import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Original game meshes. No downloaded animal/fixture models or photo textures.
// Coordinates are metres; every animal faces +z and rests on y=0.
const UP = new THREE.Vector3(0, 1, 0);
function modeller() {
  const parts = [];
  const add = (geometry, tint = 0xffffff) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes))
      if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
    const color = new THREE.Color(tint),
      data = new Float32Array(g.attributes.position.count * 3);
    for (let k = 0; k < data.length; k += 3) {
      data[k] = color.r;
      data[k + 1] = color.g;
      data[k + 2] = color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(data, 3));
    parts.push(g);
  };
  return {
    add,
    ellipsoid(x, y, z, rx, ry, rz, color, segments = 12, rings = 8, rotation = 0) {
      const g = new THREE.SphereGeometry(1, segments, rings);
      g.scale(rx, ry, rz);
      g.rotateX(rotation);
      g.translate(x, y, z);
      add(g, color);
    },
    box(x, y, z, w, h, d, color, rotation = 0) {
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateX(rotation);
      g.translate(x, y, z);
      add(g, color);
    },
    beam(a, b, r, color, sides = 6) {
      const x = new THREE.Vector3(...a),
        v = new THREE.Vector3(...b).sub(x),
        g = new THREE.CylinderGeometry(r, r, v.length(), sides);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, v.clone().normalize()));
      g.translate(
        ...x
          .add(new THREE.Vector3(...b))
          .multiplyScalar(0.5)
          .toArray(),
      );
      add(g, color);
    },
    triangle(a, b, c, color) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
      g.computeVertexNormals();
      add(g, color);
    },
    finish(name) {
      const g = mergeGeometries(parts, false);
      parts.forEach((p) => p.dispose());
      if (!g) throw new Error(`Unable to merge park-life ${name}`);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      g.name = name;
      return g;
    },
  };
}
const eye = (m, x, y, z, r = 0.009) => {
  m.ellipsoid(x, y, z, r, r, r, 0x101719, 8, 6);
  m.ellipsoid(x * 0.99, y + r * 0.25, z + r * 0.8, r * 0.25, r * 0.25, r * 0.25, 0xeeeecc, 6, 4);
};

function pixelModels(out) {
  const tan = 0xc9894e,
    honey = 0xe5b575,
    sable = 0x333139,
    muzzle = 0x4a3432;
  const body = modeller();
  body.ellipsoid(0, 0.49, -0.048, 0.15, 0.142, 0.41, tan);
  body.ellipsoid(0, 0.56, -0.073, 0.146, 0.104, 0.378, sable);
  body.ellipsoid(0, 0.5, 0.229, 0.142, 0.164, 0.18, honey, 12, 8, -0.2);
  body.ellipsoid(0, 0.576, 0.244, 0.116, 0.19, 0.128, tan, 12, 8, 0.42);
  body.ellipsoid(0, 0.629, 0.29, 0.115, 0.027, 0.118, 0x469eaa, 10, 6, -0.35);
  body.ellipsoid(0, 0.597, 0.391, 0.027, 0.035, 0.012, 0xffca72, 8, 6);
  out.pixel = body.finish('Pixel / black saddle and teal collar');

  const head = modeller();
  head.ellipsoid(0, 0.063, 0.072, 0.124, 0.126, 0.132, tan);
  head.ellipsoid(0, 0.032, 0.177, 0.087, 0.06, 0.141, muzzle, 12, 8, 0.13);
  head.ellipsoid(0, 0.084, 0.268, 0.048, 0.032, 0.047, 0x26252b, 10, 6);
  head.ellipsoid(0, -0.015, 0.205, 0.041, 0.024, 0.079, 0xd27878, 8, 6, 0.22);
  for (const side of [-1, 1]) {
    const base = [side * 0.045, 0.142, 0.096],
      edge = [side * 0.131, 0.132, 0.087],
      tip = [side * 0.103, 0.327, 0.049],
      back = [side * 0.088, 0.164, 0.013];
    head.triangle(base, edge, tip, sable);
    head.triangle(edge, back, tip, tan);
    head.triangle(back, base, tip, tan);
    head.triangle(
      [side * 0.061, 0.157, 0.095],
      [side * 0.115, 0.148, 0.09],
      [side * 0.098, 0.28, 0.064],
      0xd3917a,
    );
    head.ellipsoid(side * 0.085, 0.117, 0.145, 0.035, 0.023, 0.028, honey, 8, 6);
    eye(head, side * 0.094, 0.093, 0.154, 0.019);
  }
  out.pixelHead = head.finish('Pixel / pointed ears and dark muzzle');

  const tail = modeller();
  tail.ellipsoid(0, 0.061, -0.135, 0.054, 0.052, 0.165, sable, 10, 7, 0.48);
  tail.ellipsoid(0, 0.195, -0.292, 0.043, 0.047, 0.127, tan, 10, 7, 0.78);
  out.pixelTail = tail.finish('Pixel / feathered tail');

  const foreleg = modeller(),
    hindleg = modeller();
  foreleg.beam([0, 0, 0], [0, -0.37, 0.01], 0.035, tan, 8);
  foreleg.ellipsoid(0, -0.12, 0, 0.049, 0.157, 0.05, tan, 9, 6);
  foreleg.ellipsoid(0, -0.389, 0.035, 0.041, 0.038, 0.065, honey, 9, 6);
  hindleg.ellipsoid(0, -0.073, 0.012, 0.058, 0.136, 0.086, tan, 9, 6, -0.38);
  hindleg.beam([0, -0.14, 0.058], [0, -0.258, -0.054], 0.035, tan, 7);
  hindleg.beam([0, -0.258, -0.054], [0, -0.359, -0.027], 0.027, tan, 7);
  hindleg.ellipsoid(0, -0.377, -0.008, 0.043, 0.039, 0.063, honey, 9, 6);
  out.pixelForeleg = foreleg.finish('Pixel / foreleg');
  out.pixelHindleg = hindleg.finish('Pixel / hindleg');
}

export function createParkLifePrototypes() {
  const out = {};
  {
    const m = modeller(),
      fur = 0x91836d,
      light = 0xb8ae97;
    m.ellipsoid(0, 0.28, -0.025, 0.145, 0.205, 0.285, fur, 16, 10);
    m.ellipsoid(0, 0.43, 0.205, 0.112, 0.135, 0.15, fur, 14, 10, -0.16);
    m.ellipsoid(0, 0.407, 0.315, 0.081, 0.075, 0.073, light);
    m.ellipsoid(0, 0.415, 0.381, 0.026, 0.018, 0.022, 0x6a5350, 8, 6);
    m.ellipsoid(0, 0.28, -0.298, 0.065, 0.064, 0.063, 0xebe4cb, 10, 6);
    for (const s of [-1, 1]) {
      m.ellipsoid(s * 0.125, 0.2, -0.115, 0.092, 0.143, 0.16, fur);
      m.ellipsoid(s * 0.105, 0.047, 0.015, 0.055, 0.043, 0.155, light, 12, 6);
      m.ellipsoid(s * 0.068, 0.128, 0.223, 0.029, 0.105, 0.038, fur, 10, 6, -0.08);
      m.ellipsoid(s * 0.068, 0.039, 0.271, 0.033, 0.031, 0.079, light, 10, 6);
      eye(m, s * 0.102, 0.476, 0.265, 0.013);
      for (let k = 0; k < 3; k++)
        m.beam(
          [s * 0.034, 0.416, 0.367],
          [s * (0.12 + k * 0.01), 0.412 + (k - 1) * 0.015, 0.4 - (k - 1) * 0.018],
          0.0011,
          0xafa99b,
          4,
        );
    }
    out.rabbit = m.finish('Long-eared prairie hare');
    const ears = modeller();
    ears.ellipsoid(0, 0.155, 0, 0.039, 0.176, 0.024, fur, 12, 8, -0.12);
    ears.ellipsoid(0, 0.17, 0.021, 0.021, 0.132, 0.006, 0xb89588, 10, 6, -0.12);
    ears.ellipsoid(0, 0.302, -0.013, 0.03, 0.035, 0.019, 0x4a4943, 10, 6);
    out.rabbitEars = ears.finish('Prairie hare articulated ear');
  }
  {
    const m = modeller(),
      fur = 0x8d6450,
      light = 0xb7a189;
    m.ellipsoid(0, 0.2, -0.018, 0.095, 0.149, 0.177, fur, 14, 9, -0.2);
    m.ellipsoid(0, 0.336, 0.155, 0.075, 0.083, 0.105, fur, 12, 8, -0.1);
    m.ellipsoid(0, 0.314, 0.229, 0.047, 0.042, 0.061, light, 10, 6);
    m.ellipsoid(0, 0.327, 0.283, 0.017, 0.014, 0.016, 0x292b26, 8, 6);
    for (const s of [-1, 1]) {
      m.ellipsoid(s * 0.056, 0.409, 0.147, 0.026, 0.044, 0.024, fur, 10, 6);
      m.ellipsoid(s * 0.076, 0.093, -0.068, 0.051, 0.072, 0.09, fur, 10, 6);
      m.ellipsoid(s * 0.075, 0.025, -0.006, 0.03, 0.025, 0.09, 0x64523f, 10, 6);
      m.ellipsoid(s * 0.051, 0.09, 0.14, 0.023, 0.071, 0.027, fur, 10, 6, -0.2);
      m.ellipsoid(s * 0.05, 0.027, 0.188, 0.025, 0.025, 0.052, 0x64523f, 10, 6);
      eye(m, s * 0.069, 0.357, 0.208, 0.01);
    }
    out.squirrel = m.finish('Red-brown park squirrel');
    const tail = modeller();
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0.08, -0.2),
      new THREE.Vector3(0, 0.32, -0.24),
      new THREE.Vector3(0, 0.46, -0.09),
      new THREE.Vector3(0, 0.44, 0.035),
    ]);
    tail.add(new THREE.TubeGeometry(curve, 12, 0.072, 7, false), fur);
    for (let k = 0; k < 9; k++) {
      const p = curve.getPoint(k / 9);
      tail.ellipsoid(p.x, p.y, p.z, 0.086, 0.09, 0.088, k % 3 === 0 ? light : fur, 10, 6);
    }
    out.squirrelTail = tail.finish('Squirrel bushy curled tail');
  }
  {
    const m = modeller(),
      brown = 0x807766,
      feather = 0x6b655b;
    m.ellipsoid(0, 0.39, -0.025, 0.234, 0.257, 0.385, brown, 16, 10);
    m.ellipsoid(0, 0.385, 0.224, 0.196, 0.23, 0.2, 0xd0c8b1, 14, 9);
    m.ellipsoid(0, 0.31, -0.29, 0.15, 0.14, 0.2, 0xddd8c9, 12, 7);
    for (const s of [-1, 1]) {
      m.ellipsoid(s * 0.194, 0.441, -0.042, 0.064, 0.18, 0.28, feather, 12, 8, -0.24);
      for (let k = 0; k < 6; k++) {
        m.ellipsoid(
          s * (0.226 - k * 0.004),
          0.51 - k * 0.038,
          -0.12 - k * 0.019,
          0.025,
          0.013,
          0.168,
          k % 2 ? 0xa19a88 : 0x4f514a,
          10,
          5,
          -0.24,
        );
      }
    }
    m.triangle([-0.14, 0.4, -0.3], [0.14, 0.4, -0.3], [0, 0.36, -0.57], 0x333c38);
    m.triangle([-0.1, 0.415, -0.34], [0.1, 0.415, -0.34], [0, 0.38, -0.56], 0xcecbbb);
    out.goose = m.finish('Canada goose body and scalloped wings');
    const neck = modeller();
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0.22, -0.012),
      new THREE.Vector3(0, 0.47, 0.025),
      new THREE.Vector3(0, 0.59, 0.104),
    ]);
    neck.add(new THREE.TubeGeometry(curve, 12, 0.047, 9, false), 0x20292a);
    neck.ellipsoid(0, 0.59, 0.115, 0.077, 0.087, 0.115, 0x20292a, 14, 8);
    neck.ellipsoid(0, 0.567, 0.218, 0.055, 0.031, 0.09, 0x262d29, 10, 6);
    for (const s of [-1, 1]) {
      neck.ellipsoid(s * 0.064, 0.552, 0.123, 0.014, 0.036, 0.077, 0xeeeade, 12, 7, -0.25);
      eye(neck, s * 0.07, 0.608, 0.156, 0.008);
    }
    neck.ellipsoid(0, 0.526, 0.12, 0.045, 0.018, 0.044, 0xeeeade, 10, 5);
    out.gooseNeck = neck.finish('Canada goose black neck and white chinstrap');
    const leg = modeller();
    leg.beam([0, 0, 0], [0, -0.205, 0.005], 0.017, 0x303b37, 7);
    for (const dx of [-0.052, 0, 0.052])
      leg.triangle([0, -0.218, 0.012], [dx - 0.018, -0.218, 0.13], [dx + 0.018, -0.218, 0.13], 0x313c37);
    leg.ellipsoid(0, -0.213, 0.043, 0.045, 0.014, 0.065, 0x313c37, 10, 5);
    out.gooseLeg = leg.finish('Goose leg and webbed foot');
  }
  {
    const m = modeller(),
      fur = 0x66503e,
      light = 0x87705a;
    m.ellipsoid(0, 0.264, -0.045, 0.226, 0.256, 0.395, fur, 16, 10);
    m.ellipsoid(0, 0.294, 0.294, 0.177, 0.174, 0.193, fur, 14, 9);
    m.ellipsoid(0, 0.239, 0.433, 0.142, 0.09, 0.111, light, 12, 8);
    m.ellipsoid(0, 0.275, 0.516, 0.062, 0.041, 0.038, 0x282c27, 10, 7);
    for (const s of [-1, 1]) {
      m.ellipsoid(s * 0.145, 0.407, 0.254, 0.044, 0.043, 0.038, fur, 10, 6);
      m.ellipsoid(s * 0.145, 0.413, 0.27, 0.025, 0.025, 0.014, 0x9e8774, 8, 5);
      eye(m, s * 0.142, 0.355, 0.407, 0.012);
      m.ellipsoid(s * 0.154, 0.077, 0.267, 0.05, 0.055, 0.111, 0x4a4235, 10, 7);
      m.ellipsoid(s * 0.188, 0.039, -0.185, 0.062, 0.03, 0.128, 0x4a4235, 10, 7);
      m.box(s * 0.019, 0.177, 0.518, 0.03, 0.065, 0.012, 0xd6bc82, 0.15);
      for (let k = 0; k < 3; k++)
        m.beam(
          [s * 0.067, 0.247, 0.482],
          [s * 0.2, 0.24 + (k - 1) * 0.02, 0.53 - (k - 1) * 0.015],
          0.0016,
          0xb1a28b,
          4,
        );
    }
    out.beaver = m.finish('North American beaver with incisors and webbed hind feet');
    const tail = modeller();
    tail.ellipsoid(0, 0, -0.27, 0.151, 0.023, 0.285, 0x49463d, 16, 8, 0.03);
    for (let k = -3; k <= 3; k++) {
      const z = -0.27 + k * 0.055,
        width = 0.14 * Math.sqrt(Math.max(0, 1 - ((k * 0.055) / 0.28) ** 2));
      tail.beam([-width, 0.019, z - 0.025], [width, 0.019, z + 0.025], 0.002, 0x77705c, 4);
    }
    for (let k = -2; k <= 2; k++)
      tail.beam([k * 0.043, 0.019, -0.49], [k * 0.043, 0.019, -0.06], 0.002, 0x77705c, 4);
    out.beaverTail = tail.finish('Beaver flattened crosshatched paddle tail');
  }
  {
    const m = modeller(),
      coat = 0xa87d54,
      dark = 0x684737,
      pale = 0xe2c7a0;
    m.ellipsoid(0, 0.47, -0.03, 0.166, 0.149, 0.385, coat, 8, 5);
    m.ellipsoid(0, 0.52, 0.275, 0.135, 0.158, 0.17, pale, 8, 5);
    m.ellipsoid(0, 0.675, 0.356, 0.129, 0.123, 0.144, coat, 8, 5);
    m.ellipsoid(0, 0.626, 0.477, 0.102, 0.073, 0.115, pale, 8, 5);
    m.ellipsoid(0, 0.64, 0.553, 0.063, 0.047, 0.045, 0x302f2d, 8, 5);
    for (const side of [-1, 1]) {
      m.ellipsoid(side * 0.111, 0.662, 0.35, 0.05, 0.098, 0.061, dark, 6, 4, 0.22);
      eye(m, side * 0.077, 0.697, 0.445, 0.016);
      for (const z of [-0.257, 0.215]) {
        m.beam([side * 0.108, 0.447, z], [side * 0.112, 0.078, z - 0.035], 0.042, dark, 5);
        m.ellipsoid(side * 0.112, 0.057, z, 0.059, 0.055, 0.079, pale, 7, 5);
      }
    }
    m.ellipsoid(0, 0.545, 0.247, 0.145, 0.029, 0.143, 0x3c7986, 10, 5);
    out.dog = m.finish('East Village dog');
    const tail = modeller();
    tail.beam([0, 0, 0], [0, 0.12, -0.16], 0.036, coat, 5);
    tail.beam([0, 0.12, -0.16], [0, 0.25, -0.27], 0.024, dark, 5);
    out.dogTail = tail.finish('Dog tail');
  }
  pixelModels(out);
  {
    const m = modeller(),
      wood = 0x9e7950,
      metal = 0x343e3e;
    for (let k = 0; k < 6; k++)
      m.box(0, 0.455, -0.175 + k * 0.067, 1.8, 0.045, 0.057, k % 2 ? 0x96724b : wood);
    for (let k = 0; k < 4; k++)
      m.box(0, 0.593 + k * 0.089, -0.258 - k * 0.008, 1.8, 0.075, 0.037, k % 2 ? 0xa58459 : wood, -0.09);
    for (const x of [-0.68, 0.68]) {
      for (const z of [-0.21, 0.18]) m.beam([x, 0.045, z], [x, 0.45, z], 0.031, metal, 7);
      m.beam([x, 0.44, -0.29], [x, 0.94, -0.33], 0.029, metal, 7);
      m.beam([x, 0.4, -0.23], [x, 0.4, 0.25], 0.032, metal, 7);
      m.box(x, 0.021, 0, 0.17, 0.042, 0.54, 0x6f7268);
      for (const z of [-0.19, 0.19]) {
        m.ellipsoid(x, 0.048, z, 0.013, 0.007, 0.013, 0xa9aaa0, 8, 5);
      }
      const arm = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 0.44, -0.25),
        new THREE.Vector3(x, 0.69, -0.18),
        new THREE.Vector3(x, 0.7, 0.2),
        new THREE.Vector3(x, 0.45, 0.25),
      ]);
      m.add(new THREE.TubeGeometry(arm, 10, 0.021, 7, false), metal);
    }
    m.box(0, 0.826, -0.222, 0.19, 0.065, 0.009, 0x8d7b4e, -0.09);
    for (const x of [-0.077, 0.077]) m.ellipsoid(x, 0.826, -0.215, 0.004, 0.004, 0.002, 0xb3ad8b, 6, 4);
    out.bench = m.finish('Mapped City bench — timber slats and metal arms');
    const block = modeller();
    block.box(0, 0.205, 0, 2.05, 0.41, 0.59, 0xb3b2a6);
    block.box(0, 0.43, 0, 2.1, 0.055, 0.62, 0xd1cfc2);
    block.box(0, 0.015, 0, 1.94, 0.03, 0.52, 0x555b55);
    out.concreteBench = block.finish('St Patrick east plaza concrete block seat');
    const t = modeller();
    for (let k = 0; k < 7; k++)
      t.box(0, 0.765, -0.315 + k * 0.105, 1.83, 0.055, 0.093, k % 2 ? 0xa48051 : wood);
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++)
        t.box(0, 0.45, s * 0.63 + (k - 1) * 0.1, 1.83, 0.052, 0.088, k % 2 ? 0xa48051 : wood);
      for (const x of [-0.61, 0.61]) {
        t.beam([x, 0.04, s * 0.7], [x, 0.73, s * 0.21], 0.032, metal, 7);
        t.beam([x, 0.39, s * 0.77], [x, 0.39, 0], 0.032, metal, 7);
        t.ellipsoid(x, 0.797, s * 0.2, 0.012, 0.004, 0.012, 0x9eaa9f, 7, 4);
      }
    }
    for (const x of [-0.61, 0.61]) t.beam([x, 0.72, -0.36], [x, 0.72, 0.36], 0.03, metal, 7);
    t.beam([-0.61, 0.41, 0], [0.61, 0.41, 0], 0.027, metal, 7);
    // A tiny original maple-leaf plaque is a playful game detail, not an inventory field.
    const leaf = [
      [0, 0.12],
      [0.025, 0.07],
      [0.075, 0.085],
      [0.065, 0.028],
      [0.11, 0.005],
      [0.038, -0.015],
      [0.045, -0.065],
      [0.005, -0.033],
      [-0.005, -0.09],
      [-0.015, -0.033],
      [-0.055, -0.06],
      [-0.047, -0.01],
      [-0.1, 0.01],
      [-0.058, 0.035],
      [-0.065, 0.085],
      [-0.025, 0.069],
    ];
    const shape = new THREE.Shape(leaf.map((p) => new THREE.Vector2(p[0], p[1]))),
      g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0.68, 0.797, 0.17);
    t.add(g, 0x9f4132);
    out.table = t.finish('Mapped picnic table — timber and metal A-frame');
  }
  {
    const m = modeller(),
      sections = 24,
      sides = 8;
    // Open canoe shell with raised ends, a contrasting gunwale and real thwarts.
    for (let i = 0; i < sections; i++) {
      const a = i / sections,
        b = (i + 1) / sections;
      const point = (t, angle, inner = false) => {
        const z = (t - 0.5) * 4.3,
          w = Math.sin(t * Math.PI) ** 0.65 * 0.41;
        return [
          Math.sin(angle) * Math.max(0.001, w - (inner ? 0.035 : 0)),
          0.04 + Math.abs(t - 0.5) ** 2 * 0.7 + (1 - Math.cos(angle)) * 0.34 + (inner ? 0.025 : 0),
          z,
        ];
      };
      for (let j = 0; j < sides; j++) {
        const lo = -Math.PI / 2 + (j * Math.PI) / sides,
          hi = -Math.PI / 2 + ((j + 1) * Math.PI) / sides;
        const p = point(a, lo),
          q = point(b, lo),
          r = point(b, hi),
          s = point(a, hi);
        m.triangle(p, q, r, 0x9b3832);
        m.triangle(p, r, s, 0x9b3832);
      }
      for (const edge of [-Math.PI / 2, Math.PI / 2])
        m.beam(point(a, edge), point(b, edge), 0.023, 0xbda275, 7);
    }
    for (const z of [-0.9, 0.8]) m.box(0, 0.36, z, 0.65, 0.035, 0.16, 0xac8c5c);
    m.beam([-0.25, 0.43, -1.4], [0.17, 0.43, 1.45], 0.018, 0xb79b6b, 7);
    m.ellipsoid(0.18, 0.43, 1.52, 0.085, 0.018, 0.24, 0xb79b6b, 10, 5);
    out.canoe = m.finish('Optional original red canoe');
    const wake = modeller();
    for (const s of [-1, 1])
      for (let i = 0; i < 12; i++) {
        const t = i / 12,
          a = [s * (0.2 + t * 0.5), 0, -0.35 - t * 1.3],
          b = [s * (0.2 + ((i + 1) / 12) * 0.5), 0, -0.35 - ((i + 1) / 12) * 1.3];
        wake.beam(a, b, 0.009, 0xaac8c3, 4);
      }
    out.wake = wake.finish('Subtle swimming wake');
  }
  return out;
}
