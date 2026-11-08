import * as THREE from 'three/webgpu';
import { color, float, length, smoothstep, uniform, uv } from 'three/tsl';
import { createCelActorMaterial } from './materials.js';
import { springScalar } from './motion.js';
import { box, combine, ellipsoid, painted, tube, travelLamp } from './travel-geometry.js';

const vermilion = 0xde5b46,
  cream = 0xffdc94,
  graphite = 0x304153,
  canopy = 0x36748c;
const clamp = THREE.MathUtils.clamp,
  TAU = Math.PI * 2;

export function createTravelHelicopter() {
  const group = new THREE.Group();
  group.name = 'Bow River rescue helicopter';
  const material = createCelActorMaterial();
  const bubble = new THREE.SphereGeometry(1, 22, 10, 0, TAU, 0, Math.PI / 2)
    .scale(1.005, 0.99, 1.37)
    .translate(0, 0.84, 0.91);
  const body = [
    ellipsoid(0, 0.87, 0.19, 1.12, 0.87, 1.98, vermilion, 20),
    ellipsoid(0, 0.55, 0.67, 1.018, 0.47, 1.55, cream, 18),
    painted(bubble, canopy),
    ellipsoid(0, 1.6, -0.55, 0.67, 0.57, 1.15, vermilion, 16),
    ellipsoid(0, 1.59, -1.53, 0.5, 0.28, 0.5, graphite, 12),
    tube([0, 1.09, -1.16], [0, 1.78, -5.55], 0.43, vermilion, 10, 0.118),
    tube([0, 1.56, -4.21], [0, 1.65, -4.77], 0.221, cream, 10, 0.179),
    tube([0, 1.81, -5.48], [0, 2.49, -5.83], 0.23, vermilion, 8, 0.105),
    box(0, 1.62, -4.52, 2.01, 0.078, 0.38, cream),
    tube([0, 1.9, -0.45], [0, 2.58, -0.45], 0.13, graphite, 10),
    ellipsoid(0, 2.56, -0.45, 0.29, 0.115, 0.29, cream, 12),
    ellipsoid(0, 0.24, 1.82, 0.19, 0.16, 0.19, graphite, 12),
  ];
  // One canopy with a painted center spar and side frames.
  for (const [from, to] of [
    [
      [0, 0.85, 2.284],
      [0, 1.25, 2.17],
    ],
    [
      [0, 1.25, 2.17],
      [0, 1.56, 1.87],
    ],
    [
      [0, 1.56, 1.87],
      [0, 1.77, 1.42],
    ],
  ])
    body.push(tube(from, to, 0.027, cream, 6));
  for (const side of [-1, 1]) {
    body.push(
      ellipsoid(side * 0.9, 1.2, -0.56, 0.14, 0.31, 0.57, graphite, 12),
      ellipsoid(side * 0.959, 1.21, -0.55, 0.104, 0.227, 0.44, canopy, 12),
      box(side * 1.065, 0.81, -0.66, 0.035, 0.056, 0.19, cream),
      tube([side * 0.59, 0.27, 0.85], [side * 1.02, -0.19, 0.85], 0.067, graphite, 8),
      tube([side * 0.61, 0.3, -0.89], [side * 1.02, -0.19, -0.89], 0.067, graphite, 8),
      tube([side * 1.02, -0.19, -1.58], [side * 1.02, -0.19, 1.62], 0.08, graphite, 10),
      tube([side * 1.02, -0.19, 1.62], [side * 1.02, -0.03, 1.97], 0.08, graphite, 8, 0.055),
      box(side * 0.98, 1.67, -4.51, 0.12, 0.09, 0.15, side < 0 ? 0x6bc9a9 : 0xed6e58),
    );
  }
  group.add(new THREE.Mesh(combine(body), material));
  group.add(
    travelLamp(new THREE.SphereGeometry(1, 12, 8).scale(0.117, 0.092, 0.086).translate(0, 0.23, 1.96)),
  );

  const blades = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i * TAU) / 4;
    blades.push(
      box(0.08, 0, 1.75, 0.19, 0.024, 3.28, graphite).rotateY(angle),
      box(0.08, 0, 3.35, 0.19, 0.026, 0.2, cream).rotateY(angle),
    );
  }
  const rotorMaterial = material.clone();
  rotorMaterial.transparent = true;
  rotorMaterial.depthWrite = false;
  const rotor = new THREE.Mesh(combine(blades), rotorMaterial);
  rotor.position.set(0, 2.64, -0.45);
  group.add(rotor);

  const discMaterial = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const radius = length(uv().sub(0.5)).mul(2);
  discMaterial.colorNode = color(0xa5b4ba);
  const blur = uniform(0);
  discMaterial.opacityNode = blur.mul(
    smoothstep(0.11, 0.44, radius)
      .add(smoothstep(0.8, 0.92, radius).mul(0.9))
      .mul(float(1).sub(smoothstep(0.94, 1, radius))),
  );
  const disc = new THREE.Mesh(new THREE.CircleGeometry(3.48, 32).rotateX(-Math.PI / 2), discMaterial);
  disc.position.copy(rotor.position);
  group.add(disc);

  const tail = new THREE.Mesh(
    combine([
      box(0, 0, 0, 0.039, 0.97, 0.109, graphite),
      box(0, 0, 0, 0.039, 0.109, 0.97, graphite),
      box(0, 0.446, 0, 0.042, 0.077, 0.11, cream),
      box(0, -0.446, 0, 0.042, 0.077, 0.11, cream),
    ]),
    rotorMaterial,
  );
  tail.position.set(0.23, 2.02, -5.65);
  group.add(tail);
  const tailDisc = new THREE.Mesh(new THREE.CircleGeometry(0.51, 16).rotateY(Math.PI / 2), discMaterial);
  tailDisc.position.copy(tail.position);
  group.add(tailDisc);

  let pitch = 0,
    pitchVelocity = 0,
    bank = 0,
    bankVelocity = 0,
    spin = 0;
  return {
    group,
    update(dt, state) {
      group.visible = state.mode === 'fly';
      if (!group.visible) {
        pitch = pitchVelocity = bank = bankVelocity = spin = 0;
        return;
      }
      const speed = state.speed || 0;
      const lift = state.verticalSpeed || 0;
      const targetPitch = clamp(speed * 0.0035 - lift * 0.002, -0.2, 0.23);
      const turn = clamp(state.yawRate || 0, -2, 2);
      const targetBank = clamp(-turn * (0.04 + Math.abs(speed) * 0.006), -0.31, 0.31);
      [pitch, pitchVelocity] = springScalar(pitch, pitchVelocity, targetPitch, 0.37, dt);
      [bank, bankVelocity] = springScalar(bank, bankVelocity, targetBank, 0.32, dt);
      group.position.set(state.x, state.y, state.z);
      group.rotation.set(pitch, state.heading, bank, 'YXZ');
      spin += (1 - spin) * (1 - Math.exp(-dt / 0.26));
      rotor.rotation.y = (rotor.rotation.y + dt * (18 + spin * 23)) % TAU;
      tail.rotation.x = (tail.rotation.x + dt * (25 + spin * 32)) % TAU;
      rotorMaterial.opacity = 1 - spin * 0.8;
      blur.value = spin * 0.15;
      disc.visible = tailDisc.visible = spin > 0.015;
    },
  };
}
