import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { SpatialIndex, bounds } from '../app/geo.js';
import {
  createCameraCollision,
  createChaseBoom,
  movementBody,
  footprintContact,
} from '../app/camera-collision.js';

const building = {
  id: 'tower',
  ring: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
  holes: [
    [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ],
  ],
  height: 30,
};
function world(objects = [building]) {
  const buildingIndex = new SpatialIndex(20);
  for (const b of objects) buildingIndex.insert(b, bounds(b.ring));
  return { buildingIndex, groundHeight: () => 0.2 };
}

test('camera volume resolves building interiors, concave corners, roofs and ground', () => {
  const camera = createCameraCollision(world());
  for (const start of [
    [1, 2, 1],
    [9.9, 2, -0.1],
    [9, 29.9, 9],
    [14, -10, 14],
  ]) {
    const end = camera.resolve(new THREE.Vector3(...start));
    assert.equal(camera.blocked(end), false, JSON.stringify(start));
    assert.ok(end.y >= 0.51);
  }
  assert.equal(camera.blocked(new THREE.Vector3(5, 2, 5)), false, 'open courtyard is clear');
});

test('camera boom stops before a wall even when both endpoints are clear', () => {
  const camera = createCameraCollision(world());
  const a = new THREE.Vector3(-5, 2, 1),
    b = new THREE.Vector3(15, 2, 1);
  assert.equal(camera.blocked(a), false);
  assert.equal(camera.blocked(b), false);
  const result = camera.sweep(a, b);
  assert.ok(result.x < -0.34 && result.x > -1);
  assert.equal(camera.blocked(result), false);
});

test('chase camera stays attached through a turn and eases back out after a wall', () => {
  const collision = createCameraCollision(world()),
    follow = createChaseBoom(collision),
    anchor = new THREE.Vector3(-1, 2, 1),
    desired = new THREE.Vector3(5, 2, 1),
    actual = new THREE.Vector3();
  follow(anchor, desired, 1 / 60, actual, true);
  assert.ok(actual.x < -0.4, 'the radius clears the wall');
  const compressed = actual.distanceTo(anchor);
  anchor.set(-1, 2, -1);
  desired.set(5, 2, -1);
  follow(anchor, desired, 1 / 60, actual);
  assert.equal(actual.z, anchor.z, 'the camera follows the player around the corner immediately');
  assert.ok(actual.distanceTo(anchor) > compressed && actual.distanceTo(anchor) < 2, 'no instant zoom out');
  for (let i = 0; i < 45; i++) {
    follow(anchor, desired, 1 / 60, actual);
    assert.equal(collision.blocked(actual, 0.4), false);
  }
  assert.ok(actual.distanceTo(desired) < 0.01, 'the full chase distance recovers');
});

test('camera can pass below raised structures without jumping onto their deck', () => {
  const raised = { ...building, holes: [], minHeight: 5, height: 8 };
  const camera = createCameraCollision(world([raised]));
  assert.equal(camera.blocked(new THREE.Vector3(5, 2, 5)), false);
  assert.equal(camera.blocked(new THREE.Vector3(5, 6, 5)), true);
  assert.equal(footprintContact(raised, 5, 0, 5, movementBody('drive'), {}), false);
});

test('driving collisions use the vehicle rectangle and preserve courtyard gaps', () => {
  assert.equal(footprintContact(building, -1.4, 0, 5, movementBody('drive', Math.PI / 2), {}), true);
  assert.equal(footprintContact(building, -1.4, 0, 5, movementBody('drive', 0), {}), false);
  assert.equal(footprintContact(building, 5, 0, 5, movementBody('walk'), {}), false);
});
