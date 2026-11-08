import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createLinearPolygonGeometry } from '../app/linear-polygon-geometry.js';

function originalGeometry(surface, y) {
  const shape = new THREE.Shape(surface.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const ring of surface.holes || [])
    shape.holes.push(new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, y, 0);
}

const bytes = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

function compareWithThree(surface, y = 0.31, inspect = () => {}) {
  const expected = originalGeometry(surface, y),
    actual = createLinearPolygonGeometry(surface, y);
  try {
    assert.deepEqual(Object.keys(actual.attributes), Object.keys(expected.attributes));
    for (const name of [...Object.keys(expected.attributes), 'index']) {
      const a = name === 'index' ? actual.index : actual.attributes[name],
        b = name === 'index' ? expected.index : expected.attributes[name];
      assert.equal(a.constructor, b.constructor, `${name} attribute class`);
      assert.equal(a.array.constructor, b.array.constructor, `${name} element type`);
      for (const key of ['itemSize', 'count', 'normalized', 'usage', 'gpuType', 'version'])
        assert.equal(a[key], b[key], `${name} ${key}`);
      assert.deepEqual(bytes(a.array), bytes(b.array), `${name} exact bytes`);
    }
    assert.deepEqual(actual.groups, expected.groups);
    assert.deepEqual(actual.drawRange, expected.drawRange);
    assert.equal(actual.boundingBox, expected.boundingBox);
    assert.equal(actual.boundingSphere, expected.boundingSphere);
    inspect(actual, expected);
  } finally {
    actual.dispose();
    expected.dispose();
  }
}

test('linear polygons retain Three triangles, attributes and winding with concavity and holes', () => {
  const outside = [
      [-8, -9],
      [8, -9],
      [8, 6],
      [2, 2],
      [-8, 6],
    ],
    firstHole = [
      [-6, -6],
      [-2, -6],
      [-2, -2],
      [-6, -2],
    ],
    secondHole = [
      [3, -6],
      [6, -6],
      [6, -3],
      [3, -3],
    ];
  for (const closed of [false, true])
    for (const reversed of [false, true]) {
      const ring = (points) => {
        const result = reversed ? points.slice().reverse() : points.slice();
        if (closed) result.push(result[0]);
        return result;
      };
      compareWithThree(
        { ring: ring(outside), holes: [ring(firstHole).reverse(), ring(secondHole)] },
        0.115,
        (geometry) => assert.ok(geometry.index.count > 0),
      );
    }
});

test('signed zero, exact duplicate removal and Float32 rounding match the installed Three path', () => {
  const cases = [
    {
      ring: [
        [-0, 0],
        [1, -0],
        [1, 1],
        [-0, 1],
        [-0, 0],
      ],
    },
    {
      ring: [
        [0, -0],
        [0, -0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, -0],
      ],
    },
    {
      ring: [
        [-7.1, -8.3],
        [-7.1, -8.3],
        [-1.2, -8.3],
        [-1.2, -2.7],
        [-7.1, -2.7],
      ],
    },
    {
      ring: [
        [1 + 2 ** -24, -(2 ** -149)],
        [3 + 2 ** -22, -0],
        [3, 2],
        [1, 2],
      ],
    },
  ];
  for (const surface of cases) compareWithThree(surface, 0.135);
  compareWithThree(cases[0], 0.31, (geometry) => {
    assert.ok(geometry.attributes.uv.array.some((value) => Object.is(value, -0)));
    assert.ok(geometry.attributes.normal.array.some((value) => value > 0 && value < 1e-15));
  });
});

test('single points, repeated points and collinear paths keep their original geometry', () => {
  const cases = [
    { ring: [[3, -8]] },
    {
      ring: [
        [3, -8],
        [3, -8],
        [3, -8],
      ],
    },
    {
      ring: [
        [3, -8],
        [5, -8],
      ],
    },
    {
      ring: [
        [3, -8],
        [5, -8],
        [7, -8],
        [3, -8],
      ],
    },
  ];
  for (const surface of cases) compareWithThree(surface);
});

test('unsupported source forms retain the original Three factory and error behavior', () => {
  const square = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
    cases = [
      { ring: square.map((point) => new Float64Array(point)) },
      {
        ring: [
          [Number.MAX_VALUE, 0],
          [-Number.MAX_VALUE, 0],
          [0, 1],
        ],
      },
      {
        ring: [
          [0, 0],
          [1, 0],
          [0, NaN],
        ],
      },
      {
        ring: square,
        holes: new Set([
          [
            [1, 1],
            [2, 1],
            [1, 2],
          ],
        ]),
      },
    ];
  for (const surface of cases)
    compareWithThree(surface, 0.31, (geometry) => assert.ok(geometry instanceof THREE.ShapeGeometry));
  for (const surface of [
    { ring: [] },
    { ring: square, holes: [[]] },
    { ring: square, holes: [[[1, 1]]] },
    { ring: square, holes: new Array(1) },
    { ring: [[0, 0], , [1, 1]] },
  ]) {
    let expected;
    try {
      originalGeometry(surface, 0.31);
    } catch (error) {
      expected = error;
    }
    assert.ok(expected);
    assert.throws(() => createLinearPolygonGeometry(surface, 0.31), { name: expected.name });
  }
});

test('triangulation does not mutate source contours or share output storage between calls', () => {
  const surface = {
    id: 'surveyed-source',
    kind: 'Curb Gutter Sidewalk',
    ring: [
      [0, 0],
      [9, 0],
      [9, 9],
      [0, 9],
      [0, 0],
    ],
    holes: [
      [
        [2, 2],
        [5, 2],
        [5, 5],
        [2, 5],
        [2, 2],
      ],
    ],
  };
  const before = structuredClone(surface),
    sourceRing = surface.ring,
    sourceHoles = surface.holes,
    sourceHole = surface.holes[0];
  for (const ring of [surface.ring, ...surface.holes]) {
    ring.forEach(Object.freeze);
    Object.freeze(ring);
  }
  Object.freeze(surface.holes);
  Object.freeze(surface);
  compareWithThree(surface);
  const first = createLinearPolygonGeometry(surface, 0.31),
    second = createLinearPolygonGeometry(surface, 0.31);
  try {
    assert.notEqual(first.attributes.position.array.buffer, second.attributes.position.array.buffer);
    assert.notEqual(first.index.array.buffer, second.index.array.buffer);
    first.attributes.position.array.fill(123);
    first.index.array.fill(0);
    compareWithThree(surface);
    assert.deepEqual(surface, before);
    assert.equal(surface.ring, sourceRing);
    assert.equal(surface.holes, sourceHoles);
    assert.equal(surface.holes[0], sourceHole);
  } finally {
    first.dispose();
    second.dispose();
  }
});
