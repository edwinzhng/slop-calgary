import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createParkingBoxBatch } from '../app/parking-box-batch.js';
import { createIslandTerrain } from '../app/island-terrain.js';
import { createGroundSurfaces, parkingLayout } from '../app/ground-surfaces.js';

function original(boxes, terrain) {
  const geometries = boxes.map(([width, height, depth, angle, x, y, z]) => {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.rotateY(angle);
    geometry.translate(x, y, z);
    return terrain?.drapeGeometry(geometry, 2) || geometry;
  });
  const result = mergeGeometries(geometries, false);
  geometries.forEach((g) => g.dispose());
  return result;
}
function packed(boxes, terrain) {
  const batch = createParkingBoxBatch(terrain);
  for (const box of boxes) batch.add(...box);
  assert.equal(batch.length, boxes.length);
  return batch.finish();
}
function bytes(attribute) {
  const a = attribute.array;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}
function sameGeometry(actual, expected) {
  assert.deepEqual(Object.keys(actual.attributes).sort(), Object.keys(expected.attributes).sort());
  assert.equal(actual.index?.array.constructor, expected.index?.array.constructor);
  assert.deepEqual(bytes(actual.index), bytes(expected.index));
  for (const name of Object.keys(expected.attributes)) {
    assert.equal(actual.attributes[name].itemSize, expected.attributes[name].itemSize);
    assert.equal(actual.attributes[name].normalized, expected.attributes[name].normalized);
    assert.deepEqual(bytes(actual.attributes[name]), bytes(expected.attributes[name]), name);
  }
  assert.deepEqual(actual.groups, [], 'the original merge drops individual box face groups');
}

test('packed parking boxes preserve all drawn bytes through both Float32 transforms', () => {
  const boxes = [];
  for (const angle of [0, -0, 1e-12, -1e-12, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI, 2.3])
    for (const [x, z] of [
      [0, 0],
      [-1975.12345, 2186.89421],
      [999999.123, -999998.899],
    ])
      for (const [width, height, depth] of [
        [2.7, 0.008, 0.075],
        [5.10000001, 0.008, 0.075],
        [1.6, 0.11, 0.15],
      ])
        boxes.push([width, height, depth, angle, x, 0.162, z]);
  const actual = packed(boxes),
    expected = original(boxes);
  try {
    sameGeometry(actual, expected);
  } finally {
    actual.dispose();
    expected.dispose();
  }
});

test('per-box terrain boundaries, subdivision, normals and UVs match the original drape path', () => {
  const manifest = {
    grids: [
      {
        id: 'curved',
        byteOffset: 0,
        width: 9,
        height: 9,
        step: 2,
        origin: { x: -8, z: -8 },
        bounds: [-8, -8, 8, 8],
        maximumOffset: 3,
      },
    ],
  };
  const samples = Float32Array.from(
    { length: 81 },
    (_, i) => Math.sin(i % 9) * 0.12 + (Math.floor(i / 9) - 4) ** 2 * 0.11,
  );
  const a = createIslandTerrain(manifest, samples.buffer.slice(0)),
    b = createIslandTerrain(manifest, samples.buffer.slice(0));
  const boxes = [
    [5.1, 0.008, 0.075, 0.14, -20, 0.162, 0],
    [5.1, 0.008, 0.075, 0.4, -8, 0.162, 0],
    [5.1, 0.008, 0.075, 2.3, 0, 0.162, 0],
    [1.6, 0.11, 0.15, -Math.PI, 8, 0.215, 8],
    [2.5, 0.008, 0.075, -0.37, 20, 0.162, 0],
  ];
  const actual = packed(boxes, a),
    expected = original(boxes, b);
  try {
    sameGeometry(actual, expected);
    assert.equal(a.stats.drapedGeometries, b.stats.drapedGeometries);
    assert.equal(a.stats.addedTriangles, b.stats.addedTriangles);
    assert.ok(a.stats.addedTriangles > 0, 'curved terrain exercises actual subdivision');
    assert.ok(a.stats.drapedGeometries < boxes.length, 'outside boxes keep their original topology');
  } finally {
    actual.dispose();
    expected.dispose();
  }
});

test('index promotion retains Three’s reserved 65535 restart index and independent batch ownership', () => {
  for (const count of [2730, 2731]) {
    const boxes = Array.from({ length: count }, (_, i) => [2.5, 0.008, 0.075, i * 0.017, i * 2.7, 0.162, -i]);
    const actual = packed(boxes),
      expected = original(boxes);
    try {
      sameGeometry(actual, expected);
      assert.equal(actual.index.array.constructor, count === 2730 ? Uint16Array : Uint32Array);
      const saved = bytes(actual.attributes.position).slice();
      const unrelated = packed([[1.6, 0.11, 0.15, Math.PI, -100, 0.215, 90]]);
      unrelated.dispose();
      assert.deepEqual(bytes(actual.attributes.position), saved);
    } finally {
      actual.dispose();
      expected.dispose();
    }
  }
  assert.equal(createParkingBoxBatch().finish(), null);
});

test('parking rebuilds retain blocker/water exclusions, global car caps, two paint draws and aerial clearing', () => {
  const surfaces = Array.from({ length: 6 }, (_, i) => {
    const x = i * 42 - 64,
      z = 0;
    return {
      id: `lot-${i}`,
      kind: 'Parking',
      material: 'Pavement',
      ring: [
        [x, z],
        [x + 38, z],
        [x + 38, z + 36],
        [x, z + 36],
        [x, z],
      ],
    };
  });
  const excluded = parkingLayout(surfaces[0])[1],
    water = parkingLayout(surfaces[1])[2];
  const blocker = {
    ring: [
      [excluded.x - 1, excluded.z - 1],
      [excluded.x + 1, excluded.z - 1],
      [excluded.x + 1, excluded.z + 1],
      [excluded.x - 1, excluded.z + 1],
      [excluded.x - 1, excluded.z - 1],
    ],
  };
  const scene = new THREE.Scene();
  const context = {
    roadIndex: {
      segments: surfaces.slice(0, 5).map(({ ring: [[x, z]] }) => ({
        a: [x + 4, z + 18],
        b: [x + 34, z + 18],
        road: { sourceTags: { service: 'parking_aisle' } },
      })),
    },
    buildingIndex: { near: () => new Set([blocker]) },
    inWater: (x, z) => Math.hypot(x - water.x, z - water.z) < 0.1,
  };
  const paving = createGroundSurfaces(scene, { surfaces }, context);
  assert.equal(paving.stats.parkingAreas, 5, 'unverified paving must not be marked as parking');
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 2, 15);
  const carMeshes = () => scene.children.filter((o) => o.isInstancedMesh);
  const paintMeshes = () =>
    scene.children.filter((o) =>
      ['Inferred parking stall markings', 'Inferred concrete wheel stops'].includes(o.name),
    );
  try {
    for (const [quality, cap] of [
      ['balanced', 22],
      ['high', 40],
    ]) {
      paving.update(camera, quality);
      assert.equal(paving.stats.parkedCars, cap);
      assert.equal(
        carMeshes().reduce((n, m) => n + m.count, 0),
        cap,
      );
      assert.equal(
        paving.stats.liveParkingBays,
        surfaces.slice(0, 5).reduce((n, s) => n + parkingLayout(s).length, 0) - 2,
      );
      assert.equal(paintMeshes().length, 2);
      for (const mesh of carMeshes())
        for (let i = 0; i < mesh.count; i++) {
          const at = i * 16,
            a = mesh.instanceMatrix.array;
          for (const p of [excluded, water]) assert.ok(Math.hypot(a[at + 12] - p.x, a[at + 14] - p.z) > 0.1);
        }
    }
    camera.position.y = 200;
    paving.update(camera, 'high');
    assert.equal(paintMeshes().length, 0);
    assert.equal(paving.stats.parkedCars, 0);
    assert.equal(
      carMeshes().reduce((n, m) => n + m.count, 0),
      0,
    );
  } finally {
    scene.traverse((o) => {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose();
    });
    scene.clear();
  }
});
