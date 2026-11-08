// Acceleration, coasting and braking adapted from mrdoob/slop-newyork (MIT).
export const DRIVE = Object.freeze({
  speed: 36,
  reverseSpeed: 10.5,
  acceleration: 21.5,
  powerSpeed: 15,
  rolling: 0.18,
  drag: 0.0012,
  coast: 0.6,
  brake: 9,
  wheelbase: 2.76,
  grip: 9.5,
  cornering: 10.5,
});
export const CYCLE = Object.freeze({
  speed: 19,
  reverseSpeed: 4.5,
  acceleration: 9,
  rolling: 0.08,
  drag: 0.004,
  coast: 0.2,
  brake: 7.5,
  wheelbase: 1.08,
  grip: 15,
  steerAngle: 0.66,
  steerFade: 0.018,
  steerResponse: 14,
  steerReturn: 20,
  cornerSpeed: 11.5,
  cornerBrake: 3,
});
export function driveSpeed(speed, throttle, dt, drive) {
  if (!(dt > 0) || !Number.isFinite(dt)) return speed;
  if (speed * throttle < 0 && Math.abs(speed) < 0.05) speed = 0;
  const braking = speed * throttle < 0,
    magnitude = Math.abs(speed);
  const deceleration =
    drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;
  const limit = throttle < 0 ? drive.reverseSpeed : drive.speed;
  let acceleration = drive.acceleration;
  if (drive.powerSpeed) acceleration *= drive.powerSpeed / Math.max(drive.powerSpeed, magnitude);
  return (
    Math.sign(throttle) *
    Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt)
  );
}
export function turnRate(speed, steering, drive) {
  const steerAngle =
    (steering * (drive.steerAngle ?? 0.58)) / (1 + Math.abs(speed) * (drive.steerFade ?? 0.025));
  const desired = (speed / drive.wheelbase) * Math.tan(steerAngle);
  const limit = drive.grip / Math.max(2, Math.abs(speed));
  return Math.max(-limit, Math.min(limit, desired));
}

const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

// Slop New York's speed-dependent steering and tire slip, with Calgary's
// stronger engine tune. The caller already steps at 120 Hz.
export function stepCarDrive(state, throttle, steering, brake, dt) {
  const forward = state.speed,
    speed = driveSpeed(forward, brake ? -Math.sign(forward) : throttle, dt, DRIVE),
    acceleration = (speed - forward) / dt,
    tireForce = acceleration + DRIVE.drag * forward * Math.abs(forward),
    longitudinal = Math.sign(forward) * acceleration > 0 ? clamp(tireForce, DRIVE.grip * 0.78) : tireForce,
    grip = Math.sqrt(Math.max(0, DRIVE.grip ** 2 - longitudinal ** 2)),
    slide =
      (brake ? 1 : forward * throttle < 0 ? Math.abs(throttle) : 0) * Math.min(1, Math.abs(forward) / 5),
    steeringGrip = grip + (DRIVE.grip - grip) * slide,
    turn = DRIVE.wheelbase * DRIVE.cornering,
    lock = Math.atan(turn / Math.max(speed * speed, turn / Math.tan(0.6)));
  state.steerAngle += (-steering * lock - state.steerAngle) * (1 - Math.exp(-10 * dt));
  const yawLimit = steeringGrip / Math.max(2, Math.abs(speed)),
    target = clamp((speed * Math.tan(state.steerAngle)) / DRIVE.wheelbase, yawLimit),
    yaw = state.yawRate + clamp((target - state.yawRate) * (1 - Math.exp(-5 * dt)), steeringGrip * 0.65 * dt),
    angle = yaw * dt,
    cos = Math.cos(angle),
    sin = Math.sin(angle),
    slip = state.lateralSpeed * cos - speed * sin;
  state.speed = speed * cos + state.lateralSpeed * sin;
  state.lateralSpeed = slip + clamp(-slip * (1 - Math.exp(-4 * dt)), grip * (1 - 0.7 * slide) * dt);
  state.heading += angle;
}

// Fast, continuous lock-to-lock response, with stronger self-centering than turn-in.
export function steeringApproach(current, input, dt, config = DRIVE) {
  if (!(dt > 0) || !Number.isFinite(dt)) return current;
  const target = Math.max(-1, Math.min(1, input));
  const returning =
    !target || Math.sign(target) !== Math.sign(current) || Math.abs(target) < Math.abs(current);
  const response = returning ? (config.steerReturn ?? 20) : (config.steerResponse ?? 14);
  return current + (target - current) * (1 - Math.exp(-response * dt));
}

// A held sharp turn eases off excess speed instead of demanding a perfect brake input.
// Straight-line boost/top speed are unaffected; this is an exploration driving assist.
export function corneringSpeed(speed, steering, dt, config) {
  if (!(dt > 0) || !config.cornerSpeed) return speed;
  const amount = Math.max(0, Math.min(1, (Math.abs(steering) - 0.35) / 0.65));
  const limit = config.cornerSpeed / Math.max(0.25, amount);
  return (
    Math.sign(speed) *
    Math.max(Math.min(Math.abs(speed), limit), Math.abs(speed) - (config.cornerBrake ?? 0) * amount * dt)
  );
}
