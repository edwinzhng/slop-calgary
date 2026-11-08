import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoadGraph, SpatialIndex, seeded } from '../app/geo.js';
import {
  avoidanceOffset,
  createTrafficSimulation,
  rightLaneOffset,
  trafficBodyContact,
  trafficLanePosition,
  trafficVehicleModel,
  TRAFFIC_LIMITS,
} from '../app/traffic.js';
import { createTrafficFrameWorkspace, writeTrafficRoutePose } from '../app/traffic-frame-workspace.js';

// Captured from the pre-workspace route implementation, SHA-256
// 7280acead4acf2bc670e7d63d838dbbfa6b1875ad3a7c1ef16dc753132dbbb2b.
function originalRoutePosition(car) {
  const edge = car.edge,
    pose = trafficLanePosition(edge, car.t, car.lane),
    distance = car.t * edge.length,
    remaining = edge.length - distance,
    currentOffset = rightLaneOffset(edge.road, car.lane),
    currentX = -Math.cos(edge.heading) * currentOffset,
    currentZ = Math.sin(edge.heading) * currentOffset,
    blend = Math.min(6, edge.length * 0.3);
  const blendOffset = (other, amount) => {
    const offset = rightLaneOffset(other.road, car.lane),
      targetX = (-Math.cos(other.heading) * offset + currentX) * 0.5,
      targetZ = (Math.sin(other.heading) * offset + currentZ) * 0.5,
      t = amount * amount * (3 - 2 * amount);
    pose.x += (targetX - currentX) * t;
    pose.z += (targetZ - currentZ) * t;
  };
  if (car.previousEdge && distance < blend) blendOffset(car.previousEdge, 1 - distance / blend);
  if (car.nextEdge && remaining < blend) blendOffset(car.nextEdge, 1 - remaining / blend);
  return pose;
}

function edge(heading, length, road = {}) {
  return {
    a: [0, -0],
    b: [Math.sin(heading) * length, Math.cos(heading) * length],
    heading,
    length,
    road: { kind: 'primary', lanes: 4, ...road },
  };
}

test('the smaller fleet fills nearby streets without overlapping vehicles', () => {
  const roads = Array.from({ length: 161 }, (_, i) => ({
    id: `city-street-${i}`,
    kind: 'secondary',
    lanes: 4,
    width: 12.8,
    points: [
      [-240, (i - 10) * 35],
      [-90, (i - 10) * 35],
      [90, (i - 10) * 35],
      [240, (i - 10) * 35],
    ],
  }));
  const simulation = createTrafficSimulation(
    { data: { roads }, surfaceHeight: () => 0.18 },
    makeRoadGraph(roads),
    seeded(53),
    TRAFFIC_LIMITS.touchFleet,
  );
  const inNeighborhood = (car) => car.edge && Math.hypot(car.x, car.z) < 290;
  assert.ok(simulation.fleet.filter(inNeighborhood).length < TRAFFIC_LIMITS.touchNearby);
  simulation.populate({ x: 0, z: 0, lookX: 0, lookZ: 1, initial: true }, TRAFFIC_LIMITS.touchNearby);
  const local = simulation.fleet.filter(inNeighborhood);
  assert.ok(local.length >= TRAFFIC_LIMITS.touchNearby);
  for (const [i, car] of local.entries()) {
    const bus = car.model === 'bus';
    const body = {
      car: true,
      cos: Math.cos(car.heading),
      sin: Math.sin(car.heading),
      hx: bus ? 1.29 : 0.9,
      hz: bus ? 6.08 : 2.3,
    };
    for (const other of local.slice(i + 1)) assert.equal(trafficBodyContact(car, body, other), false);
  }
});

test('traffic reacts to a predicted crossing at the same level while buses keep their longer collision body', () => {
  const street = edge(0, 120, { width: 14 }),
    car = { x: -3, y: 0.2, z: 15, heading: 0, speed: 9, seed: 0.4, edge: street, t: 0.125, lane: 0 },
    player = { x: -3.7, y: 0.2, z: 25, mode: 'walk', velocityX: 0, velocityZ: 0 };
  assert.ok(avoidanceOffset(car, player) > 0.3);
  assert.equal(avoidanceOffset(car, { ...player, y: 6 }), 0);
  assert.equal(avoidanceOffset(car, { ...player, z: 6 }), 0);
  assert.equal(avoidanceOffset({ ...car, model: 'bus' }, player), 0);
  const bumper = { x: car.x, y: car.y, z: car.z + 5.7 };
  assert.equal(trafficBodyContact(bumper, { radius: 0.42 }, car), false);
  assert.equal(trafficBodyContact(bumper, { radius: 0.42 }, { ...car, model: 'bus' }), true);
  assert.equal(trafficVehicleModel(0.299), 'pickup');
  assert.equal(trafficVehicleModel(0.3), 'sedan');
});

test('scratch route poses retain exact coordinates through both turn blends and mutable road attributes', () => {
  const output = {},
    angles = [0, -0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI, 0.7321],
    roads = [
      {},
      { lanes: 1, oneway: 'yes' },
      { lanes: 3, width: 9.7, oneway: '-1' },
      { lanes: 6, width: 19.2 },
    ];
  let checked = 0;
  for (const heading of angles)
    for (const length of [1.01, 4, 80, 500])
      for (const road of roads)
        for (const t of [0, Number.EPSILON, 0.01, 0.15, 0.5, 0.85, 0.99, 1])
          for (const lane of [0, 1, 7, -3]) {
            const car = {
              edge: edge(heading, length, road),
              previousEdge: edge(heading - 1.72, 70, { lanes: 2 }),
              nextEdge: edge(heading + 0.84, 90, { oneway: 'yes' }),
              t,
              lane,
            };
            for (const mutate of [false, true]) {
              if (mutate) {
                car.edge.heading += 0.317;
                car.edge.road.width = 11.37;
                car.nextEdge.road.lanes = 1;
              }
              assert.equal(writeTrafficRoutePose(car, output, rightLaneOffset), output);
              assert.deepEqual(output, originalRoutePosition(car));
              checked++;
            }
          }
  assert.equal(checked, 7168);
});

test('neighbour scratch storage preserves identity/order while rereading moving buckets', () => {
  const index = new SpatialIndex(32),
    workspace = createTrafficFrameWorkspace(rightLaneOffset),
    owner = {},
    a = { id: 1 },
    b = { id: 1 }, // Equal IDs must not conflate distinct objects.
    c = { id: 3 },
    d = { id: 4 };
  index.cells.set('-1,-1', [b, a, b]);
  index.cells.set('-1,0', [c, a]);
  index.cells.set('0,-1', [d, c]);
  const expected = () => [...index.near(0, 0, 31)];
  const first = workspace.neighbours(index, 0, 0, 31, owner);
  assert.deepEqual(first, expected());
  assert.deepEqual(first, [b, a, c, d]);
  first.push({ player: true });
  // Same bounds, different contents, removed bucket, and a newly present bucket.
  index.cells.set('-1,-1', [c, b]);
  index.cells.delete('-1,0');
  index.cells.set('0,0', [a, d, b]);
  const second = workspace.neighbours(index, 0.1, 0.1, 31, owner);
  assert.equal(second, first);
  assert.deepEqual(second, expected());
  assert.deepEqual(second, [c, b, d, a]);
  assert.deepEqual(workspace.stats, { keyBuilds: 1, keyCacheHits: 1 });
});

test('query bounds, radius, grid size and index identity invalidate cached coordinates', () => {
  const workspace = createTrafficFrameWorkspace(rightLaneOffset),
    owner = {},
    index = new SpatialIndex(32),
    rng = seeded(321);
  const objects = Array.from({ length: 40 }, (_, id) => ({ id }));
  for (const item of objects) {
    const x = rng() * 600 - 300,
      z = rng() * 600 - 300;
    index.insert(item, { minX: x - 15, maxX: x + 15, minZ: z - 15, maxZ: z + 15 });
  }
  for (let i = 0; i < 300; i++) {
    const x = i % 2 ? rng() * 600 - 300 : -32,
      z = i % 3 ? rng() * 600 - 300 : 32,
      radius = [0, 1, 32, 70, 100][i % 5];
    assert.deepEqual(workspace.neighbours(index, x, z, radius, owner), [...index.near(x, z, radius)]);
  }
  const other = new SpatialIndex(32);
  other.insert(objects[39], { minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
  assert.deepEqual(workspace.neighbours(index, 0, 0, 31, owner), [...index.near(0, 0, 31)]);
  assert.deepEqual(workspace.neighbours(other, 0, 0, 31, owner), [objects[39]]);
  const builds = workspace.stats.keyBuilds;
  other.size = 64;
  assert.deepEqual(workspace.neighbours(other, 0, 0, 31, owner), [objects[39]]);
  assert.equal(workspace.stats.keyBuilds, builds + 1, 'even identical integer bounds must revalidate size');
  other.cells = new Map([['0,0', [objects[38]]]]);
  assert.deepEqual(workspace.neighbours(other, 0, 0, 31, owner), [objects[38]]);
});

test('workspace lifetime is isolated between simulations and owners never share cached bounds', () => {
  const a = createTrafficFrameWorkspace(rightLaneOffset),
    b = createTrafficFrameWorkspace(rightLaneOffset),
    index = new SpatialIndex(32),
    ownerA = {},
    ownerB = {},
    itemA = {},
    itemB = {};
  index.cells.set('0,0', [itemA]);
  index.cells.set('4,4', [itemB]);
  assert.deepEqual(a.neighbours(index, 0, 0, 1, ownerA), [itemA]);
  const otherResult = b.neighbours(index, 128, 128, 1, ownerB);
  assert.deepEqual(otherResult, [itemB]);
  assert.deepEqual(a.neighbours(index, 128, 128, 1, ownerB), [itemB]);
  assert.deepEqual(a.neighbours(index, 0, 0, 1, ownerA), [itemA]);
  assert.deepEqual(otherResult, [itemB]);
  const car = { edge: edge(0.8, 50), t: 0.5, lane: 0 };
  const aPose = a.pose(car),
    bPose = b.pose(car);
  assert.notEqual(aPose, bPose);
  car.t = 0.9;
  b.pose(car);
  assert.deepEqual(aPose, originalRoutePosition({ ...car, t: 0.5 }));
});
