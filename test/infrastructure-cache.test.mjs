import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { InfrastructureCache, mergeInfrastructureStreams } from '../app/infrastructure-cache.js';
import { buildInfrastructure, INFRASTRUCTURE_LIMITS } from '../app/infrastructure.js';

const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

function equalGeometry(actual, expected) {
  assert.deepEqual(Object.keys(actual.attributes), Object.keys(expected.attributes));
  for (const [name, attribute] of Object.entries(actual.attributes)) {
    const reference = expected.getAttribute(name);
    assert.equal(attribute.constructor, reference.constructor, name);
    assert.deepEqual(
      [attribute.itemSize, attribute.normalized, attribute.usage, attribute.gpuType],
      [reference.itemSize, reference.normalized, reference.usage, reference.gpuType],
      name,
    );
    assert.deepEqual(bytes(attribute.array), bytes(reference.array), name);
  }
  assert.equal(actual.index, expected.index);
  assert.deepEqual(actual.groups, expected.groups);
  assert.deepEqual(actual.drawRange, expected.drawRange);
  assert.deepEqual(actual.boundingBox, expected.boundingBox);
  assert.deepEqual(actual.boundingSphere, expected.boundingSphere);
}

test('primitive assembly preserves complete ordered Float32 rows and owns its output', () => {
  const pieces = [
      {
        positions: [-0, 0, 0, 1 / 3, 0, 0, 0, 1 / 7, 0],
        normals: [-0, 0, 1, -0, 0, 1, -0, 0, 1],
        colors: [0.123456789, 0.2, 0.3, 0.123456789, 0.2, 0.3, 0.123456789, 0.2, 0.3],
      },
      {
        positions: [-4000.0001, 1.15, 1500.1, -3999.9, 1.15, 1500.1, -4000.0001, 2, 1500.1],
        normals: [0, -0, 1, 0, -0, 1, 0, -0, 1],
        colors: [1, 0, -0, 1, 0, -0, 1, 0, -0],
      },
    ],
    streams = pieces.map((piece) =>
      Object.fromEntries(Object.entries(piece).map(([name, values]) => [name, new Float32Array(values)])),
    ),
    empty = { positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array() },
    expected = new THREE.BufferGeometry();
  for (const [name, field] of [
    ['position', 'positions'],
    ['normal', 'normals'],
    ['color', 'colors'],
  ])
    expected.setAttribute(
      name,
      new THREE.Float32BufferAttribute(
        pieces.flatMap((p) => p[field]),
        3,
      ),
    );
  expected.computeBoundingSphere();
  expected.computeBoundingBox();
  const actual = mergeInfrastructureStreams([streams[0], empty, streams[1]]);
  equalGeometry(actual, expected);
  actual.attributes.position.array[0] = 2;
  assert.equal(Object.is(streams[0].positions[0], -0), true);
  actual.dispose();
  expected.dispose();
  assert.equal(mergeInfrastructureStreams([empty]), null);
  assert.equal(mergeInfrastructureStreams([]), null);
});

test('cache bounds account for bytes, empty entries, identity and transferred ownership', () => {
  const disposed = [],
    cache = new InfrastructureCache(10, 2, (value) => disposed.push(value)),
    a = { id: 'duplicate' },
    b = { id: 'duplicate' },
    c = {};
  assert.equal(cache.set(a, 'a', 4), true);
  assert.equal(cache.set(b, 'b', 4), true);
  assert.equal(cache.get(a), 'a');
  cache.set(c, 'c', 4);
  assert.deepEqual(disposed, ['b']);
  assert.equal(cache.get(b), undefined);
  assert.equal(cache.take(a), 'a');
  assert.equal(cache.get(a), undefined);
  assert.deepEqual(disposed, ['b'], 'taking transfers ownership without disposing it');
  cache.set(b, 'large', 9);
  assert.deepEqual(disposed, ['b', 'c']);
  assert.equal(cache.set(a, 'oversize', 11), false);
  assert.deepEqual(disposed, ['b', 'c'], 'the caller retains an unaccepted value');
  cache.set(a, 'empty-a', 0);
  cache.set(c, 'empty-c', 0);
  assert.deepEqual(disposed, ['b', 'c', 'large']);
  assert.equal(cache.stats.entries, 2);
  assert.equal(cache.stats.bytes, 0);
  cache.clear();
  cache.clear();
  assert.deepEqual(disposed, ['b', 'c', 'large', 'empty-a', 'empty-c']);
  assert.equal(cache.stats.entries, 0);
});

function streetFixture() {
  const coordinates = [-900, -600, -300, 0, 300, 600, 900],
    roads = [];
  for (const z of coordinates.slice(1, -1))
    roads.push({
      id: `east-${z}`,
      name: 'Test Avenue',
      kind: 'secondary',
      points: coordinates.map((x) => [x, z]),
    });
  for (const x of coordinates.slice(1, -1))
    roads.push({
      id: `north-${x}`,
      name: 'Test Street',
      kind: 'primary',
      points: coordinates.map((z) => [x, z]),
    });
  return { roads, rails: [], buildings: [], parks: [], waters: [] };
}

function equalMesh(actual, expected) {
  assert.equal(!!actual, !!expected);
  if (!actual) return;
  equalGeometry(actual.geometry, expected.geometry);
  for (const property of [
    'name',
    'castShadow',
    'receiveShadow',
    'frustumCulled',
    'matrixAutoUpdate',
    'matrixWorldAutoUpdate',
    'renderOrder',
  ])
    assert.equal(actual[property], expected[property], property);
  for (const property of ['side', 'transparent', 'depthTest', 'depthWrite', 'vertexColors'])
    assert.equal(actual.material[property], expected.material[property], property);
  assert.deepEqual(actual.matrix.elements, expected.matrix.elements);
  assert.deepEqual(actual.matrixWorld.elements, expected.matrixWorld.elements);
}

function equalNearby(actual, expected, scene, referenceScene) {
  for (const name of [
    'Nearby benches, bins, cycle racks and street lamps',
    'Nearby traffic-signal poles, mast arms and pedestrian heads',
  ])
    equalMesh(scene.getObjectByName(name), referenceScene.getObjectByName(name));
  const actualKeys = [...actual.tiles].filter(([, tile]) => tile.detail).map(([key]) => key),
    expectedKeys = [...expected.tiles].filter(([, tile]) => tile.detail).map(([key]) => key);
  assert.deepEqual(actualKeys, expectedKeys);
  for (const key of actualKeys) {
    equalMesh(actual.tiles.get(key).detail, expected.tiles.get(key).detail);
    assert.equal(actual.tiles.get(key).connectionTriangles, expected.tiles.get(key).connectionTriangles);
  }
  assert.deepEqual(actual.stats, expected.stats);
}

test('overlapping cold selections and revisits retain exact geometry, phases and disposal', () => {
  const data = streetFixture(),
    scene = new THREE.Scene(),
    infrastructure = buildInfrastructure(scene, data),
    camera = new THREE.PerspectiveCamera(),
    geometries = new Map();
  function trackGeometries() {
    scene.traverse((object) => {
      const geometry = object.geometry;
      if (!geometry || geometries.has(geometry)) return;
      geometries.set(geometry, 0);
      geometry.addEventListener('dispose', () => geometries.set(geometry, geometries.get(geometry) + 1));
    });
  }
  trackGeometries();
  assert.deepEqual([...new Set(infrastructure.definitions.furniture.map((item) => item.kind))].sort(), [
    'bench',
    'bin',
    'bollard',
    'cycle-rack',
    'lamp',
  ]);
  try {
    for (const [x, y, quality] of [
      [0, 2, 'balanced'],
      [150, 2, 'balanced'],
      [300, 2, 'high'],
      [450, 2, 'balanced'],
      [600, 2, 'balanced'],
      [450, 2, 'balanced'],
      [300, 2, 'high'],
      [0, 500, 'balanced'],
      [0, 2, 'balanced'],
    ]) {
      camera.position.set(x, y, 0);
      infrastructure.update(camera, quality);
      trackGeometries();
      const referenceScene = new THREE.Scene(),
        reference = buildInfrastructure(referenceScene, data);
      try {
        reference.update(camera, quality);
        equalNearby(infrastructure, reference, scene, referenceScene);
        for (const time of [0, 22, 24.9, 27, 49, 53.9, 108.2]) {
          infrastructure.updateSignals(time, true);
          reference.updateSignals(time, true);
          const active = scene.getObjectByName('Active traffic and pedestrian signal lenses'),
            expected = referenceScene.getObjectByName(active.name),
            count = active.count;
          assert.equal(count, expected.count);
          assert.deepEqual(
            bytes(active.instanceMatrix.array.subarray(0, count * 16)),
            bytes(expected.instanceMatrix.array.subarray(0, count * 16)),
          );
          if (count)
            assert.deepEqual(
              bytes(active.instanceColor.array.subarray(0, count * 3)),
              bytes(expected.instanceColor.array.subarray(0, count * 3)),
            );
        }
        assert.ok(infrastructure.stats.liveDetailTiles <= INFRASTRUCTURE_LIMITS.highTiles);
      } finally {
        reference.dispose();
      }
    }
    assert.ok(infrastructure.detailCaches.furniture.hits > infrastructure.detailCaches.furniture.misses);
    assert.ok(infrastructure.detailCaches.signals.hits > infrastructure.detailCaches.signals.misses);
    assert.ok(infrastructure.detailCaches.tiles.hits > 0);
    for (const [name, maxBytes, maxEntries] of [
      ['furniture', 8 * 1024 * 1024, 640],
      ['signals', 4 * 1024 * 1024, 144],
      ['tiles', 4 * 1024 * 1024, 32],
    ]) {
      assert.ok(infrastructure.detailCaches[name].bytes <= maxBytes);
      assert.ok(infrastructure.detailCaches[name].entries <= maxEntries);
    }
  } finally {
    infrastructure.dispose();
  }
  assert.equal(scene.children.length, 0);
  for (const count of geometries.values()) assert.equal(count, 1, 'dispose every owned geometry once');
  for (const cache of Object.values(infrastructure.detailCaches)) {
    assert.equal(cache.bytes, 0);
    assert.equal(cache.entries, 0);
  }
});

test('retained primitives expire when placement or signal source evidence changes', () => {
  const data = streetFixture(),
    camera = new THREE.PerspectiveCamera(),
    scene = new THREE.Scene(),
    infrastructure = buildInfrastructure(scene, data),
    referenceScene = new THREE.Scene(),
    reference = buildInfrastructure(referenceScene, data),
    nearest = (items) => items.reduce((a, b) => (Math.hypot(a.x, a.z) < Math.hypot(b.x, b.z) ? a : b)),
    furnitureIndex = infrastructure.definitions.furniture.indexOf(
      nearest(infrastructure.definitions.furniture),
    ),
    signalIndex = infrastructure.signals.indexOf(nearest(infrastructure.signals));
  try {
    camera.position.set(0, 2, 0);
    infrastructure.update(camera);
    infrastructure.definitions.furniture[furnitureIndex].x += 0.03125;
    reference.definitions.furniture[furnitureIndex].x += 0.03125;
    infrastructure.signals[signalIndex].citySite = { pedestrianButtons: false };
    reference.signals[signalIndex].citySite = { pedestrianButtons: false };
    camera.position.y = 500;
    infrastructure.update(camera);
    camera.position.y = 2;
    infrastructure.update(camera);
    reference.update(camera);
    equalNearby(infrastructure, reference, scene, referenceScene);
  } finally {
    infrastructure.dispose();
    reference.dispose();
  }
});
