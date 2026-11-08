import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildSteerableWheelGeo,
  buildCarSidePatch,
  createLoftedCarMaterial,
} from '../js/cars.js';

// Original lofted interpretation of the second-generation R8 Coupé.
// Audi's published dimensions: 4.429m long, 1.940m wide, 1.236m high,
// 2.650m wheelbase. Panel curvature and trim details are authored estimates.
export const R8_SPEC = {
  ...BODY_SPECS.sedan,
  name: 'calgary-r8-coupe',
  zFront: 2.318,
  zRear: -2.111,
  wheelZ: 1.325,
  wheelX: 0.82,
  wheelRadius: 0.335,
  archGap: 0.035,
  archFlare: 0.018,
  tuck: 0.04,
  halfWidth: [
    [2.318, 0.89],
    [1.325, 0.954],
    [0, 0.944],
    [-1.325, 0.97],
    [-2.111, 0.91],
  ],
  sill: [
    [2.318, 0.2],
    [1.325, 0.17],
    [-1.325, 0.17],
    [-2.111, 0.23],
  ],
  shoulder: [
    [2.318, 0.49],
    [1.6, 0.66],
    [1.325, 0.69],
    [0, 0.71],
    [-1.325, 0.73],
    [-2.111, 0.7],
  ],
  edge: [
    [2.2, 0.61],
    [1.6, 0.71],
    [1.1, 0.77],
    [0.7, 0.8],
    [-0.7, 0.83],
    [-1.325, 0.84],
    [-2, 0.82],
  ],
  crown: [
    [2.22, 0.024],
    [0.8, 0.028],
    [0.55, 0.004],
    [-1.05, 0.004],
    [-1.8, 0.028],
    [-2.111, 0.014],
  ],
  tumble: [
    [2.318, 0.1],
    [0.9, 0.1],
    [-1.325, 0.08],
    [-2.111, 0.1],
  ],
  nose: {
    halfWidth: [0.24, 0.72, 3.4],
    edge: [0.12, 0.59, 3],
    crown: [0.12, 0.008, 2],
    sill: [0.14, 0.23, 2],
    shoulder: [0.18, 0.45, 3],
  },
  tail: {
    halfWidth: [0.18, 0.8, 3.4],
    edge: [0.07, 0.79, 3],
    crown: [0.07, 0.004, 2],
    sill: [0.12, 0.25, 2],
    shoulder: [0.16, 0.66, 3],
  },
  noseRake: {
    length: 0.4,
    y: [
      [0.2, 0.03],
      [0.36, 0],
      [0.52, 0],
      [0.67, 0.05],
      [0.78, 0.12],
    ],
    plan: 0.055,
  },
  tailRake: {
    length: 0.24,
    y: [
      [0.2, 0.04],
      [0.38, 0],
      [0.62, 0],
      [0.82, 0.015],
    ],
    plan: 0.035,
  },
  cabin: {
    cowl: 0.67,
    roofFront: -0.02,
    roofRear: -0.84,
    deck: -1.45,
    roofY: [
      [-0.02, 1.19],
      [-0.4, 1.205],
      [-0.84, 1.17],
    ],
    rail: [0.65, 0.62],
    inset: 0.026,
    bulge: 0.012,
    roofEdge: 0.035,
    roofCrown: 0.031,
    roofRound: 4,
    pillars: [],
    glassEnd: -0.9,
  },
  doors: [0.63, -0.87],
  handles: [-0.65],
  headlight: [0.64, 0.635, 0.215, 0.028],
  taillight: [0.65, 0.734, 0.23, 0.025],
  grille: [0.47, 0.48, 0.12],
  intake: [0.29, 0.65, 0.065],
  plates: [0.34, 0.43],
  bumperLine: [0.69, 0.57],
  bumpers: [
    [0.24, 0.026],
    [0.25, 0.03],
  ],
  chrome: false,
  cladding: 0,
  rails: false,
  rearWiper: false,
  lamps: [0.635, 0.734],
  lampX: [0.64, 0.65],
};

export function createPlayerCar() {
  const group = new THREE.Group();
  group.name = 'Blue Audi R8 Coupé';
  const material = createLoftedCarMaterial(R8_SPEC, 0x176fc4);
  const body = new THREE.Mesh(buildCarGeometry(R8_SPEC, false), material);
  body.name = 'R8 low mid-engine coupé body';
  body.castShadow = body.receiveShadow = true;
  group.add(body);
  const carbon = new THREE.MeshStandardNodeMaterial({ color: 0x111a24, roughness: 0.42, metalness: 0.3 });
  const chrome = new THREE.MeshStandardNodeMaterial({ color: 0xb8c6d5, roughness: 0.22, metalness: 0.85 });
  const dark = [];
  for (const side of [-1, 1]) {
    dark.push(buildCarSidePatch(R8_SPEC, side, -1.14, -0.88, 0.44, 0.86, 0.012, 5, 4));
    dark.push(buildCarSidePatch(R8_SPEC, side, -0.98, -0.55, 0.29, 0.49, 0.016, 6, 3));
  }
  const engine = new THREE.BoxGeometry(1.12, 0.022, 0.46);
  engine.translate(0, 0.867, -1.3);
  dark.push(engine);
  const splitter = new THREE.BoxGeometry(1.7, 0.045, 0.2);
  splitter.translate(0, 0.205, 2.14);
  dark.push(splitter);
  const diffuser = new THREE.BoxGeometry(1.5, 0.11, 0.16);
  diffuser.translate(0, 0.26, -2.055);
  dark.push(diffuser);
  const carbonMesh = new THREE.Mesh(
    mergeGeometries(dark.map((g) => (g.index ? g.toNonIndexed() : g))),
    carbon,
  );
  dark.forEach((g) => g.dispose());
  carbonMesh.name = 'R8 sideblades, engine cover and aero trim';
  group.add(carbonMesh);
  const metal = [];
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.TorusGeometry(0.043, 0.007, 6, 16);
    ring.translate((i - 1.5) * 0.064, 0.54, 2.285);
    metal.push(ring);
  }
  for (const side of [-1, 1]) {
    const exhaust = new THREE.TorusGeometry(0.065, 0.015, 6, 16);
    exhaust.scale(1.35, 0.8, 1);
    exhaust.translate(side * 0.66, 0.27, -2.125);
    metal.push(exhaust);
  }
  const trim = new THREE.Mesh(mergeGeometries(metal.map((g) => g.toNonIndexed())), chrome);
  metal.forEach((g) => g.dispose());
  group.add(trim);
  const wheels = [];
  for (const side of [-1, 1]) {
    const geometry = buildSteerableWheelGeo(R8_SPEC, side);
    for (const axle of [-1, 1]) {
      const pivot = new THREE.Group(),
        wheel = new THREE.Mesh(geometry, material);
      pivot.position.set(side * R8_SPEC.wheelX, R8_SPEC.wheelRadius, axle * R8_SPEC.wheelZ);
      wheel.castShadow = true;
      pivot.add(wheel);
      group.add(pivot);
      wheels.push({ pivot, wheel, front: axle > 0 });
    }
  }
  let spin = 0,
    lastSpeed = 0;
  return {
    group,
    body,
    wheels,
    spec: R8_SPEC,
    update(dt, state) {
      spin = (spin + (state.speed * Math.max(0, dt)) / R8_SPEC.wheelRadius) % (Math.PI * 2);
      for (const { pivot, wheel, front } of wheels) {
        pivot.rotation.y = front ? (state.steerAngle ?? 0) : 0;
        wheel.rotation.x = spin;
      }
      const acceleration = dt > 0 ? (state.speed - lastSpeed) / dt : 0;
      lastSpeed = state.speed;
      material.userData.carState.value.set(
        acceleration < -0.6 || state.braking ? 1 : 0,
        0,
        0,
        state.speed < -0.1 ? 1 : 0,
      );
      body.rotation.z = THREE.MathUtils.damp(
        body.rotation.z,
        -Math.max(-0.022, Math.min(0.022, state.yawRate * state.speed * 0.0018)),
        12,
        dt,
      );
    },
  };
}
