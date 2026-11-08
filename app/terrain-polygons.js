import * as THREE from 'three/webgpu';

// Split an attributed convex polygon without changing its winding.
export function splitTerrainPolygon(polygon, signedDistance) {
  const below = [],
    above = [];
  let a = polygon.at(-1),
    d0 = signedDistance(a);
  for (const b of polygon) {
    const d1 = signedDistance(b);
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      const mid = a.map((v, i) => v + (b[i] - v) * t);
      below.push(mid);
      above.push(mid);
    }
    if (d1 <= 0) below.push(b);
    if (d1 >= 0) above.push(b);
    a = b;
    d0 = d1;
  }
  return [below, above];
}

export function terrainPolygonBounds(polygon) {
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const [x, , z] of polygon) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

export function remeshTerrain(geometry, transform, offsetAt = () => 0) {
  const p = geometry.attributes.position,
    uv = geometry.attributes.uv,
    index = geometry.index,
    positions = [],
    uvs = [],
    indices = [];
  const read = (i) => {
    const n = index ? index.getX(i) : i;
    return [p.getX(n), p.getY(n), p.getZ(n), uv?.getX(n) ?? 0, uv?.getY(n) ?? 0];
  };
  const emit = (polygon) => {
    const base = positions.length / 3;
    for (const [x, y, z, u, v] of polygon) {
      positions.push(x, y + offsetAt(x, z), z);
      if (uv) uvs.push(u, v);
    }
    for (let i = 2; i < polygon.length; i++) {
      const a = polygon[0],
        b = polygon[i - 1],
        c = polygon[i];
      if (Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) > 1e-9)
        indices.push(base, base + i - 1, base + i);
    }
  };
  for (let i = 0; i < (index?.count ?? p.count); i += 3) transform([read(i), read(i + 1), read(i + 2)], emit);
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (uv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  result.setIndex(indices);
  result.computeVertexNormals();
  geometry.dispose();
  return result;
}
