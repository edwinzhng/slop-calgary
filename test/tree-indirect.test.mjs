import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three/webgpu';
import { createIndirectCellDraws, treeBoundsExpansion } from '../app/vegetation-cells.js';
import { TREE_WIND_LIMITS, treeWindBoundsPadding } from '../app/reference-tree-material.js';
import { prepareInstanceMatrices } from '../app/render-instances.js';

function fixture({ indexed = true } = {}) {
  const scene = new THREE.Scene(),
    box = new THREE.BoxGeometry(),
    geometry = indexed ? box : box.toNonIndexed(),
    material = new THREE.MeshBasicNodeMaterial(),
    mesh = new THREE.InstancedMesh(geometry, material, 6),
    poses = [
      [800, -10],
      [0, 10],
      [0, -10],
      [800, -10],
      [0, -10],
      [0, 10],
    ],
    matrix = new THREE.Matrix4(),
    color = new THREE.Color();
  if (!indexed) box.dispose();
  geometry.setAttribute('aTreeData', new THREE.InstancedBufferAttribute(new Float32Array(24), 4));
  geometry.setAttribute('aTreeShape', new THREE.InstancedBufferAttribute(new Float32Array(12), 2));
  geometry.setAttribute('sourceId', new THREE.InstancedBufferAttribute(new Uint32Array(6), 1));
  geometry.attributes.sourceId.gpuType = THREE.IntType;
  geometry.setAttribute('packedTint', new THREE.InstancedBufferAttribute(new Uint8Array(18), 3, true));
  for (let i = 0; i < poses.length; i++) {
    mesh.setMatrixAt(i, matrix.makeTranslation(poses[i][0], i * 0.01, poses[i][1]));
    mesh.setColorAt(i, color.setRGB((i + 1) / 7, (6 - i) / 7, i / 6));
    geometry.attributes.aTreeData.setXYZW(i, i / 7, i / 9, i / 11, i + 0.123);
    geometry.attributes.aTreeShape.setXY(i, i + 0.5, i / 3);
    geometry.attributes.sourceId.array[i] = 0x1000000 + i;
    geometry.attributes.packedTint.array.set([i * 41, i * 19, i * 7], i * 3);
  }
  scene.add(mesh);
  return {
    scene,
    mesh,
    geometry,
    material,
    dispose() {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

function instanceAttributes(mesh) {
  return [
    mesh.instanceMatrix,
    mesh.instanceColor,
    ...Object.values(mesh.geometry.attributes).filter((attribute) => attribute.isInstancedBufferAttribute),
  ].filter(Boolean);
}

// Hash complete records together. Separately comparing attribute arrays would
// miss a tree receiving another tree's transform, colour or measured trunk.
function recordMultiset(mesh, count = mesh.count) {
  const attributes = instanceAttributes(mesh),
    records = [];
  for (let i = 0; i < count; i++) {
    const hash = createHash('sha256');
    for (const attribute of attributes) {
      const size = attribute.array.BYTES_PER_ELEMENT;
      hash.update(
        new Uint8Array(
          attribute.array.buffer,
          attribute.array.byteOffset + i * attribute.itemSize * size,
          attribute.itemSize * size,
        ),
      );
    }
    records.push(hash.digest('hex'));
  }
  return records.sort();
}

function selectedSources(draw, mesh) {
  const stride = mesh.geometry.index ? 5 : 4,
    records = [];
  for (const offset of draw.offsets) {
    const command = offset / Uint32Array.BYTES_PER_ELEMENT,
      count = draw.indirect.array[command + 1],
      first = draw.indirect.array[command + stride - 1];
    for (let i = first; i < first + count; i++) records.push(mesh.geometry.attributes.sourceId.array[i]);
  }
  return records.sort((a, b) => a - b);
}

function cameras() {
  const view = new THREE.PerspectiveCamera(55, 1.6, 0.2, 100),
    shadow = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.2, 100),
    empty = view.clone();
  shadow.rotation.y = Math.PI;
  empty.rotation.y = Math.PI / 2;
  for (const camera of [view, shadow, empty]) camera.updateMatrixWorld();
  return { view, shadow, empty };
}

test('cell packing preserves complete raw tree records, geometry and material ownership', () => {
  const f = fixture();
  try {
    prepareInstanceMatrices(f.scene, true);
    const expected = recordMultiset(f.mesh),
      attributes = instanceAttributes(f.mesh),
      arrays = attributes.map((attribute) => attribute.array),
      staticPositions = f.geometry.attributes.position.array.slice(),
      staticIndices = f.geometry.index.array.slice(),
      draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    assert.deepEqual(recordMultiset(f.mesh), expected);
    assert.equal(f.mesh.geometry, f.geometry);
    assert.equal(f.mesh.material, f.material);
    assert.equal(f.mesh.count, 6);
    assert.equal(draw.stats.cells, 3);
    assert.equal(draw.stats.selected, 6);
    assert.equal(draw.indirect.array.byteLength, 8 * 5 * Uint32Array.BYTES_PER_ELEMENT);
    assert.deepEqual(f.geometry.attributes.position.array, staticPositions);
    assert.deepEqual(f.geometry.index.array, staticIndices);
    instanceAttributes(f.mesh).forEach((attribute, i) => {
      assert.equal(attribute, attributes[i]);
      assert.equal(attribute.array, arrays[i], 'packing must reuse the existing buffers');
    });
    assert.equal(f.geometry.attributes.sourceId.gpuType, THREE.IntType);
    assert.equal(f.geometry.attributes.packedTint.normalized, true);

    // Real tree pools reserve more slots than the current selected set.
    // Repacking that prefix must not overwrite records outside the draw.
    f.mesh.count = 4;
    const selected = recordMultiset(f.mesh),
      tails = instanceAttributes(f.mesh).map((attribute) => attribute.array.slice(4 * attribute.itemSize));
    draw.repack();
    assert.deepEqual(recordMultiset(f.mesh), selected);
    instanceAttributes(f.mesh).forEach((attribute, i) => {
      assert.deepEqual(attribute.array.subarray(4 * attribute.itemSize), tails[i]);
    });
  } finally {
    f.dispose();
  }
});

test('view and shadow callbacks independently select source records without rewriting GPU input', () => {
  const f = fixture(),
    { view, shadow, empty } = cameras();
  try {
    prepareInstanceMatrices(f.scene, true);
    const draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    const attributes = [...instanceAttributes(f.mesh), draw.indirect],
      snapshots = attributes.map((attribute) => ({
        version: attribute.version,
        array: attribute.array.slice(),
      }));
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
    assert.equal(f.mesh.count, 2);
    assert.ok(draw.indirect.array[draw.offsets[0] / 4 + 4] > 0, 'view uses a nonzero firstInstance');
    const viewOffsets = draw.offsets.slice();

    // Match ShadowBaseNode's callback order. Deliberately pass the original
    // view to onBeforeRender to verify that the explicit light camera wins.
    f.mesh.onBeforeShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000001, 0x1000005]);
    assert.equal(f.mesh.count, 2);
    f.mesh.onAfterShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    assert.deepEqual(draw.offsets, viewOffsets, 'a nested light render must restore the pending view draw');
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
    assert.equal(f.mesh.count, 2);
    f.mesh.onBeforeRender(null, f.scene, empty, f.geometry, f.material);
    assert.equal(f.mesh.count, 0);
    assert.equal(draw.offsets.length, 0);
    assert.equal(f.mesh.visible, true, 'a zero-count view must not hide the mesh from later passes');
    f.mesh.onBeforeShadow(null, f.mesh, empty, shadow, f.geometry, f.material);
    f.mesh.onBeforeRender(null, f.scene, empty, f.geometry, f.material);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000001, 0x1000005]);
    f.mesh.onAfterShadow(null, f.mesh, empty, shadow, f.geometry, f.material);
    assert.equal(f.mesh.count, 0, 'restore a zero-count view after a nonempty shadow pass');
    assert.equal(draw.offsets.length, 0);
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
    attributes.forEach((attribute, i) => {
      assert.equal(attribute.version, snapshots[i].version);
      assert.deepEqual(attribute.array, snapshots[i].array);
    });
  } finally {
    f.dispose();
  }
});

test('nested light cameras restore the previous light and then the pending view', () => {
  const f = fixture(),
    { view, shadow, empty } = cameras();
  try {
    const draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    const viewOffsets = draw.offsets.slice();
    f.mesh.onBeforeShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    const shadowOffsets = draw.offsets.slice();
    f.mesh.onBeforeShadow(null, f.mesh, shadow, empty, f.geometry, f.material);
    f.mesh.onBeforeRender(null, f.scene, shadow, f.geometry, f.material);
    assert.equal(f.mesh.count, 0);
    assert.equal(draw.offsets.length, 0);
    f.mesh.onAfterShadow(null, f.mesh, shadow, empty, f.geometry, f.material);
    assert.deepEqual(draw.offsets, shadowOffsets);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000001, 0x1000005]);
    assert.equal(f.mesh.count, 2);
    f.mesh.onAfterShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    assert.deepEqual(draw.offsets, viewOffsets);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
    assert.equal(f.mesh.count, 2);
  } finally {
    f.dispose();
  }
});

test('a light pass before the first view restores the complete selected pool', () => {
  const f = fixture(),
    { view, shadow } = cameras();
  try {
    const draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    f.mesh.onBeforeShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000001, 0x1000005]);
    f.mesh.onAfterShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    assert.equal(f.mesh.count, 6);
    assert.deepEqual(
      selectedSources(draw, f.mesh),
      [0x1000000, 0x1000001, 0x1000002, 0x1000003, 0x1000004, 0x1000005],
    );
  } finally {
    f.dispose();
  }
});

test('a throwing original shadow callback still restores the pending view selection', () => {
  const f = fixture(),
    { view, shadow } = cameras(),
    failure = new Error('original callback failed');
  f.mesh.onAfterShadow = () => {
    throw failure;
  };
  try {
    const draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    const offsets = draw.offsets.slice();
    f.mesh.onBeforeShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    assert.throws(() => f.mesh.onAfterShadow(null, f.mesh, view, shadow, f.geometry, f.material), failure);
    assert.deepEqual(draw.offsets, offsets);
    assert.equal(f.mesh.count, 2);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
  } finally {
    f.dispose();
  }
});

test('tree cell selection accounts for the mesh and parent world transforms', () => {
  const f = fixture(),
    { view } = cameras();
  try {
    const draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    f.mesh.position.x = -800;
    f.scene.updateMatrixWorld();
    draw.select(view);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000000, 0x1000003]);
    f.scene.position.x = 800;
    f.scene.updateMatrixWorld();
    draw.select(view);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
  } finally {
    f.dispose();
  }
});

test('later tree repacks write and version the instanceMatrix installed by startup preparation', () => {
  const f = fixture();
  try {
    const draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    const original = f.mesh.instanceMatrix,
      version = original.version,
      array = original.array;
    prepareInstanceMatrices(f.scene, true);
    const storage = f.mesh.instanceMatrix;
    assert.notEqual(storage, original);
    assert.equal(storage.array, array);
    f.mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-800, 7, -10));
    const expected = recordMultiset(f.mesh);
    draw.repack();
    assert.equal(original.version, version, 'the replaced attribute must not receive updates');
    assert.ok(storage.version > 0);
    assert.deepEqual(storage.updateRanges, [{ start: 0, count: 6 * 16 }]);
    assert.deepEqual(recordMultiset(f.mesh), expected);
    assert.ok(Array.from(storage.array).includes(-800));
  } finally {
    f.dispose();
  }
});

test('disabling after a culled view restores all records and the original callbacks', () => {
  const f = fixture(),
    { view, shadow } = cameras(),
    calls = [];
  const before = function (...args) {
      calls.push({ name: 'view', owner: this, args });
    },
    beforeShadow = function (...args) {
      calls.push({ name: 'before shadow', owner: this, args });
    },
    afterShadow = function (...args) {
      calls.push({ name: 'after shadow', owner: this, args });
    };
  f.mesh.onBeforeRender = before;
  f.mesh.onBeforeShadow = beforeShadow;
  f.mesh.onAfterShadow = afterShadow;
  f.mesh.frustumCulled = true;
  try {
    const expected = recordMultiset(f.mesh),
      draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    calls.length = 0;
    f.mesh.onBeforeShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    f.mesh.onAfterShadow(null, f.mesh, view, shadow, f.geometry, f.material);
    assert.deepEqual(
      calls.map((call) => call.name),
      ['before shadow', 'view', 'after shadow'],
    );
    assert.ok(calls.every((call) => call.owner === f.mesh));
    assert.equal(calls[0].args[3], shadow);
    assert.equal(calls[1].args[2], view);
    assert.equal(f.mesh.count, 2);
    draw.disable();
    assert.equal(f.mesh.count, 6);
    assert.equal(f.geometry.indirect, null);
    assert.deepEqual(recordMultiset(f.mesh), expected);
    assert.equal(f.mesh.onBeforeRender, before);
    assert.equal(f.mesh.onBeforeShadow, beforeShadow);
    assert.equal(f.mesh.onAfterShadow, afterShadow);
    assert.equal(f.mesh.frustumCulled, true);
    f.mesh.onBeforeRender(null, f.scene, view, f.geometry, f.material);
    assert.equal(f.mesh.count, 6, 'direct drawing uses the whole packed pool');
    assert.doesNotThrow(
      () => createIndirectCellDraws(f.mesh, { maxCells: 8 }),
      'disabled geometry can be attached again',
    );
  } finally {
    f.dispose();
  }
});

test('disabled feature support leaves direct WebGL-compatible instances untouched', () => {
  const f = fixture();
  try {
    const attributes = instanceAttributes(f.mesh),
      expected = recordMultiset(f.mesh),
      before = f.mesh.onBeforeRender,
      frustumCulled = f.mesh.frustumCulled;
    assert.equal(createIndirectCellDraws(f.mesh, { enabled: false }), null);
    assert.equal(f.geometry.indirect, null);
    assert.equal(f.mesh.count, 6);
    assert.equal(f.mesh.instanceMatrix.isStorageInstancedBufferAttribute, undefined);
    assert.equal(f.mesh.onBeforeRender, before);
    assert.equal(f.mesh.frustumCulled, frustumCulled);
    assert.deepEqual(instanceAttributes(f.mesh), attributes);
    assert.deepEqual(recordMultiset(f.mesh), expected);
  } finally {
    f.dispose();
  }
});

test('a cell-budget overflow falls back before losing any source record', () => {
  const f = fixture();
  try {
    const expected = recordMultiset(f.mesh),
      draw = createIndirectCellDraws(f.mesh, { maxCells: 1 });
    draw.repack();
    assert.equal(f.geometry.indirect, null);
    assert.equal(f.mesh.count, 6);
    assert.deepEqual(recordMultiset(f.mesh), expected);
  } finally {
    f.dispose();
  }
});

test('nonindexed branch instances retain their records and use complete four-word draw commands', () => {
  const f = fixture({ indexed: false }),
    { view } = cameras();
  try {
    const expected = recordMultiset(f.mesh),
      draw = createIndirectCellDraws(f.mesh, { maxCells: 8 });
    draw.repack();
    assert.equal(f.geometry.index, null);
    assert.deepEqual(recordMultiset(f.mesh), expected);
    draw.select(view);
    assert.deepEqual(selectedSources(draw, f.mesh), [0x1000002, 0x1000004]);
    assert.equal(draw.indirect.array[draw.offsets[0] / 4], f.geometry.attributes.position.count);
    assert.equal(draw.indirect.array.byteLength, 8 * 4 * Uint32Array.BYTES_PER_ELEMENT);
  } finally {
    f.dispose();
  }
});

function exactCellBounds(draw) {
  return draw.cells.map((cell) => ({
    key: cell.key,
    first: cell.first,
    count: cell.count,
    bounds: Buffer.from(
      new Float64Array([
        ...cell.box.min.toArray(),
        ...cell.box.max.toArray(),
        ...cell.sphere.center.toArray(),
        cell.sphere.radius,
      ]).buffer,
    ),
  }));
}

for (const indexed of [true, false])
  test(`cached Float64 instance bounds preserve exact ${indexed ? 'indexed' : 'nonindexed'} cells through record permutations`, () => {
    const original = fixture({ indexed }),
      cached = fixture({ indexed }),
      calls = { original: 0, cached: 0 },
      point = new THREE.Vector3();
    const expansion = (name) => (owner, slot, bounds, matrix) => {
      calls[name]++;
      const shape = owner.geometry.attributes.aTreeShape;
      point.set(-shape.getX(slot) * 2.5, shape.getY(slot) * 0.25, 0.75).applyMatrix4(matrix);
      bounds.expandByPoint(point);
    };
    const ordinaryDraw = createIndirectCellDraws(original.mesh, {
        maxCells: 8,
        windPadding: 0.127,
        expandInstanceBounds: expansion('original'),
      }),
      cachedDraw = createIndirectCellDraws(cached.mesh, {
        maxCells: 8,
        windPadding: 0.127,
        expandInstanceBounds: expansion('cached'),
      }),
      source = instanceAttributes(cached.mesh).map((attribute) => attribute.array.slice()),
      bySource = new Map(),
      instanceBounds = new Float64Array(8 * 6).fill(123456.75),
      box = new THREE.Box3(),
      matrix = new THREE.Matrix4(),
      { view, shadow, empty } = cameras();
    try {
      for (let slot = 0; slot < cached.mesh.count; slot++) {
        assert.equal(cachedDraw.instanceBounds(slot, box), box);
        const bounds = new Float64Array([...box.min.toArray(), ...box.max.toArray()]);
        cached.mesh.getMatrixAt(slot, matrix);
        const manual = cached.geometry.boundingBox.clone().applyMatrix4(matrix),
          shape = cached.geometry.attributes.aTreeShape;
        manual.expandByPoint(
          new THREE.Vector3(-shape.getX(slot) * 2.5, shape.getY(slot) * 0.25, 0.75).applyMatrix4(matrix),
        );
        assert.deepEqual(
          Buffer.from(bounds.buffer),
          Buffer.from(new Float64Array([...manual.min.toArray(), ...manual.max.toArray()]).buffer),
          'the public calculation uses current packed transforms and exact expansion',
        );
        bySource.set(cached.geometry.attributes.sourceId.array[slot], bounds);
      }
      assert.equal(calls.cached, 6, 'lazy callers can compute one bound per record');
      for (const order of [
        [0, 1, 2, 3, 4, 5],
        [5, 3, 1, 4, 0, 2],
        [4, 2, 0, 1],
        [0, 2, 4, 1, 3, 5],
      ]) {
        for (const f of [original, cached]) {
          const attributes = instanceAttributes(f.mesh);
          for (let slot = 0; slot < order.length; slot++)
            for (let a = 0; a < attributes.length; a++) {
              const { itemSize, array } = attributes[a],
                first = order[slot] * itemSize;
              array.set(source[a].subarray(first, first + itemSize), slot * itemSize);
            }
          f.mesh.count = order.length;
        }
        for (let slot = 0; slot < order.length; slot++)
          instanceBounds.set(bySource.get(cached.geometry.attributes.sourceId.array[slot]), slot * 6);
        const untouchedTail = instanceBounds.slice(order.length * 6);
        ordinaryDraw.repack();
        cachedDraw.repack({ instanceBounds });
        assert.equal(calls.cached, 6, 'cache repacks never rescan bark');
        assert.deepEqual(
          exactCellBounds(cachedDraw),
          exactCellBounds(ordinaryDraw),
          'cell boxes and spheres are bit-identical after union and wind padding',
        );
        assert.deepEqual(cachedDraw.indirect.array, ordinaryDraw.indirect.array);
        assert.deepEqual(cachedDraw.offsets, ordinaryDraw.offsets);
        assert.deepEqual(recordMultiset(cached.mesh), recordMultiset(original.mesh));
        for (let slot = 0; slot < order.length; slot++)
          assert.deepEqual(
            instanceBounds.subarray(slot * 6, slot * 6 + 6),
            bySource.get(cached.geometry.attributes.sourceId.array[slot]),
            'the CPU bound stays attached to its entire GPU record',
          );
        assert.deepEqual(
          instanceBounds.subarray(order.length * 6),
          untouchedTail,
          'partial populations leave capacity tails untouched',
        );
        const attributes = [...instanceAttributes(cached.mesh), cachedDraw.indirect],
          versions = attributes.map((attribute) => attribute.version),
          boundsSnapshot = instanceBounds.slice();
        for (const draw of [ordinaryDraw, cachedDraw]) {
          draw.select(view);
          const mesh = draw === ordinaryDraw ? original.mesh : cached.mesh,
            scene = draw === ordinaryDraw ? original.scene : cached.scene;
          mesh.onBeforeShadow(null, mesh, view, shadow);
          mesh.onBeforeRender(null, scene, view);
          mesh.onBeforeShadow(null, mesh, shadow, empty);
          mesh.onBeforeRender(null, scene, shadow);
          mesh.onAfterShadow(null, mesh, shadow, empty);
          mesh.onAfterShadow(null, mesh, view, shadow);
        }
        assert.deepEqual(cachedDraw.offsets, ordinaryDraw.offsets);
        assert.deepEqual(
          selectedSources(cachedDraw, cached.mesh),
          selectedSources(ordinaryDraw, original.mesh),
        );
        assert.deepEqual(instanceBounds, boundsSnapshot);
        attributes.forEach((attribute, i) => assert.equal(attribute.version, versions[i]));
      }
    } finally {
      ordinaryDraw.disable();
      cachedDraw.disable();
      original.dispose();
      cached.dispose();
    }
  });

test('incomplete bounds caches retain the original path and disabled draws never permute caller data', () => {
  const f = fixture(),
    box = new THREE.Box3();
  let expansions = 0;
  const draw = createIndirectCellDraws(f.mesh, { maxCells: 8, expandInstanceBounds: () => expansions++ });
  try {
    const complete = new Float64Array(6 * f.mesh.count);
    for (let slot = 0; slot < f.mesh.count; slot++) {
      draw.instanceBounds(slot, box);
      box.min.toArray(complete, slot * 6);
      box.max.toArray(complete, slot * 6 + 3);
    }
    for (const partial of [undefined, new Float64Array(6), new Float32Array(complete), null]) {
      const before = expansions;
      draw.repack({ instanceBounds: partial });
      assert.equal(expansions - before, 6);
    }
    draw.disable();
    const records = recordMultiset(f.mesh),
      before = complete.slice();
    draw.repack({ instanceBounds: complete });
    assert.deepEqual(complete, before);
    assert.deepEqual(recordMultiset(f.mesh), records);
    const overflow = createIndirectCellDraws(f.mesh, { maxCells: 1 });
    overflow.repack({ instanceBounds: complete });
    assert.equal(overflow.stats.enabled, false);
    assert.deepEqual(complete, before, 'overflow falls back before mutating the optional CPU cache');
    assert.deepEqual(recordMultiset(f.mesh), records);
  } finally {
    draw.disable();
    f.dispose();
  }
});

test('wind and measured low-bark bounds remain conservative facing both directions', () => {
  const geometry = new THREE.BufferGeometry(),
    material = new THREE.MeshBasicNodeMaterial();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-2, 0, 0, 2, 1, 0, 1, 12, 2, -1, 25, -2], 3),
  );
  geometry.setAttribute(
    'aTree',
    new THREE.Float32BufferAttribute([0, 1, 0, 0, 0, 1, 0.2, 0, 1, 0.7, 0.8, 0.4, 1, 0.7, 1, 0.9], 4),
  );
  geometry.setAttribute('aTreeShape', new THREE.InstancedBufferAttribute(new Float32Array([4.75, 0.25]), 2));
  geometry.computeBoundingBox();
  const mesh = new THREE.InstancedMesh(geometry, material, 1),
    expansion = treeBoundsExpansion(mesh),
    draw = createIndirectCellDraws(mesh, { maxCells: 8, ...expansion }),
    matrix = new THREE.Matrix4(),
    original = new THREE.Box3(),
    correctedBark = new THREE.Vector3(),
    animated = new THREE.Vector3(),
    sample = new THREE.Vector3(),
    normal = new THREE.Vector3(),
    p = geometry.attributes.position,
    a = geometry.attributes.aTree,
    limits = TREE_WIND_LIMITS;
  try {
    for (const angle of [0, Math.PI]) {
      matrix.compose(
        new THREE.Vector3(300, 1, -400),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle),
        new THREE.Vector3(0.75, 0.25, 0.9),
      );
      mesh.setMatrixAt(0, matrix);
      mesh.count = 1;
      draw.repack();
      original.copy(geometry.boundingBox).applyMatrix4(matrix);
      correctedBark.set(-2 * 4.75, 0, 0).applyMatrix4(matrix);
      assert.equal(original.containsPoint(correctedBark), false);
      assert.equal(draw.cells[0].box.containsPoint(correctedBark), true);
      assert.equal(draw.cells[0].sphere.containsPoint(correctedBark), true);
      for (let i = 0; i < 1024; i++) {
        const time = i * 0.127,
          phase = (((i * 7919) % 10007) / 10007) * 6.2832;
        normal.set(Math.sin(i * 0.17), Math.cos(i * 0.23), Math.sin(i * 0.31)).normalize();
        for (let vertex = 0; vertex < p.count; vertex++) {
          const x = p.getX(vertex),
            y = p.getY(vertex),
            z = p.getZ(vertex),
            t = Math.max(0, Math.min(1, (y * 0.25 - 1.8) / 1.4)),
            radius = 1 + (4.75 - 1) * (1 - a.getX(vertex)) * (1 - t * t * (3 - 2 * t));
          // Forward the authored position shader: correct bark, instance,
          // then add world-directed wind and normalized-normal flutter.
          animated.set(x * radius, y, z * radius).applyMatrix4(matrix);
          const gust =
              Math.sin(
                time * 0.5 - (animated.x * limits.directionX + animated.z * limits.directionZ) * 0.045,
              ) *
                0.5 +
              0.5,
            strength = gust * gust * 0.7 + 0.3,
            lean = (Math.sin(time * 0.85 + phase) * 0.45 + 0.55) * strength * limits.lean,
            rock = Math.sin(time * 0.67 + phase * 1.7) * limits.rock * strength,
            bend = (y / limits.heightM) ** 2,
            bob = Math.sin(time * 2.1 + x * 0.9 + z * 0.7 + phase) * limits.bob * a.getZ(vertex) * strength,
            flutter =
              Math.sin(time * 8 + a.getW(vertex) * 37 + y * 2) *
              limits.flutter *
              a.getX(vertex) *
              a.getZ(vertex) *
              (strength + limits.flutterStrengthExtra);
          sample
            .set(
              (limits.directionX * lean - limits.directionZ * rock) * bend,
              bob,
              (limits.directionZ * lean + limits.directionX * rock) * bend,
            )
            .addScaledVector(normal, flutter);
          assert.ok(
            sample.length() <= expansion.windPadding,
            'the animated position must stay in the cell margin',
          );
          animated.add(sample);
          assert.equal(draw.cells[0].box.containsPoint(animated), true);
          assert.equal(draw.cells[0].sphere.containsPoint(animated), true);
        }
      }
    }
    const plain = new THREE.BoxGeometry();
    try {
      assert.equal(
        treeWindBoundsPadding(plain),
        0,
        'static evergreen and branch materials need no wind margin',
      );
    } finally {
      plain.dispose();
    }
  } finally {
    mesh.dispose();
    geometry.dispose();
    material.dispose();
  }
});
