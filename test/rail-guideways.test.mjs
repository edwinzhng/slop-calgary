import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { RAIL_PROFILE, railGuidewayFinish } from '../app/rail-guideways.js';
import { createInfrastructureSurfaces, buildInfrastructure } from '../app/infrastructure.js';
import { bridgePathPoint } from '../app/bridge-path.js';
import { TRANSIT_LIMITS } from '../app/transit-motion.js';
import { createRailClearance, trimRailCollider, trimRailGeometry } from '../app/rail-clearance.js';
import { bounds, makeRoadIndex } from '../app/geo.js';
import { footprintContact, movementBody } from '../app/camera-collision.js';

const data = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))),
  originalRails = JSON.stringify(data.rails),
  surfaces = createInfrastructureSurfaces(data),
  direct = surfaces.plans.filter((plan) => plan.trackFinish === 'direct-fixation');

test('only the eight matching West LRT source ways receive direct-fixation guideways', () => {
  assert.equal(direct.length, 4);
  assert.equal(direct.flatMap((plan) => plan.roads).length, 8);
  assert.ok(direct.every((plan) => plan.rail && plan.roads.every((road) => road.kind === 'light_rail')));
  for (const plan of surfaces.plans.filter((plan) => plan.rail && !direct.includes(plan))) {
    assert.equal(plan.trackFinish, null);
    assert.ok(
      plan.deck.segments.every(
        (segment) => segment.paving.length === 1 && segment.paving[0].kind === 'ballast',
      ),
    );
  }
  assert.equal(JSON.stringify(data.rails), originalRails, 'source geometry and metadata are not rewritten');
});

test('guideway detail expires after a changed source identity, geometry or bridge classification', () => {
  const road = data.rails.find((rail) => rail.id === 'osm-way-53529046-0');
  assert.equal(railGuidewayFinish([road]), 'direct-fixation');
  for (const mutate of [
    (r) => (r.points[0][0] += 0.001),
    (r) => (r.id = 'unmatched-source'),
    (r) => (r.bridge = false),
    (r) => (r.tunnel = true),
    (r) => (r.kind = 'rail'),
  ]) {
    const changed = structuredClone(road);
    mutate(changed);
    assert.equal(railGuidewayFinish([changed]), null);
    assert.equal(railGuidewayFinish([road, changed]), null);
  }
  assert.equal(railGuidewayFinish([road, road]), null);
  assert.equal(railGuidewayFinish([]), null);
});

test('concrete plinths share the rendered floor while preserving railhead and train boarding heights', () => {
  assert.ok(
    Math.abs(RAIL_PROFILE.railCenter + RAIL_PROFILE.railRadius - TRANSIT_LIMITS.railHeadAboveDeck) < 1e-12,
  );
  assert.ok(RAIL_PROFILE.plinthTop < RAIL_PROFILE.railCenter - RAIL_PROFILE.railRadius);
  for (const plan of direct) {
    assert.equal(plan.level, 5.4);
    for (const segment of plan.deck.segments) {
      assert.deepEqual(
        segment.paving.map((p) => p.kind),
        ['guideway-concrete', 'guideway-plinth', 'guideway-plinth'],
      );
      const t = (segment.from + segment.to) / 2;
      for (const side of [-1, 1]) {
        const offset = side * RAIL_PROFILE.halfGauge,
          point = bridgePathPoint(plan, t, offset, plan.deck.heightAtStation(t, offset)),
          plinth = segment.paving[side === -1 ? 1 : 2].band.heightAt(point[0], point[2]);
        assert.ok(Math.abs(segment.floor(point[0], point[2]) - plinth) < 1e-8);
        // The independently triangulated bands can differ slightly where the
        // guideway climbs through an oblique curve at the Bow Trail crossing.
        const rise = plinth - point[1];
        assert.ok(Math.abs(rise - RAIL_PROFILE.plinthTop) < (plan.gradeSeparation ? 0.001 : 1e-4));
        assert.ok(rise < RAIL_PROFILE.railCenter - RAIL_PROFILE.railRadius);
        assert.ok(
          Math.abs(surfaces.surfaceHeight(point[0], point[2], plan.roads[0]) - point[1]) < 2e-5,
          'train reference remains the neutral deck, not the walking plinth top',
        );
      }
    }
  }
});

test('independent rays through emitted bridge buffers hit every sampled concrete walking surface', () => {
  const scene = new THREE.Scene();
  buildInfrastructure(scene, data, { surfaces });
  scene.updateMatrixWorld(true);
  const meshes = [];
  scene.traverse((object) => {
    if (object.isMesh && object.name === 'Bridge and overpass structural tile') meshes.push(object);
  });
  assert.ok(meshes.length);
  const ray = new THREE.Raycaster(),
    origin = new THREE.Vector3(),
    down = new THREE.Vector3(0, -1, 0);
  let probes = 0;
  for (const plan of direct)
    for (const t of [0.2, 0.4, 0.6, 0.8])
      for (const offset of [
        0,
        -RAIL_PROFILE.halfGauge - RAIL_PROFILE.plinthHalfWidth * 0.65,
        RAIL_PROFILE.halfGauge + RAIL_PROFILE.plinthHalfWidth * 0.65,
      ]) {
        const p = bridgePathPoint(plan, t, offset, plan.deck.heightAtStation(t, offset)),
          expected = Math.max(...plan.deck.segments.map((s) => s.floor(p[0], p[2])).filter(Number.isFinite));
        assert.ok(Number.isFinite(expected));
        ray.set(origin.set(p[0], expected + 3, p[2]), down);
        assert.ok(
          ray.intersectObjects(meshes, false).some((hit) => Math.abs(hit.point.y - expected) < 0.0001),
          `${plan.roads[0].id} station ${t}, offset ${offset}`,
        );
        probes++;
      }
  assert.equal(probes, 48);
  const geometries = new Set(),
    materials = new Set();
  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const m of Array.isArray(object.material) ? object.material : [object.material])
      if (m) materials.add(m);
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
  scene.clear();
});

test('rail clearance opens a train path through a station without removing its roof or separated buildings', () => {
  const roads = [
    {
      kind: 'light_rail',
      points: [
        [0, -15],
        [0, 15],
      ],
    },
  ];
  const rail = createRailClearance(makeRoadIndex(roads), () => 0.18);
  const station = {
    ring: [
      [-4, -4],
      [4, -4],
      [4, 4],
      [-4, 4],
      [-4, -4],
    ],
    minHeight: 0,
    height: 8,
  };
  const cuts = rail.find(station, bounds(station.ring), 0, 8);
  const collider = trimRailCollider(station, cuts);
  const walker = movementBody('walk');
  const occupied = (x, y, z) => collider.some((part) => footprintContact(part, x, y, z, walker, {}));
  assert.equal(occupied(0, 0.2, 0), false, 'the station opening is physically clear');
  assert.equal(occupied(3, 0.2, 0), true, 'walls outside the rail corridor still collide');
  assert.equal(occupied(0, 5.5, 0), true, 'overhead structure remains');

  const original = new THREE.BoxGeometry(8, 8, 8).translate(0, 4, 0);
  const clipped = trimRailGeometry(original, cuts);
  const { position } = clipped.attributes;
  let roof = false;
  for (let i = 0; i < position.count; i += 3) {
    const x = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const y = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3;
    assert.ok(Math.abs(x) >= 1.74 || y >= 4.97, 'no face enters the train envelope');
    roof ||= y === 8;
  }
  assert.ok(roof);
  clipped.dispose();
  const elevated = createRailClearance(makeRoadIndex([{ ...roads[0], bridge: true }]), () => 12);
  assert.equal(elevated.find(station, bounds(station.ring), 0, 8).length, 0);
  const underground = createRailClearance(makeRoadIndex([{ ...roads[0], tunnel: true }]), () => 0);
  assert.equal(underground.find(station, bounds(station.ring), 0, 8).length, 0);
});
