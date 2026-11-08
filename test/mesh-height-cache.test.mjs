import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createMeshHeightCache } from '../app/mesh-height-cache.js';
import { createMeshHeightSampler } from '../app/mesh-height-envelope.js';
import { createCityMeshes } from '../app/city-meshes.js';
import { bodyPolygon, clippedRange, geometryFaces } from './helpers/mesh-projection-oracle.mjs';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const face = [
  [0, 0, 0],
  [4, 8, 0],
  [0, 12, 4],
];
test('lower envelopes retain slopes, local boundaries, rotated bodies and disjoint clearance', () => {
  const low = createMeshHeightSampler([face], { minimum: true }),
    high = createMeshHeightSampler([face]),
    circle = { radius: 0.2 };
  near(low(1, 1, circle), 5 - Math.sqrt(13) * 0.2);
  near(high(1, 1, circle), 5 + Math.sqrt(13) * 0.2);
  near(low(1, 1), 5);
  near(low(2, -0.2), 4);
  assert.equal(low(8, 8, circle), Infinity);
  assert.equal(high(8, 8, circle), -Infinity);
  for (const heading of [0, 0.7, Math.PI / 2, -1.2]) {
    const box = { car: true, hx: 0.3, hz: 0.6, cos: Math.cos(heading), sin: Math.sin(heading) },
      range = clippedRange([face], bodyPolygon(2, -0.2, box));
    near(low(2, -0.2, box), range.min);
    near(high(2, -0.2, box), range.max);
  }
  const vertical = [
    [
      [1, -5, 1],
      [1, 2, 1],
      [1, 8, 1],
    ],
  ];
  near(createMeshHeightSampler(vertical, { minimum: true })(1, 1, circle), -5);
  near(createMeshHeightSampler(vertical)(1, 1, circle), 8);
});

function mesh(height, triangles = 1, indexed = false) {
  const geometry = new THREE.BufferGeometry(),
    vertices = [];
  for (let i = 0; i < triangles; i++) vertices.push(0, height, 0, 4, height, 0, 0, height, 4);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  if (indexed) geometry.setIndex(Array.from({ length: vertices.length / 3 }, (_, i) => i));
  return geometry;
}
test('projection caches are lazy, bounded by both owner and triangle counts, and rebuild the same exact values', () => {
  const loaded = [],
    disposed = [],
    cache = createMeshHeightCache(
      (id) => {
        loaded.push(id);
        if (id === 'missing') return null;
        const geometry = mesh(Number(id), Number(id) === 4 ? 3 : 1, id === '2');
        geometry.addEventListener('dispose', () => disposed.push(id));
        return geometry;
      },
      { maxEntries: 2, maxTriangles: 3 },
    );
  assert.equal(cache.stats.builds, 0);
  near(cache.heightAt('1', 1, 1, { radius: 0.2 }), 1);
  near(cache.heightAt('2', 1, 1, { radius: 0.2 }), 2);
  near(cache.heightAt('1', 1, 1), 1);
  assert.equal(cache.stats.hits, 1);
  near(cache.heightAt('3', 1, 1), 3);
  assert.equal(cache.stats.evictions, 1, 'owner 2 was least recently used');
  near(cache.heightAt('2', 1, 1), 2);
  assert.deepEqual(loaded, ['1', '2', '3', '2']);
  near(cache.heightAt('4', 1, 1), 4);
  assert.equal(cache.stats.retainedEntries, 1);
  assert.equal(cache.stats.retainedTriangles, 3);
  assert.equal(cache.stats.peakEntries, 2);
  assert.equal(cache.stats.peakTriangles, 3);
  assert.deepEqual(disposed, loaded, 'temporary decoding geometry is always released');
  assert.equal(cache.heightAt('missing', 1, 1), null);
  cache.clear();
  assert.equal(cache.stats.retainedEntries, 0);
  assert.equal(cache.stats.retainedTriangles, 0);
});
test('oversized or invalid geometries cannot silently exceed a cache budget or leave retained decoding objects', () => {
  let disposed = 0;
  const cache = createMeshHeightCache(
    () => {
      const g = mesh(7, 3);
      g.addEventListener('dispose', () => disposed++);
      return g;
    },
    { maxEntries: 1, maxTriangles: 2 },
  );
  for (let i = 0; i < 2; i++) near(cache.heightAt('large', 1, 1), 7);
  assert.equal(cache.stats.oversizedBuilds, 2);
  assert.equal(cache.stats.retainedEntries, 0);
  assert.equal(disposed, 2);
  const broken = createMeshHeightCache(() => {
    const g = mesh(3);
    g.setIndex([0, 1]);
    g.addEventListener('dispose', () => disposed++);
    return g;
  });
  assert.throws(() => broken.heightAt('bad', 1, 1), /complete triangles/);
  assert.equal(disposed, 3);
  assert.equal(broken.stats.retainedEntries, 0);
  for (const n of [0, -1, 0.5, Infinity, NaN]) {
    assert.throws(() => createMeshHeightCache(() => null, { maxEntries: n }), /positive integers/);
    assert.throws(() => createMeshHeightCache(() => null, { maxTriangles: n }), /positive integers/);
  }
  assert.throws(() => createMeshHeightCache(() => null, { minimum: 'yes' }), /direction must be boolean/);
});

test('the positions-only City projection preserves Float32 geometry and validates both source index widths', () => {
  for (const indexBytes of [2, 4]) {
    const bytes = Buffer.alloc(16 + 18 + 3 * indexBytes);
    bytes.set([67, 71, 77, 69, 83, 72, 49, 0]);
    bytes.writeUInt32LE(1, 8);
    bytes.writeFloatLE(0.02, 12);
    [0, 100, 0, 200, 300, 0, 0, 200, 200].forEach((v, i) => bytes.writeInt16LE(v, 16 + i * 2));
    for (let i = 0; i < 3; i++)
      indexBytes === 2
        ? bytes.writeUInt16LE(i, 34 + i * indexBytes)
        : bytes.writeUInt32LE(i, 34 + i * indexBytes);
    const manifest = {
        version: 1,
        meta: { quantization: 0.02, binaryBytes: bytes.length },
        buildings: [
          {
            id: 'actual-precision-control',
            offset: 16,
            origin: [1034.123456, -1333.987654],
            vertexCount: 3,
            indexCount: 3,
            indexBytes,
            height: 6,
            minHeight: 0,
          },
        ],
      },
      source = createCityMeshes(manifest, bytes),
      geometry = source.createGeometry('actual-precision-control'),
      expected = createMeshHeightSampler(geometryFaces(geometry)),
      x = geometry.attributes.position.getX(0) + 0.7,
      z = geometry.attributes.position.getZ(0) + 0.7;
    try {
      for (const body of [
        undefined,
        { radius: 0.42 },
        { car: true, hx: 0.3, hz: 0.6, cos: Math.cos(0.7), sin: Math.sin(0.7) },
      ])
        assert.equal(source.collisionHeightAt('actual-precision-control', x, z, body), expected(x, z, body));
      assert.equal(source.contactStats.builds, 1);
      assert.equal(source.collisionHeightAt('missing', x, z), null);
      const bad = Buffer.from(bytes);
      indexBytes === 2 ? bad.writeUInt16LE(3, 34) : bad.writeUInt32LE(3, 34);
      const invalid = createCityMeshes(manifest, bad);
      assert.throws(() => invalid.collisionHeightAt('actual-precision-control', x, z), /index out of range/);
      assert.equal(invalid.contactStats.retainedEntries, 0);
    } finally {
      geometry.dispose();
    }
  }
});
