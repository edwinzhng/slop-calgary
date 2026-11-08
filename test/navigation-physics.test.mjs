import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE,
  CYCLE,
  driveSpeed,
  turnRate,
  steeringApproach,
  corneringSpeed,
  stepCarDrive,
} from '../app/navigation-physics.js';

function simulate(drive, hz, seconds, throttle = 1, speed = 0) {
  for (let i = 0; i < hz * seconds; i++) speed = driveSpeed(speed, throttle, 1 / hz, drive);
  return speed;
}

test('vehicle acceleration is stable across frame rates and never exceeds its limit', () => {
  for (const config of [DRIVE, CYCLE]) {
    const samples = [30, 60, 144].map((hz) => simulate(config, hz, 10));
    assert.ok(Math.max(...samples) - Math.min(...samples) < 0.09);
    assert.ok(samples.every((speed) => speed > 10 && speed <= config.speed));
    assert.ok(simulate(config, 60, 120) <= config.speed);
  }
});

test('reverse input brakes before changing direction and coasting slows without reversing', () => {
  assert.ok(driveSpeed(20, -1, 1 / 60, DRIVE) < 20);
  assert.ok(simulate(DRIVE, 60, 3, -1, 20) <= 0.01);
  const reverse = simulate(DRIVE, 60, 5, -1, 20);
  assert.ok(reverse < -1 && reverse >= -DRIVE.reverseSpeed);
  const coast = simulate(DRIVE, 60, 30, 0, 20);
  assert.ok(coast >= 0 && coast < 1);
  assert.equal(driveSpeed(5, 1, NaN, DRIVE), 5);
});

test('the car brakes before reversing at the same rate in either direction', () => {
  for (const hz of [30, 120]) {
    for (const sign of [-1, 1]) {
      assert.ok(simulate(DRIVE, hz, 0.1, -sign, 8 * sign) * sign > 0, 'brake before reversing');
      assert.ok(simulate(DRIVE, hz, 0.25, -sign, 8 * sign) * sign > 0);
      assert.ok(simulate(DRIVE, hz, 1.1, -sign, 8 * sign) * sign < -0.6);
    }
  }
});

test('the car launches quickly while retaining speed-dependent steering and tire slip', () => {
  assert.ok(simulate(DRIVE, 60, 0.5) > 10);
  const turn = (speed) => {
    const car = { speed, heading: 0, yawRate: 0, lateralSpeed: 0, steerAngle: 0 };
    const dt = 1 / 120;
    for (let i = 0; i < 120; i++) {
      const previous = car.heading;
      stepCarDrive(car, 0, 1, false, dt);
      car.yawRate = (car.heading - previous) / dt;
    }
    return car;
  };
  const slow = turn(6),
    fast = turn(27);
  assert.ok(Math.abs(slow.steerAngle) > 0.5 && Math.abs(fast.steerAngle) < 0.12);
  assert.ok(Math.abs(slow.heading) > Math.abs(fast.heading));
  assert.ok(fast.lateralSpeed > 0.5 && fast.speed > 20);
});

test('grip limits cornering acceleration and reversing reverses steering', () => {
  for (const config of [DRIVE, CYCLE]) {
    for (const speed of [2, 5, 15, 30, 44]) {
      assert.ok(Math.abs(turnRate(speed, 1, config) * speed) <= config.grip + 1e-8);
      assert.equal(turnRate(speed, -1, config), -turnRate(speed, 1, config));
      assert.equal(turnRate(-speed, 1, config), -turnRate(speed, 1, config));
    }
  }
});

test('bicycle steering returns without lingering input and limits sharp-turn speed', () => {
  for (const config of [CYCLE]) {
    let steering = 0;
    for (let i = 0; i < 12; i++) steering = steeringApproach(steering, 1, 1 / 60, config);
    assert.ok(steering > 0.9);
    for (let i = 0; i < 12; i++) steering = steeringApproach(steering, 0, 1 / 60, config);
    assert.ok(steering < 0.02);
    assert.equal(corneringSpeed(30, 0, 0.1, config), 30);
    assert.ok(corneringSpeed(30, 1, 0.1, config) < 30);
    assert.ok(corneringSpeed(5, 1, 0.1, config) >= 5);
  }
});
