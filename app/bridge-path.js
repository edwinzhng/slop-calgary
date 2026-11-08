const paths = new WeakMap();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const seamTolerance = 0.0005;

/** Shared inferred cross sections retain every mapped source bend. */
export function bridgePath(points) {
  let path = paths.get(points);
  if (path) return path;
  if (!Array.isArray(points) || points.length < 2) throw new Error('Invalid bridge path');
  const arcs = [0],
    lengths = [],
    directions = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (![a?.[0], a?.[1], b?.[0], b?.[1]].every(Number.isFinite))
      throw new Error('Invalid bridge path point');
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz);
    if (length < 1e-8) throw new Error('Degenerate bridge source edge');
    lengths.push(length);
    directions.push([dx / length, dz / length]);
    arcs.push(arcs.at(-1) + length);
  }
  const normals = points.map((_point, i) => {
    const a = directions[Math.max(0, i - 1)],
      b = directions[Math.min(directions.length - 1, i)];
    let nx = -a[1] - b[1],
      nz = a[0] + b[0],
      length = Math.hypot(nx, nz);
    if (length < 1e-8) return [-a[1], a[0]];
    nx /= length;
    nz /= length;
    // Bound inferred joins on acute digitized bends, as on the custom 9A ramp.
    const scale = Math.min(1.6, 1 / Math.max(0.35, nx * -a[1] + nz * a[0]));
    return [nx * scale, nz * scale];
  });
  const length = arcs.at(-1),
    stations = [0];
  for (let i = 0; i < lengths.length; i++) {
    const count = Math.max(1, Math.ceil(lengths[i] / 5));
    for (let j = 1; j <= count; j++)
      stations.push(j === count ? arcs[i + 1] / length : (arcs[i] + (lengths[i] * j) / count) / length);
  }
  stations[stations.length - 1] = 1;
  const sample = (t) => {
    if (!Number.isFinite(t)) throw new Error('Invalid bridge station');
    const wanted = clamp(t, 0, 1) * length;
    let low = 0,
      high = lengths.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (wanted > arcs[mid + 1]) low = mid + 1;
      else high = mid;
    }
    const i = low,
      u = clamp((wanted - arcs[i]) / lengths[i], 0, 1),
      a = points[i],
      b = points[i + 1],
      na = normals[i],
      nb = normals[i + 1];
    return {
      x: a[0] + (b[0] - a[0]) * u,
      z: a[1] + (b[1] - a[1]) * u,
      dx: directions[i][0],
      dz: directions[i][1],
      nx: na[0] + (nb[0] - na[0]) * u,
      nz: na[1] + (nb[1] - na[1]) * u,
    };
  };
  path = { length, arcs, normals, stations, sample };
  paths.set(points, path);
  return path;
}

export function bridgePathPoint(plan, t, offset, y) {
  const q = bridgePath(plan.points).sample(t);
  return [q.x + q.nx * offset, y, q.z + q.nz * offset];
}

export const BRIDGE_BAND_TRIANGLES = Object.freeze([
  Object.freeze([0, 1, 3]),
  Object.freeze([1, 4, 3]),
  Object.freeze([1, 2, 4]),
  Object.freeze([2, 5, 4]),
]);

/** A split at the band centre keeps the mapped centreline on triangle edges. */
export function bridgeBand(plan, from, to, low, high, y0, y1, offsetAt) {
  const middle = (low + high) / 2,
    vertices = [
      bridgePathPoint(plan, from, low, y0),
      bridgePathPoint(plan, from, middle, y0),
      bridgePathPoint(plan, from, high, y0),
      bridgePathPoint(plan, to, low, y1),
      bridgePathPoint(plan, to, middle, y1),
      bridgePathPoint(plan, to, high, y1),
    ].map(([x, y, z]) => [Math.fround(x), Math.fround(y + (offsetAt?.(x, y, z) || 0)), Math.fround(z)]),
    minX = Math.min(...vertices.map((p) => p[0])),
    maxX = Math.max(...vertices.map((p) => p[0])),
    minZ = Math.min(...vertices.map((p) => p[2])),
    maxZ = Math.max(...vertices.map((p) => p[2])),
    planes = [];
  let foldedTriangles = 0,
    degenerateTriangles = 0;
  for (const ids of BRIDGE_BAND_TRIANGLES) {
    const [a, b, c] = ids.map((i) => vertices[i]),
      bx = b[0] - a[0],
      bz = b[2] - a[2],
      cx = c[0] - a[0],
      cz = c[2] - a[2],
      determinant = bx * cz - bz * cx;
    if (determinant > 1e-8) foldedTriangles++;
    if (Math.abs(determinant) < 1e-10) {
      degenerateTriangles++;
      continue;
    }
    const absolute = Math.abs(determinant);
    planes.push({
      x: a[0],
      z: a[2],
      y: a[1],
      bx,
      bz,
      cx,
      cz,
      by: b[1] - a[1],
      cy: c[1] - a[1],
      determinant,
      uTolerance: (seamTolerance * Math.hypot(cx, cz)) / absolute,
      vTolerance: (seamTolerance * Math.hypot(bx, bz)) / absolute,
      sumTolerance: (seamTolerance * Math.hypot(cx - bx, cz - bz)) / absolute,
    });
  }
  return {
    vertices,
    bounds: { minX, maxX, minZ, maxZ },
    foldedTriangles,
    degenerateTriangles,
    clipSegment(a, b, heightTolerance = 0.08) {
      const intervals = [];
      const dx = b[0] - a[0],
        dz = b[2] - a[2],
        dy = b[1] - a[1];
      for (const p of planes) {
        const x = a[0] - p.x,
          z = a[2] - p.z,
          u0 = (x * p.cz - z * p.cx) / p.determinant,
          v0 = (p.bx * z - p.bz * x) / p.determinant,
          du = (dx * p.cz - dz * p.cx) / p.determinant,
          dv = (p.bx * dz - p.bz * dx) / p.determinant,
          difference = a[1] - (p.y + u0 * p.by + v0 * p.cy),
          change = dy - du * p.by - dv * p.cy;
        let from = 0,
          to = 1;
        for (const [value, slope] of [
          [u0, du],
          [v0, dv],
          [1 - u0 - v0, -du - dv],
          [heightTolerance - difference, -change],
          [heightTolerance + difference, change],
        ]) {
          if (Math.abs(slope) < 1e-12) {
            if (value < -1e-9) {
              to = -1;
              break;
            }
          } else if (slope > 0) from = Math.max(from, -value / slope);
          else to = Math.min(to, -value / slope);
          if (to <= from) break;
        }
        if (to - from > 1e-8) intervals.push([from, to]);
      }
      return intervals;
    },
    heightAt(x, z) {
      // Source poses use doubles while rendered vertices are Float32. Limit
      // seam acceptance in metres rather than an area-dependent barycentric epsilon.
      if (
        x < minX - seamTolerance ||
        x > maxX + seamTolerance ||
        z < minZ - seamTolerance ||
        z > maxZ + seamTolerance
      )
        return null;
      let height = null;
      for (const p of planes) {
        const dx = x - p.x,
          dz = z - p.z,
          u = (dx * p.cz - dz * p.cx) / p.determinant,
          v = (p.bx * dz - p.bz * dx) / p.determinant;
        if (u < -p.uTolerance || v < -p.vTolerance || u + v > 1 + p.sumTolerance) continue;
        const y = p.y + u * p.by + v * p.cy;
        height = Math.max(height ?? -Infinity, y);
      }
      return height;
    },
  };
}
