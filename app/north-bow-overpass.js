import * as THREE from 'three/webgpu';
import { DRIVABLE, bounds, makeRoadIndex, nearestOnSegment, roadWidth, SpatialIndex } from './geo.js';
import { createNorthBowAccess } from './north-bow-access.js';
import evidence from '../data/north-bow-overpass-evidence.json' with { type: 'json' };

export const NORTH_BOW_OVERPASS_ID = 'osm-way-166400806-0';
export const NORTH_BOW_PATH_ID = 'osm-way-180764948-0';
export const NORTH_BOW_OVERPASS_SOURCE = Object.freeze({
  name: '9A Street Memorial Drive Overpass',
  sourceWay: 'https://www.openstreetmap.org/way/166400806',
  pathSnapshot: '2026-10-29T00:11:36Z',
  images: [
    {
      id: 'mapillary-793666217805126',
      capturedAt: '2021-03-07T14:43:57Z',
      creator: 'adamdunn',
      sourceUrl: 'https://www.mapillary.com/app/?pKey=793666217805126&focus=photo',
      previewSha256: 'f2a69f1462467d94119c9c88159fa6c29d54e819460399e9013321379b2535a6',
    },
    {
      id: 'mapillary-903736060406501',
      capturedAt: '2021-03-07T14:43:51Z',
      creator: 'adamdunn',
      sourceUrl: 'https://www.mapillary.com/app/?pKey=903736060406501&focus=photo',
      previewSha256: '62e540f9d157c5b2b3e69c86aa7d9d732268e7932db65d9dcb132db37851abff',
    },
  ],
  photoLicense: 'CC BY-SA 4.0',
  photoLicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  observed: [
    'looping concrete deck',
    'blue-green open mesh guards with horizontal rails',
    'round paired concrete columns',
    'asphalt shared path with double yellow centerline beneath',
  ],
  geometryPolicy:
    'The complete current mapped OSM centerline is retained. City bare-earth DEM constrains relative bank ties and Alberta TIMS reports 5.5m Meas VCL Over; neither provides a surveyed deck profile. Width, slab/guard dimensions, modeled vertical profile and support stations remain bounded inferences.',
  visualReviewStatus: 'revised-source-camera-context-rechecked-2026-10-30; checkpoint-sides-open',
  clearance: Object.freeze(evidence.clearance),
  bankGroundSource: Object.freeze(evidence.sourceGround),
  mappedStepCounts: {
    'osm-way-422813126-0': 11,
    'osm-way-422813127-0': 15,
    'osm-way-422813128-0': 9,
    'osm-way-608738663-0': 28,
  },
});

export const NORTH_BOW_OVERPASS_LIMITS = Object.freeze({
  width: 2.8,
  deckThickness: 0.32,
  measuredClearanceOver: 5.5,
  inferredRoadLevel: 0.16,
  southRiser: 0.17,
  maxGrade: 0.12,
  bankAccessMaxGrade: 0.08,
  guardHeight: 1.18,
  guardRadius: 0.04,
  columnRadius: 0.2,
  stepUp: 0.65,
  pieceLength: 1.6,
  wireSpacing: 0.16,
  detailDistance: 180,
  visibleDistance: 2200,
});
const PALETTE = { concrete: 0xc5c5ba, edge: 0xd3d2c6, guard: 0x397f79, wire: 0x477b72 };
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mix = (a, b, t) => a + (b - a) * t;
const at = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const EPS = 1e-8;

// C1 easing has a bounded 10/9 slope amplification, retaining useful ramp
// length near the actual short hairpins instead of inventing a broad hump.
export function northBowRampEase(t) {
  const u = clamp(t),
    f = 0.1;
  return u < f
    ? (u * u) / (2 * f * (1 - f))
    : u > 1 - f
      ? 1 - (1 - u) ** 2 / (2 * f * (1 - f))
      : (u - f / 2) / (1 - f);
}

function cumulative(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out.at(-1) + len(points[i - 1], points[i]));
  return out;
}
function baryHeight(x, z, a, b, c) {
  const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(det) < EPS) return null;
  const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
  const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det,
    w = 1 - u - v;
  return u >= -1e-7 && v >= -1e-7 && w >= -1e-7 ? u * a[1] + v * b[1] + w * c[1] : null;
}
function quadHeight(q, x, z) {
  const a = q[0].map((n, i) => (n + q[3][i]) / 2),
    b = q[1].map((n, i) => (n + q[2][i]) / 2);
  return (
    baryHeight(x, z, q[0], q[1], b) ??
    baryHeight(x, z, q[0], b, a) ??
    baryHeight(x, z, a, b, q[2]) ??
    baryHeight(x, z, a, q[2], q[3])
  );
}
function quadPrism(id, top, lower, upper, type) {
  const ring = top.map((p) => [p[0], p[2]]);
  ring.push([...ring[0]]);
  const fallback = (x, z) => {
    const a = [(top[0][0] + top[3][0]) / 2, (top[0][2] + top[3][2]) / 2],
      b = [(top[1][0] + top[2][0]) / 2, (top[1][2] + top[2][2]) / 2];
    return mix(top[0][1], top[1][1], nearestOnSegment(x, z, a, b).t);
  };
  const heightAt = (x, z) => quadHeight(top, x, z) ?? fallback(x, z);
  return {
    id,
    type,
    ring,
    minHeight: Math.min(...top.map((p) => p[1])) + lower,
    height: Math.max(...top.map((p) => p[1])) + upper,
    minHeightAt: (x, z) => heightAt(x, z) + lower,
    heightAt: (x, z) => heightAt(x, z) + upper,
    sourceRoadId: NORTH_BOW_OVERPASS_ID,
    inferredDimensions: true,
    storefrontAnchor: false,
  };
}

const STAIR_SOURCE_COUNTS = Object.freeze({
  'osm-way-422813126-0': 11,
  'osm-way-422813127-0': 15,
  'osm-way-422813128-0': 9,
  'osm-way-608738663-0': 28,
});
function sampleSource(points, arcs, distance) {
  const atDistance = clamp(distance, 0, arcs.at(-1));
  for (let i = 1; i < arcs.length; i++)
    if (arcs[i] >= atDistance - EPS)
      return at(points[i - 1], points[i], (atDistance - arcs[i - 1]) / (arcs[i] - arcs[i - 1]));
  return points.at(-1);
}
function createStairFlights(data, mainPoints, mainArc, heightAtArc, ground) {
  const byId = new Map((data.roads || []).map((r) => [r.id, r])),
    flights = [],
    gaps = [];
  const mainConnection = (point) => {
    let best = null;
    for (let i = 1; i < mainPoints.length; i++) {
      const q = nearestOnSegment(...point, mainPoints[i - 1], mainPoints[i]);
      if (q.distance < 0.06 && (!best || q.distance < best.distance))
        best = { distance: q.distance, arc: mix(mainArc[i - 1], mainArc[i], q.t) };
    }
    return best;
  };
  const upper = byId.get('osm-way-422813127-0'),
    north = byId.get('osm-way-608738663-0');
  const upperConnection = upper && mainConnection(upper.points.at(-1));
  const lower = byId.get('osm-way-422813126-0'),
    middle =
      upperConnection && lower
        ? ground(...lower.points[0]) +
          ((heightAtArc(upperConnection.arc) - ground(...lower.points[0])) * 11) / 26
        : null;
  const descriptions = [
    [lower, lower && ground(...lower.points[0]), middle],
    [upper, middle, upperConnection && heightAtArc(upperConnection.arc)],
    [byId.get('osm-way-422813128-0'), null, middle],
    [
      north,
      north && ground(...north.points[0]),
      north && mainConnection(north.points.at(-1)) && heightAtArc(mainConnection(north.points.at(-1)).arc),
    ],
  ];
  for (const [r, providedBase, topHeight] of descriptions) {
    if (!r || r.kind !== 'steps' || r.points.some((p) => !p.every(Number.isFinite))) continue;
    const count = STAIR_SOURCE_COUNTS[r.id],
      mapped = Number(r.sourceTags?.step_count) || count;
    const base = providedBase ?? ground(...r.points[0]);
    if (mapped !== count || !Number.isFinite(topHeight) || topHeight - base < 0.4 || topHeight <= base)
      continue;
    const riser = (topHeight - base) / count;
    if (riser < 0.08 || riser > 0.25) continue;
    const points = r.points.map((p) => [...p]),
      arc = cumulative(points),
      length = arc.at(-1),
      width = 1.6,
      segments = [];
    const connection = mainConnection(points.at(-1));
    const midPoint = lower?.points.at(-1),
      landingRadius = 0.65;
    const startTrim = midPoint && len(points[0], midPoint) < 0.01 ? landingRadius : 0;
    let endTrim = midPoint && len(points.at(-1), midPoint) < 0.01 ? landingRadius : 0;
    if (connection) {
      const i = Math.max(0, mainArc.findIndex((d) => d >= connection.arc - EPS) - 1),
        a = mainPoints[i],
        b = mainPoints[i + 1],
        last = points.at(-1),
        prev = points.at(-2),
        normal = [-(b[1] - a[1]) / len(a, b), (b[0] - a[0]) / len(a, b)],
        approach = [(last[0] - prev[0]) / len(prev, last), (last[1] - prev[1]) / len(prev, last)];
      // Source stairs connect to the bridge centreline. Finish their risers at
      // its physical edge, then retain a flat landing to that mapped node.
      endTrim =
        (NORTH_BOW_OVERPASS_LIMITS.width / 2 + 0.04) /
        Math.max(0.5, Math.abs(normal[0] * approach[0] + normal[1] * approach[1]));
    }
    const landingSegments = [];
    const flatLanding = (d0, d1, height, label) => {
      if (d1 - d0 < 0.001) return;
      const a = sampleSource(points, arc, d0),
        b = sampleSource(points, arc, d1),
        l = len(a, b),
        nx = ((-(b[1] - a[1]) / l) * width) / 2,
        nz = (((b[0] - a[0]) / l) * width) / 2;
      const top = [
        [a[0] - nx, height, a[1] - nz],
        [b[0] - nx, height, b[1] - nz],
        [b[0] + nx, height, b[1] + nz],
        [a[0] + nx, height, a[1] + nz],
      ];
      const slab = quadPrism(`north-bow-landing-${r.id}-${label}`, top, -0.24, 0, 'bridge-stair-landing');
      slab.sourceRoadId = r.id;
      landingSegments.push({ a, b, h0: height, h1: height, top, slab, width, road: r, landing: true });
    };
    let stepsBefore = 0;
    for (let leg = 1; leg < points.length; leg++) {
      const legCount =
        leg === points.length - 1
          ? count - stepsBefore
          : Math.round((count * arc[leg]) / length) - stepsBefore;
      const from = arc[leg - 1] + (leg === 1 ? startTrim : landingRadius),
        to = arc[leg] - (leg === points.length - 1 ? endTrim : landingRadius);
      if (to <= from || legCount < 1)
        throw new Error('Mapped9A stair run is too short for its retained steps and landings');
      flatLanding(arc[leg - 1], from, base + stepsBefore * riser, `start-${leg}`);
      for (let j = 0; j < legCount; j++) {
        const i = stepsBefore + j,
          d0 = from + ((to - from) * j) / legCount,
          d1 = from + ((to - from) * (j + 1)) / legCount,
          a = sampleSource(points, arc, d0),
          b = sampleSource(points, arc, d1),
          l = len(a, b),
          nx = ((-(b[1] - a[1]) / l) * width) / 2,
          nz = (((b[0] - a[0]) / l) * width) / 2,
          previousHeight = base + riser * i,
          height = base + riser * (i + 1),
          top = [
            [a[0] - nx, height, a[1] - nz],
            [b[0] - nx, height, b[1] - nz],
            [b[0] + nx, height, b[1] + nz],
            [a[0] + nx, height, a[1] + nz],
          ];
        const slab = quadPrism(`north-bow-stair-${r.id}-${i}`, top, -0.24 - riser, 0, 'bridge-stair-deck');
        slab.minHeight = previousHeight - 0.24;
        slab.minHeightAt = (x, z) => mix(previousHeight, height, nearestOnSegment(x, z, a, b).t) - 0.24;
        slab.sourceRoadId = r.id;
        segments.push({
          a,
          b,
          h0: height,
          h1: height,
          previousHeight,
          top,
          slab,
          width,
          road: r,
          stair: true,
          stepIndex: i,
        });
      }
      stepsBefore += legCount;
      flatLanding(to, arc[leg], base + stepsBefore * riser, `end-${leg}`);
      if (leg < points.length - 1) {
        const [x, z] = points[leg],
          h = base + stepsBefore * riser,
          radius = 0.8,
          top = [
            [x - radius, h, z - radius],
            [x + radius, h, z - radius],
            [x + radius, h, z + radius],
            [x - radius, h, z + radius],
          ],
          slab = quadPrism(`north-bow-landing-${r.id}-turn-${leg}`, top, -0.24, 0, 'bridge-stair-landing');
        slab.sourceRoadId = r.id;
        landingSegments.push({
          a: [x - radius, z],
          b: [x + radius, z],
          h0: h,
          h1: h,
          top,
          slab,
          width: radius * 2,
          road: r,
          landing: true,
        });
      }
    }
    const flight = {
      road: r,
      points,
      arc,
      length,
      width,
      count,
      riser,
      base,
      topHeight,
      segments,
      landings: landingSegments,
    };
    flights.push(flight);
    if (connection) {
      const end = points.at(-1),
        lower = points.at(-2),
        i = Math.max(0, mainArc.findIndex((d) => d >= connection.arc - EPS) - 1),
        a = mainPoints[i],
        b = mainPoints[i + 1];
      const normal = [-(b[1] - a[1]), b[0] - a[0]],
        side = (lower[0] - end[0]) * normal[0] + (lower[1] - end[1]) * normal[1] >= 0 ? 1 : -1;
      gaps.push({
        side,
        from: connection.arc - width / 2 - 0.12,
        to: connection.arc + width / 2 + 0.12,
        sourceRoadId: r.id,
      });
    }
  }
  return {
    flights,
    gaps,
    sharedLanding:
      middle == null || !lower
        ? null
        : {
            point: lower.points.at(-1),
            height: middle,
            road: lower,
            ownerRoadIds: [lower.id, upper?.id, 'osm-way-422813128-0'].filter(Boolean),
          },
  };
}

/** Pure source owner, surface and solid model; constructing it creates no GPU objects. */
export function createNorthBowOverpass(data, context = {}) {
  const road = (data.roads || []).find((r) => r.id === NORTH_BOW_OVERPASS_ID);
  if (!road || !road.bridge || road.tunnel || road.kind !== 'cycleway' || road.points.length < 3) return null;
  if (road.points.some((p) => !Array.isArray(p) || !p.every(Number.isFinite))) return null;
  const points = road.points.map((p) => [...p]),
    arc = cumulative(points),
    length = arc.at(-1);
  if (length < 100 || length > 240) return null; // A changed source needs re-audit, not an accidental reused model.
  if (
    points.length !== evidence.mappedDeckGroundSamples.length ||
    points.some((p, i) => len(p, evidence.mappedDeckGroundSamples[i].point) > 0.01)
  )
    return null;
  const byId = new Map((data.roads || []).map((r) => [r.id, r]));
  for (const profile of evidence.bankSurfaceProfiles || []) {
    const source = byId.get(profile.roadId),
      first = source?.points.findIndex((p) => len(p, profile.samples[0].point) < 0.01);
    if (
      source?.bridge ||
      source?.tunnel ||
      !['cycleway', 'footway', 'path', 'pedestrian'].includes(source?.kind) ||
      Number(source?.layer || 0) !== 0 ||
      first == null ||
      first < 0 ||
      profile.samples.some(
        (s, i) => !source.points[first + i] || len(source.points[first + i], s.point) >= 0.01,
      )
    )
      return null;
  }
  for (const connection of evidence.bridgeBankConnections || []) {
    const source = byId.get(connection.roadId);
    if (
      !source?.bridge ||
      source.tunnel ||
      source.kind !== 'cycleway' ||
      ![source.points[0], source.points.at(-1)].some((p) => len(p, connection.point) < 0.01)
    )
      return null;
  }
  const width = NORTH_BOW_OVERPASS_LIMITS.width,
    half = width / 2,
    thickness = NORTH_BOW_OVERPASS_LIMITS.deckThickness;
  const ground = context.groundHeightAt || context.pathGroundHeight || (() => 0.14);
  const safeGround = (x, z) => {
    const y = ground(x, z);
    return Number.isFinite(y) ? y : 0.14;
  };
  const roadIndex = context.roadIndex || makeRoadIndex(data.roads || []);
  const baseline = safeGround(...evidence.anchors.southLowerStair.point);
  const anchors = Object.fromEntries(
    Object.entries(evidence.anchors).map(([name, anchor]) => [
      name,
      {
        ...anchor,
        height: baseline + anchor.offsetFromSouthLowerStair,
      },
    ]),
  );
  const startHeight = anchors.southAbutment.height,
    endHeight = anchors.northAbutment.height;
  const bankProfiles = (evidence.bankSurfaceProfiles || []).map((profile) => ({
    roadId: profile.roadId,
    samples: profile.samples.map((sample) => ({
      ...sample,
      height: baseline + sample.offsetFromSouthLowerStair,
    })),
  }));
  const bridgeConnections = (evidence.bridgeBankConnections || []).map((connection) => {
    const profile = bankProfiles.find((p) => p.roadId === connection.profileRoadId),
      sample = profile.samples.find((p) => len(p.point, connection.point) < 0.01);
    return { roadId: connection.roadId, point: connection.point, height: sample.height };
  });
  // The straight mapped span crosses Memorial between source vertices10/11.
  // The primary inventory's measured clearance is relative to that road; the
  // flat-scene road datum and slab depth are explicitly separate inferences.
  const spanRoadHeight = context.roadHeightAt
    ? Math.max(
        NORTH_BOW_OVERPASS_LIMITS.inferredRoadLevel,
        ...[0.2, 0.5, 0.8]
          .map((t) => {
            const p = at(points[10], points[11], t);
            return context.roadHeightAt(...p, roadIndex.nearest(...p, true, 24)?.road);
          })
          .filter(Number.isFinite),
      )
    : NORTH_BOW_OVERPASS_LIMITS.inferredRoadLevel;
  const crest = spanRoadHeight + NORTH_BOW_OVERPASS_LIMITS.measuredClearanceOver + thickness;
  const southLanding = baseline + 26 * NORTH_BOW_OVERPASS_LIMITS.southRiser;
  const controls = [
    [0, startHeight],
    [arc[8] - 2.3, southLanding],
    [arc[8] + 2.3, southLanding],
    [arc[10], crest],
    [arc[11] + 2.3, crest],
    [length, endHeight],
  ];
  const heightAtArc = (distance) => {
    const target = clamp(distance, 0, length);
    for (let i = 1; i < controls.length; i++)
      if (target <= controls[i][0] + EPS) {
        const [a, h0] = controls[i - 1],
          [b, h1] = controls[i];
        return mix(h0, h1, northBowRampEase((target - a) / (b - a)));
      }
    return endHeight;
  };
  const stairGround = (x, z) => {
    for (const name of ['southLowerStair', 'southHigherStair', 'northLowerStair']) {
      const anchor = anchors[name];
      if (Math.hypot(x - anchor.point[0], z - anchor.point[1]) < 0.01) return anchor.height;
    }
    return safeGround(x, z);
  };
  const bankAccess = createNorthBowAccess(data, {
    roadIndex,
    seeds: [
      anchors.southAbutment,
      anchors.northAbutment,
      anchors.southHigherStair,
      anchors.northLowerStair,
      ...bankProfiles.flatMap((p) => p.samples),
    ],
    profiles: bankProfiles,
    groundHeightAt: safeGround,
    maxGrade: NORTH_BOW_OVERPASS_LIMITS.bankAccessMaxGrade,
    pieceLength: NORTH_BOW_OVERPASS_LIMITS.pieceLength,
  });
  const normals = points.map((p, i) => {
    const prev = i ? points[i - 1] : p,
      next = i < points.length - 1 ? points[i + 1] : p;
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
      n = Math.hypot(nx, nz);
    if (n < EPS) {
      nx = -az;
      nz = ax;
      n = 1;
    }
    nx /= n;
    nz /= n;
    const factor = Math.min(1.6, 1 / Math.max(0.35, nx * -az + nz * ax));
    return [nx * factor, nz * factor];
  });
  const stations = [];
  for (let i = 1; i < points.length; i++) {
    const pieces = Math.max(1, Math.ceil((arc[i] - arc[i - 1]) / NORTH_BOW_OVERPASS_LIMITS.pieceLength));
    const fractions = [
      ...Array.from({ length: pieces }, (_, j) => j / pieces),
      ...controls
        .filter(([d]) => d > arc[i - 1] + EPS && d < arc[i] - EPS)
        .map(([d]) => (d - arc[i - 1]) / (arc[i] - arc[i - 1])),
    ].sort((a, b) => a - b);
    for (const t of fractions) {
      const p = at(points[i - 1], points[i], t),
        a = mix(arc[i - 1], arc[i], t),
        n = at(normals[i - 1], normals[i], t);
      stations.push({ point: p, arc: a, height: heightAtArc(a), normal: n, sourceSegmentIndex: i - 1 });
    }
  }
  stations.push({
    point: points.at(-1),
    arc: length,
    height: endHeight,
    normal: normals.at(-1),
    sourceSegmentIndex: points.length - 2,
  });
  const pointAtArc = (distance) => {
    const target = clamp(distance, 0, length);
    for (let i = 1; i < arc.length; i++)
      if (arc[i] >= target - EPS) {
        const t = (target - arc[i - 1]) / (arc[i] - arc[i - 1]);
        return {
          point: at(points[i - 1], points[i], t),
          normal: at(normals[i - 1], normals[i], t),
          height: heightAtArc(target),
          arc: target,
        };
      }
    return stations.at(-1);
  };
  const edge = (s, side, offset = half) => [
    s.point[0] + s.normal[0] * side * offset,
    s.height,
    s.point[1] + s.normal[1] * side * offset,
  ];
  const stairAccess = createStairFlights(data, points, arc, heightAtArc, stairGround);
  const guardOpen = (side, from, to) =>
    stairAccess.gaps.some((g) => g.side === side && g.from < to && g.to > from);
  const guardRuns = (side, from, to) => {
    let runs = [[from, to]];
    for (const gap of stairAccess.gaps)
      if (gap.side === side)
        runs = runs.flatMap(([a, b]) =>
          gap.to <= a || gap.from >= b
            ? [[a, b]]
            : [
                [a, Math.min(b, gap.from)],
                [Math.max(a, gap.to), b],
              ].filter(([x, y]) => y - x > 0.005),
        );
    return runs;
  };
  const slabs = [],
    segments = [],
    guards = [];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1],
      b = stations[i],
      top = [edge(a, -1), edge(b, -1), edge(b, 1), edge(a, 1)];
    const slab = quadPrism(`north-bow-deck-${i - 1}`, top, -thickness, 0, 'bridge-deck');
    slabs.push(slab);
    segments.push({
      a: a.point,
      b: b.point,
      h0: a.height,
      h1: b.height,
      top,
      slab,
      arc0: a.arc,
      arc1: b.arc,
      width,
      road,
    });
    for (const side of [-1, 1])
      for (const [from, to] of guardRuns(side, a.arc, b.arc)) {
        const q = [edge(pointAtArc(from), side, half - 0.06), edge(pointAtArc(to), side, half - 0.06)],
          dx = q[1][0] - q[0][0],
          dz = q[1][2] - q[0][2],
          l = Math.hypot(dx, dz),
          nx = (-dz / l) * 0.06,
          nz = (dx / l) * 0.06;
        const guardTop = [
          [q[0][0] + nx, q[0][1], q[0][2] + nz],
          [q[1][0] + nx, q[1][1], q[1][2] + nz],
          [q[1][0] - nx, q[1][1], q[1][2] - nz],
          [q[0][0] - nx, q[0][1], q[0][2] - nz],
        ];
        guards.push(
          quadPrism(
            `north-bow-guard-${side}-${i - 1}-${from}`,
            guardTop,
            0.06,
            NORTH_BOW_OVERPASS_LIMITS.guardHeight,
            'bridge-guardrail',
          ),
        );
      }
  }
  const columns = [];
  const safeColumn = (p) => {
    for (const s of roadIndex.index.near(...p, 12)) {
      if (s.road.id === road.id || s.road.bridge || s.road.tunnel || Number(s.road.layer) > 0) continue;
      const limit = roadWidth(s.road) / 2 + (DRIVABLE.has(s.road.kind) ? 0.8 : 0.45);
      if (nearestOnSegment(...p, s.a, s.b).distance < limit) return false;
    }
    return true;
  };
  // Source establishes paired round columns, not their survey positions. Keep
  // inferred stations away from all mapped ground carriageways and path tops.
  for (const d of [24, 43, 62, 117, 136, 149]) {
    if (d >= length - 8) continue;
    const s = pointAtArc(d);
    const pair = [
      [-0.65, 0.65],
      [0.65, 1.1],
      [-0.65, -1.1],
    ]
      .map((offsets) =>
        offsets.map((offset) => [s.point[0] + s.normal[0] * offset, s.point[1] + s.normal[1] * offset]),
      )
      .find((points) => points.every(safeColumn));
    if (s.height < 1 || !pair) continue;
    for (const [j, p] of pair.entries()) {
      const base = safeGround(...p),
        top = s.height - thickness - 0.05;
      if (top - base < 0.7) continue;
      const ring = Array.from({ length: 10 }, (_, i) => [
        p[0] + Math.cos((i * Math.PI) / 5) * NORTH_BOW_OVERPASS_LIMITS.columnRadius,
        p[1] + Math.sin((i * Math.PI) / 5) * NORTH_BOW_OVERPASS_LIMITS.columnRadius,
      ]);
      ring.push([...ring[0]]);
      columns.push({
        id: `north-bow-pier-${d}-${j}`,
        type: 'bridge-pier',
        ring,
        minHeight: base,
        height: top,
        x: p[0],
        z: p[1],
        radius: NORTH_BOW_OVERPASS_LIMITS.columnRadius,
        sourceRoadId: road.id,
        inferredDimensions: true,
        inferredLocation: true,
        storefrontAnchor: false,
      });
    }
  }
  const ownedIds = new Set([road.id, ...stairAccess.flights.map((f) => f.road.id), ...bankAccess.fullyOwned]);
  const sourceSupportedIds = new Set([...ownedIds, ...bankAccess.byRoad.keys()]);
  const stairSegments = stairAccess.flights.flatMap((f) => f.segments);
  const landings = stairAccess.flights.flatMap((f) => f.landings);
  if (stairAccess.sharedLanding) {
    const l = stairAccess.sharedLanding,
      [x, z] = l.point,
      r = 0.65;
    const top = [
      [x - r, l.height, z - r],
      [x + r, l.height, z - r],
      [x + r, l.height, z + r],
      [x - r, l.height, z + r],
    ];
    const slab = quadPrism('north-bow-stair-shared-landing', top, -0.24, 0, 'bridge-stair-landing');
    slab.sourceRoadId = l.road.id;
    landings.push({
      a: [x - r, z],
      b: [x + r, z],
      h0: l.height,
      h1: l.height,
      top,
      slab,
      width: r * 2,
      road: l.road,
      ownerRoadIds: l.ownerRoadIds,
      landing: true,
    });
  }
  for (const [i, s] of bankAccess.segments.entries()) {
    s.base0 = safeGround(...s.a);
    s.base1 = safeGround(...s.b);
    s.slab = quadPrism(`north-bow-bank-access-${s.road.id}-${i}`, s.top, -0.08, 0, 'bridge-bank-access');
    // This is a ground-path bank attachment, not another flyover. Fill only its
    // narrow source path footprint down to existing ground, preserving the
    // adjacent river-path underpass and every unrelated layered crossing.
    s.slab.minHeight = Math.min(safeGround(...s.a), safeGround(...s.b)) - 0.08;
    s.slab.minHeightAt = (x, z) => safeGround(x, z) - 0.08;
    s.slab.sourceRoadId = s.road.id;
    slabs.push(s.slab);
  }
  const stairGuards = [];
  for (const flight of stairAccess.flights)
    for (const s of flight.segments)
      for (const side of [-1, 1]) {
        const l = len(s.a, s.b),
          nx = -(s.b[1] - s.a[1]) / l,
          nz = (s.b[0] - s.a[0]) / l,
          offset = side * (s.width / 2 - 0.03),
          w = 0.06;
        const a = [s.a[0] + nx * offset, s.a[1] + nz * offset],
          b = [s.b[0] + nx * offset, s.b[1] + nz * offset];
        const top = [
          [a[0] + nx * w, s.previousHeight, a[1] + nz * w],
          [b[0] + nx * w, s.h1, b[1] + nz * w],
          [b[0] - nx * w, s.h1, b[1] - nz * w],
          [a[0] - nx * w, s.previousHeight, a[1] - nz * w],
        ];
        const guard = quadPrism(
          `north-bow-stair-guard-${s.road.id}-${side}-${s.stepIndex}`,
          top,
          0.08,
          1.1,
          'bridge-stair-guardrail',
        );
        guard.sourceRoadId = s.road.id;
        guard.railEdge = [
          [a[0], s.previousHeight, a[1]],
          [b[0], s.h1, b[1]],
        ];
        guard.stepIndex = s.stepIndex;
        stairGuards.push(guard);
      }
  const querySegments = [...segments, ...stairSegments, ...landings, ...bankAccess.segments];
  const queryBounds = bounds(querySegments.flatMap((s) => s.top.map((p) => [p[0], p[2]])));
  const query = (x, z, owner, elevationHint) => {
    const requestedId = owner && (typeof owner === 'string' ? owner : owner.id);
    if (requestedId && !sourceSupportedIds.has(requestedId)) return null;
    if (x < queryBounds.minX || x > queryBounds.maxX || z < queryBounds.minZ || z > queryBounds.maxZ)
      return null;
    let best = null,
      bank = null;
    for (const s of querySegments) {
      if (requestedId && s.road.id !== requestedId && !s.ownerRoadIds?.includes(requestedId)) continue;
      const h = quadHeight(s.top, x, z);
      if (
        h === null ||
        (Number.isFinite(elevationHint) && h > elevationHint + NORTH_BOW_OVERPASS_LIMITS.stepUp)
      )
        continue;
      const score = Number.isFinite(elevationHint)
        ? Math.abs(elevationHint - h)
        : nearestOnSegment(x, z, s.a, s.b).distance;
      const result = { height: h, score, segment: s };
      if (s.bankAccess) {
        // Overlapping pieces belong to one rendered bank field. Selecting its
        // lower piece can leave feet inside the higher piece's visible side.
        if (!bank || h > bank.height) bank = result;
      } else if (best === null || score < best.score) best = result;
    }
    return bank && (!best || bank.score < best.score) ? bank : best;
  };
  const bankIndex = new SpatialIndex(12),
    deckIndex = new SpatialIndex(12);
  for (const s of bankAccess.segments) bankIndex.insert(s, bounds(s.top.map((p) => [p[0], p[2]])));
  for (const s of segments) deckIndex.insert(s, bounds(s.top.map((p) => [p[0], p[2]])));
  const indexedHeight = (index, x, z) => {
    let support = null;
    for (const s of index.near(x, z)) {
      const h = quadHeight(s.top, x, z);
      if (h != null) support = Math.max(support ?? -Infinity, h);
    }
    return support;
  };
  for (const s of bankAccess.segments) {
    const original = s.slab.heightAt;
    s.slab.heightAt = (x, z) => {
      const support = indexedHeight(bankIndex, x, z);
      // A cylinder touching a neighbouring ramp piece must not hit an invented
      // clamped end wall while its centre already stands on that same connected
      // ground-path surface. Actual outer bank sides remain solid.
      return support ?? original(x, z);
    };
  }
  for (const s of segments) {
    const original = s.slab.heightAt;
    s.slab.heightAt = (x, z) => {
      const own = indexedHeight(deckIndex, x, z);
      if (own != null) return own;
      // A bicycle's circular footprint also straddles slab seams. At an actual
      // endpoint only, its adjoining bank is the same continuously joined floor.
      if (
        Math.min(
          Math.hypot(x - points[0][0], z - points[0][1]),
          Math.hypot(x - points.at(-1)[0], z - points.at(-1)[1]),
        ) < 2
      ) {
        const bank = indexedHeight(bankIndex, x, z),
          top = original(x, z);
        if (bank != null && Math.abs(bank - top) < 0.2) return bank;
      }
      return original(x, z);
    };
  }
  let maxGrade = 0;
  for (const s of segments) maxGrade = Math.max(maxGrade, Math.abs(s.h1 - s.h0) / len(s.a, s.b));
  return {
    id: road.id,
    road,
    points,
    length,
    width,
    stations,
    segments,
    slabs: [...slabs, ...stairSegments.map((s) => s.slab), ...landings.map((s) => s.slab)],
    guards,
    columns,
    stairs: stairAccess.flights,
    landings,
    stairGuards,
    guardOpen,
    guardRuns,
    railOpenings: stairAccess.gaps,
    ownedIds,
    sourceSupportedIds,
    accessSegments: bankAccess.segments,
    accessFields: bankAccess.fields,
    unownedRuns: (r) => (ownedIds.has(r.id) ? [] : bankAccess.unownedRuns(r)),
    bankAnchors: anchors,
    bankProfiles,
    bridgeConnections,
    profileControls: controls,
    mainSpan: { startArc: arc[10], endArc: arc[11], height: crest },
    barriers: [...guards, ...stairGuards, ...columns],
    colliders: [...guards, ...stairGuards, ...columns],
    bounds: bounds(points),
    source: NORTH_BOW_OVERPASS_SOURCE,
    heightAtArc,
    pointAtArc,
    ownsRoad: (r) => ownedIds.has(typeof r === 'string' ? r : r?.id),
    surfaceHeight: (x, z, owner) => query(x, z, owner)?.height ?? null,
    groundHeight: (x, z, hint) => query(x, z, null, hint)?.height ?? null,
    surfaceAt: (x, z, hint) => query(x, z, null, hint),
    stats: {
      sourceRoads: ownedIds.size,
      partiallyOwnedSourceRoads: sourceSupportedIds.size - ownedIds.size,
      bankAccessRoads: bankAccess.byRoad.size,
      bankAccessSegments: bankAccess.segments.length,
      bankAccessLengthM: bankAccess.sourceLength,
      sourceVertices: points.length,
      lengthM: length,
      walkableSegments: segments.length + stairSegments.length + bankAccess.segments.length + landings.length,
      stairFlights: stairAccess.flights.length,
      stairSteps: stairSegments.length,
      stairLandings: landings.length,
      guardSolids: guards.length + stairGuards.length,
      columnSolids: columns.length,
      maxGrade,
      deckThickness: thickness,
      inferredPeakHeight: crest,
      measuredClearanceOver: NORTH_BOW_OVERPASS_LIMITS.measuredClearanceOver,
      clearanceSourceField: 'Meas VCL Over',
      groundSourceTile: evidence.sourceGround.tile,
      widthMeasured: false,
      elevationsMeasured: false,
      columnPositionsMeasured: false,
      sourceOnlyReview: true,
    },
  };
}

/** Construction-time attachment, shared with the offline crossing bake. */
export function attachNorthBowSurfaces(surfaces, model) {
  if (!model) return surfaces;
  const owns = surfaces.ownsRoad.bind(surfaces),
    surface = surfaces.surfaceHeight.bind(surfaces),
    ground = surfaces.groundHeight.bind(surfaces);
  surfaces.ownsRoad = (road) => model.ownsRoad(road) || owns(road);
  surfaces.surfaceHeight = (x, z, road) => model.surfaceHeight(x, z, road) ?? surface(x, z, road);
  surfaces.groundHeight = (x, z, hint) => {
    const a = model.groundHeight(x, z, hint),
      b = ground(x, z, hint);
    if (a == null) return b;
    if (b == null) return a;
    return Number.isFinite(hint) ? (Math.abs(a - hint) < Math.abs(b - hint) ? a : b) : Math.max(a, b);
  };
  return surfaces;
}

class MeshWriter {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.normals = [];
    this.color = new THREE.Color();
    this.cache = new Map();
  }
  tri(a, b, c, tint) {
    const u = b.map((n, i) => n - a[i]),
      v = c.map((n, i) => n - a[i]),
      normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      l = Math.hypot(...normal);
    if (l < 1e-10) return;
    let rgb = this.cache.get(tint);
    if (!rgb) {
      this.color.setHex(tint);
      rgb = [this.color.r, this.color.g, this.color.b];
      this.cache.set(tint, rgb);
    }
    for (const p of [a, b, c]) {
      this.positions.push(...p);
      this.normals.push(...normal.map((n) => n / l));
      this.colors.push(...rgb);
    }
  }
  quad(a, b, c, d, tint) {
    this.tri(a, b, c, tint);
    this.tri(a, c, d, tint);
  }
  surface(q, tint, up) {
    const a = q[0].map((n, i) => (n + q[3][i]) / 2),
      b = q[1].map((n, i) => (n + q[2][i]) / 2);
    for (const p of [
      [q[0], q[1], b],
      [q[0], b, a],
      [a, b, q[2]],
      [a, q[2], q[3]],
    ])
      this.tri(p[0], p[up ? 2 : 1], p[up ? 1 : 2], tint);
  }
  beam(a, b, radius, tint, sides = 6) {
    const d = b.map((n, i) => n - a[i]),
      l = Math.hypot(...d);
    if (l < 0.001) return;
    for (let i = 0; i < 3; i++) d[i] /= l;
    let u = Math.abs(d[1]) < 0.9 ? [-d[2], 0, d[0]] : [0, d[2], -d[1]],
      ul = Math.hypot(...u);
    u = u.map((n) => n / ul);
    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]],
      rings = [a, b].map((p) =>
        Array.from({ length: sides }, (_, j) =>
          p.map(
            (n, i) =>
              n +
              radius *
                (u[i] * Math.cos((j * Math.PI * 2) / sides) + v[i] * Math.sin((j * Math.PI * 2) / sides)),
          ),
        ),
      );
    for (let j = 0; j < sides; j++) {
      const k = (j + 1) % sides;
      this.quad(rings[0][j], rings[0][k], rings[1][k], rings[1][j], tint);
    }
    for (let j = 1; j < sides - 1; j++) {
      this.tri(rings[0][0], rings[0][j + 1], rings[0][j], tint);
      this.tri(rings[1][0], rings[1][j], rings[1][j + 1], tint);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Two bounded meshes: concrete/frames, and nearby open wire geometry. */
export function buildNorthBowOverpass(scene, model, options = {}) {
  if (!model) return null;
  const body = new MeshWriter(),
    wire = new MeshWriter(),
    thickness = NORTH_BOW_OVERPASS_LIMITS.deckThickness;
  for (const s of model.segments) {
    const q = s.top,
      b = q.map((p) => [p[0], p[1] - thickness, p[2]]);
    body.surface(q, PALETTE.concrete, true);
    body.surface(b, PALETTE.concrete, false);
    for (const [i, j] of [
      [0, 1],
      [2, 3],
    ])
      body.quad(q[i], q[j], b[j], b[i], PALETTE.edge);
  }
  for (const [s, indices] of [
    [model.segments[0], [3, 0]],
    [model.segments.at(-1), [1, 2]],
  ]) {
    const q = s.top,
      a = q[indices[0]],
      b = q[indices[1]];
    body.quad(a, b, [b[0], b[1] - thickness, b[2]], [a[0], a[1] - thickness, a[2]], PALETTE.concrete);
  }
  for (const s of model.accessSegments) {
    const q = s.top,
      b = q.map((p, i) => [p[0], (i === 0 || i === 3 ? s.base0 : s.base1) - 0.08, p[2]]);
    const tint = (s.road.surface || s.road.sourceTags?.surface) === 'asphalt' ? 0x535a59 : PALETTE.concrete;
    body.surface(q, tint, true);
    for (const [i, j] of [
      [0, 1],
      [2, 3],
    ])
      body.quad(q[i], q[j], b[j], b[i], 0x827f69);
  }
  for (const flight of model.stairs) {
    for (const s of flight.segments) {
      const q = s.top,
        b = q.map((p, i) => [p[0], (i === 0 || i === 3 ? s.previousHeight : s.h1) - 0.24, p[2]]);
      body.surface(q, PALETTE.concrete, true);
      body.surface(b, PALETTE.concrete, false);
      for (const [i, j] of [
        [0, 1],
        [2, 3],
      ])
        body.quad(q[i], q[j], b[j], b[i], PALETTE.edge);
      const below = s.stepIndex ? s.previousHeight : s.previousHeight - 0.24;
      body.quad(q[3], q[0], [q[0][0], below, q[0][2]], [q[3][0], below, q[3][2]], PALETTE.edge);
    }
  }
  for (const landing of model.landings) {
    const q = landing.top,
      b = q.map((p) => [p[0], p[1] - 0.24, p[2]]);
    body.surface(q, PALETTE.concrete, true);
    body.surface(b, PALETTE.concrete, false);
    for (let i = 0; i < 4; i++) body.quad(q[i], q[(i + 1) % 4], b[(i + 1) % 4], b[i], PALETTE.edge);
  }
  for (const guard of model.stairGuards) {
    const [a, b] = guard.railEdge;
    for (const h of [0.12, 0.64, 1.1])
      body.beam([a[0], a[1] + h, a[2]], [b[0], b[1] + h, b[2]], 0.026, PALETTE.guard, 6);
    if (guard.stepIndex % 3 === 0)
      body.beam([a[0], a[1] + 0.05, a[2]], [a[0], a[1] + 1.13, a[2]], 0.035, PALETTE.guard, 6);
  }
  for (const c of model.columns) {
    body.beam([c.x, c.minHeight, c.z], [c.x, c.height, c.z], c.radius, PALETTE.concrete, 10);
    body.beam([c.x, c.height - 0.08, c.z], [c.x, c.height + 0.05, c.z], c.radius * 1.2, PALETTE.edge, 10);
  }
  const half = model.width / 2 - 0.06,
    H = NORTH_BOW_OVERPASS_LIMITS.guardHeight;
  const railPoint = (s, side, height) => [
    s.point[0] + s.normal[0] * side * half,
    s.height + height,
    s.point[1] + s.normal[1] * side * half,
  ];
  for (const side of [-1, 1]) {
    for (let i = 1; i < model.stations.length; i++)
      for (const [from, to] of model.guardRuns(side, model.stations[i - 1].arc, model.stations[i].arc))
        for (const h of [0.14, 0.65, H])
          body.beam(
            railPoint(model.pointAtArc(from), side, h),
            railPoint(model.pointAtArc(to), side, h),
            h === H ? 0.032 : 0.021,
            PALETTE.guard,
            6,
          );
    const sourceArcs = cumulative(model.points),
      posts = [
        0,
        model.length,
        ...sourceArcs.slice(1, -1),
        ...model.railOpenings.filter((g) => g.side === side).flatMap((g) => [g.from, g.to]),
      ];
    for (let d = 2; d < model.length; d += 2) posts.push(d);
    posts.sort((a, b) => a - b);
    const unique = posts.filter((d, i) => !i || d - posts[i - 1] > 0.12);
    for (const d of unique) {
      if (model.railOpenings.some((g) => g.side === side && d > g.from + 0.002 && d < g.to - 0.002)) continue;
      const s = model.pointAtArc(d);
      body.beam(railPoint(s, side, 0.04), railPoint(s, side, H + 0.025), 0.043, PALETTE.guard, 6);
    }
    // Chain-link diamonds are real open struts, never an opaque facade card.
    for (let i = 1; i < unique.length; i++) {
      const d0 = unique[i - 1],
        d1 = unique[i],
        panel = d1 - d0;
      if (panel < 0.12 || model.guardOpen(side, d0 + 0.001, d1 - 0.001)) continue;
      const lo = 0.19,
        hi = H - 0.065;
      for (const slope of [-1, 1])
        for (let c = -panel - hi; c < panel + hi; c += NORTH_BOW_OVERPASS_LIMITS.wireSpacing) {
          let from, to;
          if (slope === 1) {
            from = Math.max(0, lo - c);
            to = Math.min(panel, hi - c);
          } else {
            from = Math.max(0, c - hi);
            to = Math.min(panel, c - lo);
          }
          if (to - from < 0.025) continue;
          const a = model.pointAtArc(d0 + from),
            b = model.pointAtArc(d0 + to);
          wire.beam(
            railPoint(a, side, slope * from + c),
            railPoint(b, side, slope * to + c),
            0.0032,
            PALETTE.wire,
            3,
          );
        }
    }
  }
  const ownMaterial = !options.material,
    material =
      options.material || new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.83 });
  const wireMaterial = options.wireMaterial || material;
  const deck = new THREE.Mesh(body.geometry(), material),
    mesh = new THREE.Mesh(wire.geometry(), wireMaterial);
  deck.name = '9A Street Memorial overpass: source hairpin, inferred concrete deck and round supports';
  deck.castShadow = true;
  deck.receiveShadow = true;
  mesh.name = '9A Street Memorial overpass: photo-supported open blue-green chain-link guards';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  for (const object of [deck, mesh])
    object.userData = { sourceRoadId: model.id, source: NORTH_BOW_OVERPASS_SOURCE, inferredDimensions: true };
  scene.add(deck, mesh);
  const center = [(model.bounds.minX + model.bounds.maxX) / 2, (model.bounds.minZ + model.bounds.maxZ) / 2];
  const update = (camera) => {
    const distance = Math.hypot(camera.position.x - center[0], camera.position.z - center[1]);
    deck.visible = distance < NORTH_BOW_OVERPASS_LIMITS.visibleDistance;
    mesh.visible = distance < NORTH_BOW_OVERPASS_LIMITS.detailDistance && camera.position.y < 180;
  };
  return {
    model,
    mesh: deck,
    wireMesh: mesh,
    meshes: [deck, mesh],
    update,
    stats: {
      ...model.stats,
      baseTriangles: deck.geometry.attributes.position.count / 3,
      wireTriangles: mesh.geometry.attributes.position.count / 3,
      maximumDrawCalls: 2,
    },
    dispose() {
      for (const m of [deck, mesh]) {
        scene.remove(m);
        m.geometry.dispose();
      }
      if (ownMaterial) material.dispose();
    },
  };
}
