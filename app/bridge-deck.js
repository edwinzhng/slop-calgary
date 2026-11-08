import { bridgePath, bridgeBand } from './bridge-path.js';
import { nearestOnSegment } from './geo.js';
import { RAIL_PROFILE } from './rail-guideways.js';

const decks = new WeakMap();

function nearestBoundary(band, x, z) {
  const v = band.vertices,
    corners = [v[0], v[3], v[5], v[2]];
  let best = null;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i],
      b = corners[(i + 1) % corners.length],
      p = nearestOnSegment(x, z, [a[0], a[2]], [b[0], b[2]]);
    if (!best || p.distance < best.distance) best = p;
  }
  return best;
}

/** The inferred deck uses the same Float32 bands for drawing and support. */
export function createBridgeDeck(plan, heightAt, terrain = null) {
  const previous = decks.get(plan);
  if (previous?.terrain === terrain && previous.heightAt === heightAt) return previous.deck;
  const path = bridgePath(plan.points),
    segments = [],
    stations = [0],
    depth = plan.drive ? 0.48 : 0.26,
    localOffsetAt = terrain?.localOffsetAt || terrain?.offsetAt;
  const refine = (from, to, depth = 0) => {
    const a = heightAt(plan, from),
      b = heightAt(plan, to);
    const error = Math.max(
      ...[0.25, 0.5, 0.75].map((u) => Math.abs(heightAt(plan, from + (to - from) * u) - (a + (b - a) * u))),
    );
    if (error > 0.005 && depth < 10 && (to - from) * path.length > 0.05) {
      const middle = (from + to) / 2;
      refine(from, middle, depth + 1);
      refine(middle, to, depth + 1);
    } else stations.push(to);
  };
  for (let i = 1; i < path.stations.length; i++) refine(path.stations[i - 1], path.stations[i]);
  for (let i = 1; i < stations.length; i++) {
    const from = stations[i - 1],
      to = stations[i],
      a = path.sample(from),
      b = path.sample(to),
      h0 = heightAt(plan, from),
      h1 = heightAt(plan, to),
      makeBand = (low, high, raise) =>
        bridgeBand(
          plan,
          from,
          to,
          low,
          high,
          h0 + raise,
          h1 + raise,
          localOffsetAt ? (x, y, z) => (y - raise < 0.6 ? localOffsetAt(x, z) || 0 : 0) : undefined,
        ),
      neutral = makeBand(-plan.width / 2, plan.width / 2, 0),
      slab = makeBand(-plan.width / 2, plan.width / 2, -0.035),
      paving = [];
    if (plan.drive) {
      const roadway = plan.compactShoulders ? plan.width : Math.max(4, plan.width - 4.2);
      paving.push({ kind: 'asphalt', thickness: 0, band: makeBand(-roadway / 2, roadway / 2, 0) });
      for (const side of plan.compactShoulders ? [] : [-1, 1]) {
        const offsets = [(side * roadway) / 2, (side * plan.width) / 2].sort((a, b) => a - b);
        paving.push({ kind: 'sidewalk', thickness: 0.15, band: makeBand(...offsets, 0.15) });
      }
    } else if (plan.rail) {
      const direct = plan.trackFinish === 'direct-fixation';
      paving.push({
        kind: direct ? 'guideway-concrete' : 'ballast',
        thickness: 0,
        band: makeBand(-1.55, 1.55, RAIL_PROFILE.bedTop),
      });
      if (direct)
        for (const side of [-1, 1]) {
          const offset = side * RAIL_PROFILE.halfGauge;
          paving.push({
            kind: 'guideway-plinth',
            thickness: RAIL_PROFILE.plinthTop - RAIL_PROFILE.bedTop,
            band: makeBand(
              offset - RAIL_PROFILE.plinthHalfWidth,
              offset + RAIL_PROFILE.plinthHalfWidth,
              RAIL_PROFILE.plinthTop,
            ),
          });
        }
    } else {
      paving.push({
        kind: 'sidewalk',
        thickness: 0,
        band: makeBand(-plan.width / 2 + 0.16, plan.width / 2 - 0.16, 0),
      });
    }
    const floor = (x, z) => {
      let result = slab.heightAt(x, z);
      for (const surface of paving) {
        const h = surface.band.heightAt(x, z);
        if (h != null) result = Math.max(result ?? -Infinity, h);
      }
      return result;
    };
    const clamped = (x, z, sample) => {
      const own = sample(x, z);
      if (own != null) return own;
      const point = nearestBoundary(slab, x, z);
      return sample(point.x, point.z);
    };
    const vertices = slab.vertices,
      ring = [vertices[0], vertices[3], vertices[5], vertices[2], vertices[0]].map((p) => [p[0], p[2]]);
    const solid = {
      id: `deck-${plan.name}-${i - 1}`,
      ring,
      minHeight: Math.min(...vertices.map((p) => p[1])) - depth,
      height: Math.max(
        ...paving.flatMap((s) => s.band.vertices.map((p) => p[1])),
        ...vertices.map((p) => p[1]),
      ),
      minHeightAt: (x, z) => clamped(x, z, slab.heightAt) - depth,
      heightAt: (x, z) => clamped(x, z, floor),
    };
    segments.push({
      a: [a.x, a.z],
      b: [b.x, b.z],
      from,
      to,
      h0,
      h1,
      plan,
      level: plan.level,
      ramp: false,
      distance0: from * path.length,
      distance1: to * path.length,
      deckStart: i === 1,
      deckEnd: i === stations.length - 1,
      neutral,
      slab,
      paving,
      depth,
      floor,
      solid,
      bounds: slab.bounds,
    });
  }
  const deck = {
    path,
    stations,
    segments,
    heightAtStation(t, offset = 0) {
      const q = path.sample(t),
        x = q.x + q.nx * offset,
        z = q.z + q.nz * offset;
      let low = 0,
        high = segments.length - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (t > segments[mid].to) low = mid + 1;
        else high = mid;
      }
      const s = segments[low],
        h = s.neutral.heightAt(x, z);
      if (h != null) return h;
      const fraction = Math.max(0, Math.min(1, (t - s.from) / (s.to - s.from))),
        base = s.h0 + (s.h1 - s.h0) * fraction;
      return base + (base < 0.6 ? localOffsetAt?.(x, z) || 0 : 0);
    },
    profileHeightAt: (t) => heightAt(plan, t),
    stats: {
      sections: segments.length,
      bands: segments.reduce((n, s) => n + 1 + s.paving.length, 0),
      foldedTriangles: segments.reduce(
        (n, s) => n + s.slab.foldedTriangles + s.paving.reduce((n, p) => n + p.band.foldedTriangles, 0),
        0,
      ),
      degenerateTriangles: segments.reduce(
        (n, s) =>
          n + s.slab.degenerateTriangles + s.paving.reduce((n, p) => n + p.band.degenerateTriangles, 0),
        0,
      ),
    },
  };
  if (deck.stats.foldedTriangles || deck.stats.degenerateTriangles)
    throw new Error('Bridge geometry needs an updated mapped outline');
  decks.set(plan, { terrain, heightAt, deck });
  return deck;
}
