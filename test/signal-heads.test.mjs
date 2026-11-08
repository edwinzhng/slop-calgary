import test from 'node:test';
import assert from 'node:assert/strict';
import { signalHeadLayout, signalLensIndex } from '../app/signal-heads.js';

const westbound = () => ({
  x: -154.45774839842898,
  z: 886.1905173425898,
  width: 12.8,
  junction: [-162.55735140771637, 886.110323253389],
  sign: 1,
  axis: 0,
  travelX: -0.9999509888009116,
  travelZ: -0.009900504839615243,
  road: '17 Avenue SW',
  roadKind: 'secondary',
  roadId: 'osm-way-233756425-0',
  inventoryDerived: true,
  citySite: {
    id: 'city-signal-1109001112',
    x: -159.88,
    z: 886.47,
    kind: 'Traffic signal',
    firstRoad: '17 AVENUE',
    secondRoad: '5 STREET',
    quadrant: 'SW',
    pedestrianButtons: false,
    pedestrianTimer: true,
    accessible: true,
  },
  sourceRoad: {
    id: 'osm-way-233756425-0',
    name: '17 Avenue SW',
    kind: 'secondary',
    points: [
      [-163.6, 886.1],
      [-153.5, 886.2],
    ],
    oneway: 'no',
    bridge: false,
    tunnel: false,
    lanes: 4,
    layer: 0,
    surface: 'asphalt',
  },
});

test('unobserved heads retain the existing vertical dimensions and phase positions', () => {
  const layout = signalHeadLayout({});
  assert.equal(layout.horizontal, false);
  assert.deepEqual(
    [
      layout.housingWidth,
      layout.housingHeight,
      layout.backingWidth,
      layout.backingHeight,
      layout.centerOffsetY,
    ],
    [0.4, 1.1, 0.32, 1.02, 0],
  );
  assert.deepEqual(layout.lensOffsets, [
    [0, 0.31, 0],
    [0, 0, 0],
    [0, -0.31, 0],
  ]);
  assert.deepEqual(['red', 'amber', 'green'].map(signalLensIndex), [0, 1, 2]);
});

test('the observed westbound head keeps its mount top with red left and green right', () => {
  const signal = westbound(),
    before = structuredClone(signal),
    layout = signalHeadLayout(signal);
  assert.equal(layout.horizontal, true);
  assert.deepEqual(
    [layout.housingWidth, layout.housingHeight, layout.backingWidth, layout.backingHeight],
    [1.1, 0.4, 1.02, 0.32],
  );
  assert.equal(layout.centerOffsetY + layout.housingHeight / 2, 1.1 / 2);
  assert.equal(layout.centerOffsetY + layout.backingHeight / 2, 1.02 / 2);
  const right = [-signal.travelZ, 0, signal.travelX];
  for (const [phase, expected] of [
    ['red', -0.31],
    ['amber', 0],
    ['green', 0.31],
  ]) {
    const offset = layout.lensOffsets[signalLensIndex(phase)];
    const across = offset[0] * right[0] + offset[2] * right[2];
    assert.ok(Math.abs(across - expected) < 1e-12);
    assert.equal(offset[1], 0);
  }
  assert.deepEqual(signal, before, 'layout must not mutate poles, stops, timing or source ownership');
});

test('changed site evidence, mapped source shape or generated approach expires the correction', () => {
  const mutations = [
    (s) => (s.citySite.id += '-changed'),
    (s) => (s.citySite.x += 0.01),
    (s) => (s.citySite.z += 0.01),
    (s) => (s.citySite.kind = 'Overhead Flasher'),
    (s) => (s.citySite.firstRoad = '16 AVENUE'),
    (s) => (s.citySite.secondRoad = '4 STREET'),
    (s) => (s.citySite.quadrant = 'NW'),
    (s) => (s.citySite.pedestrianButtons = true),
    (s) => (s.citySite.pedestrianTimer = false),
    (s) => (s.citySite.accessible = false),
    (s) => delete s.citySite.pedestrianButtons,
    (s) => (s.roadId += '-changed'),
    (s) => (s.road = '5 Street SW'),
    (s) => (s.roadKind = 'tertiary'),
    (s) => (s.inventoryDerived = false),
    (s) => delete s.sourceRoad,
    (s) => (s.sourceRoad.points[0][0] += 0.001),
    (s) => s.sourceRoad.points.reverse(),
    (s) => s.sourceRoad.points.push([-153, 886.2]),
    (s) => (s.sourceRoad.lanes = 3),
    (s) => (s.sourceRoad.bridge = true),
    (s) => (s.sourceRoad.tunnel = true),
    (s) => (s.sourceRoad.oneway = 'yes'),
    (s) => (s.sourceRoad.layer = 1),
    (s) => (s.sourceRoad.surface = 'concrete'),
    (s) => (s.x += 0.001),
    (s) => (s.z += 0.001),
    (s) => (s.width += 0.001),
    (s) => (s.junction[0] += 0.001),
    (s) => (s.junction[1] += 0.001),
    (s) => (s.travelX = -s.travelX),
    (s) => (s.travelX += 1e-6),
    (s) => (s.travelZ += 1e-6),
    (s) => (s.sign = -1),
    (s) => (s.axis = 1),
  ];
  for (const mutate of mutations) {
    const signal = westbound();
    mutate(signal);
    assert.equal(signalHeadLayout(signal).horizontal, false, String(mutate));
  }
});

test('a clustered site still requires the exact observed inventory record', () => {
  const signal = westbound();
  signal.citySites = [{ ...signal.citySite, id: 'unrelated' }, signal.citySite];
  signal.citySite = signal.citySites[0];
  assert.equal(signalHeadLayout(signal).horizontal, true);
  signal.citySites[1] = { ...signal.citySites[1], pedestrianTimer: false };
  assert.equal(signalHeadLayout(signal).horizontal, false);
});
