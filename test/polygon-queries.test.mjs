import test from 'node:test';
import assert from 'node:assert/strict';
import { inside, inPolygon, seeded } from '../app/geo.js';
import { createStaticPolygonQueries, containsPreparedPolygon } from '../app/polygon-queries.js';

const bits = new DataView(new ArrayBuffer(8));
function nextUp(value) {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  const word = bits.getBigUint64(0);
  bits.setBigUint64(0, value > 0 ? word + 1n : word - 1n);
  return bits.getFloat64(0);
}
const nextDown = (value) => -nextUp(-value);

function subdivide(corners, parts = 8, closed = false) {
  const ring = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i],
      b = corners[(i + 1) % corners.length];
    for (let j = 0; j < parts; j++)
      ring.push([a[0] + ((b[0] - a[0]) * j) / parts, a[1] + ((b[1] - a[1]) * j) / parts]);
  }
  if (closed) ring.push([...ring[0]]);
  return ring;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function edgeQueries(poly) {
  const points = [
      [0, 0],
      [-0, -0],
      [NaN, 0],
      [0, NaN],
      [Infinity, 0],
      [-Infinity, 0],
      [0, Infinity],
      [0, -Infinity],
    ],
    rings = [poly.ring];
  if (poly.holes) for (let i = 0; i < poly.holes.length; i++) if (i in poly.holes) rings.push(poly.holes[i]);
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        x = (a[0] + b[0]) / 2,
        z = (a[1] + b[1]) / 2;
      points.push(
        a,
        [nextUp(a[0]), a[1]],
        [nextDown(a[0]), a[1]],
        [a[0], nextUp(a[1])],
        [a[0], nextDown(a[1])],
        [x, z],
        [nextUp(x), z],
        [nextDown(x), z],
        [x, nextUp(z)],
        [x, nextDown(z)],
      );
    }
  return points;
}

function checkParity(factory, poly, points = edgeQueries(poly)) {
  const prepared = factory.preparePolygon(poly);
  for (const [x, z] of points)
    assert.equal(
      containsPreparedPolygon(x, z, poly, prepared),
      inPolygon(x, z, poly),
      `membership at (${x}, ${z})`,
    );
  return prepared;
}

const rectangle = [
  [-16, -32],
  [16, -32],
  [16, 0],
  [-16, 0],
];

test('prepared rings retain strict half-open boundaries and adjacent Float64 queries', () => {
  const pins = [
    [-16, -32, true],
    [16, -32, false],
    [-16, 0, false],
    [-16, -16, true],
    [16, -16, false],
    [0, -32, true],
    [0, 0, false],
    [nextDown(-16), -16, false],
    [nextUp(-16), -16, true],
    [nextDown(16), -16, true],
    [nextUp(16), -16, false],
    [0, nextDown(-32), false],
    [0, nextUp(-32), true],
    [0, nextDown(0), true],
    [0, nextUp(0), false],
  ];
  for (const closed of [false, true])
    for (const reverse of [false, true]) {
      const ring = subdivide(rectangle, 16, closed);
      if (reverse) ring.reverse();
      const poly = freeze({ ring }),
        factory = createStaticPolygonQueries({ maxBins: 8 }),
        prepared = checkParity(factory, poly);
      assert.notEqual(prepared, null, 'the fixtures must exercise the prepared path');
      for (const [x, z, expected] of pins) {
        assert.equal(inside(x, z, ring), expected);
        assert.equal(containsPreparedPolygon(x, z, poly, prepared), expected);
      }
      // This 64-edge rectangle spans eight exact bin boundaries below zero.
      for (let cut = -32; cut <= 0; cut += 4)
        for (const z of [nextDown(cut), cut, nextUp(cut)])
          for (const x of [-17, -16, 0, 16, 17]) {
            assert.equal(containsPreparedPolygon(x, z, poly, prepared), inside(x, z, ring));
          }
    }
});

test('concave polygons preserve small and prepared holes, sparse entries, winding and source records', () => {
  const exterior = subdivide([
      [-40, -50],
      [40, -50],
      [40, -5],
      [10, -5],
      [10, 20],
      [-40, 20],
    ]),
    smallHole = [
      [-20, -35],
      [-8, -35],
      [-8, -20],
      [-20, -20],
    ],
    largeHole = subdivide(
      [
        [5, -30],
        [15, -30],
        [10, -15],
      ],
      16,
    ),
    random = seeded(721),
    scattered = Array.from({ length: 200 }, () => [random() * 120 - 60, random() * 100 - 65]);
  for (const reverse of [false, true])
    for (const closed of [false, true]) {
      const ring = exterior.map((point) => [...point]);
      if (reverse) ring.reverse();
      if (closed) ring.push([...ring[0]]);
      const holes = new Array(7);
      holes[1] = reverse ? [...smallHole].reverse() : smallHole;
      holes[5] = reverse ? [...largeHole].reverse() : largeHole;
      const poly = { id: 'surveyed-source', ring, holes },
        snapshot = structuredClone(poly),
        references = [poly.ring, poly.holes, holes[1], holes[5]];
      freeze(poly);
      const factory = createStaticPolygonQueries(),
        prepared = checkParity(factory, poly, [...edgeQueries(poly), ...scattered]);
      assert.notEqual(prepared, null);
      for (const [x, z, expected] of [
        [30, 10, false],
        [-35, 10, true],
        [-14, -27, false],
        [10, -25, false],
        [-20, -27, false],
        [-8, -27, true],
        [-14, -35, false],
        [-14, -20, true],
      ]) {
        assert.equal(containsPreparedPolygon(x, z, poly, prepared), expected);
      }
      assert.deepEqual(poly, snapshot);
      assert.deepEqual(Object.keys(holes), ['1', '5']);
      assert.equal(poly.ring, references[0]);
      assert.equal(poly.holes, references[1]);
      assert.equal(holes[1], references[2]);
      assert.equal(holes[5], references[3]);
    }
});

test('repeated points, degenerate rings and nonfinite queries preserve the original arithmetic', () => {
  const repeated = subdivide(rectangle);
  repeated.splice(3, 0, [...repeated[3]], [...repeated[3]]);
  const fixtures = [
    [],
    [[2, -1]],
    [
      [-2, -10],
      [4, -10],
      [-2, -10],
    ],
    Array.from({ length: 40 }, (_, i) => [i, -6]),
    Array.from({ length: 40 }, (_, i) => [0, i - 20]),
    repeated,
    subdivide(
      [
        [0, 0],
        [4, 4],
        [0, 4],
        [4, 0],
      ],
      10,
    ),
    [
      [1e16, 1e16],
      [1e16 + 8, 1e16],
      [1e16 + 8, 1e16 + 2],
      [1e16, 1e16 + 2],
    ],
    [
      [-1e308, 0],
      [1e308, 1],
      [-1e308, 2],
    ],
    [
      [-Infinity, 0],
      [0, 2],
      [2, 0],
    ],
    [
      [NaN, -2],
      [0, 2],
      [2, 0],
    ],
    [
      [-1e308, -1e308],
      [1e308, -1e308],
      [1e308, 1e308],
      [-1e308, 1e308],
    ],
  ];
  for (const ring of fixtures) {
    const poly = freeze({ ring }),
      points = [...edgeQueries(poly), [-1, 1], [1, 1], [0, -6], [1e16 + 4, 1e16]];
    checkParity(createStaticPolygonQueries({ minEdges: 3 }), poly, points);
  }
  for (const holes of [undefined, null, []])
    checkParity(createStaticPolygonQueries(), freeze({ ring: subdivide(rectangle), holes }));
});

test('small and fully direct polygons retain no prepared wrappers or edge metadata', () => {
  const factory = createStaticPolygonQueries();
  for (let i = 0; i < 40; i++) {
    const ring = rectangle.map(([x, z]) => [x + i, z]),
      poly = freeze({
        ring,
        holes: [
          [
            [i, -20],
            [i + 2, -20],
            [i + 1, -18],
          ],
        ],
      });
    assert.equal(factory.preparePolygon(poly), null);
    const before = { ...factory.stats };
    assert.equal(factory.preparePolygon(poly), null);
    assert.deepEqual(factory.stats, before);
    checkParity(factory, poly);
  }
  for (const ring of [[], [[1, 1]], Array.from({ length: 40 }, (_, i) => [i, 7])])
    assert.equal(factory.preparePolygon({ ring }), null);
  assert.equal(factory.stats.preparedRings, 0);
  assert.equal(factory.stats.bytes, 0);
  assert.equal(factory.stats.references, 0);
  assert.equal(factory.stats.largestBins, 0);
});

test('metadata and edge-reference limits fall back without changing membership or double charging cached sources', () => {
  const circle = (offset = 0) =>
    Array.from({ length: 64 }, (_, i) => {
      const angle = (i * Math.PI) / 32;
      return [Math.cos(angle) * 30 + offset, Math.sin(angle) * 20 - 80];
    });
  for (const options of [{ maxBytes: 0 }, { maxBytes: 1 }, { maxBins: 1 }]) {
    const factory = createStaticPolygonQueries(options),
      poly = freeze({ ring: circle() });
    assert.equal(checkParity(factory, poly), null);
    assert.equal(factory.stats.bytes, 0);
  }
  const limited = createStaticPolygonQueries({ maxBytes: 1024, maxBins: 8 });
  let preparedCount = 0,
    directCount = 0;
  for (let i = 0; i < 8; i++) {
    const poly = freeze({ ring: circle(i * 80) }),
      prepared = checkParity(limited, poly),
      before = { ...limited.stats };
    if (prepared) preparedCount++;
    else directCount++;
    assert.equal(limited.preparePolygon(poly), prepared);
    assert.deepEqual(limited.stats, before, 'cached source identity must not charge metadata again');
    assert.ok(limited.stats.bytes <= 1024);
    assert.ok(limited.stats.largestBins <= 8);
  }
  assert.ok(preparedCount > 0);
  assert.ok(directCount > 0);
  const zigzag = Array.from({ length: 64 }, (_, i) => [i, i % 2 ? -5 : -95]),
    capped = createStaticPolygonQueries({ maxReferencesPerEdge: 1 });
  assert.equal(checkParity(capped, freeze({ ring: zigzag })), null);
  assert.equal(capped.stats.preparedRings, 0);
  assert.equal(capped.stats.bytes, 0);
});

test('source ring and hole replacements use current polygon semantics instead of stale indexes', () => {
  const original = () => {
      const holes = new Array(3);
      holes[0] = subdivide([
        [-8, -24],
        [8, -24],
        [8, -8],
        [-8, -8],
      ]);
      return { ring: subdivide(rectangle), holes };
    },
    replacements = [
      (poly) => {
        poly.ring = [
          [100, 100],
          [110, 100],
          [110, 110],
          [100, 110],
        ];
      },
      (poly) => {
        poly.holes = [];
      },
      (poly) => {
        poly.holes[0] = [
          [100, 100],
          [110, 100],
          [110, 110],
          [100, 110],
        ];
      },
      (poly) => {
        poly.ring.splice(1, poly.ring.length - 3);
      },
      (poly) => {
        poly.holes[0].splice(1, poly.holes[0].length - 3);
      },
      (poly) => {
        poly.holes.length = 3;
        poly.holes[2] = [
          [-15, -31],
          [15, -31],
          [15, -1],
          [-15, -1],
        ];
      },
    ];
  for (const replace of replacements) {
    const poly = original(),
      factory = createStaticPolygonQueries(),
      prepared = factory.preparePolygon(poly),
      before = { ...factory.stats };
    assert.notEqual(prepared, null);
    replace(poly);
    for (const [x, z] of [...edgeQueries(poly), [0, -16], [-12, -16], [105, 105]])
      assert.equal(containsPreparedPolygon(x, z, poly, prepared), inPolygon(x, z, poly));
    assert.deepEqual(factory.stats, before, 'fallback queries must not allocate a replacement index');
  }
});

test('invalid preparation limits are rejected before allocating metadata', () => {
  for (const options of [
    { minEdges: 2 },
    { minEdges: 3.5 },
    { minEdges: Infinity },
    { maxBins: 0 },
    { maxBins: 65 },
    { maxBins: 1.5 },
    { maxReferencesPerEdge: 0 },
    { maxReferencesPerEdge: 65 },
    { maxReferencesPerEdge: NaN },
    { maxBytes: -1 },
    { maxBytes: 0.5 },
    { maxBytes: 32 * 1024 * 1024 + 1 },
  ])
    assert.throws(() => createStaticPolygonQueries(options));
});
