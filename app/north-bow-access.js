import { DRIVABLE, bounds, roadWidth } from './geo.js';

const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const key = (p) => `${p[0]},${p[1]}`;
const pointAt = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const ease = (t) => {
  const u = clamp(t),
    f = 0.1;
  return u < f
    ? (u * u) / (2 * f * (1 - f))
    : u > 1 - f
      ? 1 - (1 - u) ** 2 / (2 * f * (1 - f))
      : (u - f / 2) / (1 - f);
};

/** Small source-node bank attachment field, independent of bridge/deck layers.
 * Only actual connected ground paths carry it; no XY-distance propagation over
 * a crossing, carriageway, water or unrelated source way is permitted.
 */
export function createNorthBowAccess(
  data,
  { roadIndex, seeds, groundHeightAt, profiles = [], maxGrade = 0.08, pieceLength = 1.6 },
) {
  const nodes = new Map(),
    edges = [],
    fields = [],
    byRoad = new Map();
  const supportedKinds = new Set(['footway', 'cycleway', 'path', 'pedestrian']),
    profileEdges = new Map();
  for (const profile of profiles)
    for (let i = 1; i < profile.samples.length; i++) {
      const a = profile.samples[i - 1],
        b = profile.samples[i];
      profileEdges.set(`${profile.roadId}:${key(a.point)}:${key(b.point)}`, [a.height, b.height]);
      profileEdges.set(`${profile.roadId}:${key(b.point)}:${key(a.point)}`, [b.height, a.height]);
    }
  const node = (point) => {
    const id = key(point);
    if (!nodes.has(id)) nodes.set(id, { id, point, edges: [] });
    return nodes.get(id);
  };
  const candidates = new Set();
  for (const seed of seeds)
    for (const segment of roadIndex.index.near(...seed.point, 45)) candidates.add(segment);
  for (const segment of candidates) {
    const road = segment.road;
    if (
      DRIVABLE.has(road.kind) ||
      !supportedKinds.has(road.kind) ||
      road.bridge ||
      road.tunnel ||
      Number(road.layer || 0) !== 0
    )
      continue;
    const length = distance(segment.a, segment.b);
    if (length < 0.01) continue;
    const a = node(segment.a),
      b = node(segment.b);
    const edge = { ...segment, aNode: a, bNode: b, length };
    a.edges.push(edge);
    b.edges.push(edge);
    edges.push(edge);
  }
  for (const seed of seeds) {
    const start = nodes.get(key(seed.point)),
      rise = seed.height - groundHeightAt(...seed.point);
    if (!start || rise < 0.03) continue;
    const radius = rise / (maxGrade * 0.9),
      distances = new Map([[start.id, 0]]),
      pending = [{ node: start, distance: 0 }];
    while (pending.length) {
      pending.sort((a, b) => b.distance - a.distance);
      const current = pending.pop();
      if (current.distance !== distances.get(current.node.id) || current.distance >= radius) continue;
      for (const edge of current.node.edges) {
        const next = edge.aNode === current.node ? edge.bNode : edge.aNode,
          d = current.distance + edge.length;
        if (d >= radius || d >= (distances.get(next.id) ?? Infinity)) continue;
        distances.set(next.id, d);
        pending.push({ node: next, distance: d });
      }
    }
    fields.push({ ...seed, rise, radius, distances });
  }
  const offsetAt = (edge, t) => {
    let height = 0;
    for (const field of fields) {
      const d = Math.min(
        (field.distances.get(edge.aNode.id) ?? Infinity) + t * edge.length,
        (field.distances.get(edge.bNode.id) ?? Infinity) + (1 - t) * edge.length,
      );
      height = Math.max(height, field.rise * ease(1 - d / field.radius));
    }
    return height;
  };
  const intervals = (edge) => {
    if (profileEdges.has(`${edge.road.id}:${edge.aNode.id}:${edge.bNode.id}`)) return [[0, 1]];
    const ranges = [];
    for (const field of fields) {
      const da = field.distances.get(edge.aNode.id),
        db = field.distances.get(edge.bNode.id);
      if (da != null && da < field.radius) ranges.push([0, Math.min(1, (field.radius - da) / edge.length)]);
      if (db != null && db < field.radius)
        ranges.push([Math.max(0, 1 - (field.radius - db) / edge.length), 1]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1] + 1e-10) previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range]);
    }
    return merged;
  };
  const segments = [],
    cuts = new Map(),
    sourceArcs = new Map(),
    sourceNormals = new Map();
  for (const edge of edges) {
    const ranges = intervals(edge);
    if (!ranges.length) continue;
    const road = edge.road;
    if (!sourceArcs.has(road.id)) {
      const arcs = [0];
      for (let i = 1; i < road.points.length; i++)
        arcs.push(arcs.at(-1) + distance(road.points[i - 1], road.points[i]));
      sourceArcs.set(road.id, arcs);
      sourceNormals.set(
        road.id,
        road.points.map((p, i) => {
          const prev = road.points[Math.max(0, i - 1)],
            next = road.points[Math.min(road.points.length - 1, i + 1)];
          let ax = p[0] - prev[0],
            az = p[1] - prev[1],
            bx = next[0] - p[0],
            bz = next[1] - p[1];
          const al = Math.hypot(ax, az),
            bl = Math.hypot(bx, bz);
          if (al) {
            ax /= al;
            az /= al;
          } else {
            ax = bx / bl;
            az = bz / bl;
          }
          if (bl) {
            bx /= bl;
            bz /= bl;
          } else {
            bx = ax;
            bz = az;
          }
          let nx = -(az + bz),
            nz = ax + bx,
            l = Math.hypot(nx, nz);
          if (l < 1e-9) {
            nx = -az;
            nz = ax;
            l = 1;
          }
          nx /= l;
          nz /= l;
          const factor = Math.min(1.6, 1 / Math.max(0.35, nx * -az + nz * ax));
          return [nx * factor, nz * factor];
        }),
      );
    }
    const index = road.points.findIndex(
      (p, i) => i < road.points.length - 1 && p === edge.a && road.points[i + 1] === edge.b,
    );
    if (index < 0) throw new Error('Bank access edge must retain the exact source-road vertices');
    if (!cuts.has(road.id)) cuts.set(road.id, []);
    for (const [from, to] of ranges) {
      const start = sourceArcs.get(road.id)[index];
      cuts.get(road.id).push([start + from * edge.length, start + to * edge.length]);
      const count = Math.max(1, Math.ceil(((to - from) * edge.length) / pieceLength));
      for (let j = 0; j < count; j++) {
        const t0 = from + ((to - from) * j) / count,
          t1 = from + ((to - from) * (j + 1)) / count;
        const a = pointAt(edge.a, edge.b, t0),
          b = pointAt(edge.a, edge.b, t1);
        const profile = profileEdges.get(`${road.id}:${edge.aNode.id}:${edge.bNode.id}`),
          height = (point, t) =>
            Math.max(
              groundHeightAt(...point) + offsetAt(edge, t),
              profile ? profile[0] + (profile[1] - profile[0]) * t : -Infinity,
            ),
          h0 = height(a, t0),
          h1 = height(b, t1);
        const half = roadWidth(road) / 2,
          normals = sourceNormals.get(road.id),
          na = pointAt(normals[index], normals[index + 1], t0),
          nb = pointAt(normals[index], normals[index + 1], t1);
        const top = [
          [a[0] - na[0] * half, h0, a[1] - na[1] * half],
          [b[0] - nb[0] * half, h1, b[1] - nb[1] * half],
          [b[0] + nb[0] * half, h1, b[1] + nb[1] * half],
          [a[0] + na[0] * half, h0, a[1] + na[1] * half],
        ];
        const s = {
          a,
          b,
          h0,
          h1,
          top,
          width: half * 2,
          road,
          bankAccess: true,
          sourceArc0: start + t0 * edge.length,
          sourceArc1: start + t1 * edge.length,
        };
        segments.push(s);
        if (!byRoad.has(road.id)) byRoad.set(road.id, []);
        byRoad.get(road.id).push(s);
      }
    }
  }
  for (const ranges of cuts.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length;)
      if (ranges[i][0] <= ranges[i - 1][1] + 1e-8) {
        ranges[i - 1][1] = Math.max(ranges[i - 1][1], ranges[i][1]);
        ranges.splice(i, 1);
      } else i++;
  }
  const sample = (road, arcs, target) => {
    for (let i = 1; i < arcs.length; i++)
      if (arcs[i] >= target - 1e-8)
        return pointAt(
          road.points[i - 1],
          road.points[i],
          clamp((target - arcs[i - 1]) / (arcs[i] - arcs[i - 1])),
        );
    return [...road.points.at(-1)];
  };
  const unownedRuns = (road) => {
    const ranges = cuts.get(road.id);
    if (!ranges) return [road.points];
    const arcs = sourceArcs.get(road.id),
      length = arcs.at(-1),
      residual = [],
      result = [];
    let at = 0;
    for (const [from, to] of ranges) {
      if (from > at + 1e-7) residual.push([at, from]);
      at = Math.max(at, to);
    }
    if (at < length - 1e-7) residual.push([at, length]);
    for (const [from, to] of residual)
      result.push([
        sample(road, arcs, from),
        ...road.points.filter((_p, i) => arcs[i] > from + 1e-8 && arcs[i] < to - 1e-8),
        sample(road, arcs, to),
      ]);
    return result;
  };
  const fullyOwned = new Set(
    [...cuts.keys()].filter((id) => {
      const ranges = cuts.get(id),
        length = sourceArcs.get(id).at(-1);
      return ranges.length === 1 && ranges[0][0] < 1e-8 && ranges[0][1] > length - 1e-8;
    }),
  );
  return {
    segments,
    cuts,
    byRoad,
    fields,
    fullyOwned,
    unownedRuns,
    bounds: segments.length ? bounds(segments.flatMap((s) => s.top.map((p) => [p[0], p[2]]))) : null,
    sourceLength: [...cuts.values()].flat().reduce((n, [a, b]) => n + b - a, 0),
  };
}
