import { bounds, DRIVABLE, nearestOnSegment, roadWidth, SpatialIndex } from './geo.js';

// These shared source nodes were checked against the bundled OSM geometry.
// Heights/grades adapt their mapped access to the existing flat-city decks;
// they are not a measured vertical survey or an accessibility certification.
export const BRIDGE_ACCESS_SOURCES = Object.freeze([
  Object.freeze({
    parent: 'George C. King Bridge',
    roadId: 'osm-way-779639382-0',
    sharedNode: '2404084679',
    anchor: Object.freeze([1757.1, -295.1]),
    sourceIncline: 'down',
  }),
  Object.freeze({
    parent: "Prince's Island Bridge",
    roadId: 'osm-way-420030817-0',
    sharedNode: '2371879891',
    anchor: Object.freeze([181, -1285.4]),
  }),
  Object.freeze({
    parent: "Prince's Island Bridge",
    roadId: 'osm-way-584509001-0',
    sharedNode: '2371879891',
    anchor: Object.freeze([181, -1285.4]),
  }),
]);

export const BRIDGE_ACCESS_LIMITS = Object.freeze({
  maxGrade: 0.12,
  maxBlendLength: 120,
  maxSegments: 1400,
  stepUp: 0.65,
  segmentLength: 2.5,
  easeFraction: 0.1,
  ground: 0.14,
});

const key = (p) => `${p[0]},${p[1]}`,
  lengthOf = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),
  clamp = (v, a, b) => Math.max(a, Math.min(b, v)),
  lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function createBridgeAccessBranches(data, context = {}) {
  const plans = context.plans || [],
    roadIndex = context.roadIndex,
    heightAt = context.heightAt || ((p) => p.level),
    groundAt = context.pathGroundHeight || (() => BRIDGE_ACCESS_LIMITS.ground),
    roads = new Map((data.roads || []).map((r) => [r.id, r])),
    nodes = new Map(),
    fields = [],
    segments = [],
    byRoad = new Map(),
    seedIds = new Set(),
    index = new SpatialIndex(40),
    unresolved = [];
  const node = (p) => {
    const id = key(p);
    if (!nodes.has(id)) nodes.set(id, { id, point: p, edges: [] });
    return nodes.get(id);
  };
  for (const edge of roadIndex?.segments || []) {
    const r = edge.road;
    if (DRIVABLE.has(r.kind) || r.tunnel || ['corridor', 'steps'].includes(r.kind)) continue;
    if (!['footway', 'cycleway', 'path', 'pedestrian'].includes(r.kind)) continue;
    const a = node(edge.a),
      b = node(edge.b),
      length = lengthOf(edge.a, edge.b);
    if (length < 0.01) continue;
    const value = { ...edge, aNode: a, bNode: b, length };
    a.edges.push(value);
    b.edges.push(value);
  }

  for (const definition of BRIDGE_ACCESS_SOURCES) {
    const road = roads.get(definition.roadId),
      plan = plans.find((p) => p.name === definition.parent);
    if (!road || !plan) continue;
    const anchor = nodes.get(key(definition.anchor)),
      sourceLength = road.points.slice(1).reduce((n, b, i) => n + lengthOf(road.points[i], b), 0);
    let distance = 0,
      at = null;
    for (let i = 1; i < plan.points.length; i++) {
      const q = nearestOnSegment(...definition.anchor, plan.points[i - 1], plan.points[i]),
        length = lengthOf(plan.points[i - 1], plan.points[i]);
      if (q.distance < 0.01) at = (distance + q.t * length) / plan.length;
      distance += length;
    }
    const first = anchor?.edges.find((e) => e.road.id === road.id);
    if (!anchor || at === null || !first || !road.bridge) {
      unresolved.push({ roadId: road.id, reason: 'Expected source bridge/shared anchor missing' });
      continue;
    }
    const next = first.aNode === anchor ? first.bNode : first.aNode,
      dx = (next.point[0] - anchor.point[0]) / first.length,
      dz = (next.point[1] - anchor.point[1]) / first.length;
    let tangent = null;
    for (let i = 1; i < plan.points.length; i++) {
      const a = plan.points[i - 1],
        b = plan.points[i],
        q = nearestOnSegment(...anchor.point, a, b),
        length = lengthOf(a, b);
      if (q.distance < 0.01) tangent = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    }
    const sine = Math.abs(dx * tangent[1] - dz * tangent[0]),
      plateau = (plan.width / 2 + 0.35) / Math.max(0.35, sine),
      startHeight = heightAt(plan, at),
      endpoint = road.points.find((p) => lengthOf(p, definition.anchor) > 0.01) || next.point,
      ground = groundAt(...endpoint),
      minimum =
        plateau +
        Math.abs(startHeight - ground) /
          ((1 - BRIDGE_ACCESS_LIMITS.easeFraction) * BRIDGE_ACCESS_LIMITS.maxGrade) +
        0.25,
      blendLength = Math.max(sourceLength, minimum);
    if (blendLength > BRIDGE_ACCESS_LIMITS.maxBlendLength || !Number.isFinite(ground + startHeight)) {
      unresolved.push({ roadId: road.id, reason: 'Required blend exceeds bounded supported length' });
      continue;
    }
    const field = {
      ...definition,
      plan,
      at,
      startHeight,
      sourceLength,
      plateau,
      blendLength,
      segments: [],
      roadIds: new Set(),
    };
    // Open only the side reached by this actual shared-node branch. Express
    // the opening in the parent's existing distance parameter so rendering,
    // fine balustrades, light inserts and collision can use the same cuts.
    const side = Math.sign(-tangent[1] * dx + tangent[0] * dz),
      along = ((plan.width / 2 - 0.1) / Math.max(0.35, sine)) * (tangent[0] * dx + tangent[1] * dz),
      halfOpening = (roadWidth(road) / 2 + 0.5) / Math.max(0.35, sine),
      centreDistance = at * plan.length + along;
    plan.accessOpenings ||= [];
    plan.accessOpenings.push({
      side,
      from: clamp((centreDistance - halfOpening) / plan.length, 0, 1),
      to: clamp((centreDistance + halfOpening) / plan.length, 0, 1),
      roadId: road.id,
    });
    fields.push(field);
    seedIds.add(road.id);
    const distances = new Map([[anchor, 0]]),
      queue = [anchor],
      reached = new Set();
    while (queue.length) {
      queue.sort((a, b) => distances.get(b) - distances.get(a));
      const current = queue.pop(),
        d = distances.get(current);
      if (d >= blendLength) continue;
      for (const edge of current.edges) {
        const r = edge.road;
        if (r.bridge ? r.id !== road.id : Number(r.layer) > 0) continue;
        if (current === anchor && r.id !== road.id) continue;
        reached.add(edge);
        const other = edge.aNode === current ? edge.bNode : edge.aNode,
          nextDistance = d + edge.length;
        if (nextDistance >= (distances.get(other) ?? Infinity)) continue;
        distances.set(other, nextDistance);
        if (nextDistance < blendLength) queue.push(other);
      }
    }
    const height = (d, p) => {
      const u = clamp((d - plateau) / (blendLength - plateau), 0, 1),
        f = BRIDGE_ACCESS_LIMITS.easeFraction,
        eased =
          u < f
            ? (u * u) / (2 * f * (1 - f))
            : u > 1 - f
              ? 1 - (1 - u) ** 2 / (2 * f * (1 - f))
              : (u - f / 2) / (1 - f),
        localGround = groundAt(...p);
      return startHeight + (localGround - startHeight) * eased;
    };
    for (const edge of reached) {
      const da = distances.get(edge.aNode) ?? Infinity,
        db = distances.get(edge.bNode) ?? Infinity,
        distanceAt = (t) => Math.min(da + edge.length * t, db + edge.length * (1 - t)),
        pieces = Math.max(1, Math.ceil(edge.length / BRIDGE_ACCESS_LIMITS.segmentLength)),
        cuts = Array.from({ length: pieces + 1 }, (_, i) => i / pieces);
      for (const d of [plateau, blendLength])
        for (const t of [(d - da) / edge.length, 1 - (d - db) / edge.length])
          if (t > 0 && t < 1) cuts.push(t);
      cuts.sort((a, b) => a - b);
      for (let i = 1; i < cuts.length; i++) {
        const lo = cuts[i - 1],
          hi = cuts[i];
        if (hi - lo < 1e-7 || distanceAt((lo + hi) / 2) >= blendLength) continue;
        if (segments.length >= BRIDGE_ACCESS_LIMITS.maxSegments)
          throw new Error('Bridge access segment budget exceeded');
        const a = lerp(edge.a, edge.b, lo),
          b = lerp(edge.a, edge.b, hi),
          segment = {
            a,
            b,
            h0: height(distanceAt(lo), a),
            h1: height(distanceAt(hi), b),
            road: edge.road,
            width: roadWidth(edge.road),
            sourceA: edge.a,
            sourceB: edge.b,
            d0: distanceAt(lo),
            d1: distanceAt(hi),
            ramp: true,
            branch: true,
            accessBranch: true,
            field,
            plan,
          };
        field.segments.push(segment);
        field.roadIds.add(edge.road.id);
        segments.push(segment);
        index.insert(segment, bounds([a, b]));
        if (!byRoad.has(edge.road.id)) byRoad.set(edge.road.id, []);
        byRoad.get(edge.road.id).push(segment);
      }
    }
  }
  const selectedRoads = new Set([...byRoad.keys()]),
    branchRoadIndex = {
      index: new SpatialIndex(40),
      segments: (roadIndex?.segments || []).filter((s) => selectedRoads.has(s.road.id)),
    };
  for (const edge of branchRoadIndex.segments) branchRoadIndex.index.insert(edge, bounds([edge.a, edge.b]));
  const query = (x, z, road, hint) => {
    let best = null;
    for (const s of road ? byRoad.get(road.id) || [] : index.near(x, z, 4)) {
      const dx = s.b[0] - s.a[0],
        dz = s.b[1] - s.a[1],
        rawT = ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / (dx * dx + dz * dz),
        q = nearestOnSegment(x, z, s.a, s.b);
      if (rawT < -0.0001 || rawT > 1.0001 || q.distance > s.width / 2 + 0.12) continue;
      const y = s.h0 + (s.h1 - s.h0) * q.t;
      if (Number.isFinite(hint) && y > hint + BRIDGE_ACCESS_LIMITS.stepUp) continue;
      const priority = Number.isFinite(hint)
        ? hint - y > 0.75
          ? 1000 + (hint - y) * 100 + q.distance * 0.01
          : q.distance + Math.abs(y - hint) * 0.01
        : q.distance;
      if (!best || priority < best.priority) best = { height: y, priority };
    }
    return best?.height ?? null;
  };
  const remainderCache = new Map(),
    unownedRuns = (road) => {
      if (!byRoad.has(road.id)) return [road.points];
      if (seedIds.has(road.id)) return [];
      if (remainderCache.has(road.id)) return remainderCache.get(road.id);
      const cumulative = [0];
      for (let i = 1; i < road.points.length; i++)
        cumulative.push(cumulative[i - 1] + lengthOf(road.points[i - 1], road.points[i]));
      const along = (p, a, b) => {
        for (let i = 1; i < road.points.length; i++) {
          if (key(a) !== key(road.points[i - 1]) || key(b) !== key(road.points[i])) continue;
          return cumulative[i - 1] + nearestOnSegment(...p, a, b).t * lengthOf(a, b);
        }
        throw new Error(`Access source edge missing from ${road.id}`);
      };
      const occupied = (byRoad.get(road.id) || [])
          .map((s) =>
            [along(s.a, s.sourceA, s.sourceB), along(s.b, s.sourceA, s.sourceB)].sort((a, b) => a - b),
          )
          .sort((a, b) => a[0] - b[0]),
        merged = [];
      for (const [a, b] of occupied)
        if (merged.length && a <= merged.at(-1)[1] + 1e-6) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b);
        else merged.push([a, b]);
      const pointAt = (d) => {
          for (let i = 1; i < cumulative.length; i++)
            if (d <= cumulative[i] + 1e-7)
              return lerp(
                road.points[i - 1],
                road.points[i],
                clamp((d - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1]), 0, 1),
              );
          return road.points.at(-1).slice();
        },
        ranges = [];
      let cursor = 0;
      for (const [a, b] of merged) {
        if (a > cursor + 1e-6) ranges.push([cursor, a]);
        cursor = Math.max(cursor, b);
      }
      if (cursor < cumulative.at(-1) - 1e-6) ranges.push([cursor, cumulative.at(-1)]);
      const runs = ranges
        .filter(([a, b]) => b - a > 0.01)
        .map(([a, b]) => [
          pointAt(a),
          ...road.points.filter((_, i) => cumulative[i] > a + 1e-6 && cumulative[i] < b - 1e-6),
          pointAt(b),
        ]);
      remainderCache.set(road.id, runs);
      return runs;
    };
  return {
    fields,
    segments,
    byRoad,
    seedIds,
    roadIndex: branchRoadIndex,
    ownsRoad: (road) => seedIds.has(road?.id),
    ownsApproach: (road) => byRoad.has(road?.id),
    unownedRuns,
    surfaceHeight: (x, z, road) => query(x, z, road),
    groundHeight: (x, z, hint) => query(x, z, undefined, hint),
    stats: {
      fields: fields.length,
      roads: byRoad.size,
      segments: segments.length,
      maxGrade: Math.max(0, ...segments.map((s) => Math.abs(s.h1 - s.h0) / lengthOf(s.a, s.b))),
      unresolved,
    },
  };
}
