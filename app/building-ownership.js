// Hide an extrusion only while every measured roof that proved its coverage
// is present. Its collision footprint is deliberately retained by world.js.
export function coveredFallbacks(meta, renderedModels) {
  const covered = new Set();
  for (const proof of meta?.coveredFallbacks || []) {
    if (proof.modelIds?.length && proof.modelIds.every((id) => renderedModels.has(id))) covered.add(proof.id);
  }
  // The east Eighth Avenue tower narrowly misses the general 98% footprint
  // threshold (97.42%), but its actual 2013 compound contains both towers.
  if (renderedModels.has('city-outline-27884-0')) covered.add('city-outline-27890-0');
  return covered;
}

// Only identical complete extrusion volumes share a render owner. Ring start
// and winding do not change a polygon; holes and vertical intervals do.
export function fallbackVolumeKey(building, height, minHeight = -1) {
  const ringKey = (source) => {
    const ring = source.slice();
    if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
    const points = ring.map((p) => JSON.stringify(p));
    const cyclic = (list) => {
      let first = 0;
      for (let i = 1; i < list.length; i++) if (list[i] < list[first]) first = i;
      return [...list.slice(first), ...list.slice(0, first)].join(';');
    };
    const forward = cyclic(points),
      reverse = cyclic(points.reverse());
    return forward < reverse ? forward : reverse;
  };
  return JSON.stringify([
    ringKey(building.ring),
    (building.holes || []).map(ringKey).sort(),
    height,
    minHeight,
  ]);
}
