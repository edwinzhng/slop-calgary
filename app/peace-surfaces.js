import { bounds, DRIVABLE, nearestOnSegment, project, roadWidth, SpatialIndex } from './geo.js';

export const PEACE_SURFACE_LIMITS = Object.freeze({
  level: 2.65,
  ground: 0.14,
  blendLength: 40,
  maxGrade: 0.085,
  stepUp: 0.65,
});
export const PEACE_ANCHORS = Object.freeze([
  project(-114.0794883, 51.0543154),
  project(-114.0783324, 51.0535117),
]);
// Clear lane widths from Calatrava’s 2012 architectural statement. The
// curb rise and short tapers are inferred from the interior photographs.
export const PEACE_WALKWAY = Object.freeze({
  width: 6.2,
  cycleWidth: 2.5,
  curbRise: 0.055,
  taper: 2,
  guardOffset: 3,
  railTop: PEACE_SURFACE_LIMITS.level + 1.04,
  railBase: PEACE_SURFACE_LIMITS.level + 0.17,
  crownLight: PEACE_SURFACE_LIMITS.level + 3.42,
});

export function peaceSidewalkRise(station, length) {
  return (
    PEACE_WALKWAY.curbRise *
    Math.max(0, Math.min(1, station / PEACE_WALKWAY.taper, (length - station) / PEACE_WALKWAY.taper))
  );
}

const lengthOf = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  key = (point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`,
  clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// The deck is adapted to the game's compressed bank elevations. Ease the
// approach into the existing paths without raising the rest of the plaza.
export function peaceAccessHeight(distance) {
  const u = clamp(distance / PEACE_SURFACE_LIMITS.blendLength, 0, 1),
    fraction = 0.25,
    eased =
      u < fraction
        ? (u * u) / (2 * fraction * (1 - fraction))
        : u > 1 - fraction
          ? 1 - (1 - u) ** 2 / (2 * fraction * (1 - fraction))
          : (u - fraction / 2) / (1 - fraction);
  return PEACE_SURFACE_LIMITS.level - (PEACE_SURFACE_LIMITS.level - PEACE_SURFACE_LIMITS.ground) * eased;
}

// The south plaza meets the bridge at full deck width and fans out onto
// the riverwalk. Every paved route shares this continuous land surface.
function createSouthLanding() {
  const [north, south] = PEACE_ANCHORS;
  const length = lengthOf(north, south);
  const dx = (south[0] - north[0]) / length,
    dz = (south[1] - north[1]) / length,
    step = 2,
    columns = 16,
    halfWidth = (distance) => PEACE_WALKWAY.width / 2 + Math.min(distance / 14, 1) * 12.5;
  const rows = Array.from({ length: 1 + PEACE_SURFACE_LIMITS.blendLength / step }, (_, row) => {
    const d = row * step;
    return Array.from({ length: columns + 1 }, (_, i) => {
      const side = (2 * i) / columns - 1,
        offset = side * halfWidth(d),
        edge = clamp((Math.abs(side) - 0.5) * 2, 0, 1) * Math.min(d / 6, 1),
        center = peaceAccessHeight(d),
        y = center + (PEACE_SURFACE_LIMITS.ground - center) * edge * edge;
      return [south[0] + d * dx - offset * dz, y, south[1] + d * dz + offset * dx];
    });
  });
  const local = ([x, z]) => [
    (x - south[0]) * dx + (z - south[1]) * dz,
    (z - south[1]) * dx - (x - south[0]) * dz,
  ];
  const trim = ([d, o]) => [
    d,
    PEACE_SURFACE_LIMITS.blendLength - d,
    halfWidth(14) - o,
    halfWidth(14) + o,
    halfWidth(0) + (d * 12.5) / 14 - o,
    halfWidth(0) + (d * 12.5) / 14 + o,
  ];
  return {
    rows,
    outsideRuns(points) {
      const box = bounds(points);
      if (
        box.minX > south[0] + 58 ||
        box.maxX < south[0] - 58 ||
        box.minZ > south[1] + 58 ||
        box.maxZ < south[1] - 58
      )
        return [points];
      const runs = [];
      let run = [points[0]],
        first = trim(local(points[0]));
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i],
          second = trim(local(b));
        let enter = 0,
          exit = 1;
        for (let j = 0; j < first.length; j++) {
          if (first[j] < 0 && second[j] < 0) {
            enter = 2;
            break;
          }
          if (first[j] < 0) enter = Math.max(enter, first[j] / (first[j] - second[j]));
          else if (second[j] < 0) exit = Math.min(exit, first[j] / (first[j] - second[j]));
        }
        if (enter >= exit) run.push(b);
        else {
          const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (enter > 1e-5) run.push(at(enter));
          if (run.length > 1) runs.push(run);
          run = exit < 1 - 1e-5 ? [at(exit), b] : [b];
        }
        first = second;
      }
      if (run.length > 1) runs.push(run);
      return runs;
    },
    heightAt(x, z) {
      const rx = x - south[0],
        rz = z - south[1],
        d = rx * dx + rz * dz,
        offset = -rx * dz + rz * dx;
      if (d < -0.0001 || d > PEACE_SURFACE_LIMITS.blendLength || Math.abs(offset) > halfWidth(d)) return null;
      const row = Math.max(0, Math.min(rows.length - 2, Math.floor(d / step))),
        cross = (0.5 + (0.5 * offset) / halfWidth(d)) * columns,
        col = Math.min(columns - 1, Math.floor(cross)),
        along = clamp(d / step - row, 0, 1),
        a = rows[row][col],
        b = rows[row][col + 1],
        c = rows[row + 1][col],
        e = rows[row + 1][col + 1],
        diagonal = (along * halfWidth((row + 1) * step)) / halfWidth(d),
        sideways = cross - col;
      return sideways < diagonal
        ? a[1] +
            (c[1] - a[1]) * along +
            ((e[1] - c[1]) * (sideways * halfWidth(d))) / halfWidth((row + 1) * step)
        : a[1] +
            (e[1] - b[1]) * along +
            (b[1] - a[1]) * (((sideways - diagonal) * halfWidth(d)) / halfWidth(row * step) + along);
    },
  };
}

export function createPeaceBridgeSurfaces(data, context = {}) {
  const deckRoads = (data.roads || []).filter(context.isPeaceBridgeRoad || (() => false)),
    roadIndex = context.roadIndex,
    nodes = new Map(),
    edges = [],
    byRoad = new Map(),
    surfaceIndex = new SpatialIndex(40);
  const node = (point) => {
    const id = key(point);
    if (!nodes.has(id)) nodes.set(id, { id, point, edges: [], distance: Infinity });
    return nodes.get(id);
  };
  if (!deckRoads.length)
    return {
      segments: [],
      junctions: [],
      ownsApproach: () => false,
      surfaceHeight: () => null,
      groundHeight: () => null,
      stats: { roads: 0, segments: 0, junctions: 0, maxGrade: 0, unresolvedEndpoints: [] },
    };
  const nearby = new Set();
  for (const anchor of PEACE_ANCHORS)
    for (const segment of roadIndex.index.near(...anchor, 100)) nearby.add(segment);
  for (const segment of nearby) {
    if (
      segment.road.bridge ||
      segment.road.tunnel ||
      DRIVABLE.has(segment.road.kind) ||
      ['corridor', 'steps'].includes(segment.road.kind)
    )
      continue;
    const a = node(segment.a),
      b = node(segment.b),
      length = lengthOf(segment.a, segment.b),
      edge = { ...segment, aNode: a, bNode: b, length };
    edges.push(edge);
    a.edges.push(edge);
    b.edges.push(edge);
  }
  const queue = [];
  for (const road of deckRoads)
    for (const point of [road.points[0], road.points.at(-1)]) {
      if (lengthOf(point, PEACE_ANCHORS[0]) >= 4) continue;
      const matching = nodes.get(key(point));
      if (matching && matching.distance !== 0) {
        matching.distance = 0;
        queue.push(matching);
      }
    }
  while (queue.length) {
    queue.sort((a, b) => b.distance - a.distance);
    const current = queue.pop();
    for (const edge of current.edges) {
      const other = edge.aNode === current ? edge.bNode : edge.aNode,
        candidate = current.distance + edge.length;
      if (candidate >= other.distance) continue;
      other.distance = candidate;
      if (candidate <= PEACE_SURFACE_LIMITS.blendLength + 150) queue.push(other);
    }
  }
  const segments = [];
  for (const edge of edges) {
    if (Math.min(edge.aNode.distance, edge.bNode.distance) >= PEACE_SURFACE_LIMITS.blendLength) continue;
    const at = (t) => [edge.a[0] + (edge.b[0] - edge.a[0]) * t, edge.a[1] + (edge.b[1] - edge.a[1]) * t],
      distanceAt = (t) =>
        Math.min(edge.aNode.distance + t * edge.length, edge.bNode.distance + (1 - t) * edge.length),
      parts = Math.max(1, Math.ceil(edge.length / 3)),
      cuts = Array.from({ length: parts + 1 }, (_, i) => i / parts);
    for (const t of [
      (PEACE_SURFACE_LIMITS.blendLength - edge.aNode.distance) / edge.length,
      1 - (PEACE_SURFACE_LIMITS.blendLength - edge.bNode.distance) / edge.length,
    ])
      if (t > 0 && t < 1) cuts.push(t);
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (
        cuts[i] - cuts[i - 1] < 1e-7 ||
        distanceAt((cuts[i] + cuts[i - 1]) / 2) >= PEACE_SURFACE_LIMITS.blendLength
      )
        continue;
      const segment = {
        a: at(cuts[i - 1]),
        b: at(cuts[i]),
        h0: peaceAccessHeight(distanceAt(cuts[i - 1])),
        h1: peaceAccessHeight(distanceAt(cuts[i])),
        d0: distanceAt(cuts[i - 1]),
        d1: distanceAt(cuts[i]),
        road: edge.road,
        ramp: true,
        width: roadWidth(edge.road),
        sourceA: edge.a,
        sourceB: edge.b,
      };
      segments.push(segment);
      surfaceIndex.insert(segment, bounds([segment.a, segment.b]));
      if (!byRoad.has(edge.road.id)) byRoad.set(edge.road.id, []);
      byRoad.get(edge.road.id).push(segment);
    }
  }
  const southLanding = createSouthLanding(),
    deckIds = new Set(deckRoads.map((road) => road.id)),
    a = PEACE_ANCHORS[0],
    b = PEACE_ANCHORS[1],
    dx = b[0] - a[0],
    dz = b[1] - a[1],
    squared = dx * dx + dz * dz,
    length = Math.sqrt(squared),
    query = (x, z, road, elevationHint) => {
      let best = null;
      const raw = ((x - a[0]) * dx + (z - a[1]) * dz) / squared,
        deck = nearestOnSegment(x, z, a, b),
        deckHeight =
          PEACE_SURFACE_LIMITS.level +
          (deck.distance >= PEACE_WALKWAY.cycleWidth / 2 ? peaceSidewalkRise(raw * length, length) : 0);
      if (
        (!road || deckIds.has(road.id)) &&
        raw >= 0 &&
        raw <= 1 &&
        deck.distance < PEACE_WALKWAY.width / 2 &&
        (!Number.isFinite(elevationHint) || deckHeight <= elevationHint + PEACE_SURFACE_LIMITS.stepUp)
      )
        return deckHeight;
      if (!road || (!road.bridge && !road.tunnel && !DRIVABLE.has(road.kind))) {
        const landing = southLanding.heightAt(x, z);
        if (
          landing !== null &&
          (!Number.isFinite(elevationHint) || landing <= elevationHint + PEACE_SURFACE_LIMITS.stepUp)
        )
          return landing;
      }
      for (const segment of road ? byRoad.get(road.id) || [] : surfaceIndex.near(x, z, 4)) {
        const p = nearestOnSegment(x, z, segment.a, segment.b),
          ux = segment.b[0] - segment.a[0],
          uz = segment.b[1] - segment.a[1],
          t = ((x - segment.a[0]) * ux + (z - segment.a[1]) * uz) / (ux * ux + uz * uz);
        if (p.distance > segment.width / 2 + 0.12 || (road && (t < -0.0001 || t > 1.0001))) continue;
        const height = segment.h0 + (segment.h1 - segment.h0) * p.t;
        if (Number.isFinite(elevationHint) && height > elevationHint + PEACE_SURFACE_LIMITS.stepUp) continue;
        if (!best || p.distance < best.distance) best = { height, distance: p.distance };
      }
      return best?.height ?? null;
    },
    junctions = [...nodes.values()]
      .filter((n) => n.distance < PEACE_SURFACE_LIMITS.blendLength && n.edges.length > 2)
      .map((n) => ({
        at: n.point.slice(),
        distance: n.distance,
        height: peaceAccessHeight(n.distance),
        roadIds: [...new Set(n.edges.map((edge) => edge.road.id))],
      })),
    unresolvedEndpoints = [...nodes.values()]
      .filter((n) => n.distance < PEACE_SURFACE_LIMITS.blendLength && n.distance > 0 && n.edges.length === 1)
      .map((n) => ({
        at: n.point.slice(),
        height: peaceAccessHeight(n.distance),
        roadId: n.edges[0].road.id,
      }));
  return {
    segments,
    junctions,
    byRoad,
    deckRoads,
    southLanding,
    ownsApproach: (road) => byRoad.has(road.id),
    surfaceHeight: (x, z, road) => query(x, z, road),
    groundHeight: (x, z, elevationHint) => query(x, z, undefined, elevationHint),
    stats: {
      roads: byRoad.size,
      segments: segments.length,
      junctions: junctions.length,
      maxGrade: Math.max(0, ...segments.map((s) => Math.abs(s.h1 - s.h0) / lengthOf(s.a, s.b))),
      unresolvedEndpoints,
    },
  };
}
