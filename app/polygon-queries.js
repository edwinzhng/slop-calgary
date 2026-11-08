import { inside, inPolygon } from './geo.js';

// Opt in after authoring static polygons. In-place coordinate edits require a
// new query pool; mutable geometry continues to use geo.inside/inPolygon.
export function createStaticPolygonQueries({
  minEdges = 32,
  maxBins = 64,
  maxReferencesPerEdge = 8,
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  if (
    !Number.isSafeInteger(minEdges) ||
    minEdges < 3 ||
    !Number.isInteger(maxBins) ||
    maxBins < 1 ||
    maxBins > 64 ||
    !Number.isFinite(maxReferencesPerEdge) ||
    maxReferencesPerEdge < 1 ||
    maxReferencesPerEdge > 64 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > 32 * 1024 * 1024
  )
    throw new RangeError('Invalid static polygon query limits');

  const rings = new WeakMap(),
    polygons = new WeakMap(),
    stats = { preparedRings: 0, directRings: 0, bytes: 0, references: 0, largestBins: 0 };

  function direct(ring) {
    rings.set(ring, null);
    stats.directRings++;
    return null;
  }

  function prepareRing(ring) {
    const cached = rings.get(ring);
    if (cached !== undefined) return cached;
    const length = ring.length;
    if (length < minEdges || length > 0xffffffff || maxBins === 1 || maxBytes === 0) return direct(ring);
    let minZ = Infinity,
      maxZ = -Infinity;
    for (const point of ring) {
      if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) return direct(ring);
      minZ = Math.min(minZ, point[1]);
      maxZ = Math.max(maxZ, point[1]);
    }
    const span = maxZ - minZ;
    if (!(span > 0 && Number.isFinite(span))) return direct(ring);
    const requestedBins = Math.min(maxBins, Math.max(2, Math.ceil(Math.sqrt(length)))),
      boundaries = [minZ];
    for (let i = 1; i < requestedBins; i++) {
      const cut = minZ + span * (i / requestedBins);
      if (cut > boundaries.at(-1) && cut < maxZ) boundaries.push(cut);
    }
    boundaries.push(maxZ);
    const cuts = Float64Array.from(boundaries),
      count = cuts.length - 1,
      temporaryBytes = length * 2 + count * 8;
    if (count < 2 || stats.bytes + cuts.byteLength + temporaryBytes > maxBytes) return direct(ring);

    const first = new Uint8Array(length),
      last = new Uint8Array(length),
      counts = new Uint32Array(count);
    let references = 0;
    for (let i = 0, j = length - 1; i < length; j = i++) {
      const az = ring[i][1],
        bz = ring[j][1];
      if (az === bz) {
        first[i] = 255;
        continue;
      }
      first[i] = binAt(Math.min(az, bz), cuts);
      last[i] = binAt(Math.max(az, bz), cuts);
      // Include the upper endpoint's bin. The original crossing comparison
      // rejects an extra edge at that endpoint without moving the boundary.
      references += last[i] - first[i] + 1;
      if (references > length * maxReferencesPerEdge || references > 0xffffffff) return direct(ring);
      for (let bin = first[i]; bin <= last[i]; bin++) counts[bin]++;
    }
    const bytes = cuts.byteLength + (count + 1) * 4 + references * 4;
    if (stats.bytes + bytes + temporaryBytes > maxBytes) return direct(ring);
    const offsets = new Uint32Array(count + 1);
    for (let bin = 0; bin < count; bin++) offsets[bin + 1] = offsets[bin] + counts[bin];
    const cursor = offsets.slice(0, count),
      edges = new Uint32Array(references);
    for (let i = 0; i < length; i++) {
      if (first[i] === 255) continue;
      for (let bin = first[i]; bin <= last[i]; bin++) edges[cursor[bin]++] = i;
    }
    const prepared = { ring, length, cuts, offsets, edges };
    rings.set(ring, prepared);
    stats.preparedRings++;
    stats.bytes += bytes;
    stats.references += references;
    stats.largestBins = Math.max(stats.largestBins, count);
    return prepared;
  }

  function preparePolygon(polygon) {
    const cached = polygons.get(polygon);
    if (cached !== undefined) return cached;
    const exterior = prepareRing(polygon.ring),
      holes = polygon.holes?.map(prepareRing);
    // Short/direct polygons retain no query wrappers or copied coordinates.
    const prepared = exterior || holes?.some(Boolean) ? { exterior, holes: holes || [] } : null;
    polygons.set(polygon, prepared);
    return prepared;
  }
  return { preparePolygon, stats };
}

function binAt(z, cuts) {
  let lo = 0,
    hi = cuts.length - 1;
  // Use the same explicit boundaries for edges and queries, avoiding
  // disagreement from separately dividing their coordinates into bins.
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (z < cuts[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

function insidePreparedRing(x, z, ring, prepared) {
  if (!prepared || prepared.ring !== ring || prepared.length !== ring.length) return inside(x, z, ring);
  const { cuts, offsets, edges } = prepared;
  if (z < cuts[0] || z >= cuts[cuts.length - 1]) return false;
  const bin = binAt(z, cuts);
  let yes = false;
  for (let at = offsets[bin]; at < offsets[bin + 1]; at++) {
    const i = edges[at],
      j = i ? i - 1 : ring.length - 1,
      a = ring[i],
      b = ring[j];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}

export function containsPreparedPolygon(x, z, polygon, prepared) {
  if (!prepared) return inPolygon(x, z, polygon);
  if (!insidePreparedRing(x, z, polygon.ring, prepared.exterior)) return false;
  const holes = polygon.holes;
  if (holes)
    for (let i = 0; i < holes.length; i++)
      if (i in holes && insidePreparedRing(x, z, holes[i], prepared.holes[i])) return false;
  return true;
}
