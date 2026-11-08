import * as THREE from 'three/webgpu';
import { readAssetBytes } from './asset-bytes.js';

export async function loadIslandTerrain() {
  const binaryUrl = new URL('../data/calgary-island-relief.bin', import.meta.url);
  const [manifest, binary] = await Promise.all([
    fetch(new URL('../data/calgary-island-relief.json', import.meta.url)).then((r) => {
      if (!r.ok) throw new Error('Island elevation metadata could not be loaded');
      return r.json();
    }),
    fetch(binaryUrl).then((r) => {
      if (!r.ok) throw new Error('Island elevation samples could not be loaded');
      return readAssetBytes(r, binaryUrl);
    }),
  ]);
  return createIslandTerrain(manifest, binary);
}

/** Baked measured relief; all bridge attachments keep their existing shared levels. */
export function createIslandTerrain(manifest, binary) {
  const grids = manifest.grids.map((grid) => ({
    ...grid,
    values: new Float32Array(binary, grid.byteOffset, grid.width * grid.height),
  }));
  const intersects = (b, g) =>
    b.maxX >= g.bounds[0] && b.minX <= g.bounds[2] && b.maxZ >= g.bounds[1] && b.minZ <= g.bounds[3];
  function offsetAt(x, z) {
    for (const grid of grids) {
      const u = (x - grid.origin.x) / grid.step,
        v = (z - grid.origin.z) / grid.step;
      if (u < 0 || v < 0 || u > grid.width - 1 || v > grid.height - 1) continue;
      const ix = Math.min(grid.width - 2, Math.floor(u)),
        iz = Math.min(grid.height - 2, Math.floor(v)),
        tx = u - ix,
        tz = v - iz,
        k = iz * grid.width + ix;
      return (
        (grid.values[k] * (1 - tx) + grid.values[k + 1] * tx) * (1 - tz) +
        (grid.values[k + grid.width] * (1 - tx) + grid.values[k + grid.width + 1] * tx) * tz
      );
    }
    return 0;
  }
  const stats = {
    grids: grids.length,
    bytes: binary.byteLength,
    drapedGeometries: 0,
    addedTriangles: 0,
    maximumOffset: Math.max(...grids.map((g) => g.maximumOffset)),
  };
  return {
    grids,
    manifest,
    stats,
    offsetAt,
    drapeGeometry: createTerrainDraper(offsetAt, (box) => grids.some((g) => intersects(box, g)), stats),
    contains: (x, z) =>
      grids.some((g) => x >= g.bounds[0] && x <= g.bounds[2] && z >= g.bounds[1] && z <= g.bounds[3]),
  };
}

export function createTerrainDraper(
  offsetAt,
  intersectsBounds,
  stats,
  { maxSpan = 20, minEdge = 5, tolerance = 0.035 } = {},
) {
  return function drapeGeometry(geometry, maxEdge = minEdge) {
    geometry.computeBoundingBox();
    const b = geometry.boundingBox;
    if (!intersectsBounds({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z })) return geometry;
    const p = geometry.attributes.position,
      uv = geometry.attributes.uv,
      positions = [],
      uvs = [],
      count = geometry.index?.count ?? p.count;
    const vertex = (i) => [p.getX(i), p.getY(i), p.getZ(i), uv?.getX(i) ?? 0, uv?.getY(i) ?? 0];
    const midpoint = (a, b) => a.map((v, i) => (v + b[i]) * 0.5);
    const length = (a, b) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2;
    function triangle(a, b, c, depth = 0) {
      const box = {
        minX: Math.min(a[0], b[0], c[0]),
        maxX: Math.max(a[0], b[0], c[0]),
        minZ: Math.min(a[2], b[2], c[2]),
        maxZ: Math.max(a[2], b[2], c[2]),
      };
      const ab = length(a, b),
        bc = length(b, c),
        ca = length(c, a);
      const longest = Math.max(ab, bc, ca);
      let curved = longest > maxSpan * maxSpan;
      if (!curved && longest > maxEdge * maxEdge) {
        const ha = offsetAt(a[0], a[2]),
          hb = offsetAt(b[0], b[2]),
          hc = offsetAt(c[0], c[2]);
        curved =
          Math.max(
            Math.abs(offsetAt((a[0] + b[0]) / 2, (a[2] + b[2]) / 2) - (ha + hb) / 2),
            Math.abs(offsetAt((b[0] + c[0]) / 2, (b[2] + c[2]) / 2) - (hb + hc) / 2),
            Math.abs(offsetAt((c[0] + a[0]) / 2, (c[2] + a[2]) / 2) - (hc + ha) / 2),
            Math.abs(offsetAt((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3) - (ha + hb + hc) / 3),
          ) > tolerance;
      }
      if (depth < 24 && longest > maxEdge * maxEdge && curved && intersectsBounds(box)) {
        if (ab >= bc && ab >= ca) {
          const m = midpoint(a, b);
          triangle(a, m, c, depth + 1);
          triangle(m, b, c, depth + 1);
        } else if (bc >= ca) {
          const m = midpoint(b, c);
          triangle(a, b, m, depth + 1);
          triangle(a, m, c, depth + 1);
        } else {
          const m = midpoint(c, a);
          triangle(a, b, m, depth + 1);
          triangle(m, b, c, depth + 1);
        }
        return;
      }
      for (const v of [a, b, c]) {
        positions.push(v[0], v[1] + offsetAt(v[0], v[2]), v[2]);
        if (uv) uvs.push(v[3], v[4]);
      }
    }
    for (let i = 0; i < count; i += 3)
      triangle(...[0, 1, 2].map((j) => vertex(geometry.index ? geometry.index.getX(i + j) : i + j)));
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (uv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    if (geometry.index) {
      const Index = positions.length / 3 > 65535 ? Uint32Array : Uint16Array;
      result.setIndex(
        new THREE.BufferAttribute(
          Index.from({ length: positions.length / 3 }, (_v, i) => i),
          1,
        ),
      );
    }
    result.computeVertexNormals();
    result.computeBoundingBox();
    result.computeBoundingSphere();
    stats.drapedGeometries++;
    stats.addedTriangles += positions.length / 9 - count / 3;
    geometry.dispose();
    return result;
  };
}
