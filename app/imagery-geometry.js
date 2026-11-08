// A homography samples a photographed wall's selected corners without repainting it.
// Corner order is top left, top right, bottom right, bottom left in image space.
function homographyMatrix(corners) {
  if (
    !Array.isArray(corners) ||
    corners.length !== 4 ||
    corners.some(
      (p) => !Array.isArray(p) || p.length !== 2 || p.some((v) => !Number.isFinite(v) || v < 0 || v > 1),
    )
  ) {
    throw new TypeError('Photo corners must be four normalized image coordinates');
  }
  const [p0, p1, p2, p3] = corners;
  const dx1 = p1[0] - p2[0],
    dx2 = p3[0] - p2[0];
  const dy1 = p1[1] - p2[1],
    dy2 = p3[1] - p2[1];
  const dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  let g = 0,
    h = 0;
  if (Math.abs(dx3) + Math.abs(dy3) > 1e-10) {
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-12) throw new RangeError('Photo quadrilateral is degenerate');
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  const area = corners.reduce((sum, p, i) => {
    const q = corners[(i + 1) % 4];
    return sum + p[0] * q[1] - p[1] * q[0];
  }, 0);
  if (Math.abs(area) < 1e-8) throw new RangeError('Photo quadrilateral has no area');
  const a = p1[0] - p0[0] + g * p1[0];
  const b = p3[0] - p0[0] + h * p3[0];
  const d = p1[1] - p0[1] + g * p1[1];
  const e = p3[1] - p0[1] + h * p3[1];
  return [a, b, p0[0], d, e, p0[1], g, h, 1];
}

function project(matrix, x, y) {
  const divisor = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(divisor) < 1e-8) throw new RangeError('Photo projection crosses infinity');
  return [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / divisor,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / divisor,
  ];
}

function inverse(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const result = [
      e * i - f * h,
      c * h - b * i,
      b * f - c * e,
      f * g - d * i,
      a * i - c * g,
      c * d - a * f,
      d * h - e * g,
      b * g - a * h,
      a * e - b * d,
    ],
    determinant = a * result[0] + b * result[3] + c * result[6];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new RangeError('Photo surface profile is degenerate');
  return result.map((value) => value / determinant);
}

export function imageHomography(corners) {
  const matrix = homographyMatrix(corners);
  return (x, y) => project(matrix, x, y);
}

// Optional explicit sloping top/base bounds. Their inverse homography converts
// actual wall-plane coordinates into the photograph's corner quadrilateral;
// a simple bilinear stretch would incorrectly tilt the horizontal windows.
function surfaceProjection(facade) {
  const { base = 0.2, height, surfaceProfile, corners } = facade,
    photograph = imageHomography(corners);
  if (!surfaceProfile) return { sample: photograph };
  if (
    surfaceProfile.type !== 'linear-top-base' ||
    ![surfaceProfile.top, surfaceProfile.bottom].every(
      (values) => Array.isArray(values) && values.length === 2 && values.every(Number.isFinite),
    )
  )
    throw new RangeError('Photo surface profile needs explicit finite endpoint tops and bases');
  const { top, bottom } = surfaceProfile;
  for (let i = 0; i < 2; i++)
    if (top[i] - bottom[i] < 0.2 || bottom[i] < base - 1e-8 || top[i] > base + height + 1e-8)
      throw new RangeError('Photo surface profile must remain inside its explicit height bounds');
  const topAt = (s) => top[0] + (top[1] - top[0]) * s,
    bottomAt = (s) => bottom[0] + (bottom[1] - bottom[0]) * s,
    // Endpoint bounds are validated above. Clamp their normalized roundoff
    // (e.g. (8.8 - 3.8) / 5 > 1 by one ULP), not the source wall geometry.
    normalized = (y) => Math.max(0, Math.min(1, (base + height - y) / height)),
    toUnit = inverse(
      homographyMatrix([
        [0, normalized(top[0])],
        [1, normalized(top[1])],
        [1, normalized(bottom[1])],
        [0, normalized(bottom[0])],
      ]),
    ),
    sample = (s, t) => {
      const [u, v] = project(toUnit, s, t);
      return photograph(Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v)));
    };
  return { sample, topAt, bottomAt };
}

export function facadeSamples(facade, subdivisions = 24) {
  if (!Number.isInteger(subdivisions) || subdivisions < 1 || subdivisions > 64) {
    throw new RangeError('Facade subdivisions must be between 1 and 64');
  }
  const { a, b, normal, height, base = 0.2, offset = 0.12, corners } = facade;
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (![...a, ...b, ...normal, height, base, offset].every(Number.isFinite) || width < 0.2 || height <= 0) {
    throw new RangeError('Photo facade needs finite wall coordinates and positive size');
  }
  const surface = surfaceProjection(facade),
    sample = surface.sample,
    positions = [],
    uvs = [],
    indices = [];
  const vertical = Math.max(2, Math.ceil(subdivisions * Math.min(height / width, 1)));
  for (let row = 0; row <= vertical; row++) {
    const t = row / vertical;
    for (let col = 0; col <= subdivisions; col++) {
      const s = col / subdivisions;
      const y = surface.topAt
        ? surface.topAt(s) * (1 - t) + surface.bottomAt(s) * t
        : base + height * (1 - t);
      // A small physical offset avoids coplanar depth fighting against the wall.
      positions.push(
        a[0] + (b[0] - a[0]) * s + normal[0] * offset,
        y,
        a[1] + (b[1] - a[1]) * s + normal[1] * offset,
      );
      const [u, v] = sample(s, surface.topAt ? (base + height - y) / height : t);
      uvs.push(u, 1 - v);
      if (row < vertical && col < subdivisions) {
        const i = row * (subdivisions + 1) + col;
        indices.push(i, i + 1, i + subdivisions + 1, i + 1, i + subdivisions + 2, i + subdivisions + 1);
      }
    }
  }
  return { positions, uvs, indices };
}

// Project only onto real, explicitly selected wall triangles. A photograph may
// cross a shallow setback or parapet; it must not create a solid rectangle over
// the courtyard, flatten a chamfer, or cover another elevation of the compound.
export function measuredFacadeSamples(facade, geometry, subdivisions = 24) {
  if (!Number.isInteger(subdivisions) || subdivisions < 1 || subdivisions > 64)
    throw new RangeError('Invalid decal subdivisions');
  const { a, b, normal, height, base = 0.2, corners, projection } = facade;
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]),
    normalLength = Math.hypot(...normal);
  const minDepth = projection?.minDepth,
    maxDepth = projection?.maxDepth,
    normalMinDot = projection?.normalMinDot ?? 0.85,
    offset = projection?.offset ?? 0.025;
  if (
    ![...a, ...b, ...normal, height, base, minDepth, maxDepth, normalMinDot, offset].every(Number.isFinite) ||
    width < 0.2 ||
    height <= 0 ||
    minDepth > maxDepth ||
    maxDepth - minDepth > 20 ||
    normalLength < 0.9 ||
    normalMinDot < 0.5 ||
    normalMinDot > 1 ||
    offset < 0.005 ||
    offset > 0.1
  )
    throw new RangeError('Measured photo decal needs explicit bounded source-wall depth');
  const tx = (b[0] - a[0]) / width,
    tz = (b[1] - a[1]) / width,
    nx = normal[0] / normalLength,
    nz = normal[1] / normalLength,
    surface = surfaceProjection(facade),
    sample = surface.sample,
    p = geometry.attributes.position,
    index = geometry.index,
    positions = [],
    uvs = [],
    indices = [],
    stats = { sourceTriangles: 0, selectedTriangles: 0, clippedTriangles: 0, outputTriangles: 0 };
  const read = (i) => {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const s = ((x - a[0]) * tx + (z - a[1]) * tz) / width;
    return [
      x,
      y,
      z,
      s,
      (base + height - y) / height,
      (x - a[0]) * nx + (z - a[1]) * nz,
      surface.topAt ? surface.topAt(s) - y : 0,
      surface.bottomAt ? y - surface.bottomAt(s) : 0,
    ];
  };
  const mix = (a, b, t) => a.map((n, i) => n + (b[i] - n) * t);
  function clip(polygon, axis, limit, greater) {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length],
        da = (a[axis] - limit) * (greater ? 1 : -1),
        db = (b[axis] - limit) * (greater ? 1 : -1),
        ina = da >= -1e-8,
        inb = db >= -1e-8;
      if (ina) result.push(a);
      if (ina !== inb) result.push(mix(a, b, da / (da - db)));
    }
    return result;
  }
  const edge2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
    maximumEdge = Math.max(0.35, Math.max(width, height) / subdivisions),
    limit2 = maximumEdge ** 2;
  function emit(a, b, c, normal, level = 0) {
    const ab = edge2(a, b),
      bc = edge2(b, c),
      ca = edge2(c, a);
    if (level < 9 && Math.max(ab, bc, ca) > limit2) {
      if (ab >= bc && ab >= ca) {
        const mid = mix(a, b, 0.5);
        emit(a, mid, c, normal, level + 1);
        emit(mid, b, c, normal, level + 1);
      } else if (bc >= ca) {
        const mid = mix(b, c, 0.5);
        emit(a, b, mid, normal, level + 1);
        emit(a, mid, c, normal, level + 1);
      } else {
        const mid = mix(c, a, 0.5);
        emit(a, b, mid, normal, level + 1);
        emit(mid, b, c, normal, level + 1);
      }
      return;
    }
    const start = positions.length / 3;
    for (const v of [a, b, c]) {
      positions.push(v[0] + normal[0] * offset, v[1] + normal[1] * offset, v[2] + normal[2] * offset);
      const [u, w] = sample(Math.max(0, Math.min(1, v[3])), Math.max(0, Math.min(1, v[4])));
      uvs.push(u, 1 - w);
    }
    indices.push(start, start + 1, start + 2);
    stats.outputTriangles++;
  }
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    stats.sourceTriangles++;
    const vertices = [0, 1, 2].map((k) => read(index ? index.getX(i + k) : i + k)),
      [v0, v1, v2] = vertices,
      u = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]],
      v = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]],
      cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      m = Math.hypot(...cross);
    if (m < 1e-8) continue;
    const n = cross.map((x) => x / m);
    if (Math.abs(n[1]) > 0.2 || n[0] * nx + n[2] * nz < normalMinDot) continue;
    let polygon = vertices;
    const clipping = surface.topAt
      ? [
          [3, 0, true],
          [3, 1, false],
          [6, 0, true],
          [7, 0, true],
          [5, minDepth, true],
          [5, maxDepth, false],
        ]
      : [
          [3, 0, true],
          [3, 1, false],
          [4, 0, true],
          [4, 1, false],
          [5, minDepth, true],
          [5, maxDepth, false],
        ];
    for (const [axis, value, greater] of clipping) {
      polygon = clip(polygon, axis, value, greater);
      if (polygon.length < 3) break;
    }
    if (polygon.length < 3) continue;
    stats.selectedTriangles++;
    stats.clippedTriangles += polygon.length - 2;
    for (let j = 1; j < polygon.length - 1; j++) emit(polygon[0], polygon[j], polygon[j + 1], n);
  }
  return { positions, uvs, indices, stats };
}
