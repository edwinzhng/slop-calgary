import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { makeRoadIndex } from '../app/geo.js';
import { createActors } from '../app/actors.js';
import { windowGlow } from '../app/materials.js';

test('travel modes preserve the light set while car beams follow the vehicle and switch off outside driving', () => {
  const scene = new THREE.Scene(),
    world = {
      data: { roads: [] },
      roadIndex: makeRoadIndex([]),
      groundSurfaces: { groundHeight: () => null },
      groundHeight: () => 0,
      surfaceHeight: () => 0,
      collision: () => false,
    },
    player = { group: new THREE.Group(), hide() {}, updateWalk() {}, updateRide() {} },
    actors = createActors(scene, world, { player }),
    camera = new THREE.PerspectiveCamera(),
    baseline = [];
  scene.traverseVisible((object) => {
    if (object.isLight) baseline.push(object);
  });
  assert.equal(baseline.length, 2);
  for (const mode of ['drive', 'walk', 'cycle', 'fly', 'drive']) {
    const heading = mode.length * 0.731,
      state = { mode, x: 23, y: 7, z: -41, heading, speed: 0, steering: 0, yawRate: 0 };
    actors.update(0, state, camera, 'balanced');
    scene.updateMatrixWorld(true);
    const lights = [];
    scene.traverseVisible((object) => {
      if (object.isLight) lights.push(object);
    });
    assert.deepEqual(lights, baseline, `${mode} keeps the same lighting graph`);
    assert.equal(actors.playerCar.visible, mode === 'drive');
    for (const light of lights) {
      assert.equal(light.intensity, mode === 'drive' ? windowGlow.value * 240 : 0);
      if (mode !== 'drive') continue;
      for (const object of [light, light.target]) {
        const expected = object.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), heading);
        expected.add(new THREE.Vector3(state.x, state.y, state.z));
        assert.ok(object.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-10);
      }
    }
  }
});
