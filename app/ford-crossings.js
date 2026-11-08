import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import polygonClipping from 'polygon-clipping';
import { bounds, inPolygon, nearestOnSegment, SpatialIndex } from './geo.js';
import { projectedMeshHeightAt } from './mesh-height-envelope.js';
import { surfaceStyle } from './ground-surfaces.js';

export function isMappedFootFord(road) {
  return (
    road.sourceTags?.ford === 'yes' &&
    ['footway', 'path', 'cycleway'].includes(road.kind) &&
    !road.bridge &&
    !road.tunnel
  );
}

// A visible collar repairs only centimetre-scale gaps between independent City
// paving outlines at the two deck ends. Original source polygons remain intact.
function planFordJoins(road, pad, selected) {
  const a = road.points[0],
    b = road.points.at(-1),
    length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.1) return [];
  const dx = (b[0] - a[0]) / length,
    dz = (b[1] - a[1]) / length,
    box = bounds(pad.ring),
    cx = (box.minX + box.maxX) / 2,
    cz = (box.minZ + box.maxZ) / 2,
    joins = [];
  for (let i = 1; i < pad.ring.length; i++) {
    const p = pad.ring[i - 1],
      q = pad.ring[i],
      edge = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (edge < 0.01 || Math.abs(((q[0] - p[0]) * dx + (q[1] - p[1]) * dz) / edge) > 0.4) continue;
    const sign = ((p[0] + q[0]) / 2 - cx) * dx + ((p[1] + q[1]) / 2 - cz) * dz > 0 ? 1 : -1,
      reach = 0.025;
    const cap = [
      p,
      q,
      [q[0] + dx * sign * reach, q[1] + dz * sign * reach],
      [p[0] + dx * sign * reach, p[1] + dz * sign * reach],
      p,
    ];
    const approaches = selected.filter(
      (s) =>
        s.id !== pad.id &&
        s.kind === 'Pathways' &&
        polygonClipping.intersection([cap], [s.ring, ...(s.holes || [])]).length,
    );
    if (!approaches.length) continue;
    const gaps = polygonClipping.difference([cap], ...selected.map((s) => [s.ring, ...(s.holes || [])]));
    for (const rings of gaps)
      joins.push({
        id: `inferred-ford-seam-${pad.id}-${i}-${joins.length}`,
        padId: pad.id,
        ring: rings[0],
        holes: rings.slice(1),
        maximumReachM: reach,
        sourceSurfaceIds: [pad.id, ...approaches.map((s) => s.id)],
      });
  }
  return joins;
}

// A source ford needs an actual mapped concrete crossing and rendered paving.
// Neither a water intersection nor an ordinary path creates water permission.
export function createFordCrossings(roads, surfaceData, { inWater, waterHeight }) {
  const records = [],
    index = new SpatialIndex(48),
    surfaceOwners = new Map();
  const stats = {
    sourceFords: 0,
    supportedFords: 0,
    registeredSurfaces: 0,
    retainedTriangles: 0,
    retainedMappedPavingTriangles: 0,
    inferredJoinTriangles: 0,
  };
  const eligible = (surface) => ['Concrete Pad', 'Pathways'].includes(surface.kind);
  for (const road of roads) {
    if (!isMappedFootFord(road) || road.points.length < 2) continue;
    stats.sourceFords++;
    const stations = [];
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1],
        b = road.points[i];
      const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let j = 0; j <= count; j++)
        stations.push([a[0] + ((b[0] - a[0]) * j) / count, a[1] + ((b[1] - a[1]) * j) / count]);
    }
    const selected = (surfaceData.surfaces || []).filter(
      (s) => eligible(s) && stations.some((p) => inPolygon(...p, s)),
    );
    const pads = selected.filter((s) => s.kind === 'Concrete Pad' && s.material === 'Concrete');
    if (!pads.length) continue;
    const distance = (p) =>
      Math.min(...road.points.slice(1).map((b, i) => nearestOnSegment(...p, road.points[i], b).distance));
    const halfWidth = Math.max(...pads.flatMap((p) => p.ring.map(distance)));
    if (!(halfWidth > 0) || halfWidth > 12) continue;
    const box = bounds(road.points);
    const record = {
      sourceRoadId: road.id,
      road,
      pads,
      joins: pads.flatMap((p) => planFordJoins(road, p, selected)),
      halfWidth,
      surfaces: new Map(),
      faces: [],
      box: {
        minX: box.minX - halfWidth,
        maxX: box.maxX + halfWidth,
        minZ: box.minZ - halfWidth,
        maxZ: box.maxZ + halfWidth,
      },
    };
    for (const s of selected) {
      record.surfaces.set(s.id, s);
      if (!surfaceOwners.has(s.id)) surfaceOwners.set(s.id, []);
      surfaceOwners.get(s.id).push(record);
    }
    records.push(record);
    index.insert(record, record.box);
    stats.supportedFords++;
    if (records.length > 128) throw new Error('Source ford owner budget exceeded');
  }
  function registerSurfaceGeometry(surface, geometry) {
    const owners = surfaceOwners.get(surface.id);
    if (!owners) return;
    const p = geometry.attributes.position,
      ix = geometry.index,
      n = ix?.count ?? p.count;
    const faces = [];
    for (let i = 0; i < n; i += 3) {
      const t = [0, 1, 2].map((j) => {
        const k = ix ? ix.getX(i + j) : i + j;
        return [p.getX(k), p.getY(k), p.getZ(k)];
      });
      if (!t.flat().every(Number.isFinite)) throw new Error('Nonfinite source ford paving');
      const [a, b, c] = t,
        up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      if (up < -1e-8) throw new Error('Downward source ford paving');
      if (up > 1e-10) faces.push(t);
    }
    for (const r of owners) {
      const kept = faces.filter(
        (t) =>
          Math.min(...t.map((p) => p[0])) <= r.box.maxX &&
          Math.max(...t.map((p) => p[0])) >= r.box.minX &&
          Math.min(...t.map((p) => p[2])) <= r.box.maxZ &&
          Math.max(...t.map((p) => p[2])) >= r.box.minZ,
      );
      r.faces.push(...kept);
      stats.retainedTriangles += kept.length;
      stats.retainedMappedPavingTriangles += kept.length;
    }
    stats.registeredSurfaces++;
    if (stats.retainedTriangles > 131072) throw new Error('Source ford triangle budget exceeded');
  }
  function registerJoinGeometry(record, geometry) {
    if (!records.includes(record)) throw new Error('Unknown source ford owner');
    const p = geometry.attributes.position,
      ix = geometry.index,
      n = ix?.count ?? p.count;
    for (let i = 0; i < n; i += 3) {
      const t = [0, 1, 2].map((j) => {
        const k = ix ? ix.getX(i + j) : i + j;
        return [p.getX(k), p.getY(k), p.getZ(k)];
      });
      record.faces.push(t);
      stats.inferredJoinTriangles++;
      stats.retainedTriangles++;
    }
    if (stats.retainedTriangles > 131072) throw new Error('Source ford triangle budget exceeded');
  }
  function corridor(r, x, z) {
    for (let i = 1; i < r.road.points.length; i++) {
      const a = r.road.points[i - 1],
        b = r.road.points[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        d = dx * dx + dz * dz;
      if (!d) continue;
      const t = ((x - a[0]) * dx + (z - a[1]) * dz) / d;
      if (t >= 0 && t <= 1 && nearestOnSegment(x, z, a, b).distance <= r.halfWidth) return true;
    }
    return false;
  }
  function sampleAt(x, z, hint) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const bucket = index.cells.get(`${Math.floor(x / index.size)},${Math.floor(z / index.size)}`);
    if (!bucket) return null;
    let best = null;
    for (const r of bucket) {
      if (!corridor(r, x, z)) continue;
      const y = projectedMeshHeightAt(r.faces, x, z);
      if (!Number.isFinite(y) || (Number.isFinite(hint) && y > hint + 0.65)) continue;
      const water = waterHeight(x, z);
      if (!Number.isFinite(water)) continue;
      const score = Number.isFinite(hint) ? Math.abs(y - hint) : -y;
      if (!best || score < best.score)
        best = { height: y, sourceRoadId: r.sourceRoadId, depth: Math.max(0, water - y), score };
    }
    return best;
  }
  const directions = Array.from({ length: 8 }, (_, i) => [
    Math.cos((i * Math.PI) / 4),
    Math.sin((i * Math.PI) / 4),
  ]);
  function permitsBody(position, body) {
    if (!['walk', 'cycle'].includes(body?.mode) || body.car) return false;
    const centre = sampleAt(position.x, position.z, position.y);
    if (!centre || Math.abs(centre.height - position.y) > 0.65 || centre.depth > 0.35) return false;
    for (const [u, v] of directions) {
      const x = position.x + u * body.radius,
        z = position.z + v * body.radius;
      if (!inWater(x, z)) continue;
      const p = sampleAt(x, z, position.y);
      if (!p || Math.abs(p.height - position.y) > 0.65 || p.depth > 0.35) return false;
    }
    return true;
  }
  function footprintBlocked(position, body, crossingHeight) {
    if (position.y >= 3) return false;
    const ex = body.extX ?? body.radius ?? 0,
      ez = body.extZ ?? body.radius ?? 0;
    if (
      !records.some(
        (r) =>
          r.box.minX <= position.x + ex &&
          r.box.maxX >= position.x - ex &&
          r.box.minZ <= position.z + ez &&
          r.box.maxZ >= position.z - ez,
      )
    )
      return false;
    const probes = body.car
      ? [
          [-1, -1],
          [-1, 0],
          [-1, 1],
          [0, 1],
          [1, 1],
          [1, 0],
          [1, -1],
          [0, -1],
        ]
      : directions;
    for (const [u, v] of probes) {
      const dx = body.car ? u * body.hx : u * body.radius,
        dz = body.car ? v * body.hz : v * body.radius;
      const x = position.x + (body.car ? dx * body.cos + dz * body.sin : dx),
        z = position.z + (body.car ? -dx * body.sin + dz * body.cos : dz);
      if (!inWater(x, z)) continue;
      const bridge = crossingHeight(x, z, position.y);
      if (bridge != null && Math.abs(bridge - position.y) <= 0.65) continue;
      const p = sampleAt(x, z, position.y);
      if (
        !['walk', 'cycle'].includes(body.mode) ||
        body.car ||
        !p ||
        Math.abs(p.height - position.y) > 0.65 ||
        p.depth > 0.35
      )
        return true;
    }
    return false;
  }
  return {
    records,
    stats,
    registerSurfaceGeometry,
    registerJoinGeometry,
    sampleAt,
    permitsBody,
    footprintBlocked,
    groundHeight: (x, z, hint) => sampleAt(x, z, hint)?.height ?? null,
    supportsSourceRoad: (r) => records.some((o) => o.sourceRoadId === (typeof r === 'string' ? r : r?.id)),
  };
}

// Existing mapped deck tops remain intact. Low fascia, narrow contraction joints
// and explicit tiny seam repairs add inferred detail without a duplicate slab top.
export function buildFordDetails(scene, fords, { terrain } = {}) {
  const fascia = [],
    joints = [],
    colliders = [],
    meshes = [],
    seen = new Set();
  const height = (s, x, z) => surfaceStyle(s).y + (terrain?.offsetAt(x, z) || 0);
  for (const r of fords.records)
    for (const s of r.pads) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const positions = [];
      for (const ring of [s.ring, ...(s.holes || [])])
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1],
            b = ring[i],
            ya = height(s, ...a) - 0.0005,
            yb = height(s, ...b) - 0.0005;
          positions.push(
            a[0],
            ya,
            a[1],
            a[0],
            ya - 0.22,
            a[1],
            b[0],
            yb,
            b[1],
            b[0],
            yb,
            b[1],
            a[0],
            ya - 0.22,
            a[1],
            b[0],
            yb - 0.22,
            b[1],
          );
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.computeVertexNormals();
      fascia.push(g);
      const joins = r.joins.filter((j) => j.padId === s.id);
      for (const join of joins) {
        const shape = new THREE.Shape(join.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
        for (const ring of join.holes)
          shape.holes.push(new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(-Math.PI / 2);
        g.deleteAttribute('uv');
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) p.setY(i, height(s, p.getX(i), p.getZ(i)));
        const flat = g.toNonIndexed();
        g.dispose();
        fords.registerJoinGeometry(r, flat);
        fascia.push(flat);
      }
      const a = r.road.points[0],
        b = r.road.points.at(-1),
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dx = (b[0] - a[0]) / length,
        dz = (b[1] - a[1]) / length,
        nx = -dz,
        nz = dx;
      for (let d = 2.4; d < length; d += 2.4) {
        const x = a[0] + dx * d,
          z = a[1] + dz * d,
          w = r.halfWidth + 0.1,
          h = 0.007;
        const strip = [
          [-w, -h],
          [w, -h],
          [w, h],
          [-w, h],
          [-w, -h],
        ].map(([u, v]) => [x + nx * u + dx * v, z + nz * u + dz * v]);
        const clipped = polygonClipping.intersection([s.ring, ...(s.holes || [])], [strip]);
        for (const rings of clipped) {
          const shape = new THREE.Shape(rings[0].map(([x, z]) => new THREE.Vector2(x, -z)));
          for (const ring of rings.slice(1))
            shape.holes.push(new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
          const g = new THREE.ShapeGeometry(shape);
          g.rotateX(-Math.PI / 2);
          const p = g.attributes.position;
          for (let i = 0; i < p.count; i++) p.setY(i, height(s, p.getX(i), p.getZ(i)) + 0.001);
          joints.push(g);
        }
      }
      const levels = s.ring.map((p) => height(s, ...p));
      const solidRings = joins.length
        ? polygonClipping.union([s.ring, ...(s.holes || [])], ...joins.map((j) => [j.ring, ...j.holes]))
        : [[s.ring, ...(s.holes || [])]];
      for (const [component, rings] of solidRings.entries())
        colliders.push({
          id: `ford-slab-${s.id}-${component}`,
          kind: 'fordSlab',
          sourceRoadId: r.sourceRoadId,
          ring: rings[0],
          holes: rings.slice(1),
          minHeight: Math.min(...levels) - 0.22,
          height: Math.max(...levels) - 0.0001,
          heightAt: (x, z) => height(s, x, z) - 0.0001,
        });
    }
  for (const [part, geometries, color] of [
    ['fascia', fascia, 0x8d9189],
    ['joints', joints, 0x606860],
  ]) {
    if (!geometries.length) continue;
    const g = mergeGeometries(geometries, false);
    geometries.forEach((g) => g.dispose());
    const m = new THREE.MeshStandardNodeMaterial({
      color,
      roughness: 0.82,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = `Mapped low-water ford ${part}`;
    mesh.userData.sourceFordDetail = part;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
  }
  return {
    meshes,
    colliders,
    stats: {
      pads: seen.size,
      draws: meshes.length,
      triangles: meshes.reduce(
        (n, m) => n + (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3,
        0,
      ),
      physicalDeckDatumVerified: false,
      jointSpacingInferred: true,
      slabThicknessInferred: true,
      inferredJoinPieces: fords.records.reduce((n, r) => n + r.joins.length, 0),
      maximumInferredJoinReachM: Math.max(
        0,
        ...fords.records.flatMap((r) => r.joins.map((j) => j.maximumReachM)),
      ),
    },
    dispose() {
      for (const m of meshes) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      }
    },
  };
}
