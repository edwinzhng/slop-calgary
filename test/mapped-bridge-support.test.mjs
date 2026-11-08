import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createMappedBridgeSupport, mappedBridgeFootprintBlocked } from '../app/mapped-bridge-support.js';
import { movementBody } from '../app/camera-collision.js';

const road = {
    id: 'mapped-bridge',
    kind: 'footway',
    bridge: true,
    points: [
      [0, 0],
      [10, 0],
    ],
  },
  water = (x, z) => x > 2 && x < 8 && Math.abs(z) < 10,
  flat = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0.2, -1.1, 0, 0.2, 1.1, 10, 0.2, -1.1, 10, 0.2, 1.1], 3),
    );
    g.setIndex([0, 1, 2, 2, 1, 3]);
    return g;
  };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('actual registered triangle support matches independent rays without outside projection or geometry mutation', () => {
  const g = flat(),
    p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, 0.2 + p.getX(i) * 0.05);
  const original = p.array.slice(),
    index = g.index.array.slice(),
    s = createMappedBridgeSupport([road], { inWater: () => true, surfaceHeight: () => 0.2 }),
    material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
    mesh = new THREE.Mesh(g, material),
    ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  try {
    s.registerGeometry(road, g);
    assert.deepEqual(g.attributes.position.array, original);
    assert.deepEqual(g.index.array, index);
    for (const x of [0.1, 2, 5, 9.9])
      for (const z of [-1, 0, 1]) {
        ray.ray.origin.set(x, 20, z);
        const hit = ray.intersectObject(mesh)[0];
        assert.ok(hit);
        near(s.groundHeight(x, z), hit.point.y);
        assert.equal(s.sampleAt(x, z).source, 'emitted-road-triangle');
      }
    assert.equal(s.groundHeight(5, 1.2), null);
    assert.equal(s.groundHeight(-0.01, 0), null);
    assert.equal(s.groundHeight(10.01, 0), null);
    assert.equal(s.groundHeight(5, 0, -1), null);
    assert.equal(s.groundHeight(NaN, 0), null);
  } finally {
    g.dispose();
    material.dispose();
  }
});

test('a source bridge can use visible mapped paving, respecting holes, height hints and exact source endpoints', () => {
  const s = createMappedBridgeSupport([road], {
    inWater: () => true,
    surfaceHeight: () => 0.14,
    pavingHeight: (x, z) =>
      x > 7 && Math.abs(z) < 0.8 && !(x > 8 && x < 9 && Math.abs(z) < 0.2) ? 0.31 : null,
  });
  near(s.groundHeight(7.5, 0), 0.31);
  assert.equal(s.sampleAt(7.5, 0).source, 'mapped-paving-within-source-bridge');
  assert.equal(s.groundHeight(8.5, 0), null);
  assert.equal(s.groundHeight(10.1, 0), null);
  assert.equal(s.groundHeight(7.5, 1.2), null);
  assert.equal(s.groundHeight(7.5, 0, -1), null);
  const high = createMappedBridgeSupport([road], {
    inWater: () => true,
    surfaceHeight: () => 0.14,
    pavingHeight: () => 5,
  });
  assert.equal(high.groundHeight(5, 0), null);
  const noTag = createMappedBridgeSupport([{ ...road, bridge: false }], {
    inWater: () => true,
    surfaceHeight: () => 0.14,
    pavingHeight: () => 0.14,
  });
  assert.equal(noTag.groundHeight(5, 0), null);
});

test('bridge footprint probes pass tangent-aligned bodies, reject wet edges and retain dry shore handoffs', () => {
  const g = flat(),
    s = createMappedBridgeSupport([road], { inWater: water, surfaceHeight: () => 0.2 });
  s.registerGeometry(road, g);
  g.dispose();
  const blocked = (p, body) =>
    mappedBridgeFootprintBlocked(p, body, { support: s, inWater: water, crossingHeight: s.groundHeight });
  assert.equal(blocked({ x: 5, y: 0.2, z: 0 }, movementBody('walk')), false);
  assert.equal(blocked({ x: 5, y: 0.2, z: 0 }, movementBody('cycle')), false);
  assert.equal(blocked({ x: 5, y: 0.2, z: 0 }, movementBody('drive', Math.PI / 2)), false);
  assert.equal(blocked({ x: 5, y: 0.2, z: 0 }, movementBody('drive', 0)), true);
  assert.equal(blocked({ x: 5, y: 0.2, z: 0.9 }, movementBody('walk')), true);
  assert.equal(blocked({ x: 1.8, y: 0.2, z: 0 }, movementBody('drive', Math.PI / 2)), false);
  assert.equal(blocked({ x: 5, y: -1, z: 0 }, movementBody('walk')), true);
  assert.equal(blocked({ x: 5, y: 5, z: 0 }, movementBody('walk')), false);
  assert.equal(
    s.nearby(45, 45, movementBody('walk')),
    false,
    'cell membership alone does not activate an edge guard',
  );
});
