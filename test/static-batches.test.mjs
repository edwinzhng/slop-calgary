import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { addStaticBatches, configureStaticBatches, mergeStaticGeometries } from '../app/static-batches.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function triangleAttributes(geometry) {
  const expanded = geometry.index ? geometry.toNonIndexed() : geometry;
  try {
    return Object.fromEntries(
      Object.entries(expanded.attributes).map(([name, attribute]) => [
        name,
        {
          type: attribute.array.constructor.name,
          bytes: new Uint8Array(
            attribute.array.buffer,
            attribute.array.byteOffset,
            attribute.array.byteLength,
          ).slice(),
          itemSize: attribute.itemSize,
          normalized: attribute.normalized,
          gpuType: attribute.gpuType,
        },
      ]),
    );
  } finally {
    if (expanded !== geometry) expanded.dispose();
  }
}

test('homogeneous static merges retain shared vertices and the exact triangle attribute stream', () => {
  const sources = [
    new THREE.PlaneGeometry(12, 8, 3, 2),
    new THREE.PlaneGeometry(5, 7, 2, 3).translate(20, -0, -10),
  ];
  for (const geometry of sources) {
    const count = geometry.attributes.position.count;
    geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(count * 4).fill(171), 4, true));
    geometry.setAttribute(
      'profile',
      new THREE.BufferAttribute(new Uint16Array(count * 2).fill(12345), 2, true),
    );
  }
  const sourceArrays = sources.map((geometry) =>
    Object.values(geometry.attributes).map((attribute) => attribute.array),
  );
  const expanded = sources.map((geometry) => geometry.toNonIndexed()),
    reference = mergeGeometries(expanded, false),
    result = mergeStaticGeometries(sources);
  try {
    assert.ok(result.index);
    assert.equal(result.index.count, reference.attributes.position.count);
    assert.equal(
      result.attributes.position.count,
      sources.reduce((sum, geometry) => sum + geometry.attributes.position.count, 0),
    );
    assert.ok(result.attributes.position.count < reference.attributes.position.count);
    assert.deepEqual(triangleAttributes(result), triangleAttributes(reference));
    assert.deepEqual(result.groups, reference.groups);
    assert.deepEqual(result.drawRange, reference.drawRange);
    sources.forEach((geometry, i) => {
      assert.ok(geometry.index);
      Object.values(geometry.attributes).forEach((attribute, j) =>
        assert.equal(attribute.array, sourceArrays[i][j]),
      );
    });
  } finally {
    for (const geometry of [...sources, ...expanded, reference, result]) geometry.dispose();
  }
});

test('mixed static merges preserve exact source triangles without altering input ownership', () => {
  const indexed = new THREE.BoxGeometry(4, 6, 8),
    flat = new THREE.PlaneGeometry(9, 3).toNonIndexed(),
    expanded = indexed.toNonIndexed(),
    reference = mergeGeometries([expanded, flat], false),
    result = mergeStaticGeometries([indexed, flat]);
  try {
    assert.equal(result.index, null);
    assert.deepEqual(triangleAttributes(result), triangleAttributes(reference));
    assert.ok(indexed.index);
    assert.equal(flat.index, null);
  } finally {
    for (const geometry of [indexed, flat, expanded, reference, result]) geometry.dispose();
  }
});

test('mixed spatial source groups keep one index layout across all batch cells', () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshBasicNodeMaterial(),
    indexed = new THREE.PlaneGeometry(4, 4),
    flat = new THREE.PlaneGeometry(4, 4).toNonIndexed().translate(20, 0, 0),
    pieces = [
      mergeStaticGeometries([indexed], { preserveIndices: false }),
      mergeStaticGeometries([flat], { preserveIndices: false }),
    ];
  const mesh = addStaticBatches(scene, pieces, material, 'Mixed spatial group');
  try {
    assert.equal(mesh.isBatchedMesh, true);
    assert.equal(mesh.geometry.index, null);
    assert.equal(mesh.geometry.attributes.position.count, 12);
  } finally {
    indexed.dispose();
    flat.dispose();
    mesh.dispose();
    material.dispose();
  }
});

test('static pieces retain exact attributes, source ownership and independent camera/shadow culling', () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshBasicNodeMaterial(),
    pieces = [
      new THREE.BoxGeometry(4, 4, 4).translate(0, 2, -30),
      new THREE.BoxGeometry(4, 4, 4).translate(0, 2, 100),
    ],
    attributes = Object.fromEntries(
      Object.keys(pieces[0].attributes).map((name) => [
        name,
        pieces.flatMap((geometry) => Array.from(geometry.attributes[name].array)),
      ]),
    );
  let sourceDisposals = 0,
    materialDisposed = false;
  for (const piece of pieces) piece.addEventListener('dispose', () => sourceDisposals++);
  material.addEventListener('dispose', () => {
    materialDisposed = true;
  });
  const mesh = addStaticBatches(scene, pieces, material, 'Static test pieces', true);
  try {
    assert.equal(scene.children.length, 1);
    assert.equal(mesh.isBatchedMesh, true);
    assert.equal(mesh.castShadow, true);
    assert.equal(sourceDisposals, 2);
    assert.equal(materialDisposed, false);
    for (const [name, expected] of Object.entries(attributes))
      assert.deepEqual(Array.from(mesh.geometry.attributes[name].array), expected, name);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.2, 1000);
    camera.position.set(0, 2, 0);
    camera.updateMatrixWorld();
    mesh.onBeforeRender({ isWebGPURenderer: false }, scene, camera, mesh.geometry, material);
    assert.equal(mesh._multiDrawCount, 1, 'only the piece in front is submitted');
    camera.rotation.y = Math.PI;
    camera.updateMatrixWorld();
    mesh.onBeforeRender({ isWebGPURenderer: false }, scene, camera, mesh.geometry, material);
    assert.equal(mesh._multiDrawCount, 1, 'a camera turn selects the other piece');
    const shadowCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    shadowCamera.position.set(0, 2, 0);
    shadowCamera.updateMatrixWorld();
    mesh.onBeforeShadow({ isWebGPURenderer: false }, null, camera, shadowCamera, mesh.geometry, material);
    assert.equal(mesh._multiDrawCount, 1, 'shadow culling uses the light camera');
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    assert.ok(ray.intersectObject(mesh).some((hit) => Math.abs(hit.distance - 28) < 1e-6));
    ray.ray.direction.z = 1;
    assert.ok(ray.intersectObject(mesh).some((hit) => Math.abs(hit.distance - 98) < 1e-6));
  } finally {
    mesh.dispose();
    material.dispose();
  }
});

test('a single static piece retains its ordinary geometry and shared material', () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.PlaneGeometry(),
    material = new THREE.MeshBasicNodeMaterial();
  const mesh = addStaticBatches(scene, [null, geometry], material, 'One piece');
  try {
    assert.equal(mesh.isBatchedMesh, undefined);
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(mesh.matrixAutoUpdate, false);
    assert.equal(mesh.matrixWorldAutoUpdate, false);
    assert.equal(addStaticBatches(scene, [], material, 'Empty'), null);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

function cellPieces(indexed = true) {
  return [
    [0, -30],
    [0, 100],
    [800, -30],
  ].map(([x, z], i) => {
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([x - 2, 0, z, x + 2, 0, z, x, 4, z, 10000, 10000, 10000], 3),
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, -0, 1, 0, 0.5, 1, 99, 99], 2));
    geometry.setAttribute('color', new THREE.Uint8BufferAttribute(new Uint8Array(16).fill(29 + i), 4, true));
    geometry.setAttribute('sourceId', new THREE.Uint32BufferAttribute([i, i, i, 0xffffff], 1));
    geometry.attributes.sourceId.gpuType = THREE.IntType;
    geometry.setIndex([0, 1, 2]);
    if (!indexed) {
      const expanded = geometry.toNonIndexed();
      geometry.dispose();
      geometry = expanded;
    }
    if (i === 1)
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-10, -5, 90), new THREE.Vector3(6, 9, 110));
    if (i === 2) geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(803, 9, -25), 20);
    return geometry;
  });
}

function disposeStaticMesh(mesh) {
  if (mesh.isBatchedMesh) mesh.dispose();
  else mesh.geometry.dispose();
}

test('opt-in static cells retain source bytes, draw ranges and exact authored/referenced BatchedMesh bounds', () => {
  for (const indexed of [true, false]) {
    const scene = new THREE.Scene(),
      material = new THREE.MeshBasicNodeMaterial(),
      reference = addStaticBatches(new THREE.Scene(), cellPieces(indexed), material, 'Reference', true),
      sources = cellPieces(indexed),
      sourceArrays = sources.map((g) => Object.values(g.attributes).map((a) => a.array.slice())),
      configuration = configureStaticBatches(scene, { indirectDraws: true });
    let sourceDisposals = 0,
      materialDisposals = 0;
    sources.forEach((g) => g.addEventListener('dispose', () => sourceDisposals++));
    material.addEventListener('dispose', () => materialDisposals++);
    const mesh = addStaticBatches(scene, sources, material, 'Indirect cells', true);
    try {
      assert.equal(mesh.isMesh, true);
      assert.equal(mesh.isBatchedMesh, undefined);
      assert.equal(mesh.isInstancedMesh, undefined);
      assert.equal(mesh.instanceMatrix, undefined);
      assert.equal(mesh.material, material);
      assert.equal(mesh.name, 'Indirect cells');
      assert.equal(mesh.castShadow, true);
      assert.equal(mesh.receiveShadow, true);
      assert.equal(mesh.matrixAutoUpdate, false);
      assert.equal(mesh.matrixWorldAutoUpdate, false);
      assert.deepEqual(mesh.matrixWorld, new THREE.Matrix4());
      assert.deepEqual(triangleAttributes(mesh.geometry), triangleAttributes(reference.geometry));
      assert.deepEqual(Object.keys(mesh.geometry.attributes), Object.keys(reference.geometry.attributes));
      if (indexed) assert.deepEqual(mesh.geometry.index.array, reference.geometry.index.array);
      else assert.equal(mesh.geometry.index, null);
      assert.deepEqual(mesh.geometry.boundingBox, reference.boundingBox);
      assert.deepEqual(mesh.geometry.boundingSphere, reference.boundingSphere);
      const { parts } = mesh.userData.staticCellDraws;
      assert.deepEqual(
        parts.map(({ start, count }) => ({ start, count })),
        [
          { start: 0, count: 3 },
          { start: 3, count: 3 },
          { start: 6, count: 3 },
        ],
      );
      parts.forEach((part, i) =>
        assert.deepEqual(part.sphere, reference.getBoundingSphereAt(i, new THREE.Sphere())),
      );
      assert.ok(parts[0].sphere.radius < 3, 'unused indexed allocation vertices stay outside cell bounds');
      assert.notDeepEqual(parts[0].sphere.center, parts[1].sphere.center);
      const stride = indexed ? 5 : 4;
      assert.deepEqual(
        Array.from(mesh.geometry.indirect.array),
        parts.flatMap(({ start, count }) => (indexed ? [count, 1, start, 0, 0] : [count, 1, start, 0])),
      );
      assert.equal(mesh.geometry.indirect.array.length, stride * parts.length);
      assert.equal(configuration.stats.groups, 1);
      assert.equal(configuration.stats.parts, 3);
      assert.equal(sourceDisposals, 3);
      sources.forEach((g, i) =>
        Object.values(g.attributes).forEach((a, j) => assert.deepEqual(a.array, sourceArrays[i][j])),
      );
    } finally {
      disposeStaticMesh(reference);
      disposeStaticMesh(mesh);
    }
    assert.equal(sourceDisposals, 3);
    assert.equal(materialDisposals, 0);
    assert.equal(configuration.stats.groups, 0);
    assert.equal(configuration.stats.parts, 0);
    assert.equal(mesh.geometry.indirect, null);
    assert.equal(mesh.onBeforeRender, THREE.Object3D.prototype.onBeforeRender);
    assert.equal(mesh.frustumCulled, true);
    material.dispose();
  }
});

test('static cell accounting aggregates real view/shadow commands and resets only frame corrections', () => {
  const scene = new THREE.Scene(),
    configuration = configureStaticBatches(scene, { indirectDraws: true }),
    other = configureStaticBatches(new THREE.Scene(), { indirectDraws: true }),
    material = new THREE.MeshBasicNodeMaterial(),
    mesh = addStaticBatches(scene, cellPieces(), material, 'Accounting cells', true),
    camera = new THREE.PerspectiveCamera(55, 1, 0.2, 2000),
    all = new THREE.OrthographicCamera(-1500, 1500, 1500, -1500, 0.2, 4000);
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld();
  all.position.set(0, 2000, 0);
  all.up.set(0, 0, -1);
  all.lookAt(0, 0, 0);
  all.updateMatrixWorld();
  try {
    const { stats, beginFrame } = configuration;
    mesh.onBeforeRender(null, scene, camera, mesh.geometry, material);
    assert.deepEqual(stats, { groups: 1, parts: 3, indirectDrawCalls: 1, indirectTriangles: 1 });
    mesh.onBeforeShadow(null, null, all, all, mesh.geometry, material);
    mesh.onBeforeRender(null, scene, all, mesh.geometry, material);
    assert.deepEqual(stats, { groups: 1, parts: 3, indirectDrawCalls: 4, indirectTriangles: 4 });
    mesh.onAfterShadow(null, null, all, all, mesh.geometry, material);
    assert.equal(stats.indirectDrawCalls, 4, 'restoring a view is not another backend draw');
    assert.deepEqual(other.stats, { groups: 0, parts: 0, indirectDrawCalls: 0, indirectTriangles: 0 });
    beginFrame();
    assert.deepEqual(stats, { groups: 1, parts: 3, indirectDrawCalls: 0, indirectTriangles: 0 });
    camera.position.x = 7000;
    camera.updateMatrixWorld();
    mesh.onBeforeRender(null, scene, camera, mesh.geometry, material);
    assert.deepEqual(stats, { groups: 1, parts: 3, indirectDrawCalls: 0, indirectTriangles: 0 });
    assert.equal(mesh.geometry.indirectOffset.length, 0);
    assert.equal(configureStaticBatches(scene, { indirectDraws: true }), configuration);
  } finally {
    disposeStaticMesh(mesh);
    material.dispose();
  }
});

test('static indirect configuration is explicit and unsupported layouts or two-pass materials retain fallback', () => {
  for (const indirectDraws of [undefined, false, 1, 'true']) {
    const scene = new THREE.Scene(),
      material = new THREE.MeshBasicNodeMaterial();
    configureStaticBatches(scene, { indirectDraws });
    const mesh = addStaticBatches(scene, cellPieces(), material, 'Fallback');
    try {
      assert.equal(mesh.isBatchedMesh, true);
    } finally {
      disposeStaticMesh(mesh);
      material.dispose();
    }
  }
  for (const unsupported of ['groups', 'drawRange', 'morphs', 'dynamic', 'wireframe', 'two-pass']) {
    const scene = new THREE.Scene(),
      material = new THREE.MeshBasicNodeMaterial(),
      pieces = cellPieces(),
      configuration = configureStaticBatches(scene, { indirectDraws: true });
    if (unsupported === 'groups') pieces[0].addGroup(0, 3, 0);
    if (unsupported === 'drawRange') pieces[0].setDrawRange(0, 3);
    if (unsupported === 'morphs')
      pieces[0].morphAttributes.position = [pieces[0].attributes.position.clone()];
    if (unsupported === 'dynamic') pieces[0].attributes.position.setUsage(THREE.DynamicDrawUsage);
    if (unsupported === 'wireframe') material.wireframe = true;
    if (unsupported === 'two-pass') {
      material.transparent = true;
      material.side = THREE.DoubleSide;
    }
    const mesh = addStaticBatches(scene, pieces, material, 'Unsupported fallback');
    try {
      assert.equal(mesh.isBatchedMesh, true, unsupported);
      assert.equal(mesh.geometry.indirect, null);
      assert.equal(configuration.stats.groups, 0);
    } finally {
      disposeStaticMesh(mesh);
      material.dispose();
    }
  }
  const scene = new THREE.Scene(),
    material = new THREE.MeshBasicNodeMaterial();
  configureStaticBatches(scene, { indirectDraws: true });
  const geometry = new THREE.PlaneGeometry(),
    mesh = addStaticBatches(scene, [geometry], material, 'Single');
  try {
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.geometry.indirect, null);
    assert.equal(mesh.userData.staticCellDraws, undefined);
  } finally {
    disposeStaticMesh(mesh);
    material.dispose();
  }
});

test('required indirect batches leave unsupported sources owned by the caller', () => {
  for (const indirectDraws of [false, true]) {
    const scene = new THREE.Scene(),
      material = new THREE.MeshBasicNodeMaterial(),
      pieces = cellPieces();
    configureStaticBatches(scene, { indirectDraws });
    if (indirectDraws) pieces[0].addGroup(0, 3, 0);
    let disposed = 0;
    for (const geometry of pieces) geometry.addEventListener('dispose', () => disposed++);
    try {
      assert.equal(
        addStaticBatches(scene, pieces, material, 'Required', true, { requireIndirect: true }),
        null,
      );
      assert.equal(scene.children.length, 0);
      assert.equal(disposed, 0);
      assert.ok(pieces.every((geometry) => geometry.attributes.position.count > 0));
    } finally {
      for (const geometry of pieces) geometry.dispose();
      material.dispose();
    }
  }
});
