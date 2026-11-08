import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { observedBridgeGuardProfile, bridgeGuardCapStations } from '../app/bridge-guard-finishes.js';
import { bridgeGuardOffset, bridgeGuardStyle } from '../app/bridge-connections.js';
import { createInfrastructureSurfaces, buildInfrastructure } from '../app/infrastructure.js';
import { createBridgeCollisionParts } from '../app/bridge-collision.js';
import { bridgePathPoint } from '../app/bridge-path.js';
import { footprintContact, movementBody } from '../app/camera-collision.js';

const source = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))),
  ids = new Set(['osm-way-52460453-0', 'osm-way-52460663-0']),
  data = {
    meta: source.meta,
    waters: [],
    rails: [],
    roads: source.roads
      .filter((road) => ids.has(road.id))
      .map((road) => ({ ...structuredClone(road), inferredLanes: 2 })),
  },
  surfaces = createInfrastructureSurfaces(data);

test('the dated Blackfoot concrete barriers keep the cap on the physical outer edge when a plan reverses', () => {
  assert.equal(surfaces.plans.length, 2);
  for (const plan of surfaces.plans) {
    assert.equal(bridgeGuardStyle(plan), 'concrete-road-parapet');
    assert.equal(plan.compactShoulders, true);
    const forward = JSON.stringify(plan.points) === JSON.stringify(plan.roads[0].points),
      outerSide = forward ? 1 : -1;
    assert.equal(observedBridgeGuardProfile(plan, outerSide).capHeight, 1.055);
    assert.equal(observedBridgeGuardProfile(plan, -outerSide).capHeight, null);
    const reversed = { ...plan, points: plan.points.slice().reverse() };
    assert.deepEqual(
      observedBridgeGuardProfile(plan, outerSide),
      observedBridgeGuardProfile(reversed, -outerSide),
    );
    const capStations = plan.deck.segments.flatMap((segment) =>
      bridgeGuardCapStations(plan, segment.from, segment.to, 3.2),
    );
    assert.equal(new Set(capStations).size, capStations.length);
    assert.equal(capStations[0], 0);
    assert.equal(capStations.at(-1), 1);
  }
});

test('observed barriers expire after source or component changes', () => {
  const road = data.roads[0],
    plan = () => ({
      drive: true,
      type: 'girder',
      roads: [structuredClone(road)],
      points: structuredClone(road.points),
    });
  for (const mutate of [
    (p) => (p.roads[0].points[0][0] += 0.001),
    (p) => (p.points[0][0] += 0.001),
    (p) => (p.roads[0].id = 'different-source'),
    (p) => (p.roads[0].kind = 'primary'),
    (p) => (p.roads[0].bridge = false),
    (p) => (p.roads[0].tunnel = true),
    (p) => (p.roads[0].oneway = 'no'),
    (p) => (p.roads[0].layer = 2),
    (p) => (p.roads[0].lanes = 3),
    (p) => p.roads.push(structuredClone(road)),
    (p) => (p.rail = true),
  ]) {
    const changed = plan();
    mutate(changed);
    assert.equal(observedBridgeGuardProfile(changed, 1), null);
    assert.equal(bridgeGuardStyle(changed), 'standard');
  }
});

test('independent rays hit solid parapets in the emitted bridge buffers and their body envelopes agree', () => {
  const scene = new THREE.Scene();
  buildInfrastructure(scene, data, { surfaces });
  scene.updateMatrixWorld(true);
  const meshes = [];
  scene.traverse((object) => {
    if (object.isMesh && object.name === 'Bridge and overpass structural tile') meshes.push(object);
  });
  assert.ok(meshes.length);
  const parts = createBridgeCollisionParts(surfaces),
    ray = new THREE.Raycaster(),
    down = new THREE.Vector3(0, -1, 0),
    body = movementBody('walk', 0, 0.02),
    contact = {};
  let checked = 0;
  for (const plan of surfaces.plans)
    for (const side of [-1, 1])
      for (const t of [0.15, 0.4, 0.65, 0.85]) {
        const offset = side * bridgeGuardOffset(plan),
          point = bridgePathPoint(plan, t, offset, plan.deck.heightAtStation(t, offset));
        ray.set(new THREE.Vector3(point[0], point[1] + 2, point[2]), down);
        assert.ok(
          ray.intersectObjects(meshes, false).some((hit) => Math.abs(hit.point.y - point[1] - 0.9) < 0.0001),
        );
        const overlapping = parts.barriers.filter((barrier) =>
          footprintContact(barrier, point[0], point[1] + 0.5, point[2], body, contact),
        );
        assert.ok(overlapping.length);
        assert.ok(
          overlapping.every(
            (barrier) =>
              Math.abs(
                barrier.heightAt(point[0], point[2]) -
                  point[1] -
                  observedBridgeGuardProfile(plan, side).upper,
              ) < 0.0001,
          ),
        );
        assert.ok(
          parts.barriers.every((barrier) => !footprintContact(barrier, point[0], 0, point[2], body, contact)),
          'space below the raised bridge stays open',
        );
        checked++;
      }
  assert.equal(checked, 16);
  scene.traverse((object) => {
    object.geometry?.dispose();
    if (!Array.isArray(object.material)) object.material?.dispose();
  });
  scene.clear();
});
