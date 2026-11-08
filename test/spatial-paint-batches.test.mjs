import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three/webgpu';
import { addSpatialBatches, splitGeometryByPrimitives } from '../app/static-batches.js';
import {
  createRoadPaintMaterial,
  expandRoadPaintBounds,
  ROAD_PAINT_MAX_WIDEN,
} from '../app/reference-streets.js';

function paintGeometry() {
  const geometry = new THREE.BufferGeometry(),
    positions = [],
    indices = [];
  for (const [quad, z] of [-1200, 1200, -1500].entries()) {
    positions.push(-2, 0, z - 2, 2, 0, z - 2, 2, 0, z + 2, -2, 0, z + 2);
    const first = quad * 4;
    indices.push(...[0, 2, 1, 0, 3, 2].map((index) => first + index));
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      Array.from({ length: 36 }, (_, i) => (i % 7) / 7),
      3,
    ),
  );
  geometry.setAttribute(
    'side',
    new THREE.Float32BufferAttribute(
      Array.from({ length: 24 }, (_, i) => (i - 12) / 37),
      2,
    ),
  );
  geometry.setAttribute(
    'paint',
    new THREE.Float32BufferAttribute(
      Array.from({ length: 36 }, (_, i) => i / 13),
      3,
    ),
  );
  geometry.setAttribute(
    'color',
    new THREE.Uint8BufferAttribute(
      Array.from({ length: 36 }, (_, i) => i * 7),
      3,
      true,
    ),
  );
  const identities = new THREE.Uint32BufferAttribute(
    Array.from({ length: 12 }, (_, i) => 0x1000000 + Math.floor(i / 4)),
    1,
  );
  identities.name = 'Surveyed source identity';
  identities.setUsage(THREE.DynamicDrawUsage);
  identities.gpuType = THREE.IntType;
  geometry.setAttribute('sourceId', identities);
  geometry.setIndex(indices);
  return geometry;
}

// A triangle includes every raw vertex attribute in its original winding.
// Sorting only complete triangle hashes permits draw-order changes, never
// coordinate, material-input, source-identity or topology changes.
function triangleMultiset(geometries) {
  const result = [];
  for (const geometry of geometries) {
    const attributes = Object.keys(geometry.attributes)
        .sort()
        .map((name) => geometry.attributes[name]),
      count = geometry.index?.count ?? geometry.attributes.position.count;
    for (let triangle = 0; triangle < count; triangle += 3) {
      const hash = createHash('sha256');
      for (let corner = 0; corner < 3; corner++) {
        const vertex = geometry.index ? geometry.index.getX(triangle + corner) : triangle + corner;
        for (const attribute of attributes) {
          const size = attribute.array.BYTES_PER_ELEMENT;
          hash.update(
            new Uint8Array(
              attribute.array.buffer,
              attribute.array.byteOffset + vertex * attribute.itemSize * size,
              attribute.itemSize * size,
            ),
          );
        }
      }
      result.push(hash.digest('hex'));
    }
  }
  return result.sort();
}

test('spatial paint pieces preserve every source triangle, raw attribute and integer identity', () => {
  const source = paintGeometry(),
    expected = triangleMultiset([source]),
    originals = Object.fromEntries(
      Object.entries(source.attributes).map(([name, attribute]) => [name, attribute.array.slice()]),
    ),
    pieces = splitGeometryByPrimitives(source);
  try {
    assert.equal(pieces.length, 2);
    assert.deepEqual(triangleMultiset(pieces), expected);
    for (const piece of pieces) {
      assert.equal(piece.attributes.position.count % 4, 0, 'source quads remain intact');
      for (const [name, attribute] of Object.entries(piece.attributes)) {
        const original = source.attributes[name];
        assert.equal(attribute.array.constructor, original.array.constructor, name);
        assert.equal(attribute.itemSize, original.itemSize, name);
        assert.equal(attribute.normalized, original.normalized, name);
        assert.equal(attribute.name, original.name, name);
        assert.equal(attribute.usage, original.usage, name);
        assert.equal(attribute.gpuType, original.gpuType, name);
      }
    }
    for (const [name, array] of Object.entries(originals))
      assert.deepEqual(source.attributes[name].array, array);
  } finally {
    source.dispose();
    for (const piece of pieces) piece.dispose();
  }
});

test('spatial paint batches cull their exact geometry independently for view and shadow cameras', () => {
  const source = paintGeometry(),
    expected = triangleMultiset([source]),
    scene = new THREE.Scene(),
    material = new THREE.MeshBasicNodeMaterial(),
    mesh = addSpatialBatches(scene, source, material, 'Paint test');
  try {
    assert.equal(mesh.isBatchedMesh, true);
    assert.deepEqual(triangleMultiset([mesh.geometry]), expected);
    assert.equal(mesh.castShadow, false);
    assert.equal(mesh.receiveShadow, true);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.2, 3000);
    camera.updateMatrixWorld();
    mesh.onBeforeRender({ isWebGPURenderer: false }, scene, camera, mesh.geometry, material);
    assert.equal(mesh._multiDrawCount, 1);
    assert.equal(mesh._multiDrawCounts[0], 12, 'the two front quads share a spatial piece');
    camera.rotation.y = Math.PI;
    camera.updateMatrixWorld();
    mesh.onBeforeRender({ isWebGPURenderer: false }, scene, camera, mesh.geometry, material);
    assert.equal(mesh._multiDrawCount, 1);
    assert.equal(mesh._multiDrawCounts[0], 6, 'the rear quad is selected after turning');
    const shadow = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.2, 3000);
    shadow.updateMatrixWorld();
    mesh.onBeforeShadow({ isWebGPURenderer: false }, null, camera, shadow, mesh.geometry, material);
    assert.equal(mesh._multiDrawCount, 1);
    assert.equal(mesh._multiDrawCounts[0], 12, 'the shadow view selects its own front piece');
  } finally {
    mesh.dispose();
    material.dispose();
  }
});

test('nonindexed primitives retain their exact winding and malformed primitive boundaries are rejected', () => {
  const indexed = paintGeometry(),
    source = indexed.toNonIndexed(),
    pieces = splitGeometryByPrimitives(source, 1000, 6);
  try {
    assert.deepEqual(triangleMultiset(pieces), triangleMultiset([source]));
    assert.ok(pieces.every((piece) => piece.index === null));
    assert.throws(() => splitGeometryByPrimitives(source), /complete/);
    indexed.index.setX(0, 8);
    assert.throws(() => splitGeometryByPrimitives(indexed), /inside their source primitive/);
    assert.throws(() => splitGeometryByPrimitives(source, 0, 6), /complete, contiguous/);
  } finally {
    indexed.dispose();
    source.dispose();
    for (const piece of pieces) piece.dispose();
  }
});

test('grazing paint remains visible when the shader expands it beyond raw spatial bounds', () => {
  const camera = new THREE.OrthographicCamera(-5000, 5000, 10, -10, 1, 20);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  for (const centres of [[5000.5], [5000.5, 6000.5]]) {
    const scene = new THREE.Scene(),
      material = createRoadPaintMaterial(),
      geometry = new THREE.BufferGeometry(),
      positions = [],
      offsets = [],
      indices = [],
      halfWidth = 0.05;
    for (const centre of centres) {
      const first = positions.length / 3;
      positions.push(
        centre - halfWidth,
        0,
        -5.1,
        centre + halfWidth,
        0,
        -5.1,
        centre + halfWidth,
        0,
        -4.9,
        centre - halfWidth,
        0,
        -4.9,
      );
      offsets.push(-halfWidth, 0, halfWidth, 0, halfWidth, 0, -halfWidth, 0);
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('side', new THREE.Float32BufferAttribute(offsets, 2));
    geometry.setIndex(indices);
    const original = geometry.clone(),
      raw = new THREE.Mesh(original, material),
      widened = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, 0);
    widened.x += geometry.attributes.side.getX(0) * (ROAD_PAINT_MAX_WIDEN - 1);
    raw.updateMatrixWorld();
    assert.equal(frustum.intersectsObject(raw), false, 'raw geometry lies completely beyond the right plane');
    assert.equal(frustum.containsPoint(widened), true, 'the widened stripe crosses into the view');
    const mesh = addSpatialBatches(scene, geometry, material, 'Grazing paint', {
      expandBounds: expandRoadPaintBounds,
    });
    try {
      assert.equal(frustum.intersectsObject(mesh), true, 'the overall expanded bounds enter the frustum');
      assert.deepEqual(triangleMultiset([mesh.geometry]), triangleMultiset([original]));
      if (mesh.isBatchedMesh) {
        mesh.onBeforeRender({ isWebGPURenderer: false }, scene, camera, mesh.geometry, material);
        assert.equal(mesh._multiDrawCount, 1, 'only the shader-visible spatial piece is submitted');
        assert.equal(mesh._multiDrawCounts[0], 6);
        const box = mesh.getBoundingBoxAt(0, new THREE.Box3()),
          sphere = mesh.getBoundingSphereAt(0, new THREE.Sphere());
        assert.equal(box.containsPoint(widened), true, 'cached piece box includes shader displacement');
        assert.equal(sphere.containsPoint(widened), true, 'cached piece sphere includes shader displacement');
        assert.equal(mesh.boundingBox.containsPoint(widened), true);
        assert.equal(mesh.boundingSphere.containsPoint(widened), true);
      } else {
        assert.equal(mesh.geometry.boundingBox.containsPoint(widened), true);
        assert.equal(mesh.geometry.boundingSphere.containsPoint(widened), true);
      }
    } finally {
      original.dispose();
      if (mesh.isBatchedMesh) mesh.dispose();
      else mesh.geometry.dispose();
      material.dispose();
    }
  }
});
