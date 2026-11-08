import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createCarInstances } from '../app/car-instances.js';
import { prepareInstanceMatrices } from '../app/render-instances.js';

test('distant vehicles preserve transforms, paint and indicators while reducing their geometry', () => {
  const scene = new THREE.Scene(),
    cars = createCarInstances(scene, { name: 'Test fleet', capacity: 3 }),
    matrix = new THREE.Matrix4().makeRotationY(0.71).setPosition(123, 4, -71),
    paint = new THREE.Color(0x234eaa),
    actual = new THREE.Matrix4();
  prepareInstanceMatrices(scene, true);
  try {
    cars.begin();
    cars.add('near', matrix, paint, 40, 1, 0, 1, 7);
    cars.add('far', matrix, paint, 250, 0, 1, 0, 3);
    cars.end();
    assert.deepEqual([cars.stats.nearby, cars.stats.distant], [1, 1]);
    const [near, far] = cars.meshes;
    assert.ok(far.geometry.attributes.position.count < near.geometry.attributes.position.count / 5);
    for (const [index, mesh] of [near, far].entries()) {
      mesh.getMatrixAt(0, actual);
      assert.deepEqual(actual.elements, Array.from(new Float32Array(matrix.elements)));
      assert.deepEqual(
        Array.from(mesh.geometry.attributes.paintColor.array.subarray(0, 3)),
        Array.from(new Float32Array([paint.r, paint.g, paint.b])),
      );
      assert.deepEqual(
        Array.from(mesh.geometry.attributes.carState.array.subarray(0, 4)),
        index ? [0, 1, 0, 3] : [1, 0, 1, 7],
      );
      assert.ok(mesh.boundingSphere.containsPoint(new THREE.Vector3(123, 4.6, -71)));
      assert.equal(mesh.instanceMatrix.isStorageInstancedBufferAttribute, true);
      assert.ok(mesh.instanceMatrix.version > 0);
    }
  } finally {
    for (const mesh of cars.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
});

test('detail changes have hysteresis, bounded identity history and one shared fleet capacity', () => {
  const cars = createCarInstances(new THREE.Scene(), { name: 'Test fleet', capacity: 2 }),
    matrix = new THREE.Matrix4(),
    paint = new THREE.Color();
  const frame = (distance, quality = 'balanced') => {
    cars.begin(quality);
    cars.add('one', matrix, paint, distance);
    cars.end();
    return [cars.stats.nearby, cars.stats.distant];
  };
  try {
    assert.deepEqual(frame(95), [1, 0]);
    assert.deepEqual(frame(105), [1, 0]);
    assert.deepEqual(frame(110), [0, 1]);
    assert.deepEqual(frame(95), [0, 1]);
    assert.deepEqual(frame(90), [1, 0]);
    assert.deepEqual(frame(140, 'high'), [1, 0]);
    assert.deepEqual(
      frame(60, 'performance'),
      [0, 1],
      'the cheaper mode uses the matching silhouette earlier',
    );
    assert.deepEqual(frame(35, 'performance'), [0, 1]);
    assert.deepEqual(frame(30, 'performance'), [1, 0]);
    assert.deepEqual(frame(60, 'balanced'), [1, 0], 'restoring quality restores nearby detail');
    cars.begin();
    cars.end();
    assert.deepEqual(frame(105), [0, 1], 'a departed identity does not retain an old detail state');
    cars.begin();
    assert.equal(cars.add('one', matrix, paint, 50), true);
    assert.equal(cars.add('two', matrix, paint, 250, 1, 1, 0, 8, 'pickup'), true);
    assert.equal(cars.add('three', matrix, paint, 50), false);
    cars.end();
    assert.equal(cars.stats.nearby + cars.stats.distant, 2);
    assert.equal(cars.stats.pickups, 1);
    const [sedanNear, sedanFar, pickupNear, pickupFar] = cars.meshes;
    assert.deepEqual([sedanNear.count, sedanFar.count, pickupNear.count, pickupFar.count], [1, 0, 0, 1]);
    assert.deepEqual(Array.from(pickupFar.geometry.attributes.carState.array.subarray(0, 4)), [1, 1, 0, 8]);
    cars.begin();
    assert.equal(cars.add('two', matrix, paint, 60, 1, 1, 0, 8, 'pickup'), true);
    cars.end();
    assert.deepEqual([pickupNear.count, pickupFar.count], [1, 0]);
  } finally {
    for (const mesh of cars.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
});
