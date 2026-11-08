import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createParks } from '../app/parks.js';
import { surfaceMaterial } from '../app/materials.js';
import { PARK_AGGREGATE_FINISHES } from '../app/park-finishes.js';
import { configureStaticBatches } from '../app/static-batches.js';

for (const indirectDraws of [false, true])
  test(`park batches keep independent distance limits and restore empty selections (indirect=${indirectDraws})`, () => {
    const scene = new THREE.Scene();
    configureStaticBatches(scene, { indirectDraws });
    const parks = createParks(scene, {
      ground: [0, 6000, 12000].map((x, i) => ({ id: `ground-${i}`, kind: 'turf', ring: square(x, 0) })),
    });
    const mesh = scene.children[0],
      camera = new THREE.OrthographicCamera(-20000, 20000, 20000, -20000, 1, 50000),
      commands = mesh.geometry.indirect,
      version = commands?.version;
    try {
      assert.equal(scene.children.length, 1, 'one render object retains three original spatial pieces');
      for (const [x, quality, expected] of [
        [0, 'balanced', [0]],
        [6000, 'high', [0, 1, 2]],
        [12000, 'balanced', [2]],
        [100000, 'balanced', []],
        [0, 'balanced', [0]],
      ]) {
        camera.position.set(x, 100, 0);
        camera.lookAt(x, 0, 0);
        camera.updateMatrixWorld(true);
        parks.update(camera, quality);
        let selected;
        if (indirectDraws) {
          mesh.onBeforeRender({}, scene, camera);
          selected = mesh.geometry.indirectOffset.map((offset) => offset / (5 * 4));
          assert.equal(mesh.geometry.indirect, commands);
          assert.equal(commands.version, version, 'visibility does not rewrite static command buffers');
        } else selected = [0, 1, 2].filter((i) => mesh.getVisibleAt(i));
        assert.deepEqual(selected, expected);
      }
    } finally {
      parks.dispose();
    }
    assert.equal(scene.children.length, 0);
  });

function square(x, z, size = 12) {
  return [
    [x - size / 2, z - size / 2],
    [x + size / 2, z - size / 2],
    [x + size / 2, z + size / 2],
    [x - size / 2, z + size / 2],
    [x - size / 2, z - size / 2],
  ];
}

function attributeBytes(attribute, start = 0, count = attribute.count) {
  const array = attribute.array.subarray(start * attribute.itemSize, (start + count) * attribute.itemSize);
  return {
    type: array.constructor.name,
    itemSize: attribute.itemSize,
    normalized: attribute.normalized,
    gpuType: attribute.gpuType,
    bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice(),
  };
}

function snapshot(geometry, range) {
  const start = range?.vertexStart || 0,
    count = range?.vertexCount ?? geometry.attributes.position.count,
    indexStart = range?.indexStart || 0,
    indexCount = range?.indexCount ?? geometry.index?.count ?? 0;
  return {
    attributes: Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        attributeBytes(attribute, start, count),
      ]),
    ),
    indices: geometry.index
      ? Uint32Array.from(geometry.index.array.subarray(indexStart, indexStart + indexCount), (i) => i - start)
      : null,
  };
}

function disposeScene(scene) {
  for (const mesh of [...scene.children]) {
    scene.remove(mesh);
    if (mesh.isBatchedMesh) mesh.dispose();
    else {
      mesh.geometry?.dispose();
      if (mesh.isInstancedMesh) mesh.dispose();
    }
  }
}

const offsetAt = (x, z) => 0.2 + x / 100000 + z / 200000;
function drape(geometry, marker = 1) {
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++)
    position.setY(i, position.getY(i) + offsetAt(position.getX(i), position.getZ(i)));
  geometry.setAttribute(
    'surveyedFinish',
    new THREE.BufferAttribute(new Uint8Array(position.count * 4).fill(marker), 4, true),
  );
  return geometry;
}

test('park polygons retain the original Three draw stream through holes, drape and finish packing', () => {
  const polygons = [
    { id: 'lawn', kind: 'turf', ring: square(-8, -9), holes: [square(-8, -9, 3).reverse()] },
    {
      id: 'stone',
      kind: 'paving',
      sourceMaterial: 'FLAGSTONE',
      ring: [
        [-0, 0],
        [8, 0],
        [8, 6],
        [4, 3],
        [-0, 6],
        [-0, 0],
      ],
      holes: [square(2, 2, 1)],
    },
  ];
  const scene = new THREE.Scene(),
    reference = [],
    before = structuredClone(polygons);
  for (const [i, polygon] of polygons.entries()) {
    const shape = new THREE.Shape(polygon.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const hole of polygon.holes || [])
      shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
    const geometry = drape(
      new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, i ? 0.138 : 0.045, 0),
    );
    if (i) {
      const aggregate = PARK_AGGREGATE_FINISHES.stone,
        rgba = [...new THREE.Color(aggregate[0]).toArray(), aggregate[1]].map((v) => Math.round(v * 255)),
        finish = new Uint8Array(geometry.attributes.position.count * 4);
      for (let j = 0; j < geometry.attributes.position.count; j++) finish.set(rgba, j * 4);
      geometry.setAttribute('parkFinish', new THREE.BufferAttribute(finish, 4, true));
    }
    const expanded = geometry.toNonIndexed();
    reference.push(mergeGeometries([expanded], false));
    expanded.dispose();
    geometry.dispose();
  }
  const parks = createParks(
    scene,
    {
      ground: [polygons[0]],
      paving: [polygons[1]],
      mapParks: [{ ...polygons[0], name: 'Source park' }],
    },
    { terrain: { offsetAt, drapeGeometry: drape } },
  );
  try {
    const meshes = scene.children.filter((mesh) => mesh.name.startsWith('Surveyed Calgary park'));
    assert.equal(meshes.length, reference.length);
    meshes.forEach((mesh, i) => {
      assert.ok(mesh.geometry.index, 'uniform park sources retain shared vertices');
      assert.ok(mesh.geometry.attributes.position.count < reference[i].attributes.position.count);
      const expanded = mesh.geometry.toNonIndexed();
      try {
        assert.deepEqual(snapshot(expanded), snapshot(reference[i]));
      } finally {
        expanded.dispose();
      }
    });
    assert.equal(meshes[0].material, surfaceMaterial('turf'));
    assert.equal(meshes[1].material, surfaceMaterial('park-aggregate'));
    assert.equal(parks.groundHeight(-8, -9), null, 'ground hole remains open');
    assert.equal(parks.groundHeight(-12, -9), 0.045 + offsetAt(-12, -9));
    assert.equal(parks.groundHeight(2, 2, true), null, 'paving hole remains open');
    assert.equal(parks.groundHeight(6, 1, true), 0.138 + offsetAt(6, 1));
    assert.equal(parks.nameAt(-12, -9), 'Source park');
    assert.equal(parks.nameAt(-8, -9), null);
    assert.deepEqual(polygons, before);
    assert.equal(
      parks.stats.parkTriangles,
      reference.reduce((n, g) => n + g.attributes.position.count / 3, 0),
    );
    const disposals = meshes.map(() => 0);
    meshes.forEach((mesh, i) => mesh.geometry.addEventListener('dispose', () => disposals[i]++));
    parks.dispose();
    assert.equal(scene.children.length, 0);
    assert.deepEqual(disposals, [1, 1]);
  } finally {
    for (const geometry of reference) geometry.dispose();
    disposeScene(scene);
  }
});
