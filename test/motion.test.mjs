import test from 'node:test';
import assert from 'node:assert/strict';
import { springScalar, springVector, angleDelta, walkInput, velocityApproach } from '../app/motion.js';

test('camera spring converges without overshoot and is independent of render frame rate', () => {
  const samples = [30, 60, 144].map((hz) => {
    let x = 0,
      velocity = 0;
    for (let i = 0; i < hz; i++) {
      [x, velocity] = springScalar(x, velocity, 10, 0.16, 1 / hz);
      assert.ok(x >= 0 && x <= 10);
    }
    return x;
  });
  assert.ok(Math.max(...samples) - Math.min(...samples) < 1e-10);
  assert.ok(samples[0] > 9.99);
  const position = { x: 0, y: 0, z: 0 },
    velocity = { x: 0, y: 0, z: 0 };
  springVector(position, velocity, { x: 10, y: 20, z: -10 }, 0.16, 1 / 60);
  assert.ok(position.x > 0 && position.z < 0 && position.y === position.x * 2);
});

test('camera-relative walking supports strafe and diagonals without faster diagonal travel', () => {
  const forward = walkInput(1, 0, Math.PI / 2, 6.2);
  assert.ok(Math.abs(forward.x - 6.2) < 1e-8 && Math.abs(forward.z) < 1e-8);
  const strafe = walkInput(0, 1, 0, 6.2);
  assert.equal(strafe.x, -6.2);
  assert.equal(strafe.z, 0);
  const diagonal = walkInput(1, 1, 0, 6.2);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 6.2) < 1e-8);
  assert.ok(Math.abs(angleDelta(3.1, -3.1)) < 0.1, 'turns take the short path across pi');
});

test('locomotion starts promptly, stops quickly and crosses reversal smoothly', () => {
  let velocity = 0;
  for (let i = 0; i < 36; i++) velocity = velocityApproach(velocity, 6.2, 1 / 120, 12, 19);
  assert.ok(velocity > 5);
  for (let i = 0; i < 24; i++) velocity = velocityApproach(velocity, 0, 1 / 120, 24, 40);
  assert.ok(velocity < 0.5);
  const previous = velocity;
  velocity = velocityApproach(velocity, -6.2, 1 / 120, 12, 19);
  assert.ok(previous - velocity <= 19 / 120 + 1e-8);
});
