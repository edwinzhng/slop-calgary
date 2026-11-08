import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three/webgpu';
import { createMeshHeightCache } from './mesh-height-cache.js';
import { polygonContact } from './building-collision.js';

function openRing(ring) {
  if (!Array.isArray(ring) || ring.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
    throw new Error('Invalid collision region coordinates');
  const result = ring.slice();
  if (result.length > 1 && result[0][0] === result.at(-1)[0] && result[0][1] === result.at(-1)[1])
    result.pop();
  if (result.length < 3) throw new Error('Collision region needs three vertices');
  return result;
}
const area = (ring) => {
  const [x, z] = ring[0];
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    sum += (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
  }
  return sum / 2;
};
function trianglesOf(part) {
  const rings = [part.ring, ...(part.holes || [])].map(openRing),
    flat = rings.flat(),
    [ox, oz] = rings[0][0],
    vectors = rings.map((r) => r.map(([x, z]) => new Vector2(x - ox, z - oz))),
    triangles = ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)).map((t) => t.map((i) => flat[i])),
    expected = Math.abs(area(rings[0])) - rings.slice(1).reduce((n, r) => n + Math.abs(area(r)), 0),
    actual = triangles.reduce((n, t) => n + Math.abs(area(t)), 0);
  if (!(expected > 0) || Math.abs(actual - expected) > 1e-5)
    throw new Error('Collision region lost area or a hole');
  return triangles.map((triangle) => ({ triangle, orientation: Math.sign(area(triangle)) }));
}
function clip(polygon, distance) {
  if (!polygon.length) return polygon;
  const result = [];
  let previous = polygon.at(-1),
    before = distance(previous);
  for (const current of polygon) {
    const next = distance(current);
    if (before >= 0 !== next >= 0) {
      const t = before / (before - next);
      result.push(previous.map((v, k) => v + t * (current[k] - v)));
    }
    if (next >= 0) result.push(current);
    previous = current;
    before = next;
  }
  return result;
}
function clipFaces(source, spec) {
  const output = [];
  for (const face of source) {
    if (face.maxX < spec.minX || face.minX > spec.maxX || face.maxZ < spec.minZ || face.minZ > spec.maxZ)
      continue;
    for (const { triangle, orientation } of spec.triangles) {
      let polygon = face.points;
      for (let i = 0; i < 3 && polygon.length; i++) {
        const a = triangle[i],
          b = triangle[(i + 1) % 3];
        polygon = clip(
          polygon,
          (p) => orientation * ((b[0] - a[0]) * (p[2] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])),
        );
      }
      if (spec.band) {
        polygon = clip(polygon, (p) => p[1] - spec.band[0]);
        polygon = clip(polygon, (p) => spec.band[1] - p[1]);
      }
      if (polygon.length === 1) output.push([polygon[0], polygon[0], polygon[0]]);
      else if (polygon.length === 2) output.push([polygon[0], polygon[1], polygon[1]]);
      else for (let i = 1; i + 1 < polygon.length; i++) output.push([polygon[0], polygon[i], polygon[i + 1]]);
    }
  }
  return output;
}
function facesOf(geometry) {
  const p = geometry.getAttribute('position'),
    index = geometry.getIndex(),
    count = index?.count ?? p.count,
    result = [];
  for (let i = 0; i < count; i += 3) {
    const points = [0, 1, 2].map((j) => {
      const k = index ? index.getX(i + j) : i + j;
      return [p.getX(k), p.getY(k), p.getZ(k)];
    });
    result.push({
      points,
      minX: Math.min(...points.map((v) => v[0])),
      maxX: Math.max(...points.map((v) => v[0])),
      minZ: Math.min(...points.map((v) => v[2])),
      maxZ: Math.max(...points.map((v) => v[2])),
    });
  }
  return result;
}
function sampleRegion(cache, spec, x, z, body, empty) {
  if (body) {
    const radius = Math.max(0, body.radius || 0),
      ex = body.car ? Math.abs(body.cos) * body.hx + Math.abs(body.sin) * body.hz : radius,
      ez = body.car ? Math.abs(body.sin) * body.hx + Math.abs(body.cos) * body.hz : radius;
    if (
      x + ex < spec.minX ||
      x - ex > spec.maxX ||
      z + ez < spec.minZ ||
      z - ez > spec.maxZ ||
      !polygonContact(spec.polygon, x, z, body)
    )
      return empty;
  }
  return cache.heightAt(spec.key, x, z, body);
}

/** Preserve individual collision polygons and mapped vertical intervals. Source
 * faces are clipped to each region; only the nearby contact projections compile.
 * No rendered source geometry, mapped volume semantics or ownership is changed.
 */
export function createRegionalMeshContacts(owners, { sourceTriangleBudget = 8192 } = {}) {
  if (!Number.isSafeInteger(sourceTriangleBudget) || sourceTriangleBudget <= 0)
    throw new Error('Regional source triangle budget must be a positive integer');
  if (new Set(owners.map((owner) => owner.id)).size !== owners.length)
    throw new Error('Regional source owners must be unique');
  const definitions = new Map(owners.map((owner) => [owner.id, owner])),
    sources = new Map(),
    specs = new Map(),
    parts = new Map(),
    failed = new Set(),
    stats = {
      initializedOwners: 0,
      sourceTriangles: 0,
      regions: 0,
      preflightTriangles: 0,
      maxRegionTriangles: 0,
      preflightMs: 0,
      errors: [],
    },
    loadProjection = (key) => {
      const spec = specs.get(key);
      if (!spec) return null;
      const triangles = clipFaces(sources.get(spec.ownerId), spec),
        geometry = new BufferGeometry();
      // CPU-only exact plane interpolation; these Float64 attributes are never uploaded.
      geometry.setAttribute('position', new BufferAttribute(new Float64Array(triangles.flat(2)), 3));
      return geometry;
    },
    cache = createMeshHeightCache(loadProjection),
    lowerCache = createMeshHeightCache(loadProjection, { minimum: true });
  stats.cache = cache.stats;
  stats.lowerCache = lowerCache.stats;
  return {
    stats,
    clearProjections() {
      cache.clear();
      lowerCache.clear();
    },
    collisionParts(id) {
      if (parts.has(id)) return parts.get(id);
      const owner = definitions.get(id);
      if (!owner || failed.has(id)) return null;
      const stamp = performance.now();
      let faces = null;
      try {
        const geometry = owner.source.createGeometry(id);
        if (!geometry) throw new Error('Missing selected source geometry');
        try {
          faces = facesOf(geometry);
        } finally {
          geometry.dispose();
        }
        if (stats.sourceTriangles + faces.length > sourceTriangleBudget)
          throw new Error('Regional source projection budget exceeded');
        if (!Array.isArray(owner.parts) || !owner.parts.length)
          throw new Error('Selected source has no collision regions');
        const localSpecs = [],
          localParts = [];
        for (const [index, part] of owner.parts.entries()) {
          const points = [part.ring, ...(part.holes || [])].flat(),
            q = owner.source.manifest.meta.quantization,
            spec = {
              key: `${id}:${index}`,
              ownerId: id,
              triangles: trianglesOf(part),
              minX: Math.min(...points.map((p) => p[0])),
              maxX: Math.max(...points.map((p) => p[0])),
              minZ: Math.min(...points.map((p) => p[1])),
              maxZ: Math.max(...points.map((p) => p[1])),
              polygon: {
                outer: part.ring.map(([x, z]) => ({ x, z })),
                holes: (part.holes || []).map((r) => r.map(([x, z]) => ({ x, z }))),
              },
              band: owner.preserveBands
                ? [
                    Math.fround(Math.round(part.minHeight / q) * q),
                    Math.fround(Math.round(part.height / q) * q),
                  ]
                : null,
            },
            projected = clipFaces(faces, spec);
          if (!projected.length) throw new Error('A collision region has no original source face');
          let low = Infinity,
            high = -Infinity;
          for (const face of projected)
            for (const p of face) {
              low = Math.min(low, p[1]);
              high = Math.max(high, p[1]);
            }
          if (!Number.isFinite(low + high)) throw new Error('Invalid regional source bounds');
          localSpecs.push(spec);
          localParts.push({
            ...part,
            sourceCollisionHeight: part.height,
            sourceCollisionMinHeight: part.minHeight,
            height: Math.max(part.height, high),
            minHeight: spec.band ? spec.band[0] : Math.min(part.minHeight, low),
            heightAt: (x, z, body) => sampleRegion(cache, spec, x, z, body, -Infinity),
            ...(owner.suspended
              ? { minHeightAt: (x, z, body) => sampleRegion(lowerCache, spec, x, z, body, Infinity) }
              : {}),
          });
          spec.projectedTriangles = projected.length;
        }
        sources.set(id, faces);
        for (const spec of localSpecs) {
          specs.set(spec.key, spec);
          stats.preflightTriangles += spec.projectedTriangles;
          stats.maxRegionTriangles = Math.max(stats.maxRegionTriangles, spec.projectedTriangles);
        }
        stats.sourceTriangles += faces.length;
        stats.regions += localParts.length;
        stats.initializedOwners++;
        parts.set(id, localParts);
        return localParts;
      } catch (error) {
        failed.add(id);
        stats.errors.push({ id, message: error.message });
        return null;
      } finally {
        stats.preflightMs += performance.now() - stamp;
      }
    },
  };
}
