import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { applyRoadAttributes } from '../app/road-attributes.js';
import { applySiteOverlays } from '../app/site-overlays.js';
import { createInfrastructureSurfaces } from '../app/infrastructure.js';
import {
  createNorthBowOverpass,
  attachNorthBowSurfaces,
  buildNorthBowOverpass,
} from '../app/north-bow-overpass.js';
import { footprintContact, movementBody } from '../app/camera-collision.js';

const json = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}.json`, import.meta.url)));
const data = json('calgary');
applyRoadAttributes(data, json('calgary-road-attributes'));
applySiteOverlays(data, json('calgary-site-overlay'));
const model = createNorthBowOverpass(data, { groundHeightAt: () => 0.15 });
const surfaces = attachNorthBowSurfaces(
  createInfrastructureSurfaces(data, { bridgeConnections: model.bridgeConnections }),
  model,
);

test('the lower LRT path deck joins the authored bank datum without a second inferred approach', () => {
  const connection = model.bridgeConnections[0],
    plan = surfaces.byRoad.get(connection.roadId),
    road = data.roads.find((r) => r.id === connection.roadId),
    path = data.roads.find((r) => r.id === 'osm-way-180764948-0'),
    [x, z] = connection.point;
  assert.ok(Math.abs(connection.height - 1.3189250036897646) < 1e-8);
  assert.ok(Math.abs(surfaces.surfaceHeight(x, z, road) - model.surfaceHeight(x, z, path)) < 1e-6);
  assert.ok(plan.approaches.every((s) => s.approachSide !== 'end'));
  for (const [x, z] of [
    [-844.55, -718.75],
    [-847.6, -717.5],
    [-853.7, -715],
  ]) {
    const height = model.surfaceHeight(x, z, path);
    assert.ok(height > 0.8);
    assert.ok(Math.abs(surfaces.groundHeight(x, z, height + 0.15) - height) < 1e-6);
  }
  assert.equal(model.surfaceHeight(-847.6, -717.5, { id: 'unrelated-path' }), null);
  assert.equal(surfaces.groundHeight(x, z, -1), null);
});

test('overlapping bank pieces select the physical upper face and do not block a bicycle on it', () => {
  const x = -858.8,
    z = -708.8,
    height = surfaces.groundHeight(x, z, 0.32665399473774615),
    lowerPiece = model.surfaceHeight(x, z, { id: 'osm-way-436935510-0' }),
    body = movementBody('cycle'),
    contact = {},
    scene = new THREE.Scene(),
    rendered = buildNorthBowOverpass(scene, model),
    ray = new THREE.Raycaster(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));
  try {
    const tops = ray
      .intersectObject(rendered.mesh)
      .filter((hit) => hit.face.normal.y > 0.5 && hit.point.y <= 0.32665399473774615 + 0.65)
      .map((hit) => hit.point.y);
    assert.ok(height > lowerPiece + 0.002);
    assert.ok(Math.abs(height - Math.max(...tops)) < 0.00002);
    assert.ok(model.slabs.every((slab) => !footprintContact(slab, x, height, z, body, contact)));
  } finally {
    rendered.dispose();
  }
});

test('bank support heights agree with actual emitted concrete faces', () => {
  const scene = new THREE.Scene(),
    rendered = buildNorthBowOverpass(scene, model),
    ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  try {
    const probes = [
      [-839.2, -720],
      [-841.5, -720],
      [-847.6, -717.5],
      [-853.7, -715],
      [-857.65, -714.3],
      [-858.8, -708.8],
      ...model.accessSegments.map((s) => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]),
    ];
    for (const [x, z] of probes) {
      const owner = model.accessSegments.find(
          (s) => Math.hypot((s.a[0] + s.b[0]) / 2 - x, (s.a[1] + s.b[1]) / 2 - z) < 0.00001,
        ),
        hint = owner ? (owner.h0 + owner.h1) / 2 : 1.3,
        height = model.groundHeight(x, z, hint);
      ray.ray.origin.set(x, 20, z);
      const hits = ray.intersectObject(rendered.mesh).filter((h) => h.face.normal.y > 0.5);
      assert.ok(
        hits.some((hit) => Math.abs(hit.point.y - height) < 0.00002),
        `${x},${z}: no rendered floor at ${height}`,
      );
    }
  } finally {
    rendered.dispose();
  }
});

test('changed source connections disable the authored model instead of reusing old bank ties', () => {
  for (const id of ['osm-way-129175808-0', 'osm-way-180764948-0']) {
    const changed = {
        ...data,
        roads: data.roads.map((r) => (r.id === id ? { ...r, points: r.points.map((p) => [...p]) } : r)),
      },
      road = changed.roads.find((r) => r.id === id),
      index = road.points.findIndex((p) => p[0] === -839.2 && p[1] === -720);
    assert.ok(index >= 0);
    road.points[index][0] += 0.1;
    assert.equal(createNorthBowOverpass(changed), null);
  }
});
