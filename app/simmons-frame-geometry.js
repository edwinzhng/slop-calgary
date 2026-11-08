import { matchesSimmonsSource } from './simmons-evidence.js';
export { matchesSimmonsSource as simmonsSourceMatches };
// Authored frame profiles derived from explicitly inspected source openings.
// Pure buffers: no renderer, world mutation, collision or source-shell edits.
const finitePair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

export function basis(a, b) {
  if (![a, b].every(finitePair)) throw new RangeError('Invalid Simmons wall endpoints');
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (width < 0.5 || width > 50) throw new RangeError('Invalid Simmons wall span');
  return { width, tangent: [(b[0] - a[0]) / width, (b[1] - a[1]) / width] };
}

export function verifyPlane(plane, geometry) {
  const { tangent } = basis(plane.a, plane.b),
    normal = [-tangent[1], tangent[0]];
  const p = geometry.attributes.position,
    n = geometry.attributes.normal;
  if (!Array.isArray(plane.sourceTriangles) || !plane.sourceTriangles.length || !finitePair(plane.top))
    throw new RangeError('Simmons detail needs explicit measured source triangles');
  for (const triangle of plane.sourceTriangles) {
    if (!Number.isInteger(triangle) || triangle < 0 || triangle * 3 + 2 >= p.count)
      throw new RangeError('Invalid Simmons source triangle index');
    for (let c = 0; c < 3; c++) {
      const i = triangle * 3 + c;
      if (Math.abs(n.getY(i)) > 0.01 || n.getX(i) * normal[0] + n.getZ(i) * normal[1] < 0.999)
        throw new RangeError('Simmons detail normal does not match the measured wall');
      if (Math.abs((p.getX(i) - plane.a[0]) * normal[0] + (p.getZ(i) - plane.a[1]) * normal[1]) > 0.015)
        throw new RangeError('Simmons detail leaves its measured wall plane');
    }
  }
  return normal;
}

export function makeBatch() {
  return { positions: [], normals: [], indices: [] };
}

export function mergeOpaque(batches, style) {
  const result = { ...makeBatch(), colors: [] },
    channel = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  for (const key of ['frame', 'lintel', 'sill']) {
    const color = style[`${key}Color`];
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))
      throw new RangeError('Invalid Simmons evidence color');
    const rgb = [1, 3, 5].map((i) => channel(parseInt(color.slice(i, i + 2), 16) / 255)),
      batch = batches[key],
      offset = result.positions.length / 3;
    result.positions.push(...batch.positions);
    result.normals.push(...batch.normals);
    result.indices.push(...batch.indices.map((i) => i + offset));
    for (let i = 0; i < batch.positions.length / 3; i++) result.colors.push(...rgb);
  }
  return result;
}

function emitQuad(batch, points, normal) {
  const start = batch.positions.length / 3;
  for (const p of points) {
    batch.positions.push(...p);
    batch.normals.push(...normal);
  }
  batch.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

function detailBuilder(plane, batches) {
  const { tangent } = basis(plane.a, plane.b),
    normal = [-tangent[1], tangent[0]];
  const point = (u, y, d) => [
    plane.a[0] + tangent[0] * u + normal[0] * d,
    y,
    plane.a[1] + tangent[1] * u + normal[1] * d,
  ];
  const quad = (key, coordinates, n) =>
    emitQuad(
      batches[key],
      coordinates.map((p) => point(...p)),
      n,
    );
  function box(key, u0, u1, y0, y1, d0, d1) {
    if (
      ![u0, u1, y0, y1, d0, d1].every(Number.isFinite) ||
      u1 <= u0 ||
      y1 <= y0 ||
      d1 <= d0 ||
      d0 < 0.025 ||
      d1 > 0.22
    )
      throw new RangeError('Simmons visual detail must have bounded positive dimensions');
    quad(
      key,
      [
        [u0, y0, d1],
        [u1, y0, d1],
        [u1, y1, d1],
        [u0, y1, d1],
      ],
      [normal[0], 0, normal[1]],
    );
    quad(
      key,
      [
        [u1, y0, d0],
        [u0, y0, d0],
        [u0, y1, d0],
        [u1, y1, d0],
      ],
      [-normal[0], 0, -normal[1]],
    );
    quad(
      key,
      [
        [u1, y0, d1],
        [u1, y0, d0],
        [u1, y1, d0],
        [u1, y1, d1],
      ],
      [tangent[0], 0, tangent[1]],
    );
    quad(
      key,
      [
        [u0, y0, d0],
        [u0, y0, d1],
        [u0, y1, d1],
        [u0, y1, d0],
      ],
      [-tangent[0], 0, -tangent[1]],
    );
    quad(
      key,
      [
        [u0, y1, d1],
        [u1, y1, d1],
        [u1, y1, d0],
        [u0, y1, d0],
      ],
      [0, 1, 0],
    );
    quad(
      key,
      [
        [u0, y0, d0],
        [u1, y0, d0],
        [u1, y0, d1],
        [u0, y0, d1],
      ],
      [0, -1, 0],
    );
  }
  function glass(u0, u1, y0, y1) {
    quad(
      'glass',
      [
        [u0, y0, 0.035],
        [u1, y0, 0.035],
        [u1, y1, 0.035],
        [u0, y1, 0.035],
      ],
      [normal[0], 0, normal[1]],
    );
  }
  return { box, glass, normal };
}

export function simmonsWindowGeometry(feature, plane, batches, style) {
  const { u0, u1, top, bottom } = feature,
    residual = feature.fitResidualM,
    photograph = { id: feature.imageId },
    width = basis(plane.a, plane.b).width;
  if (
    ![u0, u1, top, bottom, residual].every(Number.isFinite) ||
    u0 < 0.1 ||
    u1 > width - 0.1 ||
    u1 - u0 < 0.5 ||
    u1 - u0 > 2.4 ||
    top - bottom < 0.8 ||
    top - bottom > 3.3 ||
    residual < 0 ||
    residual > 0.25 ||
    bottom < 5 ||
    top > 7.3
  )
    throw new RangeError('Simmons window geometry needs bounded inspected upper-wall dimensions');
  const { frameM: f, barM: bar, centerM: mid, transomFraction: tf } = style;
  if (
    ![f, bar, mid, tf].every(Number.isFinite) ||
    f < 0.025 ||
    f > 0.1 ||
    bar < 0.015 ||
    bar > 0.05 ||
    mid < f ||
    mid > 0.13 ||
    tf < 0.15 ||
    tf > 0.35
  )
    throw new RangeError('Invalid bounded Simmons frame profile');
  const { box, glass } = detailBuilder(plane, batches),
    depth0 = 0.035,
    depth1 = 0.11,
    cy = bottom + (top - bottom) * (1 - tf),
    cx = (u0 + u1) / 2;
  const rail = (x0, x1, y0, y1) => box('frame', x0, x1, y0, y1, depth0, depth1);
  rail(u0, u0 + f, bottom, top);
  rail(u1 - f, u1, bottom, top);
  rail(u0 + f, u1 - f, bottom, bottom + f);
  rail(u0 + f, u1 - f, top - f, top);
  rail(cx - mid / 2, cx + mid / 2, bottom + f, top - f);
  rail(u0 + f, u1 - f, cy - mid / 2, cy + mid / 2);
  let panes = 0;
  for (const [left, right] of [
    [u0 + f, cx - mid / 2],
    [cx + mid / 2, u1 - f],
  ]) {
    const mx = (left + right) / 2;
    rail(mx - bar / 2, mx + bar / 2, bottom + f, cy - mid / 2);
    rail(mx - bar / 2, mx + bar / 2, cy + mid / 2, top - f);
    const body0 = bottom + f,
      body1 = cy - mid / 2;
    for (let row = 1; row < 3; row++) {
      const yy = body0 + ((body1 - body0) * row) / 3;
      rail(left, right, yy - bar / 2, yy + bar / 2);
    }
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 2; col++) {
        const x0 = col === 0 ? left : mx + bar / 2,
          x1 = col === 0 ? mx - bar / 2 : right;
        const y0 = body0 + ((body1 - body0) * row) / 3 + (row ? bar / 2 : 0),
          y1 = body0 + ((body1 - body0) * (row + 1)) / 3 - (row < 2 ? bar / 2 : 0);
        glass(x0, x1, y0, y1);
        panes++;
      }
    glass(left, mx - bar / 2, cy + mid / 2, top - f);
    glass(mx + bar / 2, right, cy + mid / 2, top - f);
    panes += 2;
  }
  box('lintel', u0 - 0.07, u1 + 0.07, top, top + 0.22, 0.025, 0.105);
  box('sill', u0 - 0.055, u1 + 0.055, bottom - 0.115, bottom, 0.025, 0.18);
  return {
    id: feature.id,
    planeId: plane.id,
    imageId: photograph.id,
    u0,
    u1,
    top,
    bottom,
    transomY: cy,
    width: u1 - u0,
    height: top - bottom,
    fitResidualM: residual,
    panes,
    photographOcclusions: feature.occlusions ?? feature.photographOcclusions,
    metricPrecision: 'Architectural correspondence estimate; not surveyed window dimensions.',
  };
}
