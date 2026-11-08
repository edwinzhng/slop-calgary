import test from 'node:test';
import assert from 'node:assert/strict';
import { createCivilianPlayer } from '../app/civilian-player.js';
import { createPlayerBicycle } from '../app/player-bicycle.js';

const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('bicycle wheels, fork and pedals animate', () => {
  const bicycle = createPlayerBicycle();
  let previousAngle = bicycle.wheelAngle;
  const count = bicycle.group.children.length;
  for (let frame = 0; frame < 240; frame++) {
    const state = {
      x: 0,
      z: (frame * 14) / 60,
      y: 0,
      speed: 14,
      heading: frame * 0.001,
      steering: 0.3,
      cameraDistance: 5,
    };
    bicycle.update(1 / 60, state, () => 0);
    assert.ok(bicycle.wheelAngle > previousAngle);
    previousAngle = bicycle.wheelAngle;
    assert.equal(bicycle.group.children.length, count);
    assert.ok([...bicycle.group.matrixWorld.elements].every(Number.isFinite));
  }
  assert.ok(Math.abs(bicycle.lean) > 0.01 && Math.abs(bicycle.lean) <= 0.43);
  close(bicycle.frontWheel.rotation.x, bicycle.rearWheel.rotation.x);
  bicycle.dispose();
});

test('bicycle coasting rotates wheels while pedals and rider feet hold their crank position', () => {
  const bicycle = createPlayerBicycle();
  const state = { x: 0, z: 0, y: 0, speed: 14, heading: 0, throttle: 1 };
  bicycle.update(1 / 60, state, () => 0);
  const crank = bicycle.crankAngle,
    wheel = bicycle.wheelAngle;
  for (let i = 0; i < 120; i++) bicycle.update(1 / 60, { ...state, throttle: 0 }, () => 0);
  close(bicycle.crankAngle, crank);
  assert.ok(bicycle.wheelAngle > wheel);
  bicycle.dispose();
});

test('bicycle pitch follows ramps and first-person view leaves handlebars visible', () => {
  const bicycle = createPlayerBicycle(),
    player = createCivilianPlayer();
  const state = { x: 0, z: 0, y: 0, speed: 14, heading: 0, cameraView: 'first', cameraDistance: 0 };
  for (let i = 0; i < 80; i++) bicycle.update(1 / 60, state, (x, z) => z * 0.1);
  close(bicycle.pitch, -Math.atan(0.1), 1e-7);
  player.updateRide(1 / 60, bicycle, state);
  assert.equal(player.group.visible, false);
  assert.equal(bicycle.group.visible, true);
  assert.ok(bicycle.steering.children.some((child) => child.isMesh));
  player.dispose();
  bicycle.dispose();
});
