import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { facadeSamples, measuredFacadeSamples } from '../app/imagery-geometry.js';

test('photo decals retain real setbacks and facade gaps without changing the source shell', () => {
  const points = [];
  const wall = (x0, x1, z, reverse = false) => {
    const a = [x0, 0, z],
      b = [x0, 3, z],
      c = [x1, 3, z],
      d = [x1, 0, z];
    points.push(...(reverse ? [a, c, b, a, d, c] : [a, b, c, a, c, d]).flat());
  };
  wall(0, 1, 0);
  wall(3, 4, 0.6);
  wall(0, 4, 3);
  wall(0, 4, -0.02, true);
  points.push(0, 3, 0, 4, 3, 0, 4, 3, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const before = geometry.attributes.position.array.slice(),
    facade = {
      a: [0, 0],
      b: [4, 0],
      normal: [0, -1],
      base: 0.2,
      height: 2.5,
      corners: [
        [0.1, 0.1],
        [0.9, 0.2],
        [0.85, 0.9],
        [0.15, 0.85],
      ],
      projection: { type: 'measured-walls', minDepth: -1, maxDepth: 0.1, offset: 0.025 },
    };
  const result = measuredFacadeSamples(facade, geometry, 12);
  assert.equal(result.stats.selectedTriangles, 4);
  assert.ok(result.stats.outputTriangles > 20);
  assert.deepEqual(geometry.attributes.position.array, before, 'source geometry is immutable');
  for (let i = 0; i < result.positions.length; i += 9) {
    const xs = [result.positions[i], result.positions[i + 3], result.positions[i + 6]];
    assert.ok(Math.max(...xs) <= 1 + 1e-7 || Math.min(...xs) >= 3 - 1e-7, 'never bridge the real facade gap');
    for (let j = 0; j < 9; j += 3) {
      assert.ok(result.positions[i + j + 1] >= 0.2 - 1e-7 && result.positions[i + j + 1] <= 2.7 + 1e-7);
      assert.ok(
        Math.abs(result.positions[i + j + 2] + 0.025) < 1e-7 ||
          Math.abs(result.positions[i + j + 2] - 0.575) < 1e-6,
        'retain each selected measured depth',
      );
    }
  }
  assert.ok(result.uvs.every((n) => Number.isFinite(n) && n >= 0 && n <= 1));
  geometry.dispose();
});

test('a measured facade requires explicit bounded depths and never falls back to an invented plane', () => {
  const facade = {
    a: [0, 0],
    b: [2, 0],
    normal: [0, -1],
    height: 3,
    corners: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  };
  assert.throws(() => measuredFacadeSamples(facade, new THREE.BufferGeometry()), /explicit bounded/);
  assert.throws(
    () =>
      measuredFacadeSamples(
        { ...facade, projection: { minDepth: -100, maxDepth: 1 } },
        new THREE.BufferGeometry(),
      ),
    /explicit bounded/,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1], 3));
  const result = measuredFacadeSamples({ ...facade, projection: { minDepth: -1, maxDepth: 1 } }, geometry);
  assert.equal(result.positions.length, 0, 'horizontal roof or ground is not a facade');
  geometry.dispose();
});

test('explicit trapezoid profiles preserve measured depths, gaps and sloping top/base bounds', () => {
  const points = [];
  for (const [x0, x1, z] of [
    [0, 1, 0],
    [3, 4, 0.6],
  ]) {
    const a = [x0, 0, z],
      b = [x0, 4, z],
      c = [x1, 4, z],
      d = [x1, 0, z];
    points.push(...[a, b, c, a, c, d].flat());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const before = geometry.attributes.position.array.slice();
  const facade = {
    a: [0, 0],
    b: [4, 0],
    normal: [0, -1],
    base: 0.4,
    height: 3,
    corners: [
      [0.1, 0.1],
      [0.9, 0.25],
      [0.85, 0.9],
      [0.15, 0.85],
    ],
    surfaceProfile: { type: 'linear-top-base', top: [3.4, 2.6], bottom: [0.4, 0.6] },
    projection: { type: 'measured-walls', minDepth: -1, maxDepth: 0.1, offset: 0.025 },
  };
  const result = measuredFacadeSamples(facade, geometry, 12);
  assert.equal(result.stats.selectedTriangles, 4);
  assert.deepEqual(geometry.attributes.position.array, before);
  for (let i = 0; i < result.positions.length; i += 9) {
    const xs = [result.positions[i], result.positions[i + 3], result.positions[i + 6]];
    assert.ok(Math.max(...xs) <= 1 + 1e-7 || Math.min(...xs) >= 3 - 1e-7);
    for (let j = 0; j < 9; j += 3) {
      const x = result.positions[i + j],
        y = result.positions[i + j + 1],
        z = result.positions[i + j + 2];
      assert.ok(y >= 0.4 + (0.2 * x) / 4 - 1e-7);
      assert.ok(y <= 3.4 - (0.8 * x) / 4 + 1e-7);
      assert.ok(Math.abs(z + 0.025) < 1e-7 || Math.abs(z - 0.575) < 1e-6);
    }
  }
  assert.ok(result.uvs.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  geometry.dispose();
});

test('trapezoid UVs use a true projective mapping and preserve straight architectural lines', () => {
  const facade = {
    a: [0, 0],
    b: [4, 0],
    normal: [0, -1],
    base: 1,
    height: 3,
    corners: [
      [0.1, 0.1],
      [0.9, 0.25],
      [0.9, 0.9],
      [0.1, 0.9],
    ],
    surfaceProfile: { type: 'linear-top-base', top: [4, 3], bottom: [1, 1] },
    projection: { type: 'measured-walls', minDepth: -0.05, maxDepth: 0.05, offset: 0.025 },
  };
  const grid = facadeSamples(facade, 4);
  const first = [0, 4, grid.positions.length / 3 - 1, grid.positions.length / 3 - 5];
  for (let c = 0; c < 4; c++) {
    const i = first[c];
    assert.ok(Math.abs(grid.uvs[i * 2] - facade.corners[c][0]) < 1e-12);
    assert.ok(Math.abs(1 - grid.uvs[i * 2 + 1] - facade.corners[c][1]) < 1e-12);
  }
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  for (const [x0, x1] of [
    [0, 2],
    [2, 4],
  ])
    positions.push(x0, 2, 0, x0, 2.1, 0, x1, 2.1, 0, x0, 2, 0, x1, 2.1, 0, x1, 2, 0);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const result = measuredFacadeSamples(facade, geometry, 4),
    row = new Map();
  for (let i = 0; i < result.positions.length; i += 3)
    if (Math.abs(result.positions[i + 1] - 2) < 1e-7)
      row.set(result.positions[i], [result.uvs[(i / 3) * 2], result.uvs[(i / 3) * 2 + 1]]);
  assert.ok(row.size >= 3);
  const entries = [...row.entries()].sort((a, b) => a[0] - b[0]),
    a = entries[0][1],
    b = entries.at(-1)[1];
  for (const [, p] of entries)
    assert.ok(Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) < 1e-10);
  geometry.dispose();
});

test('surface profiles reject unbounded, malformed, inverted and nonfinite endpoint heights', () => {
  const facade = {
    a: [0, 0],
    b: [4, 0],
    normal: [0, -1],
    base: 1,
    height: 3,
    corners: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  };
  for (const surfaceProfile of [
    { type: 'other', top: [4, 3], bottom: [1, 1] },
    { type: 'linear-top-base', top: [4], bottom: [1, 1] },
    { type: 'linear-top-base', top: [4, NaN], bottom: [1, 1] },
    { type: 'linear-top-base', top: [4, 3], bottom: [1, 3] },
    { type: 'linear-top-base', top: [5, 3], bottom: [1, 1] },
    { type: 'linear-top-base', top: [4, 3], bottom: [0, 1] },
  ])
    assert.throws(() => facadeSamples({ ...facade, surfaceProfile }), /surface profile/);
});

test('valid measured height bounds tolerate normalized floating-point roundoff', () => {
  const result = facadeSamples({
    a: [0, 0],
    b: [23, 0],
    normal: [0, -1],
    base: 3.8,
    height: 5,
    corners: [
      [0.4, 0.36],
      [0.67, 0.2],
      [0.67, 0.5],
      [0.4, 0.52],
    ],
    surfaceProfile: { type: 'linear-top-base', top: [8.8, 8.76], bottom: [3.8, 3.8] },
  });
  assert.ok(result.positions.every(Number.isFinite));
  assert.ok(result.uvs.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
});
