import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import ShadowBaseNode from 'three/src/nodes/lighting/ShadowBaseNode.js';
import { createStaticCellDraws } from '../app/static-cell-draws.js';

const bytes = (array) => Buffer.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));

function fixture(indexed = true) {
  const scene = new THREE.Scene(),
    geometry = new THREE.BufferGeometry(),
    material = new THREE.MeshStandardNodeMaterial(),
    mesh = new THREE.Mesh(geometry, material),
    counts = [3, 6, 3, 6, 3, 9],
    centers = [
      [0, 0, -10],
      [0, 0, 10],
      [80, 0, -10],
      [10.7, 0, -10],
      [0, 0, -150],
      [-15, 0, -30],
    ],
    positions = [],
    indices = [],
    parts = [];
  let start = 0;
  for (const [partIndex, count] of counts.entries()) {
    const [x, y, z] = centers[partIndex];
    for (let i = 0; i < count / 3; i++) {
      const vertex = positions.length / 3;
      positions.push(x - 0.2, y, z, x + 0.2, y, z, x, y + 0.2 + i * 0.02, z);
      indices.push(vertex + 2, vertex, vertex + 1);
    }
    parts.push({ start, count, sphere: new THREE.Sphere(new THREE.Vector3(x, y, z), 1) });
    start += count;
  }
  // An indexed mesh may retain vertices outside every drawn source range.
  if (indexed) positions.push(1e6, -0, -1e6);
  const buffer = new ArrayBuffer(16 + positions.length * Float32Array.BYTES_PER_ELEMENT),
    packedPosition = new Float32Array(buffer, 8, positions.length);
  packedPosition.set(positions);
  geometry.setAttribute('position', new THREE.BufferAttribute(packedPosition, 3));
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      positions.map((_, i) => i / 71),
      3,
    ),
  );
  geometry.setAttribute(
    'sourceTint',
    new THREE.Uint8BufferAttribute(
      positions.map((_, i) => i % 256),
      3,
      true,
    ),
  );
  if (indexed) geometry.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
  geometry.addGroup(0, start, 0);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-100, -1, -151), new THREE.Vector3(81, 1, 11));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(17, 2, -61), 201);
  geometry.userData.sourceId = 'unchanged-merged-source';
  scene.add(mesh);
  return {
    scene,
    geometry,
    material,
    mesh,
    parts,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function cameras(coordinateSystem = THREE.WebGLCoordinateSystem, reversedDepth = false) {
  const view = new THREE.PerspectiveCamera(90, 1, 1, 100),
    shadow = new THREE.OrthographicCamera(-5, 5, 5, -5, 1, 100),
    empty = view.clone();
  shadow.rotation.y = Math.PI;
  empty.position.set(10000, 10000, 10000);
  for (const camera of [view, shadow, empty]) {
    camera.coordinateSystem = coordinateSystem;
    camera._reversedDepth = reversedDepth;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  return { view, shadow, empty };
}

test('static cells retain separate view and shadow eligibility without changing immutable commands', () => {
  const f = fixture(),
    { view } = cameras(),
    draw = createStaticCellDraws(f.mesh, f.parts),
    commands = bytes(f.geometry.indirect.array),
    version = f.geometry.indirect.version;
  try {
    draw.setShadowVisibleAt(0, false);
    draw.setVisibleAt(1, false);
    f.mesh.onBeforeRender({}, f.scene, view);
    assert.ok(selectedParts(f.geometry).includes(0), 'view retains a piece that casts no shadow');
    const before = selectedParts(f.geometry);
    f.mesh.onBeforeShadow({}, null, view, view);
    f.mesh.onBeforeRender({}, f.scene, view);
    assert.ok(!selectedParts(f.geometry).includes(0));
    assert.ok(!selectedParts(f.geometry).includes(1));
    f.mesh.onAfterShadow();
    assert.deepEqual(selectedParts(f.geometry), before);
    draw.setShadowVisibleAt(0, true);
    f.mesh.onBeforeShadow({}, null, view, view);
    f.mesh.onBeforeRender({}, f.scene, view);
    assert.ok(selectedParts(f.geometry).includes(0));
    f.mesh.onAfterShadow();
    assert.deepEqual(bytes(f.geometry.indirect.array), commands);
    assert.equal(f.geometry.indirect.version, version);
    assert.throws(() => draw.setVisibleAt(-1, false), RangeError);
    assert.throws(() => draw.setShadowVisibleAt(f.parts.length, false), RangeError);
  } finally {
    draw.dispose();
    f.dispose();
  }
});

function selectedParts(geometry) {
  const stride = geometry.index ? 5 : 4;
  return geometry.indirectOffset.map((offset) => offset / (stride * Uint32Array.BYTES_PER_ELEMENT));
}

function sourceSnapshot(f) {
  return {
    geometry: f.mesh.geometry,
    material: f.mesh.material,
    attributes: new Map(
      [...Object.entries(f.geometry.attributes), ['index', f.geometry.index]]
        .filter(([, attribute]) => attribute)
        .map(([name, attribute]) => [
          name,
          {
            attribute,
            array: attribute.array,
            bytes: bytes(attribute.array),
            version: attribute.version,
            ranges: structuredClone(attribute.updateRanges),
            normalized: attribute.normalized,
            usage: attribute.usage,
          },
        ]),
    ),
    groups: structuredClone(f.geometry.groups),
    drawRange: { ...f.geometry.drawRange },
    userData: structuredClone(f.geometry.userData),
    box: f.geometry.boundingBox,
    sphere: f.geometry.boundingSphere,
    bounds: bytes(
      new Float64Array([
        ...f.geometry.boundingBox.min.toArray(),
        ...f.geometry.boundingBox.max.toArray(),
        ...f.geometry.boundingSphere.center.toArray(),
        f.geometry.boundingSphere.radius,
      ]),
    ),
    parts: f.parts.map(({ start, count, sphere }) => ({ start, count, sphere: sphere.clone() })),
    visible: f.mesh.visible,
  };
}

function assertSourceUnchanged(f, original) {
  assert.equal(f.mesh.geometry, original.geometry);
  assert.equal(f.mesh.material, original.material);
  for (const [name, old] of original.attributes) {
    const attribute = name === 'index' ? f.geometry.index : f.geometry.attributes[name];
    assert.equal(attribute, old.attribute, `${name} attribute identity`);
    assert.equal(attribute.array, old.array, `${name} array identity`);
    assert.deepEqual(bytes(attribute.array), old.bytes, `${name} source bytes`);
    assert.equal(attribute.version, old.version, `${name} upload version`);
    assert.deepEqual(attribute.updateRanges, old.ranges);
    assert.equal(attribute.normalized, old.normalized);
    assert.equal(attribute.usage, old.usage);
  }
  assert.deepEqual(f.geometry.groups, original.groups);
  assert.deepEqual(f.geometry.drawRange, original.drawRange);
  assert.deepEqual(f.geometry.userData, original.userData);
  assert.equal(f.geometry.boundingBox, original.box);
  assert.equal(f.geometry.boundingSphere, original.sphere);
  const current = sourceSnapshot(f);
  assert.deepEqual(current.bounds, original.bounds);
  assert.deepEqual(f.parts, original.parts);
  assert.equal(f.mesh.visible, original.visible, 'selection never globally hides the source');
}

for (const indexed of [true, false])
  test(`static ${indexed ? 'indexed' : 'nonindexed'} commands preserve complete source ranges and GPU inputs`, () => {
    const f = fixture(indexed),
      original = sourceSnapshot(f),
      renderer = { name: 'actual pass renderer' },
      passes = [],
      { view, shadow, empty } = cameras(),
      draw = createStaticCellDraws(f.mesh, f.parts, {
        onPass: (pass) => passes.push({ ...pass, selected: selectedParts(f.geometry) }),
      }),
      indirect = f.geometry.indirect,
      commandBytes = bytes(indirect.array),
      commandVersion = indirect.version;
    try {
      assert.equal(indirect.isIndirectStorageBufferAttribute, true);
      assert.deepEqual(
        Array.from(indirect.array),
        f.parts.flatMap(({ start, count }) => (indexed ? [count, 1, start, 0, 0] : [count, 1, start, 0])),
      );
      assert.deepEqual(selectedParts(f.geometry), [0, 1, 2, 3, 4, 5]);
      assert.deepEqual(draw.stats, { sourceTriangles: 10, currentDraws: 6, currentTriangles: 10 });
      assert.equal(f.mesh.frustumCulled, false);
      f.mesh.onBeforeRender(renderer, f.scene, view, f.geometry, f.material);
      assert.deepEqual(selectedParts(f.geometry), [0, 3, 5], 'the grazing sphere remains visible');
      assert.deepEqual(draw.stats, { sourceTriangles: 10, currentDraws: 3, currentTriangles: 6 });
      f.mesh.onBeforeShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material);
      assert.equal(passes.length, 1, 'selecting a shadow camera is not an additional draw');
      f.mesh.onBeforeRender(renderer, f.scene, shadow, f.geometry, f.material);
      assert.deepEqual(selectedParts(f.geometry), [1]);
      f.mesh.onAfterShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material);
      assert.deepEqual(selectedParts(f.geometry), [0, 3, 5]);
      assert.equal(passes.length, 2, 'selection restoration is not an additional draw');
      f.mesh.onBeforeRender(renderer, f.scene, empty, f.geometry, f.material);
      assert.deepEqual(selectedParts(f.geometry), []);
      assert.equal(f.mesh.visible, true);
      f.mesh.onBeforeRender(renderer, f.scene, view, f.geometry, f.material);
      assert.deepEqual(selectedParts(f.geometry), [0, 3, 5], 'an empty pass does not block the next view');
      assert.deepEqual(passes, [
        { renderer, draws: 3, triangles: 6, sourceTriangles: 10, selected: [0, 3, 5] },
        { renderer, draws: 1, triangles: 2, sourceTriangles: 10, selected: [1] },
        { renderer, draws: 0, triangles: 0, sourceTriangles: 10, selected: [] },
        { renderer, draws: 3, triangles: 6, sourceTriangles: 10, selected: [0, 3, 5] },
      ]);
      assert.equal(f.geometry.indirect, indirect);
      assert.equal(indirect.version, commandVersion, 'camera selection never dirties commands');
      assert.deepEqual(bytes(indirect.array), commandBytes);
      assertSourceUnchanged(f, original);
    } finally {
      draw.dispose();
      f.dispose();
    }
  });

test('view culling follows parent transforms, camera coordinates and reversed depth', () => {
  const f = fixture(),
    draw = createStaticCellDraws(f.mesh, f.parts);
  try {
    for (const coordinateSystem of [THREE.WebGLCoordinateSystem, THREE.WebGPUCoordinateSystem])
      for (const reversedDepth of [false, true]) {
        const { view } = cameras(coordinateSystem, reversedDepth);
        f.mesh.position.set(-80, 0, 0);
        f.scene.position.set(0, 0, 0);
        f.scene.rotation.set(0, 0, 0);
        f.scene.scale.set(1, 1, 1);
        f.scene.updateMatrixWorld(true);
        f.mesh.onBeforeRender(null, f.scene, view);
        assert.deepEqual(selectedParts(f.geometry), [2]);
        f.scene.position.x = 80;
        f.scene.scale.set(2, 1, 2);
        f.mesh.position.set(-40, 0, 0);
        f.scene.updateMatrixWorld(true);
        f.mesh.onBeforeRender(null, f.scene, view);
        assert.deepEqual(selectedParts(f.geometry), [0, 3, 5]);
        f.scene.position.x = 0;
        f.scene.scale.set(1, 1, 1);
        f.scene.rotation.y = Math.PI;
        f.mesh.position.set(0, 0, 0);
        f.scene.updateMatrixWorld(true);
        f.mesh.onBeforeRender(null, f.scene, view);
        assert.deepEqual(selectedParts(f.geometry), [1]);
      }
  } finally {
    draw.dispose();
    f.dispose();
  }
});

test('nested shadow passes restore exact prior ranges, including an empty pending view', () => {
  const f = fixture(),
    { view, shadow, empty } = cameras(),
    passes = [],
    draw = createStaticCellDraws(f.mesh, f.parts, { onPass: (pass) => passes.push(pass) }),
    offsets = f.geometry.indirectOffset;
  try {
    f.mesh.onBeforeRender(null, f.scene, view);
    const viewOffsets = offsets.slice();
    f.mesh.onBeforeShadow(null, f.mesh, shadow, shadow);
    f.mesh.onBeforeRender(null, f.scene, shadow);
    const lightOffsets = offsets.slice();
    f.mesh.onBeforeShadow(null, f.mesh, empty, empty);
    f.mesh.onBeforeRender(null, f.scene, empty);
    assert.deepEqual(offsets, []);
    shadow.position.set(10000, 0, 0);
    shadow.updateMatrixWorld();
    f.mesh.onAfterShadow(null, f.mesh, empty, empty);
    assert.equal(f.geometry.indirectOffset, offsets, 'the renderer retains one mutable offset array');
    assert.deepEqual(
      offsets,
      lightOffsets,
      'restore the interrupted selection without re-querying its changed camera',
    );
    assert.equal(draw.stats.currentTriangles, 2);
    f.mesh.onAfterShadow(null, f.mesh, shadow, shadow);
    assert.deepEqual(offsets, viewOffsets);
    assert.equal(draw.stats.currentTriangles, 6);
    f.mesh.onBeforeRender(null, f.scene, empty);
    shadow.position.set(0, 0, 0);
    shadow.updateMatrixWorld();
    f.mesh.onBeforeShadow(null, f.mesh, shadow, shadow);
    f.mesh.onBeforeRender(null, f.scene, shadow);
    assert.deepEqual(selectedParts(f.geometry), [1]);
    f.mesh.onAfterShadow(null, f.mesh, shadow, shadow);
    assert.deepEqual(offsets, []);
    assert.equal(draw.stats.currentTriangles, 0);
    assert.equal(passes.length, 5, 'only five actual before-render calls report passes');
  } finally {
    draw.dispose();
    f.dispose();
  }
});

test('a first shadow draw restores the full source and callback failures cannot strand its selection', () => {
  const f = fixture(),
    { view, shadow } = cameras(),
    failure = new Error('original after-shadow callback failed'),
    calls = [],
    renderer = {};
  const before = function (...args) {
      calls.push({ name: 'before', owner: this, args });
    },
    beforeShadow = function (...args) {
      calls.push({ name: 'before shadow', owner: this, args });
    },
    afterShadow = function (...args) {
      calls.push({ name: 'after shadow', owner: this, args });
      throw failure;
    };
  f.mesh.onBeforeRender = before;
  f.mesh.onBeforeShadow = beforeShadow;
  f.mesh.onAfterShadow = afterShadow;
  const draw = createStaticCellDraws(f.mesh, f.parts);
  try {
    const group = { start: 0, count: 3 };
    f.mesh.onBeforeShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material, group);
    f.mesh.onBeforeRender(renderer, f.scene, shadow, f.geometry, f.material, group);
    assert.deepEqual(selectedParts(f.geometry), [1]);
    assert.throws(
      () => f.mesh.onAfterShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material, group),
      (error) => error === failure,
    );
    assert.deepEqual(selectedParts(f.geometry), [0, 1, 2, 3, 4, 5]);
    assert.equal(draw.stats.currentTriangles, 10);
    f.mesh.onBeforeRender(renderer, f.scene, view, f.geometry, f.material, group);
    f.mesh.onBeforeShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material, group);
    assert.throws(
      () => f.mesh.onAfterShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material, group),
      (error) => error === failure,
    );
    assert.deepEqual(selectedParts(f.geometry), [0, 3, 5]);
    assert.deepEqual(
      calls.slice(0, 3).map(({ name }) => name),
      ['before shadow', 'before', 'after shadow'],
    );
    assert.ok(calls.every(({ owner }) => owner === f.mesh));
    assert.deepEqual(calls[0].args, [renderer, f.mesh, shadow, shadow, f.geometry, f.material, group]);
    assert.deepEqual(calls[1].args, [renderer, f.scene, shadow, f.geometry, f.material, group]);
    assert.deepEqual(calls[2].args, calls[0].args);
  } finally {
    draw.dispose();
    assert.equal(f.mesh.onBeforeRender, before);
    assert.equal(f.mesh.onBeforeShadow, beforeShadow);
    assert.equal(f.mesh.onAfterShadow, afterShadow);
    f.dispose();
  }
});

test('beginFrame recovers abandoned real Three shadow draws without retaining earlier frame selections', () => {
  const f = fixture(),
    original = sourceSnapshot(f),
    { view, shadow, empty } = cameras(),
    light = new THREE.DirectionalLight(),
    failure = new Error('shadow GPU submission failed'),
    passes = [];
  let throwDraw = true,
    afterCalls = 0;
  f.mesh.castShadow = true;
  f.mesh.onAfterShadow = () => afterCalls++;
  light.shadow.camera = shadow;
  const renderer = {
      shadowMap: { type: THREE.PCFShadowMap },
      getMRT: () => null,
      renderObject(object, scene, camera, geometry, material, group) {
        assert.equal(camera, shadow, 'ShadowNode renders with the actual light camera');
        object.onBeforeRender(this, scene, camera, geometry, material, group);
        if (throwDraw) throw failure;
      },
    },
    node = new ShadowBaseNode(light),
    renderShadowObject = node.getShadowRenderObjectFunction(renderer),
    draw = createStaticCellDraws(f.mesh, f.parts, { onPass: (pass) => passes.push(pass) }),
    indirect = f.geometry.indirect,
    commands = bytes(indirect.array),
    commandVersion = indirect.version,
    offsets = f.geometry.indirectOffset,
    renderShadow = () =>
      renderShadowObject(f.mesh, f.scene, shadow, f.geometry, f.material, null, null, null, 'shadow');
  try {
    // Two interrupted nested draws must restore the oldest complete selection.
    for (let i = 0; i < 2; i++) assert.throws(renderShadow, (error) => error === failure);
    assert.equal(afterCalls, 0, 'the installed Three callback skips onAfterShadow when drawing throws');
    assert.deepEqual(selectedParts(f.geometry), [1]);
    draw.beginFrame();
    assert.deepEqual(selectedParts(f.geometry), [0, 1, 2, 3, 4, 5]);
    assert.equal(draw.stats.currentTriangles, 10);

    for (let frame = 0; frame < 32; frame++) {
      const priorCamera = frame % 2 ? empty : view,
        nextCamera = frame % 2 ? view : empty;
      f.mesh.onBeforeRender(renderer, f.scene, priorCamera, f.geometry, f.material);
      const priorOffsets = offsets.slice(),
        priorTriangles = draw.stats.currentTriangles,
        priorAfterCalls = afterCalls,
        priorPasses = passes.length;
      assert.throws(renderShadow, (error) => error === failure);
      assert.equal(afterCalls, priorAfterCalls);
      assert.equal(
        passes.length,
        priorPasses + 1,
        'the failed draw reaches one actual before-render callback',
      );
      assert.deepEqual(selectedParts(f.geometry), [1]);

      // Even before the frame boundary, every render uses its actual camera.
      f.mesh.onBeforeRender(renderer, f.scene, nextCamera, f.geometry, f.material);
      assert.deepEqual(selectedParts(f.geometry), nextCamera === view ? [0, 3, 5] : []);
      const passesBeforeRecovery = passes.length;
      draw.beginFrame();
      assert.equal(f.geometry.indirectOffset, offsets);
      assert.deepEqual(offsets, priorOffsets, 'recover this frame rather than any older abandoned snapshot');
      assert.equal(draw.stats.currentTriangles, priorTriangles);
      assert.equal(passes.length, passesBeforeRecovery, 'frame recovery does not count as a draw');

      // A normal frame boundary must not read matrices or perform culling.
      const matrixWorld = f.mesh.matrixWorld;
      f.mesh.matrixWorld = new Proxy(matrixWorld, {
        get() {
          throw new Error('normal beginFrame must not inspect transforms');
        },
      });
      try {
        draw.beginFrame();
      } finally {
        f.mesh.matrixWorld = matrixWorld;
      }

      f.mesh.onBeforeRender(renderer, f.scene, nextCamera, f.geometry, f.material);
      const nextOffsets = offsets.slice();
      f.mesh.onAfterShadow(renderer, f.mesh, shadow, shadow, f.geometry, f.material);
      assert.deepEqual(offsets, nextOffsets, 'cleared shadow depth cannot pop a previous frame snapshot');
    }
    throwDraw = false;
    f.mesh.onBeforeRender(renderer, f.scene, view, f.geometry, f.material);
    const viewOffsets = offsets.slice(),
      beforeSuccess = afterCalls;
    renderShadow();
    assert.equal(afterCalls, beforeSuccess + 1);
    assert.deepEqual(offsets, viewOffsets, 'normal shadow completion still restores the pending view');
    draw.beginFrame();
    assert.deepEqual(offsets, viewOffsets);
    assert.equal(indirect.version, commandVersion);
    assert.deepEqual(bytes(indirect.array), commands);
    assertSourceUnchanged(f, original);
  } finally {
    draw.dispose();
    f.dispose();
  }
});

test('dispose restores prior indirect state and callbacks without disposing shared source assets', () => {
  const f = fixture(),
    original = sourceSnapshot(f),
    priorIndirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array([30, 1, 0, 0, 0]), 1),
    priorOffsets = [0],
    before = f.mesh.onBeforeRender,
    beforeShadow = f.mesh.onBeforeShadow,
    afterShadow = f.mesh.onAfterShadow,
    { view, shadow } = cameras();
  let geometryDisposals = 0,
    materialDisposals = 0;
  f.geometry.addEventListener('dispose', () => geometryDisposals++);
  f.material.addEventListener('dispose', () => materialDisposals++);
  f.geometry.setIndirect(priorIndirect, priorOffsets);
  const draw = createStaticCellDraws(f.mesh, f.parts);
  try {
    assert.throws(
      () => createStaticCellDraws(new THREE.Mesh(f.geometry, f.material), f.parts),
      /one geometry owner/,
    );
    f.mesh.onBeforeRender(null, f.scene, view);
    f.mesh.onBeforeShadow(null, f.mesh, shadow, shadow);
    draw.dispose();
    draw.dispose();
    assert.equal(f.geometry.indirect, priorIndirect);
    assert.equal(f.geometry.indirectOffset, priorOffsets);
    assert.equal(f.mesh.frustumCulled, true);
    assert.equal(f.mesh.onBeforeRender, before);
    assert.equal(f.mesh.onBeforeShadow, beforeShadow);
    assert.equal(f.mesh.onAfterShadow, afterShadow);
    assert.equal(geometryDisposals, 0);
    assert.equal(materialDisposals, 0);
    assertSourceUnchanged(f, original);
    const next = createStaticCellDraws(f.mesh, f.parts);
    next.dispose();
    assert.equal(f.geometry.indirect, priorIndirect);
    assert.equal(f.geometry.indirectOffset, priorOffsets);
  } finally {
    draw.dispose();
    f.dispose();
  }
});

test('malformed or incomplete ranges fail before changing source ownership or callbacks', () => {
  const f = fixture(),
    original = sourceSnapshot(f),
    before = f.mesh.onBeforeRender;
  try {
    const invalid = [
      f.parts.slice(0, -1),
      f.parts.map((part, i) => (i === 1 ? { ...part, start: part.start + 3 } : part)),
      f.parts.map((part, i) => (i === 1 ? { ...part, start: part.start - 3 } : part)),
      f.parts.map((part, i) => (i === 0 ? { ...part, count: 2 } : part)),
      f.parts.map((part, i) => (i === 0 ? { ...part, count: 0 } : part)),
      f.parts.map((part, i) => (i === 0 ? { ...part, count: Infinity } : part)),
      f.parts.map((part, i) =>
        i === 0 ? { ...part, sphere: new THREE.Sphere(new THREE.Vector3(NaN, 0, 0), 1) } : part,
      ),
      f.parts.map((part, i) =>
        i === 0 ? { ...part, sphere: new THREE.Sphere(new THREE.Vector3(), -1) } : part,
      ),
      [...f.parts].reverse(),
    ];
    for (const parts of invalid) {
      assert.throws(() => createStaticCellDraws(f.mesh, parts), /static cell|Static cells/);
      assert.equal(f.geometry.indirect, null);
      assert.equal(f.mesh.onBeforeRender, before);
      assert.equal(f.mesh.frustumCulled, true);
      assertSourceUnchanged(f, original);
    }
    f.geometry.setDrawRange(3, 27);
    assert.throws(() => createStaticCellDraws(f.mesh, f.parts), /configuration/);
    f.geometry.setDrawRange(0, Infinity);
    assert.throws(
      () => createStaticCellDraws(new THREE.InstancedMesh(f.geometry, f.material, 1), f.parts),
      /configuration/,
    );
    assert.throws(
      () => createStaticCellDraws(new THREE.Mesh(f.geometry, [f.material]), f.parts),
      /configuration/,
    );
    const emptyGeometry = new THREE.BufferGeometry();
    emptyGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const emptyMesh = new THREE.Mesh(emptyGeometry, f.material),
      emptyBefore = emptyMesh.onBeforeRender;
    try {
      assert.throws(() => createStaticCellDraws(emptyMesh, []), /configuration/);
      assert.equal(emptyGeometry.indirect, null, 'empty input never creates an empty GPU command buffer');
      assert.equal(emptyMesh.onBeforeRender, emptyBefore);
      assert.equal(emptyMesh.frustumCulled, true);
    } finally {
      emptyGeometry.dispose();
    }
    const draw = createStaticCellDraws(f.mesh, f.parts);
    draw.dispose();
  } finally {
    f.dispose();
  }
});
