import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from '../js/pedestrians.js';
import { BICYCLE } from './player-bicycle.js';
import { PLAYER_PACE_MULTIPLIER } from './motion.js';

const sampleFloor = (floor, x, z) => floor(x, z);
const flat = () => 0;
const bodyVisible = (state) =>
  state.cameraView !== 'first' && !(state.cameraDistance > 0 && state.cameraDistance < 0.85);

export function createCivilianPlayer() {
  const rig = new PersonRig({
    seed: 0.62,
    hair: 0.42,
    stride: 1.08,
    motionScale: 1 / PLAYER_PACE_MULTIPLIER,
  });
  const crowd = new PersonCrowd(1, { farDistance: Infinity, friendlyFace: true });
  const group = new THREE.Group();
  group.name = 'Civilian player';
  group.add(...crowd.meshes);
  const geometry = crowd.meshes[0].geometry;
  const avatarStats = {
    model: 'Civilian',
    ready: true,
    drawCalls: 1,
    triangles: (geometry.index?.count ?? geometry.attributes.position.count) / 3,
  };
  const ride = {
    seat: new THREE.Vector3(...BICYCLE.seat),
    bracket: new THREE.Vector3(...BICYCLE.bracket),
    crankLength: BICYCLE.crankRadius,
    pedalHalf: BICYCLE.pedalHalf,
  };
  let previousMode;
  function draw(state) {
    group.visible = bodyVisible(state);
    crowd.begin();
    if (group.visible) crowd.add(rig);
    crowd.end();
  }
  return {
    group,
    rig,
    avatarStats,
    updateWalk(dt, state, groundHeight = flat) {
      if (previousMode !== 'walk') rig.placed = false;
      previousMode = 'walk';
      const floor = groundHeight(state.x, state.z);
      const air = state.grounded === false ? Math.max(0, state.y - floor) : 0;
      const support = Number.isFinite(state.y) && state.grounded !== false ? state.y : floor;
      const footFloor = (x, z) => THREE.MathUtils.clamp(groundHeight(x, z), support - 0.28, support + 0.28);
      rig.update(dt, state.x, state.z, state.heading, sampleFloor, footFloor, air);
      draw(state);
    },
    updateRide(_dt, bicycle, state) {
      previousMode = 'cycle';
      ride.grips = bicycle.grips;
      rig.ride(bicycle.group, bicycle.crankAngle + Math.PI, ride);
      draw(state);
    },
    dispose() {
      for (const mesh of crowd.meshes) {
        mesh.material.dispose();
      }
      group.removeFromParent();
    },
    hide() {
      previousMode = undefined;
      group.visible = false;
    },
  };
}
