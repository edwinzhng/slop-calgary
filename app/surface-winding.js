/**
 * Ordinary road, bank and rail ribbons are top surfaces. Tight bends can fold
 * their triangulation and reverse a face. Repair the final Float32 geometry,
 * after terrain subdivision, without moving any vertex or changing its UV.
 * Never apply this to closed buildings, bridge bodies or their undersides.
 */
export function orientSurfaceUpward(geometry) {
  const position = geometry.attributes.position;
  let index = geometry.index,
    repaired = 0;
  const count = index?.count ?? position.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const a = index ? index.getX(i) : i,
      b = index ? index.getX(i + 1) : i + 1,
      c = index ? index.getX(i + 2) : i + 2,
      abx = position.getX(b) - position.getX(a),
      abz = position.getZ(b) - position.getZ(a),
      acx = position.getX(c) - position.getX(a),
      acz = position.getZ(c) - position.getZ(a),
      normalY = abz * acx - abx * acz;
    if (!(normalY < 0)) continue;
    if (!index) {
      geometry.setIndex(Array.from({ length: position.count }, (_, j) => j));
      index = geometry.index;
    }
    index.setX(i + 1, c);
    index.setX(i + 2, b);
    repaired++;
  }
  if (repaired) {
    index.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  return repaired;
}
