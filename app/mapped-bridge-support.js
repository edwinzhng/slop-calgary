import { bounds, SpatialIndex, roadWidth, nearestOnSegment } from './geo.js';
import { projectedMeshHeightAt } from './mesh-height-envelope.js';

// These mapped bridges retain the generic road renderer. This registry adds
// support for its real emitted triangles (or the paving which suppressed that
// ribbon), without claiming ownership that would suppress their rendering.
export function createMappedBridgeSupport(
  roads,
  { ownsRenderedRoad = () => false, inWater, pavingHeight = () => null, surfaceHeight } = {},
) {
  if (typeof inWater !== 'function' || typeof surfaceHeight !== 'function')
    throw new Error('Mapped bridge support requires existing water and render-surface queries');
  const records = new Map(),
    index = new SpatialIndex(48),
    stats = {
      candidates: 0,
      registeredGeometries: 0,
      retainedTriangles: 0,
      queries: 0,
      ribbonHits: 0,
      pavingHits: 0,
      maximumBucketCandidates: 0,
    };
  for (const road of roads) {
    if (
      !road.bridge ||
      road.tunnel ||
      road.kind === 'corridor' ||
      road.points?.length < 2 ||
      ownsRenderedRoad(road)
    )
      continue;
    if (++stats.candidates > 2048) throw new Error('Mapped bridge support exceeds source-owner budget');
    const box = bounds(road.points),
      half = roadWidth(road) / 2,
      record = {
        id: road.id,
        road,
        halfWidth: half,
        faces: [],
        geometries: 0,
        box: { minX: box.minX - half, maxX: box.maxX + half, minZ: box.minZ - half, maxZ: box.maxZ + half },
      };
    records.set(road.id, record);
    index.insert(record, {
      minX: box.minX - half,
      maxX: box.maxX + half,
      minZ: box.minZ - half,
      maxZ: box.maxZ + half,
    });
  }
  for (const bucket of index.cells.values())
    stats.maximumBucketCandidates = Math.max(stats.maximumBucketCandidates, bucket.length);
  function registerGeometry(road, geometry) {
    const r = records.get(road.id);
    if (!r) return;
    const p = geometry.attributes.position,
      indices = geometry.index,
      count = indices?.count ?? p.count;
    for (let i = 0; i < count; i += 3) {
      const triangle = [0, 1, 2].map((j) => {
          const k = indices ? indices.getX(i + j) : i + j;
          return [p.getX(k), p.getY(k), p.getZ(k)];
        }),
        [a, b, c] = triangle,
        up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      if (!triangle.flat().every(Number.isFinite)) throw new Error('Invalid emitted bridge-support triangle');
      if (up < -1e-8) throw new Error('Bridge support requires upward emitted faces');
      if (up <= 1e-10) continue;
      if (++stats.retainedTriangles > 131072)
        throw new Error('Mapped bridge support exceeds triangle budget');
      r.faces.push(triangle);
    }
    r.geometries++;
    stats.registeredGeometries++;
  }
  function sourceCorridorContains(r, x, z) {
    const p = r.road.points;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1],
        b = p[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        d = dx * dx + dz * dz;
      if (!d) continue;
      const t = ((x - a[0]) * dx + (z - a[1]) * dz) / d;
      if (t < 0 || t > 1) continue; // No rounded cap extending past the source endpoint.
      if (nearestOnSegment(x, z, a, b).distance <= r.halfWidth) return true;
    }
    return false;
  }
  function sampleAt(x, z, hint) {
    stats.queries++;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const bucket = index.cells.get(`${Math.floor(x / index.size)},${Math.floor(z / index.size)}`);
    if (!bucket || !inWater(x, z)) return null;
    let best = null;
    for (const r of bucket) {
      let y = projectedMeshHeightAt(r.faces, x, z),
        source = 'emitted-road-triangle';
      if (y == null && sourceCorridorContains(r, x, z)) {
        const paving = pavingHeight(x, z),
          rendered = surfaceHeight(x, z, r.road);
        if (Number.isFinite(paving) && Number.isFinite(rendered) && Math.abs(paving - rendered) <= 0.65) {
          y = paving;
          source = 'mapped-paving-within-source-bridge';
        }
      }
      if (!Number.isFinite(y) || (Number.isFinite(hint) && y > hint + 0.65)) continue;
      const score = Number.isFinite(hint) ? Math.abs(y - hint) : -y;
      if (!best || score < best.score) best = { height: y, source, sourceRoadId: r.id, score };
    }
    if (best) stats[best.source === 'emitted-road-triangle' ? 'ribbonHits' : 'pavingHits']++;
    return best;
  }
  function nearby(x, z, body) {
    const ex = body?.extX ?? body?.radius ?? 0,
      ez = body?.extZ ?? body?.radius ?? 0;
    for (let col = Math.floor((x - ex) / index.size); col <= Math.floor((x + ex) / index.size); col++)
      for (let row = Math.floor((z - ez) / index.size); row <= Math.floor((z + ez) / index.size); row++)
        for (const r of index.cells.get(`${col},${row}`) || [])
          if (r.box.minX <= x + ex && r.box.maxX >= x - ex && r.box.minZ <= z + ez && r.box.maxZ >= z - ez)
            return true;
    return false;
  }
  return {
    records,
    stats,
    registerGeometry,
    sampleAt,
    nearby,
    groundHeight: (x, z, hint) => sampleAt(x, z, hint)?.height ?? null,
    supportsSourceRoad: (r) => records.has(typeof r === 'string' ? r : r?.id),
  };
}

const CIRCLE = Array.from({ length: 8 }, (_, i) => [
    Math.cos((i * Math.PI) / 4),
    Math.sin((i * Math.PI) / 4),
  ]),
  BOX = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1],
    [0, -1],
  ];
// Additional edge probes apply only near these mapped bridges. Dry shoreline
// points remain normal land; every wet footprint probe needs real crossing
// support at the current feet height. This is a bounded game-body approximation.
export function mappedBridgeFootprintBlocked(position, body, { support, inWater, crossingHeight }) {
  if (position.y >= 3 || !support.nearby(position.x, position.z, body)) return false;
  const points = body.car ? BOX : CIRCLE;
  for (const [u, v] of points) {
    const dx = body.car ? u * body.hx : u * (body.radius || 0),
      dz = body.car ? v * body.hz : v * (body.radius || 0),
      x = position.x + (body.car ? dx * body.cos + dz * body.sin : dx),
      z = position.z + (body.car ? -dx * body.sin + dz * body.cos : dz);
    if (!inWater(x, z)) continue;
    const height = crossingHeight(x, z, position.y);
    if (height == null || Math.abs(height - position.y) > 0.65) return true;
  }
  return false;
}
