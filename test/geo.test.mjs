import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpatialIndex,
  makeRoadIndex,
  nearestOnSegment,
  DRIVABLE,
  seeded,
  inside,
  inPolygon,
} from '../app/geo.js';

test('polygon membership preserves boundaries, courtyards, winding and empty holes', () => {
  const ring = [
    [-30, -20],
    [30, -20],
    [30, 0],
    [12, 0],
    [12, 20],
    [-30, 20],
  ];
  const holes = [
    [
      [-12, -12],
      [-2, -12],
      [-2, -2],
      [-12, -2],
    ],
    [
      [2, -12],
      [12, -12],
      [7, -2],
    ],
  ];
  const sparse = [];
  sparse[2] = holes[0];
  const random = seeded(2031);
  const points = [
    ...ring,
    ...holes.flat(),
    [0, -0],
    [NaN, 0],
    [Infinity, 0],
    ...Array.from({ length: 2000 }, () => [random() * 100 - 50, random() * 100 - 50]),
  ];
  for (const outer of [ring, [...ring].reverse()])
    for (const cutouts of [undefined, null, [], holes, holes.map((h) => [...h].reverse()), sparse]) {
      const poly = { ring: outer, holes: cutouts };
      for (const [x, z] of points)
        assert.equal(
          inPolygon(x, z, poly),
          inside(x, z, outer) && !(cutouts || []).some((hole) => inside(x, z, hole)),
        );
    }
});

function referenceNear(index, x, z, radius = 0) {
  const found = new Set();
  for (let gx = Math.floor((x - radius) / index.size); gx <= Math.floor((x + radius) / index.size); gx++)
    for (let gz = Math.floor((z - radius) / index.size); gz <= Math.floor((z + radius) / index.size); gz++)
      for (const item of index.cells.get(`${gx},${gz}`) || []) found.add(item);
  return found;
}

function referenceNearest(index, x, z, driveOnly, radius, namedStreet) {
  let best = null;
  for (const segment of referenceNear(index, x, z, radius)) {
    if (driveOnly && (!DRIVABLE.has(segment.road.kind) || segment.road.transitOnly)) continue;
    if (namedStreet && (!segment.road.name || segment.road.kind === 'service')) continue;
    const point = nearestOnSegment(x, z, segment.a, segment.b);
    if (!best || point.distance < best.distance) best = { ...point, ...segment };
  }
  return best;
}

test('single-cell and multi-cell lookups retain source identity/order and independent results', () => {
  const index = new SpatialIndex(16),
    a = { id: 1 },
    b = { id: 1 },
    c = { id: 3 };
  index.cells.set('-1,0', [b, a, b]);
  index.cells.set('0,0', [c, a]);
  for (const x of [-16, -0, 0, 16, 100])
    for (const z of [-16, 0, 16])
      for (const radius of [0, 0.01, 3, 16, 35])
        assert.deepEqual([...index.near(x, z, radius)], [...referenceNear(index, x, z, radius)]);
  const previous = index.near(0, 0);
  index.cells.set('0,0', [b]);
  assert.deepEqual([...index.near(0, 0)], [b]);
  assert.deepEqual([...previous], [c, a]);
  previous.clear();
  assert.deepEqual([...index.near(0, 0)], [b]);
});

test('road queries match reference positions and selection for randomized geometry and mutable road tags', () => {
  const random = seeded(714),
    roads = Array.from({ length: 180 }, (_, i) => ({
      id: i,
      name: i % 3 ? `Street ${i}` : '',
      kind: ['residential', 'primary', 'service', 'cycleway', 'footway'][i % 5],
      tunnel: i % 17 === 0,
      transitOnly: i % 19 === 0,
      points: Array.from({ length: 4 }, () => [random() * 700 - 350, random() * 700 - 350]),
    })),
    map = makeRoadIndex(roads);
  for (let i = 0; i < 1000; i++) {
    const x = random() * 900 - 450,
      z = random() * 900 - 450,
      radius = [0, 1, 28, 80, 120][i % 5],
      driveOnly = i % 2 === 0,
      named = i % 3 === 0;
    assert.deepEqual(
      map.nearest(x, z, driveOnly, radius, named),
      referenceNearest(map.index, x, z, driveOnly, radius, named),
    );
    if (i % 10 === 0) {
      const road = roads[i % roads.length];
      road.kind = road.kind === 'service' ? 'residential' : 'service';
      road.transitOnly = !road.transitOnly;
      road.name = road.name ? '' : 'Changed street';
      road.points[0][0] += 0.1;
    }
  }
});

test('ties, endpoints, negative zero and empty queries retain their exact results', () => {
  const make = (id, x) => ({
      id,
      name: id,
      kind: 'residential',
      points: [
        [x, -10],
        [x, 10],
      ],
    }),
    map = makeRoadIndex([make('west', -2), make('east', 2)]);
  for (const [x, z] of [
    [0, 0],
    [-0, -0],
    [-2, 10],
    [2, -10],
    [300, 300],
    [NaN, 0],
  ])
    assert.deepEqual(map.nearest(x, z), referenceNearest(map.index, x, z, false, 120, false));
  assert.equal(map.nearest(0, 0).road.id, 'west');
  assert.equal(makeRoadIndex([]).nearest(0, 0), null);
});
