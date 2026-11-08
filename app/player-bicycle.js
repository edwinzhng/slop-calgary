import * as THREE from 'three/webgpu';
import { createCelActorMaterial } from './materials.js';
import { painted, combine, ellipsoid, box, tube, travelLamp } from './travel-geometry.js';

export const BICYCLE = Object.freeze({
  wheelRadius: 0.35,
  rearZ: -0.72,
  frontZ: 0.76,
  bracket: [0, 0.385, -0.065],
  crankRadius: 0.17,
  pedalHalf: 0.17,
  seat: [0, 0.985, -0.27],
  grips: [
    [0.285, 1.115, 0.56],
    [-0.285, 1.115, 0.56],
  ],
});

const clamp = THREE.MathUtils.clamp;
const ease = (dt, seconds) => 1 - Math.exp(-dt / seconds);
const palette = {
  hat: 0xffbd50,
  cream: 0xffdfaa,
  shoe: 0x418783,
  metal: 0xb3d2c6,
  bike: 0x44bda1,
  rubber: 0x303948,
};

function wheelGeometry() {
  const parts = [
    painted(
      new THREE.TorusGeometry(BICYCLE.wheelRadius - 0.031, 0.031, 7, 32).rotateY(Math.PI / 2),
      palette.rubber,
    ),
    painted(
      new THREE.TorusGeometry(BICYCLE.wheelRadius - 0.053, 0.018, 6, 32).rotateY(Math.PI / 2),
      palette.cream,
    ),
    tube([-0.055, 0, 0], [0.055, 0, 0], 0.033, palette.shoe, 8),
  ];
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    parts.push(
      tube(
        [i % 2 ? 0.025 : -0.025, 0, 0],
        [0, Math.cos(angle) * 0.299, Math.sin(angle) * 0.299],
        0.004,
        palette.metal,
        4,
      ),
    );
  }
  for (const side of [-1, 1]) parts.push(box(0, side * 0.23, 0, 0.028, 0.036, 0.051, palette.hat));
  return combine(parts);
}

function fender(radius, arc, angle, value) {
  return painted(
    new THREE.TorusGeometry(radius, 0.017, 6, 16, arc)
      .rotateZ(angle)
      .rotateY(Math.PI / 2)
      .scale(2.2, 1, 1),
    value,
  );
}

export function createPlayerBicycle() {
  const group = new THREE.Group();
  group.name = 'Mint Calgary city bike';
  group.rotation.order = 'YXZ';
  const mat = createCelActorMaterial();
  const geometries = [],
    addMesh = (geometry, parent = group) => {
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      geometries.push(geometry);
      return mesh;
    };
  const seat = BICYCLE.seat,
    bracket = BICYCLE.bracket;
  const seatTube = [0, 0.86, -0.22],
    head = [0, 0.91, 0.43],
    lowHead = [0, 0.77, 0.48],
    axleY = 0.36;
  const parts = [
    tube(bracket, seatTube, 0.032, palette.bike, 8),
    tube(bracket, [0, 0.59, 0.18], 0.041, palette.bike, 8),
    tube([0, 0.59, 0.18], lowHead, 0.041, palette.bike, 8),
    tube(seatTube, [0, 0.64, 0.13], 0.026, palette.bike, 8),
    tube(head, lowHead, 0.039, palette.bike, 8),
    tube(seatTube, seat, 0.022, palette.metal, 8),
    ellipsoid(0, seat[1] + 0.012, seat[2], 0.1, 0.036, 0.145, 0xa66b52, 12),
    tube([-0.11, bracket[1], bracket[2]], [0.11, bracket[1], bracket[2]], 0.045, palette.rubber, 8),
    // A pressed chain guard and a painted fender give the step-through its profile.
    ellipsoid(0.093, 0.373, -0.31, 0.019, 0.075, 0.336, palette.shoe, 12),
    fender(0.375, 2.14, 0.7, palette.bike).translate(0, axleY, BICYCLE.rearZ),
    box(0, 0.783, -0.648, 0.21, 0.029, 0.36, palette.shoe),
    box(0, 0.775, -0.839, 0.072, 0.034, 0.018, 0xe65a47),
  ];
  for (const side of [-1, 1]) {
    const dropout = [side * 0.062, axleY, BICYCLE.rearZ];
    parts.push(
      tube(bracket, dropout, 0.019, palette.bike, 6),
      tube(seatTube, dropout, 0.017, palette.bike, 6),
      tube(dropout, [side * 0.094, 0.777, -0.74], 0.011, palette.metal, 6),
    );
  }
  addMesh(combine(parts));
  const rear = new THREE.Group();
  rear.position.set(0, axleY, BICYCLE.rearZ);
  group.add(rear);
  const wheel = wheelGeometry();
  addMesh(wheel, rear);
  const steering = new THREE.Group();
  steering.position.fromArray(head);
  group.add(steering);
  const front = new THREE.Group();
  front.position.set(0, axleY - head[1], BICYCLE.frontZ - head[2]);
  steering.add(front);
  addMesh(wheel.clone(), front);
  const forkParts = [
    tube([0, -0.13, 0.04], [0, 0.1, 0.025], 0.027, palette.shoe, 8),
    tube([0, 0.1, 0.025], [0, 0.18, 0.072], 0.023, palette.metal, 8),
    tube([-0.17, 0.18, 0.072], [0.17, 0.18, 0.072], 0.017, palette.metal, 8),
    ellipsoid(0, 0.092, 0.12, 0.047, 0.043, 0.054, palette.shoe, 10),
    fender(0.37, 1.36, 0.9, palette.bike).translate(...front.position),
  ];
  for (const side of [-1, 1]) {
    forkParts.push(
      tube(
        [side * 0.057, -0.13, 0.04],
        [side * 0.055, front.position.y, front.position.z],
        0.022,
        palette.bike,
        8,
      ),
      tube([side * 0.16, 0.18, 0.072], [side * 0.23, 0.205, 0.13], 0.017, palette.metal, 8),
      tube([side * 0.22, 0.205, 0.13], [side * 0.319, 0.205, 0.13], 0.026, 0xa66b52, 8),
      tube([side * 0.23, 0.2, 0.14], [side * 0.291, 0.184, 0.189], 0.008, palette.rubber, 6),
    );
  }
  addMesh(combine(forkParts), steering);
  steering.add(
    travelLamp(new THREE.SphereGeometry(1, 10, 6).scale(0.038, 0.034, 0.018).translate(0, 0.092, 0.168)),
  );
  const crank = new THREE.Group();
  crank.position.fromArray(bracket);
  group.add(crank);
  addMesh(
    combine([
      tube([0.1, 0, 0], [0.1, 0.17, 0], 0.018, palette.metal, 8),
      tube([-0.1, 0, 0], [-0.1, -0.17, 0], 0.018, palette.metal, 8),
      tube([0.079, 0, 0], [0.105, 0, 0], 0.079, palette.shoe, 16),
    ]),
    crank,
  );
  const pedals = [1, -1].map((side) => {
    const pedal = new THREE.Group();
    pedal.position.set(side * BICYCLE.pedalHalf, side * BICYCLE.crankRadius, 0);
    crank.add(pedal);
    addMesh(
      combine([
        box(0, 0, 0, 0.105, 0.025, 0.075, palette.rubber),
        box(0, 0, -0.038, 0.072, 0.017, 0.008, palette.hat),
      ]),
      pedal,
    );
    return pedal;
  });
  let crankAngle = 0,
    cadence = 0,
    wheelAngle = 0,
    lean = 0,
    pitch = 0,
    steer = 0,
    previousHeading = null;
  const grips = BICYCLE.grips.map((point) => [...point]);
  const rig = {
    group,
    rearWheel: rear,
    frontWheel: front,
    steering,
    crank,
    pedals,
    grips,
    get crankAngle() {
      return crankAngle;
    },
    get wheelAngle() {
      return wheelAngle;
    },
    get lean() {
      return lean;
    },
    get pitch() {
      return pitch;
    },
    update(dt, state, groundHeight = () => 0) {
      dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.06);
      const velocity = Number.isFinite(state.speed) ? state.speed : 0;
      wheelAngle += (velocity / BICYCLE.wheelRadius) * dt;
      const pedaling = (state.throttle ?? 1) > 0 && velocity > 0;
      if (pedaling) {
        const target = clamp(velocity / (BICYCLE.wheelRadius * 3.8), 0, 9.5);
        cadence += (target - cadence) * ease(dt, 0.14);
        crankAngle += cadence * dt;
      } else {
        cadence = 0;
      }
      rear.rotation.x = front.rotation.x = wheelAngle;
      crank.rotation.x = crankAngle;
      for (const pedal of pedals) pedal.rotation.x = -crankAngle;
      const heading = state.heading || 0;
      const delta =
        previousHeading === null
          ? 0
          : Math.atan2(Math.sin(heading - previousHeading), Math.cos(heading - previousHeading));
      let turnRate = dt > 0 ? delta / dt : 0;
      if (Math.abs(delta) > 0.5) turnRate = 0; // teleports / mode changes are not extreme cornering
      previousHeading = heading;
      const input = Number.isFinite(state.steering) ? state.steering : 0;
      const targetLean = clamp(
        -Math.atan((velocity * turnRate) / 9.81) - input * Math.min(Math.abs(velocity) / 22, 1) * 0.05,
        -0.43,
        0.43,
      );
      lean += (targetLean - lean) * (1 - Math.exp(-dt * 8));
      const sample = (distance) =>
        groundHeight(state.x + Math.sin(heading) * distance, state.z + Math.cos(heading) * distance);
      const frontY = sample(BICYCLE.frontZ),
        rearY = sample(BICYCLE.rearZ),
        base = groundHeight(state.x, state.z);
      const targetPitch =
        Number.isFinite(frontY) && Number.isFinite(rearY)
          ? -Math.atan2(frontY - rearY, BICYCLE.frontZ - BICYCLE.rearZ)
          : 0;
      pitch += (clamp(targetPitch, -0.32, 0.32) - pitch) * (1 - Math.exp(-dt * 12));
      steer +=
        (clamp(Math.atan2(turnRate * 1.48, Math.max(Math.abs(velocity), 1.5)), -0.42, 0.42) - steer) *
        (1 - Math.exp(-dt * 10));
      steering.rotation.y = steer;
      for (let i = 0; i < grips.length; i++) {
        const source = BICYCLE.grips[i],
          dx = source[0],
          dz = source[2] - head[2];
        grips[i][0] = dx * Math.cos(steer) + dz * Math.sin(steer);
        grips[i][1] = source[1];
        grips[i][2] = head[2] - dx * Math.sin(steer) + dz * Math.cos(steer);
      }
      group.position.set(state.x, Number.isFinite(base) ? base : state.y || 0, state.z);
      group.rotation.set(pitch, heading, lean, 'YXZ');
      group.updateMatrixWorld(true);
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      mat.dispose();
      group.removeFromParent();
    },
  };
  return rig;
}
