import { nearestOnSegment, SpatialIndex } from './geo.js';

export const TRANSIT_LIMITS = Object.freeze({
  fleet: 8,
  balancedVisible: 4,
  highVisible: 6,
  balancedRadius: 1100,
  highRadius: 1700,
  cars: 4,
  carLength: 25.8,
  carWidth: 2.65,
  carSpacing: 26.2,
  floorAboveRail: 0.982,
  railHeadAboveDeck: 0.218,
  acceleration: 0.95,
  braking: 1.35,
  emergencyBraking: 3.2,
  maxSpeed: 16.6,
  downtownSpeed: 10,
  dwellSeconds: 18,
  followingGap: 12,
  crossingLeadSeconds: 10,
  policyInterval: 0.1,
  balancedPlatforms: 8,
  highPlatforms: 12,
});
export const TRAIN_BACK =
  (TRANSIT_LIMITS.cars - 1) * TRANSIT_LIMITS.carSpacing + TRANSIT_LIMITS.carLength / 2;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function prepareTransitRoute(source) {
  const lengths = [],
    cumulative = [0],
    index = new SpatialIndex(120);
  for (let i = 1; i < source.points.length; i++) {
    const a = source.points[i - 1],
      b = source.points[i],
      length = Math.hypot(b[0] - a[0], b[1] - a[1]),
      segment = { a, b, length, start: cumulative.at(-1), index: i - 1, source: source.segments[i - 1] };
    lengths.push(length);
    cumulative.push(segment.start + length);
    index.insert(segment, {
      minX: Math.min(a[0], b[0]),
      maxX: Math.max(a[0], b[0]),
      minZ: Math.min(a[1], b[1]),
      maxZ: Math.max(a[1], b[1]),
    });
  }
  return {
    ...source,
    length: cumulative.at(-1),
    lengths,
    cumulative,
    index,
    stops: source.stops.map((stop) => ({
      ...stop,
      target: stop.distance + ((TRANSIT_LIMITS.cars - 1) * TRANSIT_LIMITS.carSpacing) / 2,
    })),
  };
}

export function transitPose(route, distance) {
  if (!route?.points?.length || distance < 0 || distance > route.length) return null;
  let lo = 0,
    hi = route.lengths.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (route.cumulative[mid + 1] < distance) lo = mid + 1;
    else hi = mid;
  }
  const a = route.points[lo],
    b = route.points[lo + 1],
    length = route.lengths[lo],
    t = clamp((distance - route.cumulative[lo]) / Math.max(length, 0.001), 0, 1),
    dx = (b[0] - a[0]) / length,
    dz = (b[1] - a[1]) / length;
  return {
    x: a[0] + (b[0] - a[0]) * t,
    z: a[1] + (b[1] - a[1]) * t,
    dx,
    dz,
    heading: Math.atan2(dx, dz),
    segment: route.segments[lo],
    index: lo,
    t,
  };
}

export function projectOnTransitRoute(route, x, z, radius = 15) {
  let best = null;
  for (const segment of route.index.near(x, z, radius)) {
    const p = nearestOnSegment(x, z, segment.a, segment.b);
    if (p.distance > radius || (best && p.distance >= best.lateral)) continue;
    best = {
      distance: segment.start + p.t * segment.length,
      lateral: p.distance,
      dx: (segment.b[0] - segment.a[0]) / segment.length,
      dz: (segment.b[1] - segment.a[1]) / segment.length,
      segment: segment.source,
      x: p.x,
      z: p.z,
    };
  }
  return best;
}

export function transitMotion(speed, desiredSpeed, stopDistance, dt) {
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1),
    current = Math.max(0, speed || 0),
    remaining = Number.isFinite(stopDistance) ? Math.max(0, stopDistance) : Infinity,
    desired = Math.max(0, Math.min(TRANSIT_LIMITS.maxSpeed, desiredSpeed || 0)),
    target = Math.min(desired, Math.sqrt(2 * TRANSIT_LIMITS.braking * remaining)),
    braking =
      current * current > 2 * TRANSIT_LIMITS.braking * remaining + 1
        ? TRANSIT_LIMITS.emergencyBraking
        : TRANSIT_LIMITS.braking;
  let next = current + clamp(target - current, -braking * step, TRANSIT_LIMITS.acceleration * step),
    distance = (current + next) * step * 0.5;
  if (distance >= remaining) {
    distance = remaining;
    next = 0;
  }
  if (next < 0.02 && target < 0.02) next = 0;
  return { speed: next, distance, target };
}

export function crossingActive(train, crossing) {
  if (train.route.id !== crossing.routeId) return false;
  const front = train.distance + TRANSIT_LIMITS.carLength / 2,
    rear = train.distance - TRAIN_BACK,
    distance = crossing.distance - front;
  return (
    (front >= crossing.distance - 7 && rear <= crossing.distance + 7) ||
    (distance > 0 && train.speed > 0.4 && distance / train.speed < TRANSIT_LIMITS.crossingLeadSeconds)
  );
}

// SAT/circle contact against one articulated section. No unbounded ejection or
// snapping to the other side of an entire train is permitted by this helper.
export function trainBodyContact(position, body, section, out = {}) {
  if (position.y >= section.y + 3.45 || position.y + (body.top ?? 1.9) <= section.y + 0.25) return false;
  const sin = Math.sin(section.heading),
    cos = Math.cos(section.heading),
    dx = position.x - section.x,
    dz = position.z - section.z,
    hx = TRANSIT_LIMITS.carWidth / 2,
    hz = 6.4;
  if (!body.car) {
    const x = dx * cos - dz * sin,
      z = dx * sin + dz * cos,
      vx = x - clamp(x, -hx, hx),
      vz = z - clamp(z, -hz, hz),
      distance = Math.hypot(vx, vz),
      radius = body.radius ?? 0.42;
    if (distance >= radius) return false;
    let nx, nz, depth;
    if (distance > 1e-8) {
      nx = vx / distance;
      nz = vz / distance;
      depth = radius - distance;
    } else if (hx - Math.abs(x) < hz - Math.abs(z)) {
      nx = Math.sign(x) || 1;
      nz = 0;
      depth = radius + hx - Math.abs(x);
    } else {
      nx = 0;
      nz = Math.sign(z) || 1;
      depth = radius + hz - Math.abs(z);
    }
    Object.assign(out, { nx: nx * cos + nz * sin, nz: -nx * sin + nz * cos, depth });
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
    [cos, -sin],
    [sin, cos],
  ]) {
    const a = Math.abs(nx * cosA - nz * sinA) * halfWidth + Math.abs(nx * sinA + nz * cosA) * halfLength,
      b = Math.abs(nx * cos - nz * sin) * hx + Math.abs(nx * sin + nz * cos) * hz,
      separation = dx * nx + dz * nz,
      overlap = a + b - Math.abs(separation);
    if (overlap <= 0) return false;
    if (overlap < depth) {
      depth = overlap;
      pushX = nx * (Math.sign(separation) || 1);
      pushZ = nz * (Math.sign(separation) || 1);
    }
  }
  Object.assign(out, { nx: pushX, nz: pushZ, depth });
  return true;
}

export function createTransitSimulation(source, context = {}) {
  const routes = source.routes.map(prepareTransitRoute),
    railById = new Map((context.rails || []).map((rail) => [rail.id, rail])),
    height = (pose) => context.surfaceHeight?.(pose.x, pose.z, railById.get(pose.segment.roadId)) ?? 0.18,
    trains = routes
      .flatMap((route, index) =>
        [0.37, 0.74].map((fraction, i) => {
          // Start an eastbound service near the Bow so an East Village visit
          // can catch the crossing soon after entering the city.
          const bridge =
            route.id === '202:0' && i === 1
              ? route.segments.findIndex((s) => s.bridge && s.roadId === 'osm-way-1343206809-0')
              : -1;
          const distance = bridge < 0 ? route.length * fraction : Math.max(0, route.cumulative[bridge] - 16);
          return {
            id: `${route.id}:train-${i}`,
            route,
            distance,
            speed: 7 + (index % 3),
            dwell: 0,
            nextStop: route.stops.findIndex((stop) => stop.target > distance + 2),
            policyClock: 0,
            stopDistance: Infinity,
            completedStops: 0,
            signalStops: 0,
            followingStops: 0,
            x: 0,
            y: 0,
            z: 0,
            sections: [],
          };
        }),
      )
      .slice(0, TRANSIT_LIMITS.fleet),
    crossings = context.crossings || [],
    sections = [],
    stats = {
      trains: trains.length,
      visibleTrains: 0,
      sections: 0,
      stopped: 0,
      dwelling: 0,
      completedStops: 0,
      policyQueries: 0,
      activeCrossings: 0,
      currentSpeed: 0,
    };

  function refreshSections() {
    sections.length = 0;
    for (const train of trains) {
      const center = transitPose(
        train.route,
        clamp(
          train.distance - ((TRANSIT_LIMITS.cars - 1) * TRANSIT_LIMITS.carSpacing) / 2,
          0,
          train.route.length,
        ),
      );
      Object.assign(train, { x: center.x, z: center.z, y: height(center), heading: center.heading });
      train.sections.length = 0;
      for (let car = 0; car < TRANSIT_LIMITS.cars; car++)
        for (const side of [1, -1]) {
          const distance = train.distance - car * TRANSIT_LIMITS.carSpacing + side * 6.45,
            pose = transitPose(train.route, distance);
          if (!pose || pose.segment.tunnel) continue;
          const y = height(pose);
          let pitch = 0;
          if (pose.segment.bridge || Math.abs(y - 0.18) > 0.02) {
            const beforeDistance = Math.max(0, distance - 6.2),
              afterDistance = Math.min(train.route.length, distance + 6.2),
              before = transitPose(train.route, beforeDistance),
              after = transitPose(train.route, afterDistance);
            if (before && after && afterDistance > beforeDistance)
              pitch = Math.atan2(height(after) - height(before), afterDistance - beforeDistance) * side;
          }
          const section = {
            ...pose,
            y,
            pitch,
            heading: pose.heading + (side < 0 ? Math.PI : 0),
            train,
            car,
            side,
            distance,
          };
          train.sections.push(section);
          sections.push(section);
        }
    }
    stats.sections = sections.length;
  }

  function obstacleDistance(train, state) {
    const frontDistance = train.distance + TRANSIT_LIMITS.carLength / 2;
    let result = Infinity;
    const objects = [
      state,
      ...(typeof context.traffic === 'function' ? context.traffic() : context.traffic || []),
    ];
    for (const object of objects) {
      if (!object || !Number.isFinite(object.x) || Math.hypot(object.x - train.x, object.z - train.z) > 160)
        continue;
      const projected = projectOnTransitRoute(train.route, object.x, object.z, object === state ? 2.1 : 2.6);
      if (!projected || projected.distance <= frontDistance - 1 || projected.segment.tunnel) continue;
      const pose = transitPose(train.route, projected.distance),
        y = height(pose);
      if (object.y > y + 3.5 || object.y + (object.mode === 'drive' || object.edge ? 1.7 : 1.9) < y + 0.25)
        continue;
      result = Math.min(
        result,
        Math.max(0, projected.distance - frontDistance - (object.mode === 'drive' || object.edge ? 3.5 : 2)),
      );
    }
    return result;
  }

  function control(train, state) {
    let stop = Infinity;
    const station = train.route.stops[train.nextStop];
    if (station && station.target >= train.distance - 0.1)
      stop = Math.min(stop, Math.max(0, station.target - train.distance));
    const front = transitPose(train.route, train.distance + TRANSIT_LIMITS.carLength / 2);
    if (front && !front.segment.tunnel) {
      const signal = context.signalAhead?.(
        front.x,
        front.z,
        front.heading,
        Math.max(100, train.speed ** 2 / (2 * TRANSIT_LIMITS.braking) + 25),
      );
      if (signal && (!signal.signal || Math.abs(signal.signal.y - height(front)) < 2)) {
        const available = signal.distance - 1.2;
        if (
          signal.state === 'red' ||
          (signal.state === 'amber' && available > train.speed ** 2 / (2 * TRANSIT_LIMITS.braking) + 2)
        ) {
          stop = Math.min(stop, Math.max(0, available));
          train.signalStops++;
        }
      }
      for (const other of trains) {
        if (other === train || Math.hypot(other.x - train.x, other.z - train.z) > 350) continue;
        const rear = transitPose(other.route, other.distance - TRAIN_BACK);
        if (!rear || rear.segment.tunnel || Math.abs(height(rear) - height(front)) > 2) continue;
        const onRoute = projectOnTransitRoute(train.route, rear.x, rear.z, 1);
        if (!onRoute || onRoute.dx * rear.dx + onRoute.dz * rear.dz < 0.8) continue;
        const gap =
          onRoute.distance - (train.distance + TRANSIT_LIMITS.carLength / 2) - TRANSIT_LIMITS.followingGap;
        if (gap > -3) {
          stop = Math.min(stop, Math.max(0, gap));
          train.followingStops++;
        }
      }
    }
    train.stopDistance = Math.min(stop, obstacleDistance(train, state));
    train.policyClock = TRANSIT_LIMITS.policyInterval;
    stats.policyQueries++;
  }

  function update(dt, state) {
    const delta = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    for (const train of trains) {
      train.policyClock -= delta;
      if (train.dwell > 0) {
        train.dwell = Math.max(0, train.dwell - delta);
        train.speed = 0;
        continue;
      }
      if (train.policyClock <= 0) control(train, state);
      const pose = transitPose(train.route, clamp(train.distance, 0, train.route.length)),
        downtown = pose && Math.abs(pose.z + 100) < 65 && pose.x > -1250 && pose.x < 1150,
        movement = transitMotion(
          train.speed,
          downtown ? TRANSIT_LIMITS.downtownSpeed : TRANSIT_LIMITS.maxSpeed,
          train.stopDistance,
          delta,
        );
      train.speed = movement.speed;
      train.distance += movement.distance;
      if (Number.isFinite(train.stopDistance))
        train.stopDistance = Math.max(0, train.stopDistance - movement.distance);
      const station = train.route.stops[train.nextStop];
      if (station && Math.abs(train.distance - station.target) < 0.12 && train.speed < 0.2) {
        train.distance = station.target;
        train.dwell = TRANSIT_LIMITS.dwellSeconds;
        train.speed = 0;
        train.nextStop++;
        train.completedStops++;
        train.policyClock = 0;
      }
      if (train.distance - TRAIN_BACK > train.route.length + 3) {
        train.distance = -TRANSIT_LIMITS.carLength / 2 - 2;
        train.speed = 7;
        train.nextStop = train.route.stops.findIndex((stop) => stop.target > train.distance);
        train.policyClock = 0;
      }
    }
    refreshSections();
    stats.activeCrossings = 0;
    for (const crossing of crossings) {
      crossing.active = trains.some((train) => crossingActive(train, crossing));
      if (crossing.active) stats.activeCrossings++;
    }
    stats.stopped = trains.filter((train) => train.speed < 0.2).length;
    stats.dwelling = trains.filter((train) => train.dwell > 0).length;
    stats.completedStops = trains.reduce((sum, train) => sum + train.completedStops, 0);
    stats.currentSpeed = Math.max(0, ...trains.map((train) => train.speed));
  }
  refreshSections();
  return { routes, trains, sections, crossings, stats, update, height, refreshSections };
}
