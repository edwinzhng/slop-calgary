import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { orientSurfaceUpward } from '../app/surface-winding.js';

const bytes = (a) => Buffer.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)),
  plane = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0.5, 0, 0, 0.7, 4, 4, 1.3, 0, 4, 1.5, 4], 3),
    );
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 1, 1], 2));
    g.setIndex([0, 1, 2, 1, 2, 3]);
    g.computeVertexNormals();
    g.computeBoundingBox();
    return g;
  };

test('indexed slope repair keeps every position/UV byte, bounds, groups and triangle count while correcting shared normals', () => {
  const g = plane(),
    positions = bytes(g.attributes.position.array),
    uv = bytes(g.attributes.uv.array),
    box = g.boundingBox.clone(),
    count = g.index.count;
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  const groups = structuredClone(g.groups);
  assert.equal(orientSurfaceUpward(g), 1);
  assert.deepEqual(bytes(g.attributes.position.array), positions);
  assert.deepEqual(bytes(g.attributes.uv.array), uv);
  assert.deepEqual(g.boundingBox, box);
  assert.deepEqual(g.groups, groups);
  assert.equal(g.index.count, count);
  assert.deepEqual([...g.index.array], [0, 1, 2, 1, 3, 2]);
  assert.ok([...g.attributes.normal.array].every(Number.isFinite));
  for (let i = 0; i < g.attributes.normal.count; i++) assert.ok(g.attributes.normal.getY(i) > 0);
  const normals = bytes(g.attributes.normal.array),
    version = g.index.version;
  assert.equal(orientSurfaceUpward(g), 0);
  assert.deepEqual(bytes(g.attributes.normal.array), normals);
  assert.equal(g.index.version, version);
  g.dispose();
});

test('non-indexed top rays become valid without moving vertex records or losing their texture correspondence', () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 0, 2], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  g.computeVertexNormals();
  const coordinates = bytes(g.attributes.position.array),
    uv = bytes(g.attributes.uv.array),
    mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.FrontSide })),
    ray = new THREE.Raycaster(new THREE.Vector3(0.5, 5, 0.5), new THREE.Vector3(0, -1, 0));
  mesh.updateMatrixWorld(true);
  assert.equal(ray.intersectObject(mesh).length, 0);
  assert.equal(orientSurfaceUpward(g), 1);
  assert.equal(ray.intersectObject(mesh)[0].point.y, 0);
  assert.deepEqual(bytes(g.attributes.position.array), coordinates);
  assert.deepEqual(bytes(g.attributes.uv.array), uv);
  assert.deepEqual([...g.index.array], [0, 2, 1]);
  g.dispose();
  mesh.material.dispose();
});

test('already upward, vertical and invalid projections do not acquire invented repairs', () => {
  for (const points of [
    [0, 0, 0, 0, 0, 2, 2, 0, 0],
    [0, 0, 0, 0, 2, 0, 0, 0, 2],
    [0, 0, 0, 1, 0, 1, 2, 0, 2],
    [NaN, 0, 0, 1, 0, 0, 0, 0, 1],
  ]) {
    const g = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(points, 3),
      ),
      positions = bytes(g.attributes.position.array);
    assert.equal(orientSurfaceUpward(g), 0);
    assert.equal(g.index, null);
    assert.deepEqual(bytes(g.attributes.position.array), positions);
    g.dispose();
  }
});
