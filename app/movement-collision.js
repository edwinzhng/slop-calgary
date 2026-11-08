// A penetration solver must never eject the player across a building/block.
// Keep its useful tangent slide, but constrain travel to the requested substep.
import { movementBody } from './camera-collision.js';

// Changing vehicle must not relocate a clear player to the nearest road.
// A tight space can reject a larger vehicle instead of searching a whole block.
export function modePlacement(world, state, next) {
  const support =
    next === 'walk' && world.walkSupportHeight
      ? world.walkSupportHeight(state.x, state.z, state.y)
      : world.groundHeight(state.x, state.z, state.y);
  if ((next === 'drive' || next === 'cycle') && state.y > support + 0.65) return null;
  const y =
    next === 'fly'
      ? Math.max(support + 0.25, state.y)
      : next === 'walk'
        ? Math.max(support, state.y)
        : support;
  const position = { x: state.x, y, z: state.z };
  const body = movementBody(next, state.heading);
  if (
    world.bodyBlocked
      ? world.bodyBlocked(position, body)
      : world.collision(position.x, position.z, body.radius, y)
  )
    return null;
  return position;
}

export function savedPlacement(world, saved) {
  let y =
    saved.mode === 'fly'
      ? Math.max(0.25, Math.min(1200, Number(saved.y) || 70))
      : saved.mode === 'walk' && world.walkSupportHeight
        ? world.walkSupportHeight(saved.x, saved.z, Number.isFinite(saved.y) ? saved.y : undefined)
        : world.groundHeight(saved.x, saved.z, Number.isFinite(saved.y) ? saved.y : undefined);
  if (saved.mode === 'walk' && Number.isFinite(saved.y)) {
    if (saved.y > 1200) return null;
    y = Math.max(y, saved.y);
  }
  const position = { x: saved.x, y, z: saved.z },
    body = movementBody(saved.mode, saved.heading);
  if (
    world.bodyBlocked
      ? world.bodyBlocked(position, body)
      : world.collision(position.x, position.z, body.radius, y)
  )
    return null;
  return position;
}

export function resolveBoundedMovement(world, position, body, origin) {
  const targetX = position.x,
    targetZ = position.z;
  const travel = Math.hypot(targetX - origin.x, targetZ - origin.z);
  const blocked = (x, z) =>
    world.bodyBlocked
      ? world.bodyBlocked({ x, y: position.y, z }, body)
      : world.collision(x, z, body.radius, position.y);
  const hit = world.resolveMovement ? world.resolveMovement(position, body) : blocked(position.x, position.z);
  const actual = Math.hypot(position.x - origin.x, position.z - origin.z);
  if (Number.isFinite(actual) && actual <= travel + 0.025 && !blocked(position.x, position.z)) return !!hit;
  // Recover the last clear point on the intended short segment. No safe-position
  // search or automatic teleport is involved, even if source colliders overlap.
  let low = 0,
    high = 1;
  if (!blocked(origin.x, origin.z)) {
    for (let i = 0; i < 9; i++) {
      const mid = (low + high) * 0.5;
      if (blocked(origin.x + (targetX - origin.x) * mid, origin.z + (targetZ - origin.z) * mid)) high = mid;
      else low = mid;
    }
  }
  position.x = origin.x + (targetX - origin.x) * low;
  position.z = origin.z + (targetZ - origin.z) * low;
  return true;
}

// Check the vertical body sweep as well as horizontal motion. Descending onto
// a roof or jumping into a suspended floor must stop at the first solid face.
export function sweepVerticalMovement(world, position, body, targetY) {
  const origin = position.y;
  if (!Number.isFinite(targetY)) return { y: origin, hit: true };
  if (Math.abs(targetY - origin) < 1e-8) return { y: origin, hit: false };
  const pose = { x: position.x, y: origin, z: position.z };
  const blocked = (y) => {
    pose.y = y;
    return world.bodyBlocked
      ? world.bodyBlocked(pose, body)
      : world.collision(pose.x, pose.z, body.radius, y);
  };
  if (blocked(origin)) return { y: origin, hit: true };
  const count = Math.max(1, Math.ceil(Math.abs(targetY - origin) / 0.25));
  let safe = origin;
  for (let i = 1; i <= count; i++) {
    const next = origin + ((targetY - origin) * i) / count;
    if (blocked(next)) {
      let lo = 0,
        hi = 1;
      for (let j = 0; j < 10; j++) {
        const mid = (lo + hi) / 2;
        if (blocked(safe + (next - safe) * mid)) hi = mid;
        else lo = mid;
      }
      return { y: safe + (next - safe) * lo, hit: true };
    }
    safe = next;
  }
  return { y: targetY, hit: false };
}

// A downward body contact is a valid standing surface even when it is a roof
// absent from the ground/bridge height field. A ceiling hit never grounds feet.
export function stepWalkingVertical(world, state, body, ground, dt, jump = false) {
  const gravity = 14.5,
    launchSpeed = Math.sqrt(2 * gravity * 1.02),
    initial = jump ? launchSpeed : state.verticalSpeed || 0,
    velocity = initial - gravity * dt;
  const vertical = sweepVerticalMovement(
    world,
    state,
    body,
    Math.max(ground, state.y + (initial + velocity) * dt * 0.5),
  );
  return {
    y: vertical.y,
    verticalSpeed: vertical.hit || vertical.y <= ground + 0.001 ? 0 : velocity,
    grounded: vertical.y <= ground + 0.02 || (vertical.hit && velocity <= 0),
  };
}

export function rotationWithClearance(from, to, blocked) {
  if (!blocked(to)) return to;
  if (blocked(from)) return from;
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  let low = 0,
    high = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (low + high) * 0.5;
    if (blocked(from + delta * mid)) high = mid;
    else low = mid;
  }
  return from + delta * low;
}

export function traversableHeight(from, to, distance, mode) {
  if (!Number.isFinite(to)) return false;
  if (mode === 'fly') return true;
  const rise = mode === 'walk' ? 0.48 : mode === 'drive' ? 0.38 : 0.24;
  const maxRise = rise + Math.max(0, distance) * (mode === 'drive' ? 0.55 : 0.4);
  if (to - from > maxRise) return false;
  return mode === 'walk' || from - to < 0.6 + Math.max(0, distance) * 0.5;
}

// Fit the chassis to the wheel contacts, then lift just enough to clear a
// crown or curb. Ignore samples on a separate stacked road or off a deck edge.
export function fitVehicleGround(groundHeight, { x, y, z, heading }, spec, out) {
  const { wheelX, wheelZ } = spec;
  const sin = Math.sin(heading),
    cos = Math.cos(heading);
  const sample = (u, v) => {
    const height = groundHeight(x + u * cos + v * sin, z - u * sin + v * cos, y);
    return Number.isFinite(height) && Math.abs(height - y) <= 1.3 ? height : y;
  };
  const fl = sample(-wheelX, wheelZ),
    fr = sample(wheelX, wheelZ);
  const rl = sample(-wheelX, -wheelZ),
    rr = sample(wheelX, -wheelZ);
  const forward = (fl + fr - rl - rr) / (4 * wheelZ);
  const right = (fr + rr - fl - rl) / (4 * wheelX);
  const run = wheelZ * forward,
    cross = wheelX * right;
  out.y = Math.max(y, fl - run + cross, fr - run - cross, rl + run + cross, rr + run - cross);
  out.pitch = -Math.atan(forward);
  out.roll = Math.atan(right * Math.cos(out.pitch));
  return out;
}
