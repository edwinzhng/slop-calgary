import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { createCityMeshes } from '../app/city-meshes.js';
import { createPointeDetails } from '../app/pointe-details.js';
import { POINTE_MATERIAL_EVIDENCE as evidence } from '../app/observed-building-materials.js';

const provider = createCityMeshes(
  JSON.parse(fs.readFileSync(new URL('../data/calgary-meshes.json', import.meta.url))),
  fs.readFileSync(new URL('../data/calgary-meshes.bin', import.meta.url)),
);

test('Pointe bands follow the actual curved shell with outward faces, readable UVs and open glass between', () => {
  const source = provider.createGeometry(evidence.buildingId),
    sourcePositions = source.attributes.position.array.slice(),
    sourceNormals = source.attributes.normal.array.slice(),
    scene = new THREE.Scene(),
    material = new THREE.MeshBasicMaterial(),
    details = createPointeDetails(scene, {}, { sourceGeometry: source, material }),
    mesh = details.group.children[0],
    shell = new THREE.Mesh(source, material),
    ray = new THREE.Raycaster();
  try {
    assert.equal(details.stats.sourceAccepted, true);
    assert.equal(details.stats.triangles, 102);
    assert.equal(details.stats.drawBudget, 1);
    assert.deepEqual(details.colliders, []);
    scene.updateMatrixWorld(true);
    shell.updateMatrixWorld(true);
    for (let triangle = 48; triangle <= 80; triangle += 2) {
      const p = source.attributes.position,
        n = new THREE.Vector3().fromBufferAttribute(source.attributes.normal, triangle * 3),
        endpoints = new Map();
      for (let vertex = triangle * 3; vertex < (triangle + 2) * 3; vertex++)
        endpoints.set(`${p.getX(vertex)},${p.getZ(vertex)}`, [p.getX(vertex), p.getZ(vertex)]);
      assert.equal(endpoints.size, 2);
      const [a, b] = [...endpoints.values()],
        x = (a[0] + b[0]) / 2,
        z = (a[1] + b[1]) / 2;
      for (const y of [2.8, 6, 9.6]) {
        ray.set(new THREE.Vector3(x, y, z).addScaledVector(n, 0.25), n.clone().negate());
        const sourceHit = ray.intersectObject(shell)[0],
          detailHit = ray.intersectObject(mesh)[0];
        assert.ok(sourceHit && detailHit);
        assert.ok(Math.abs(sourceHit.distance - detailHit.distance - 0.018) < 0.00015);
        assert.ok(detailHit.normal.dot(n) > 0.999);
      }
      for (const y of [4.1, 7.8]) {
        ray.set(new THREE.Vector3(x, y, z).addScaledVector(n, 0.25), n.clone().negate());
        assert.ok(ray.intersectObject(shell).length);
        assert.equal(ray.intersectObject(mesh).length, 0, 'the two photographed glass bands stay exposed');
      }
    }
    const uv = mesh.geometry.attributes.uv,
      indices = mesh.geometry.index;
    for (let i = 0; i < indices.count; i += 3) {
      const a = indices.getX(i),
        b = indices.getX(i + 1),
        c = indices.getX(i + 2);
      assert.ok(
        (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) -
          (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a)) >
          0,
        'the atlas lettering faces outward without mirroring',
      );
    }
    assert.deepEqual(source.attributes.position.array, sourcePositions);
    assert.deepEqual(source.attributes.normal.array, sourceNormals);
  } finally {
    details.dispose();
    source.dispose();
    material.dispose();
  }
});

test('changed Pointe geometry or source identity suppresses details before allocating a mesh', () => {
  const material = new THREE.MeshBasicMaterial();
  try {
    for (const mutate of [
      (g) => g.attributes.position.setX(0, g.attributes.position.getX(0) + 0.01),
      (g) => g.attributes.normal.setZ(0, g.attributes.normal.getZ(0) + 0.01),
      (g) => {
        g.userData.cityMesh.structureIds = [999];
      },
      (g) => {
        g.userData.cityMesh.id = 'another-building';
      },
      (g) => g.setIndex([0, 1, 2]),
    ]) {
      const source = provider.createGeometry(evidence.buildingId),
        scene = new THREE.Scene();
      mutate(source);
      const details = createPointeDetails(scene, {}, { sourceGeometry: source, material });
      try {
        details.update({ x: -1190.5, y: 2, z: -733.7 });
        assert.equal(details.stats.sourceAccepted, false);
        assert.equal(details.group.visible, false);
        assert.equal(scene.children.length, 0);
        assert.equal(details.stats.drawBudget, 0);
      } finally {
        details.dispose();
        source.dispose();
      }
    }
  } finally {
    material.dispose();
  }
});

test('Pointe detail owns only its resources, follows host ground placement and stays bounded through warmup', () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshBasicMaterial();
  let sourceDisposals = 0,
    detailDisposals = 0,
    materialDisposals = 0;
  material.addEventListener('dispose', () => materialDisposals++);
  const world = {
      photoWallGeometry(id) {
        assert.equal(id, evidence.buildingId);
        const source = provider.createGeometry(id);
        source.addEventListener('dispose', () => sourceDisposals++);
        return source;
      },
      placePhotographicGeometry(geometry, record) {
        assert.equal(record.buildingId, evidence.buildingId);
        geometry.translate(0, 7, 0);
      },
    },
    details = createPointeDetails(scene, world, { material }),
    mesh = details.group.children[0];
  mesh.geometry.addEventListener('dispose', () => detailDisposals++);
  assert.equal(sourceDisposals, 1);
  assert.ok(mesh.geometry.boundingSphere.center.y > 12);
  const near = { x: -1190.5, y: 9, z: -733.7 };
  details.update(near);
  assert.equal(details.group.visible, true);
  details.update({ ...near, x: near.x + 120 });
  assert.equal(details.group.visible, false);
  details.update({ ...near, x: near.x + 120 }, 'high');
  assert.equal(details.group.visible, true);
  details.setEnabled(false);
  assert.equal(details.group.visible, false);
  const restore = details.prewarm();
  assert.equal(details.group.visible, true);
  assert.equal(mesh.frustumCulled, false);
  restore();
  restore();
  assert.equal(details.group.visible, false);
  assert.equal(mesh.frustumCulled, true);
  details.setEnabled(true);
  details.update(near);
  const lateRestore = details.prewarm();
  details.dispose();
  details.dispose();
  lateRestore();
  details.update(near);
  assert.equal(details.group.visible, false);
  assert.equal(details.group.parent, null);
  assert.equal(detailDisposals, 1);
  assert.equal(materialDisposals, 0);
  assert.equal(details.stats.activeDraws, 0);
  material.dispose();
});
