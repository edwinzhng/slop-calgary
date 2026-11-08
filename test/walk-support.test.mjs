import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { createWalkingSupport, WALK_SUPPORT_LIMITS } from '../app/walk-support.js';
import { footprintContact, movementBody } from '../app/camera-collision.js';
import { buildRecentDevelopments, DEVELOPMENT_MANIFEST, bmoWorld } from '../app/recent-developments.js';
import { buildLandmarks } from '../app/landmarks.js';

const data = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))),
  scene = new THREE.Scene(),
  development = buildRecentDevelopments(scene, data),
  bmo = DEVELOPMENT_MANIFEST.sites.find((site) => site.id === 'bmo-centre-2024'),
  typed = development.colliders.filter((collider) =>
    ['development-stair', 'development-landing'].includes(collider.type),
  ),
  groundHeight = (x, z, hint) => {
    const height = development.surfaceHeight(x, z);
    return height != null && (!Number.isFinite(hint) || height <= hint + 0.65) ? height : 0.31;
  },
  support = createWalkingSupport({ groundHeight, stepColliders: development.colliders });

test.after(() => development.dispose());

test('Central Library stairs meet the through landing on both approaches', () => {
  const library = buildLandmarks(new THREE.Scene(), { data });
  const walk = createWalkingSupport({ groundHeight: () => 0.2, stepColliders: library.walkSlabs });
  const contact = {};
  for (const direction of [1, -1]) {
    const body = movementBody('walk', (direction * Math.PI) / 2);
    let height = 0.2,
      maximum = 0;
    for (let i = 0; i <= 1440; i++) {
      const x = direction > 0 ? 1142 + i * 0.05 : 1214 - i * 0.05;
      const z = 65.4 + ((x - 1142) * 1.72) / 72;
      const next = walk(x, z, height);
      assert.ok(Math.abs(next - height) < 0.23, `step or gap at ${x}`);
      assert.equal(
        library.colliders.some((s) => footprintContact(s, x, next, z, body, contact)),
        false,
      );
      height = next;
      maximum = Math.max(maximum, height);
    }
    assert.equal(maximum, 2.91);
    assert.equal(height, 0.2);
  }
});

test('actual BMO front approach, all 64 treads and landing are traversable at footprint contact before centre entry', () => {
  assert.ok(bmo);
  let y = 0.31,
    firstLift = null;
  const attained = new Set(),
    contact = {};
  for (let i = 0; i <= 1400; i++) {
    const v = 130 - i * 0.025,
      [x, z] = bmoWorld(bmo, 162.5, v),
      nextY = support(x, z, y),
      body = movementBody('walk', -Math.PI);
    assert.ok(nextY <= y + WALK_SUPPORT_LIMITS.stepUp + 1e-7, `unreachable support at v=${v}`);
    if (!firstLift && nextY > 0.32) firstLift = { v, y: nextY };
    for (const collider of typed)
      assert.equal(
        footprintContact(collider, x, nextY, z, body, contact),
        false,
        `${collider.type} blocks the real body at local v=${v}, support=${nextY}`,
      );
    y = nextY;
    if (v >= 100 && v <= 128) attained.add(Math.min(64, Math.max(1, Math.ceil(((128 - v) / 28) * 64))));
  }
  assert.ok(
    firstLift.v > 128 && firstLift.v < 128.5,
    'first riser must lift the footprint before its centre enters the stair',
  );
  assert.equal(attained.size, 64);
  assert.equal(y, 11.4, 'reach the actual landing without jumping');
  for (let i = 0; i <= 1400; i++) {
    const v = 95 + i * 0.025,
      [x, z] = bmoWorld(bmo, 162.5, v),
      nextY = support(x, z, y);
    assert.ok(y - nextY <= WALK_SUPPORT_LIMITS.stepUp + 1e-7, `drop exceeds a tread at v=${v}`);
    for (const collider of typed)
      assert.equal(footprintContact(collider, x, nextY, z, movementBody('walk'), contact), false);
    y = nextY;
  }
  assert.equal(y, 0.31, 'descend to the actual front sidewalk');
});

test('BMO footprint support retains clearance at the rotated diagonal front and blocks tall side/underside access', () => {
  const stair = typed.find((collider) => collider.type === 'development-stair'),
    landing = typed.find((collider) => collider.type === 'development-landing'),
    body = movementBody('walk'),
    contact = {};
  let y = 0.31;
  for (let i = 0; i <= 1400; i++) {
    const v = 130 - i * 0.025,
      u = 160 + i * 0.003,
      [x, z] = bmoWorld(bmo, u, v);
    y = support(x, z, y);
    assert.equal(footprintContact(stair, x, y, z, body, contact), false, `diagonal riser at v=${v}`);
  }
  const side = bmoWorld(bmo, 171.45, 110);
  assert.equal(support(...side, 0.31), 0.31, 'side wall is far above maximum step height');
  assert.equal(footprintContact(stair, side[0], 0.31, side[1], body, contact), true);
  const clearOfSide = bmoWorld(bmo, 174, 110);
  assert.equal(
    support(...clearOfSide, 11.4),
    0.31,
    'leaving the actual footprint does not retain stair support',
  );
  const underside = bmoWorld(bmo, 153.5, 97);
  assert.equal(support(...underside, 0.31), 0.31, 'walking beneath a landing never acquires its top');
  assert.equal(footprintContact(landing, underside[0], 0.31, underside[1], body, contact), false);
  assert.equal(footprintContact(landing, underside[0], 9.2, underside[1], body, contact), true);
});

test('ordinary terrain stays centre-sampled and generic roofs/guardrails never become footprint supports', () => {
  let queries = 0,
    forbiddenSamples = 0;
  const rectangle = {
      ring: [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
      heightAt: () => {
        forbiddenSamples++;
        return 7.3;
      },
      height: 7.3,
    },
    walk = createWalkingSupport({
      groundHeight: () => {
        queries++;
        return 7;
      },
      stepColliders: [
        { ...rectangle, type: 'roof' },
        { ...rectangle, type: 'bridge-guardrail' },
      ],
    });
  assert.equal(walk(0, 0, 7), 7);
  assert.equal(queries, 1);
  assert.equal(forbiddenSamples, 0);
});

test('transit footprint queries are spatially gated and bounded to eight reachable platform/step samples', () => {
  let nearby = false,
    queries = 0;
  const transit = {
      hasGroundSupportNear: () => nearby,
      groundHeight: () => {
        queries++;
        return 0.6;
      },
    },
    walk = createWalkingSupport({ groundHeight: () => 0.2, transit: () => transit });
  assert.equal(walk(0, 0, 0.2), 0.2);
  assert.equal(queries, 0);
  nearby = true;
  assert.equal(walk(0, 0, 0.2), 0.6);
  assert.equal(queries, 8);
  transit.groundHeight = () => 1.38;
  assert.equal(walk(0, 0, 0.2), 0.2, 'a full-height platform wall cannot be climbed as a small step');
});
