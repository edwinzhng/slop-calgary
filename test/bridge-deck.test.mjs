import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { bridgePath, bridgeBand, BRIDGE_BAND_TRIANGLES } from '../app/bridge-path.js';
import { createBridgeDeck } from '../app/bridge-deck.js';
import { connectBridgeForks } from '../app/bridge-forks.js';
import { createBridgeCollisionParts } from '../app/bridge-collision.js';
import {
  approachRoadEdgeIntervals,
  createInfrastructureSurfaces,
  bridgeDeckHeight,
} from '../app/infrastructure.js';
import { applyRoadAttributes } from '../app/road-attributes.js';
import { applySiteOverlays } from '../app/site-overlays.js';
import { movementBody, footprintContact } from '../app/camera-collision.js';
import { SpatialIndex, bounds } from '../app/geo.js';

const json = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}.json`, import.meta.url)));
const data = json('calgary');
applyRoadAttributes(data, json('calgary-road-attributes'));
applySiteOverlays(data, json('calgary-site-overlay'));
const surfaces = createInfrastructureSurfaces(data);

function plan(points, { name = 'Test bridge', level = 4.8, layer = 1, drive = true } = {}) {
  const p = {
    name,
    points,
    length: bridgePath(points).length,
    level,
    width: drive ? 10.6 : 3.8,
    drive,
    roads: [{ id: name, points, layer }],
    approaches: [],
  };
  p.deck = createBridgeDeck(p, (p) => p.level);
  return p;
}

test('source bends remain shared cross sections with continuous mitered outer corners', () => {
  const p = plan(
    [
      [0, 0],
      [20, 0],
      [20, 20],
    ],
    { drive: false },
  );
  assert.deepEqual(bridgePath(p.points).sample(0.5), { x: 20, z: 0, dx: 1, dz: 0, nx: -1, nz: 1 });
  for (let i = 1; i < p.deck.segments.length; i++) {
    assert.deepEqual(
      p.deck.segments[i - 1].slab.vertices.slice(3),
      p.deck.segments[i].slab.vertices.slice(0, 3),
    );
  }
  const corner = p.deck.segments.find((s) => s.from === 0.5);
  assert.ok(corner.floor(21.7, -1.7) !== null, 'the outer corner has an actual floor');
  assert.equal(corner.floor(22.1, -2.1), null, 'support does not extend beyond the deck');
  const parts = createBridgeCollisionParts({ plans: [p] }),
    body = movementBody('cycle'),
    contact = {};
  assert.ok(parts.barriers.every((part) => !footprintContact(part, 20, 4.8, 0, body, contact)));
});

test('Float32 band queries agree with independent Three rays and retain a submillimetre seam limit', () => {
  const p = plan(
      [
        [3000.123, 1000.456],
        [3020.789, 1003.135],
      ],
      { drive: false },
    ),
    band = bridgeBand(p, 0, 1, -1.9, 1.9, 0.2, 2.7),
    down = new THREE.Vector3(0, -1, 0),
    ray = new THREE.Ray(),
    hit = new THREE.Vector3();
  for (const ids of BRIDGE_BAND_TRIANGLES) {
    const [a, b, c] = ids.map((i) => new THREE.Vector3(...band.vertices[i])),
      centre = a
        .clone()
        .add(b)
        .add(c)
        .multiplyScalar(1 / 3);
    ray.set(centre.clone().add(new THREE.Vector3(0, 1, 0)), down);
    assert.ok(ray.intersectTriangle(a, b, c, true, hit));
    assert.ok(Math.abs(band.heightAt(centre.x, centre.z) - hit.y) < 1e-8);
  }
  const straight = plan([
      [0, 0],
      [20, 0],
    ]),
    end = bridgeBand(straight, 0, 1, -2, 2, 1, 1);
  assert.equal(end.heightAt(20.0004, 0), 1);
  assert.equal(end.heightAt(20.001, 0), null);
});

test('all actual bridge deck bands have upward faces and independent triangle-plane agreement', (t) => {
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    centre = new THREE.Vector3(),
    hit = new THREE.Vector3(),
    down = new THREE.Vector3(0, -1, 0),
    ray = new THREE.Ray();
  let bands = 0,
    rays = 0;
  assert.ok(surfaces.plans.length >= 96, 'the city inventory includes the original bridge coverage');
  for (const p of surfaces.plans) {
    assert.equal(p.deck.stats.foldedTriangles, 0, p.name);
    assert.equal(p.deck.stats.degenerateTriangles, 0, p.name);
    for (const s of p.deck.segments)
      for (const band of [s.slab, ...s.paving.map((s) => s.band)]) {
        bands++;
        for (const [ia, ib, ic] of BRIDGE_BAND_TRIANGLES) {
          a.fromArray(band.vertices[ia]);
          b.fromArray(band.vertices[ib]);
          c.fromArray(band.vertices[ic]);
          centre
            .copy(a)
            .add(b)
            .add(c)
            .multiplyScalar(1 / 3);
          ray.set(hit.copy(centre).addScaledVector(down, -1), down);
          assert.ok(ray.intersectTriangle(a, b, c, true, hit), p.name);
          assert.ok(Math.abs(band.heightAt(centre.x, centre.z) - hit.y) < 1e-6, p.name);
          rays++;
        }
      }
  }
  t.diagnostic(JSON.stringify({ plans: surfaces.plans.length, bands, independentRays: rays }));
});

test('mapped forks open the joining rail while unconnected or separated deck levels keep their guards', () => {
  for (const [points, options, expected] of [
    [
      [
        [0, 0],
        [30, 12],
      ],
      {},
      true,
    ],
    [
      [
        [0, 0],
        [30, 12],
      ],
      { layer: 2 },
      false,
    ],
    [
      [
        [0, 0],
        [30, 12],
      ],
      { level: 8.4 },
      false,
    ],
    [
      [
        [15, -20],
        [15, 20],
      ],
      {},
      false,
    ],
  ]) {
    const a = plan(
        [
          [0, 0],
          [30, 0],
        ],
        { name: 'A' },
      ),
      b = plan(points, { name: 'B', ...options });
    const result = connectBridgeForks([a, b]);
    assert.equal(result.openings > 0, expected);
    if (expected) {
      assert.ok(a.accessOpenings.some((o) => o.side === 1));
      assert.ok(!a.accessOpenings.some((o) => o.side === -1), 'the opposite outside guard remains');
      const before = JSON.stringify([a.accessOpenings, b.accessOpenings]);
      connectBridgeForks([a, b]);
      assert.equal(
        JSON.stringify([a.accessOpenings, b.accessOpenings]),
        before,
        'rebuilding does not duplicate openings',
      );
    }
  }
});

function approachFixture() {
  const bridge = plan(
    [
      [0, 0],
      [20, 0],
    ],
    { name: 'Approach bridge', drive: false, level: 2 },
  );
  bridge.approaches.push({
    a: [0, -10],
    b: [0, 0],
    width: 3.8,
    h0: 0.8,
    h1: 2,
    road: {
      id: 'mapped-approach',
      kind: 'footway',
      points: [
        [0, -10],
        [0, 0],
      ],
      layer: 0,
    },
  });
  return bridge;
}

test('an exact mapped approach opens its deck entry while keeping the floor and outside guard', () => {
  const bridge = approachFixture(),
    body = movementBody('walk'),
    before = createBridgeCollisionParts({ plans: [bridge] }),
    geometry = JSON.stringify(bridge.deck.segments.map((s) => s.neutral.vertices)),
    blocked = (parts, x, y, z) => parts.barriers.some((p) => footprintContact(p, x, y, z, body, {}));
  assert.equal(blocked(before, 0, 1.76, -2), true);
  assert.ok(connectBridgeForks([bridge]).openings > 0);
  const after = createBridgeCollisionParts({ plans: [bridge] });
  assert.equal(blocked(after, 0, 1.76, -2), false);
  assert.equal(blocked(after, 3, 2, -1.8), true);
  assert.equal(blocked(after, 1, 2, 1.8), true);
  assert.equal(JSON.stringify(bridge.deck.segments.map((s) => s.neutral.vertices)), geometry);
  const openings = JSON.stringify(bridge.accessOpenings);
  connectBridgeForks([bridge]);
  assert.equal(JSON.stringify(bridge.accessOpenings), openings);
});

test('approach openings reject displaced source nodes, missing ownership and unreachable surfaces', () => {
  for (const [label, mutate] of [
    [
      'displaced approach node',
      (p) => {
        p.approaches[0].road.points[1][0] = 0.01;
      },
    ],
    [
      'displaced bridge node',
      (p) => {
        p.roads[0].points = [
          [0.01, 0],
          [20, 0],
        ];
      },
    ],
    [
      'missing source ID',
      (p) => {
        delete p.approaches[0].road.id;
      },
    ],
    [
      'bridge instead of approach',
      (p) => {
        p.approaches[0].road.bridge = true;
      },
    ],
    [
      'tunnel',
      (p) => {
        p.approaches[0].road.tunnel = true;
      },
    ],
    [
      'separate branch',
      (p) => {
        p.approaches[0].accessBranch = true;
      },
    ],
    [
      'different joint height',
      (p) => {
        p.approaches[0].h1 = 3;
      },
    ],
    [
      'unreachable rail/path step',
      (p) => {
        p.approaches[0].h0 = -8;
      },
    ],
  ]) {
    const bridge = approachFixture();
    mutate(bridge);
    assert.equal(connectBridgeForks([bridge]).openings, 0, label);
  }
});

function assertClearBridgeRoutes(ids, modes) {
  const roads = ids.map((id) => data.roads.find((r) => r.id === id)),
    parts = createBridgeCollisionParts(surfaces),
    index = new SpatialIndex(12);
  for (const part of parts.barriers) index.insert(part, bounds(part.ring));
  let checked = 0;
  for (const reverse of [false, true])
    for (const mode of modes)
      for (const road of reverse ? roads.slice().reverse() : roads) {
        const points = reverse ? road.points.slice().reverse() : road.points;
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1],
            b = points[i],
            count = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1),
            body = movementBody(mode, Math.atan2(b[0] - a[0], b[1] - a[1]));
          for (let j = 0; j <= count; j++) {
            const x = a[0] + ((b[0] - a[0]) * j) / count,
              z = a[1] + ((b[1] - a[1]) * j) / count,
              y = surfaces.surfaceHeight(x, z, road);
            assert.ok(Number.isFinite(y), `${road.id} has no finite support`);
            for (const part of index.near(x, z, Math.max(body.extX, body.extZ)))
              assert.equal(
                footprintContact(part, x, y, z, body, {}),
                false,
                `${road.id} ${mode} ${reverse ? 'reverse' : 'forward'} at ${x},${z}: ${part.id}`,
              );
            checked++;
          }
        }
      }
  return checked;
}

test('the actual eastern bridge and connector retain clear pedestrian and bicycle body envelopes', () => {
  assert.ok(
    assertClearBridgeRoutes(
      ['osm-way-582374922-0', 'osm-way-582374923-0', 'osm-way-582374924-0'],
      ['walk', 'cycle'],
    ) > 2600,
  );
});

test('both Blackfoot carriageways clear the opposite span guard at their modeled source centre lines', () => {
  assert.ok(
    assertClearBridgeRoutes(['osm-way-52460453-0', 'osm-way-52460663-0'], ['walk', 'cycle', 'drive']) > 17000,
  );
});

test('source owner queries select the emitted deck above an overlapping lower approach', () => {
  for (const [roadId, x, z, expected] of [
    ['osm-way-10412553-0', 3088.1798502604165, -2290.4957682291665, 4.800000190734863],
    ['osm-way-615647770-0', 2873.0651041666665, -107.99612681070964, 2.7579454184586463],
    ['osm-way-615647770-0', 2873.7825520833335, -108.19806416829427, 2.7349379313771403],
  ]) {
    const road = data.roads.find((r) => r.id === roadId);
    assert.ok(Math.abs(surfaces.surfaceHeight(x, z, road) - expected) < 1e-4);
  }
});

test('overlapping inferred approaches retain the connected road instead of acquiring a higher neighbour', () => {
  const road = data.roads.find((r) => r.id === 'osm-way-202224680-0'),
    x = -1639.7153846153847,
    z = -2069.288461538462,
    expected = 3.354449554800931;
  assert.ok(Math.abs(surfaces.surfaceHeight(x, z, road) - expected) < 1e-6);
  assert.ok(Math.abs(surfaces.groundHeight(x, z, 3.4515915341074255) - expected) < 1e-6);
});

test('actual upper and lower Centre Street decks remain separated by the elevation hint', () => {
  const p = surfaces.plans.find((p) => p.name === 'Centre Street Bridge'),
    lower = surfaces.plans.find((p) => p.name === 'Centre Street lower deck'),
    q = bridgePath(p.points).sample(0.5),
    lowerCentre = bridgePath(lower.points).sample(0.5);
  assert.equal(surfaces.groundHeight(q.x, q.z, 0.2), null);
  assert.ok(Math.abs(surfaces.groundHeight(lowerCentre.x, lowerCentre.z, 3.7) - 3.7) < 0.01);
  // The upper centreline projects onto a lower-deck sidewalk, 15cm above its roadway.
  assert.ok(Math.abs(surfaces.groundHeight(q.x, q.z, 3.7) - 3.85) < 0.01);
  assert.ok(Math.abs(surfaces.groundHeight(q.x, q.z, 8.4) - 8.4) < 0.01);
});

test('the Bow Trail lanes and the Blue Line retain separate heights at the actual crossing', () => {
  const x = -2459.255905882353,
    z = 93.17247058823531;
  const road = data.roads.find((r) => r.id === 'osm-way-98252296-0');
  const rail = data.rails.find((r) => r.id === 'osm-way-53529046-0');
  const roadway = surfaces.surfaceHeight(x, z, road);
  const guideway = surfaces.surfaceHeight(x, z, rail);
  assert.ok(guideway - roadway > 8, 'preserve the source-observed order and useful clearance');
  assert.ok(Math.abs(surfaces.groundHeight(x, z, roadway) - roadway) < 0.01);
  const plan = surfaces.byRoad.get(rail.id);
  for (const { h0, h1, from, to } of plan.deck.segments) {
    assert.ok(Math.abs(h1 - h0) / ((to - from) * plan.length) < 0.081);
  }
});

test('actual 5 Avenue branches and the zigzag pedestrian bridge have clear centreline guard corridors', (t) => {
  const parts = createBridgeCollisionParts(surfaces),
    index = new SpatialIndex(32);
  for (const part of parts.barriers) index.insert(part, bounds(part.ring));
  let probes = 0;
  for (const id of ['osm-way-1097827504-0', 'osm-way-489583239-0', 'osm-way-582374922-0']) {
    const road = data.roads.find((r) => r.id === id),
      p = surfaces.byRoad.get(id);
    assert.ok(road && p);
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1],
        b = road.points[i],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (const mode of p.drive ? ['walk', 'cycle', 'drive'] : ['walk', 'cycle']) {
        const body = movementBody(mode, Math.atan2(b[0] - a[0], b[1] - a[1])),
          contact = {};
        for (let j = 0, n = Math.ceil(length / 0.25); j <= n; j++) {
          const x = a[0] + ((b[0] - a[0]) * j) / n,
            z = a[1] + ((b[1] - a[1]) * j) / n,
            y = surfaces.surfaceHeight(x, z, road),
            hits = [];
          for (const part of index.near(x, z, Math.max(body.extX, body.extZ)))
            if (footprintContact(part, x, y, z, body, contact)) hits.push(part.id);
          assert.deepEqual(hits, [], `${id} ${mode} at ${x},${z}`);
          probes++;
        }
      }
    }
  }
  t.diagnostic(JSON.stringify({ centrelineGuardProbes: probes }));
});

test('Louise Bridge leaves its turning lanes clear through both sides of the north fork', () => {
  const bridge = surfaces.plans.find((p) => p.name === 'Louise Bridge');
  const rampRoads = new Set(bridge.approaches.map((s) => s.road.id));
  const through = bridge.approaches.filter((s) => s.road.id === 'osm-way-4596266-0');
  const intervals = (segment, side) =>
    approachRoadEdgeIntervals(segment, side, segment.width, surfaces, rampRoads);
  assert.ok(through.length >= 3);
  for (const side of [-1, 1]) {
    assert.deepEqual(intervals(through[1], side), [], 'the fork has no raised divider through the lane');
    const deckEnd = bridge.approaches.find((s) => s.road.id === 'osm-way-461139248-0');
    assert.ok(intervals(deckEnd, side).length, 'the continuous section retains its approach edge');
  }
});
