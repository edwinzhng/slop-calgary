import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { translateBuildingY } from './building-ground.js';
import { nativeFoundationSpan } from './native-foundations.js';

export const FOUNDATION_BUILDING_IDS = Object.freeze([
  'city-outline-16028-0', // The McLeod, lowest source wall rim 1.20 m.
  'city-outline-16120-0', // The Barclay, 2.08 m.
  'city-outline-26946-0', // Keynote Two, 1.00 m.
  'city-outline-27884-0', // Eighth Avenue Place, 3.38 m.
  'city-outline-28596-0', // The Bow, 0.52 m.
]);

const EPS = 1e-8;
const point2 = (p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.z]);

function boundsOfPoints(points, pad = 0) {
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const p of points) {
    const [x, z] = point2(p);
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}
const boxesTouch = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;

/**
 * Find actual lowest exterior wall edges. Roof rims, triangulation diagonals,
 * vertical edges, and higher terrace/bridge boundaries cannot become skirts.
 */
export function lowestWallEdges(geometry, minHeight, { tolerance = 0.045, quantization = 0.02 } = {}) {
  const positions = geometry?.attributes?.position,
    normals = geometry?.attributes?.normal;
  if (!positions || !Number.isFinite(minHeight)) return [];
  const edges = new Map(),
    index = geometry.index;
  const getIndex = (i) => (index ? index.getX(i) : i);
  const key = (v) => v.map((n) => Math.round(n / quantization)).join(',');
  for (let i = 0; i < (index?.count || positions.count); i += 3) {
    const ids = [getIndex(i), getIndex(i + 1), getIndex(i + 2)],
      vertices = ids.map((j) => [positions.getX(j), positions.getY(j), positions.getZ(j)]),
      ab = new THREE.Vector3().fromArray(vertices[1]).sub(new THREE.Vector3().fromArray(vertices[0])),
      ac = new THREE.Vector3().fromArray(vertices[2]).sub(new THREE.Vector3().fromArray(vertices[0])),
      normal = normals
        ? [normals.getX(ids[0]), normals.getY(ids[0]), normals.getZ(ids[0])]
        : ab.cross(ac).normalize().toArray();
    if (!normal.every(Number.isFinite) || Math.abs(normal[1]) > 0.35) continue;
    for (let edge = 0; edge < 3; edge++) {
      const a = vertices[edge],
        b = vertices[(edge + 1) % 3];
      if (
        Math.hypot(b[0] - a[0], b[2] - a[2]) < 0.08 ||
        Math.max(a[1], b[1]) > minHeight + tolerance ||
        Math.min(a[1], b[1]) < minHeight - tolerance
      )
        continue;
      const edgeKey = [key(a), key(b)].sort().join('|'),
        old = edges.get(edgeKey);
      if (old) old.count++;
      else edges.set(edgeKey, { a, b, normal: [normal[0], normal[2]], count: 1 });
    }
  }
  return [...edges.values()].filter((edge) => edge.count === 1);
}

function clipRange(interval, origin, direction, min, max) {
  if (Math.abs(direction) < EPS) return origin >= min && origin <= max;
  const t0 = (min - origin) / direction,
    t1 = (max - origin) / direction;
  interval[0] = Math.max(interval[0], Math.min(t0, t1));
  interval[1] = Math.min(interval[1], Math.max(t0, t1));
  return interval[1] >= interval[0];
}

function circleInterval(a, delta, center, radius) {
  const x = a[0] - center[0],
    z = a[1] - center[1],
    aa = delta[0] ** 2 + delta[1] ** 2,
    bb = 2 * (x * delta[0] + z * delta[1]),
    cc = x * x + z * z - radius * radius,
    discriminant = bb * bb - 4 * aa * cc;
  if (aa < EPS || discriminant < 0) return null;
  const lo = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa)),
    hi = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
  return hi >= lo ? [lo, hi] : null;
}

/** Intervals where an edge touches a mapped passage capsule; exact, including endpoints. */
export function passageCutIntervals(a, b, passageA, passageB, radius) {
  const delta = [b[0] - a[0], b[1] - a[1]],
    px = passageB[0] - passageA[0],
    pz = passageB[1] - passageA[1],
    length = Math.hypot(px, pz),
    intervals = [];
  if (!(radius >= 0) || ![...a, ...b, ...passageA, ...passageB, radius].every(Number.isFinite))
    return intervals;
  for (const center of [passageA, passageB]) {
    const interval = circleInterval(a, delta, center, radius);
    if (interval) intervals.push(interval);
  }
  if (length > EPS) {
    const ux = px / length,
      uz = pz / length,
      dx = a[0] - passageA[0],
      dz = a[1] - passageA[1],
      interval = [0, 1];
    if (
      clipRange(interval, dx * ux + dz * uz, delta[0] * ux + delta[1] * uz, 0, length) &&
      clipRange(interval, -dx * uz + dz * ux, -delta[0] * uz + delta[1] * ux, -radius, radius)
    )
      intervals.push(interval);
  }
  return intervals;
}

function mergeIntervals(intervals) {
  const result = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && interval[0] <= last[1] + EPS) last[1] = Math.max(last[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}

function groundPassageSegments(data, bounds) {
  const segments = [];
  for (const road of [...(data?.roads || []), ...(data?.rails || [])]) {
    if (
      road.bridge ||
      road.tunnel ||
      (road.layer || 0) > 0 ||
      road.kind === 'corridor' ||
      !road.points?.length ||
      !boxesTouch(bounds, boundsOfPoints(road.points, 8))
    )
      continue;
    // Width is an explicit conservative opening inference; the centreline is mapped.
    const pedestrian = ['footway', 'path', 'cycleway', 'steps', 'pedestrian'].includes(road.kind),
      radius = pedestrian
        ? road.kind === 'pedestrian'
          ? 2.8
          : 1.65
        : Math.max(3.1, (road.lanes || 2) * 1.7);
    for (let i = 1; i < road.points.length; i++)
      segments.push({ a: road.points[i - 1], b: road.points[i], radius, id: road.id });
  }
  return segments;
}

/**
 * Optional, five-building-only foundation strips. Caller supplies a shared
 * material (or materialForBuilding) so this adds no facade shader variants.
 * Existing source geometry, elevations, colliders, and real +15s are untouched.
 */
export function buildInferredFoundations(
  scene,
  data,
  cityMeshes,
  {
    material,
    materialForBuilding,
    baseY = 0.12,
    inset = 0.025,
    colliderThickness = 0.12,
    buildingGround,
    nativeProfile,
  } = {},
) {
  if (!material && !materialForBuilding)
    throw new Error('Foundation skirts require an existing shared material');
  if (
    ![baseY, inset, colliderThickness].every(Number.isFinite) ||
    baseY < -0.1 ||
    baseY > 0.31 ||
    inset < 0 ||
    inset > 0.1 ||
    colliderThickness <= 0 ||
    colliderThickness > 0.3
  )
    throw new Error('Foundation skirt dimensions exceed the bounded repair range');
  const group = new THREE.Group();
  group.name = 'inferred-measured-wall-foundations';
  const buildingById = new Map((data?.buildings || []).map((b) => [b.id, b])),
    buckets = new Map(),
    records = [],
    colliders = [],
    stats = {
      buildings: 0,
      sourceEdges: 0,
      strips: 0,
      openingCuts: 0,
      triangles: 0,
      drawCalls: 0,
      maxHeight: 0,
      ...(nativeProfile
        ? {
            nativeTerrain: true,
            nativeBuildings: 0,
            deferredHostBuildings: 0,
            profile: nativeProfile.stats,
            unsupportedLengthM: 0,
            terrainCoveredLengthM: 0,
            overLimitLengthM: 0,
            collapsedLengthM: 0,
            emittedLengthM: 0,
          }
        : {}),
    };
  for (const id of FOUNDATION_BUILDING_IDS) {
    const record = cityMeshes?.get(id),
      building = buildingById.get(id);
    const hostOffset = buildingGround?.offsetFor(id),
      offset = hostOffset ?? 0,
      native = nativeProfile && hostOffset != null;
    if (!record || record.minHeight <= baseY || record.minHeight > 3.5 || !building) continue;
    const sharedMaterial = materialForBuilding?.(building, record) || material;
    if (!sharedMaterial) continue;
    const source = cityMeshes.createGeometry(id),
      edges = lowestWallEdges(source, record.minHeight),
      points = edges.flatMap((edge) => [edge.a, edge.b]).map(([x, , z]) => [x, z]),
      passages = groundPassageSegments(data, boundsOfPoints(points, 5)),
      positions = [],
      cutIds = new Set(),
      nativeSegments = [],
      nativeStats = {
        unsupportedLengthM: 0,
        terrainCoveredLengthM: 0,
        overLimitLengthM: 0,
        collapsedLengthM: 0,
        emittedLengthM: 0,
        maximumExtensionM: 0,
        maximumObservedGapM: -Infinity,
        minimumObservedGapM: Infinity,
      };
    source.dispose();
    let strips = 0,
      cuts = 0;
    for (const edge of edges) {
      const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[2] - edge.a[2]),
        normalLength = Math.hypot(...edge.normal);
      if (length < 0.08 || normalLength < EPS) continue;
      const nx = edge.normal[0] / normalLength,
        nz = edge.normal[1] / normalLength,
        a = [edge.a[0] - nx * inset, edge.a[2] - nz * inset],
        b = [edge.b[0] - nx * inset, edge.b[2] - nz * inset],
        intervals = [];
      for (const passage of passages) {
        const cut = passageCutIntervals(a, b, passage.a, passage.b, passage.radius + colliderThickness);
        if (cut.length) {
          intervals.push(...cut);
          cutIds.add(passage.id);
        }
      }
      const removed = mergeIntervals(intervals);
      cuts += removed.length;
      const kept = [];
      let start = 0;
      for (const [lo, hi] of [...removed, [1, 1]]) {
        if ((lo - start) * length >= 0.08) kept.push([start, lo]);
        start = Math.max(start, hi);
      }
      for (const [lo, hi] of kept) {
        const x0 = a[0] + (b[0] - a[0]) * lo,
          z0 = a[1] + (b[1] - a[1]) * lo,
          x1 = a[0] + (b[0] - a[0]) * hi,
          z1 = a[1] + (b[1] - a[1]) * hi,
          y0 = edge.a[1] + (edge.b[1] - edge.a[1]) * lo,
          y1 = edge.a[1] + (edge.b[1] - edge.a[1]) * hi;
        if (native) {
          const result = nativeFoundationSpan({
            a: [x0, z0],
            b: [x1, z1],
            top0: y0 + offset + 0.008,
            top1: y1 + offset + 0.008,
            nx,
            nz,
            profile: nativeProfile,
            sourceBuildingId: id,
            startId: strips,
            thickness: colliderThickness,
          });
          if (stats.triangles + positions.length / 9 + result.positions.length / 9 > 65536)
            throw new Error('Native foundations exceed aggregate triangle budget');
          for (const value of result.positions) positions.push(value);
          colliders.push(...result.colliders);
          nativeSegments.push(...result.segments);
          strips += result.colliders.length;
          for (const key of [
            'unsupportedLengthM',
            'terrainCoveredLengthM',
            'overLimitLengthM',
            'collapsedLengthM',
            'emittedLengthM',
          ])
            nativeStats[key] += result.stats[key];
          nativeStats.maximumExtensionM = Math.max(
            nativeStats.maximumExtensionM,
            result.stats.maximumExtensionM,
          );
          if (Number.isFinite(result.stats.maximumObservedGapM))
            nativeStats.maximumObservedGapM = Math.max(
              nativeStats.maximumObservedGapM,
              result.stats.maximumObservedGapM,
            );
          if (Number.isFinite(result.stats.minimumObservedGapM))
            nativeStats.minimumObservedGapM = Math.min(
              nativeStats.minimumObservedGapM,
              result.stats.minimumObservedGapM,
            );
          continue;
        }
        const quad = [
            [x0, baseY, z0],
            [x1, baseY, z1],
            [x1, y1 + 0.008, z1],
            [x0, y0 + 0.008, z0],
          ],
          faceNormal = new THREE.Vector3()
            .fromArray(quad[1])
            .sub(new THREE.Vector3().fromArray(quad[0]))
            .cross(new THREE.Vector3().fromArray(quad[2]).sub(new THREE.Vector3().fromArray(quad[0])));
        if (faceNormal.x * nx + faceNormal.z * nz >= 0)
          positions.push(...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3]);
        else positions.push(...quad[0], ...quad[2], ...quad[1], ...quad[0], ...quad[3], ...quad[2]);
        colliders.push({
          id: `inferred-foundation:${id}:${strips}`,
          sourceBuildingId: id,
          kind: 'inferredFoundation',
          ring: [
            [x0, z0],
            [x1, z1],
            [x1 - nx * colliderThickness, z1 - nz * colliderThickness],
            [x0 - nx * colliderThickness, z0 - nz * colliderThickness],
          ],
          minHeight: baseY + offset,
          height: Math.max(y0, y1) + offset,
          inferred: true,
        });
        strips++;
      }
    }
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      // World-metre facade UVs work with the existing shared City wall material.
      const uv = new Float32Array((positions.length / 3) * 2);
      for (let i = 0; i < positions.length / 3; i++) {
        const n = geometry.attributes.normal;
        uv[i * 2] = (positions[i * 3] * n.getZ(i) - positions[i * 3 + 2] * n.getX(i)) / 72;
        uv[i * 2 + 1] = positions[i * 3 + 1];
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      if (!native) translateBuildingY(geometry, offset);
      if (!buckets.has(sharedMaterial)) buckets.set(sharedMaterial, []);
      buckets.get(sharedMaterial).push(geometry);
      stats.buildings++;
      stats.triangles += positions.length / 9;
      stats.maxHeight = Math.max(stats.maxHeight, native ? nativeStats.maximumExtensionM : record.minHeight);
      if (native) stats.nativeBuildings++;
      else if (nativeProfile) stats.deferredHostBuildings++;
    }
    if (!Number.isFinite(nativeStats.maximumObservedGapM)) nativeStats.maximumObservedGapM = null;
    if (!Number.isFinite(nativeStats.minimumObservedGapM)) nativeStats.minimumObservedGapM = null;
    records.push({
      id,
      name: building.name || '',
      minHeight: record.minHeight,
      sourceEdges: edges.length,
      strips,
      openingCuts: cuts,
      preservedPassageIds: [...cutIds],
      inferred: true,
      ...(nativeProfile
        ? {
            nativeStatus: native ? 'canonical-native-wall-contact' : 'separate-host-frame-pending',
            ...(native ? { nativeStats, nativeSegments } : {}),
          }
        : {}),
    });
    if (native)
      for (const key of [
        'unsupportedLengthM',
        'terrainCoveredLengthM',
        'overLimitLengthM',
        'collapsedLengthM',
        'emittedLengthM',
      ])
        stats[key] += nativeStats[key];
    stats.sourceEdges += edges.length;
    stats.strips += strips;
    stats.openingCuts += cuts;
  }
  for (const [sharedMaterial, geometries] of buckets) {
    const geometry = mergeGeometries(geometries, false);
    geometries.forEach((g) => g.dispose());
    if (!geometry) continue;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, sharedMaterial);
    mesh.name = 'bounded-inferred-wall-base';
    mesh.receiveShadow = true;
    group.add(mesh);
    stats.drawCalls++;
  }
  scene?.add(group);
  return {
    group,
    stats,
    records,
    colliders,
    // Keep source minHeight unchanged. Only these exact short wall strips add
    // ground contact; widening the complete source footprint would seal openings.
    colliderAdjustments: [],
    dispose() {
      group.removeFromParent();
      for (const mesh of group.children) mesh.geometry.dispose();
    },
  };
}

/** Continue rigid building walls to the lower side of a hillside footprint. */
export function appendHillsideFootings(positions, shell, minHeight, reliefAt) {
  for (const { a, b, normal } of lowestWallEdges(shell, minHeight)) {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 4);
    const point = (t) => {
      const x = a[0] + (b[0] - a[0]) * t - normal[0] * 0.015,
        z = a[2] + (b[2] - a[2]) * t - normal[1] * 0.015,
        top = a[1] + (b[1] - a[1]) * t + 0.08;
      return { top: [x, top, z], low: [x, Math.min(top, reliefAt(x, z) - 0.06), z] };
    };
    let previous = point(0);
    for (let i = 1; i <= steps; i++) {
      const next = point(i / steps);
      if (previous.top[1] - previous.low[1] > 0.08 || next.top[1] - next.low[1] > 0.08) {
        const direction =
          (next.top[2] - previous.top[2]) * normal[0] - (next.top[0] - previous.top[0]) * normal[1];
        const [p, q] = direction < 0 ? [previous, next] : [next, previous];
        positions.push(...p.top, ...p.low, ...q.top, ...q.top, ...p.low, ...q.low);
      }
      previous = next;
    }
  }
}
