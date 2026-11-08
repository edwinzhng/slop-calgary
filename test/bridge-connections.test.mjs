import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import {
  createInfrastructureSurfaces,
  bridgeDeckHeight,
  buildInfrastructure,
  samplePolyline,
  INFRASTRUCTURE_LIMITS,
} from '../app/infrastructure.js';
import {
  BRIDGE_CONNECTION_LIMITS,
  bridgeDetailPoint,
  bridgeGuardStyle,
  bridgeGuardOffset,
  cableStayLayout,
  collectBridgeConnections,
  drawBridgeConnection,
  kingBalustradeFixtures,
  sampleBridge,
  suspensionCableHeight,
  suspensionCableSamples,
  trussHalfWidth,
} from '../app/bridge-connections.js';
import { collectBridgeDetailBeams } from '../app/bridge-lighting.js';
import { createPeaceShell, createPeaceSidewalk } from '../app/peace-shell.js';
import { PEACE_ANCHORS, PEACE_SURFACE_LIMITS, PEACE_WALKWAY } from '../app/peace-surfaces.js';

const data = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))),
  surfaces = createInfrastructureSurfaces(data),
  definitions = collectBridgeConnections(surfaces, { heightAt: bridgeDeckHeight }),
  plan = (name) => surfaces.plans.find((p) => p.name === name);

test('Peace Bridge steel clears the travel corridor and sidewalk meshes match walk support', () => {
  const [a, b] = PEACE_ANCHORS,
    dx = b[0] - a[0],
    dz = b[1] - a[1],
    length = Math.hypot(dx, dz),
    level = PEACE_SURFACE_LIMITS.level,
    { steel, glass } = createPeaceShell(length),
    sidewalk = new THREE.Mesh(createPeaceSidewalk(length)),
    ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  for (const g of [steel, glass]) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y >= level && y < level + PEACE_WALKWAY.curbRise + 2)
        assert.ok(Math.abs(p.getX(i)) > PEACE_WALKWAY.width / 2);
      assert.ok(Math.abs(p.getZ(i)) <= length / 2 + 1e-5);
    }
    g.dispose();
  }
  for (const [s, rise] of [
    [0.5, PEACE_WALKWAY.curbRise / 4],
    [length / 2, PEACE_WALKWAY.curbRise],
    [length - 0.5, PEACE_WALKWAY.curbRise / 4],
  ]) {
    const x = a[0] + (dx * s) / length,
      z = a[1] + (dz * s) / length;
    assert.equal(surfaces.peace.groundHeight(x, z, level), level);
    for (const side of [-1, 1]) {
      const offset = side * 2;
      ray.ray.origin.set(offset, level + 1, s - length / 2);
      const rendered = ray.intersectObject(sidewalk)[0]?.point.y,
        walkable = surfaces.peace.groundHeight(x + (dz * offset) / length, z - (dx * offset) / length, level);
      assert.ok(Math.abs(walkable - (level + rise)) < 1e-5);
      assert.ok(Math.abs(rendered - walkable) < 1e-5);
    }
  }
  sidewalk.geometry.dispose();
  sidewalk.material.dispose();
});

test('the Peace Bridge south plaza is continuous across its width and joins the deck and riverwalk', () => {
  const peace = surfaces.peace,
    [north, south] = PEACE_ANCHORS,
    span = Math.hypot(south[0] - north[0], south[1] - north[1]),
    dx = (south[0] - north[0]) / span,
    dz = (south[1] - north[1]) / span,
    at = (d, side) => [south[0] + dx * d - dz * side, south[1] + dz * d + dx * side];
  const height = (d, side = 0) => peace.groundHeight(...at(d, side));
  assert.ok(Math.abs(height(0.01) - PEACE_SURFACE_LIMITS.level) < 0.001);
  assert.ok(Math.abs(height(39.99) - PEACE_SURFACE_LIMITS.ground) < 0.001);
  for (let d = 1; d < 40; d++) {
    assert.ok(Math.abs(height(d) - height(d - 0.25)) / 0.25 <= PEACE_SURFACE_LIMITS.maxGrade);
    assert.ok(height(d, 2.8) !== null);
  }
  assert.equal(peace.southLanding.outsideRuns([at(2, 0), at(30, 0)]).length, 0);
  assert.equal(peace.southLanding.outsideRuns([at(20, -20), at(20, 20)]).length, 2);
  assert.ok(peace.segments.every((s) => Math.hypot(s.a[0] - south[0], s.a[1] - south[1]) > 50));
});

test('actual Prince’s Island source ways select the documented stayed structure and main water span', () => {
  const p = plan("Prince's Island Bridge"),
    layout = cableStayLayout(p, surfaces);
  assert.deepEqual(p.roads.map((r) => r.id).sort(), ['osm-way-10470590-0', 'osm-way-584508999-0']);
  assert.equal(p.type, 'cable-stayed', 'possessive name normalization must not erase the A tower');
  assert.equal(p.level, 2.9, 'the physical correction preserves the existing scene deck level');
  assert.equal(p.width, 3.8);
  assert.ok((layout.b - layout.a) * p.length > 60 && (layout.b - layout.a) * p.length < 70);
  for (const t of [layout.a, (layout.a + layout.b) / 2, layout.b]) {
    const a = sampleBridge(p, t),
      b = samplePolyline(p.points, t);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 1e-8);
  }
});

test('GCK luminous faces follow the same inclined fins and keep the full existing deck corridor', () => {
  const p = plan('George C. King Bridge'),
    fixtures = kingBalustradeFixtures(p, bridgeDeckHeight),
    lights = collectBridgeDetailBeams(surfaces, { heightAt: bridgeDeckHeight }).groups.find(
      (g) => g.name === p.name,
    ).beams;
  assert.equal(fixtures.length, lights.length);
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i],
      light = lights[i],
      q = sampleBridge(p, f.t),
      outX = -q.dz * f.side,
      outZ = q.dx * f.side,
      outwardLean = (f.top[0] - f.bottom[0]) * outX + (f.top[2] - f.bottom[2]) * outZ;
    assert.ok(Math.abs(outwardLean - BRIDGE_CONNECTION_LIMITS.kingFinLean) < 1e-8);
    assert.ok(Math.abs(f.top[1] - f.bottom[1] - BRIDGE_CONNECTION_LIMITS.kingFinRise) < 1e-8);
    assert.ok(
      Math.abs((light.b[0] - light.a[0]) * outX + (light.b[2] - light.a[2]) * outZ - outwardLean * 0.8) <
        1e-8,
    );
    assert.ok(light.a[1] > f.bottom[1] && light.b[1] < f.top[1]);
    const offset = (light.a[0] - q.x) * outX + (light.a[2] - q.z) * outZ;
    assert.ok(offset > p.width / 2 - 0.2 && offset < p.width / 2 + 0.2);
  }
  assert.equal(bridgeGuardStyle(p), 'king-cables');
  const joints = definitions.items.filter((i) => i.name === p.name && i.kind === 'deck-joint-seal');
  assert.equal(
    joints.length,
    2,
    'the continuous prestressed deck has no invented joint at each internal pier',
  );
  for (const joint of joints)
    assert.ok(
      Math.min(
        ...[p.points[0], p.points.at(-1)].map((end) => Math.hypot(joint.x - end[0], joint.z - end[1])),
      ) < 0.01,
    );
});

test('truss connections sit at the roadway boundary and brackets stay beneath cantilevered sidewalks', () => {
  for (const name of ['Reconciliation Bridge', 'MacDonald Bridge']) {
    const p = plan(name),
      half = trussHalfWidth(p),
      pieces = definitions.items.filter((i) => i.name === name);
    assert.ok(Math.abs(half - (p.width - 4.2) / 2) < 1e-8);
    assert.ok(pieces.some((i) => i.kind === 'truss-gusset'));
    assert.ok(pieces.some((i) => i.kind === 'bearing-sole-plate'));
    for (const bracket of pieces.filter((i) => i.kind === 'sidewalk-knee-brace')) {
      const nearest = p.points.slice(1).map((b, i) => {
        const a = p.points[i],
          dx = b[0] - a[0],
          dz = b[1] - a[1],
          length2 = dx * dx + dz * dz,
          t = Math.max(0, Math.min(1, ((bracket.x - a[0]) * dx + (bracket.z - a[1]) * dz) / length2));
        return Math.hypot(bracket.x - a[0] - dx * t, bracket.z - a[1] - dz * t);
      });
      assert.ok(Math.min(...nearest) > half && Math.min(...nearest) < p.width / 2);
      assert.ok(bracket.a[1] < p.level && bracket.b[1] < p.level);
    }
  }
  assert.equal(definitions.stats.byKind['sliding-bearing-guide'], 4);
});

test('suspension main cables meet tower saddles and terminate on abutment anchors', () => {
  assert.ok(Math.abs(suspensionCableHeight(0.07) - 7.4) < 1e-8);
  assert.ok(Math.abs(suspensionCableHeight(0.93) - 7.4) < 1e-8);
  assert.equal(suspensionCableHeight(0), 0.3);
  assert.equal(suspensionCableHeight(1), 0.3);
  assert.equal(suspensionCableHeight(0.5), 2);
  assert.ok(
    suspensionCableSamples().includes(0.07) && suspensionCableSamples().includes(0.93),
    'rendered cable vertices must land on the towers rather than chord across their peaks',
  );
  for (const tower of [0.07, 0.93])
    assert.ok(Math.abs(suspensionCableHeight(tower - 1e-8) - suspensionCableHeight(tower + 1e-8)) < 0.0001);
});

test('pedestrian post feet connect to the deck instead of floating at raised-sidewalk height', () => {
  for (const name of ["Prince's Island Bridge", 'Rideau pedestrian bridge', 'Jaipur Bridge']) {
    const p = plan(name),
      stem = definitions.items.find((i) => i.name === name && i.kind === 'guard-post-lower-stem'),
      plate = definitions.items.find((i) => i.name === name && i.kind === 'guard-post-deck-plate'),
      shoe = definitions.items.find((i) => i.name === name && i.kind === 'guard-post-shoe'),
      floor = p.deck.heightAtStation(0, -bridgeGuardOffset(p));
    assert.ok(stem && plate && shoe, name);
    assert.ok(Math.abs(plate.centre[1] - plate.height / 2 - floor) < 1e-8);
    assert.ok(Math.abs(stem.a[1] - (plate.centre[1] + plate.height / 2)) < 1e-8);
    assert.ok(stem.b[1] >= shoe.centre[1] - shoe.height / 2);
  }
  const p = plan('George C. King Bridge'),
    first = kingBalustradeFixtures(p, bridgeDeckHeight)[0],
    shoe = definitions.items.find((i) => i.name === p.name && i.kind === 'king-fin-foot');
  assert.ok(
    Math.abs(shoe.centre[1] - shoe.height / 2 - p.deck.heightAtStation(0, -(p.width / 2 - 0.11))) < 1e-8,
  );
  assert.ok(Math.abs(shoe.centre[1] + shoe.height / 2 - first.bottom[1]) < 1e-8);
});

test('gusset surfaces face outward instead of disappearing under normal back-face culling', () => {
  const item = definitions.items.find(
      (i) =>
        i.kind === 'truss-gusset' &&
        i.name === 'Reconciliation Bridge' &&
        Math.abs(i.x - plan(i.name).points[0][0]) > 5,
    ),
    centre = item.centre,
    triangles = [],
    batch = {
      triangle: (a, b, c) => triangles.push([a, b, c]),
      quad(a, b, c, d) {
        this.triangle(a, b, d);
        this.triangle(b, c, d);
      },
    };
  drawBridgeConnection(batch, item);
  let valid = 0;
  for (const [a, b, c] of triangles) {
    const ab = b.map((v, i) => v - a[i]),
      ac = c.map((v, i) => v - a[i]),
      normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]],
      outward = a.map((v, i) => (v + b[i] + c[i]) / 3 - centre[i]);
    if (Math.hypot(...normal) < 1e-9) continue;
    assert.ok(normal.reduce((n, v, i) => n + v * outward[i], 0) > 0);
    valid++;
  }
  assert.equal(valid, 28);
});

test('actual connection definitions stay bounded and follow the emitted deck reference planes', () => {
  assert.equal(definitions.stats.bridges, 14);
  assert.ok(
    definitions.items.length > 5000 && definitions.items.length < BRIDGE_CONNECTION_LIMITS.maxPrimitives,
  );
  for (const item of definitions.items) {
    assert.ok(Number.isFinite(item.x) && Number.isFinite(item.z));
    const vertices =
      item.shape === 'plate' ? [...item.points, ...item.back] : item.a ? [item.a, item.b] : [item.centre];
    for (const vertex of vertices) assert.ok(vertex.every(Number.isFinite), item.kind);
    if (item.name !== 'Peace Bridge') assert.ok(item.sourceRoadIds.length > 0);
  }
  for (const p of surfaces.plans)
    for (const t of [0, 0.17, 0.5, 0.83, 1])
      assert.ok(
        Math.abs(bridgeDetailPoint(p, t, 0, 0, bridgeDeckHeight)[1] - bridgeDeckHeight(p, t)) < 0.006,
      );
  const traverse = plan('Elbow River Traverse'),
    guards = definitions.items.filter((i) => i.kind === 'traverse-outboard-picket');
  assert.ok(guards.length > 1000);
  for (const guard of guards.slice(0, 2)) {
    const q = sampleBridge(traverse, 0);
    assert.ok(Math.hypot(guard.a[0] - q.x, guard.a[2] - q.z) > traverse.width / 2);
  }
});

test('physical bridge hardware shares existing nearby batches and releases at aerial distance', () => {
  const owned = new Set(
      surfaces.plans
        .filter((p) => p.type !== 'girder' || p.name === "Prince's Island Bridge")
        .flatMap((p) => p.roads.map((r) => r.id)),
    ),
    fixture = {
      ...data,
      roads: data.roads.filter((r) => owned.has(r.id)),
      rails: [],
      buildings: [],
      parks: [],
    },
    scene = new THREE.Scene(),
    infrastructure = buildInfrastructure(scene, fixture),
    camera = new THREE.PerspectiveCamera(),
    centre = sampleBridge(plan('Reconciliation Bridge'), 0.5);
  try {
    camera.position.set(centre.x, 8, centre.z);
    infrastructure.update(camera, 'balanced');
    assert.ok(infrastructure.stats.liveBridgeConnectionPrimitives > 200);
    assert.ok(infrastructure.stats.liveDetailTiles <= INFRASTRUCTURE_LIMITS.balancedTiles);
    assert.ok(infrastructure.stats.liveBridgeConnectionTriangles < 100000);
    assert.equal(
      scene.children.some((o) => o.isPointLight),
      false,
    );
    const nearby = scene.children.filter((o) => o.name === 'Nearby sidewalk slab joints');
    assert.ok(nearby.length > 0 && nearby.length <= INFRASTRUCTURE_LIMITS.balancedTiles);
    assert.equal(new Set(nearby.map((m) => m.material)).size, 1);
    for (const m of nearby)
      for (const v of m.geometry.attributes.position.array) assert.ok(Number.isFinite(v));
    camera.position.y = 500;
    infrastructure.update(camera, 'balanced');
    assert.equal(infrastructure.stats.liveBridgeConnectionPrimitives, 0);
    assert.equal(infrastructure.stats.liveBridgeConnectionTriangles, 0);
  } finally {
    infrastructure.dispose();
  }
  assert.equal(scene.children.length, 0);
});
