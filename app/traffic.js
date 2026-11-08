import { project, roadWidth, seeded, SpatialIndex } from './geo.js';
import { createTrafficFrameWorkspace } from './traffic-frame-workspace.js';

export const TRAFFIC_PAINTS = Object.freeze([
  0xe2e3dd, 0x456778, 0x454b50, 0x9d4240, 0xbfc3bf, 0xb89c73, 0x317d76, 0x655376, 0x46749f, 0xc87a43,
  0x786644, 0x8f9e69, 0xf0eae0, 0x556171, 0x883f53, 0x424445,
]);

export const trafficVehicleModel = (sample) => (sample < 0.3 ? 'pickup' : 'sedan');

export const TRAFFIC_LIMITS = Object.freeze({
  fleet: 144,
  touchFleet: 88,
  nearby: 32,
  touchNearby: 24,
  balancedVisible: 65,
  highVisible: 100,
  acceleration: 2.6,
  deceleration: 6,
  minimumGap: 2.5,
  headway: 1.1,
  halfWidth: 0.9,
  halfLength: 2.3,
  top: 1.65,
  maximumPlayerPush: 3,
});
const BUS_BODY = Object.freeze({ halfWidth: 1.29, halfLength: 6.08, top: 3.35 });
const trafficBody = (car) => (car.model === 'bus' ? BUS_BODY : TRAFFIC_LIMITS);
const busStreet = (road) =>
  /primary|secondary|tertiary/.test(road.kind) && roadWidth(road) > 6.8 && !road.tunnel;
const throughStreet = (road) => road.kind !== 'service' || Boolean(road.name);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const dot = (ax, az, bx, bz) => ax * bx + az * bz;
const cross = (ax, az, bx, bz) => ax * bz - az * bx;
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export function rightLaneOffset(road, lane = 0) {
  const width = roadWidth(road),
    lanes = Math.max(1, Number(road.lanes) || Math.round(width / 3.2)),
    oneWay = road.oneway && road.oneway !== 'no';
  if (oneWay) return (((Math.abs(lane) % lanes) + 0.5 - lanes / 2) * width) / lanes;
  const perDirection = Math.max(1, Math.floor(lanes / 2)),
    chosen = Math.abs(lane) % perDirection;
  return Math.min(width / 2 - TRAFFIC_LIMITS.halfWidth - 0.15, ((chosen + 0.5) * width) / (perDirection * 2));
}

export function trafficLanePosition(edge, t, lane = 0) {
  const offset = rightLaneOffset(edge.road, lane),
    x = edge.a[0] + (edge.b[0] - edge.a[0]) * t,
    z = edge.a[1] + (edge.b[1] - edge.a[1]) * t;
  // x points east and z points south: geographic right is (-cos h, +sin h).
  return {
    x: x - Math.cos(edge.heading) * offset,
    z: z + Math.sin(edge.heading) * offset,
    heading: edge.heading,
  };
}

export function trafficMotion({
  speed,
  desiredSpeed,
  dt,
  stopDistance = Infinity,
  leaderGap = Infinity,
  leaderSpeed = 0,
  yieldDistance = Infinity,
}) {
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1),
    current = Math.max(0, Number.isFinite(speed) ? speed : 0);
  let target = Math.max(0, Number.isFinite(desiredSpeed) ? desiredSpeed : 0),
    maximumTravel = Infinity;
  const clearance = Math.min(stopDistance, yieldDistance);
  if (Number.isFinite(clearance)) {
    const available = Math.max(0, clearance);
    target = Math.min(target, Math.sqrt(2 * TRAFFIC_LIMITS.deceleration * available));
    maximumTravel = available;
  }
  if (Number.isFinite(leaderGap)) {
    const available = Math.max(0, leaderGap - TRAFFIC_LIMITS.minimumGap),
      lead = Math.max(0, leaderSpeed);
    target = Math.min(
      target,
      available / TRAFFIC_LIMITS.headway,
      Math.sqrt(lead * lead + 2 * TRAFFIC_LIMITS.deceleration * available),
    );
    // Stop the final few centimetres of numerical creep in a stationary queue.
    if (lead < 0.3 && available < 0.25) target = 0;
    maximumTravel = Math.min(maximumTravel, available + lead * step);
  }
  let next =
      current +
      clamp(target - current, -TRAFFIC_LIMITS.deceleration * step, TRAFFIC_LIMITS.acceleration * step),
    travel = Math.max(0, ((current + next) * step) / 2);
  if (step > 0 && travel >= maximumTravel) {
    travel = maximumTravel;
    next = 0;
  }
  if (next < 0.03 && target < 0.03) next = 0;
  return {
    speed: next,
    distance: travel,
    acceleration: step ? (next - current) / step : 0,
    blocked: next < 0.3 && desiredSpeed > 1,
    targetSpeed: target,
  };
}

export function stopLineClearance(signal, halfLength = TRAFFIC_LIMITS.halfLength) {
  if (!signal || signal.state === 'green' || signal.distance < halfLength - 0.1) return Infinity;
  return Math.max(0, signal.distance - halfLength - 0.65);
}

export function avoidanceOffset(car, player) {
  if (
    !player ||
    !['walk', 'cycle', 'drive'].includes(player.mode) ||
    car.model === 'bus' ||
    car.seed > 0.7 ||
    Math.abs(player.y - car.y) > 1.6 ||
    car.speed < 2 ||
    (1 - car.t) * car.edge.length < 8
  )
    return 0;
  const heading = car.edge.heading,
    sin = Math.sin(heading),
    cos = Math.cos(heading),
    dx = player.x - car.x,
    dz = player.z - car.z,
    length = trafficBody(car).halfLength + (player.mode === 'drive' ? 2.15 : 0.4),
    along = dx * sin + dz * cos,
    closing = car.speed - ((player.velocityX || 0) * sin + (player.velocityZ || 0) * cos),
    seconds = (along - length) / Math.max(2, closing),
    across =
      dx * cos -
      dz * sin +
      (car.dodge || 0) +
      ((player.velocityX || 0) * cos - (player.velocityZ || 0) * sin) * Math.max(0, seconds);
  if (along < 0 || along > 24 || seconds < -0.15 || seconds > 1.35 || Math.abs(across) > 2.2) return 0;
  const road = car.edge.road,
    width = roadWidth(road) / 2,
    lane = rightLaneOffset(road, car.lane),
    clearance = trafficBody(car).halfWidth + 0.24,
    left = road.oneway && road.oneway !== 'no' ? lane + width - clearance : lane - clearance,
    right = width - lane - clearance,
    side = across > 0 ? -1 : 1;
  return side * Math.max(0, Math.min(1.55, side > 0 ? left : right));
}

// A compact SAT test for the player's oriented car body against an AI car.
// Circle bodies are used for walking, cycling and low helicopter movement.
export function trafficBodyContact(position, body, car, out = {}) {
  const { halfWidth: carWidth, halfLength: carLength, top } = trafficBody(car);
  if (position.y >= car.y + top || position.y + (body.top ?? 1.9) <= car.y) return false;
  const sinB = Math.sin(car.heading),
    cosB = Math.cos(car.heading),
    dx = position.x - car.x,
    dz = position.z - car.z;
  if (!body.car) {
    const localX = dx * cosB - dz * sinB,
      localZ = dx * sinB + dz * cosB;
    const closestX = clamp(localX, -carWidth, carWidth),
      closestZ = clamp(localZ, -carLength, carLength);
    const vx = localX - closestX,
      vz = localZ - closestZ,
      d = Math.hypot(vx, vz),
      radius = body.radius ?? 0.42;
    if (d >= radius) return false;
    let nx, nz, depth;
    if (d > 1e-8) {
      nx = vx / d;
      nz = vz / d;
      depth = radius - d;
    } else if (carWidth - Math.abs(localX) < carLength - Math.abs(localZ)) {
      nx = localX < 0 ? -1 : 1;
      nz = 0;
      depth = radius + carWidth - Math.abs(localX);
    } else {
      nx = 0;
      nz = localZ < 0 ? -1 : 1;
      depth = radius + carLength - Math.abs(localZ);
    }
    out.nx = nx * cosB + nz * sinB;
    out.nz = -nx * sinB + nz * cosB;
    out.depth = depth;
    return true;
  }
  const sinA = body.sin ?? 0,
    cosA = body.cos ?? 1,
    halfWidth = body.hx ?? 0.9,
    halfLength = body.hz ?? 2.25;
  let depth = Infinity,
    pushX = 0,
    pushZ = 0;
  for (const [nx, nz] of [
    [cosA, -sinA],
    [sinA, cosA],
    [cosB, -sinB],
    [sinB, cosB],
  ]) {
    const radiusA =
      Math.abs(nx * cosA - nz * sinA) * halfWidth + Math.abs(nx * sinA + nz * cosA) * halfLength;
    const radiusB = Math.abs(nx * cosB - nz * sinB) * carWidth + Math.abs(nx * sinB + nz * cosB) * carLength;
    const separation = dx * nx + dz * nz,
      overlap = radiusA + radiusB - Math.abs(separation);
    if (overlap <= 0) return false;
    if (overlap < depth) {
      depth = overlap;
      const sign = separation < 0 ? -1 : 1;
      pushX = nx * sign;
      pushZ = nz * sign;
    }
  }
  out.nx = pushX;
  out.nz = pushZ;
  out.depth = depth;
  return true;
}

function cityLimits(data) {
  if (!data.meta?.bbox) return null;
  const b = data.meta.bbox,
    a = project(b.west, b.north),
    c = project(b.east, b.south);
  return { minX: a[0] - 120, maxX: c[0] + 120, minZ: a[1] - 120, maxZ: c[1] + 120 };
}
function inLimits(x, z, box) {
  return !box || (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ);
}
function cruisingSpeed(road, seed) {
  const nominal = road.kind.includes('motorway')
    ? 22
    : road.kind.includes('trunk')
      ? 18
      : road.kind.includes('primary')
        ? 13
        : road.kind.includes('secondary')
          ? 12
          : road.kind.includes('tertiary')
            ? 10
            : 8;
  return nominal * (0.88 + seed * 0.2);
}

export function createTrafficSimulation(world, graph, rng, count = TRAFFIC_LIMITS.fleet) {
  const limits = cityLimits(world.data),
    spawnEdges = graph.edges.filter(
      (e) => throughStreet(e.road) && inLimits((e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2, limits),
    ),
    spawnIndex = new SpatialIndex(160),
    fleet = [],
    index = new SpatialIndex(32),
    frameWorkspace = createTrafficFrameWorkspace(rightLaneOffset);
  for (const edge of spawnEdges)
    spawnIndex.insert(edge, {
      minX: Math.min(edge.a[0], edge.b[0]),
      minZ: Math.min(edge.a[1], edge.b[1]),
      maxX: Math.max(edge.a[0], edge.b[0]),
      maxZ: Math.max(edge.a[1], edge.b[1]),
    });
  const busEdges = spawnEdges.filter((edge) => busStreet(edge.road) && edge.length > 14);
  const carBody = {
    car: true,
    hx: TRAFFIC_LIMITS.halfWidth,
    hz: TRAFFIC_LIMITS.halfLength,
    radius: 2.5,
    extX: 2.5,
    extZ: 2.5,
    top: TRAFFIC_LIMITS.top,
    sin: 0,
    cos: 1,
  };
  const pickNext = (edge, car) => {
    const choices = (graph.nodes.get(edge.end) || []).filter((n) => n.end !== edge.key);
    if (car.model === 'bus') {
      const avenues = choices.filter(
        (next) => busStreet(next.road) && Math.abs(angleDelta(next.heading, edge.heading)) < 1.95,
      );
      if (avenues.length) return avenues[Math.floor(rng() * avenues.length)];
    }
    const streets = choices.filter((next) => throughStreet(next.road));
    if (streets.length) return streets[Math.floor(rng() * streets.length)];
    if (choices.length) return choices[Math.floor(rng() * choices.length)];
    return (graph.nodes.get(edge.end) || []).find((n) => n.end === edge.key) || null;
  };
  const setPose = (car, snap = false, dt = 0) => {
    const p = frameWorkspace.pose(car);
    car.x = p.x + Math.cos(p.heading) * car.dodge;
    car.z = p.z - Math.sin(p.heading) * car.dodge;
    const nose = p.heading + car.dodgeVelocity * 0.12;
    car.heading = snap ? nose : car.heading + angleDelta(nose, car.heading) * Math.min(1, dt * 8);
    car.y = world.surfaceHeight?.(car.x, car.z, car.edge.road) ?? world.groundHeight?.(car.x, car.z) ?? 0.18;
  };
  function spawn(car, camera = null, local = null) {
    const candidates =
      car.model === 'bus'
        ? local?.edges?.filter((edge) => busStreet(edge.road) && edge.length > 14) || busEdges
        : local?.edges || spawnEdges;
    for (let trial = 0; trial < 28; trial++) {
      const edge = candidates[Math.floor(rng() * candidates.length)];
      if (!edge) break;
      const t = 0.08 + rng() * 0.84,
        pose = trafficLanePosition(edge, t, car.lane);
      if (local) {
        const dx = pose.x - local.x,
          dz = pose.z - local.z;
        const distance = Math.hypot(dx, dz);
        if (
          distance < (local.initial ? 30 : 90) ||
          distance > 285 ||
          (local.initial && trial < 20 && dx * local.lookX + dz * local.lookZ < distance * 0.32) ||
          (!local.initial && distance < 235 && dx * local.lookX + dz * local.lookZ > distance * 0.28)
        )
          continue;
      } else if (camera && Math.hypot(pose.x - camera.position.x, pose.z - camera.position.z) < 260) {
        continue;
      }
      const y = world.surfaceHeight?.(pose.x, pose.z, edge.road) ?? 0.18;
      carBody.sin = Math.sin(edge.heading);
      carBody.cos = Math.cos(edge.heading);
      const shape = trafficBody(car);
      carBody.hx = shape.halfWidth;
      carBody.hz = shape.halfLength;
      carBody.radius = carBody.extX = carBody.extZ = Math.hypot(shape.halfWidth, shape.halfLength);
      carBody.top = shape.top;
      const placement = { x: pose.x, y, z: pose.z };
      carBody.hz += 1.5;
      const occupied = fleet.some((other) => {
        if (
          other === car ||
          !other.edge ||
          Math.abs(other.x - pose.x) > 15 ||
          Math.abs(other.z - pose.z) > 15
        )
          return false;
        return trafficBodyContact(placement, carBody, other);
      });
      carBody.hz = shape.halfLength;
      if (occupied || world.bodyBlocked?.(placement, carBody)) continue;
      car.edge = edge;
      car.t = t;
      car.previousEdge = null;
      car.nextEdge = pickNext(edge, car);
      car.speed = cruisingSpeed(edge.road, car.seed) * 0.7;
      car.acceleration = 0;
      car.blocked = false;
      car.yieldTimer = 0;
      car.motion = null;
      car.controls = null;
      car.policyClock = 0;
      car.dodge = car.dodgeVelocity = 0;
      car.pitchEdge = null;
      car.pitch = undefined;
      setPose(car, true);
      return true;
    }
    if (!local) {
      car.edge = null;
      car.speed = 0;
      car.motion = null;
    }
    return false;
  }
  const vehicleMix = seeded(431);
  for (let i = 0; i < Math.min(count, TRAFFIC_LIMITS.fleet); i++) {
    const model = trafficVehicleModel(vehicleMix());
    const car = {
      id: i,
      model: busEdges.length && i % 16 === 8 ? 'bus' : model,
      seed: rng(),
      lane: Math.floor(rng() * 8),
      paintIndex: Math.floor(rng() * TRAFFIC_PAINTS.length),
      edge: null,
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 0,
      acceleration: 0,
      blocked: false,
      yieldTimer: 0,
      dodge: 0,
      dodgeVelocity: 0,
      retry: 0,
    };
    spawn(car);
    fleet.push(car);
  }
  function rebuildIndex() {
    for (const car of fleet) {
      const radius = trafficBody(car).halfLength + 0.25;
      const loX = Math.floor((car.x - radius) / index.size),
        hiX = Math.floor((car.x + radius) / index.size),
        loZ = Math.floor((car.z - radius) / index.size),
        hiZ = Math.floor((car.z + radius) / index.size);
      if (
        car.edge &&
        car.cellLoX === loX &&
        car.cellHiX === hiX &&
        car.cellLoZ === loZ &&
        car.cellHiZ === hiZ
      )
        continue;
      for (const key of car.cellKeys || []) {
        const cell = index.cells.get(key);
        if (!cell) continue;
        const at = cell.indexOf(car);
        if (at >= 0) cell.splice(at, 1);
        if (!cell.length) index.cells.delete(key);
      }
      car.cellKeys = [];
      car.cellLoX = loX;
      car.cellHiX = hiX;
      car.cellLoZ = loZ;
      car.cellHiZ = hiZ;
      if (!car.edge) {
        car.cellLoX = null;
        continue;
      }
      for (let x = loX; x <= hiX; x++)
        for (let z = loZ; z <= hiZ; z++) {
          const key = `${x},${z}`;
          if (!index.cells.has(key)) index.cells.set(key, []);
          index.cells.get(key).push(car);
          car.cellKeys.push(key);
        }
    }
  }
  rebuildIndex();
  let elapsed = 0,
    lastPlayer = null;
  const stats = { simulated: fleet.length, stopped: 0, contacts: 0, policyQueries: 0 };
  function leader(car, player) {
    const dx = Math.sin(car.edge.heading),
      dz = Math.cos(car.edge.heading);
    let gap = Infinity,
      speed = 0,
      yieldDistance = Infinity,
      leaderCar = null,
      playerLeader = false;
    const nearby = frameWorkspace.neighbours(index, car.x, car.z, 70, car);
    if (player && ['walk', 'drive', 'cycle'].includes(player.mode))
      nearby.push({
        id: -1,
        x: player.x,
        y: player.y,
        z: player.z,
        heading: player.heading + (player.speed < 0 ? Math.PI : 0),
        speed: Math.abs(player.speed),
        halfLength: player.mode === 'drive' ? 2.25 : 0.5,
        player: true,
      });
    for (const other of nearby) {
      if (
        other === car ||
        other.y >= car.y + trafficBody(car).top ||
        other.y + (other.player ? 1.9 : trafficBody(other).top) <= car.y
      )
        continue;
      const rx = other.x - car.x,
        rz = other.z - car.z,
        along = rx * dx + rz * dz,
        lateral = Math.abs(rx * dz - rz * dx),
        odx = Math.sin(other.heading),
        odz = Math.cos(other.heading),
        sameDirection = dot(dx, dz, odx, odz);
      if (
        along > 0 &&
        along < 70 &&
        lateral <
          (other.player
            ? 1.35
            : Math.max(1.6, trafficBody(car).halfWidth + trafficBody(other).halfWidth - 0.2)) &&
        (sameDirection > 0.6 || other.player)
      ) {
        const clear =
          along - trafficBody(car).halfLength - (other.halfLength ?? trafficBody(other).halfLength);
        if (clear < gap) {
          leaderCar = other.player ? player : other;
          playerLeader = !!other.player;
          gap = clear;
          speed = other.player
            ? Math.max(0, other.speed * sameDirection)
            : (other.snapshotSpeed ?? other.speed);
        }
      }
      // Deterministic yielding at unsignalized crossing trajectories. Stopped
      // traffic behind another stop line must not hold a green approach hostage.
      if (
        Math.abs(sameDirection) > 0.7 ||
        other.id > car.id ||
        ((other.snapshotSpeed ?? other.speed) < 0.5 && !other.player)
      )
        continue;
      const den = cross(dx, dz, odx, odz);
      if (Math.abs(den) < 0.2) continue;
      const a = cross(rx, rz, odx, odz) / den,
        b = cross(rx, rz, dx, dz) / den;
      if (a < 0 || a > 35 || b < -2 || b > 35) continue;
      const arrivalA = a / Math.max(2, car.snapshotSpeed),
        arrivalB = b / Math.max(1, other.snapshotSpeed ?? other.speed);
      if (arrivalA < 2.6 && arrivalB < 2.6 && Math.abs(arrivalA - arrivalB) < 1.4)
        yieldDistance = Math.min(yieldDistance, Math.max(0, a - 4.8));
    }
    return { leaderGap: gap, leaderSpeed: speed, yieldDistance, leaderCar, playerLeader };
  }
  function advance(car, distance, camera) {
    let remaining = distance;
    for (let hops = 0; remaining > 1e-7 && car.edge && hops < 12; hops++) {
      const left = (1 - car.t) * car.edge.length;
      if (remaining < left) {
        car.t += remaining / car.edge.length;
        remaining = 0;
        break;
      }
      if (!car.nextEdge && camera && Math.hypot(car.x - camera.position.x, car.z - camera.position.z) < 260) {
        // A cut-off one-way source edge may have no mapped onward connection.
        // Hold at its end until it is out of view rather than visibly teleporting.
        car.t = 1;
        car.speed = 0;
        car.blocked = true;
        remaining = 0;
        break;
      }
      remaining -= left;
      car.previousEdge = car.edge;
      car.edge = car.nextEdge;
      if (!car.edge) {
        spawn(car, camera);
        remaining = 0;
        break;
      }
      car.t = 0;
      car.nextEdge = pickNext(car.edge, car);
      car.controls = null;
      car.policyClock = 0;
    }
  }
  function step(dt, player, camera) {
    const duration = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1),
      pieces = Math.max(1, Math.ceil(duration / 0.05)),
      delta = duration / pieces;
    elapsed += duration;
    lastPlayer = player;
    const playerBody =
      player && ['walk', 'drive', 'cycle'].includes(player.mode)
        ? {
            car: player.mode === 'drive',
            sin: Math.sin(player.heading),
            cos: Math.cos(player.heading),
            hx: 0.9,
            hz: 2.25,
            top: 1.9,
            radius: player.mode === 'cycle' ? 0.6 : 0.42,
          }
        : null;
    for (let piece = 0; piece < pieces; piece++) {
      for (const car of fleet) car.snapshotSpeed = car.speed;
      for (const car of fleet) {
        if (!car.edge) {
          car.retry -= delta;
          if (car.retry <= 0) {
            spawn(car, camera);
            car.retry = 2;
          }
          continue;
        }
        car.policyClock = (car.policyClock || 0) - delta;
        if (!car.controls || car.policyClock <= 0) {
          const first = !car.controls,
            interval =
              camera && Math.hypot(car.x - camera.position.x, car.z - camera.position.z) < 550 ? 0.1 : 0.25;
          let signal = world.infrastructure?.trafficSignalAhead(
            car.x,
            car.z,
            car.edge.heading,
            world.infrastructure.signalTime ?? elapsed,
            Math.max(45, car.speed ** 2 / 12 + 12),
          );
          if (signal?.signal && Math.abs(signal.signal.y - car.y) > 2) signal = null;
          let dodge = avoidanceOffset(car, player);
          if (dodge) {
            const dx = Math.sin(car.edge.heading),
              dz = Math.cos(car.edge.heading);
            for (const other of index.near(car.x, car.z, 18)) {
              if (other === car || Math.abs(car.y - other.y) > 1.5) continue;
              const along = (other.x - car.x) * dx + (other.z - car.z) * dz,
                across = (other.x - car.x) * dz - (other.z - car.z) * dx;
              if (
                along > -4 &&
                along < 14 &&
                Math.abs(across - dodge + car.dodge) < trafficBody(other).halfWidth + 1.1
              ) {
                dodge = 0;
                break;
              }
            }
          }
          car.controls = { ...leader(car, player), signal, travelled: 0, dodge };
          car.policyClock = first ? interval * (0.65 + car.seed * 0.7) : car.policyClock + interval;
          stats.policyQueries++;
        }
        const control = car.controls,
          cachedSignal = control.signal;
        let signal = null,
          leaderGap = Infinity,
          leaderSpeed = 0;
        if (cachedSignal) {
          const s = cachedSignal.signal,
            heading = car.edge.heading;
          const distance = s
            ? (s.stopX - car.x) * Math.sin(heading) + (s.stopZ - car.z) * Math.cos(heading)
            : cachedSignal.distance - control.travelled;
          signal = {
            distance,
            state:
              s && world.infrastructure?.signalPhase
                ? world.infrastructure.signalPhase(world.infrastructure.signalTime ?? elapsed, s.axis, s.seed)
                : cachedSignal.state,
          };
        }
        const other = control.playerLeader ? player : control.leaderCar;
        if (
          other &&
          (control.playerLeader || other.edge) &&
          other.y < car.y + trafficBody(car).top &&
          other.y + (control.playerLeader ? 1.9 : trafficBody(other).top) > car.y
        ) {
          const dx = Math.sin(car.edge.heading),
            dz = Math.cos(car.edge.heading),
            rx = other.x - car.x,
            rz = other.z - car.z,
            along = rx * dx + rz * dz,
            across = Math.abs(rx * dz - rz * dx);
          if (along > 0 && across < (control.playerLeader ? 1.35 : 1.6)) {
            leaderGap =
              along -
              trafficBody(car).halfLength -
              (control.playerLeader ? (other.mode === 'drive' ? 2.25 : 0.5) : trafficBody(other).halfLength);
            leaderSpeed = control.playerLeader
              ? Math.max(0, other.speed * (dx * Math.sin(other.heading) + dz * Math.cos(other.heading)))
              : other.snapshotSpeed;
          }
        }
        car.yieldTimer = Math.max(0, car.yieldTimer - delta);
        car.motion = trafficMotion({
          speed: car.speed,
          desiredSpeed: car.yieldTimer
            ? 0
            : cruisingSpeed(car.edge.road, car.seed) * (car.model === 'bus' ? 0.82 : 1),
          dt: delta,
          stopDistance: Math.min(
            stopLineClearance(signal, trafficBody(car).halfLength),
            world.transit?.trafficStopDistance(car) ?? Infinity,
          ),
          leaderGap,
          leaderSpeed,
          yieldDistance: Number.isFinite(control.yieldDistance)
            ? Math.max(0, control.yieldDistance - control.travelled)
            : Infinity,
        });
      }
      for (const car of fleet) {
        if (!car.edge || !car.motion) continue;
        const nearPlayer = playerBody && Math.hypot(car.x - player.x, car.z - player.z) < 14,
          previous = nearPlayer
            ? {
                edge: car.edge,
                previousEdge: car.previousEdge,
                nextEdge: car.nextEdge,
                t: car.t,
                x: car.x,
                y: car.y,
                z: car.z,
                heading: car.heading,
                dodge: car.dodge,
                dodgeVelocity: car.dodgeVelocity,
              }
            : null,
          previousDepth =
            nearPlayer && trafficBodyContact(player, playerBody, car, contact) ? contact.depth : 0,
          oldSpeed = car.speed;
        car.speed = car.motion.speed;
        car.acceleration = car.motion.acceleration;
        car.blocked = car.motion.blocked;
        const dodge = car.controls?.dodge ?? 0,
          target = (dodge - car.dodge) * 3.5;
        car.dodgeVelocity += (target - car.dodgeVelocity) * (1 - Math.exp(-9 * delta));
        car.dodge += car.dodgeVelocity * delta;
        advance(car, car.motion.distance, camera);
        if (car.controls) car.controls.travelled += car.motion.distance;
        if (!car.edge) continue;
        setPose(car, false, delta);
        if (
          nearPlayer &&
          trafficBodyContact(player, playerBody, car, contact) &&
          contact.depth > previousDepth
        ) {
          // An idle player also has a solid body: turn blending must not slide
          // an AI vehicle through it between navigation updates.
          Object.assign(car, previous);
          car.speed = 0;
          car.acceleration = delta ? -oldSpeed / delta : 0;
          car.blocked = true;
          car.yieldTimer = 0.4;
        }
        if (!inLimits(car.x, car.z, limits)) spawn(car, camera);
      }
      rebuildIndex();
    }
    stats.stopped = fleet.filter((c) => c.edge && c.speed < 0.3).length;
  }
  const contact = {};
  function blocked(position, body) {
    for (const car of index.near(position.x, position.z, (body.radius ?? 2.5) + 3))
      if (trafficBodyContact(position, body, car, contact)) return true;
    return false;
  }
  function resolvePlayer(position, body) {
    let hit = false,
      pushed = 0;
    world.lastTrafficContact = null;
    for (let iteration = 0; iteration < 4 && pushed < TRAFFIC_LIMITS.maximumPlayerPush; iteration++) {
      let moved = false;
      for (const car of index.near(position.x, position.z, (body.radius ?? 2.5) + 3)) {
        if (!trafficBodyContact(position, body, car, contact)) continue;
        const amount = Math.min(0.9, contact.depth + 0.003, TRAFFIC_LIMITS.maximumPlayerPush - pushed);
        position.x += contact.nx * amount;
        position.z += contact.nz * amount;
        pushed += amount;
        if (!world.lastTrafficContact)
          world.lastTrafficContact = {
            car,
            speed: Math.max(Math.abs(lastPlayer?.speed ?? 0), car.speed),
            x: position.x,
            y: position.y,
            z: position.z,
          };
        if (car.model !== 'bus' && body.car && Math.abs(lastPlayer?.speed ?? 0) > 3)
          car.dodgeVelocity = clamp(
            -(contact.nx * Math.cos(car.heading) - contact.nz * Math.sin(car.heading)) * 3,
            -2.5,
            2.5,
          );
        car.speed *= 0.3;
        car.yieldTimer = 0.8;
        car.blocked = true;
        hit = moved = true;
        if (pushed >= TRAFFIC_LIMITS.maximumPlayerPush) break;
      }
      if (!moved) break;
    }
    if (hit) stats.contacts++;
    return hit;
  }
  function populate(local, minimum) {
    const radius = 290;
    let nearby = fleet.filter(
      (car) => car.edge && Math.hypot(car.x - local.x, car.z - local.z) < radius,
    ).length;
    if (nearby < minimum) {
      const edges = [...spawnIndex.near(local.x, local.z, radius)].filter(
        (edge) => edge.length > 11 && !edge.road.bridge,
      );
      const spare = fleet.filter((car) => !car.edge || Math.hypot(car.x - local.x, car.z - local.z) > 570);
      const context = { ...local, edges };
      for (let i = 0; i < Math.min(spare.length, local.initial ? minimum * 2 : 12) && nearby < minimum; i++) {
        if (spawn(spare[i], null, context)) nearby++;
      }
      rebuildIndex();
    }
    stats.neighborhood = nearby;
  }
  return { fleet, index, stats, step, blocked, resolvePlayer, spawnEdges, spawnIndex, populate };
}
