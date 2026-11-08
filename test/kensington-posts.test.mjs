import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { createTreeCollision } from '../app/tree-collision.js';
import { createStreetDetailPrototypes } from '../app/street-detail-models.js';
import { prepareStreetDetails, createStreetDetails, STREET_DETAIL_LIMITS } from '../app/street-details.js';

const inventory = JSON.parse(
  fs.readFileSync(new URL('../data/calgary-street-details.json', import.meta.url)),
);
const sourceRow = inventory.records.filter(
  (record) => record.kind === 'bollard' && record.assetCode === 'HIL679',
);
const fixture = (records) => ({ records, beds: [], barriers: [] });

test('the observed Kensington row retains its thirteen City inventory locations and collision envelopes', () => {
  assert.equal(sourceRow.length, 13);
  const prepared = prepareStreetDetails(fixture(sourceRow), { groundHeight: () => 0.31 });
  const fallback = prepareStreetDetails(
    fixture(sourceRow.map((row) => ({ ...row, assetCode: 'UNREVIEWED' }))),
    { groundHeight: () => 0.31 },
  );
  assert.deepEqual(prepared.colliders, fallback.colliders);
  assert.deepEqual(prepared.skipped, fallback.skipped);
  assert.equal(prepared.records.length, sourceRow.length);
  for (let i = 0; i < prepared.records.length; i++) {
    const actual = prepared.records[i];
    const source = sourceRow[i];
    assert.equal(actual.id, source.id);
    assert.equal(actual.x, source.x);
    assert.equal(actual.z, source.z);
    assert.equal(actual.baseY, 0.31);
    assert.equal(actual.profile.family, 'bollard-round');
    assert.equal(actual.geometryInferred, true);
    assert.equal(actual.finishInferred, true);
    assert.equal(actual.mountingHeightInferred, true);
    const { family: _family, tint: _tint, ...physical } = actual.profile;
    const { family: _oldFamily, tint: _oldTint, ...previousPhysical } = fallback.records[i].profile;
    assert.deepEqual(physical, previousPhysical);
  }
  const collision = createTreeCollision(prepared.colliders);
  const post = prepared.records[0];
  const body = { radius: 0.42, top: 1.9 };
  assert.equal(collision.blocked({ x: post.x, z: post.z, y: 0.31 }, body), true);
  assert.equal(collision.blocked({ x: post.x, z: post.z, y: -2 }, body), false);
  assert.equal(collision.blocked({ x: post.x, z: post.z, y: 1.3 }, body), false);
  const position = { x: post.x + 0.2, z: post.z, y: 0.31 };
  collision.resolve(position, body);
  assert.equal(collision.blocked(position, body), false);
  assert.ok(Math.hypot(position.x - post.x, position.z - post.z) < 1);
});

test('historical post appearance does not spread to other sites, materials or physical types', () => {
  const source = sourceRow[0];
  const variants = [
    {},
    { source: 'other-source' },
    { assetCode: 'HIL495' },
    { type: 'REMOVABLE' },
    { material: 'TIMBER' },
    { x: -1170 },
    { x: -1135 },
    { z: -740 },
    { z: -730 },
  ];
  for (const [index, variant] of variants.entries()) {
    const row = { ...source, ...variant };
    const prepared = prepareStreetDetails(fixture([row]));
    assert.equal(prepared.records.length, 1);
    assert.equal(prepared.records[0].profile.family, index ? 'bollard' : 'bollard-round');
  }
  const unrelated = prepareStreetDetails(
    fixture(inventory.records.filter((row) => row.assetCode !== 'HIL679')),
  );
  assert.equal(
    unrelated.records.some((row) => row.profile.family === 'bollard-round'),
    false,
  );
});

test('both post detail levels have a closed dark body and rounded top inside the existing collider', () => {
  const prototypes = createStreetDetailPrototypes();
  const material = new THREE.MeshBasicMaterial();
  try {
    for (const lod of ['fine', 'coarse']) {
      const geometry = prototypes[`bollard-round-${lod}`];
      for (const name of ['position', 'normal', 'color'])
        assert.ok(geometry.attributes[name].array.every(Number.isFinite));
      assert.equal(geometry.attributes.uv, undefined);
      assert.ok(Math.abs(geometry.boundingBox.min.y) < 1e-6);
      assert.ok(Math.abs(geometry.boundingBox.max.y - 1) < 1e-6);
      const positions = geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        assert.ok(Math.hypot(positions.getX(i), positions.getZ(i)) * 0.1 <= 0.11);
        assert.ok(positions.getY(i) * 0.95 <= 0.95 + 1e-6);
      }
      assert.ok(
        geometry.attributes.color.array.every((value) => value < 0.04),
        'no bright reflective bands',
      );
      const triangles = geometry.index.count / 3;
      assert.ok(triangles < prototypes[`bollard-${lod}`].index.count / 3);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0));
      const top = ray.intersectObject(mesh, false);
      assert.ok(top.length > 0);
      assert.ok(Math.abs(top[0].point.y - 1) < 1e-6);
      ray.set(new THREE.Vector3(0.9, 2, 0), new THREE.Vector3(0, -1, 0));
      const shoulder = ray.intersectObject(mesh, false);
      assert.ok(shoulder.length > 0);
      assert.ok(shoulder[0].point.y > 0.91 && shoulder[0].point.y < top[0].point.y);
      ray.set(new THREE.Vector3(2, 0.9, 0), new THREE.Vector3(-1, 0, 0));
      assert.ok(ray.intersectObject(mesh, false).length > 0);
    }
  } finally {
    for (const geometry of Object.values(prototypes)) geometry.dispose();
    material.dispose();
  }
});

test('nearby post variants keep bounded batches, shared resources and stationary updates', () => {
  const scene = new THREE.Scene();
  const details = createStreetDetails(scene, { data: inventory });
  const camera = { x: -1157, y: 2, z: -736 };
  try {
    for (const quality of ['low', 'balanced', 'high']) {
      details.prewarm(camera, quality);
      assert.ok(details.stats.liveAssets <= STREET_DETAIL_LIMITS[quality].assets);
      assert.ok(details.stats.liveTriangles <= STREET_DETAIL_LIMITS[quality].triangles);
      assert.ok(details.stats.drawCalls <= STREET_DETAIL_LIMITS.maxDraws);
      assert.equal(details.meshes.get('bollard-round-fine').count, 13);
      const passes = details.stats.selectionPasses;
      const writes = details.stats.instanceWrites;
      const versions = [...details.meshes.values()].map((mesh) => mesh.instanceMatrix.version);
      for (let i = 0; i < 60; i++) details.update(camera, quality);
      assert.equal(details.stats.selectionPasses, passes);
      assert.equal(details.stats.instanceWrites, writes);
      assert.deepEqual(
        [...details.meshes.values()].map((mesh) => mesh.instanceMatrix.version),
        versions,
      );
    }
    assert.equal(new Set([...details.meshes.values()].map((mesh) => mesh.material)).size, 1);
    assert.equal(details.stats.materials, 1);
    assert.equal(details.stats.textures, 0);
    assert.equal(details.stats.pointLights, 0);
    details.update({ ...camera, y: 1000 });
    assert.equal(details.stats.liveAssets, 0);
    assert.equal(details.stats.drawCalls, 0);
    assert.equal(
      scene.children.some((object) => object.isLight),
      false,
    );
  } finally {
    let disposedMaterials = 0;
    details.meshes
      .values()
      .next()
      .value.material.addEventListener('dispose', () => disposedMaterials++);
    details.dispose();
    details.dispose();
    assert.equal(disposedMaterials, 1);
    assert.equal(scene.children.length, 0);
  }
});
