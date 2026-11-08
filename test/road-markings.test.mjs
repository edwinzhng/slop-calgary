import test from 'node:test';
import { createRoadRibbonGeometry } from '../app/world.js';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { readFileSync } from 'node:fs';
import { laneLayout, buildRoadMarkings } from '../app/road-markings.js';
import { applyRoadAttributes } from '../app/road-attributes.js';
import { roadWidth } from '../app/geo.js';

test('road ribbons retain source endpoints, height callbacks and the reserved index boundary', () => {
  const points = [
      [1, 2],
      [4, 6],
    ],
    calls = [],
    geometry = createRoadRibbonGeometry(points, 2, (t, point, index) => {
      calls.push([t, point, index]);
      return 10 + t;
    });
  try {
    assert.deepEqual(
      geometry.attributes.position.array,
      new Float32Array([0.2, 10, 2.6, 1.8, 10, 1.4, 3.2, 11, 6.6, 4.8, 11, 5.4]),
    );
    assert.deepEqual(Array.from(geometry.index.array), [0, 2, 1, 1, 2, 3]);
    assert.deepEqual(calls, [
      [0, points[0], 0],
      [1, points[1], 1],
    ]);
    assert.ok(geometry.attributes.normal.array.every(Number.isFinite));
  } finally {
    geometry.dispose();
  }
  const long = createRoadRibbonGeometry(
    Array.from({ length: 32768 }, (_, i) => [i, 0]),
    2,
  );
  try {
    assert.ok(long.index.array instanceof Uint32Array, '65535 is reserved for primitive restart');
    assert.deepEqual(Array.from(long.index.array.slice(-6)), [65532, 65534, 65533, 65533, 65534, 65535]);
  } finally {
    long.dispose();
  }
});

test('two-way streets separate opposing traffic in yellow while one-way lanes stay white', () => {
  const twoWay = laneLayout({ lanes: 4, kind: 'primary', oneway: 'no' });
  assert.equal(twoWay.filter((l) => l.duty === 1).length, 2);
  assert.equal(twoWay.filter((l) => l.duty < 1).length, 2);
  const oneWay = laneLayout({ lanes: 4, kind: 'primary', oneway: 'yes' });
  assert.equal(oneWay.length, 3);
  assert.ok(oneWay.every((l) => l.duty === 0.25));
});

test('paint stops outside actual junctions, preserves both yellow lines and follows deck heights', () => {
  const scene = new THREE.Scene();
  const roads = [
    {
      kind: 'secondary',
      lanes: 2,
      oneway: 'no',
      points: [
        [-40, 0],
        [0, 0],
        [40, 0],
      ],
    },
    {
      kind: 'secondary',
      lanes: 2,
      oneway: 'no',
      points: [
        [0, -40],
        [0, 0],
        [0, 40],
      ],
    },
  ];
  const { mesh, stats } = buildRoadMarkings(scene, roads, {
    ownsRoad: () => false,
    surfaceHeight: () => 5,
  });
  assert.equal(stats.junctions, 1);
  assert.equal(stats.strips, 8);
  const p = mesh.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    assert.ok(Math.hypot(p.getX(i), p.getZ(i)) > 5);
    assert.ok(Math.abs(p.getY(i) - 5.018) < 1e-5);
  }
  assert.ok(p.array.every(Number.isFinite));
  mesh.geometry.dispose();
  mesh.material.dispose();
});

const attributes = JSON.parse(readFileSync(new URL('../data/calgary-road-attributes.json', import.meta.url))),
  model = attributes.inferredRoadModels.find((r) => r.id === 'osm-way-52460453-0'),
  fixtureAttributes = { ...attributes, meta: { ...attributes.meta, mappedRoadCount: 1 } },
  sourceRoad = () => ({ id: model.id, ...structuredClone(model.expected) }),
  applyFixture = (road) =>
    applyRoadAttributes(
      { meta: { generatedAt: attributes.meta.osmBaseTimestamp }, roads: [road] },
      fixtureAttributes,
    );

test('the observed Blackfoot lane fallback narrows the modeled carriageway without rewriting its mapped lane count', () => {
  const road = sourceRoad();
  assert.equal(roadWidth(road), 12.8);
  applyFixture(road);
  assert.equal(road.lanes, 0);
  assert.equal(road.inferredLanes, 2);
  assert.equal(roadWidth(road), 6.4);
});

test('a newer measurement or source geometry change expires the inferred lane model', () => {
  for (const mutate of [
    (r) => {
      r.lanes = 3;
    },
    (r) => {
      r.width = 11.1;
    },
    (r) => {
      r.points[0][0] += 0.01;
    },
    (r) => {
      r.bridge = false;
    },
    (r) => {
      r.oneway = 'no';
    },
    (r) => {
      r.layer = 2;
    },
    (r) => {
      r.kind = 'primary';
    },
  ]) {
    const road = sourceRoad();
    applyFixture(road);
    assert.equal(road.inferredLanes, 2);
    mutate(road);
    applyFixture(road);
    assert.equal(Object.hasOwn(road, 'inferredLanes'), false);
    if (road.lanes === 3) assert.equal(roadWidth(road), 9.600000000000001);
    if (road.width === 11.1) assert.equal(roadWidth(road), 11.1);
  }
});
