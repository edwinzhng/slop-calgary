import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createCityMeshes } from '../app/city-meshes.js';
import { buildingProfile, decorateBuildingGeometry } from '../app/building-models.js';
import {
  observedBuildingMaterialZones,
  NINTH_AVENUE_MATERIAL_EVIDENCE as evidence,
  WORN_STUDIO_MATERIAL_EVIDENCE as wornEvidence,
} from '../app/observed-building-materials.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../data/calgary-meshes.json', import.meta.url)));
const binary = fs.readFileSync(new URL('../data/calgary-meshes.bin', import.meta.url));
const provider = createCityMeshes(manifest, binary);
const building = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))).buildings.find(
  (row) => row.id === evidence.buildingId,
);
const record = provider.get(building.id),
  profile = buildingProfile({ ...building, height: record.height });
const bytes = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
  sha = (array) => createHash('sha256').update(array).digest('hex');

test('9 Avenue observations bind to the exact compound shell and six photographed north-facing triangles', () => {
  assert.deepEqual(record.structureIds, evidence.structureIds);
  assert.equal(record.ground, evidence.sourceGround);
  const payload = binary.subarray(
    record.offset,
    record.offset + record.vertexCount * 6 + record.indexCount * record.indexBytes,
  );
  assert.equal(sha(payload), evidence.sourcePayloadSha256);
  const geometry = provider.createGeometry(building.id);
  try {
    assert.equal(sha(bytes(geometry.attributes.position.array)), evidence.positionSha256);
    assert.equal(sha(bytes(geometry.attributes.normal.array)), evidence.normalSha256);
    const observed = observedBuildingMaterialZones(geometry, building);
    assert.deepEqual(
      [...observed.triangleZones.keys()].sort((a, b) => a - b),
      [4, 5, 19, 20, 48, 49],
    );
    for (const [triangle] of observed.triangleZones) {
      for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
        const x = geometry.attributes.position.getX(i),
          z = geometry.attributes.position.getZ(i);
        assert.ok(x >= 2208.39 && x <= 2236.51 && z >= 316.2 && z <= 327.08);
        assert.ok(geometry.attributes.normal.getZ(i) < -0.93);
        assert.equal(geometry.attributes.normal.getY(i), 0);
      }
    }
  } finally {
    geometry.dispose();
  }
});

test('9 Avenue finishes retain every measured surface and hidden face while removing false opening grids', () => {
  const geometry = provider.createGeometry(building.id),
    baseline = geometry.clone(),
    positions = bytes(geometry.attributes.position.array).slice(),
    normals = bytes(geometry.attributes.normal.array).slice();
  try {
    const observed = observedBuildingMaterialZones(geometry, building);
    decorateBuildingGeometry(baseline, { ...building, id: 'unobserved' }, profile);
    decorateBuildingGeometry(geometry, building, profile);
    assert.deepEqual(bytes(geometry.attributes.position.array), positions);
    assert.deepEqual(bytes(geometry.attributes.normal.array), normals);
    assert.equal(geometry.index, null);
    assert.equal(geometry.attributes.position.count, 183);
    for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) {
      const triangle = Math.floor(vertex / 3),
        zone = observed.triangleZones.get(triangle);
      if (!zone) {
        for (const name of ['color', 'wallUV', 'buildingProfile']) {
          const actual = geometry.attributes[name],
            expected = baseline.attributes[name],
            start = vertex * actual.itemSize;
          assert.deepEqual(
            actual.array.subarray(start, start + actual.itemSize),
            expected.array.subarray(start, start + actual.itemSize),
            `${name} on unobserved triangle ${triangle}`,
          );
        }
      } else if (triangle === 19 || triangle === 20) {
        assert.equal(Math.round(geometry.attributes.buildingProfile.getX(vertex) * 7), 7);
        assert.ok(
          geometry.attributes.wallUV.getY(vertex) >= 5,
          'authored arches replace every generic brick bay',
        );
      } else {
        assert.equal(Math.round(geometry.attributes.buildingProfile.getX(vertex) * 7), 5);
        assert.ok(geometry.attributes.wallUV.getY(vertex) > 2.4, 'windowless style cannot draw garage doors');
      }
    }
    assert.ok(geometry.attributes.wallUV.array.every(Number.isFinite));
    assert.equal(geometry.userData.materialEvidence.geometricChanges, false);
    assert.equal(geometry.userData.materialEvidence.hiddenSidesObserved, false);
    assert.equal(geometry.userData.materialEvidence.observedFaceTriangles, 6);
  } finally {
    geometry.dispose();
    baseline.dispose();
  }
});

test('9 Avenue observations expire on compound ownership, geometry, normals or ground changes', () => {
  const mutations = [
    (g) => g.attributes.position.setX(0, g.attributes.position.getX(0) + 0.01),
    (g) => g.attributes.normal.setX(0, g.attributes.normal.getX(0) + 0.01),
    (g) => g.setIndex([0, 1, 2]),
    (g) => {
      g.userData.cityMesh.id = 'other';
    },
    (g) => {
      g.userData.cityMesh.structureIds = [...record.structureIds].reverse();
    },
    (g) => {
      g.userData.cityMesh.structureIds = record.structureIds.slice(0, 3);
    },
    (g) => {
      g.userData.cityMesh.structureIds = [...record.structureIds, 1];
    },
    (g) => {
      g.userData.cityMesh.structureIds = 'xxxx';
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
});

const wornBuilding = JSON.parse(
    fs.readFileSync(new URL('../data/calgary.json', import.meta.url)),
  ).buildings.find((row) => row.id === wornEvidence.buildingId),
  wornRecord = provider.get(wornBuilding.id),
  wornProfile = buildingProfile(
    { ...wornBuilding, height: wornRecord.height },
    { kind: 'commercial', levels: 2.5 },
  );

test('915 observations pin the separate City owner, source date and exact north-wall payload', () => {
  const geometry = provider.createGeometry(wornBuilding.id),
    second = provider.createGeometry(wornBuilding.id);
  try {
    assert.deepEqual(wornRecord.structureIds, [1376632]);
    assert.deepEqual(wornRecord.sourceDates, [wornEvidence.sourceRecordDate]);
    assert.equal(wornRecord.ground, wornEvidence.sourceGround);
    assert.equal(
      sha(
        binary.subarray(
          wornRecord.offset,
          wornRecord.offset + wornRecord.vertexCount * 6 + wornRecord.indexCount * wornRecord.indexBytes,
        ),
      ),
      wornEvidence.sourcePayloadSha256,
    );
    assert.equal(sha(bytes(geometry.attributes.position.array)), wornEvidence.positionSha256);
    assert.equal(sha(bytes(geometry.attributes.normal.array)), wornEvidence.normalSha256);
    const observed = observedBuildingMaterialZones(geometry, wornBuilding),
      position = geometry.attributes.position;
    assert.equal(observed.evidence, wornEvidence);
    assert.deepEqual([...observed.triangleZones.keys()], [6, 7]);
    assert.equal(position.count, 39);
    for (const triangle of [6, 7])
      for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
        assert.ok(position.getX(i) >= 2197.5 && position.getX(i) <= 2207.42);
        assert.ok(position.getZ(i) >= 312.38 && position.getZ(i) <= 316.221);
        assert.equal(geometry.attributes.normal.getY(i), 0);
        assert.ok(geometry.attributes.normal.getZ(i) < -0.9325);
      }
    assert.notEqual(geometry.userData.cityMesh.sourceDates, wornRecord.sourceDates);
    geometry.userData.cityMesh.sourceDates[0] = '2024-08-01';
    assert.deepEqual(wornRecord.sourceDates, ['2013-06-10']);
    assert.deepEqual(second.userData.cityMesh.sourceDates, ['2013-06-10']);
    assert.equal(observedBuildingMaterialZones(geometry, wornBuilding), null);
    assert.equal(observedBuildingMaterialZones(second, wornBuilding).evidence, wornEvidence);
  } finally {
    geometry.dispose();
    second.dispose();
  }
});

test('915 pale paint removes only its north opening grid and preserves every measured surface and hidden attribute', () => {
  const geometry = provider.createGeometry(wornBuilding.id),
    baseline = geometry.clone(),
    positions = bytes(geometry.attributes.position.array).slice(),
    normals = bytes(geometry.attributes.normal.array).slice();
  try {
    decorateBuildingGeometry(baseline, { ...wornBuilding, id: 'unobserved' }, wornProfile);
    decorateBuildingGeometry(geometry, wornBuilding, wornProfile);
    assert.deepEqual(bytes(geometry.attributes.position.array), positions);
    assert.deepEqual(bytes(geometry.attributes.normal.array), normals);
    assert.equal(geometry.index, null);
    const selected = new Set([6, 7]);
    for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) {
      if (selected.has(Math.floor(vertex / 3))) {
        assert.equal(Math.round(geometry.attributes.buildingProfile.getX(vertex) * 7), 5);
        assert.ok(geometry.attributes.wallUV.getY(vertex) > 2.4, 'no inferred garage door on buried wall');
        assert.notDeepEqual(
          geometry.attributes.color.array.subarray(vertex * 4, vertex * 4 + 3),
          baseline.attributes.color.array.subarray(vertex * 4, vertex * 4 + 3),
        );
      } else {
        for (const name of ['color', 'wallUV', 'buildingProfile']) {
          const actual = geometry.attributes[name],
            expected = baseline.attributes[name],
            offset = vertex * actual.itemSize;
          assert.deepEqual(
            actual.array.subarray(offset, offset + actual.itemSize),
            expected.array.subarray(offset, offset + actual.itemSize),
            `${name} on unobserved 915 triangle ${Math.floor(vertex / 3)}`,
          );
        }
      }
    }
    assert.ok(geometry.attributes.wallUV.array.every(Number.isFinite));
    assert.equal(geometry.userData.materialEvidence.observedFaceTriangles, 2);
    assert.equal(geometry.userData.materialEvidence.geometricChanges, false);
    assert.equal(geometry.userData.materialEvidence.hiddenSidesObserved, false);
  } finally {
    geometry.dispose();
    baseline.dispose();
  }
});

test('915 observations reject changed geometry, owners, ground and missing or changed source dates independently', () => {
  const mutations = [
    (g) => g.attributes.position.setX(0, g.attributes.position.getX(0) + 0.01),
    (g) => g.attributes.normal.setZ(0, g.attributes.normal.getZ(0) + 0.01),
    (g) => g.setIndex([0, 1, 2]),
    (g) => (g.userData.cityMesh.id = evidence.buildingId),
    (g) => (g.userData.cityMesh.structureIds = [1524002]),
    (g) => (g.userData.cityMesh.structureIds = [1376632, 1524002]),
    (g) => (g.userData.cityMesh.ground += 0.01),
    (g) => delete g.userData.cityMesh.sourceDates,
    (g) => (g.userData.cityMesh.sourceDates = []),
    (g) => (g.userData.cityMesh.sourceDates = '2013-06-10'),
    (g) => (g.userData.cityMesh.sourceDates = ['2013-06-11']),
    (g) => (g.userData.cityMesh.sourceDates = ['2013-06-10', '2013-06-10']),
  ];
  for (const mutate of mutations) {
    const geometry = provider.createGeometry(wornBuilding.id);
    try {
      mutate(geometry);
      assert.equal(observedBuildingMaterialZones(geometry, wornBuilding), null);
    } finally {
      geometry.dispose();
    }
  }
  const compound = provider.createGeometry(building.id);
  try {
    compound.userData.cityMesh.sourceDates = [];
    assert.equal(
      observedBuildingMaterialZones(compound, building).evidence,
      evidence,
      'existing compound contract stays independent',
    );
  } finally {
    compound.dispose();
  }
});
