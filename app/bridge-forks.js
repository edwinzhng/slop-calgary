import { SpatialIndex, DRIVABLE } from './geo.js';
import { bridgeGuardOffset, BRIDGE_CONNECTION_LIMITS } from './bridge-connections.js';
import { bridgePathPoint, bridgeBand } from './bridge-path.js';
import { traversableHeight } from './movement-collision.js';

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

function mappedApproachJoin(plan, segment, band) {
  if (plan.drive || !segment.road.id || segment.road.bridge || segment.road.tunnel) return false;
  return [
    [plan.points[0], 0],
    [plan.points.at(-1), 1],
  ].some(([point, t]) => {
    if (
      (!samePoint(segment.a, point) && !samePoint(segment.b, point)) ||
      !segment.road.points.some((p) => samePoint(p, point)) ||
      !plan.roads.some((road) => road.points.some((p) => samePoint(p, point)))
    )
      return false;
    const height = band.heightAt(...point);
    return height !== null && Math.abs(height - plan.deck.heightAtStation(t, 0)) <= 0.08;
  });
}

function walkableApproachInterval(band, a, b, from, to) {
  for (const t of [from, to]) {
    const x = a[0] + (b[0] - a[0]) * t,
      y = a[1] + (b[1] - a[1]) * t,
      z = a[2] + (b[2] - a[2]) * t,
      height = band.heightAt(x, z);
    if (
      height === null ||
      !traversableHeight(height, y, 0, 'walk') ||
      !traversableHeight(y, height, 0, 'walk')
    )
      return false;
  }
  return true;
}

/** Open inferred rails where mapped deck or approach connections meet. */
export function connectBridgeForks(plans, { heightForApproach = (y) => y } = {}) {
  const nodes = new Map(),
    neighbours = new Map(),
    ownApproaches = new Set(),
    index = new SpatialIndex(32);
  for (const plan of plans) {
    plan.accessOpenings = (plan.accessOpenings || []).filter((o) => o.kind !== 'mapped-fork');
    if (plan.rail) continue;
    neighbours.set(plan, new Set());
    for (const road of plan.roads)
      for (let i = 0; i < road.points.length; i++) {
        const point = road.points[i],
          key = `${point[0]},${point[1]}`;
        if (!nodes.has(key)) nodes.set(key, []);
        nodes
          .get(key)
          .push({ plan, layer: Number(road.layer) || 0, endpoint: i === 0 || i === road.points.length - 1 });
      }
    for (const segment of plan.deck.segments)
      for (const surface of segment.paving) {
        if (surface.kind !== (plan.drive ? 'asphalt' : 'sidewalk')) continue;
        const b = surface.band.bounds;
        index.insert({ plan, band: surface.band }, b);
      }
    for (const s of plan.approaches || []) {
      if (s.accessBranch || !s.road || DRIVABLE.has(s.road.kind) !== plan.drive) continue;
      const width = plan.drive && !plan.compactShoulders ? Math.max(4, s.width - 4.2) : s.width;
      const band = bridgeBand(
        { points: [s.a, s.b] },
        0,
        1,
        -width / 2,
        width / 2,
        heightForApproach(s.h0, ...s.a),
        heightForApproach(s.h1, ...s.b),
      );
      const ownJoin = mappedApproachJoin(plan, s, band);
      if (ownJoin) ownApproaches.add(plan);
      index.insert({ plan, band, ownJoin }, band.bounds);
    }
  }
  for (const entries of nodes.values())
    for (let i = 0; i < entries.length; i++)
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i],
          b = entries[j];
        if (
          a.plan === b.plan ||
          a.plan.drive !== b.plan.drive ||
          a.layer !== b.layer ||
          !(a.endpoint || b.endpoint)
        )
          continue;
        neighbours.get(a.plan).add(b.plan);
        neighbours.get(b.plan).add(a.plan);
      }
  let openings = 0,
    affectedPlans = 0;
  for (const plan of plans) {
    const connected = neighbours.get(plan);
    if (!connected?.size && !ownApproaches.has(plan)) continue;
    let affected = false;
    for (const side of [-1, 1]) {
      const blocked = [];
      for (const segment of plan.deck.segments) {
        const { from, to } = segment,
          offset = side * bridgeGuardOffset(plan),
          a = bridgePathPoint(plan, from, offset, plan.deck.heightAtStation(from, offset)),
          b = bridgePathPoint(plan, to, offset, plan.deck.heightAtStation(to, offset)),
          x = (a[0] + b[0]) / 2,
          z = (a[2] + b[2]) / 2,
          radius = Math.hypot(b[0] - a[0], b[2] - a[2]) / 2;
        for (const other of index.near(x, z, radius)) {
          const ownApproach = other.plan === plan && other.ownJoin;
          if (!ownApproach && !connected?.has(other.plan)) continue;
          // At a sloping approach the rail crosses the path before its exact
          // deck-height joint. Keep that entry within the walking step limit.
          for (const [lo, hi] of other.band.clipSegment(a, b, ownApproach ? Infinity : 0.08)) {
            if (ownApproach && !walkableApproachInterval(other.band, a, b, lo, hi)) continue;
            blocked.push([from + (to - from) * lo, from + (to - from) * hi]);
          }
        }
      }
      blocked.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [from, to] of blocked) {
        const previous = merged.at(-1);
        // Do not leave an inferred rail stump narrower than its blocker
        // between a deck cut and its connected approach cut.
        if (previous && (from - previous[1]) * plan.length <= BRIDGE_CONNECTION_LIMITS.guardEnvelopeWidth)
          previous[1] = Math.max(previous[1], to);
        else merged.push([from, to]);
      }
      for (let [from, to] of merged) {
        if ((to - from) * plan.length < 0.01) continue;
        if (plan.compactShoulders && connected?.size) {
          // Don't strand a bumper-length post/rail fragment at the end of a
          // joined ramp after the overlapping drivable part has been cut.
          if (from * plan.length < 1.4) from = 0;
          if ((1 - to) * plan.length < 1.4) to = 1;
        }
        plan.accessOpenings.push({ from, to, side, kind: 'mapped-fork', inferred: true });
        openings++;
        affected = true;
      }
    }
    affectedPlans += Number(affected);
  }
  return { openings, affectedPlans };
}
