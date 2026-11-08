// Mesh-projected contact heights for measured building solids and suspended shells.
// This module retains no rendering objects and makes no ownership/solid-interior decision.
export function projectedMeshHeightAt(faces, x, z) {
  let y = null;
  for (const [a, b, c] of faces) {
    const abx = b[0] - a[0],
      abz = b[2] - a[2],
      acx = c[0] - a[0],
      acz = c[2] - a[2],
      det = abx * acz - abz * acx;
    if (!det) continue;
    const u = ((x - a[0]) * acz - (z - a[2]) * acx) / det,
      v = (abx * (z - a[2]) - abz * (x - a[0])) / det;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
    const value = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
    y = y === null ? value : Math.max(y, value);
  }
  return y;
}

function clipRoofFace(polygon, axis, value, greater) {
  if (!polygon.length) return polygon;
  const result = [];
  let previous = polygon.at(-1),
    wasInside = greater ? previous[axis] >= value : previous[axis] <= value;
  for (const current of polygon) {
    const inside = greater ? current[axis] >= value : current[axis] <= value;
    if (inside !== wasInside) {
      const t = (value - previous[axis]) / (current[axis] - previous[axis]);
      result.push(previous.map((n, i) => n + (current[i] - n) * t));
    }
    if (inside) result.push(current);
    previous = current;
    wasInside = inside;
  }
  return result;
}

/** Contact envelope of the actual triangle projection. An optional body follows
 * footprintContact's circle/rotated-box convention, not a 3D sphere. The default
 * is an upper envelope with -Infinity for no overlap; minimum:true produces a
 * lower envelope with +Infinity for no overlap. Neither restores a global peak.
 * Point-only queries retain exact interior heights and clamp an outside centre
 * to the nearest local boundary. Ownership/solid-interior policy stays external.
 */
export function createMeshHeightSampler(faces, { minimum = false } = {}) {
  if (minimum) {
    const negative = createMeshHeightSampler(
      faces.map((triangle) => triangle.map(([x, y, z]) => [x, -y, z])),
    );
    return (x, z, body) => -negative(x, z, body);
  }
  const compiled = faces.map((triangle) => {
    const [a, b, c] = triangle,
      bx = b[0] - a[0],
      bz = b[2] - a[2],
      cx = c[0] - a[0],
      cz = c[2] - a[2],
      det = bx * cz - bz * cx;
    return {
      triangle,
      minX: Math.min(a[0], b[0], c[0]),
      maxX: Math.max(a[0], b[0], c[0]),
      minZ: Math.min(a[2], b[2], c[2]),
      maxZ: Math.max(a[2], b[2], c[2]),
      // Subpixel ownership seams can contain zero-area projected faces after
      // quantization; their vertices/edges still have a bounded contact height.
      gradientX: det ? ((b[1] - a[1]) * cz - (c[1] - a[1]) * bz) / det : 0,
      gradientZ: det ? (bx * (c[1] - a[1]) - cx * (b[1] - a[1])) / det : 0,
    };
  });
  return (x, z, body) => {
    if (!body) {
      const actual = projectedMeshHeightAt(faces, x, z);
      if (actual !== null) return actual;
      let distance = Infinity,
        height = -Infinity;
      for (const { triangle } of compiled)
        for (let i = 0; i < 3; i++) {
          const a = triangle[i],
            b = triangle[(i + 1) % 3],
            dx = b[0] - a[0],
            dz = b[2] - a[2],
            length2 = dx * dx + dz * dz,
            t = length2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / length2)) : 0,
            d = (a[0] + t * dx - x) ** 2 + (a[2] + t * dz - z) ** 2,
            y = a[1] + t * (b[1] - a[1]);
          if (d < distance - 1e-10) {
            distance = d;
            height = y;
          } else if (Math.abs(d - distance) <= 1e-10) height = Math.max(height, y);
        }
      return height;
    }
    const car = body.car === true,
      radius = Math.max(0, body.radius || 0),
      halfX = car ? body.hx : radius,
      halfZ = car ? body.hz : radius,
      cosine = car ? body.cos : 1,
      sine = car ? body.sin : 0,
      extentX = Math.abs(cosine) * halfX + Math.abs(sine) * halfZ,
      extentZ = Math.abs(sine) * halfX + Math.abs(cosine) * halfZ;
    let height = -Infinity;
    for (const face of compiled) {
      if (
        face.maxX < x - extentX ||
        face.minX > x + extentX ||
        face.maxZ < z - extentZ ||
        face.minZ > z + extentZ
      )
        continue;
      const triangle = face.triangle;
      if (car) {
        let polygon = triangle.map(([px, py, pz]) => [
          (px - x) * cosine - (pz - z) * sine,
          py,
          (px - x) * sine + (pz - z) * cosine,
        ]);
        for (const [axis, value, greater] of [
          [0, -halfX, true],
          [0, halfX, false],
          [2, -halfZ, true],
          [2, halfZ, false],
        ])
          polygon = clipRoofFace(polygon, axis, value, greater);
        for (const p of polygon) height = Math.max(height, p[1]);
        continue;
      }
      const r2 = radius * radius;
      for (let i = 0; i < 3; i++) {
        const a = triangle[i],
          b = triangle[(i + 1) % 3],
          ax = a[0] - x,
          az = a[2] - z,
          dx = b[0] - a[0],
          dz = b[2] - a[2];
        if (ax * ax + az * az <= r2) height = Math.max(height, a[1]);
        const aa = dx * dx + dz * dz,
          bb = 2 * (ax * dx + az * dz),
          cc = ax * ax + az * az - r2,
          discriminant = bb * bb - 4 * aa * cc;
        if (aa > 0 && discriminant >= 0) {
          const root = Math.sqrt(discriminant);
          for (const t of [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)])
            if (t >= 0 && t <= 1) height = Math.max(height, a[1] + t * (b[1] - a[1]));
        }
      }
      const gradient = Math.hypot(face.gradientX, face.gradientZ),
        qx = x + (gradient ? (radius * face.gradientX) / gradient : 0),
        qz = z + (gradient ? (radius * face.gradientZ) / gradient : 0),
        arcMaximum = projectedMeshHeightAt([triangle], qx, qz);
      if (arcMaximum !== null) height = Math.max(height, arcMaximum);
    }
    return height;
  };
}
