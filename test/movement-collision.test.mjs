import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBoundedMovement,
  rotationWithClearance,
  traversableHeight,
  fitVehicleGround,
  modePlacement,
  savedPlacement,
  sweepVerticalMovement,
  stepWalkingVertical,
} from '../app/movement-collision.js';

test('vertical sweeps stop at roofs and suspended ceilings instead of entering them', () => {
  const body = { radius: 0.42, top: 1.9 };
  const roofWorld = { bodyBlocked: (p) => p.y < 12 && p.y + body.top > 0 };
  const landed = sweepVerticalMovement(roofWorld, { x: 0, y: 15, z: 0 }, body, 5);
  assert.ok(landed.hit && landed.y >= 12 && landed.y < 12.001);
  const ceilingWorld = { bodyBlocked: (p) => p.y < 6 && p.y + body.top > 4 };
  const jump = sweepVerticalMovement(ceilingWorld, { x: 0, y: 1, z: 0 }, body, 3);
  assert.ok(jump.hit && jump.y <= 2.1 && jump.y > 2.099);
  const free = sweepVerticalMovement(ceilingWorld, { x: 0, y: 0.2, z: 0 }, body, 0.4);
  assert.deepEqual(free, { y: 0.4, hit: false });
});

test('reload preserves valid saved coordinates and the selected underpass or platform layer', () => {
  const world = { bodyBlocked: () => false, groundHeight: (_x, _z, hint) => (hint < 1 ? 0.2 : 1.38) };
  assert.deepEqual(savedPlacement(world, { x: 17, z: 42, y: 0.2, heading: 0, mode: 'walk' }), {
    x: 17,
    z: 42,
    y: 0.2,
  });
  assert.deepEqual(savedPlacement(world, { x: 17, z: 42, y: 1.38, heading: 0, mode: 'walk' }), {
    x: 17,
    z: 42,
    y: 1.38,
  });
});

test('exiting flight preserves altitude for a walking fall and rejects unsupported vehicle changes', () => {
  const world = { groundHeight: () => 0.2, bodyBlocked: () => false },
    state = { x: 10, z: 12, y: 70, heading: 0.4, mode: 'fly' };
  assert.deepEqual(modePlacement(world, state, 'walk'), { x: 10, z: 12, y: 70 });
  assert.equal(modePlacement(world, state, 'drive'), null);
  assert.equal(modePlacement(world, state, 'cycle'), null);
  assert.deepEqual(savedPlacement(world, { ...state, mode: 'walk' }), { x: 10, z: 12, y: 70 });
  assert.equal(savedPlacement(world, { ...state, mode: 'walk', y: 100000 }), null);
});

test('roof landing provides stable standing and jumping contact without using the distant ground plane', () => {
  const body = { radius: 0.42, top: 1.9 },
    world = { bodyBlocked: (p) => p.y < 12 && p.y + body.top > 0 },
    state = { x: 0, z: 0, y: 15, verticalSpeed: 0, grounded: false };
  for (let i = 0; i < 180; i++) Object.assign(state, stepWalkingVertical(world, state, body, 0.2, 1 / 60));
  assert.ok(state.y >= 12 && state.y < 12.001);
  assert.equal(state.grounded, true);
  assert.equal(state.verticalSpeed, 0);
  Object.assign(state, stepWalkingVertical(world, state, body, 0.2, 1 / 60, true));
  assert.ok(state.y > 12.08 && state.verticalSpeed > 5);
  assert.equal(state.grounded, false);
});

test('an upward ceiling collision never counts as a landing', () => {
  const body = { radius: 0.42, top: 1.9 },
    world = { bodyBlocked: (p) => p.y < 6 && p.y + body.top > 4 },
    state = { x: 0, z: 0, y: 2, verticalSpeed: 5.4, grounded: false };
  let ceilingContact = false;
  for (let i = 0; i < 60; i++) {
    const before = state.y;
    Object.assign(state, stepWalkingVertical(world, state, body, 0.2, 1 / 60));
    if (before > 2 && state.verticalSpeed === 0 && state.y > 2) {
      ceilingContact = true;
      assert.equal(state.grounded, false);
    }
    assert.ok(state.y <= 2.101, 'head cannot pass the suspended slab');
  }
  assert.equal(ceilingContact, true);
  assert.ok(state.y >= 0.2);
});

test('an incomplete resolver cannot admit a body still blocked by another collision layer', () => {
  const world = { resolveMovement: () => false, bodyBlocked: (p) => p.x > 0.15 };
  const target = { x: 0.3, y: 0.2, z: 0 };
  assert.equal(resolveBoundedMovement(world, target, { radius: 0.42 }, { x: 0, y: 0.2, z: 0 }), true);
  assert.ok(target.x <= 0.15 && target.x > 0.149);
});

test('mode changes preserve a clear position and current bridge layer, and reject a car in a narrow gap', () => {
  const state = { x: 18, z: -12, y: 5.4, heading: 0, mode: 'walk' };
  const world = { groundHeight: (_x, _z, hint) => (hint < 1 ? 0.2 : 5.4), bodyBlocked: () => false };
  assert.deepEqual(modePlacement(world, state, 'cycle'), { x: 18, z: -12, y: 5.4 });
  assert.deepEqual(modePlacement(world, { ...state, y: 0.2 }, 'walk'), { x: 18, z: -12, y: 0.2 });
  assert.deepEqual(modePlacement(world, { ...state, y: 0.2 }, 'fly'), { x: 18, z: -12, y: 0.45 });
  assert.deepEqual(savedPlacement(world, { ...state, mode: 'fly', y: 0.45 }), { x: 18, z: -12, y: 0.45 });
  world.bodyBlocked = (_position, body) => body.car;
  assert.equal(modePlacement(world, state, 'drive'), null);
  assert.deepEqual(state, { x: 18, z: -12, y: 5.4, heading: 0, mode: 'walk' });
});

test('an overlapping compound collider cannot eject the player across a city block', () => {
  const origin = { x: 0, y: 0.2, z: 0 },
    target = { x: 0.3, y: 0.2, z: 0 };
  const world = {
    bodyBlocked: (p) => p.x > 0.12,
    resolveMovement: (p) => {
      p.x = 40;
      return true;
    },
  };
  assert.equal(resolveBoundedMovement(world, target, { radius: 0.42 }, origin), true);
  assert.ok(target.x <= 0.12 && target.x > 0.11);
  assert.equal(target.z, 0);
  assert.equal(target.y, 0.2);
});
test('bounded tangent sliding preserves progress without an automatic safe-position jump', () => {
  const origin = { x: 0, y: 0.2, z: 0 },
    target = { x: 0.2, y: 0.2, z: 0.2 };
  const world = {
    bodyBlocked: (p) => p.x > 0.12,
    resolveMovement: (p) => {
      p.x = 0.119;
      return true;
    },
  };
  resolveBoundedMovement(world, target, { radius: 0.42 }, origin);
  assert.ok(target.z > 0.19);
  assert.ok(Math.hypot(target.x, target.z) <= Math.hypot(0.2, 0.2) + 0.025);
  const invalid = { x: 0.2, y: 0.2, z: 0 };
  world.resolveMovement = (p) => {
    p.x = Infinity;
    return true;
  };
  resolveBoundedMovement(world, invalid, { radius: 0.42 }, origin);
  assert.ok(Number.isFinite(invalid.x) && invalid.x <= 0.12);
});
test('a car rotating beside a wall stops its rotation instead of shoving its centre', () => {
  const heading = rotationWithClearance(0, 0.3, (h) => h > 0.12);
  assert.ok(heading <= 0.12 && heading > 0.118);
  assert.equal(
    rotationWithClearance(0, 0.3, () => false),
    0.3,
  );
  assert.equal(
    rotationWithClearance(0, 0.3, () => true),
    0,
  );
});
test('bridge travel accepts continuous grades but rejects upward snaps and vehicle cliff drops', () => {
  assert.equal(traversableHeight(0.2, 0.24, 0.3, 'drive'), true);
  assert.equal(traversableHeight(0.2, 6, 0.3, 'drive'), false);
  assert.equal(traversableHeight(6, 0.2, 0.3, 'drive'), false);
  assert.equal(traversableHeight(6, 0.2, 0.3, 'walk'), true, 'a walking character may fall under gravity');
  assert.equal(traversableHeight(0.2, 0.5, 0.05, 'walk'), true);
});

test('vehicles follow grades and curbs without snapping to a stacked bridge deck', () => {
  const wheelbase = { wheelX: 0.82, wheelZ: 1.325 },
    state = { x: 0, z: 0, y: 4, heading: 0 },
    fit = (ground) => fitVehicleGround(ground, state, wheelbase, {});
  const grade = fit((x, z) => 4 + z * 0.15 + x * 0.08);
  assert.ok(Math.abs(grade.pitch + Math.atan(0.15)) < 1e-9);
  assert.ok(grade.roll > 0 && Math.abs(grade.y - 4) < 1e-9);
  const curb = fit((x, z) => (x > 0 && z > 0 ? 4.26 : 4));
  assert.ok(curb.pitch < 0 && curb.roll > 0 && curb.y > 4);
  assert.deepEqual(
    fit((x) => (x > 0 ? 10 : 4)),
    { pitch: -0, roll: 0, y: 4 },
  );
  assert.ok(traversableHeight(4, 4.32, 0.08, 'drive'));
  assert.equal(traversableHeight(4, 10, 0.35, 'drive'), false);
});

test('jump reaches hip height at different physics rates', () => {
  for (const fps of [30, 60, 120]) {
    const world = { bodyBlocked: () => false };
    const body = { radius: 0.42, top: 1.9 };
    let state = { x: 0, y: 0, z: 0, verticalSpeed: 0, grounded: true };
    let apex = 0;
    for (let i = 0; i < fps; i++) {
      state = { ...state, ...stepWalkingVertical(world, state, body, 0, 1 / fps, i === 0) };
      apex = Math.max(apex, state.y);
    }
    assert.ok(apex >= 1.015 && apex <= 1.025, `${fps} Hz jump apex was ${apex} m`);
    assert.equal(state.grounded, true);
  }
});
