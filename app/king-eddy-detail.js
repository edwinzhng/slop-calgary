// Visible south/east hotel walls in the September 2026 Commons photograph.
// Anchors are unchanged City mesh vertices. Window spacing and steel dimensions
// are visual estimates; the photograph does not expose the whole rear elevation.
export const KING_EDDY_DETAIL = Object.freeze({
  sourceId: 'city-outline-27712-0',
  sourceSha256: 'd5b16e05f47941ffcee713d7b0e04d6f90a07e2952239fb4716830f707742bb9',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:King_Eddy,_Calgary.jpg',
  capturedAt: '2026-09-15 15:58:35',
  outerTriangles: Object.freeze([156, 157, 158, 159, 160, 161, 162, 163]),
  corniceBase: 9.55,
  corniceTop: 10.14,
  faces: Object.freeze([
    { name: 'south', a: [1280.44, 154.44], b: [1291.96, 155.06], normal: [-0.0537434, 0.9985548], bays: [0.23, 0.51, 0.79] },
    { name: 'east', a: [1293.46, 153.40], b: [1294.30, 135.46], normal: [0.9989057, 0.0467708], bays: [0.14, 0.28, 0.42, 0.56, 0.70, 0.84] },
  ]),
});

export function isKingEddyObservedWall(id, triangle) {
  return id === KING_EDDY_DETAIL.sourceId && KING_EDDY_DETAIL.outerTriangles.includes(triangle);
}

export function kingEddyFacadeDetails() {
  const windows = [], cornices = [];
  for (const face of KING_EDDY_DETAIL.faces) {
    const dx = face.b[0] - face.a[0], dz = face.b[1] - face.a[1], length = Math.hypot(dx, dz);
    const point = (t, offset) => [
      face.a[0] + dx * t + face.normal[0] * offset,
      face.a[1] + dz * t + face.normal[1] * offset,
    ];
    const rotation = -Math.atan2(dz, dx);
    for (const y of [5.15, 8.0])
      for (const t of face.bays)
        windows.push({ face: face.name, t, position: point(t, 0.065), y, width: 0.95, height: 1.72, depth: 0.07, rotation });
    // A bounded ground opening, away from the chamfered corner and sign.
    for (const t of face.name === 'east' ? [0.21, 0.57, 0.84] : [0.51])
      windows.push({ face: face.name, t, position: point(t, 0.065), y: 1.7, width: 1.35, height: 2.55, depth: 0.07, rotation });
    for (const [y, height, depth] of [[9.65, 0.16, 0.19], [9.96, 0.13, 0.28], [10.15, 0.09, 0.34]])
      cornices.push({ face: face.name, position: point(0.5, depth * 0.35), y, width: length, height, depth, rotation });
  }
  // The open steel pergola is visible in the reference. This regular frame is
  // approximate and sits inside the source roof/parapet, not on an invented box.
  const roof = { origin: [1281.35, 153.10], u: [0.99855, 0.05374], v: [0.04677, -0.99891], width: 10.6, depth: 16.65, base: 8.9, top: 11.35 };
  const roofPoint = (u, v, y) => [roof.origin[0] + roof.u[0] * u + roof.v[0] * v, y, roof.origin[1] + roof.u[1] * u + roof.v[1] * v];
  const beams = [];
  for (const u of [0, roof.width / 2, roof.width]) {
    for (const v of [0, roof.depth / 2, roof.depth]) beams.push([roofPoint(u, v, roof.base), roofPoint(u, v, roof.top)]);
    beams.push([roofPoint(u, 0, roof.top), roofPoint(u, roof.depth, roof.top)]);
  }
  for (let i = 0; i <= 4; i++) beams.push([roofPoint(0, roof.depth * i / 4, roof.top), roofPoint(roof.width, roof.depth * i / 4, roof.top)]);
  return { windows, cornices, beams };
}
