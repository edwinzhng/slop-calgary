import * as THREE from 'three/webgpu';
import { bounds, DRIVABLE, roadWidth, SpatialIndex } from './geo.js';
import { createRoadPaintMaterial, expandRoadPaintBounds } from './reference-streets.js';
import { addSpatialBatches } from './static-batches.js';
import { projectedMeshHeightAt } from './mesh-height-envelope.js';

const WHITE = new THREE.Color(0xe6e2d6),
  YELLOW = new THREE.Color(0xe8ad22);
const key = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;

export function laneLayout(road) {
  const lanes = Math.max(
    1,
    Math.round(road.lanes || (['primary', 'secondary', 'trunk'].includes(road.kind) ? 4 : 2)),
  );
  const width = roadWidth(road),
    lane = width / lanes;
  const oneWay = ['yes', '1', '-1', 'true'].includes(String(road.oneway));
  const lines = [];
  for (let i = 1; i < lanes; i++) {
    const offset = -width / 2 + lane * i;
    const divider = !oneWay && i === Math.floor(lanes / 2);
    if (divider) {
      for (const side of [-1, 1])
        lines.push({ offset: offset + side * 0.12, width: 0.11, color: YELLOW, period: 1, duty: 1 });
    } else lines.push({ offset, width: 0.13, color: WHITE, period: 12, duty: 0.25 });
  }
  return lines;
}

export function recordPaintSurface(geometries) {
  const faces = new SpatialIndex(16);
  for (const geometry of geometries) {
    const p = geometry.attributes.position,
      index = geometry.index;
    for (let i = 0; i < (index?.count ?? p.count); i += 3) {
      const face = [0, 1, 2].map((j) => {
        const k = index ? index.getX(i + j) : i + j;
        return [p.getX(k), p.getY(k), p.getZ(k)];
      });
      faces.insert(face, bounds(face.map(([x, , z]) => [x, z])));
    }
  }
  return (x, z) => projectedMeshHeightAt(faces.near(x, z), x, z);
}

export function buildRoadMarkings(scene, roads, surfaces, { terrain, renderedRoads } = {}) {
  const vertices = new Map(),
    junctions = new Map();
  const candidates = roads.filter(
    (r) =>
      DRIVABLE.has(r.kind) &&
      !r.transitOnly &&
      (!r.tunnel || surfaces.underpass?.allows(r)) &&
      !surfaces.ownsRoad(r) &&
      !['service', 'living_street'].includes(r.kind),
  );
  for (const r of candidates)
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i],
        a = r.points[Math.max(0, i - 1)],
        b = r.points[Math.min(r.points.length - 1, i + 1)];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const k = key(p),
        at = { road: r, dx: (b[0] - a[0]) / length, dz: (b[1] - a[1]) / length, half: roadWidth(r) / 2 };
      const others = vertices.get(k) || [];
      for (const o of others)
        if (o.road !== r && Math.abs(o.dx * at.dz - o.dz * at.dx) > 0.35)
          junctions.set(k, Math.max(junctions.get(k) || 0, o.half, at.half) + 2.8);
      others.push(at);
      vertices.set(k, others);
    }
  const position = [],
    side = [],
    paint = [],
    colors = [],
    indices = [];
  const seen = new Set();
  for (const r of candidates) {
    const lines = laneLayout(r);
    const geometries = renderedRoads?.get(r.id),
      renderedAt = geometries && recordPaintSurface(geometries);
    const height = renderedAt || ((x, z) => surfaces.surfaceHeight(x, z, r));
    let phase = 0;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1],
        b = r.points[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      if (length < 0.05) continue;
      const ux = dx / length,
        uz = dz / length;
      const start = Math.min(length, junctions.get(key(a)) || 0),
        end = Math.max(0, length - (junctions.get(key(b)) || 0));
      if (end - start > 0.2)
        for (const line of lines) {
          const ax = a[0] + ux * start - uz * line.offset,
            az = a[1] + uz * start + ux * line.offset;
          const bx = a[0] + ux * end - uz * line.offset,
            bz = a[1] + uz * end + ux * line.offset;
          const precise = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
          const k = [precise(ax, az), precise(bx, bz)].sort().join('/');
          if (seen.has(k)) continue;
          seen.add(k);
          const sx = (-uz * line.width) / 2,
            sz = (ux * line.width) / 2;
          const cuts = terrain?.lineCuts?.(ax, az, bx, bz) || [0, 1];
          if (renderedAt) {
            // Ramps also have their own vertical profile between terrain seams.
            const count = Math.ceil((end - start) / 2.5);
            for (let j = 1; j < count; j++) cuts.push(j / count);
            cuts.sort((a, b) => a - b);
          }
          let previous;
          for (const t of cuts) {
            if (previous && t - previous.t < 1e-7) continue;
            const x = ax + (bx - ax) * t,
              z = az + (bz - az) * t,
              h = height(x, z),
              current = { x, z, h, t };
            if (previous && previous.h != null && current.h != null) {
              const n = position.length / 3;
              for (const [p, s] of [
                [previous, -1],
                [previous, 1],
                [current, 1],
                [current, -1],
              ]) {
                position.push(p.x + sx * s, p.h + 0.018, p.z + sz * s);
                side.push(sx * s, sz * s);
                paint.push(phase + start + (end - start) * p.t, line.period, line.duty);
                colors.push(line.color.r, line.color.g, line.color.b);
              }
              indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
            }
            previous = current;
          }
        }
      phase += length;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      Array.from({ length: position.length }, (_, i) => (i % 3 === 1 ? 1 : 0)),
      3,
    ),
  );
  geometry.setAttribute('side', new THREE.Float32BufferAttribute(side, 2));
  geometry.setAttribute('paint', new THREE.Float32BufferAttribute(paint, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  // World xz is baked into this geometry, as in the reference's road-paint builder.
  const mesh = addSpatialBatches(
    scene,
    geometry,
    createRoadPaintMaterial(),
    'Filtered lane markings from Calgary road lanes and directions',
    { expandBounds: expandRoadPaintBounds },
  );
  return { mesh, stats: { strips: position.length / 12, junctions: junctions.size } };
}
