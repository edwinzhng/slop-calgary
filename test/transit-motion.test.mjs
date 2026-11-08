import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  crossingActive,
  createTransitSimulation,
  prepareTransitRoute,
  projectOnTransitRoute,
  trainBodyContact,
  transitMotion,
  transitPose,
  TRANSIT_LIMITS,
} from '../app/transit-motion.js';

const fixture = (stops = []) => ({
  routes: [
    {
      id: '201:0',
      route: '201',
      direction: '0',
      headsign: 'TUSCANY',
      points: [
        [0, 0],
        [0, 1000],
        [0, 2000],
      ],
      segments: [
        { roadId: 'rail-a', bridge: false, tunnel: false },
        { roadId: 'rail-b', bridge: false, tunnel: false },
      ],
      stops,
    },
  ],
});

test('route sampling follows real cumulative distance and hides cropped or tunnel vehicle parts', () => {
  const route = prepareTransitRoute({
    ...fixture().routes[0],
    points: [
      [0, 0],
      [0, 20],
      [40, 20],
    ],
  });
  assert.equal(transitPose(route, -1), null);
  assert.equal(transitPose(route, 61), null);
  const pose = transitPose(route, 35);
  assert.equal(pose.x, 15);
  assert.equal(pose.z, 20);
  assert.equal(pose.heading, Math.PI / 2);
  const projection = projectOnTransitRoute(route, 15, 22);
  assert.equal(projection.distance, 35);
  assert.equal(projection.lateral, 2);
});

test('bounded braking stops at a station, dwells and resumes without overshooting its mapped target', () => {
  const simulation = createTransitSimulation(
      fixture([{ id: 'station', name: 'Test platform', point: [0, 600], distance: 600 }]),
    ),
    train = simulation.trains[0],
    target = train.route.stops[0].target;
  train.distance = 500;
  train.speed = 12;
  train.nextStop = 0;
  train.policyClock = 0;
  let arrived = false,
    dwellSamples = 0;
  for (let i = 0; i < 1500; i++) {
    simulation.update(0.1);
    if (!arrived) assert.ok(train.distance <= target + 0.001);
    if (train.dwell > 0) {
      arrived = true;
      dwellSamples++;
      assert.equal(train.distance, target);
      assert.equal(train.speed, 0);
    } else if (arrived) break;
  }
  assert.ok(arrived && dwellSamples >= 178);
  for (let i = 0; i < 100; i++) simulation.update(0.1);
  assert.ok(train.distance > target + 20 && train.speed > 0);
  assert.equal(train.completedStops, 1);
});

test('trains obey red signals, then accelerate on green and maintain shared-track following gaps', () => {
  let state = 'red';
  const simulation = createTransitSimulation(fixture(), {
      signalAhead: (_x, z) => (z < 600 ? { distance: 600 - z, state } : null),
    }),
    train = simulation.trains[0];
  train.distance = 500;
  train.speed = 12;
  train.nextStop = -1;
  for (let i = 0; i < 600; i++) simulation.update(0.1);
  assert.ok(train.distance + TRANSIT_LIMITS.carLength / 2 <= 598.81);
  assert.equal(train.speed, 0);
  state = 'green';
  for (let i = 0; i < 80; i++) simulation.update(0.1);
  assert.ok(train.distance > 600 && train.speed > 0);
  const leader = simulation.trains[1];
  train.distance = 900;
  train.speed = 12;
  train.policyClock = 0;
  leader.distance = 1050;
  leader.speed = 0;
  leader.dwell = 100;
  for (let i = 0; i < 400; i++) simulation.update(0.1);
  const rear =
    leader.distance - ((TRANSIT_LIMITS.cars - 1) * TRANSIT_LIMITS.carSpacing + TRANSIT_LIMITS.carLength / 2);
  assert.ok(train.distance + TRANSIT_LIMITS.carLength / 2 <= rear - TRANSIT_LIMITS.followingGap + 0.1);
});

test('crossing reservation holds through the last car and releases stopped trains before the intersection', () => {
  const route = { id: '201:0' },
    crossing = { routeId: '201:0', distance: 500 };
  assert.equal(crossingActive({ route, distance: 400, speed: 10 }, crossing), true);
  assert.equal(crossingActive({ route, distance: 470, speed: 0 }, crossing), false);
  assert.equal(crossingActive({ route, distance: 570, speed: 10 }, crossing), true);
  assert.equal(crossingActive({ route, distance: 610, speed: 10 }, crossing), false);
  assert.equal(crossingActive({ route: { id: '202:1' }, distance: 500, speed: 10 }, crossing), false);
});

test('player contact respects elevation and gives bounded finite section contact directions', () => {
  const section = { x: 0, y: 5.4, z: 0, heading: 0 },
    contact = {};
  assert.equal(trainBodyContact({ x: 0, y: 0.2, z: 0 }, { radius: 0.42 }, section, contact), false);
  assert.equal(trainBodyContact({ x: 1.5, y: 5.6, z: 0 }, { radius: 0.42 }, section, contact), true);
  assert.ok(contact.nx > 0.99 && contact.depth > 0 && contact.depth < 0.3);
  assert.equal(
    trainBodyContact({ x: 4, y: 5.6, z: 0 }, { car: true, hx: 0.9, hz: 2.25 }, section, contact),
    false,
  );
});

test('articulated halves pitch with their actual rail grade instead of hovering horizontally above ramps', () => {
  const simulation = createTransitSimulation(fixture(), { surfaceHeight: (_x, z) => 0.18 + z * 0.05 });
  for (const section of simulation.sections) {
    assert.ok(Math.abs(section.y - (0.18 + section.z * 0.05)) < 1e-9);
    assert.ok(Math.abs(Math.tan(section.pitch) - section.side * 0.05) < 1e-9);
  }
});

test('current-data fleet stays deterministic, capped and finite through station and signal updates', () => {
  const source = JSON.parse(fs.readFileSync(new URL('../data/calgary-transit.json', import.meta.url))),
    a = createTransitSimulation(source),
    b = createTransitSimulation(source);
  assert.equal(a.trains.length, TRANSIT_LIMITS.fleet);
  const bowTrain = a.trains.find((train) => train.id === '202:0:train-1');
  const bowRail = 'osm-way-1343206809-0';
  let crossedBow = false;
  for (let i = 0; i < 1000; i++) {
    a.update(0.05);
    b.update(0.05);
    crossedBow ||= bowTrain.sections.some(
      (section) => section.segment.bridge && section.segment.roadId === bowRail,
    );
  }
  assert.ok(crossedBow, 'the eastbound service reaches the mapped Bow River rail span');
  assert.deepEqual(
    a.trains.map((train) => [train.distance, train.speed, train.dwell]),
    b.trains.map((train) => [train.distance, train.speed, train.dwell]),
  );
  assert.ok(a.sections.length <= TRANSIT_LIMITS.fleet * TRANSIT_LIMITS.cars * 2);
  assert.ok(
    a.sections.every((section) => [section.x, section.y, section.z, section.heading].every(Number.isFinite)),
  );
  assert.ok(a.stats.policyQueries <= 8 * 510);
  const motion = transitMotion(16, 16, 0.03, 0.1);
  assert.equal(motion.distance, 0.03);
  assert.equal(motion.speed, 0);
});
