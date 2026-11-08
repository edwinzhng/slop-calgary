import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import { bindStorefront, createStorefronts, layoutStorefrontEdge } from '../app/storefronts.js';
import { bounds, makeRoadIndex, nearestOnSegment, project, SpatialIndex } from '../app/geo.js';

function bindings(a, c, pins) {
  const length = Math.hypot(c[0] - a[0], c[1] - a[1]),
    b = { id: 'compound' };
  return pins.map(({ id, x, z = 0, score = 0, kind = 'shop' }) => ({
    place: { id, name: id, kind, x, z },
    b,
    a,
    c,
    length,
    edge: 1,
    score,
    ...nearestOnSegment(x, z, a, c),
  }));
}

function byId(records) {
  return [...records].sort((a, b) => (a.place.id < b.place.id ? -1 : a.place.id > b.place.id ? 1 : 0));
}

function assertWithinEdge(records) {
  const spans = records
    .map((s) => {
      const center = nearestOnSegment(s.x, s.z, s.a, s.c).t * s.length;
      assert.ok(s.width >= 3.4 - 1e-10 && s.width <= 8);
      assert.ok(center - s.width / 2 >= 0.3 - 1e-10);
      assert.ok(center + s.width / 2 <= s.length - 0.3 + 1e-10);
      return [center - s.width / 2, center + s.width / 2];
    })
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] - spans[i - 1][1] >= 0.6 - 1e-10);
}

test('the actual Ninth Avenue compound keeps 917 west of 921 instead of sorting signs by score', async () => {
  const [data, places] = await Promise.all(
    ['calgary.json', 'calgary-places.json'].map(async (name) =>
      JSON.parse(await fs.readFile(new URL(`../data/${name}`, import.meta.url))),
    ),
  );
  const building = data.buildings.find((b) => b.id === 'city-outline-27163-0'),
    buildingIndex = new SpatialIndex(80),
    sourceIds = ['osm-node-12439655199', 'osm-way-540861994', 'osm-way-1344640882'],
    sourcePlaces = sourceIds.map((id) => places.places.find((p) => p.id === id)),
    roadIndex = makeRoadIndex(data.roads),
    world = { buildingIndex, roadIndex };
  buildingIndex.insert(building, bounds(building.ring));
  const stats = { candidateEdges: 0, prunedEdges: 0, roadQueries: 0 },
    stores = sourcePlaces.map((place) => bindStorefront(place, world, stats));
  for (const s of stores) {
    assert.equal(s.b, building);
    assert.equal(s.edge, 2);
    const projection = nearestOnSegment(s.place.x, s.place.z, s.a, s.c);
    assert.equal(s.t, projection.t);
    assert.equal(s.x, projection.x);
    assert.equal(s.z, projection.z);
  }
  const [untitled, apothecary] = stores;
  assert.equal(untitled.place.address, '917 9 Avenue SE');
  assert.equal(apothecary.place.address, '921 9 Avenue SE');
  assert.ok(untitled.score < apothecary.score && untitled.t > apothecary.t);
  const { records, facades } = layoutStorefrontEdge(stores),
    west = facades.find((s) => s.place.id === untitled.place.id),
    east = facades.find((s) => s.place.id === apothecary.place.id);
  assert.equal(records.length, 3, 'the cached market must remain available as a destination');
  assert.equal(facades.length, 2, 'the market must not acquire an invented permanent doorway');
  for (const s of records) {
    const original = stores.find((r) => r.place.id === s.place.id);
    assert.equal(s.x, original.x);
    assert.equal(s.z, original.z);
  }
  assert.equal(west.x, untitled.x);
  assert.equal(west.z, untitled.z);
  assert.equal(east.x, apothecary.x);
  assert.equal(east.z, apothecary.z);
  assert.ok(west.x > 2211 && west.x < 2212);
  assert.ok(east.x > 2230 && east.x < 2231);
  assertWithinEdge(facades);

  let roadQueries = 0;
  const nearest = roadIndex.nearest;
  roadIndex.nearest = (...args) => {
    roadQueries++;
    return nearest(...args);
  };
  const planned = createStorefronts(new THREE.Scene(), world, sourcePlaces);
  assert.equal(planned.count, 3);
  assert.equal(planned.facadeCount, 2);
  assert.deepEqual(planned.destinations.map((p) => p.name).sort(), sourcePlaces.map((p) => p.name).sort());
  const market = planned.destinations.find((p) => p.name === sourcePlaces[2].name),
    marketPoint = project(market.lon, market.lat);
  assert.ok(Math.abs(marketPoint[0] - sourcePlaces[2].x) < 1e-8);
  assert.ok(Math.abs(marketPoint[1] - sourcePlaces[2].z) < 1e-8);
  assert.deepEqual(planned.stats, stats);
  assert.equal(roadQueries, stats.roadQueries, 'layout must not perform additional road searches');
  assert.deepEqual(
    createStorefronts(new THREE.Scene(), world, [...sourcePlaces].reverse()).destinations,
    planned.destinations,
  );
  world.authoredStorefrontBuildingIds = new Set([building.id]);
  const authored = createStorefronts(new THREE.Scene(), world, sourcePlaces);
  assert.equal(authored.count, 3);
  assert.equal(
    authored.facadeCount,
    0,
    'accepted authored storefronts must suppress only generic facade bodies',
  );
  assert.deepEqual(authored.destinations, planned.destinations);
});

test('frontage positions do not change with POI order or score order when both bays fit', () => {
  const stores = bindings(
      [0, 0],
      [40, 0],
      [
        { id: 'west', x: 8, score: 10 },
        { id: 'east', x: 32, score: -20 },
      ],
    ),
    original = [...stores],
    layout = layoutStorefrontEdge(stores);
  assert.deepEqual(layoutStorefrontEdge([...stores].reverse()), layout);
  const changedScores = layoutStorefrontEdge(stores.map((s) => ({ ...s, score: -s.score })));
  for (const s of layout.facades) {
    const changed = changedScores.facades.find((r) => r.place.id === s.place.id);
    assert.equal(changed.x, s.x);
    assert.equal(changed.z, s.z);
    assert.equal(changed.width, s.width);
    assert.equal(s.x, s.place.id === 'west' ? 8 : 32);
    assert.equal(s.place, stores.find((r) => r.place.id === s.place.id).place);
    assert.equal(s.b, stores[0].b);
  }
  assert.deepEqual(stores, original);
  assertWithinEdge(layout.facades);
});

test('reversing a diagonal segment preserves physical positions, widths and selected businesses', () => {
  const a = [-12, 6],
    c = [12, 38],
    pins = [
      { id: 'start', x: -10.8, z: 7.6 },
      { id: 'middle', x: 0, z: 22 },
      { id: 'end', x: 10.8, z: 36.4 },
    ],
    forward = byId(layoutStorefrontEdge(bindings(a, c, pins)).facades),
    reverse = byId(layoutStorefrontEdge(bindings(c, a, pins)).facades);
  assert.deepEqual(
    forward.map((s) => s.place.id),
    reverse.map((s) => s.place.id),
  );
  for (let i = 0; i < forward.length; i++)
    for (const key of ['x', 'z', 'width']) assert.ok(Math.abs(forward[i][key] - reverse[i][key]) < 1e-10);
  assertWithinEdge(forward);
  assertWithinEdge(reverse);
});

test('coincident and tightly clustered pins keep all destinations with a deterministic visible sign', () => {
  const stores = bindings(
      [0, 0],
      [40, 0],
      [
        { id: 'b', x: 10 },
        { id: 'c', x: 11 },
        { id: 'a', x: 10 },
        { id: 'd', x: 30 },
      ],
    ),
    layout = layoutStorefrontEdge(stores);
  assert.deepEqual(
    layout.records.map((s) => [s.place.id, s.x]),
    [
      ['a', 10],
      ['b', 10],
      ['c', 11],
      ['d', 30],
    ],
  );
  assert.deepEqual(
    layout.facades.map((s) => [s.place.id, s.x]),
    [
      ['a', 10],
      ['d', 30],
    ],
  );
  assert.deepEqual(layoutStorefrontEdge([...stores].reverse()), layout);
  assertWithinEdge(layout.facades);
});

test('neighbouring bays shrink without moving their projected centres', () => {
  const stores = bindings(
      [0, 0],
      [20, 0],
      [
        { id: 'a', x: 4 },
        { id: 'b', x: 10 },
        { id: 'c', x: 16 },
      ],
    ),
    { records, facades } = layoutStorefrontEdge(stores);
  assert.deepEqual(
    records.map((s) => s.x),
    [4, 10, 16],
  );
  assert.ok(facades.every((s) => s.width < 8));
  assertWithinEdge(facades);
});

test('endpoint destinations stay at their projections without inventing a shifted doorway', () => {
  for (const length of [4, 20]) {
    const { records, facades } = layoutStorefrontEdge(
      bindings(
        [0, 0],
        [length, 0],
        [
          { id: 'a', x: -3 },
          { id: 'b', x: length + 3 },
        ],
      ),
    );
    assert.equal(records[0].x, 0);
    assert.equal(records.at(-1).x, length === 4 ? 0 : length);
    assert.equal(records.length, length === 4 ? 1 : 2);
    assert.equal(facades.length, 0);
  }
  const shortest = layoutStorefrontEdge(bindings([0, 0], [4, 0], [{ id: 'middle', x: 2 }]));
  assert.equal(shortest.facades.length, 1);
  assertWithinEdge(shortest.facades);
  assert.deepEqual(layoutStorefrontEdge([]), { records: [], facades: [] });
});

test('the density cap selects by confidence without using rank for the remaining positions', () => {
  const stores = bindings(
      [0, 0],
      [40, 0],
      [
        { id: 'a', x: 4, score: 5 },
        { id: 'b', x: 12, score: 1 },
        { id: 'c', x: 20, score: 0 },
        { id: 'd', x: 28, score: 3 },
        { id: 'e', x: 36, score: 2 },
      ],
    ),
    layout = layoutStorefrontEdge(stores);
  assert.deepEqual(
    byId(layout.records).map((s) => [s.place.id, s.x]),
    [
      ['b', 12],
      ['c', 20],
      ['d', 28],
      ['e', 36],
    ],
  );
  assert.deepEqual(layoutStorefrontEdge([...stores].reverse()), layout);
  assertWithinEdge(layout.facades);
});

test('marketplace destinations never imply a permanent facade even when there is room', () => {
  const { records, facades } = layoutStorefrontEdge(
    bindings(
      [0, 0],
      [40, 0],
      [
        { id: 'market', x: 10, kind: 'marketplace' },
        { id: 'shop', x: 30 },
      ],
    ),
  );
  assert.equal(records.length, 2);
  assert.deepEqual(
    facades.map((s) => s.place.id),
    ['shop'],
  );
});

test('nearby facade creation stays within the existing quality budget without hiding destinations', (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  let canvases = 0;
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      canvases++;
      return {
        getContext: () => ({
          save() {},
          restore() {},
          translate() {},
          fillRect() {},
          strokeRect() {},
          fillText() {},
          measureText: () => ({ width: 100 }),
        }),
      };
    },
  };
  const buildingIndex = new SpatialIndex(80),
    places = Array.from({ length: 50 }, (_, i) => {
      const x = (i % 8) * 20,
        z = Math.floor(i / 8) * 20,
        b = {
          id: `building-${i}`,
          height: 8,
          kind: 'commercial',
          ring: [
            [x, z],
            [x + 10, z],
            [x + 10, z + 10],
            [x, z + 10],
            [x, z],
          ],
        };
      buildingIndex.insert(b, bounds(b.ring));
      return { id: `place-${i}`, name: `Place ${i}`, kind: 'beauty', x: x + 5, z: z + 1 };
    }),
    scene = new THREE.Scene(),
    world = { buildingIndex, roadIndex: { nearest: () => ({ distance: 0 }) }, groundHeight: () => 1.25 },
    storefronts = createStorefronts(scene, world, places),
    camera = new THREE.PerspectiveCamera();
  camera.position.set(65, 1.7, 65);
  assert.equal(storefronts.count, places.length);
  assert.equal(storefronts.destinations.length, places.length);
  assert.equal(storefronts.facadeCount, places.length);
  storefronts.update(camera, 'balanced');
  const [batch] = scene.children;
  assert.equal(storefronts.rendering.active, 24);
  assert.equal(scene.children.length, 1);
  assert.equal(canvases, 1);
  batch.geometry.computeBoundingBox();
  assert.equal(batch.geometry.boundingBox.min.y, 1.25, 'frontages meet the local ground level');
  const initial = batch.geometry;
  storefronts.update(camera, 'balanced');
  assert.equal(batch.geometry, initial, 'a stationary view must reuse the batch');
  storefronts.update(camera, 'high');
  assert.equal(storefronts.rendering.active, 36);
  assert.equal(scene.children.length, 1);
  assert.equal(canvases, 1, 'all quality levels share one storefront atlas');
  assert.equal(world.businessPlaces.length, places.length);
  camera.position.y = 200;
  storefronts.update(camera, 'high');
  assert.equal(storefronts.rendering.active, 0);
  assert.equal(batch.visible, false);
  assert.equal(world.businessPlaces.length, places.length);
  camera.position.y = 1.7;
  storefronts.update(camera, 'balanced');
  assert.equal(batch.visible, true);
  assert.equal(storefronts.rendering.active, 24);
  assert.equal(canvases, 1, 'returning to the street reuses the atlas');
});
