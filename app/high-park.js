import * as THREE from 'three/webgpu';
import { unproject } from './geo.js';

export function buildHighPark({ add, box, beam, rectangle, sign, labels, cityMeshes, steps }) {
  const high = 'High Park';
  const id = 'city-outline-26619-0';
  const record = cityMeshes?.get(id);
  if (record?.structureIds.length !== 1 || record.structureIds[0] !== 1352575 || record.indexCount !== 1077)
    return null;
  const level = (x, z) => {
    const y = cityMeshes.collisionHeightAt(id, x, z);
    return y >= 12 && y <= 18 ? y : null;
  };
  const colors = [0xd787aa, 0xd39568, 0xe7bc5c, 0x86aa80, 0x67a9b5, 0x9f8abb];
  const deckZ = 214.8;
  const floor = (x, z, w, d, paint, lift = 0.025) => {
    const geometry = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, 0, z);
    const p = geometry.attributes.position;
    const centre = level(x, z);
    for (let i = 0; i < p.count; i++) {
      const y = level(p.getX(i), p.getZ(i));
      if (y === null || centre === null || Math.abs(y - centre) > 0.35) {
        geometry.dispose();
        return false;
      }
      p.setY(i, y + lift);
    }
    geometry.computeVertexNormals();
    add(high, geometry, paint);
    return true;
  };
  for (let x = 56; x < 240; x += 2) {
    const y = level(x, deckZ);
    if (y === null || level(x - 1, deckZ) === null || level(x + 1, deckZ) === null) continue;
    const paint = colors[Math.floor((x - 56) / 31) % colors.length];
    box(high, x, y + 0.045, deckZ, 2.008, 0.09, 2.55, paint);
    for (const edge of [-1.18, 1.18]) floor(x, deckZ + edge, 1.98, 0.048, 0xeaddb4, 0.095);
    for (let seam = -0.76; seam <= 0.77; seam += 0.25) floor(x + seam, deckZ, 0.011, 2.32, 0x928173, 0.098);
    const step = rectangle(`high-park-boardwalk-${x}`, x, deckZ, 2.008, 2.55, y, y + 0.09);
    step.type = 'park-step';
    steps.push(step);
  }

  // The park occupies the connected southern deck. Trace its edge so the
  // guards follow the roof around the drive ramp and the service recesses.
  const edgeAt = (x, dir) => {
    const home = level(x, deckZ);
    if (home === null) return null;
    let z = deckZ;
    for (let next = z + dir * 0.3; Math.abs(next - deckZ) < 15; next += dir * 0.3) {
      const y = level(x, next);
      if (y === null || Math.abs(y - home) > 0.31) break;
      z = next;
    }
    const inset = z - dir * 0.27;
    return [x, level(x, inset) ?? home, inset];
  };
  const guard = (a, b, id) => {
    if (!a || !b) return;
    const dx = b[0] - a[0],
      dz = b[2] - a[2];
    const w = Math.hypot(dx, dz);
    if (w < 0.04) return;
    const y = (a[1] + b[1]) / 2,
      yaw = Math.atan2(-dz, dx);
    const x = (a[0] + b[0]) / 2,
      z = (a[2] + b[2]) / 2;
    for (const h of [0.47, 1.04]) box(high, x, y + h, z, w + 0.05, 0.045, 0.06, 0x47555d, yaw);
    box(high, a[0], a[1] + 0.55, a[2], 0.063, 1.1, 0.063, 0x47555d);
    rectangle(id, x, z, w + 0.04, 0.1, y, y + 1.12, yaw);
  };
  for (const dir of [-1, 1]) {
    let previous = edgeAt(56, dir);
    for (let x = 58; x <= 240; x += 2) {
      const edge = edgeAt(x, dir);
      guard(previous, edge, `high-park-guard-${dir}-${x}`);
      previous = edge;
    }
  }
  for (const x of [56, 240]) guard(edgeAt(x, -1), edgeAt(x, 1), `high-park-end-${x}`);

  // Concrete joints and old stall paint remain visible where the parklets
  // leave the original parking deck exposed.
  for (let x = 60; x < 238; x += 6) {
    for (const side of [-1, 1]) {
      const edge = edgeAt(x, side);
      if (!edge) continue;
      const start = deckZ + side * 1.34;
      const end = edge[2] - side * 0.16;
      const depth = (end - start) * side;
      if (depth > 1.1) floor(x, (end + start) / 2, 0.035, depth, 0x5b6369, 0.013);
    }
  }
  for (const [x, z] of [
    [64, 218.8],
    [69, 218.8],
    [74, 218.8],
    [119, 211.2],
    [171, 211.2],
    [176, 211.2],
    [229, 211.2],
    [234, 211.2],
  ])
    floor(x, z, 0.072, 1.5, 0x9a9990, 0.018);

  for (const [x, z, paint, w] of [
    [77, 210.6, colors[0], 18],
    [110, 218.2, colors[1], 16],
    [160, 219.1, colors[3], 12],
    [187, 209.7, colors[4], 11],
    [227, 220.2, colors[5], 15],
  ]) {
    if (!floor(x, z, w, 3.7, paint)) continue;
    const y = level(x, z);
    box(high, x, y + 0.23, z, 3.8, 0.46, 0.63, 0x7a6050);
    box(high, x, y + 0.48, z, 3.92, 0.08, 0.72, 0xc5a77a);
    rectangle(`high-park-seat-${x}`, x, z, 3.92, 0.72, y, y + 0.52);
    for (const dx of [-w / 2 + 1, w / 2 - 1]) {
      const px = x + dx,
        py = level(px, z);
      if (py === null) continue;
      box(high, px, py + 0.23, z, 1.15, 0.46, 1.18, 0x776b58);
      box(high, px, py + 0.455, z, 1.02, 0.025, 1.02, 0x52493c);
      for (let i = 0; i < 7; i++) {
        const a = i * 2.4;
        add(
          high,
          new THREE.IcosahedronGeometry(0.23, 0)
            .scale(0.65, 1.4, 0.65)
            .translate(px + 0.36 * Math.cos(a), py + 0.67, z + 0.36 * Math.sin(a)),
          i % 2 ? 0x76825a : 0x596d51,
        );
      }
      rectangle(`high-park-planter-${px}`, px, z, 1.15, 1.18, py, py + 0.46);
    }
  }

  const picnic = (x, z, tint) => {
    const y = level(x, z);
    if (y === null) return;
    for (const offset of [-0.51, 0.51]) {
      box(high, x, y + 0.41, z + offset, 1.94, 0.09, 0.29, tint);
      box(high, x, y + 0.18, z + offset, 1.57, 0.095, 0.08, 0x766353);
    }
    for (const side of [-1, 1])
      for (const dz of [-0.56, 0.56]) {
        const base = new THREE.Vector3(x + side * 0.71, y, z + dz);
        const end = new THREE.Vector3(x + side * 0.71, y + 0.72, z + dz * 0.3);
        beam(high, base, end, 0.045, 0.045, 0x766353, 5);
      }
    for (const dz of [-0.21, 0, 0.21]) box(high, x, y + 0.735, z + dz, 2.04, 0.078, 0.199, tint);
    rectangle(`high-park-picnic-${x}`, x, z, 1.96, 1.3, y, y + 0.78);
  };
  picnic(72, 208.8, 0xc983a0);
  picnic(103, 218.5, 0xcd8e66);
  picnic(185, 218.8, 0x91b18d);
  picnic(229, 222.4, 0x9b88ba);

  for (const [x, z, tint, phrase] of [
    [82, 208.5, colors[0], 'SEE YOU UP TOP'],
    [116, 219.3, colors[1], 'STAY A LITTLE LONGER'],
    [182, 208.5, colors[4], 'WATCH THE SKY CHANGE'],
    [233, 224.4, colors[5], 'ABOVE THE BELTLINE'],
  ]) {
    const y = level(x, z);
    if (y === null) continue;
    for (const u of [-2.48, 2.48]) box(high, x + u, y + 1.23, z, 0.11, 2.46, 0.15, 0x997757);
    for (const h of [0.82, 2.45]) box(high, x, y + h, z, 5.05, 0.13, 0.16, 0xc2a079);
    box(high, x, y + 1.64, z, 4.82, 1.51, 0.11, tint);
    const facingSouth = z < deckZ;
    sign(
      `High Park / ${phrase}`,
      phrase,
      x,
      y + 1.64,
      z + (facingSouth ? 0.085 : -0.085),
      4.76,
      1.44,
      facingSouth ? 0 : Math.PI,
      '#28333d',
    );
    rectangle(`high-park-screen-${x}`, x, z, 5.05, 0.17, y, y + 2.51);
  }

  if (floor(177, 220.1, 18, 6.3, 0x718850)) {
    for (let i = 0; i < 8; i++) floor(169.2 + i * 2.2, 220.1, 1.12, 5.95, i % 2 ? 0x768f57 : 0x7b915e, 0.03);
  }
  const stage = { x: 158, z: 218.8 };
  const stageY = level(stage.x, stage.z);
  if (stageY !== null && floor(stage.x, stage.z, 9.2, 4.25, 0xc58a6f)) {
    box(high, stage.x, stageY + 0.12, stage.z, 7.6, 0.24, 3.3, 0x9d785f);
    for (let i = 0; i < 18; i++)
      box(high, stage.x - 3.55 + i * 0.42, stageY + 0.237, stage.z, 0.013, 0.01, 3.24, 0x725642);
    const slab = rectangle('high-park-stage', stage.x, stage.z, 7.6, 3.3, stageY, stageY + 0.24);
    slab.type = 'park-step';
    steps.push(slab);
    for (const [x, color] of [
      [155.9, 0xc4778d],
      [158.1, 0x658d98],
      [160.3, 0xdba85d],
    ]) {
      box(high, x, stageY + 1.21, 220.42, 2.18, 1.94, 0.1, color);
      box(high, x - 0.32, stageY + 1.14, 220.35, 0.24, 2.04, 0.025, 0xf1dba4, 0);
    }
    rectangle('high-park-stage-backdrop', 158.1, 220.42, 6.57, 0.12, stageY, stageY + 2.18);
  }

  const tableY = level(117, 209.8);
  if (tableY !== null && floor(117, 209.8, 5.4, 3.6, 0xddaa78)) {
    for (const side of [-1, 1])
      box(high, 117 + side * 0.99, tableY + 0.39, 209.8, 0.11, 0.78, 1.38, 0x575a60);
    box(high, 117, tableY + 0.78, 209.8, 2.74, 0.075, 1.52, 0x548584);
    box(high, 117, tableY + 0.895, 209.8, 0.03, 0.17, 1.6, 0xede3c5);
    rectangle('high-park-ping-pong', 117, 209.8, 2.74, 1.52, tableY, tableY + 0.82);
  }

  for (const [x, z, paint] of [
    [91, 210.7, 0xcf728f],
    [141, 217.9, 0x5d949b],
  ]) {
    if (!floor(x, z, 6.5, 3.1, paint)) continue;
    const y = level(x, z);
    for (const u of [-2.4, 2.4]) {
      const b = new THREE.Vector3(x + u, y + 2.64, z);
      for (const d of [-1.25, 1.25])
        beam(high, new THREE.Vector3(x + u, y, z + d), b, 0.064, 0.055, 0x52616c, 6);
    }
    beam(
      high,
      new THREE.Vector3(x - 2.5, y + 2.64, z),
      new THREE.Vector3(x + 2.5, y + 2.64, z),
      0.064,
      0.064,
      0x52616c,
    );
    for (const u of [-0.42, 0.42])
      beam(
        high,
        new THREE.Vector3(x + u, y + 0.68, z),
        new THREE.Vector3(x + u, y + 2.59, z),
        0.018,
        0.018,
        0x707774,
        5,
      );
    box(high, x, y + 0.65, z, 1.16, 0.065, 0.33, 0xd2bd93);
    rectangle(`high-park-swing-${x}`, x, z, 1.16, 0.33, y + 0.615, y + 0.683);
  }

  const courtX = 205,
    courtZ = 221.05;
  if (floor(courtX, courtZ, 20.5, 9.4, 0x548c9f)) {
    const paint = 0xf3db9e;
    for (const dz of [-4.6, 4.6]) floor(courtX, courtZ + dz, 20.28, 0.082, paint, 0.035);
    for (const dx of [-10.1, 10.1]) floor(courtX + dx, courtZ, 0.082, 9.2, paint, 0.035);
    floor(courtX + 7.7, courtZ, 4.75, 3.55, 0xcc8291, 0.033);
    const x = courtX + 9.98,
      y = level(x, courtZ);
    const arc = new THREE.RingGeometry(3.54, 3.64, 28, 1, Math.PI / 2, Math.PI)
      .rotateX(-Math.PI / 2)
      .translate(x - 0.7, 0, courtZ);
    const points = arc.attributes.position;
    for (let i = 0; i < points.count; i++) points.setY(i, level(points.getX(i), points.getZ(i)) + 0.043);
    arc.computeVertexNormals();
    add(high, arc, paint);
    box(high, x, y + 1.61, courtZ, 0.12, 3.22, 0.12, 0x49535a);
    box(high, x - 0.34, y + 3.07, courtZ, 0.07, 0.86, 1.56, 0xf1dcc3);
    add(
      high,
      new THREE.TorusGeometry(0.24, 0.023, 5, 16).rotateX(Math.PI / 2).translate(x - 0.62, y + 2.78, courtZ),
      0xbc543a,
    );
    rectangle('high-park-basketball-post', x, courtZ, 0.15, 0.15, y, y + 3.22);
  }
  for (const [x, z] of [
    [57, 216.8],
    [97, 216.8],
    [122, 216.8],
    [151, 216.8],
    [188, 216.8],
    [218, 216.8],
    [238, 216.8],
  ]) {
    const y = level(x, z);
    if (y === null) continue;
    box(high, x, y + 1.59, z, 0.1, 3.18, 0.1, 0x495860);
    box(high, x, y + 3.2, z, 0.18, 0.1, 0.18, 0xeec477);
    rectangle(`high-park-light-post-${x}`, x, z, 0.14, 0.14, y, y + 3.25);
  }
  for (const [a, b] of [
    [57, 97],
    [97, 122],
    [122, 151],
    [151, 188],
    [188, 218],
    [218, 238],
  ]) {
    const za = 216.8,
      ya = level(a, za),
      yb = level(b, za);
    if (ya === null || yb === null) continue;
    const cable = (t) =>
      new THREE.Vector3(a + (b - a) * t, ya + (yb - ya) * t + 3.16 - 0.72 * Math.sin(Math.PI * t), za);
    for (let i = 0; i < 12; i++) {
      const bulb = cable((i + 0.5) / 12);
      beam(high, cable(i / 12), cable((i + 1) / 12), 0.015, 0.015, 0x495860, 4);
      box(high, bulb.x, bulb.y - 0.042, bulb.z, 0.065, 0.095, 0.065, 0xf4cd87);
    }
  }
  const signY = level(62, 211);
  if (signY !== null) {
    box(high, 62, signY + 1.04, 211, 5.5, 1.85, 0.16, 0x253948);
    sign(
      'High Park rooftop entry',
      'HIGH PARK\nLEVEL 6 · BELTLINE',
      62,
      signY + 1.04,
      211.1,
      5.3,
      1.72,
      0,
      '#f7d898',
      '#263f51',
    );
  }
  const x = 69,
    y = level(x, deckZ);
  if (y === null) return null;
  const [lon, lat] = unproject(x, deckZ);
  labels.push({ name: high, x: 151, z: deckZ, height: 20 });
  return {
    place: {
      name: high,
      sub: 'Rooftop park at 340 10 Avenue SW',
      lon,
      lat,
      bearing: Math.PI / 2,
      elevation: y + 0.09,
      onFoot: true,
    },
    supportAt(x, z, hint) {
      if (!Number.isFinite(hint) || x < 54 || x > 242 || z < 199 || z > 249) return null;
      const roof = level(x, z);
      return roof !== null && hint >= roof - 0.45 ? roof + 0.015 : null;
    },
  };
}
