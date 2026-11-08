export const PLAYER_PACE_MULTIPLIER = 2;

// Exact critically damped springs: stable at 30, 60 and 144 Hz, without a
// frame-dependent lerp or overshoot after a teleport.
export function springScalar(current, velocity, target, smoothTime, dt) {
  if (!(dt > 0)) return [current, velocity];
  const omega = 2 / Math.max(0.015, smoothTime),
    decay = Math.exp(-omega * dt);
  const offset = current - target,
    impulse = (velocity + omega * offset) * dt;
  return [target + (offset + impulse) * decay, (velocity - omega * impulse) * decay];
}

export function springVector(current, velocity, target, smoothTime, dt) {
  const omega = 2 / Math.max(0.015, smoothTime),
    decay = Math.exp(-omega * Math.max(0, dt));
  for (const axis of ['x', 'y', 'z']) {
    const offset = current[axis] - target[axis],
      impulse = (velocity[axis] + omega * offset) * dt;
    current[axis] = target[axis] + (offset + impulse) * decay;
    velocity[axis] = (velocity[axis] - omega * impulse) * decay;
  }
  return current;
}

export function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function walkInput(forward, strafe, yaw, speed) {
  const magnitude = Math.min(1, Math.hypot(forward, strafe));
  const length = Math.hypot(forward, strafe) || 1;
  const f = (forward / length) * magnitude * speed,
    s = (strafe / length) * magnitude * speed;
  return { x: Math.sin(yaw) * f - Math.cos(yaw) * s, z: Math.cos(yaw) * f + Math.sin(yaw) * s };
}

export function velocityApproach(current, target, dt, response, acceleration) {
  const desired = (target - current) * (1 - Math.exp(-response * dt));
  return current + Math.max(-acceleration * dt, Math.min(acceleration * dt, desired));
}
