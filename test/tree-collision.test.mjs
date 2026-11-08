import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createTreeCollision } from '../app/tree-collision.js';
import { createCameraCollision, movementBody } from '../app/camera-collision.js';

const trunks = createTreeCollision([{ x: 0, z: 0, profile: { radius: 0.2, height: 12 } }]);

test('surveyed trunks block people and the rotated vehicle box, with height-aware clearance', () => {
  const person = movementBody('walk');
  assert.equal(trunks.blocked({ x: 0.5, y: 0.2, z: 0 }, person), true);
  assert.equal(trunks.blocked({ x: 0.7, y: 0.2, z: 0 }, person), false);
  assert.equal(trunks.blocked({ x: 0, y: 14, z: 0 }, person), false);
  assert.equal(trunks.blocked({ x: 2.4, y: 0.2, z: 0 }, movementBody('drive', Math.PI / 2)), true);
  assert.equal(trunks.blocked({ x: 2.4, y: 0.2, z: 0 }, movementBody('drive', 0)), false);
  const position = { x: 0.5, y: 0.2, z: 0 };
  assert.equal(trunks.resolve(position, person), true);
  assert.equal(trunks.blocked(position, person), false);
});

test('the camera boom stops before a trunk without treating the whole tree canopy as solid', () => {
  const camera = createCameraCollision({ trunks, groundHeight: () => 0.2 });
  const end = camera.sweep(new THREE.Vector3(-3, 2, 0), new THREE.Vector3(3, 2, 0), 0.3);
  assert.ok(end.x < -0.49 && end.x > -0.7);
  assert.equal(camera.blocked(new THREE.Vector3(2, 6, 0), 0.3), false);
});

test('large street assets stay collidable across spatial cell boundaries', () => {
  const assets = createTreeCollision([{ x: 41.9, z: 0, baseY: 0.2, profile: { radius: 2.2, height: 1.2 } }]);
  assert.equal(assets.blocked({ x: 39.5, y: 0.2, z: 0 }, movementBody('walk')), true);
  assert.equal(assets.blocked({ x: 39.5, y: 2, z: 0 }, movementBody('walk')), false);
});
