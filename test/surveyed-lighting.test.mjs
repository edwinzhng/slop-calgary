import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import {
  prepareSurveyedLights,
  createSurveyedLighting,
  createLightingPrototypes,
  SURVEYED_LIGHTING_LIMITS,
} from '../app/surveyed-lighting.js';
import { createTreeCollision } from '../app/tree-collision.js';
import {
  createStreetLightWash,
  streetLightFootprint,
  updateVehicleHeadlightWash,
  vehicleHeadlightLevel,
} from '../app/street-light-wash.js';

const inventory = JSON.parse(await readFile(new URL('../data/calgary-lighting.json', import.meta.url)));
const row = (id, x, z, type) => ({ id, x, z, type, heading: 0 });

test('vehicle lighting admits the player and three nearby cars only in low visibility', () => {
  const camera = { position: { y: 3 } },
    player = { x: 0, y: 0.2, z: 0, heading: 0 },
    traffic = [8, 15, 21, 33, 46, 82].map((cameraDistance) => ({
      ...player,
      x: cameraDistance,
      cameraDistance,
    }));
  assert.equal(vehicleHeadlightLevel(0.06, 0), 0);
  assert.equal(vehicleHeadlightLevel(0, 0.58), 0.58);
  assert.ok(vehicleHeadlightLevel(0.8, 0) > 0);
  assert.equal(vehicleHeadlightLevel(1.8, 0), 1);
  assert.equal(updateVehicleHeadlightWash(player, traffic, 1, camera), 4);
  assert.equal(updateVehicleHeadlightWash({ ...player, mode: 'cycle' }, traffic, 1, camera, 0.3), 4);
  assert.equal(updateVehicleHeadlightWash(null, traffic, 1, camera), 3);
  assert.equal(updateVehicleHeadlightWash(player, traffic, 0, camera), 0);
  assert.equal(
    updateVehicleHeadlightWash(null, [{ ...traffic[0], y: 31 }, ...traffic.slice(-1)], 1, camera),
    0,
  );
});

test('streetlight wash tracks the surveyed mount and updates only when needed at night', () => {
  const source = {
    types: { road: { category: 'cobrahead' }, inset: { category: 'ground' } },
    records: [row('lamp', 14, 10, 'road'), row('inset', 18, 10, 'inset')],
  };
  const prepared = prepareSurveyedLights(source, { groundHeight: () => 7 });
  const [head, ground] = prepared.records;
  const footprint = streetLightFootprint(head);
  assert.equal(footprint.y, 7);
  assert.equal(footprint.x, 14);
  assert.ok(footprint.z > head.z);
  assert.equal(streetLightFootprint(ground), null);
  const lighting = createStreetLightWash(prepared.records);
  const camera = { position: { x: 14, y: 9, z: 10 } };
  lighting.update(camera, 0);
  assert.equal(lighting.stats.updates, 0);
  lighting.update(camera, 1.8);
  assert.equal(lighting.stats.active, 1);
  assert.equal(lighting.stats.updates, 1);
  camera.position.x += 4;
  lighting.update(camera, 1.8);
  assert.equal(lighting.stats.updates, 1);
  camera.position.x += 500;
  lighting.update(camera, 1.8);
  assert.equal(lighting.stats.active, 0);
  assert.equal(lighting.stats.updates, 2);
});

test('dimensioned Galleon configurations require a complete known inventory model', () => {
  const prepared = prepareSurveyedLights(inventory);
  const counts = {};
  for (const record of prepared.records) {
    const expected = { MF: 'galleon-2', ON: 'galleon-2', QK: 'galleon-4' }[record.type];
    if (expected) {
      assert.equal(record.kind, expected);
      counts[record.type] = (counts[record.type] || 0) + 1;
    } else {
      assert.ok(!record.kind.startsWith('galleon-'), record.id);
    }
    if (['SF', 'SK'].includes(record.type)) assert.equal(record.kind, 'cobra');
  }
  assert.deepEqual(counts, { QK: 2, MF: 54, ON: 1 });
  const source = {
    types: {
      known: inventory.types.MF,
      incomplete: { ...inventory.types.MF, description: 'Galleon LED Shoebox' },
      different: { ...inventory.types.MF, description: 'LED Shoebox (RSX1-P1-30K-R2-PER7)' },
      missing: { category: 'cobrahead' },
    },
    records: ['known', 'incomplete', 'different', 'missing'].map((type, i) => row(type, i * 10, 0, type)),
  };
  assert.deepEqual(
    prepareSurveyedLights(source).records.map((record) => record.kind),
    ['galleon-2', 'cobra', 'cobra', 'cobra'],
  );
});

test('fixture selection preserves support contact, clustered heads and pole collision heights', () => {
  const groundHeight = (_x, z) => 3 + z * 0.25;
  const makeSource = (type) => ({
    types: { fixture: type },
    records: [row('bank', 0, 0, 'fixture'), row('a', 10, 0, 'fixture'), row('b', 10, 0, 'fixture')],
  });
  const types = inventory.types.MF;
  const rectangular = prepareSurveyedLights(makeSource(types), { groundHeight });
  const rounded = prepareSurveyedLights(makeSource({ ...types, description: 'Legacy rounded cobrahead' }), {
    groundHeight,
  });
  assert.deepEqual(rectangular.supports, rounded.supports);
  for (let i = 0; i < rectangular.records.length; i++) {
    const { kind: a, ...actual } = rectangular.records[i];
    const { kind: b, ...expected } = rounded.records[i];
    assert.equal(a, 'galleon-2');
    assert.equal(b, 'cobra');
    assert.deepEqual(actual, expected);
  }
  assert.equal(rectangular.supports[0].baseY, 2.6);
  assert.equal(rectangular.supports.length, 2);
  assert.equal(rectangular.supports[1].sourceIds.length, 2);
  const collision = createTreeCollision(rectangular.supports);
  const body = { radius: 0.42, top: 1.9 };
  assert.equal(collision.blocked({ x: 0, y: 3, z: -1.6 }, body), true);
  assert.equal(collision.blocked({ x: 0, y: 0.2, z: -1.6 }, body), false);
  assert.equal(collision.blocked({ x: 0, y: 20, z: -1.6 }, body), false);
  assert.equal(rectangular.covers(0, 0, 0), true);
  assert.equal(rectangular.covers(0, 31, 30), false);
});

test('rectangular cases fit catalogue dimensions with distinct downward light squares', () => {
  const prototypes = createLightingPrototypes();
  try {
    for (const [kind, geometry] of Object.entries(prototypes)) {
      for (const name of ['position', 'normal', 'color', 'lampEmission'])
        assert.ok(geometry.attributes[name].array.every(Number.isFinite), `${kind}: ${name}`);
    }
    for (const squares of [2, 4]) {
      const geometry = prototypes[`galleon-${squares}`];
      const dimensions = geometry.boundingBox.getSize(new THREE.Vector3());
      assert.ok(Math.abs(dimensions.x - 0.394) < 1e-6);
      assert.ok(Math.abs(dimensions.y - 0.1) < 1e-6);
      assert.ok(Math.abs(dimensions.z - 0.553) < 1e-6);
      assert.ok(geometry.index.count / 3 < prototypes.cobra.index.count / 3);
      const normals = geometry.attributes.normal;
      for (let i = 0; i < normals.count; i++)
        assert.ok(Math.abs(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) - 1) < 1e-6);
      const positions = geometry.attributes.position;
      const mask = geometry.attributes.lampEmission;
      const horizontalIntervals = new Set();
      for (let i = 0; i < positions.count; i++) {
        if (!mask.getX(i)) continue;
        assert.ok(positions.getY(i) < 0, 'unlit top and side housing');
        horizontalIntervals.add(`${positions.getX(i).toFixed(6)},${positions.getZ(i).toFixed(6)}`);
      }
      assert.equal(horizontalIntervals.size, squares * 4, 'independent separated square lenses');
      assert.equal(geometry.attributes.uv, undefined);
    }
  } finally {
    for (const geometry of Object.values(prototypes)) geometry.dispose();
  }
});

test('mixed nearby heads stay bounded without stationary uploads, new lights or textures', () => {
  const types = {
    two: inventory.types.MF,
    four: inventory.types.QK,
    road: { category: 'cobrahead' },
    globe: { category: 'globe' },
    post: { category: 'post' },
    ground: { category: 'ground' },
    bollard: { category: 'bollard' },
  };
  const kinds = Object.keys(types);
  const data = {
    types,
    records: Array.from({ length: 700 }, (_, i) =>
      row(String(i), (i % 35) * 4, Math.floor(i / 35) * 4, kinds[i % kinds.length]),
    ),
  };
  const scene = new THREE.Scene();
  const lighting = createSurveyedLighting(scene, { data });
  try {
    for (const quality of ['low', 'balanced', 'high']) {
      lighting.update({ x: 60, y: 2, z: 40 }, quality);
      assert.equal(lighting.stats.activeHeads, SURVEYED_LIGHTING_LIMITS[quality].heads);
      assert.ok(lighting.stats.draws <= SURVEYED_LIGHTING_LIMITS.maxDraws);
      assert.ok(lighting.stats.activeInstances <= lighting.stats.activeHeads * 4);
      assert.ok(lighting.stats.activeTriangles < 300000);
      assert.equal(lighting.stats.materials, 1);
      assert.equal(lighting.stats.pointLights, 0);
      assert.equal(lighting.stats.runtimeTextures, 0);
      const rebuilds = lighting.stats.rebuilds;
      const versions = lighting.meshes.map((mesh) => mesh.instanceMatrix.version);
      for (let i = 0; i < 60; i++) lighting.update({ x: 60, y: 2, z: 40 }, quality);
      assert.equal(lighting.stats.rebuilds, rebuilds);
      assert.deepEqual(
        lighting.meshes.map((mesh) => mesh.instanceMatrix.version),
        versions,
      );
      for (const mesh of lighting.meshes) {
        assert.equal(mesh.material, lighting.material);
        assert.ok(mesh.geometry.attributes.lampTint.isInstancedBufferAttribute);
        assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
      }
    }
    lighting.update({ x: 60, y: 1000, z: 40 }, 'high');
    assert.equal(lighting.stats.activeHeads, 0);
    assert.equal(lighting.stats.draws, 0);
    assert.equal(
      scene.children.some((object) => object.isLight),
      false,
    );
    assert.equal(lighting.colliders.length, lighting.supports.length);
  } finally {
    let disposedGeometries = 0;
    let disposedMaterials = 0;
    for (const mesh of lighting.meshes) mesh.geometry.addEventListener('dispose', () => disposedGeometries++);
    lighting.material.addEventListener('dispose', () => disposedMaterials++);
    lighting.dispose();
    lighting.dispose();
    assert.equal(disposedGeometries, lighting.meshes.length);
    assert.equal(disposedMaterials, 1);
    assert.equal(scene.children.length, 0);
  }
});
