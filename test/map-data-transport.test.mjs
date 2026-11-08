import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { brotliCompressSync, constants } from 'node:zlib';
import {
  MAP_TRANSPORT_SOURCES,
  packBinaryMapData,
  packMapDataTransport,
} from '../build/map-data-transport.mjs';
import {
  MAP_DATA_TRANSPORT,
  MAP_COORDINATE_SEQUENCE,
  MAP_BINARY_COORDINATES,
  MAP_NEGATIVE_ZERO,
  MAP_RECORDS,
  MAP_COLUMNS,
  unpackBinaryMapData,
  unpackMapDataTransport,
} from '../app/map-data-transport.js';

const roundTrip = (data) => unpackMapDataTransport(JSON.parse(JSON.stringify(packMapDataTransport(data))));

test('binary coordinate sequences preserve signed deltas and reject damaged or extra bytes', () => {
  const data = {
    ring: [
      [-2147483648, -0.0001],
      [-1, 1],
      [2147483646, -1],
      [0, 0],
    ],
    signed: [
      [-2147483648, 2147483647],
      [-1, 0],
      [0, 0],
    ],
    small: [
      [0, 0],
      [5, -12],
      [1, 6],
    ],
  };
  const packed = Uint8Array.from(packBinaryMapData(packMapDataTransport(data)));
  assert.deepEqual(unpackBinaryMapData(packed.buffer), data);
  assert.throws(() => unpackBinaryMapData(packed.slice(0, -1).buffer), /coordinate/);
  assert.throws(() => unpackBinaryMapData(Uint8Array.of(...packed, 0).buffer), /trailing/);
  assert.throws(() => unpackBinaryMapData(packed.slice(0, 6).buffer), /metadata/);
  assert.throws(
    () => unpackMapDataTransport([MAP_DATA_TRANSPORT, { ring: [MAP_BINARY_COORDINATES, 1, 3] }]),
    /coordinate sequence/,
  );
});

for (const [, name, transportOptions] of MAP_TRANSPORT_SOURCES) {
  test(`${name} retains every original coordinate, property, contour and source identity`, async (t) => {
    const source = await fs.readFile(new URL(`../data/${name}.json`, import.meta.url)),
      original = JSON.parse(source),
      packed = JSON.stringify(packMapDataTransport(original, transportOptions)),
      start = performance.now(),
      restored = unpackMapDataTransport(JSON.parse(packed)),
      parseAndDecodeMs = performance.now() - start,
      options = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
      originalBrotli = brotliCompressSync(source, options).byteLength,
      packedBrotli = brotliCompressSync(packed, options).byteLength;
    assert.deepEqual(restored, original);
    assert.equal(JSON.stringify(restored), JSON.stringify(original), 'source field order is preserved');
    assert.ok(
      packedBrotli <
        originalBrotli * (['calgary', 'calgary-surfaces', 'calgary-parks'].includes(name) ? 0.75 : 0.96),
    );
    assert.equal(unpackMapDataTransport(original), original, 'unbundled development reads the source format');
    t.diagnostic(
      JSON.stringify({
        name,
        originalBytes: source.byteLength,
        packedBytes: Buffer.byteLength(packed),
        originalBrotli,
        packedBrotli,
        parseAndDecodeMs,
      }),
    );
  });
}

test('holes, explicit closures, mixed precision and negative zero retain their exact numeric values', () => {
  const source = {
    ring: [
      [0, -1.1],
      [12.5, -1.1],
      [12.5, 7.09],
      [0, -1.1],
    ],
    holes: [
      [
        [1.25, 2.125],
        [1.875, 2.0001],
        [1.25, 2.125],
      ],
    ],
    precise: [
      [Math.PI, 0],
      [1 / 3, 2 / 3],
      [Math.E, -Math.PI],
    ],
    zero: -0,
    zerosInRing: [
      [-0, 0],
      [1, -0],
      [0, 1],
    ],
    empty: [],
    onePoint: [[0, 0]],
    shortSegment: [
      [1, 2],
      [3, 4],
    ],
    fields: { source: 'City of Calgary', measured: true, null: null },
  };
  assert.deepEqual(roundTrip(source), source);
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(
    roundTrip({
      ring: [
        [maximum, 0],
        [-maximum, 1],
        [0, 2],
      ],
    }),
    {
      ring: [
        [maximum, 0],
        [-maximum, 1],
        [0, 2],
      ],
    },
  );
});

test('record schemas preserve omitted fields, field order, nested contours and JSON prototype keys', () => {
  const records = Array.from({ length: 12 }, (_, i) => {
    const row = JSON.parse('{"__proto__":{"source":"City"},"constructor":"source-value","0":"numeric key"}');
    row.longSourceIdentifier = `asset-${i}`;
    if (i % 2) row.optionalSourceMeasurement = null;
    else row.inferredSourceMeasurement = -0;
    row.measuredOutline = {
      ring: [
        [0, 0],
        [1.25, 2.5],
        [0, 0],
      ],
      holes: [],
    };
    return row;
  });
  const packed = packMapDataTransport({ records });
  assert.equal(packed[1].records[0], MAP_COLUMNS);
  const restored = unpackMapDataTransport(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(restored, { records });
  assert.equal(JSON.stringify(restored), JSON.stringify({ records }));
  for (const row of restored.records) {
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(Object.hasOwn(row, '__proto__'), true);
    assert.deepEqual(row.__proto__, { source: 'City' });
  }
  assert.equal(Object.prototype.source, undefined);
});

test('reserved marker collisions fail the build instead of changing source data', () => {
  for (const marker of [
    MAP_DATA_TRANSPORT,
    MAP_COORDINATE_SEQUENCE,
    MAP_NEGATIVE_ZERO,
    MAP_RECORDS,
    MAP_COLUMNS,
  ])
    assert.throws(() => packMapDataTransport({ value: [marker, 1, 2] }), /reserved transport marker/);
});

test('column records restore interleaved schemas, nested contours and explicit field order', () => {
  const encoded = [
    MAP_DATA_TRANSPORT,
    {
      records: [
        MAP_COLUMNS,
        [
          ['id', 'ring', 'name'],
          ['name', 'id'],
        ],
        [0, 1, 0],
        [
          [
            ['first', 'last'],
            [[MAP_COORDINATE_SEQUENCE, 10, 0, 0, 12, 15, -12, -15], [MAP_NEGATIVE_ZERO]],
            ['First', null],
          ],
          [['Middle'], ['middle']],
        ],
      ],
    },
  ];
  const restored = unpackMapDataTransport(encoded),
    expected = {
      records: [
        {
          id: 'first',
          ring: [
            [0, 0],
            [1.2, 1.5],
            [0, 0],
          ],
          name: 'First',
        },
        { name: 'Middle', id: 'middle' },
        { id: 'last', ring: -0, name: null },
      ],
    };
  assert.deepEqual(restored, expected);
  assert.equal(JSON.stringify(restored), JSON.stringify(expected));
  assert.deepEqual(
    unpackMapDataTransport([MAP_DATA_TRANSPORT, { records: [MAP_COLUMNS, [[]], [0, 0], [[]]] }]),
    { records: [{}, {}] },
  );
  assert.deepEqual(
    unpackMapDataTransport([MAP_DATA_TRANSPORT, { records: [MAP_RECORDS, [['id']], [[0, 'legacy']]] }]),
    { records: [{ id: 'legacy' }] },
  );
});

test('incomplete columns and invalid record order are rejected before expansion', () => {
  const envelope = (table) => [MAP_DATA_TRANSPORT, { records: table }];
  for (const table of [
    [MAP_COLUMNS],
    [MAP_COLUMNS, [], [], []],
    [MAP_COLUMNS, [['id', 'id']], [], [[]]],
    [MAP_COLUMNS, [[1]], [], [[]]],
    [MAP_COLUMNS, [['id']], null, [[[]]]],
    [MAP_COLUMNS, [['id']], [], null],
    [MAP_COLUMNS, [['id']], [], []],
    [MAP_COLUMNS, [['id']], [], [[[]]], 'extra'],
  ])
    assert.throws(() => unpackMapDataTransport(envelope(table)), /column schemas/);
  for (const id of [-1, 1, 0.5, '0', null])
    assert.throws(
      () => unpackMapDataTransport(envelope([MAP_COLUMNS, [['id']], [id], [[['first']]]])),
      /record order/,
    );
  for (const columns of [null, [], [null], [['first', 'extra']], [['first'], []]])
    assert.throws(
      () => unpackMapDataTransport(envelope([MAP_COLUMNS, [['id']], [0], [columns]])),
      /column length/,
    );
  assert.throws(
    () =>
      unpackMapDataTransport(
        envelope([MAP_COLUMNS, [['id'], ['name']], [0, 1, 0], [[['first', 'last']], [[]]]]),
      ),
    /column length/,
  );
});

test('malformed record schemas and rows fail before entering game data', () => {
  const envelope = (records) => [MAP_DATA_TRANSPORT, { records }];
  for (const table of [
    [MAP_RECORDS],
    [MAP_RECORDS, [], []],
    [MAP_RECORDS, 'keys', []],
    [MAP_RECORDS, [[1]], []],
    [MAP_RECORDS, [['id', 'id']], []],
    [MAP_RECORDS, [['id']], null],
    [MAP_RECORDS, [['id']], [], 'trailing'],
  ])
    assert.throws(() => unpackMapDataTransport(envelope(table)), /record schemas/);
  for (const row of [null, [], [-1, 'id'], [1, 'id'], [0.5, 'id'], ['0', 'id'], [0], [0, 'id', 'extra']])
    assert.throws(() => unpackMapDataTransport(envelope([MAP_RECORDS, [['id']], [row]])), /record row/);
});

test('malformed envelopes, coordinate scales, deltas and integer overflow fail explicitly', () => {
  const envelope = (sequence) => [MAP_DATA_TRANSPORT, { ring: sequence }];
  for (const data of [null, 1, [MAP_DATA_TRANSPORT], ['CGMAP2', {}], [MAP_DATA_TRANSPORT, []]])
    assert.throws(() => unpackMapDataTransport(data), /transport/);
  for (const scale of [0, -1, 3, '10', Infinity])
    assert.throws(
      () => unpackMapDataTransport(envelope([MAP_COORDINATE_SEQUENCE, scale, 0, 0, 1, 0, 0, 1])),
      /coordinate sequence/,
    );
  for (const bad of [1.5, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => unpackMapDataTransport(envelope([MAP_COORDINATE_SEQUENCE, 1, bad, 0, 1, 0, 0, 1])),
      /coordinate delta/,
    );
  assert.throws(
    () => unpackMapDataTransport(envelope([MAP_COORDINATE_SEQUENCE, 1, 0, 0, 1, 0, 0])),
    /coordinate sequence/,
  );
  assert.throws(
    () =>
      unpackMapDataTransport(envelope([MAP_COORDINATE_SEQUENCE, 1, Number.MAX_SAFE_INTEGER, 0, 1, 0, 0, 1])),
    /overflows/,
  );
  assert.throws(() => unpackMapDataTransport(envelope([MAP_NEGATIVE_ZERO, 1])), /negative-zero/);
});
