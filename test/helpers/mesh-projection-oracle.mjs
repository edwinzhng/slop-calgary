// Independent world-coordinate convex clipping. Circle polygons bound the
// analytic runtime's exact disc; OBB polygons give an exact rectangle oracle.
export function bodyPolygon(x, z, body, outer = false, sides = 64) {
  if (body.car)
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [
      x + u * body.hx * body.cos + v * body.hz * body.sin,
      z - u * body.hx * body.sin + v * body.hz * body.cos,
    ]);
  const r = body.radius / (outer ? Math.cos(Math.PI / sides) : 1);
  return Array.from({ length: sides }, (_, i) => [
    x + r * Math.cos(i * 2 * Math.PI / sides),
    z + r * Math.sin(i * 2 * Math.PI / sides),
  ]);
}
export function geometryFaces(geometry) {
  const p = geometry.getAttribute('position'), index = geometry.getIndex(),
    count = index?.count ?? p.count, result = [];
  for (let i = 0; i < count; i += 3)
    result.push([0, 1, 2].map((j) => {
      const k = index ? index.getX(i + j) : i + j;
      return [p.getX(k), p.getY(k), p.getZ(k)];
    }));
  return result;
}
export function clippedRange(faces, footprint) {
  let min = Infinity, max = -Infinity;
  for (const face of faces) {
    let polygon = face;
    for (let edge = 0; edge < footprint.length && polygon.length; edge++) {
      const a = footprint[edge], b = footprint[(edge + 1) % footprint.length],
        side = (p) => (b[0] - a[0]) * (p[2] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]),
        output = [];
      let previous = polygon.at(-1), previousSide = side(previous);
      for (const current of polygon) {
        const currentSide = side(current);
        if ((previousSide >= 0) !== (currentSide >= 0)) {
          const t = previousSide / (previousSide - currentSide);
          output.push(previous.map((v, k) => v + t * (current[k] - v)));
        }
        if (currentSide >= 0) output.push(current);
        previous = current;
        previousSide = currentSide;
      }
      polygon = output;
    }
    for (const p of polygon) { min = Math.min(min, p[1]); max = Math.max(max, p[1]); }
  }
  return { min, max };
}
