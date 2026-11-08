export const ORIGIN = { lon: -114.0719, lat: 51.0458 };
const M = (Math.PI * 6371008.8) / 180;
export function project(lon, lat) {
  return [(lon - ORIGIN.lon) * M * Math.cos((ORIGIN.lat * Math.PI) / 180), (ORIGIN.lat - lat) * M];
}
export function unproject(x, z) {
  return [ORIGIN.lon + x / (M * Math.cos((ORIGIN.lat * Math.PI) / 180)), ORIGIN.lat - z / M];
}
export function bounds(ring) {
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}
export function inside(x, z, ring) {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}
export function inPolygon(x, z, poly) {
  if (!inside(x, z, poly.ring)) return false;
  const holes = poly.holes;
  if (holes) for (let i = 0; i < holes.length; i++) if (i in holes && inside(x, z, holes[i])) return false;
  return true;
}
export function nearestOnSegment(x, z, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  const px = a[0] + dx * t,
    pz = a[1] + dz * t;
  return { x: px, z: pz, t, distance: Math.hypot(x - px, z - pz) };
}
export class SpatialIndex {
  constructor(size = 80) {
    this.size = size;
    this.cells = new Map();
  }
  insert(item, box) {
    for (let x = Math.floor(box.minX / this.size); x <= Math.floor(box.maxX / this.size); x++)
      for (let z = Math.floor(box.minZ / this.size); z <= Math.floor(box.maxZ / this.size); z++) {
        const key = `${x},${z}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(item);
      }
  }
  near(x, z, radius = 0) {
    const minX = Math.floor((x - radius) / this.size),
      maxX = Math.floor((x + radius) / this.size),
      minZ = Math.floor((z - radius) / this.size),
      maxZ = Math.floor((z + radius) / this.size);
    if (minX === maxX && minZ === maxZ) return new Set(this.cells.get(`${minX},${minZ}`));
    const found = new Set();
    for (let gx = minX; gx <= maxX; gx++)
      for (let gz = minZ; gz <= maxZ; gz++) {
        const bucket = this.cells.get(`${gx},${gz}`);
        if (bucket) for (const item of bucket) found.add(item);
      }
    return found;
  }
}
export const DRIVABLE = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'residential',
  'unclassified',
  'living_street',
  'service',
]);
export function roadWidth(road) {
  if (Number.isFinite(road.width) && road.width >= 0.3 && road.width <= 40) return road.width;
  if (!DRIVABLE.has(road.kind)) return road.kind === 'cycleway' ? 3 : 2.2;
  return Math.max(
    road.kind === 'service' ? 4 : 6,
    Math.min(
      24,
      (Number(road.lanes) ||
        Number(road.inferredLanes) ||
        (['primary', 'secondary', 'trunk'].includes(road.kind) ? 4 : 2)) * 3.2,
    ),
  );
}
export function makeRoadIndex(roads) {
  const index = new SpatialIndex(80),
    segments = [];
  for (const road of roads) {
    if (road.tunnel) continue;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1],
        b = road.points[i];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.2) continue;
      const s = { a, b, road, width: roadWidth(road) };
      segments.push(s);
      index.insert(s, bounds([a, b]));
    }
  }
  const nearest = (x, z, driveOnly = false, radius = 120, namedStreet = false) => {
    let best = null,
      bestX,
      bestZ,
      bestT,
      bestDistance,
      rejectionLimit = Infinity;
    for (const s of index.near(x, z, radius)) {
      if (driveOnly && (!DRIVABLE.has(s.road.kind) || s.road.transitOnly)) continue;
      if (namedStreet && (!s.road.name || s.road.kind === 'service')) continue;
      const dx = s.b[0] - s.a[0],
        dz = s.b[1] - s.a[1],
        t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / (dx * dx + dz * dz || 1))),
        px = s.a[0] + dx * t,
        pz = s.a[1] + dz * t,
        offsetX = x - px,
        offsetZ = z - pz;
      // Keep near ties on the original norm calculation while rejecting
      // farther candidates without a costly hypot for every source edge.
      if (best && offsetX * offsetX + offsetZ * offsetZ > rejectionLimit) continue;
      const distance = Math.hypot(offsetX, offsetZ);
      if (!best || distance < bestDistance) {
        best = s;
        bestX = px;
        bestZ = pz;
        bestT = t;
        bestDistance = distance;
        rejectionLimit = distance * distance * (1 + 16 * Number.EPSILON);
      }
    }
    return best ? { x: bestX, z: bestZ, t: bestT, distance: bestDistance, ...best } : null;
  };
  return { index, segments, nearest };
}
export function makeRoadGraph(roads, allowTunnel = () => false) {
  const nodes = new Map(),
    edges = [];
  const key = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const add = (a, b, road) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1) return;
    const edge = {
      a,
      b,
      road,
      length,
      key: key(a),
      end: key(b),
      heading: Math.atan2(b[0] - a[0], b[1] - a[1]),
    };
    if (!nodes.has(edge.key)) nodes.set(edge.key, []);
    nodes.get(edge.key).push(edge);
    edges.push(edge);
  };
  for (const road of roads)
    if (
      DRIVABLE.has(road.kind) &&
      road.kind !== 'service' &&
      (!road.tunnel || allowTunnel(road)) &&
      !road.transitOnly
    ) {
      for (let i = 1; i < road.points.length; i++) {
        if (road.oneway !== '-1') add(road.points[i - 1], road.points[i], road);
        if (!road.oneway || road.oneway === 'no' || road.oneway === '-1')
          add(road.points[i], road.points[i - 1], road);
      }
    }
  return { nodes, edges };
}
export function seeded(seed = 42) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
