// Private, per-simulation scratch storage. Neither the pose nor the neighbours
// array may escape a synchronous traffic policy calculation.
function blendOffset(pose, other, lane, currentX, currentZ, amount, laneOffset) {
  const offset = laneOffset(other.road, lane),
    targetX = (-Math.cos(other.heading) * offset + currentX) * 0.5,
    targetZ = (Math.sin(other.heading) * offset + currentZ) * 0.5;
  const t = amount * amount * (3 - 2 * amount);
  pose.x += (targetX - currentX) * t;
  pose.z += (targetZ - currentZ) * t;
}

export function writeTrafficRoutePose(car, pose, laneOffset) {
  const edge = car.edge,
    offset = laneOffset(edge.road, car.lane),
    cos = Math.cos(edge.heading),
    sin = Math.sin(edge.heading),
    x = edge.a[0] + (edge.b[0] - edge.a[0]) * car.t,
    z = edge.a[1] + (edge.b[1] - edge.a[1]) * car.t,
    distance = car.t * edge.length,
    remaining = edge.length - distance,
    currentX = -cos * offset,
    currentZ = sin * offset,
    blend = Math.min(6, edge.length * 0.3);
  // Retain the original operation order, including subtraction and signed zero.
  pose.x = x - cos * offset;
  pose.z = z + sin * offset;
  pose.heading = edge.heading;
  if (car.previousEdge && distance < blend)
    blendOffset(pose, car.previousEdge, car.lane, currentX, currentZ, 1 - distance / blend, laneOffset);
  if (car.nextEdge && remaining < blend)
    blendOffset(pose, car.nextEdge, car.lane, currentX, currentZ, 1 - remaining / blend, laneOffset);
  return pose;
}

export function createTrafficFrameWorkspace(laneOffset) {
  const pose = { x: 0, z: 0, heading: 0 },
    neighbours = [],
    keysByOwner = new WeakMap();
  let seen = new WeakMap(),
    generation = 0,
    keyBuilds = 0,
    keyCacheHits = 0;
  return {
    pose(car) {
      return writeTrafficRoutePose(car, pose, laneOffset);
    },
    neighbours(index, x, z, radius, owner) {
      const size = index.size,
        loX = Math.floor((x - radius) / size),
        hiX = Math.floor((x + radius) / size),
        loZ = Math.floor((z - radius) / size),
        hiZ = Math.floor((z + radius) / size);
      let cached = keysByOwner.get(owner);
      if (
        !cached ||
        cached.index !== index ||
        cached.size !== size ||
        cached.loX !== loX ||
        cached.hiX !== hiX ||
        cached.loZ !== loZ ||
        cached.hiZ !== hiZ
      ) {
        const keys = [];
        for (let gx = loX; gx <= hiX; gx++) for (let gz = loZ; gz <= hiZ; gz++) keys.push(`${gx},${gz}`);
        cached = { index, size, loX, hiX, loZ, hiZ, keys };
        keysByOwner.set(owner, cached);
        keyBuilds++;
      } else keyCacheHits++;
      neighbours.length = 0;
      if (generation === Number.MAX_SAFE_INTEGER) {
        seen = new WeakMap();
        generation = 0;
      }
      generation++;
      for (const key of cached.keys) {
        // Cache only coordinates, never bucket contents. Cars move between
        // buckets even when this query's bounds remain completely unchanged.
        const cell = index.cells.get(key);
        if (!cell) continue;
        for (const car of cell)
          if (seen.get(car) !== generation) {
            seen.set(car, generation);
            neighbours.push(car);
          }
      }
      return neighbours;
    },
    get stats() {
      return { keyBuilds, keyCacheHits };
    },
  };
}
