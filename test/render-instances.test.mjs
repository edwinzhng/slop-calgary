import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { prepareInstanceMatrices } from '../app/render-instances.js';

test('storage matrices retain the exact live transform array, update ranges and upload configuration', () => {
  const scene = new THREE.Scene(),
    mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3),
    matrix = new THREE.Matrix4().makeTranslation(19, 2.5, -41);
  scene.add(mesh);
  mesh.setMatrixAt(1, matrix);
  const source = mesh.instanceMatrix,
    values = source.array.slice();
  const uploaded = () => {};
  source.setUsage(THREE.DynamicDrawUsage);
  source.addUpdateRange(16, 16);
  source.onUpload(uploaded);
  const stats = prepareInstanceMatrices(scene, true),
    storage = mesh.instanceMatrix;
  assert.ok(storage.isStorageInstancedBufferAttribute);
  assert.equal(storage.array, source.array, 'no extra copy of instance transforms');
  assert.deepEqual(storage.array, values);
  assert.equal(storage.usage, THREE.DynamicDrawUsage);
  assert.equal(storage.onUploadCallback, uploaded);
  assert.deepEqual(storage.updateRanges, [{ start: 16, count: 16 }]);
  assert.equal(stats.buffers, 1);
  assert.equal(stats.bytes, values.byteLength);
  mesh.setMatrixAt(1, matrix.makeTranslation(-3, 8, 5));
  const version = storage.version;
  mesh.instanceMatrix.needsUpdate = true;
  assert.equal(storage.version, version + 1);
  mesh.getMatrixAt(1, matrix);
  assert.deepEqual(matrix.elements.slice(12, 15), [-3, 8, 5]);
  assert.equal(prepareInstanceMatrices(scene, true).meshes, 0);
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('shared matrix ownership survives conversion and WebGL keeps its ordinary instance attributes', () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial(),
    a = new THREE.InstancedMesh(geometry, material, 2),
    b = new THREE.InstancedMesh(geometry, material, 2);
  b.instanceMatrix = a.instanceMatrix;
  scene.add(a, b);
  const source = a.instanceMatrix;
  assert.deepEqual(prepareInstanceMatrices(scene, false), { meshes: 0, buffers: 0, bytes: 0 });
  assert.equal(a.instanceMatrix, source);
  assert.equal(b.instanceMatrix, source);
  const stats = prepareInstanceMatrices(scene, true);
  assert.equal(stats.meshes, 2);
  assert.equal(stats.buffers, 1);
  assert.equal(a.instanceMatrix, b.instanceMatrix);
  assert.equal(a.instanceMatrix.array, source.array);
  geometry.dispose();
  material.dispose();
});
