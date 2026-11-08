import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createFordCrossings, buildFordDetails, isMappedFootFord } from '../app/ford-crossings.js';
import { createGroundSurfaces } from '../app/ground-surfaces.js';
import { movementBody, footprintContact } from '../app/camera-collision.js';

const road = {
  id: 'source-ford',
  kind: 'footway',
  sourceTags: { ford: 'yes' },
  points: [
    [0, 0],
    [10, 0],
  ],
};
const pad = {
  id: 'mapped-pad',
  kind: 'Concrete Pad',
  material: 'Concrete',
  ring: [
    [1, -1],
    [9, -1],
    [9, 1],
    [1, 1],
    [1, -1],
  ],
};
const water = (x, z) => x > 2 && x < 8 && Math.abs(z) < 20;
const make = (surfaces = [pad], waterHeight = () => 0.075) => {
  const scene = new THREE.Scene();
  const fords = createFordCrossings([road], { surfaces }, { inWater: water, waterHeight });
  const paving = createGroundSurfaces(
    scene,
    { surfaces },
    { registerSurfaceGeometry: fords.registerSurfaceGeometry },
  );
  return { scene, fords, paving };
};
const cleanup = (scene) => {
  scene.traverse((o) => {
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose();
  });
  scene.clear();
};

test('only an explicit pedestrian ford with a real concrete crossing can acquire water support', () => {
  assert.equal(isMappedFootFord(road), true);
  for (const change of [
    { sourceTags: {} },
    { sourceTags: { ford: 'no' } },
    { bridge: true },
    { tunnel: true },
    { kind: 'motorway' },
    { sourceTags: { ford: 'stepping_stones' } },
  ])
    assert.equal(isMappedFootFord({ ...road, ...change }), false);
  const missing = createFordCrossings(
    [road],
    { surfaces: [{ ...pad, kind: 'Pathways' }] },
    { inWater: water, waterHeight: () => 0.075 },
  );
  assert.equal(missing.records.length, 0);
  assert.equal(missing.groundHeight(5, 0), null);
});

test('ford support uses actual emitted paving, including holes, exact endpoints and height hints', () => {
  const hole = [
    [4, -0.3],
    [6, -0.3],
    [6, 0.3],
    [4, 0.3],
    [4, -0.3],
  ];
  const { scene, fords } = make([{ ...pad, holes: [hole] }]);
  try {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fords.records[0].faces.flat(2), 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    for (const x of [1.1, 3, 7, 8.9])
      for (const z of [-0.8, 0, 0.8]) {
        ray.ray.origin.set(x, 10, z);
        const hit = ray.intersectObject(mesh)[0];
        assert.ok(hit);
        assert.ok(Math.abs(fords.groundHeight(x, z) - hit.point.y) < 1e-7);
      }
    g.dispose();
    mesh.material.dispose();
    assert.equal(fords.groundHeight(5, 0), null, 'a paving hole stays unsupported');
    assert.equal(fords.groundHeight(5, 1.01), null);
    assert.equal(fords.groundHeight(-0.01, 0), null);
    assert.equal(fords.groundHeight(10.01, 0), null);
    assert.equal(fords.groundHeight(3, 0, -2), null);
  } finally {
    cleanup(scene);
  }
});

test('walking and cycling cross the actual footprint while cars, wet overhangs and deep flooding are rejected', () => {
  const { scene, fords } = make();
  const p = { x: 5, y: fords.groundHeight(5, 0), z: 0 };
  try {
    for (const mode of ['walk', 'cycle']) {
      const body = movementBody(mode);
      assert.equal(fords.permitsBody(p, body), true);
      assert.equal(
        fords.footprintBlocked(p, body, () => null),
        false,
      );
    }
    assert.equal(fords.permitsBody(p, movementBody('drive')), false);
    assert.equal(fords.permitsBody(p, movementBody('fly')), false);
    assert.equal(
      fords.footprintBlocked(p, movementBody('drive', Math.PI / 2), () => null),
      true,
    );
    assert.equal(fords.permitsBody({ ...p, z: 0.8 }, movementBody('walk')), false);
    assert.equal(
      fords.footprintBlocked({ ...p, z: 0.8 }, movementBody('walk'), () => null),
      true,
    );
    assert.equal(
      fords.footprintBlocked({ ...p, x: 1.7 }, movementBody('walk'), () => null),
      false,
      'dry shore handoff remains clear',
    );
    assert.equal(
      fords.footprintBlocked({ ...p, x: 45, z: 45 }, movementBody('walk'), () => null),
      false,
      'unrelated points do not activate the guard',
    );
    assert.equal(
      fords.footprintBlocked(p, movementBody('drive'), () => p.y),
      false,
      'an independently supported bridge remains authoritative',
    );
  } finally {
    cleanup(scene);
  }
  const flooded = make([pad], () => 0.7);
  try {
    assert.equal(
      flooded.fords.permitsBody({ x: 5, y: flooded.fords.groundHeight(5, 0), z: 0 }, movementBody('walk')),
      false,
    );
  } finally {
    cleanup(flooded.scene);
  }
});

test('centimetre-scale paving gaps receive visible bounded seam geometry before they can support movement', () => {
  const north = {
    id: 'north',
    kind: 'Pathways',
    material: 'Pavement',
    ring: [
      [-1, -1],
      [0.995, -1],
      [0.995, 1],
      [-1, 1],
      [-1, -1],
    ],
  };
  const south = {
    id: 'south',
    kind: 'Pathways',
    material: 'Pavement',
    ring: [
      [9.005, -1],
      [11, -1],
      [11, 1],
      [9.005, 1],
      [9.005, -1],
    ],
  };
  const { scene, fords } = make([pad, north, south]);
  try {
    assert.equal(fords.groundHeight(0.9975, 0), null);
    assert.ok(fords.records[0].joins.length > 0);
    const detail = buildFordDetails(scene, fords);
    assert.ok(Number.isFinite(fords.groundHeight(0.9975, 0)));
    assert.ok(Number.isFinite(fords.groundHeight(9.0025, 0)));
    assert.ok(fords.stats.inferredJoinTriangles > 0);
    assert.equal(detail.stats.maximumInferredJoinReachM, 0.025);
    for (const j of fords.records[0].joins) assert.equal(j.sourceSurfaceIds.length, 2);
    detail.dispose();
  } finally {
    cleanup(scene);
  }
});

test('low crossing details preserve the paving top, stay on its footprint and couple the solid fascia to collision', () => {
  const { scene, fords } = make();
  const before = scene.children
    .filter((o) => o.geometry)
    .map((o) => [o, o.geometry.attributes.position.array.slice()]);
  const detail = buildFordDetails(scene, fords);
  try {
    for (const [o, positions] of before) assert.deepEqual(o.geometry.attributes.position.array, positions);
    assert.equal(detail.stats.pads, 1);
    assert.equal(detail.stats.draws, 2);
    assert.ok(detail.stats.triangles < 100);
    const [slab] = detail.colliders,
      contact = {};
    const y = fords.groundHeight(5, 0);
    assert.equal(footprintContact(slab, 5, y, 0, movementBody('walk'), contact), false);
    assert.equal(footprintContact(slab, 5, y - 0.1, 0, movementBody('walk'), contact), true);
    for (const mesh of detail.meshes) {
      assert.ok(mesh.userData.sourceFordDetail);
      const p = mesh.geometry.attributes.position;
      assert.ok(p.array.every(Number.isFinite));
      for (let i = 0; i < p.count; i++) {
        assert.ok(p.getX(i) >= 1 - 1e-6 && p.getX(i) <= 9 + 1e-6);
        assert.ok(Math.abs(p.getZ(i)) <= 1 + 1e-6);
        if (mesh.userData.sourceFordDetail === 'fascia') assert.ok(p.getY(i) < y, 'no duplicate top face');
      }
    }
    detail.dispose();
    assert.equal(
      scene.children.some((o) => o.userData.sourceFordDetail),
      false,
    );
  } finally {
    cleanup(scene);
  }
});
