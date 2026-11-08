import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createCityMeshes } from '../app/city-meshes.js';
import { buildingProfile, decorateBuildingGeometry } from '../app/building-models.js';
import {
  observedBuildingMaterialZones,
  POINTE_MATERIAL_EVIDENCE,
} from '../app/observed-building-materials.js';

const evidence = POINTE_MATERIAL_EVIDENCE;
const manifest = JSON.parse(fs.readFileSync(new URL('../data/calgary-meshes.json', import.meta.url)));
const binary = fs.readFileSync(new URL('../data/calgary-meshes.bin', import.meta.url));
const provider = createCityMeshes(manifest, binary);
const building = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))).buildings.find(
  (row) => row.id === evidence.buildingId,
);
const record = provider.get(building.id);
const profile = buildingProfile({ ...building, height: record.height });
const bytes = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
const sha = (array) => createHash('sha256').update(array).digest('hex');

test('Evolution and Concord source finish zones keep their measured shells and finite wall coordinates', () => {
  for (const id of ['city-outline-28510-0', 'city-outline-28330-0']) {
    const record = provider.get(id);
    const target = { ...building, id, height: record.height };
    const geometry = provider.createGeometry(id);
    const positions = bytes(geometry.attributes.position.array).slice();
    try {
      decorateBuildingGeometry(geometry, target, buildingProfile(target));
      assert.ok(geometry.userData.materialEvidence.observedFaceTriangles > 200);
      assert.deepEqual(bytes(geometry.attributes.position.array), positions);
      assert.ok(geometry.attributes.wallUV.array.every(Number.isFinite));
    } finally {
      geometry.dispose();
    }
  }
});

test('Pointe material observations bind to the measured shell and only the photographed north/bay walls', () => {
  assert.equal(record.structureIds.length, 1);
  assert.equal(record.structureIds[0], evidence.structureId);
  assert.equal(record.ground, evidence.sourceGround);
  assert.equal(record.height, 10.8);
  const payload = binary.subarray(
    record.offset,
    record.offset + record.vertexCount * 6 + record.indexCount * record.indexBytes,
  );
  assert.equal(sha(payload), evidence.sourcePayloadSha256);
  const geometry = provider.createGeometry(building.id);
  try {
    assert.equal(sha(bytes(geometry.attributes.position.array)), evidence.positionSha256);
    assert.equal(sha(bytes(geometry.attributes.normal.array)), evidence.normalSha256);
    const observations = observedBuildingMaterialZones(geometry, building);
    assert.ok(observations);
    assert.equal(observations.triangleZones.size, 36);
    const normal = geometry.attributes.normal;
    const position = geometry.attributes.position;
    for (const [triangle, zone] of observations.triangleZones) {
      assert.ok(Math.abs(normal.getY(triangle * 3)) < 1e-6, 'no roof or sloped parapet faces');
      for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
        const x = position.getX(i),
          z = position.getZ(i);
        if (zone.style === 0) {
          assert.ok(x >= -1191.5 && x <= -1189.46);
          assert.ok(z >= -735.39 && z <= -731.93);
        } else {
          assert.ok(x >= -1209.62 && x <= -1191.48);
          assert.ok(z >= -735.55 && z <= -735.37);
          assert.ok(normal.getZ(i) < -0.99);
        }
      }
    }
  } finally {
    geometry.dispose();
  }
});

test('decoration changes selected attributes while retaining all source geometry and hidden-face attributes', () => {
  const geometry = provider.createGeometry(building.id);
  const baseline = geometry.clone();
  const position = bytes(geometry.attributes.position.array).slice();
  const normal = bytes(geometry.attributes.normal.array).slice();
  try {
    const observations = observedBuildingMaterialZones(geometry, building);
    decorateBuildingGeometry(baseline, { ...building, id: 'unobserved' }, profile);
    decorateBuildingGeometry(geometry, building, profile);
    assert.deepEqual(bytes(geometry.attributes.position.array), position);
    assert.deepEqual(bytes(geometry.attributes.normal.array), normal);
    assert.equal(geometry.index, null);
    assert.equal(geometry.attributes.position.count / 3, 153);
    for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) {
      const zone = observations.triangleZones.get(Math.floor(vertex / 3));
      if (!zone) {
        for (const name of ['color', 'wallUV', 'buildingProfile']) {
          const actual = geometry.attributes[name];
          const expected = baseline.attributes[name];
          const start = vertex * actual.itemSize;
          assert.deepEqual(
            actual.array.subarray(start, start + actual.itemSize),
            expected.array.subarray(start, start + actual.itemSize),
            `${name} on unobserved triangle ${Math.floor(vertex / 3)}`,
          );
        }
      } else {
        assert.equal(Math.round(geometry.attributes.buildingProfile.getX(vertex) * 7), zone.style);
      }
    }
    assert.equal(geometry.userData.materialEvidence.geometricChanges, false);
    assert.equal(geometry.userData.materialEvidence.hiddenSidesObserved, false);
    assert.equal(geometry.userData.materialEvidence.observedFaceTriangles, 36);
  } finally {
    geometry.dispose();
    baseline.dispose();
  }
});

test('glass coordinates follow the measured bay continuously across all seventeen facets', () => {
  const geometry = provider.createGeometry(building.id);
  try {
    decorateBuildingGeometry(geometry, building, profile);
    const positions = geometry.attributes.position,
      uv = geometry.attributes.wallUV;
    const shared = new Map();
    let previousEnd = 0;
    for (let triangle = 48; triangle <= 80; triangle += 2) {
      let start = Infinity,
        end = -Infinity;
      for (let vertex = triangle * 3; vertex < (triangle + 2) * 3; vertex++) {
        const u = uv.getX(vertex);
        const key = `${positions.getX(vertex)},${positions.getZ(vertex)}`;
        if (shared.has(key)) assert.ok(Math.abs(shared.get(key) - u) < 1e-6);
        else shared.set(key, u);
        assert.ok(Number.isFinite(u));
        start = Math.min(start, u);
        end = Math.max(end, u);
      }
      assert.ok(Math.abs(start - previousEnd) < 1e-6);
      assert.ok(end > start);
      previousEnd = end;
    }
    assert.equal(shared.size, 18);
    assert.ok(previousEnd > 5 && previousEnd < 7);
  } finally {
    geometry.dispose();
  }
});

test('source position, normal, topology or identity changes disable the observation', () => {
  const mutations = [
    (g) => g.attributes.position.setX(0, g.attributes.position.getX(0) + 0.01),
    (g) => g.attributes.normal.setX(0, g.attributes.normal.getX(0) + 0.01),
    (g) => g.setIndex([0, 1, 2]),
    (g) => {
      g.userData.cityMesh.id = 'other';
    },
    (g) => {
      g.userData.cityMesh.structureIds = [0];
    },
    (g) => {
      g.userData.cityMesh.ground += 0.01;
    },
  ];
  for (const mutate of mutations) {
    const geometry = provider.createGeometry(building.id);
    try {
      mutate(geometry);
      assert.equal(observedBuildingMaterialZones(geometry, building), null);
    } finally {
      geometry.dispose();
    }
  }
  const geometry = provider.createGeometry(building.id);
  try {
    assert.equal(observedBuildingMaterialZones(geometry, { ...building, id: 'other' }), null);
  } finally {
    geometry.dispose();
  }
});
