import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const C = { yellow: 0xd4ad38, steel: 0x6f7975, dark: 0x28342f, black: 0x17221e, pale: 0xc6cdc0 };
function painted(geometry, color) {
  geometry.deleteAttribute('uv');
  const values = new Float32Array(geometry.attributes.position.count * 3),
    tint = new THREE.Color(color);
  for (let i = 0; i < geometry.attributes.position.count; i++) tint.toArray(values, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
  return geometry;
}
function combine(parts) {
  const output = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  output.computeBoundingBox();
  output.computeBoundingSphere();
  return output;
}
function body(parts, geometry, color, position, rotation) {
  if (rotation)
    geometry
      .rotateX(rotation[0] || 0)
      .rotateY(rotation[1] || 0)
      .rotateZ(rotation[2] || 0);
  if (position) geometry.translate(...position);
  parts.push(painted(geometry, color));
}
function rod(parts, a, b, radius, color, sides = 5) {
  const va = new THREE.Vector3(...a),
    vb = new THREE.Vector3(...b),
    direction = vb.clone().sub(va),
    geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), sides);
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
  );
  body(parts, geometry, color, va.add(vb).multiplyScalar(0.5).toArray());
}

/** Code-native interpretations: inventory does not contain manufacturer meshes. */
export function createStreetDetailPrototypes() {
  const output = {};
  for (const fine of [false, true]) {
    const sides = fine ? 12 : 6,
      parts = [],
      key = fine ? 'fine' : 'coarse';
    body(parts, new THREE.CylinderGeometry(0.105, 0.12, 0.59, sides), C.yellow, [0, 0.36, 0]);
    body(parts, new THREE.CylinderGeometry(0.19, 0.19, 0.055, sides), C.steel, [0, 0.04, 0]);
    body(parts, new THREE.CylinderGeometry(0.16, 0.16, 0.06, sides), C.yellow, [0, 0.68, 0]);
    body(
      parts,
      new THREE.SphereGeometry(0.16, sides, fine ? 6 : 3, 0, Math.PI * 2, 0, Math.PI / 2),
      C.yellow,
      [0, 0.72, 0],
    );
    body(parts, new THREE.CylinderGeometry(0.037, 0.037, 0.06, 6), C.steel, [0, 0.9, 0]);
    for (const sign of [-1, 1]) {
      body(
        parts,
        new THREE.CylinderGeometry(0.075, 0.075, 0.23, sides),
        C.yellow,
        [sign * 0.13, 0.55, 0],
        [0, 0, Math.PI / 2],
      );
      body(
        parts,
        new THREE.CylinderGeometry(0.085, 0.085, 0.035, sides),
        C.yellow,
        [sign * 0.25, 0.55, 0],
        [0, 0, Math.PI / 2],
      );
      body(
        parts,
        new THREE.CylinderGeometry(0.03, 0.03, 0.025, 6),
        C.steel,
        [sign * 0.28, 0.55, 0],
        [0, 0, Math.PI / 2],
      );
    }
    body(
      parts,
      new THREE.CylinderGeometry(0.093, 0.093, 0.23, sides),
      C.yellow,
      [0, 0.49, 0.15],
      [Math.PI / 2, 0, 0],
    );
    body(
      parts,
      new THREE.CylinderGeometry(0.105, 0.105, 0.04, sides),
      C.yellow,
      [0, 0.49, 0.28],
      [Math.PI / 2, 0, 0],
    );
    if (fine) {
      body(
        parts,
        new THREE.CylinderGeometry(0.035, 0.035, 0.03, 6),
        C.steel,
        [0, 0.49, 0.315],
        [Math.PI / 2, 0, 0],
      );
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        body(parts, new THREE.CylinderGeometry(0.015, 0.015, 0.025, 6), C.steel, [
          Math.sin(a) * 0.15,
          0.08,
          Math.cos(a) * 0.15,
        ]);
      }
      for (const sign of [-1, 1]) {
        const points = [
          [sign * 0.25, 0.54, 0.045],
          [sign * 0.28, 0.4, 0.08],
          [sign * 0.18, 0.32, 0.1],
          [sign * 0.1, 0.4, 0.11],
        ];
        for (let i = 1; i < points.length; i++) rod(parts, points[i - 1], points[i], 0.009, C.steel, 4);
      }
    }
    output[`hydrant-${key}`] = combine(parts);

    const bollard = [];
    // Normalized radius/height; actual source material affects tint. The source
    // has no diameter, section profile or finish, so none is claimed measured.
    body(bollard, new THREE.CylinderGeometry(0.88, 1, 0.94, sides), 0xb0b7ad, [0, 0.47, 0]);
    body(bollard, new THREE.CylinderGeometry(0.89, 0.89, 0.06, sides), C.pale, [0, 0.97, 0]);
    if (fine) {
      body(bollard, new THREE.CylinderGeometry(1.05, 1.05, 0.055, sides), C.dark, [0, 0.035, 0]);
      body(bollard, new THREE.CylinderGeometry(0.91, 0.91, 0.07, sides), C.pale, [0, 0.78, 0]);
    }
    output[`bollard-${key}`] = combine(bollard);

    const roundPost = [];
    body(roundPost, new THREE.CylinderGeometry(1, 1, 0.91, sides), C.black, [0, 0.455, 0]);
    body(
      roundPost,
      new THREE.SphereGeometry(1, sides, fine ? 4 : 2, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.09, 1),
      C.black,
      [0, 0.91, 0],
    );
    output[`bollard-round-${key}`] = combine(roundPost);

    const waste = [];
    body(waste, new THREE.CylinderGeometry(0.28, 0.27, 0.78, sides), C.black, [0, 0.43, 0]);
    body(waste, new THREE.CylinderGeometry(0.33, 0.33, 0.08, sides), C.dark, [0, 0.08, 0]);
    const lathe = new THREE.LatheGeometry(
      [
        [0.29, 0.78],
        [0.34, 0.81],
        [0.35, 0.87],
        [0.32, 0.96],
        [0.2, 1.02],
        [0.19, 0.98],
      ].map((p) => new THREE.Vector2(...p)),
      sides,
    );
    body(waste, lathe, C.dark);
    if (fine) {
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        body(waste, new THREE.BoxGeometry(0.055, 0.66, 0.025).rotateY(-a), 0x8d998f, [
          Math.sin(a) * 0.292,
          0.45,
          Math.cos(a) * 0.292,
        ]);
      }
      body(waste, new THREE.BoxGeometry(0.17, 0.15, 0.026), C.pale, [0, 0.61, 0.3]);
      for (const x of [-0.15, 0.15])
        body(waste, new THREE.BoxGeometry(0.035, 0.11, 0.05), C.steel, [x, 0.23, 0.3]);
    }
    output[`waste-${key}`] = combine(waste);

    const box = [];
    body(box, new THREE.BoxGeometry(0.66, 0.76, 0.65), 0x88978b, [0, 0.43, 0]);
    body(box, new THREE.BoxGeometry(0.72, 0.07, 0.71), C.dark, [0, 0.065, 0]);
    body(box, new THREE.BoxGeometry(0.72, 0.08, 0.78).rotateX(-0.16), C.dark, [0, 0.91, 0.01]);
    body(box, new THREE.BoxGeometry(0.45, 0.17, 0.025), C.black, [0, 0.76, 0.338]);
    body(box, new THREE.BoxGeometry(0.46, 0.03, 0.075), C.steel, [0, 0.68, 0.36]);
    if (fine) {
      body(box, new THREE.BoxGeometry(0.21, 0.16, 0.028), C.pale, [0, 0.46, 0.34]);
      for (const x of [-0.285, 0.285]) {
        body(box, new THREE.BoxGeometry(0.028, 0.7, 0.022), C.steel, [x, 0.43, 0.34]);
        body(
          box,
          new THREE.CylinderGeometry(0.018, 0.018, 0.055, 6),
          C.steel,
          [x, 0.89, -0.25],
          [Math.PI / 2, 0, 0],
        );
      }
      body(box, new THREE.BoxGeometry(0.09, 0.035, 0.025), C.black, [0.22, 0.66, 0.39]);
      body(
        box,
        new THREE.CylinderGeometry(0.022, 0.022, 0.035, 6),
        C.steel,
        [0.22, 0.66, 0.41],
        [Math.PI / 2, 0, 0],
      );
    }
    output[`waste-box-${key}`] = combine(box);

    const fountain = [];
    body(fountain, new THREE.CylinderGeometry(0.13, 0.17, 0.81, sides), C.dark, [0, 0.405, 0]);
    body(fountain, new THREE.CylinderGeometry(0.22, 0.22, 0.05, sides), C.steel, [0, 0.83, 0]);
    body(
      fountain,
      new THREE.LatheGeometry(
        [
          [0.02, 0.84],
          [0.13, 0.85],
          [0.2, 0.9],
          [0.215, 0.94],
          [0.19, 0.95],
          [0.13, 0.89],
          [0.02, 0.87],
        ].map((p) => new THREE.Vector2(...p)),
        sides,
      ),
      C.steel,
    );
    body(fountain, new THREE.CylinderGeometry(0.018, 0.018, 0.065, fine ? 8 : 5), C.pale, [0.1, 0.94, 0]);
    if (fine) {
      body(
        fountain,
        new THREE.CylinderGeometry(0.035, 0.035, 0.035, 8),
        C.steel,
        [0, 0.66, 0.14],
        [Math.PI / 2, 0, 0],
      );
      body(fountain, new THREE.CylinderGeometry(0.21, 0.21, 0.035, sides), C.dark, [0, 0.02, 0]);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        body(fountain, new THREE.CylinderGeometry(0.012, 0.012, 0.02, 5), C.steel, [
          Math.sin(a) * 0.17,
          0.04,
          Math.cos(a) * 0.17,
        ]);
      }
      body(fountain, new THREE.CylinderGeometry(0.025, 0.025, 0.005, 8), C.black, [0, 0.866, 0]);
    }
    output[`fountain-${key}`] = combine(fountain);
  }
  return output;
}
