import { createMeshHeightSampler } from './mesh-height-envelope.js';

// Nearby movement/camera contacts need a local upper envelope. Retain a bounded
// CPU projection cache, independent of the merged rendering geometry/GPU memory.
export function createMeshHeightCache(
  loadGeometry,
  { maxEntries = 128, maxTriangles = 8192, minimum = false } = {},
) {
  if (![maxEntries, maxTriangles].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Mesh contact cache limits must be positive integers');
  if (typeof minimum !== 'boolean') throw new Error('Mesh contact envelope direction must be boolean');
  const entries = new Map(),
    stats = {
      maxEntries,
      maxTriangles,
      minimum,
      queries: 0,
      hits: 0,
      builds: 0,
      evictions: 0,
      oversizedBuilds: 0,
      retainedEntries: 0,
      retainedTriangles: 0,
      peakEntries: 0,
      peakTriangles: 0,
    };
  function heightAt(id, x, z, body) {
    stats.queries++;
    let entry = entries.get(id);
    if (entry) {
      stats.hits++;
      entries.delete(id);
      entries.set(id, entry);
    } else {
      const geometry = loadGeometry(id);
      if (!geometry) return null;
      try {
        const p = geometry.getAttribute('position'),
          index = geometry.getIndex(),
          count = index ? index.count : p.count,
          faces = [];
        if (count % 3) throw new Error('Mesh contact projection requires complete triangles');
        for (let i = 0; i < count; i += 3)
          faces.push(
            [0, 1, 2].map((j) => {
              const k = index ? index.getX(i + j) : i + j;
              return [p.getX(k), p.getY(k), p.getZ(k)];
            }),
          );
        entry = { triangles: count / 3, sample: createMeshHeightSampler(faces, { minimum }) };
        stats.builds++;
      } finally {
        geometry.dispose();
      }
      if (entry.triangles <= maxTriangles) {
        while (
          entries.size &&
          (entries.size >= maxEntries || stats.retainedTriangles + entry.triangles > maxTriangles)
        ) {
          const oldest = entries.keys().next().value;
          stats.retainedTriangles -= entries.get(oldest).triangles;
          entries.delete(oldest);
          stats.evictions++;
        }
        entries.set(id, entry);
        stats.retainedTriangles += entry.triangles;
        stats.retainedEntries = entries.size;
        stats.peakEntries = Math.max(stats.peakEntries, entries.size);
        stats.peakTriangles = Math.max(stats.peakTriangles, stats.retainedTriangles);
      } else stats.oversizedBuilds++;
    }
    return entry.sample(x, z, body);
  }
  return {
    heightAt,
    stats,
    clear() {
      entries.clear();
      stats.retainedEntries = 0;
      stats.retainedTriangles = 0;
    },
  };
}
