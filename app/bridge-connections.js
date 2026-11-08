import { PEACE_ANCHORS, PEACE_SURFACE_LIMITS } from './peace-surfaces.js';
import { bridgePath } from './bridge-path.js';
import { observedBridgeGuardProfile } from './bridge-guard-finishes.js';

// Architectural representations of documented connections, not shop drawings.
// All hardware dimensions and spacing below are explicitly inferred. These
// primitives are merged into the existing bounded nearby infrastructure tiles.
export const BRIDGE_CONNECTION_LIMITS = Object.freeze({
  maxPrimitives: 18000,
  guardEnvelopeWidth: 0.16,
  kingSpacing: 1.8,
  kingFinRise: 1.34,
  kingFinLean: 0.23,
  traversePicketSpacing: 0.14,
  peacePostSpacing: 3.2,
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v)),
  C = {
    steel: 0x5a655f,
    pale: 0xdce0d7,
    dark: 0x35413e,
    plate: 0x82918c,
    concrete: 0xbcbcaf,
    recess: 0x9b9f95,
    rubber: 0x303b39,
    wood: 0x957852,
    weathering: 0x785447,
  };

export const PEACE_DETAIL_ANCHORS = Object.freeze({
  north: PEACE_ANCHORS[0],
  south: PEACE_ANCHORS[1],
  level: PEACE_SURFACE_LIMITS.level,
});

export function sampleBridge(plan, t) {
  const { x, z, dx, dz } = bridgePath(plan.points).sample(t);
  return { x, z, dx, dz };
}

export function bridgeDetailPoint(plan, t, offset = 0, above = 0, heightAt = (p) => p.level) {
  const q = bridgePath(plan.points).sample(t),
    correction = plan.deck ? plan.deck.heightAtStation(t, offset) - plan.deck.profileHeightAt(t) : 0;
  return [q.x + q.nx * offset, heightAt(plan, t) + above + correction, q.z + q.nz * offset];
}

export function bridgeGuardStyle(plan) {
  if (observedBridgeGuardProfile(plan, 1)) return 'concrete-road-parapet';
  if (plan.name === 'George C. King Bridge') return 'king-cables';
  if (plan.name === 'Elbow River Traverse') return 'traverse-pickets';
  if (plan.name === 'Jaipur Bridge') return 'jaipur-screen';
  if (plan.name === 'Louise Bridge' || plan.name === 'Centre Street Bridge') return 'heritage-concrete';
  return 'standard';
}

export function bridgeGuardOffset(plan) {
  const style = bridgeGuardStyle(plan);
  return plan.width / 2 + (style === 'king-cables' ? 0.027 : style === 'traverse-pickets' ? 0.035 : -0.1);
}

// Cantilevered sidewalks are outboard of the trusses, not pierced by them.
// Match the renderer's existing roadway/sidewalk boundary; no deck is widened.
export function trussHalfWidth(plan) {
  return Math.max(1.5, plan.width / 2 - (plan.drive ? 2.1 : 0.7));
}

export function concreteArchRibOffset(plan) {
  return plan.width / 2 - 0.6;
}

export function bridgeGuardIntervals(plan, side, from = 0, to = 1) {
  let intervals = [[from, to]];
  for (const opening of plan.accessOpenings || []) {
    if (opening.side !== side) continue;
    intervals = intervals.flatMap(([a, b]) => {
      if (opening.to <= a || opening.from >= b) return [[a, b]];
      return [
        [a, Math.max(a, opening.from)],
        [Math.min(b, opening.to), b],
      ].filter(([lo, hi]) => hi - lo > 1e-8);
    });
  }
  return intervals;
}

export function isBridgeGuardOpen(plan, t, side) {
  return (plan.accessOpenings || []).some((o) => o.side === side && t > o.from + 1e-8 && t < o.to - 1e-8);
}

export function bridgeGuardPostStations(plan, side) {
  const stations = (plan.deck?.stations || bridgePath(plan.points).stations).slice(0, -1);
  for (const opening of plan.accessOpenings || [])
    if (opening.side === side) stations.push(opening.from, opening.to);
  return [...new Set(stations)].sort((a, b) => a - b).filter((t) => !isBridgeGuardOpen(plan, t, side));
}

export function cableStayLayout(plan, surfaces) {
  const pieces = Math.max(2, Math.ceil(plan.length)),
    runs = [];
  let start = null;
  for (let i = 0; i <= pieces; i++) {
    const q = sampleBridge(plan, i / pieces),
      wet = surfaces.inWater(q.x, q.z);
    if (wet && start === null) start = i / pieces;
    if ((!wet || i === pieces) && start !== null) {
      runs.push([start, i / pieces]);
      start = null;
    }
  }
  const water = runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0] || [0.3, 0.8],
    a = clamp(water[0] - 2 / plan.length, 0.08, 0.85),
    b = clamp(water[1] + 2 / plan.length, a + 0.08, 0.98);
  return { a, b, supports: [...new Set([0, a, b, 1])] };
}

// The main cable meets the existing towers; short backstays descend to the
// abutment anchors. Rise, sag and anchor sizes remain inferred.
export function suspensionCableHeight(t) {
  if (t < 0.07) return 0.3 + 7.1 * clamp(t / 0.07, 0, 1);
  if (t > 0.93) return 0.3 + 7.1 * clamp((1 - t) / 0.07, 0, 1);
  return 2 + 5.4 * ((t - 0.5) / 0.43) ** 2;
}

export function suspensionCableSamples() {
  return [...new Set([0.07, 0.93, ...Array.from({ length: 43 }, (_, i) => i / 42)])].sort((a, b) => a - b);
}

export function kingBalustradeFixtures(plan, heightAt) {
  const count = Math.ceil(plan.length / BRIDGE_CONNECTION_LIMITS.kingSpacing),
    fixtures = [];
  const fin = (t, side) => {
    const bottom = bridgeDetailPoint(plan, t, side * (plan.width / 2 - 0.11), 0.08, heightAt),
      q = sampleBridge(plan, t),
      lean = side * BRIDGE_CONNECTION_LIMITS.kingFinLean;
    return {
      t,
      side,
      bottom,
      top: [
        bottom[0] - q.dz * lean,
        bottom[1] + BRIDGE_CONNECTION_LIMITS.kingFinRise,
        bottom[2] + q.dx * lean,
      ],
    };
  };
  for (let i = 0; i <= count; i++)
    for (const side of [-1, 1]) {
      const t = i / count;
      if (!isBridgeGuardOpen(plan, t, side)) fixtures.push({ ...fin(t, side), index: i });
    }
  for (const opening of plan.accessOpenings || [])
    for (const t of [opening.from, opening.to]) {
      if (fixtures.some((f) => f.side === opening.side && Math.abs(f.t - t) < 1e-8)) continue;
      fixtures.push({ ...fin(t, opening.side), index: Math.round(t * count), terminal: true });
    }
  return fixtures.sort((a, b) => a.t - b.t || a.side - b.side);
}

export function collectBridgeConnections(surfaces, context = {}) {
  const items = [],
    counts = {},
    represented = new Map(),
    heightAt = context.heightAt || ((p) => p.level),
    named = new Set([
      'Centre Street Bridge',
      'Louise Bridge',
      'Mewata Bridge',
      'Reconciliation Bridge',
      'MacDonald Bridge',
      'George C. King Bridge',
      'Jaipur Bridge',
      'Elbow River Traverse',
      "Prince's Island Bridge",
      'Rideau pedestrian bridge',
      'Mission Bridge',
      '25 Avenue SW Bridge',
      '9 Avenue SE Bridge',
    ]);
  let plan;
  const emit = (kind, primitive) => {
      if (items.length >= BRIDGE_CONNECTION_LIMITS.maxPrimitives)
        throw new Error('Bridge connection budget exceeded');
      const centre =
        primitive.centre ||
        (primitive.a ? primitive.a.map((v, i) => (v + primitive.b[i]) / 2) : primitive.points[0]);
      const item = {
        ...primitive,
        x: centre[0],
        z: centre[2],
        kind,
        name: plan.name,
        sourceRoadIds: plan.roads?.map((r) => r.id) || [],
      };
      items.push(item);
      counts[kind] = (counts[kind] || 0) + 1;
      represented.set(plan.name, (represented.get(plan.name) || 0) + 1);
      return item;
    },
    point = (t, offset, y) => bridgeDetailPoint(plan, t, offset, y, heightAt),
    beam = (kind, a, b, radius, tint = C.steel, sides = 4) =>
      emit(kind, { shape: 'beam', a, b, radius, tint, sides }),
    box = (kind, t, offset, y, width, height, depth, tint = C.steel) => {
      const q = sampleBridge(plan, t);
      return emit(kind, {
        shape: 'box',
        centre: point(t, offset, y),
        width,
        height,
        depth,
        // Batch.box rotates local depth onto [dx,dz] at this positive angle.
        angle: Math.atan2(q.dx, q.dz),
        tint,
      });
    },
    plate = (kind, t, offset, y, width, height, tint) => {
      const dt = width / (2 * plan.length),
        vertices = [
          [-1, -0.32],
          [-0.55, -0.5],
          [0.55, -0.5],
          [1, -0.32],
          [1, 0.32],
          [0.55, 0.5],
          [-0.55, 0.5],
          [-1, 0.32],
        ];
      const front = vertices.map(([u, v]) => point(clamp(t + dt * u, 0, 1), offset - 0.045, y + height * v)),
        back = vertices.map(([u, v]) => point(clamp(t + dt * u, 0, 1), offset + 0.045, y + height * v));
      return emit(kind, { shape: 'plate', points: front, back, centre: point(t, offset, y), tint });
    };

  for (plan of surfaces.plans) {
    if (!named.has(plan.name) || plan.rail) continue;
    const style = bridgeGuardStyle(plan),
      segments = Math.max(2, Math.ceil(plan.length / 5));
    // Endpoint strip seals, edge angles and sidewalk plates. Interior deck
    // joints are represented only on Reconciliation's two independent spans.
    for (const t of [0, ...(plan.name === 'Reconciliation Bridge' ? [0.5] : []), 1]) {
      const bands = plan.drive
        ? [
            [0, plan.width - 4.2, 0],
            [-plan.width / 2 + 1.05, 2.1, 0.15],
            [plan.width / 2 - 1.05, 2.1, 0.15],
          ]
        : [[0, plan.width - 0.12, 0]];
      for (const [offset, width, y] of bands) {
        box('deck-joint-seal', t, offset, y + 0.009, width, 0.014, 0.055, C.rubber);
        for (const sign of [-1, 1])
          box(
            'joint-edge-angle',
            clamp(t + (sign * 0.055) / plan.length, 0, 1),
            offset,
            y + 0.007,
            width,
            0.014,
            0.045,
            C.plate,
          );
      }
    }

    if (plan.type === 'parker-truss') {
      const half = trussHalfWidth(plan),
        rise = plan.name === 'MacDonald Bridge' ? 6 : 8,
        steel = plan.name === 'MacDonald Bridge' ? 0x6b786a : 0x60736d;
      for (let span = 0; span < plan.spans; span++)
        for (let i = 0; i <= 8; i++) {
          const u = i / 8,
            t = (span + u) / plan.spans,
            crown = rise * (0.6 + 0.4 * Math.sin(Math.PI * u));
          for (const side of [-1, 1]) {
            for (const y of [0.2, crown]) {
              plate('truss-gusset', t, side * half, y, 0.95, 0.72, steel);
              for (const du of [-0.27, 0, 0.27])
                for (const dy of [-0.18, 0.18]) {
                  const tt = clamp(t + du / plan.length, 0, 1),
                    outer = side * (half + 0.052),
                    inner = side * (half + 0.08);
                  beam('gusset-rivet', point(tt, outer, y + dy), point(tt, inner, y + dy), 0.024, C.plate, 6);
                }
            }
            // Triangular brackets carry the outboard sidewalks. The top limb
            // and knee end beneath the slab, leaving the walking corridor open.
            const a = point(t, side * half, -0.2),
              b = point(t, side * (plan.width / 2 - 0.22), -0.2),
              c = point(t, side * half, -1.05);
            beam('sidewalk-outrigger', a, b, 0.075, steel);
            beam('sidewalk-knee-brace', c, b, 0.065, steel);
          }
          if (i < 8) {
            const next = (span + (i + 1) / 8) / plan.spans;
            beam('underdeck-crossbrace', point(t, -half, -0.47), point(next, half, -0.47), 0.045, steel);
            beam('underdeck-crossbrace', point(t, half, -0.47), point(next, -half, -0.47), 0.045, steel);
          }
        }
      for (let i = 0; i <= plan.spans; i++)
        for (const side of [-1, 1]) {
          const t = i / plan.spans,
            offset = side * half;
          box('bearing-masonry-plate', t, offset, -0.635, 0.95, 0.06, 0.85, C.plate);
          box('bearing-core', t, offset, -0.565, 0.65, 0.08, 0.56, C.dark);
          box('bearing-sole-plate', t, offset, -0.505, 0.86, 0.04, 0.72, C.plate);
          if (
            plan.name === 'Reconciliation Bridge' &&
            sampleBridge(plan, t).z === Math.max(sampleBridge(plan, 0).z, sampleBridge(plan, 1).z)
          )
            for (const along of [-0.26, 0.26])
              box(
                'sliding-bearing-guide',
                clamp(t + along / plan.length, 0, 1),
                offset,
                -0.56,
                0.8,
                0.08,
                0.045,
                C.plate,
              );
        }
      // Continuous service pipe follows the deck below the outboard walkway.
      for (let i = 0; i < segments; i++)
        beam(
          'underdeck-service-conduit',
          point(i / segments, half + 0.35, -0.6),
          point((i + 1) / segments, half + 0.35, -0.6),
          0.045,
          C.dark,
          6,
        );
    }

    if (style === 'king-cables') {
      for (const fixture of kingBalustradeFixtures(plan, heightAt)) {
        emit('king-inclined-fin', {
          shape: 'beam',
          a: fixture.bottom,
          b: fixture.top,
          radius: 0.075,
          tint: C.steel,
          sides: 4,
        });
        box(
          'king-fin-foot',
          fixture.t,
          fixture.side * (plan.width / 2 - 0.11),
          0.04,
          0.22,
          0.08,
          0.22,
          C.plate,
        );
      }
      for (const side of [-1, 1])
        for (let i = 0; i < segments; i++)
          for (const y of [0.18, 0.3, 0.42, 0.54, 0.66, 0.78, 1.0, 1.12, 1.25]) {
            const offset =
              side *
              (plan.width / 2 -
                0.11 +
                (BRIDGE_CONNECTION_LIMITS.kingFinLean * (y - 0.08)) / BRIDGE_CONNECTION_LIMITS.kingFinRise);
            for (const [from, to] of bridgeGuardIntervals(plan, side, i / segments, (i + 1) / segments))
              beam('king-horizontal-cable', point(from, offset, y), point(to, offset, y), 0.007, C.steel, 4);
          }
    } else if (style === 'traverse-pickets') {
      const count = Math.ceil(plan.length / BRIDGE_CONNECTION_LIMITS.traversePicketSpacing);
      for (let i = 0; i <= count; i++)
        for (const side of [-1, 1])
          beam(
            'traverse-outboard-picket',
            point(i / count, side * (plan.width / 2 + 0.035), -0.1),
            point(i / count, side * (plan.width / 2 + 0.035), 1.12),
            0.009,
            C.pale,
            4,
          );
      for (let i = 0, count = Math.ceil(plan.length / 2.4); i <= count; i++)
        for (const side of [-1, 1]) {
          const t = i / count;
          beam(
            'traverse-edge-bracket',
            point(t, side * (plan.width / 2 - 0.16), -0.16),
            point(t, side * (plan.width / 2 + 0.07), -0.16),
            0.035,
            C.pale,
          );
        }
    } else if (style === 'heritage-concrete') {
      const count = Math.ceil(plan.length / 0.7);
      for (let i = 0; i <= count; i++)
        for (const side of [-1, 1]) {
          const t = i / count,
            offset = side * (plan.width / 2 - 0.1);
          box('concrete-baluster', t, offset, 0.7, 0.14, 0.7, 0.17, C.concrete);
          box('baluster-neck', t, offset, 1.03, 0.19, 0.09, 0.22, C.concrete);
          box('baluster-foot', t, offset, 0.39, 0.2, 0.09, 0.23, C.concrete);
        }
      const piers = Math.ceil(plan.length / 8);
      for (let i = 0; i <= piers; i++)
        for (const side of [-1, 1]) {
          const t = i / piers,
            offset = side * (plan.width / 2 - 0.1);
          box('heritage-pilaster', t, offset, 0.72, 0.48, 1.14, 0.58, C.concrete);
          box('pilaster-cap', t, offset, 1.3, 0.6, 0.12, 0.7, C.concrete);
          box('pilaster-inset-panel', t, offset + side * 0.244, 0.75, 0.012, 0.56, 0.37, C.recess);
        }
    } else if (style === 'jaipur-screen') {
      const count = Math.max(1, Math.floor(plan.length / 1.7));
      for (let i = 0; i < count; i++)
        for (const side of [-1, 1]) {
          const t = (i + 0.5) / count,
            offset = side * (plan.width / 2 - 0.1),
            panelPoint = (u, y) => point(clamp(t + u / plan.length, 0, 1), offset, y),
            corners = [
              [-0.7, 0.29],
              [0.7, 0.29],
              [0.7, 1.11],
              [-0.7, 1.11],
            ];
          for (let j = 0; j < 4; j++)
            beam(
              'jaipur-screen-frame',
              panelPoint(...corners[j]),
              panelPoint(...corners[(j + 1) % 4]),
              0.025,
              C.steel,
            );
          // A code-native open floral outline replaces the old opaque panel/X.
          // This is a simplified flower cue, not a copy of the architect's cut
          // file or a claim about the exact Jaipur pattern used on every panel.
          let last = null,
            first = null;
          for (let j = 0; j <= 32; j++) {
            const theta = (j / 32) * Math.PI * 2,
              r = 0.22 + 0.07 * Math.cos(theta * 8),
              q = panelPoint(Math.cos(theta) * r * 1.9, 0.7 + Math.sin(theta) * r);
            if (!first) first = q;
            if (last) beam('jaipur-floral-screen', last, j === 32 ? first : q, 0.018, C.steel);
            last = q;
          }
        }
      for (const [t, side] of [
        [0.3, -1],
        [0.7, 1],
      ]) {
        const offset = side * (plan.width / 2 - 0.42);
        for (const v of [-0.165, -0.055, 0.055, 0.165])
          box('jaipur-wood-seat', t, offset + v, 0.49, 0.085, 0.06, 2.2, C.wood);
        for (const d of [-0.72, 0.72])
          box('jaipur-seat-leg', t + d / plan.length, offset, 0.26, 0.37, 0.43, 0.06, C.steel);
      }
    }
    if (style === 'standard' || style === 'jaipur-screen') {
      // Shoe plates attach the existing guard posts; post spacing must match
      // drawBridge's five-metre segmentation exactly.
      for (const side of [-1, 1])
        for (const t of bridgeGuardPostStations(plan, side)) {
          box('guard-post-shoe', t, side * (plan.width / 2 - 0.1), 0.17, 0.21, 0.025, 0.24, C.plate);
          if (!plan.drive) {
            const offset = side * (plan.width / 2 - 0.1);
            beam('guard-post-lower-stem', point(t, offset, 0.03), point(t, offset, 0.18), 0.045, C.steel);
            box('guard-post-deck-plate', t, offset, 0.015, 0.21, 0.03, 0.24, C.plate);
          }
        }
    }

    if (plan.type === 'network-arch') {
      // Small cable collars follow the exact existing hanger endpoints.
      for (let span = 0; span < 3; span++)
        for (let i = 1; i < 15; i++)
          for (const side of [-1, 1]) {
            const u = i / 15,
              v = clamp(u + (i % 2 ? -0.12 : 0.12), 0.03, 0.97),
              rise = span === 1 ? -2.8 : 11,
              a = point((span + u) / 3, (side * plan.width) / 2, 0.15),
              b = point(
                (span + v) / 3,
                side * (plan.width / 2 - 0.1 - Math.sin(Math.PI * v) * 0.45),
                Math.sin(Math.PI * v) * rise,
              ),
              len = Math.hypot(...b.map((q, j) => q - a[j])),
              collar = a.map((q, j) => q + (b[j] - q) * Math.min(0.2 / len, 0.2));
            beam('hanger-anchor-socket', a, collar, 0.058, C.plate, 6);
          }
    }
    if (plan.type === 'cable-stayed') {
      const layout = cableStayLayout(plan, surfaces),
        tower = layout.a;
      for (const side of [-1, 1])
        for (let i = 1; i <= 8; i++)
          for (const t of [tower + ((layout.b - tower) * i) / 9, Math.max(0.025, tower * (1 - i / 9))]) {
            const a = point(t, side * (plan.width / 2 - 0.1), 0.2),
              b = point(tower, side * 0.18, 12),
              len = Math.hypot(...b.map((v, j) => v - a[j])),
              end = a.map((v, j) => v + (b[j] - v) * Math.min(0.28 / len, 0.25));
            beam('stay-anchor-socket', a, end, 0.064, C.plate, 6);
            box('stay-anchor-base', t, side * (plan.width / 2 - 0.1), 0.13, 0.21, 0.08, 0.3, C.plate);
          }
    }
    if (plan.type === 'suspension') {
      for (const side of [-1, 1]) {
        for (const t of [0, 1]) {
          box('suspension-anchor-block', t, side * (plan.width / 2 + 0.1), -0.05, 0.6, 0.5, 0.85, C.concrete);
          box('suspension-anchor-plate', t, side * (plan.width / 2 + 0.1), 0.23, 0.36, 0.06, 0.58, C.plate);
        }
        for (const t of [0.07, 0.93]) {
          box('suspension-tower-shoe', t, side * (plan.width / 2 + 0.1), -0.08, 0.47, 0.08, 0.5, C.plate);
          const dt = 0.18 / plan.length;
          beam(
            'suspension-saddle',
            point(t - dt, side * (plan.width / 2 + 0.1), suspensionCableHeight(t - dt)),
            point(t + dt, side * (plan.width / 2 + 0.1), suspensionCableHeight(t + dt)),
            0.09,
            C.plate,
            6,
          );
        }
      }
    }
  }

  if (context.includePeace !== false) {
    const { north, south, level } = PEACE_DETAIL_ANCHORS;
    plan = {
      name: 'Peace Bridge',
      points: [north, south],
      level,
      length: Math.hypot(south[0] - north[0], south[1] - north[1]),
      roads: [],
    };
    const count = Math.ceil(plan.length / BRIDGE_CONNECTION_LIMITS.peacePostSpacing);
    for (const side of [-1, 1])
      for (let i = 0; i <= count; i++) {
        const t = i / count;
        box('peace-infill-post-foot', t, side * 3, 0.15, 0.14, 0.045, 0.17, C.plate);
        for (let y = 0.2; y < 0.69; y += 0.075) {
          const a = point(t, side * 3, y),
            b = point(clamp(t + (i === count ? -0.06 : 0.06) / plan.length, 0, 1), side * 3, y);
          beam('peace-cable-ferrule', a, b, 0.018, C.plate, 6);
        }
      }
  }
  const triangleUpperBound = items.reduce(
    (n, item) =>
      n +
      (item.shape === 'beam' ? item.sides * 4 - 4 : item.shape === 'box' ? 12 : item.points.length * 4 - 4),
    0,
  );
  return {
    items,
    stats: {
      primitives: items.length,
      bridges: represented.size,
      byKind: counts,
      byBridge: Object.fromEntries(represented),
      addedMaterials: 0,
      addedDrawCalls: 0,
      pointLights: 0,
      triangleUpperBound,
    },
  };
}

export function drawBridgeConnection(batch, item) {
  if (item.shape === 'beam') batch.beam(item.a, item.b, item.radius, item.tint, item.sides);
  else if (item.shape === 'box')
    batch.box(...item.centre, item.width, item.height, item.depth, item.angle, item.tint);
  else if (item.shape === 'plate') {
    const { points, back, tint } = item,
      n = points.length;
    for (let i = 1; i < n - 1; i++) {
      batch.triangle(points[0], points[i + 1], points[i], tint);
      batch.triangle(back[0], back[i], back[i + 1], tint);
    }
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      batch.quad(points[i], points[next], back[next], back[i], tint);
    }
  }
}
