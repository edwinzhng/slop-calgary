import { nearestOnSegment } from './geo.js';
import { accessRailIntervals, bridgeDeckHeight } from './infrastructure.js';
import { bridgeGuardIntervals, bridgeGuardOffset, BRIDGE_CONNECTION_LIMITS } from './bridge-connections.js';
import { bridgePathPoint } from './bridge-path.js';
import { createBridgeDeck } from './bridge-deck.js';
import { PEACE_ANCHORS, PEACE_SURFACE_LIMITS, PEACE_WALKWAY } from './peace-surfaces.js';
import { observedBridgeGuardProfile } from './bridge-guard-finishes.js';

// Shared solid envelopes follow the actual rendered height profile. Camera
// slabs stay separate from walkable support; only the visible rails block feet.
export function slopingPrism(a, b, width, y0, y1, lower, upper, id) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.01) return null;
  const nx = ((-(b[1] - a[1]) / length) * width) / 2,
    nz = (((b[0] - a[0]) / length) * width) / 2;
  const ring = [
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
    [a[0] + nx, a[1] + nz],
  ];
  const height = (x, z) => y0 + (y1 - y0) * nearestOnSegment(x, z, a, b).t;
  return {
    id,
    ring,
    minHeight: Math.min(y0, y1) + lower,
    height: Math.max(y0, y1) + upper,
    minHeightAt: (x, z) => height(x, z) + lower,
    heightAt: (x, z) => height(x, z) + upper,
  };
}

export function createBridgeCollisionParts(surfaces = {}) {
  const slabs = [],
    barriers = [];
  const add = (a, b, width, y0, y1, id, rails = true, intervals = () => [[0, 1]]) => {
    const slab = slopingPrism(a, b, width, y0, y1, -0.58, 0.15, `deck-${id}`);
    if (!slab) return;
    slabs.push(slab);
    if (!rails) return;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]),
      nx = -(b[1] - a[1]) / length,
      nz = (b[0] - a[0]) / length;
    for (const side of [-1, 1]) {
      const offset = side * (width / 2 - 0.1);
      for (const [from, to] of intervals(side)) {
        const start = [a[0] + (b[0] - a[0]) * from, a[1] + (b[1] - a[1]) * from],
          end = [a[0] + (b[0] - a[0]) * to, a[1] + (b[1] - a[1]) * to],
          h0 = y0 + (y1 - y0) * from,
          h1 = y0 + (y1 - y0) * to;
        const rail = slopingPrism(
          [start[0] + nx * offset, start[1] + nz * offset],
          [end[0] + nx * offset, end[1] + nz * offset],
          BRIDGE_CONNECTION_LIMITS.guardEnvelopeWidth,
          h0,
          h1,
          0.1,
          1.1,
          `guardrail-${id}-${side}-${from}`,
        );
        if (rail) {
          rail.type = 'bridge-guardrail';
          barriers.push(rail);
        }
      }
    }
  };
  for (const plan of surfaces.plans || []) {
    const deck = plan.deck || createBridgeDeck(plan, bridgeDeckHeight);
    for (const [i, segment] of deck.segments.entries()) {
      slabs.push(segment.solid);
      for (const side of [-1, 1])
        for (const [from, to] of bridgeGuardIntervals(plan, side, segment.from, segment.to)) {
          const profile = observedBridgeGuardProfile(plan, side),
            offset = side * bridgeGuardOffset(plan),
            a = bridgePathPoint(plan, from, offset, deck.heightAtStation(from, offset)),
            b = bridgePathPoint(plan, to, offset, deck.heightAtStation(to, offset)),
            rail = slopingPrism(
              [a[0], a[2]],
              [b[0], b[2]],
              profile?.width ?? BRIDGE_CONNECTION_LIMITS.guardEnvelopeWidth,
              a[1],
              b[1],
              profile?.lower ?? 0.1,
              profile?.upper ?? 1.1,
              `guardrail-${plan.name}-${i}-${side}-${from}`,
            );
          if (rail) {
            rail.type = 'bridge-guardrail';
            barriers.push(rail);
          }
        }
    }
    for (const [i, s] of (plan.approaches || []).entries())
      add(
        s.a,
        s.b,
        s.width,
        surfaces.approachHeightAt?.(s, 0) ?? s.h0,
        surfaces.approachHeightAt?.(s, 1) ?? s.h1,
        `approach-${plan.name}-${i}`,
        !!s.accessBranch && Math.max(s.h0, s.h1) > 0.65,
        (side) =>
          accessRailIntervals(s, side, s.width, surfaces).map(([from, to]) => [
            from / Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]),
            to / Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]),
          ]),
      );
  }
  if (surfaces.peace?.deckRoads?.length) {
    add(
      ...PEACE_ANCHORS,
      PEACE_WALKWAY.width,
      PEACE_SURFACE_LIMITS.level,
      PEACE_SURFACE_LIMITS.level,
      'Peace Bridge',
    );
    for (const [i, s] of surfaces.peace.segments.entries())
      add(s.a, s.b, s.width, s.h0, s.h1, `Peace-access-${i}`, false);
  }
  return { slabs, barriers, stats: { slabs: slabs.length, guardrails: barriers.length } };
}
