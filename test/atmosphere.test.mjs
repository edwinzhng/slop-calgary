import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { bounds, makeRoadIndex, SpatialIndex, unproject } from '../app/geo.js';
import {
  ATMOSPHERE_LIMITS,
  atmosphereSettings,
  createAtmosphere,
  precipitationBudget,
} from '../app/atmosphere.js';
import { collectThemeAnchors, createThemeDetails, TOKYO_DETAIL_LIMITS } from '../app/theme-details.js';

function fixture() {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 2, 8);
  const building = {
      id: 'real-building',
      height: 12,
      ring: [
        [-5, 12],
        [5, 12],
        [5, 24],
        [-5, 24],
        [-5, 12],
      ],
    },
    index = new SpatialIndex(30);
  index.insert(building, bounds(building.ring));
  const road = {
      id: 'real-street',
      name: 'Real Street',
      kind: 'tertiary',
      points: [
        [-100, 0],
        [100, 0],
      ],
    },
    [lon, lat] = unproject(0, 5);
  const world = {
    buildingIndex: index,
    roadIndex: makeRoadIndex([road]),
    businessPlaces: [{ name: 'Mapped business', lon, lat, bearing: 0 }],
    groundHeight: () => 0.2,
    inWater: () => false,
    collision: () => false,
  };
  return { scene, camera, world };
}

test('weather settings keep independent theme, wetness and cold atmosphere values', () => {
  assert.equal(atmosphereSettings('rain', 'tokyo').themeMix, 1);
  assert.equal(atmosphereSettings('rain').wetness, 1);
  assert.ok(atmosphereSettings('snow').temperatureTint > atmosphereSettings('rain').temperatureTint);
  assert.equal(atmosphereSettings('clear').fogMultiplier, 1);
  assert.equal(precipitationBudget('clear'), 0);
  assert.equal(precipitationBudget('rain'), ATMOSPHERE_LIMITS.rain.balanced);
  assert.equal(precipitationBudget('snow', 'high'), ATMOSPHERE_LIMITS.snow.high);
});

test('precipitation is bounded, finite, camera-local and clears without stale visible particles', () => {
  const { scene, camera, world } = fixture(),
    atmosphere = createAtmosphere(scene, camera, world);
  atmosphere.setWeather('rain');
  atmosphere.update(1 / 60);
  assert.equal(atmosphere.stats.rainParticles, ATMOSPHERE_LIMITS.rain.balanced);
  assert.equal(atmosphere.stats.snowParticles, 0);
  assert.ok(atmosphere.stats.drawCalls <= 2);
  const rain = scene.children.find((o) => o.name === 'Camera-local rain streaks');
  assert.equal(rain.count, ATMOSPHERE_LIMITS.rain.balanced);
  assert.equal(rain.material.depthWrite, false);
  assert.equal(rain.material.side, THREE.DoubleSide);
  assert.equal(rain.material.forceSinglePass, true);
  assert.ok(rain.instanceMatrix.array.every(Number.isFinite));
  camera.position.set(12000, 500, -8000);
  atmosphere.update(2, 'high');
  const m = new THREE.Matrix4(),
    p = new THREE.Vector3();
  rain.getMatrixAt(0, m);
  p.setFromMatrixPosition(m);
  assert.ok(Math.abs(p.x - camera.position.x) <= 80.1);
  assert.ok(Math.abs(p.z - camera.position.z) <= 80.1);
  assert.ok(p.y > 470 && p.y < 550);
  atmosphere.setWeather('snow');
  atmosphere.update(1 / 60, 'high');
  assert.equal(rain.count, 0);
  assert.equal(atmosphere.stats.snowParticles, ATMOSPHERE_LIMITS.snow.high);
  const snow = scene.children.find((o) => o.name === 'Camera-local drifting snow');
  assert.equal(snow.material.side, THREE.DoubleSide);
  assert.equal(snow.material.forceSinglePass, true);
  assert.ok(snow.instanceMatrix.array.every(Number.isFinite));
  atmosphere.setWeather('clear');
  assert.equal(rain.visible, false);
  assert.equal(snow.visible, false);
  assert.equal(snow.count, 0);
  assert.equal(atmosphere.stats.drawCalls, 0);
  assert.equal(atmosphere.environment.wetness, 0);
  atmosphere.dispose();
  assert.equal(scene.children.length, 0);
});

test('Tokyo props follow real mapped building frontages, keep strict limits and disappear in aerial view', () => {
  const { scene, camera, world } = fixture(),
    anchors = collectThemeAnchors(world, camera);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].b.id, 'real-building');
  assert.ok(anchors[0].nz < -0.99);
  const theme = createThemeDetails(scene, world);
  theme.setActive(true);
  theme.update(camera, 'high', 1);
  assert.equal(theme.stats.activeSigns, 1);
  assert.equal(theme.stats.activeLanterns, 2);
  assert.ok(theme.stats.drawCalls <= 4);
  assert.ok(theme.stats.activeSigns <= TOKYO_DETAIL_LIMITS.high);
  for (const mesh of scene.children)
    for (const attribute of Object.values(mesh.geometry.attributes))
      assert.ok(attribute.array.every(Number.isFinite), mesh.name);
  camera.position.y = 500;
  theme.update(camera);
  assert.equal(theme.stats.activeSigns, 0);
  assert.equal(scene.children.length, 0);
  theme.dispose();
});

test('overcast and river fog replace precipitation without invisible particle updates', () => {
  const { scene, camera, world } = fixture(),
    atmosphere = createAtmosphere(scene, camera, world);
  atmosphere.setWeather('snow');
  atmosphere.update(1 / 60);
  for (const weather of ['overcast', 'fog']) {
    atmosphere.setWeather(weather);
    atmosphere.update(1 / 60, 'high');
    assert.equal(precipitationBudget(weather, 'high'), 0);
    assert.equal(atmosphere.stats.snowParticles, 0);
    assert.equal(atmosphere.stats.rainParticles, 0);
    assert.equal(atmosphere.stats.drawCalls, 0);
    assert.ok(atmosphere.environment.cloudCover > 0.7);
  }
  assert.ok(atmosphereSettings('fog').fogMultiplier > atmosphereSettings('overcast').fogMultiplier * 3);
  atmosphere.dispose();
});

test('weather and theme switches are independent and reversible without moving the camera', () => {
  const { scene, camera, world } = fixture(),
    atmosphere = createAtmosphere(scene, camera, world),
    before = camera.position.clone();
  atmosphere.setWeather('snow');
  atmosphere.setTheme('tokyo');
  atmosphere.update(1 / 60, 'balanced', 1);
  assert.equal(atmosphere.state.weather, 'snow');
  assert.equal(atmosphere.state.theme, 'tokyo');
  assert.equal(atmosphere.stats.themeSigns, 1);
  atmosphere.setTheme('calgary');
  atmosphere.update(1 / 60);
  assert.equal(atmosphere.state.weather, 'snow');
  assert.equal(atmosphere.stats.themeSigns, 0);
  atmosphere.setWeather('clear');
  assert.equal(atmosphere.state.theme, 'calgary');
  assert.ok(camera.position.equals(before));
  assert.throws(() => atmosphere.setWeather('storm'), RangeError);
  assert.throws(() => atmosphere.setTheme('another-city'), RangeError);
  atmosphere.dispose();
  assert.equal(scene.children.length, 0);
});
