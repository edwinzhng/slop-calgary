import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  color,
  dot,
  float,
  fwidth,
  length,
  max,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  step,
  vec3,
} from 'three/tsl';
import { cityUniforms } from './city-uniforms.js';
import { surfaceMaterial } from './materials.js';
import { streetLightWash } from './street-light-wash.js';
import { signalHeadLayout, signalLensIndex } from './signal-heads.js';
import { InfrastructureCache, mergeInfrastructureStreams } from './infrastructure-cache.js';
import { addStaticBatches } from './static-batches.js';
import { bumpNormal, noise2D } from './render-nodes.js';
import { buildBridgeDetails } from './bridge-lighting.js';
import {
  bridgeGuardStyle,
  bridgeGuardOffset,
  bridgeGuardIntervals,
  isBridgeGuardOpen,
  cableStayLayout,
  concreteArchRibOffset,
  collectBridgeConnections,
  drawBridgeConnection,
  trussHalfWidth,
  suspensionCableHeight,
  suspensionCableSamples,
} from './bridge-connections.js';
import { createPeaceBridgeSurfaces } from './peace-surfaces.js';
import { createMemorialUnderpass } from './memorial-underpass.js';
import { bridgePath, bridgePathPoint, bridgeBand, BRIDGE_BAND_TRIANGLES } from './bridge-path.js';
import { createBridgeDeck } from './bridge-deck.js';
import { RAIL_PROFILE, railGuidewayFinish } from './rail-guideways.js';
import { observedBridgeGuardProfile, bridgeGuardCapStations } from './bridge-guard-finishes.js';
import { connectBridgeForks } from './bridge-forks.js';
import { createBridgeAccessBranches } from './bridge-access.js';
import { NORTH_BOW_OVERPASS_ID } from './north-bow-overpass.js';
import {
  bounds,
  DRIVABLE,
  inPolygon,
  makeRoadIndex,
  nearestOnSegment,
  project,
  roadWidth,
  SpatialIndex,
} from './geo.js';

// Geometry is georeferenced to the mapped street centre lines. Dimensions that
// are not present in the source are design inferences, not an asset inventory.
export const INFRASTRUCTURE_LIMITS = Object.freeze({
  tileSize: 200,
  staticTileSize: 1000,
  balancedTiles: 8,
  highTiles: 14,
  balancedFurniture: 180,
  highFurniture: 320,
  balancedRadius: 430,
  highRadius: 650,
  curbHeight: 0.15,
  sidewalkWidth: 2.1,
  roadLevel: 0.16,
  pathLevel: 0.14,
  skywalkLevel: 4.75,
  balancedSignals: 40,
  highSignals: 72,
});

const palette = {
  sidewalk: 0xb8b6ab,
  curb: 0xc7c5bb,
  gutter: 0x9c9f98,
  joint: 0x858a82,
  asphalt: 0x555a59,
  paint: 0xe7e3cf,
  concrete: 0xbcbcaf,
  concreteDark: 0x969c94,
  steel: 0x5a655f,
  truss: 0x60736d,
  whiteSteel: 0xdce0d7,
  weathering: 0x785447,
  wood: 0x957852,
  dark: 0x3e4b47,
  tactile: 0xbca76e,
  glass: 0x708e8d,
  skywalk: 0xa0a9a1,
  brass: 0xa99161,
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const normName = (name = '') =>
  name
    .toLowerCase()
    .replace(/\b[ns][ew]?\b/g, '')
    .replace(/[^a-z0-9]/g, '');
const finitePoint = (p) => p?.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const validPoints = (points = []) =>
  points.filter(finitePoint).filter((p, i, a) => !i || distance(p, a[i - 1]) > 0.01);
const pointBox = (x, z, r = 0) => ({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const polylineCache = new WeakMap(),
  linearColors = new Map();

function segmentCrossParameters(a, b, c, d) {
  const u = [b[0] - a[0], b[1] - a[1]],
    v = [d[0] - c[0], d[1] - c[1]],
    den = cross(u, v);
  if (Math.abs(den) < 1e-8) return null;
  const q = [c[0] - a[0], c[1] - a[1]],
    t = cross(q, v) / den,
    s = cross(q, u) / den;
  return {
    t,
    s,
    point: lerp(a, b, t),
    sine: Math.abs(den) / (Math.hypot(...u) * Math.hypot(...v)),
  };
}

export function segmentIntersection(a, b, c, d) {
  const result = segmentCrossParameters(a, b, c, d);
  if (!result || result.t < -0.005 || result.t > 1.005 || result.s < -0.005 || result.s > 1.005) return null;
  return { ...result, t: clamp(result.t, 0, 1), s: clamp(result.s, 0, 1) };
}

export function subtractIntervals(length, blocked) {
  const merged = [];
  for (const [a, b] of blocked
    .map(([a, b]) => [clamp(a, 0, length), clamp(b, 0, length)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])) {
    if (merged.length && a <= merged.at(-1)[1] + 0.05) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b);
    else merged.push([a, b]);
  }
  const result = [];
  let last = 0;
  for (const [a, b] of merged) {
    if (a - last > 0.3) result.push([last, a]);
    last = Math.max(last, b);
  }
  if (length - last > 0.3) result.push([last, length]);
  return result;
}

// Intersect the actual neighbouring carriageway corridors. This removes raised
// curbs across junctions and avoids the common "sidewalk stripe through traffic"
// artifact caused by simply offsetting every road polyline.
export function sidewalkIntervals(segment, roadIndex) {
  const { a, b, road } = segment,
    len = distance(a, b);
  if (len < 0.5) return [];
  const blocked = [];
  for (const other of roadIndex.index.near((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, len / 2 + 22)) {
    if (
      other === segment ||
      other.road === road ||
      other.road.bridge ||
      other.road.tunnel ||
      !DRIVABLE.has(other.road.kind)
    )
      continue;
    const hit = segmentCrossParameters(a, b, other.a, other.b);
    if (!hit || hit.s < -0.005 || hit.s > 1.005 || hit.sine < 0.34) continue;
    const margin = (other.width / 2 + 1.3) / hit.sine;
    blocked.push([hit.t * len - margin, hit.t * len + margin]);
  }
  return subtractIntervals(len, blocked);
}

// Raised path handrails must open where another mapped path actually joins.
// Test the offset rail itself: a T branch opens the joining side while leaving
// the opposite bank-side rail intact. Unrelated lower paths keep their rail.
export function approachRailIntervals(segment, side, width, surfaces) {
  const { a, b, road, h0, h1 } = segment,
    len = distance(a, b);
  if (len < 0.5) return [];
  const dx = (b[0] - a[0]) / len,
    dz = (b[1] - a[1]) / len,
    offset = side * (width / 2 - 0.1),
    railA = [a[0] - dz * offset, a[1] + dx * offset],
    railB = [b[0] - dz * offset, b[1] + dx * offset],
    blocked = [];
  for (const other of surfaces.roadIndex.index.near((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, len / 2 + 16)) {
    if (
      other.road === road ||
      other.road.id === road.id ||
      other.road.tunnel ||
      other.road.kind === 'corridor'
    )
      continue;
    const hit = segmentCrossParameters(railA, railB, other.a, other.b);
    if (!hit || hit.s < -0.005 || hit.s > 1.005 || hit.sine < 0.34) continue;
    const height = h0 + (h1 - h0) * clamp(hit.t, 0, 1),
      otherHeight = surfaces.surfaceHeight(...hit.point, other.road);
    if (Math.abs(height - otherHeight) > (surfaces.railHeightTolerance ?? 0.45)) continue;
    const otherWidth = surfaces.railWidthFor?.(other.road) ?? other.width,
      margin = (otherWidth / 2 + (DRIVABLE.has(other.road.kind) ? 1.3 : 0.25)) / hit.sine;
    blocked.push([hit.t * len - margin, hit.t * len + margin]);
  }
  return subtractIntervals(len, blocked);
}

export function accessRailIntervals(segment, side, width, surfaces) {
  return approachRailIntervals(segment, side, width, {
    ...surfaces,
    railHeightTolerance: 0.08,
    railWidthFor: (road) => surfaces.byRoad.get(road.id)?.width ?? roadWidth(road),
  });
}

export function samplePolyline(points, t) {
  if (!points.length) return { x: 0, z: 0, dx: 0, dz: 1 };
  if (points.length === 1) return { x: points[0][0], z: points[0][1], dx: 0, dz: 1 };
  let cached = polylineCache.get(points);
  if (!cached) {
    const lengths = points.slice(1).map((p, i) => distance(points[i], p));
    cached = { lengths, total: lengths.reduce((a, b) => a + b, 0) };
    polylineCache.set(points, cached);
  }
  const { lengths, total } = cached;
  let d = clamp(t, 0, 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (d <= lengths[i] || i === lengths.length - 1) {
      const len = lengths[i] || 1,
        q = lerp(points[i], points[i + 1], clamp(d / len, 0, 1));
      return {
        x: q[0],
        z: q[1],
        dx: (points[i + 1][0] - points[i][0]) / len,
        dz: (points[i + 1][1] - points[i][1]) / len,
      };
    }
    d -= lengths[i];
  }
}

const peaceA = project(-114.0794883, 51.0543154),
  peaceB = project(-114.0783324, 51.0535117);
export function isPeaceBridgeRoad(road) {
  if (/peace bridge/i.test(road.name || '')) return true;
  if (DRIVABLE.has(road.kind) || road.kind === 'corridor' || !road.bridge) return false;
  return road.points.some((p) => nearestOnSegment(...p, peaceA, peaceB).distance < 4.5);
}

function roadWaterLength(road, inWater) {
  let total = 0;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1],
      b = road.points[i],
      len = distance(a, b),
      n = Math.max(1, Math.ceil(len / 6));
    for (let j = 0; j < n; j++) {
      const p = lerp(a, b, (j + 0.5) / n);
      if (inWater(...p)) total += len / n;
    }
  }
  return total;
}

function joinRoads(roads, threshold = 2.2) {
  const remaining = roads
      .map((r) => ({ road: r, points: validPoints(r.points) }))
      .filter((r) => r.points.length > 1),
    groups = [];
  while (remaining.length) {
    const first = remaining.shift(),
      group = { roads: [first.road], points: first.points.slice(), joins: [] };
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i],
          options = [
            { left: group.points, right: candidate.points },
            { left: group.points, right: candidate.points.slice().reverse() },
            { left: candidate.points, right: group.points },
            { left: candidate.points.slice().reverse(), right: group.points },
          ];
        if (
          normName(first.road.name) !== normName(candidate.road.name) ||
          Number(first.road.layer || 0) !== Number(candidate.road.layer || 0)
        )
          continue;
        // Proximity alone joins parallel carriageways into a U-shaped bridge.
        // Check both end tangents, and for a survey gap also require the gap
        // itself to continue those tangents. Retain both surveyed endpoints;
        // dropping one used to move the abutment to the next interior vertex.
        const option = options
          .map((o) => {
            const a = o.left.at(-1),
              b = o.right[0],
              gap = distance(a, b),
              u0 = o.left.at(-2),
              v1 = o.right[1],
              ul = distance(u0, a),
              vl = distance(b, v1),
              u = [(a[0] - u0[0]) / ul, (a[1] - u0[1]) / ul],
              v = [(v1[0] - b[0]) / vl, (v1[1] - b[1]) / vl];
            if (gap >= threshold || u[0] * v[0] + u[1] * v[1] < 0.25) return null;
            if (gap > 2.2) {
              const g = [(b[0] - a[0]) / gap, (b[1] - a[1]) / gap];
              if (u[0] * g[0] + u[1] * g[1] < 0.8 || v[0] * g[0] + v[1] * g[1] < 0.8) return null;
            }
            return { ...o, a, b, gap };
          })
          .filter(Boolean)
          .sort((a, b) => a.gap - b.gap)[0];
        if (!option) continue;
        group.points = [...option.left, ...option.right.slice(option.gap < 0.01 ? 1 : 0)];
        if (option.gap > 0.01) group.joins.push({ a: option.a, b: option.b, gap: option.gap });
        group.roads.push(candidate.road);
        remaining.splice(i, 1);
        changed = true;
        break;
      }
    }
    group.length = group.points.slice(1).reduce((v, p, i) => v + distance(group.points[i], p), 0);
    groups.push(group);
  }
  return groups;
}

function bridgeStyle(group) {
  const road = group.roads[0],
    name = normName(road.name),
    middle = samplePolyline(group.points, 0.5);
  if (name.includes('centrestreet') && (Number(road.layer) >= 2 || road.kind === 'secondary'))
    return {
      name: 'Centre Street Bridge',
      type: 'concrete-arch',
      spans: 4,
      level: 8.4,
      lions: true,
      spandrel: 'open',
    };
  if (name.includes('centrestreet'))
    return { name: 'Centre Street lower deck', type: 'girder', spans: 3, level: 3.7 };
  if (name.includes('10street'))
    return { name: 'Louise Bridge', type: 'concrete-arch', spans: 5, level: 5.8 };
  if (name.includes('14street') && middle.z < 0 && middle.z > -700)
    return { name: 'Mewata Bridge', type: 'box-girder', spans: 3, level: 5.5 };
  if (name.includes('4avenue') && middle.x > 1200 && middle.z < -300)
    return { name: 'Reconciliation Bridge', type: 'parker-truss', spans: 2, level: 5.6 };
  if (name.includes('macdonald'))
    return { name: 'MacDonald Bridge', type: 'parker-truss', spans: 1, level: 3.6 };
  if (name.includes('georgecking'))
    return { name: 'George C. King Bridge', type: 'network-arch', spans: 3, level: 4.1 };
  if (name.includes('jaipur'))
    return { name: 'Jaipur Bridge', type: 'jaipur', spans: 1, level: 2.4, width: 6 };
  if (name.includes('princesislandbridge') || name.includes('princeislandbridge'))
    return { name: "Prince's Island Bridge", type: 'cable-stayed', spans: 3, level: 2.9 };
  if (name.includes('elbowrivertraverse'))
    return { name: 'Elbow River Traverse', type: 'weathering-arch', spans: 1, level: 3.1, width: 5.4 };
  if (name.includes('9avenue') && middle.x > 1900)
    return { name: '9 Avenue SE Bridge', type: 'twin-arch', spans: 1, level: 3.7 };
  if (name.includes('rideaubridge'))
    return { name: 'Rideau pedestrian bridge', type: 'suspension', spans: 1, level: 3.5, width: 3.6 };
  if (name.includes('4street') && middle.z > 1400)
    return { name: 'Mission Bridge', type: 'concrete-arch', spans: 4, level: 3.6 };
  if (name.includes('25avenue')) return { name: '25 Avenue SW Bridge', type: 'girder', spans: 4, level: 3.4 };
  const drive = DRIVABLE.has(road.kind);
  return {
    name: road.name || (drive ? 'Mapped road bridge' : 'Mapped pedestrian bridge'),
    type: 'girder',
    spans: Math.max(1, Math.min(5, Math.round(group.length / 45))),
    level: drive ? 4.8 : 2.9,
  };
}

const flyoverWays = new Set([
  'osm-way-11902157-0',
  'osm-way-1097827504-0',
  'osm-way-489583239-0',
  'osm-way-53191498-0',
]);

function sizeRoadDecks(plans) {
  const parallel = (a, b) => {
    if (!a.roads[0].name || normName(a.roads[0].name) !== normName(b.roads[0].name)) return false;
    if (a.roads[0].layer !== b.roads[0].layer || Math.abs(a.level - b.level) > 0.08) return false;
    let separation = Infinity;
    for (const t of [0.2, 0.5, 0.8]) {
      const p = samplePolyline(a.points, t);
      let nearest = Infinity;
      for (let i = 1; i < b.points.length; i++) {
        const u = b.points[i - 1],
          v = b.points[i],
          length = distance(u, v),
          dot = (p.dx * (v[0] - u[0]) + p.dz * (v[1] - u[1])) / length;
        if (Math.abs(dot) < 0.92) continue;
        const q = nearestOnSegment(p.x, p.z, u, v);
        if (q.t > 0.005 && q.t < 0.995) nearest = Math.min(nearest, q.distance);
      }
      if (nearest < 3.5 || nearest > (a.width + b.width) / 2) return false;
      separation = Math.min(separation, nearest);
    }
    return Number.isFinite(separation);
  };
  const divided = plans.filter(
    (plan) =>
      plan.type === 'girder' && plan.roads.every((r) => r.oneway === 'yes' && !Number.isFinite(r.width)),
  );
  const narrow = new Set();
  for (const a of divided)
    for (const b of divided)
      if (a !== b && parallel(a, b)) {
        narrow.add(a);
        narrow.add(b);
      }
  for (const p of plans) {
    if (p.type !== 'girder' || p.name === 'Centre Street lower deck') continue;
    if (
      !narrow.has(p) &&
      !p.roads.some((r) => flyoverWays.has(r.id)) &&
      !p.roads.every((r) => r.sourceTags?.foot === 'no') &&
      !p.roads.every((r) => /^(motorway|trunk)(_link)?$/.test(r.kind))
    )
      continue;
    // Divided decks have a narrow paved edge and barrier. Generating two
    // pedestrian sidewalks per carriageway puts the inner rails in traffic.
    p.compactShoulders = true;
    p.width -= 3.5;
    if (p.roads.length === 1 && p.roads[0].id === 'osm-way-489583239-0') {
      // The short flyover branch needs an outside swept-path margin where
      // the mapped alignment bends beside the diverge.
      p.width += 0.6;
    }
  }
}

function companionFitsDeck(road, plan) {
  if (plan.compactShoulders || road.points.length < 2) return false;
  if (Number(road.layer || 1) !== Number(plan.roads[0].layer || 1)) return false;
  const cap = plan.width / 2 - 0.45;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1],
      b = road.points[i],
      n = Math.max(1, Math.ceil(distance(a, b) / 4));
    for (let j = 0; j <= n; j++) {
      const q = lerp(a, b, j / n);
      if (!plan.points.slice(1).some((end, k) => nearestOnSegment(...q, plan.points[k], end).distance <= cap))
        return false;
    }
  }
  return true;
}

function overlapsRoadDeckEdge(walk, roads) {
  for (let i = 1; i < walk.points.length; i++) {
    const a = walk.points[i - 1],
      b = walk.points[i],
      steps = Math.max(1, Math.ceil(distance(a, b) / 2));
    for (let j = 0; j <= steps; j++) {
      const q = lerp(a, b, j / steps);
      for (const road of roads) {
        // Reconciliation's truss approaches descend within the mapped span.
        // The nominal midspan level cannot establish clearance there.
        if (road.type !== 'parker-truss' && Math.abs(road.level - walk.level) > 2) continue;
        const edge = bridgeGuardOffset(road),
          clearance = walk.width / 2 + 0.4;
        for (let k = 1; k < road.points.length; k++) {
          const at = nearestOnSegment(...q, road.points[k - 1], road.points[k]);
          if (at.distance <= edge + clearance) return true;
        }
      }
    }
  }
  return false;
}

function dryWalkBridge(plan, data, roadIndex, driveIndex, railIndex, existing) {
  if (!plan.roads.every((r) => Number(r.layer) > 0 && ['footway', 'path', 'cycleway'].includes(r.kind)))
    return false;
  plan.rampLength = 45;
  plan.level = 5.4;
  plan.approaches = [...tracedApproach(plan, true, roadIndex), ...tracedApproach(plan, false, roadIndex)];
  configureBridgeProfile(plan, data, existing, roadIndex);
  let checked = 0,
    travelled = 0;
  for (let i = 1; i < plan.points.length; i++) {
    const a = plan.points[i - 1],
      b = plan.points[i],
      length = distance(a, b),
      mid = lerp(a, b, 0.5);
    for (const index of [driveIndex, railIndex]) {
      for (const s of index.index.near(...mid, length / 2 + 2)) {
        const hit = segmentIntersection(a, b, s.a, s.b);
        if (!hit || hit.sine < 0.23 || hit.s <= 0.002 || hit.s >= 0.998) continue;
        if (s.road.bridge || Number(s.road.layer || 0) > 0) return false;
        const station = travelled + length * hit.t,
          extent = (s.width / 2 + 0.5) / hit.sine;
        if (station < extent || station + extent > plan.length) return false;
        if (
          Math.min(
            bridgeDeckHeight(plan, (station - extent) / plan.length),
            bridgeDeckHeight(plan, (station + extent) / plan.length),
          ) < 4.8
        )
          return false;
        checked++;
      }
    }
    travelled += length;
  }
  return (
    checked > 0 &&
    bridgeDeckHeight(plan, 0) < 4.15 &&
    bridgeDeckHeight(plan, 1) < 4.15 &&
    plan.approaches.some((s) => s.approachSide === 'start') &&
    plan.approaches.some((s) => s.approachSide === 'end')
  );
}

function tracedApproach(plan, atStart, roadIndex) {
  const end = samplePolyline(plan.points, atStart ? 0 : 1),
    points = [[end.x, end.z]],
    used = new Set();
  let heading = [end.dx * (atStart ? -1 : 1), end.dz * (atStart ? -1 : 1)],
    length = 0;
  const own = new Set([...plan.roads, ...(plan.companions || [])].map((r) => r.id));
  for (let step = 0; step < 50 && length < plan.rampLength; step++) {
    const here = points.at(-1);
    let best = null;
    for (const s of roadIndex.index.near(...here, 4)) {
      if (
        used.has(s) ||
        own.has(s.road.id) ||
        s.road.tunnel ||
        s.road.kind === 'steps' ||
        s.road.kind === 'corridor' ||
        s.road.bridge ||
        DRIVABLE.has(s.road.kind) !== plan.drive
      )
        continue;
      let next;
      if (distance(here, s.a) < 2.2) next = s.b;
      else if (distance(here, s.b) < 2.2) next = s.a;
      else continue;
      const len = distance(here, next);
      if (len < 0.2) continue;
      const dx = (next[0] - here[0]) / len,
        dz = (next[1] - here[1]) / len,
        dot = dx * heading[0] + dz * heading[1];
      if (dot < 0.15) continue;
      const sameName = normName(s.road.name) === normName(plan.roads[0].name),
        score = dot + (sameName ? 1.6 : 0) - (s.road.kind === 'service' ? 1 : 0);
      if (!best || score > best.score) best = { s, next, len, dx, dz, score };
    }
    if (!best) break;
    used.add(best.s);
    let left = plan.rampLength - length,
      junctionLimited = false;
    if (plan.drive && !plan.rail) {
      const mid = lerp(here, best.next, 0.5);
      for (const crossing of roadIndex.index.near(...mid, best.len / 2 + 20)) {
        if (
          crossing.road === best.s.road ||
          own.has(crossing.road.id) ||
          !DRIVABLE.has(crossing.road.kind) ||
          crossing.road.bridge ||
          crossing.road.tunnel ||
          crossing.road.kind === 'service' ||
          crossing.road.kind.includes('link') ||
          !crossing.road.name ||
          normName(crossing.road.name) === normName(best.s.road.name)
        )
          continue;
        const hit = segmentCrossParameters(here, best.next, crossing.a, crossing.b);
        if (!hit || hit.sine < 0.45 || hit.t < -0.005 || hit.t > 1.005 || hit.s < -0.005 || hit.s > 1.005)
          continue;
        const available = hit.t * best.len - (crossing.width / 2 + 0.8) / hit.sine;
        if (available < left) {
          left = Math.max(0, available);
          junctionLimited = true;
        }
      }
    }
    if (left <= 0.05) break;
    const next = best.len > left ? lerp(here, best.next, left / best.len) : best.next;
    length += distance(here, next);
    points.push(Object.assign(next.slice(), { road: best.s.road }));
    heading = [best.dx, best.dz];
    if (junctionLimited) break;
  }
  const result = [];
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const len = distance(points[i - 1], points[i]);
    // Ease both ends into their horizontal decks. Sampling at <=4m keeps the
    // geometric grade and the navigation/traffic height function in agreement.
    const height = (d) => {
      const u = clamp(d / Math.max(length, 1), 0, 1);
      return plan.level - (plan.level - 0.16) * u * u * (3 - 2 * u);
    };
    const parts = Math.max(1, Math.ceil(len / 4));
    for (let j = 0; j < parts; j++)
      result.push({
        a: lerp(points[i - 1], points[i], j / parts),
        b: lerp(points[i - 1], points[i], (j + 1) / parts),
        h0: height(travelled + (len * j) / parts),
        h1: height(travelled + (len * (j + 1)) / parts),
        distance0: travelled + (len * j) / parts,
        distance1: travelled + (len * (j + 1)) / parts,
        approachLength: length,
        approachSide: atStart ? 'start' : 'end',
        road: points[i].road,
        plan,
        ramp: true,
      });
    travelled += len;
  }
  return result;
}

// Flat city terrain cannot retain a high, constant deck until an abutment only
// a few metres from a ground intersection. Extend the inferred vertical blend
// INTO the mapped bridge instead of raising the neighbouring street block or
// compressing a five-metre drop into a five-metre ramp. This is a display
// profile, not a surveyed vertical alignment; its limits are explicit below.
export function bridgeDeckHeight(plan, t) {
  let height = plan.level;
  for (const side of ['start', 'end']) {
    const profile = plan.verticalProfile?.[side];
    if (!profile) continue;
    const along = (side === 'start' ? t : 1 - t) * plan.length,
      u = clamp((profile.externalLength + along) / profile.transitionLength, 0, 1),
      cap = profile.base + (plan.level - profile.base) * u * u * (3 - 2 * u);
    height = Math.min(height, cap);
  }
  // Adjacent bridge approaches can share one mapped ground way. Their common
  // upper envelope also reaches the physical deck endpoint; preserve that
  // connection inside a short span rather than drawing an invisible step.
  if (plan.sharedEndpointHeights) {
    const grade = plan.verticalProfile?.maxGrade || 0.16;
    if (Number.isFinite(plan.sharedEndpointHeights.start))
      height = Math.max(height, plan.sharedEndpointHeights.start - Math.max(0, t) * plan.length * grade);
    if (Number.isFinite(plan.sharedEndpointHeights.end))
      height = Math.max(height, plan.sharedEndpointHeights.end - Math.max(0, 1 - t) * plan.length * grade);
  }
  if (plan.gradeSeparation) {
    const { station, run, rise } = plan.gradeSeparation;
    const u = Math.max(0, 1 - Math.abs(t * plan.length - station) / run);
    height += rise * u * u * (3 - 2 * u);
  }
  if (plan.terrainEnds)
    height += plan.terrainEnds[0] + (plan.terrainEnds[1] - plan.terrainEnds[0]) * clamp(t, 0, 1);
  return height;
}

function preserveBowTrailRailClearance(plan) {
  if (!plan.rail || !plan.roads.some((r) => r.id === 'osm-way-53529046-0' || r.id === 'osm-way-1225419515-0'))
    return;
  // Photos place the guideway over Bow Trail; the local 2020 elevation bands
  // are about 9.6 m apart. Blend that inferred separation into the existing
  // frame, keeping the added grade below 8% on both sides of the crossing.
  const x = -2459.2559,
    z = 93.17247;
  let best = Infinity,
    station = 0,
    travelled = 0;
  for (let i = 1; i < plan.points.length; i++) {
    const a = plan.points[i - 1],
      b = plan.points[i],
      length = distance(a, b),
      q = nearestOnSegment(x, z, a, b);
    if (q.distance < best) {
      best = q.distance;
      station = travelled + q.t * length;
    }
    travelled += length;
  }
  if (best < 6 && station >= 175 && plan.length - station >= 175)
    plan.gradeSeparation = { station, run: 175, rise: 9 };
}

function configureBridgeProfile(plan, data, otherPlans, approachIndex) {
  const defaultBase = plan.rail
      ? 0.18
      : plan.drive
        ? INFRASTRUCTURE_LIMITS.roadLevel
        : INFRASTRUCTURE_LIMITS.pathLevel,
    maxGrade = plan.rail ? 0.08 : plan.drive ? 0.16 : 0.12;
  plan.verticalProfile = { maxGrade, inferred: true };
  for (const side of ['start', 'end']) {
    const connection = plan.bankConnections?.[side],
      base = connection?.height ?? defaultBase,
      endpoint = side === 'start' ? plan.points[0] : plan.points.at(-1),
      approach = plan.approaches.filter((s) => s.approachSide === side),
      externalLength = approach[0]?.approachLength || 0,
      b = data.meta?.bbox,
      w = b && project(b.west, b.north),
      e = b && project(b.east, b.south),
      cropEdge =
        b &&
        Math.min(
          Math.abs(endpoint[0] - w[0]),
          Math.abs(endpoint[0] - e[0]),
          Math.abs(endpoint[1] - w[1]),
          Math.abs(endpoint[1] - e[1]),
        ) < 0.3,
      connectedDeck = otherPlans.some(
        (other) =>
          other !== plan &&
          other.rail === plan.rail &&
          other.drive === plan.drive &&
          Math.abs(other.level - plan.level) < 0.05 &&
          [other.points[0], other.points.at(-1)].some((p) => distance(p, endpoint) < 0.3),
      ),
      hasGroundConnection = [...approachIndex.index.near(...endpoint, 3)].some(
        (segment) =>
          !segment.road.bridge &&
          !segment.road.tunnel &&
          segment.road.kind !== 'corridor' &&
          (plan.rail
            ? segment.road.kind === plan.roads[0].kind
            : !plan.drive || DRIVABLE.has(segment.road.kind)) &&
          (Math.min(distance(endpoint, segment.a), distance(endpoint, segment.b)) < 2.2 ||
            nearestOnSegment(...endpoint, segment.a, segment.b).distance < 0.2),
      );
    // A cropped viaduct or a contiguous same-level deck continues outside this
    // component. There is no ground handoff to invent at that cut.
    if (!connection && !externalLength && (cropEdge || connectedDeck || !hasGroundConnection)) {
      plan.verticalProfile[`${side}Boundary`] = cropEdge
        ? 'crop'
        : connectedDeck
          ? 'adjacent-deck'
          : 'unconnected-source';
      continue;
    }
    const transitionLength = Math.max(externalLength, (1.5 * (plan.level - base)) / maxGrade, 1);
    plan.verticalProfile[side] = { base, externalLength, transitionLength };
  }
  // Both envelopes may overlap on a short bridge. Evaluate their minimum for
  // the approach as well, otherwise its first vertex can remain several metres
  // above the lowered end of that same deck.
  for (const segment of plan.approaches) {
    const t = (distance) =>
      segment.approachSide === 'start' ? -distance / plan.length : 1 + distance / plan.length;
    segment.h0 = bridgeDeckHeight(plan, t(segment.distance0));
    segment.h1 = bridgeDeckHeight(plan, t(segment.distance1));
  }
}

function approachBranches(plan, ramps, roadIndex, connectedRamps = ramps, data) {
  if (!plan.drive || plan.rail || !ramps.length) return [];
  const own = new Set(
      [...plan.roads, ...(plan.companions || []), ...ramps.map((s) => s.road)].map((r) => r.id),
    ),
    used = new Set(),
    branches = [];
  const heightAt = (point) => {
    for (const s of connectedRamps) {
      if (s.plan.rail || s.plan.drive !== plan.drive) continue;
      const q = nearestOnSegment(...point, s.a, s.b);
      if (q.distance < 0.15) return s.h0 + (s.h1 - s.h0) * q.t;
    }
    return null;
  };
  for (const ramp of ramps) {
    for (const [here, startHeight] of [
      [ramp.a, ramp.h0],
      [ramp.b, ramp.h1],
    ]) {
      if (startHeight < 0.4 || branches.length > 140) continue;
      for (const first of roadIndex.index.near(...here, 2)) {
        if (
          used.has(first) ||
          own.has(first.road.id) ||
          !first.road.kind.includes('link') ||
          first.road.bridge ||
          first.road.tunnel
        )
          continue;
        const next =
          distance(here, first.a) < 0.15 ? first.b : distance(here, first.b) < 0.15 ? first.a : null;
        if (!next) continue;
        const segments = [],
          maxLength = Math.min(65, Math.max(12, (1.5 * (startHeight - 0.16)) / 0.16));
        let previous = here,
          current = next,
          source = first,
          length = 0,
          targetHeight = 0.16;
        for (let step = 0; step < 24 && length < maxLength; step++) {
          used.add(source);
          const fullLength = distance(previous, current),
            remaining = maxLength - length,
            end = fullLength > remaining ? lerp(previous, current, remaining / fullLength) : current,
            len = distance(previous, end);
          if (len < 0.05) break;
          segments.push({ a: previous, b: end, road: source.road, length: len });
          length += len;
          const connectedHeight = heightAt(end);
          if (connectedHeight !== null) {
            targetHeight = connectedHeight;
            break;
          }
          if (fullLength > remaining) break;
          const forward = [current[0] - previous[0], current[1] - previous[1]],
            choices = [...roadIndex.index.near(...current, 2)]
              .filter(
                (s) =>
                  !used.has(s) &&
                  !own.has(s.road.id) &&
                  s.road.kind.includes('link') &&
                  !s.road.bridge &&
                  !s.road.tunnel,
              )
              .map((s) => ({
                s,
                next: distance(current, s.a) < 0.15 ? s.b : distance(current, s.b) < 0.15 ? s.a : null,
              }))
              .filter(
                (s) =>
                  s.next && (s.next[0] - current[0]) * forward[0] + (s.next[1] - current[1]) * forward[1] > 0,
              );
          if (!choices.length) break;
          previous = current;
          current = choices[0].next;
          source = choices[0].s;
        }
        const lastPoint = segments.at(-1)?.b,
          crop = data?.meta?.bbox;
        if (lastPoint && crop) {
          const nw = project(crop.west, crop.north),
            se = project(crop.east, crop.south);
          if (
            Math.min(
              Math.abs(lastPoint[0] - nw[0]),
              Math.abs(lastPoint[0] - se[0]),
              Math.abs(lastPoint[1] - nw[1]),
              Math.abs(lastPoint[1] - se[1]),
            ) < 0.3
          )
            targetHeight = startHeight;
        }
        let at = 0;
        const h = (d) => {
          const u = clamp(d / Math.max(length, 1), 0, 1);
          return startHeight + (targetHeight - startHeight) * u * u * (3 - 2 * u);
        };
        for (const s of segments) {
          const pieces = Math.ceil(s.length / 4);
          for (let i = 0; i < pieces; i++)
            branches.push({
              a: lerp(s.a, s.b, i / pieces),
              b: lerp(s.a, s.b, (i + 1) / pieces),
              h0: h(at + (s.length * i) / pieces),
              h1: h(at + (s.length * (i + 1)) / pieces),
              road: s.road,
              plan,
              ramp: true,
              branch: true,
            });
          at += s.length;
        }
      }
    }
  }
  return branches;
}

// Pure surface model may be constructed before the building meshes. All bridge
// rendering, navigation, actors and approach road vertices share these heights.
export function createInfrastructureSurfaces(data, context = {}) {
  let terrain = context.terrain || null;
  let underpass = createMemorialUnderpass(data, terrain);
  const regionalOffsetAt = (x, z) => terrain?.regionalOffsetAt?.(x, z) || 0;
  const localOffsetAt = (x, z) => (terrain?.localOffsetAt || terrain?.offsetAt)?.(x, z) || 0;
  const terrainHeight = (y, x, z) => y + regionalOffsetAt(x, z) + (y < 0.6 ? localOffsetAt(x, z) : 0);
  const approachHeightAt = (segment, t, x, z) => {
    const y = segment.h0 + (segment.h1 - segment.h0) * t;
    if (segment.accessBranch) return y;
    const cx = segment.a[0] + (segment.b[0] - segment.a[0]) * t,
      cz = segment.a[1] + (segment.b[1] - segment.a[1]) * t;
    return y + regionalOffsetAt(cx, cz) + (y < 0.6 ? localOffsetAt(x ?? cx, z ?? cz) : 0);
  };
  const placeBridgeFrames = () => {
    for (const plan of plans) {
      const start = regionalOffsetAt(...plan.points[0]),
        end = regionalOffsetAt(...plan.points.at(-1));
      plan.terrainEnds = start || end ? [start, end] : null;
    }
  };
  const roadIndex = context.roadIndex || makeRoadIndex(data.roads || []),
    driveIndex = makeRoadIndex((data.roads || []).filter((r) => DRIVABLE.has(r.kind))),
    railIndex = makeRoadIndex(data.rails || []),
    waters = data.waters || [];
  const waterIndex = new SpatialIndex(180);
  for (const water of waters) waterIndex.insert(water, bounds(water.ring));
  const inWater = context.inWater || ((x, z) => [...waterIndex.near(x, z)].some((w) => inPolygon(x, z, w)));
  const peace = createPeaceBridgeSurfaces(data, { roadIndex, isPeaceBridgeRoad });
  const all = (data.roads || []).filter(
    (r) =>
      (r.bridge || (r.kind === 'corridor' && Number(r.layer) > 0) || /plus\s?15/i.test(r.name || '')) &&
      !r.tunnel &&
      validPoints(r.points).length > 1 &&
      !isPeaceBridgeRoad(r),
  );
  const skywalks = all.filter((r) => r.kind === 'corridor' || /plus\s?15/i.test(r.name || ''));
  const skyIds = new Set(skywalks.map((r) => r.id));
  const candidates = all.filter((r) => !skyIds.has(r.id) && !['steps', 'service'].includes(r.kind));
  const river = candidates.filter((r) => roadWaterLength(r, inWater) > 5);
  // Join the complete mapped bridge before checking water. Abutments and
  // overbank spans are often separate OSM ways with no water beneath them.
  const plans = joinRoads(
    candidates.filter((r) => DRIVABLE.has(r.kind)),
    40,
  )
    .filter((g) => g.length > 8 && g.points.some((p) => inDatasetBounds(data, ...p)))
    .map((g) => ({
      ...g,
      ...bridgeStyle(g),
      drive: true,
      width: Math.max(...g.roads.map((r) => roadIndex.segments.find((s) => s.road === r)?.width || 6)) + 4.2,
    }));
  // A short OSM fragment can sit inside a gap already spanned by two other
  // bridge ways. Associate it with that component instead of building a second
  // bridge, piers and ramps on top of it.
  for (let i = plans.length - 1; i >= 0; i--) {
    const p = plans[i];
    if (p.length > 45) continue;
    const owner = plans.find(
      (q) =>
        q !== p &&
        q.length > p.length * 2 &&
        q.name === p.name &&
        q.level === p.level &&
        p.points.every((point) =>
          q.points.slice(1).some((b, j) => nearestOnSegment(...point, q.points[j], b).distance < 1.1),
        ),
    );
    if (owner) {
      owner.roads.push(...p.roads);
      plans.splice(i, 1);
    }
  }
  // Some mapped viaducts alternate bridge=yes spans and short ordinary-road
  // links over solid land. These links belong to the joined deck surface too;
  // leaving them generic makes traffic drop several metres inside one bridge.
  for (const plan of plans) {
    plan.connectors = [];
    for (const join of plan.joins || []) {
      if (join.gap < 2.2) continue;
      for (const road of data.roads || []) {
        if (
          road.tunnel ||
          !DRIVABLE.has(road.kind) ||
          plan.roads.includes(road) ||
          normName(road.name) !== normName(plan.roads[0].name)
        )
          continue;
        if (road.points.every((point) => nearestOnSegment(...point, join.a, join.b).distance < 1.1)) {
          plan.connectors.push(road);
          plan.roads.push(road);
        }
      }
    }
  }
  sizeRoadDecks(plans);
  const roadPlans = plans.slice();
  const byRoad = new Map();
  for (const p of plans) for (const r of p.roads) byRoad.set(r.id, p);
  const pedestrians = [],
    possibleCompanions = new Map();
  const attachCompanion = (road, plan) => {
    byRoad.set(road.id, plan);
    plan.companions ||= [];
    plan.companions.push(road);
  };
  for (const road of candidates.filter((r) => !DRIVABLE.has(r.kind))) {
    if (road.id === NORTH_BOW_OVERPASS_ID) continue;
    const mid = samplePolyline(road.points, 0.5);
    let companion = null;
    for (const p of plans)
      for (let i = 1; i < p.points.length; i++) {
        const n = nearestOnSegment(mid.x, mid.z, p.points[i - 1], p.points[i]);
        const length = distance(p.points[i - 1], p.points[i]),
          dx = (p.points[i][0] - p.points[i - 1][0]) / length,
          dz = (p.points[i][1] - p.points[i - 1][1]) / length;
        if (
          n.distance < p.width / 2 + 4 &&
          Math.abs(mid.dx * dx + mid.dz * dz) > 0.72 &&
          (!companion || n.distance < companion.distance)
        )
          companion = { p, distance: n.distance };
      }
    if (companion && companionFitsDeck(road, companion.p)) attachCompanion(road, companion.p);
    else {
      if (companion) possibleCompanions.set(road, companion.p);
      pedestrians.push(road);
    }
  }
  for (const g of joinRoads(pedestrians, 3)) {
    const style = bridgeStyle(g),
      p = { ...g, ...style, drive: false, width: style.width || 3.8 };
    if (
      g.length < 8 ||
      (!g.roads.some((r) => river.includes(r)) &&
        !dryWalkBridge(p, data, roadIndex, driveIndex, railIndex, plans)) ||
      overlapsRoadDeckEdge(p, roadPlans)
    ) {
      for (const road of g.roads) {
        const companion = possibleCompanions.get(road);
        if (companion) attachCompanion(road, companion);
      }
      continue;
    }
    plans.push(p);
    for (const r of g.roads) byRoad.set(r.id, p);
  }
  for (const kind of ['rail', 'light_rail'])
    for (const group of joinRoads(
      (data.rails || []).filter((r) => r.kind === kind && r.bridge && !r.tunnel),
    )) {
      if (group.length < 8 || !group.points.some((p) => inDatasetBounds(data, ...p))) continue;
      const plan = {
        ...group,
        name: group.roads[0].name || 'Mapped railway bridge',
        type: 'girder',
        rail: true,
        drive: false,
        level: kind === 'light_rail' ? 5.4 : 5.1,
        trackFinish: railGuidewayFinish(group.roads),
        width: 3.6,
        spans: Math.max(1, Math.min(5, Math.round(group.length / 48))),
      };
      plans.push(plan);
      for (const road of group.roads) byRoad.set(road.id, plan);
    }
  const surfaceIndex = new SpatialIndex(32),
    rampRoadIds = new Set();
  for (const p of plans) {
    preserveBowTrailRailClearance(p);
    // Long, automatic 1:17 approaches raised neighbouring city blocks and
    // cross streets in the simplified flat terrain. Keep transitions local to
    // the mapped abutment and stop before the first at-grade junction.
    p.rampLength = p.rail
      ? Math.max(65, p.level * 17)
      : p.drive
        ? Math.max(32, Math.min(65, p.level * 10))
        : Math.max(24, Math.min(45, p.level * 10));
    // Follow connected mapped roads/paths around bends. Extrapolating a straight
    // ramp from the bridge would cut through Kensington buildings and junctions.
    const approachIndex = p.rail ? railIndex : roadIndex;
    p.bankConnections = {};
    if (!p.drive && !p.rail)
      for (const side of ['start', 'end']) {
        const endpoint = side === 'start' ? p.points[0] : p.points.at(-1),
          connection = (context.bridgeConnections || []).find(
            (c) =>
              p.roads.some((r) => r.id === c.roadId) &&
              distance(endpoint, c.point) < 0.01 &&
              Number.isFinite(c.height) &&
              c.height >= INFRASTRUCTURE_LIMITS.pathLevel &&
              c.height < p.level,
          );
        if (connection) p.bankConnections[side] = connection;
      }
    p.approaches = [
      ...(p.bankConnections.start ? [] : tracedApproach(p, true, approachIndex)),
      ...(p.bankConnections.end ? [] : tracedApproach(p, false, approachIndex)),
    ];
    configureBridgeProfile(p, data, plans, approachIndex);
    for (const s of p.approaches) {
      rampRoadIds.add(s.road.id);
      s.width = p.drive ? roadWidth(s.road) + (p.compactShoulders ? 0.7 : 4.2) : p.width;
      const box = bounds([s.a, s.b]),
        margin = s.width / 2 + 0.801;
      surfaceIndex.insert(s, {
        minX: box.minX - margin,
        maxX: box.maxX + margin,
        minZ: box.minZ - margin,
        maxZ: box.maxZ + margin,
      });
    }
  }
  // Two close bridges may approach each other along the same actual road/path.
  // Both formerly generated a separate decline to ground, and whichever ramp
  // happened to be visited first won the query. Reconcile their upper envelope
  // before rendering or traffic queries; each component remains grade-bounded.
  const rawApproaches = plans.flatMap((plan) => plan.approaches).map((segment) => ({ ...segment })),
    rawApproachIndex = new SpatialIndex(120);
  for (const segment of rawApproaches) rawApproachIndex.insert(segment, bounds([segment.a, segment.b]));
  for (const plan of plans) {
    for (const segment of plan.approaches) {
      const height = (point, ownHeight) => {
        let result = ownHeight;
        for (const other of rawApproachIndex.near(...point, 1)) {
          if (other.road.id !== segment.road.id) continue;
          const q = nearestOnSegment(...point, other.a, other.b);
          if (q.distance < 0.15) result = Math.max(result, other.h0 + (other.h1 - other.h0) * q.t);
        }
        return result;
      };
      segment.h0 = height(segment.a, segment.h0);
      segment.h1 = height(segment.b, segment.h1);
    }
    plan.sharedEndpointHeights = {};
    for (const side of ['start', 'end']) {
      const approach = plan.approaches.find((segment) => segment.approachSide === side);
      if (approach) plan.sharedEndpointHeights[side] = approach.h0;
    }
  }
  // A link can connect two separately mapped carriageway approaches. Build
  // those after all primary profiles exist so its far end meets the other
  // ramp instead of dropping to an invented ground point between them.
  const primaryApproaches = plans.flatMap((plan) => plan.approaches);
  for (const plan of plans) {
    const branches = approachBranches(
      plan,
      plan.approaches,
      plan.rail ? railIndex : roadIndex,
      primaryApproaches,
      data,
    );
    for (const segment of branches) {
      rampRoadIds.add(segment.road.id);
      segment.width = roadWidth(segment.road) + (plan.compactShoulders ? 0.7 : 4.2);
      const box = bounds([segment.a, segment.b]),
        margin = segment.width / 2 + 0.801;
      surfaceIndex.insert(segment, {
        minX: box.minX - margin,
        maxX: box.maxX + margin,
        minZ: box.minZ - margin,
        maxZ: box.maxZ + margin,
      });
    }
    plan.approaches.push(...branches);
  }
  placeBridgeFrames();
  const accessBranches = createBridgeAccessBranches(data, {
    plans,
    roadIndex,
    heightAt: bridgeDeckHeight,
    pathGroundHeight: context.pathGroundHeight,
  });
  for (const segment of accessBranches.segments) segment.plan.approaches.push(segment);
  const attachDecks = () => {
    for (const plan of plans) {
      const deck = createBridgeDeck(plan, bridgeDeckHeight, terrain);
      if (plan.deck) {
        for (let i = 0; i < plan.segments.length; i++) Object.assign(plan.segments[i], deck.segments[i]);
        plan.deck = { ...deck, segments: plan.segments };
      } else {
        plan.deck = deck;
        plan.segments = deck.segments;
        for (const segment of plan.segments) {
          const b = segment.bounds;
          surfaceIndex.insert(segment, {
            minX: b.minX - 0.0005,
            maxX: b.maxX + 0.0005,
            minZ: b.minZ - 0.0005,
            maxZ: b.maxZ + 0.0005,
          });
        }
      }
    }
    connectBridgeForks(plans, { heightForApproach: terrainHeight });
  };
  attachDecks();
  const surface = (x, z, road, includeRamps = true, elevationHint) => {
    const candidates = new Map();
    const specific = road && byRoad.get(road.id);
    for (const s of surfaceIndex.near(x, z)) {
      if (!includeRamps && s.ramp) continue;
      if (s.plan.rail && !specific && !road) continue;
      if (specific && s.plan !== specific) continue;
      if (road && !specific && !s.ramp) continue;
      if (road && s.ramp && DRIVABLE.has(road.kind) !== s.plan.drive) continue;
      if (road && s.ramp && road.id !== s.road?.id && !specific) continue;
      const p = nearestOnSegment(x, z, s.a, s.b);
      let h;
      if (s.ramp) {
        if (p.distance > s.width / 2 + 0.8) continue;
        const dx = s.b[0] - s.a[0],
          dz = s.b[1] - s.a[1],
          rawT = ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / (dx * dx + dz * dz);
        const pastEnd = Math.max(-rawT, rawT - 1, 0);
        if (pastEnd > 0.0001) {
          // The deck uses a mitred edge but the ramp search uses its segment
          // normal. Their different headings leave a narrow wedge at some
          // abutments. Retain the approach endpoint under an existing traveller.
          if (road || !Number.isFinite(elevationHint) || pastEnd * Math.hypot(dx, dz) > 0.24) continue;
        }
        h = approachHeightAt(s, p.t, x, z);
      } else {
        h = road && s.plan.rail ? s.neutral.heightAt(x, z) : s.floor(x, z);
        if (h == null) continue;
      }
      // A ground traveller crossing below an overpass cannot acquire its deck
      // simply because both share x/z. Falling travellers may acquire lower
      // supports; only upward steps are bounded. Rendering keeps the no-hint
      // path, while navigation supplies the current feet elevation.
      if (Number.isFinite(elevationHint) && h > elevationHint + 0.65) continue;
      const priority = specific
        ? p.distance
        : road
          ? -h * 1000 + p.distance * 0.001
          : Number.isFinite(elevationHint)
            ? elevationHint - h > 0.75
              ? 1000 + (elevationHint - h) * 100 + p.distance * 0.01
              : p.distance + Math.abs(elevationHint - h) * 0.01 + (s.ramp ? 0.001 : 0)
            : p.distance + (s.ramp ? 0.1 : 0);
      let own = candidates.get(s.plan);
      if (!own) candidates.set(s.plan, (own = { deck: null, ramp: null }));
      const key = s.ramp ? 'ramp' : 'deck',
        previous = own[key];
      if (!previous || (s.ramp ? priority < previous.priority : h > previous.height))
        own[key] = { height: h, plan: s.plan, priority, ramp: s.ramp };
    }
    let best = null;
    for (const { deck, ramp } of candidates.values()) {
      // A plan's lower inferred approach cannot replace its physical deck.
      // Across different plans, retain proximity and elevation continuity:
      // the highest nearby inferred ramp may belong to another road entirely.
      const candidate = deck && (!ramp || deck.height >= ramp.height) ? deck : ramp;
      if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
    }
    return best;
  };
  return {
    roadIndex,
    driveIndex,
    railIndex,
    inWater,
    plans,
    byRoad,
    skywalks,
    peace,
    accessBranches,
    surfaceIndex,
    get underpass() {
      return underpass;
    },
    approachHeightAt,
    regionalOffsetAt,
    terrainOffsetAt: (x, z) => regionalOffsetAt(x, z) + localOffsetAt(x, z),
    attachGroundTerrain(next) {
      if (next === terrain) return;
      terrain = next;
      underpass = createMemorialUnderpass(data, terrain);
      placeBridgeFrames();
      attachDecks();
    },
    hasRoadApproach(road) {
      return rampRoadIds.has(road.id);
    },
    ownsRoad(road) {
      return byRoad.has(road.id) || skyIds.has(road.id) || accessBranches.ownsRoad(road);
    },
    isSkywalk(road) {
      return skyIds.has(road.id);
    },
    surfaceHeight(x, z, road) {
      const tunnelHeight = underpass?.heightAt(x, z, road);
      if (tunnelHeight != null) return tunnelHeight;
      const peaceHeight = peace.surfaceHeight(x, z, road);
      if (peaceHeight !== null) return terrainHeight(peaceHeight, x, z);
      const accessHeight = accessBranches.surfaceHeight(x, z, road);
      if (accessHeight !== null) return accessHeight;
      if (skyIds.has(road?.id))
        return INFRASTRUCTURE_LIMITS.skywalkLevel * Math.max(1, Math.min(2, Number(road.layer) || 1));
      const base = DRIVABLE.has(road?.kind)
        ? INFRASTRUCTURE_LIMITS.roadLevel
        : ['rail', 'light_rail'].includes(road?.kind)
          ? 0.18
          : INFRASTRUCTURE_LIMITS.pathLevel;
      // Most roads are ordinary ground-level ways. They cannot inherit a
      // neighbouring overpass and need no repeated spatial bridge search.
      if (road && !byRoad.has(road.id) && !rampRoadIds.has(road.id)) return terrainHeight(base, x, z);
      return surface(x, z, road)?.height ?? terrainHeight(base, x, z);
    },
    bridgeSurface(road, t) {
      const p = samplePolyline(road.points, t);
      return this.surfaceHeight(p.x, p.z, road);
    },
    deckConflictsWithSupport(x, z, base, top) {
      for (const s of surfaceIndex.near(x, z)) {
        if (s.ramp || s.plan.rail) continue;
        if (!s.plan.drive && nearestOnSegment(x, z, s.a, s.b).distance > 0.86) continue;
        const band = s.paving.find((part) => part.kind === (s.plan.drive ? 'asphalt' : 'sidewalk'))?.band;
        const deck = band?.heightAt(x, z);
        if (deck != null && deck > 0.8 && base < deck + 1.9 && top > deck) return true;
      }
      return false;
    },
    groundHeight(x, z, elevationHint) {
      const peaceHeight = peace.groundHeight(x, z, elevationHint);
      if (peaceHeight !== null) return terrainHeight(peaceHeight, x, z);
      const primary = surface(x, z, undefined, true, elevationHint)?.height ?? null,
        access = accessBranches.groundHeight(x, z, elevationHint);
      if (primary === null) return access;
      if (access === null) return primary;
      return Number.isFinite(elevationHint)
        ? Math.abs(primary - elevationHint) <= Math.abs(access - elevationHint)
          ? primary
          : access
        : Math.max(primary, access);
    },
  };
}

class Batch {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.colors = [];
    this.color = new THREE.Color();
  }
  triangle(a, b, c, tint) {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len;
    ny /= len;
    nz /= len;
    let tintRGB = linearColors.get(tint);
    if (!tintRGB) {
      this.color.setHex(tint);
      tintRGB = [this.color.r, this.color.g, this.color.b];
      linearColors.set(tint, tintRGB);
    }
    for (const p of [a, b, c]) {
      this.positions.push(...p);
      this.normals.push(nx, ny, nz);
      this.colors.push(...tintRGB);
    }
  }
  quad(a, b, c, d, tint) {
    this.triangle(a, b, d, tint);
    this.triangle(b, c, d, tint);
  }
  box(x, y, z, width, height, depth, angle = 0, tint = palette.steel) {
    const c = Math.cos(angle),
      s = Math.sin(angle),
      points = [];
    for (const yy of [-height / 2, height / 2])
      for (const zz of [-depth / 2, depth / 2])
        for (const xx of [-width / 2, width / 2])
          points.push([x + xx * c + zz * s, y + yy, z - xx * s + zz * c]);
    for (const f of [
      [0, 1, 3, 2],
      [4, 6, 7, 5],
      [0, 4, 5, 1],
      [2, 3, 7, 6],
      [0, 2, 6, 4],
      [1, 5, 7, 3],
    ])
      this.quad(...f.map((i) => points[i]), tint);
  }
  beam(a, b, radius, tint = palette.steel, sides = 4) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 0.005) return;
    const dx = (b[0] - a[0]) / len,
      dy = (b[1] - a[1]) / len,
      dz = (b[2] - a[2]) / len;
    let ux = Math.abs(dy) < 0.9 ? -dz : 0,
      uy = Math.abs(dy) < 0.9 ? 0 : dz,
      uz = Math.abs(dy) < 0.9 ? dx : -dy;
    const ul = Math.hypot(ux, uy, uz);
    ux *= radius / ul;
    uy *= radius / ul;
    uz *= radius / ul;
    const vx = dy * uz - dz * uy,
      vy = dz * ux - dx * uz,
      vz = dx * uy - dy * ux,
      rings = [[], []];
    for (let j = 0; j < sides; j++) {
      const t = (j * Math.PI * 2) / sides,
        c = Math.cos(t),
        s = Math.sin(t),
        x = ux * c + vx * s,
        y = uy * c + vy * s,
        z = uz * c + vz * s;
      rings[0].push([a[0] + x, a[1] + y, a[2] + z]);
      rings[1].push([b[0] + x, b[1] + y, b[2] + z]);
    }
    for (let j = 0; j < sides; j++) {
      const next = (j + 1) % sides;
      this.quad(rings[0][next], rings[1][next], rings[1][j], rings[0][j], tint);
    }
    for (let j = 1; j < sides - 1; j++) {
      this.triangle(rings[0][0], rings[0][j + 1], rings[0][j], tint);
      this.triangle(rings[1][0], rings[1][j], rings[1][j + 1], tint);
    }
  }
  strip(a, b, lowOffset, highOffset, y0, y1, tint, thickness = 0) {
    const len = distance(a, b);
    if (len < 0.01) return;
    const nx = -(b[1] - a[1]) / len,
      nz = (b[0] - a[0]) / len;
    const p = [
      [a[0] + nx * lowOffset, y0, a[1] + nz * lowOffset],
      [b[0] + nx * lowOffset, y1, b[1] + nz * lowOffset],
      [b[0] + nx * highOffset, y1, b[1] + nz * highOffset],
      [a[0] + nx * highOffset, y0, a[1] + nz * highOffset],
    ];
    this.quad(p[0], p[3], p[2], p[1], tint);
    if (thickness) {
      const q = p.map((v) => [v[0], v[1] - thickness, v[2]]);
      this.quad(p[0], p[1], q[1], q[0], tint);
      this.quad(p[2], p[3], q[3], q[2], tint);
      this.quad(p[3], p[0], q[0], q[3], tint);
      this.quad(p[1], p[2], q[2], q[1], tint);
    }
  }
  band(surface, tint, thickness = 0, capStart = true, capEnd = true) {
    const p = surface.vertices;
    for (const [a, b, c] of BRIDGE_BAND_TRIANGLES) this.triangle(p[a], p[b], p[c], tint);
    if (!thickness) return;
    const q = p.map(([x, y, z]) => [x, y - thickness, z]);
    for (const [a, b, c] of BRIDGE_BAND_TRIANGLES) this.triangle(q[c], q[b], q[a], tint);
    this.quad(p[0], p[3], q[3], q[0], tint);
    this.quad(p[5], p[2], q[2], q[5], tint);
    if (capStart) this.quad(p[2], p[0], q[0], q[2], tint);
    if (capEnd) this.quad(p[3], p[5], q[5], q[3], tint);
  }
  geometry() {
    if (!this.positions.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function meshFor(batch, material, name, castShadow = true) {
  return meshForGeometry(batch.geometry(), material, name, castShadow);
}

function meshForGeometry(g, material, name, castShadow = true) {
  if (!g) return null;
  const m = new THREE.Mesh(g, material);
  m.name = name;
  m.castShadow = castShadow;
  m.receiveShadow = true;
  // Batch vertices are fixed world coordinates; only visibility changes.
  m.updateMatrixWorld(true);
  m.matrixAutoUpdate = m.matrixWorldAutoUpdate = false;
  return m;
}

function primitiveStream(cache, item, signature, draw, layout) {
  const previous = cache.get(item);
  if (
    previous &&
    previous.signature.length === signature.length &&
    signature.every((value, index) => Object.is(value, previous.signature[index]))
  )
    return previous;
  const batch = new Batch(),
    descriptor = draw(batch, item, layout),
    length = batch.positions.length,
    storage = new Float32Array(length * 3),
    positions = storage.subarray(0, length),
    normals = storage.subarray(length, length * 2),
    colors = storage.subarray(length * 2);
  positions.set(batch.positions);
  normals.set(batch.normals);
  colors.set(batch.colors);
  const stream = { positions, normals, colors, signature, descriptor };
  cache.set(item, stream, storage.byteLength);
  return stream;
}

function buildingClear(index, inWater, x, z, radius = 0.3) {
  if (inWater(x, z)) return false;
  for (const b of index?.near(x, z, radius) || []) {
    if (inPolygon(x, z, b)) return false;
    if (radius)
      for (const [dx, dz] of [
        [radius, 0],
        [-radius, 0],
        [0, radius],
        [0, -radius],
      ])
        if (inPolygon(x + dx, z + dz, b)) return false;
  }
  return true;
}

function inDatasetBounds(data, x, z, margin = 80) {
  if (!data.meta?.bbox) return true;
  const b = data.meta.bbox,
    a = project(b.west, b.north),
    c = project(b.east, b.south);
  return x > a[0] - margin && x < c[0] + margin && z > a[1] - margin && z < c[1] + margin;
}

const signalRoadName = (name = '') =>
  normName(
    name
      .toLowerCase()
      .replace(/\b(?:nb|sb|eb|wb|northbound|southbound|eastbound|westbound|ramp)\b/g, '')
      .replace(/\bave\b/g, 'avenue')
      .replace(/\bst\b/g, 'street')
      .replace(/\btr\b/g, 'trail')
      .replace(/\brd\b/g, 'road'),
  );

// The City's control sites are independent evidence of a signal. Reconstruct
// their approach directions directly from nearby mapped carriageways instead
// of requiring an inferred painted crosswalk on both sides of every street.
export function inventorySignalApproaches(sites, surfaces, crossings = []) {
  const candidates = [],
    clusters = [],
    names = new WeakMap();
  const nameFor = (s) => {
    if (!names.has(s.road)) names.set(s.road, signalRoadName(s.road.name));
    return names.get(s.road);
  };
  const roadEligible = (s) =>
    DRIVABLE.has(s.road.kind) && !s.road.bridge && !s.road.tunnel && !s.road.kind.includes('motorway');
  for (const site of sites) {
    const aliases = [site.firstRoad, site.secondRoad]
        .flatMap((n) => (n || '').split(/[\/&]/).map(signalRoadName))
        .filter(Boolean),
      matches = (s) => aliases.includes(nameFor(s)),
      near = [...surfaces.driveIndex.index.near(site.x, site.z, 60)]
        .filter(roadEligible)
        .map((s) => ({ s, q: nearestOnSegment(site.x, site.z, s.a, s.b) }))
        .filter((v) => v.q.distance < 50)
        .sort((a, b) => a.q.distance + (matches(a.s) ? 0 : 25) - b.q.distance - (matches(b.s) ? 0 : 25));
    if (!near.length || (aliases.length && !near.some((n) => matches(n.s)))) continue;
    const existing = crossings
      .filter((c) => distance(c.junction, [site.x, site.z]) < 42)
      .sort((a, b) => distance(a.junction, [site.x, site.z]) - distance(b.junction, [site.x, site.z]));
    const first = near[0].s,
      firstLength = distance(first.a, first.b),
      axes = [
        {
          dx: (first.b[0] - first.a[0]) / firstLength,
          dz: (first.b[1] - first.a[1]) / firstLength,
          s: first,
        },
      ];
    let junction = existing[0]?.junction || [near[0].q.x, near[0].q.z],
      best = null;
    for (const a of near.slice(0, 28))
      for (const b of near.slice(0, 28)) {
        if (a === b || a.s.road === b.s.road || (aliases.length && (!matches(a.s) || !matches(b.s))))
          continue;
        const h = segmentCrossParameters(a.s.a, a.s.b, b.s.a, b.s.b);
        if (!h || h.sine < 0.45) continue;
        const la = distance(a.s.a, a.s.b),
          lb = distance(b.s.a, b.s.b),
          padding = 12;
        if (h.t * la < -padding || h.t * la > la + padding || h.s * lb < -padding || h.s * lb > lb + padding)
          continue;
        const gap = distance(h.point, [site.x, site.z]);
        if (gap > 48) continue;
        const score = gap + a.q.distance * 0.1 + b.q.distance * 0.1;
        if (!best || score < best.score) best = { a: a.s, b: b.s, point: h.point, score };
      }
    if (best) {
      junction =
        existing[0] && distance(existing[0].junction, best.point) < 16 ? existing[0].junction : best.point;
      axes.length = 0;
      for (const s of [best.a, best.b]) {
        const len = distance(s.a, s.b);
        axes.push({ dx: (s.b[0] - s.a[0]) / len, dz: (s.b[1] - s.a[1]) / len, s });
      }
    }
    let cluster = clusters.find((c) => distance(c.junction, junction) < 18);
    if (!cluster) {
      cluster = { junction, dx: axes[0].dx, dz: axes[0].dz };
      clusters.push(cluster);
    }
    junction = cluster.junction;
    if (surfaces.inWater(...junction) || surfaces.groundHeight(...junction) > 0.4) continue;
    for (let axisIndex = 0; axisIndex < axes.length; axisIndex++) {
      const axis = axes[axisIndex],
        other = axes[1 - axisIndex],
        crossWidth = other ? other.s.width : 6.4,
        signalAxis = Math.abs(axis.dx * cluster.dx + axis.dz * cluster.dz) > 0.9 ? 0 : 1;
      for (const sign of [-1, 1]) {
        const at = crossWidth / 2 + 3.3,
          x = junction[0] + axis.dx * at * sign,
          z = junction[1] + axis.dz * at * sign;
        let support = null;
        for (const item of near) {
          const s = item.s,
            len = distance(s.a, s.b),
            sx = (s.b[0] - s.a[0]) / len,
            sz = (s.b[1] - s.a[1]) / len;
          if (Math.abs(axis.dx * sx + axis.dz * sz) < 0.86) continue;
          const q = nearestOnSegment(x, z, s.a, s.b);
          if (q.distance > Math.max(2, s.width / 2 - 0.5)) continue;
          const travelDot = -sign * (axis.dx * sx + axis.dz * sz),
            oneWay = s.road.oneway;
          if (oneWay && oneWay !== 'no' && (oneWay === '-1' ? travelDot > -0.3 : travelDot < 0.3)) continue;
          const score = q.distance + (matches(s) ? 0 : 12);
          if (!support || score < support.score) support = { s, score };
        }
        if (!support) continue;
        const width = support.s.width;
        const duplicate = candidates.find(
          (c) =>
            distance(c.junction, junction) < 2 &&
            c.sign * (c.dx * axis.dx + c.dz * axis.dz) * sign > 0.94 &&
            Math.hypot(c.x - x, c.z - z) < width / 2,
        );
        if (duplicate) {
          duplicate.citySites ||= [duplicate.citySite];
          if (!duplicate.citySites.includes(site)) duplicate.citySites.push(site);
          continue;
        }
        candidates.push({
          x,
          z,
          dx: axis.dx,
          dz: axis.dz,
          width,
          junction,
          sign,
          signalAxis,
          road: support.s.road.name,
          roadKind: support.s.road.kind,
          roadId: support.s.road.id,
          sourceRoad: support.s.road,
          crossKind: other?.s.road.kind || 'pedestrian crossing',
          inventoryDerived: true,
          citySite: site,
          citySites: [site],
        });
      }
    }
  }
  return candidates;
}

export function collectStreetPlans(data, context = {}) {
  const surfaces = context.surfaces || createInfrastructureSurfaces(data, context),
    roadIndex = surfaces.roadIndex,
    driveIndex = surfaces.driveIndex;
  const buildingIndex = context.buildingIndex,
    inWater = surfaces.inWater;
  const sidewalks = [],
    furniture = [],
    crossings = [],
    junctionIndex = new SpatialIndex(20),
    occupied = new SpatialIndex(8);
  const surveyed = context.sidewalkPolygons || [],
    surveyedIndex = new SpatialIndex(60);
  for (const p of surveyed) surveyedIndex.insert(p, bounds(p.ring));
  const onSurveyed = (x, z) => [...surveyedIndex.near(x, z)].some((p) => inPolygon(x, z, p));
  const eligible = (s) =>
    DRIVABLE.has(s.road.kind) &&
    !s.road.bridge &&
    !s.road.tunnel &&
    !['motorway', 'trunk', 'service', 'living_street'].includes(s.road.kind) &&
    !s.road.kind.includes('link');
  const free = (x, z, radius = 0.3) => buildingClear(buildingIndex, inWater, x, z, radius);
  const addFurniture = (object) => {
    if (!free(object.x, object.z, object.kind === 'bench' ? 1 : 0.4)) return;
    if (surveyed.length && !object.pathside && !onSurveyed(object.x, object.z)) return;
    const nearest = driveIndex.nearest(object.x, object.z, true, 22);
    if (nearest && nearest.distance < nearest.width / 2 + 0.4) return;
    if (
      [...occupied.near(object.x, object.z, 4)].some((p) => Math.hypot(p.x - object.x, p.z - object.z) < 3.7)
    )
      return;
    occupied.insert(object, pointBox(object.x, object.z));
    furniture.push(object);
  };
  for (const s of roadIndex.segments) {
    if (!eligible(s)) continue;
    const len = distance(s.a, s.b),
      mx = (s.a[0] + s.b[0]) / 2,
      mz = (s.a[1] + s.b[1]) / 2;
    if (len < 1.5 || !inDatasetBounds(data, mx, mz)) continue;
    const dx = (s.b[0] - s.a[0]) / len,
      dz = (s.b[1] - s.a[1]) / len,
      angle = Math.atan2(dx, dz);
    const intervals = sidewalkIntervals(s, driveIndex);
    for (const [start, end] of intervals)
      for (const side of [-1, 1]) {
        const width = s.road.kind === 'residential' ? 1.8 : 2.4,
          offset = s.width / 2 + 0.05;
        const parts = Math.ceil((end - start) / 12);
        if (!surveyed.length)
          for (let j = 0; j < parts; j++) {
            const from = start + ((end - start) * j) / parts,
              to = start + ((end - start) * (j + 1)) / parts;
            const a = lerp(s.a, s.b, from / len),
              b = lerp(s.a, s.b, to / len),
              mid = lerp(a, b, 0.5);
            if (
              ![0.5, 0.9].every((u) =>
                free(
                  mid[0] - dz * (offset + width * u) * side,
                  mid[1] + dx * (offset + width * u) * side,
                  width * 0.1,
                ),
              )
            )
              continue;
            if (
              surveyed.length &&
              !onSurveyed(
                mid[0] - dz * (offset + width * 0.5) * side,
                mid[1] + dx * (offset + width * 0.5) * side,
              )
            )
              continue;
            const ya = surfaces.surfaceHeight(...a, s.road),
              yb = surfaces.surfaceHeight(...b, s.road);
            sidewalks.push({ a, b, side, width, offset, ya, yb, road: s.road });
          }
        // Furniture occupies the outer edge of a surviving sidewalk, leaving its
        // inner clear walking zone open. Placement is inferred and deterministic.
        if (end - start < 26) continue;
        const seed = Math.abs(Math.round(s.a[0] * 7 + s.a[1] * 13));
        for (let at = start + 15 + (seed % 12); at < end - 12; at += 60) {
          const p = lerp(s.a, s.b, at / len),
            o = offset + width - 0.3;
          const x = p[0] - dz * o * side,
            z = p[1] + dx * o * side;
          const nearbySidewalk = sidewalks.at(-1);
          if (
            !surveyed.length &&
            (!nearbySidewalk || nearbySidewalk.road !== s.road || nearbySidewalk.side !== side)
          )
            continue;
          const kind = (seed + Math.round(at) + (side + 1) * 3) % 11;
          addFurniture({
            x,
            z,
            y: surfaces.surfaceHeight(x, z, s.road) + 0.15,
            angle,
            side,
            kind:
              kind < 4
                ? 'lamp'
                : kind < 6
                  ? 'bench'
                  : kind < 8
                    ? 'bin'
                    : kind < 10
                      ? 'cycle-rack'
                      : 'bollard',
            road: s.road.name,
          });
        }
      }
    if (!s.road.name || (s.road.kind === 'residential' && s.width > 7)) continue;
    for (const other of driveIndex.index.near(mx, mz, len / 2 + 18)) {
      if (
        !eligible(other) ||
        other.road === s.road ||
        !other.road.name ||
        normName(s.road.name) === normName(other.road.name)
      )
        continue;
      const hit = segmentIntersection(s.a, s.b, other.a, other.b);
      if (!hit || hit.sine < 0.75) continue;
      const junction = hit.point;
      if ([...junctionIndex.near(...junction, 11)].some((p) => distance(p, junction) < 11)) continue;
      junctionIndex.insert(junction, pointBox(...junction));
      if (surfaces.groundHeight(...junction) > 0.4 || inWater(...junction)) continue;
      const da = { dx, dz, width: s.width, road: s.road },
        l2 = distance(other.a, other.b),
        db = {
          dx: (other.b[0] - other.a[0]) / l2,
          dz: (other.b[1] - other.a[1]) / l2,
          width: other.width,
          road: other.road,
        };
      // Parallel pairs are the conventional crosswalk marks common in Calgary;
      // exact signal/crossing inventories are deliberately not implied.
      for (const [axis, across] of [
        [da, db],
        [db, da],
      ])
        for (const sign of [-1, 1]) {
          const at = across.width / 2 + 3.3,
            x = junction[0] + axis.dx * at * sign,
            z = junction[1] + axis.dz * at * sign;
          const ends = [
            [x - axis.dz * (axis.width / 2 + 1), z + axis.dx * (axis.width / 2 + 1)],
            [x + axis.dz * (axis.width / 2 + 1), z - axis.dx * (axis.width / 2 + 1)],
          ];
          if (!ends.every((p) => free(...p, 0.1))) continue;
          if (
            surveyed.length &&
            !ends.every((p) =>
              [...surveyedIndex.near(...p, 2)].some(
                (poly) => inPolygon(...p, poly) || poly.ring.some((q) => distance(q, p) < 2.5),
              ),
            )
          )
            continue;
          crossings.push({
            x,
            z,
            dx: axis.dx,
            dz: axis.dz,
            width: axis.width,
            ends,
            road: axis.road.name,
            roadKind: axis.road.kind,
            roadId: axis.road.id,
            crossKind: across.road.kind,
            junction,
            sign,
            signalAxis: axis === da ? 0 : 1,
            oneway: axis.road.oneway,
          });
        }
    }
  }
  // River benches and bicycle parking use the mapped off-street paths. Do not
  // scatter objects on riverbanks or water just to fill the scene.
  for (const s of roadIndex.segments) {
    if (
      DRIVABLE.has(s.road.kind) ||
      s.road.bridge ||
      s.road.tunnel ||
      !['cycleway', 'footway', 'path'].includes(s.road.kind)
    )
      continue;
    const len = distance(s.a, s.b);
    if (len < 55) continue;
    const dx = (s.b[0] - s.a[0]) / len,
      dz = (s.b[1] - s.a[1]) / len;
    for (let at = 28; at < len - 15; at += 95) {
      const p = lerp(s.a, s.b, at / len);
      if (
        !inDatasetBounds(data, ...p) ||
        ![10, 20, 30, -10, -20, -30].some((offset) => inWater(p[0] - dz * offset, p[1] + dx * offset))
      )
        continue;
      for (const side of [-1, 1]) {
        const offset = s.width / 2 + 1.1,
          x = p[0] - dz * offset * side,
          z = p[1] + dx * offset * side;
        if (!free(x, z, 1.1)) continue;
        const nearRoad = driveIndex.nearest(x, z, true, 30);
        if (nearRoad && nearRoad.distance < nearRoad.width / 2 + 3) continue;
        addFurniture({
          x,
          z,
          y: 0.15,
          angle: Math.atan2(dx, dz),
          side,
          kind: 'bench',
          pathside: true,
          road: s.road.name || 'River pathway',
        });
        break;
      }
    }
  }
  const signals = [];
  const signalKinds = new Set(['primary', 'secondary', 'tertiary']);
  const usesInventory = Array.isArray(context.signalSites);
  const citySignals = (context.signalSites || []).filter((s) => /traffic signal|1\/2 signal/i.test(s.kind));
  const citySignalIndex = new SpatialIndex(60);
  for (const s of citySignals) citySignalIndex.insert(s, pointBox(s.x, s.z));
  const signalCandidates = usesInventory
    ? inventorySignalApproaches(citySignals, surfaces, crossings)
    : crossings;
  for (const c of signalCandidates) {
    const site =
      c.citySite ||
      (citySignals.length
        ? [...citySignalIndex.near(...c.junction, 42)]
            .map((s) => ({ s, d: Math.hypot(s.x - c.junction[0], s.z - c.junction[1]) }))
            .filter((v) => v.d < 42)
            .sort((a, b) => a.d - b.d)[0]?.s
        : null);
    if (usesInventory ? !site : !signalKinds.has(c.roadKind) || !signalKinds.has(c.crossKind)) continue;
    if (!c.inventoryDerived && ((c.oneway === 'yes' && c.sign > 0) || (c.oneway === '-1' && c.sign < 0)))
      continue;
    const nx = c.dz * c.sign,
      nz = -c.dx * c.sign;
    let pole = null;
    for (const along of [0, -1.5, 1.5, -3, 3, -5, 5]) {
      for (const extra of [0.85, 1.35, 1.85, 2.35, 3.1, 4.2, 5.4]) {
        const offset = c.width / 2 + extra,
          x = c.x + nx * offset + c.dx * along,
          z = c.z + nz * offset + c.dz * along;
        if (!free(x, z, 0.25) || (surveyed.length && !onSurveyed(x, z))) continue;
        const carriageway = driveIndex.nearest(x, z, true, 15);
        if (carriageway && carriageway.distance < carriageway.width / 2 + 0.15) continue;
        pole = { x, z };
        break;
      }
      if (pole) break;
    }
    if (!pole) continue;
    const seed = Math.abs(Math.round(c.junction[0] / 5) * 17 + Math.round(c.junction[1] / 5) * 31);
    signals.push({
      ...c,
      poleX: pole.x,
      poleZ: pole.z,
      stopX: c.x + c.dx * c.sign * 2.6,
      stopZ: c.z + c.dz * c.sign * 2.6,
      travelX: -c.dx * c.sign,
      travelZ: -c.dz * c.sign,
      axis: c.signalAxis,
      citySite: site,
      citySites: c.citySites || (site ? [site] : []),
      seed,
      y: 0.31,
    });
  }
  return {
    sidewalks,
    crossings,
    furniture,
    surfaces,
    surveyed,
    surveyedIndex,
    signals,
    signalInventory: {
      sites: (context.signalSites || []).length,
      controlSites: citySignals.length,
      mappedSites: new Set(
        signalCandidates.flatMap((s) => (s.citySites || [s.citySite]).map((p) => p?.id)).filter(Boolean),
      ).size,
      representedSites: new Set(signals.flatMap((s) => s.citySites.map((p) => p.id))).size,
      unmatched: citySignals
        .filter((s) => !signals.some((p) => p.citySites.some((c) => c.id === s.id)))
        .map((s) => ({
          id: s.id,
          kind: s.kind,
          road: [s.firstRoad, s.secondRoad].filter(Boolean).join(' / '),
          reason: signalCandidates.some((c) => (c.citySites || [c.citySite]).some((p) => p?.id === s.id))
            ? 'No safe surveyed-sidewalk pole location'
            : 'No unambiguous mapped ground approach',
        })),
    },
    surveyedCurbs: context.surveyedCurbs ?? collectSurveyedCurbs(surveyed, surfaces),
  };
}

// Shared visual/traffic cycle: 22s green, 3s amber, 2s all-red for each axis.
// The timing is illustrative, not connected to Calgary's signal controllers.
export function signalPhase(timeSeconds, axis = 0, seed = 0) {
  const cycle = ((Number.isFinite(timeSeconds) ? timeSeconds : 0) + (seed % 54)) % 54;
  const t = (cycle + 54) % 54;
  if (axis === 0) return t < 22 ? 'green' : t < 25 ? 'amber' : 'red';
  return t >= 27 && t < 49 ? 'green' : t >= 49 && t < 52 ? 'amber' : 'red';
}

export function trafficSignalAhead(signals, x, z, heading, timeSeconds, maxDistance = 60) {
  const dx = Math.sin(heading),
    dz = Math.cos(heading);
  let best = null;
  for (const s of signals) {
    if (s.travelX * dx + s.travelZ * dz < 0.94) continue;
    const rx = s.stopX - x,
      rz = s.stopZ - z,
      along = rx * dx + rz * dz,
      across = Math.abs(rx * dz - rz * dx);
    if (along < -0.6 || along > maxDistance || across > s.width / 2 + 0.5) continue;
    if (!best || along < best.distance)
      best = { signal: s, distance: Math.max(0, along), state: signalPhase(timeSeconds, s.axis, s.seed) };
  }
  return best;
}

function drawTrafficSignal(batch, s, head = signalHeadLayout(s)) {
  const faceX = -s.travelX,
    faceZ = -s.travelZ,
    headX = s.x - s.travelZ * 1.65,
    headZ = s.z + s.travelX * 1.65,
    angle = Math.atan2(faceX, faceZ),
    y = s.y,
    headY = y + 5.15 + head.centerOffsetY;
  batch.box(s.poleX, y + 0.15, s.poleZ, 0.28, 0.3, 0.28, 0, palette.dark);
  batch.beam([s.poleX, y + 0.2, s.poleZ], [s.poleX, y + 5.4, s.poleZ], 0.08, palette.steel, 6);
  batch.beam([s.poleX, y + 5.4, s.poleZ], [headX, y + 5.65, headZ], 0.065, palette.steel, 6);
  batch.box(headX, headY, headZ, head.housingWidth, head.housingHeight, 0.27, angle, 0xd5ac42);
  batch.box(
    headX + faceX * 0.15,
    headY,
    headZ + faceZ * 0.15,
    head.backingWidth,
    head.backingHeight,
    0.05,
    angle,
    0x202b26,
  );
  const colors = [0x492c29, 0x4c4326, 0x244333];
  for (let i = 0; i < 3; i++) {
    const [offsetX, offsetY, offsetZ] = head.lensOffsets[i],
      lensX = headX + offsetX,
      yy = headY + offsetY,
      lensZ = headZ + offsetZ;
    batch.beam(
      [lensX + faceX * 0.18, yy, lensZ + faceZ * 0.18],
      [lensX + faceX * 0.225, yy, lensZ + faceZ * 0.225],
      0.12,
      colors[i],
      10,
    );
    batch.box(lensX + faceX * 0.21, yy + 0.13, lensZ + faceZ * 0.21, 0.29, 0.045, 0.25, angle, palette.dark);
  }
  const pedX = s.poleX + faceX * 0.18,
    pedZ = s.poleZ + faceZ * 0.18;
  batch.box(pedX, y + 2.28, pedZ, 0.25, 0.38, 0.2, angle, palette.dark);
  if (s.citySite?.pedestrianButtons !== false)
    batch.box(
      pedX + faceX * 0.12,
      y + 1.45,
      pedZ + faceZ * 0.12,
      0.12,
      0.18,
      0.06,
      angle,
      palette.concreteDark,
    );
  return {
    signal: s,
    vehicle: head.lensOffsets.map(([offsetX, offsetY, offsetZ]) => [
      headX + offsetX + faceX * 0.235,
      headY + offsetY,
      headZ + offsetZ + faceZ * 0.235,
    ]),
    pedestrian: [pedX + faceX * 0.125, y + 2.28, pedZ + faceZ * 0.125],
  };
}

// City photogrammetric polygons preserve curved corners, separated walks and
// parking-lot boundaries. A curb belongs on the ROAD-facing boundary only. A
// short normal probe distinguishes that edge from the back of the sidewalk,
// independent of polygon winding. No curb is inferred across a perpendicular
// crossing boundary or along a river edge.
export function collectSurveyedCurbs(polygons, surfaces, onCurb) {
  const curbs = [],
    roadIndex = surfaces.driveIndex || surfaces.roadIndex;
  for (const polygon of polygons)
    for (const ring of [polygon.ring, ...(polygon.holes || [])]) {
      for (let i = 0; i < ring.length; i++) {
        const originalA = ring[i],
          originalB = ring[(i + 1) % ring.length],
          originalLength = distance(originalA, originalB);
        if (originalLength < 0.18 || originalLength > 180) continue;
        const parts = Math.ceil(originalLength / 8);
        for (let part = 0; part < parts; part++) {
          const a = lerp(originalA, originalB, part / parts),
            b = lerp(originalA, originalB, (part + 1) / parts),
            len = distance(a, b);
          const mid = lerp(a, b, 0.5),
            near = roadIndex.nearest(...mid, true, 28);
          if (
            !near ||
            near.road.bridge ||
            near.road.tunnel ||
            ['motorway', 'trunk', 'service'].includes(near.road.kind) ||
            near.road.kind.includes('link')
          )
            continue;
          const roadLength = distance(near.a, near.b),
            dx = (b[0] - a[0]) / len,
            dz = (b[1] - a[1]) / len,
            rdx = (near.b[0] - near.a[0]) / roadLength,
            rdz = (near.b[1] - near.a[1]) / roadLength;
          if (
            Math.abs(dx * rdx + dz * rdz) < 0.58 ||
            near.distance < 1 ||
            near.distance > near.width / 2 + 6.5
          )
            continue;
          let nx = -dz,
            nz = dx,
            flipped = false;
          if ((near.x - mid[0]) * nx + (near.z - mid[1]) * nz < 0) {
            nx *= -1;
            nz *= -1;
            flipped = true;
          }
          if (inPolygon(mid[0] + nx * 0.24, mid[1] + nz * 0.24, polygon)) continue;
          if (!inPolygon(mid[0] - nx * 0.24, mid[1] - nz * 0.24, polygon)) continue;
          for (const [from, to] of sidewalkIntervals({ a, b, road: near.road }, roadIndex)) {
            const n = Math.max(1, Math.ceil((to - from) / 8));
            for (let j = 0; j < n; j++) {
              const ta = (from + ((to - from) * j) / n) / len,
                tb = (from + ((to - from) * (j + 1)) / n) / len,
                aa = lerp(a, b, ta),
                bb = lerp(a, b, tb),
                q = lerp(aa, bb, 0.5);
              if (
                surfaces.inWater(...q) ||
                surfaces.groundHeight(...q) > (surfaces.terrainOffsetAt?.(...q) || 0) + 0.45
              )
                continue;
              curbs.push({ a: aa, b: bb, nx, nz, polygon, road: near.road });
              onCurb?.({ polygon, ring, edge: i, part, flipped, ta, tb, road: near.road });
            }
          }
        }
      }
    }
  return curbs;
}

function drawSurveyedCurb(batch, s) {
  // Top sits on the surveyed .31m sidewalk. The vertical road-facing reveal is
  // generated only nearby; its .15m height is a design inference.
  const [ya, yb, yc, yd] = s.offsets || [0, 0, 0, 0];
  const a = [s.a[0], 0.314 + ya, s.a[1]],
    b = [s.b[0], 0.314 + yb, s.b[1]],
    c = [s.b[0] - s.nx * 0.18, 0.314 + yc, s.b[1] - s.nz * 0.18],
    d = [s.a[0] - s.nx * 0.18, 0.314 + yd, s.a[1] - s.nz * 0.18];
  const normal = (s.b[0] - s.a[0]) * -s.nz - (s.b[1] - s.a[1]) * -s.nx;
  if (normal < 0) batch.quad(a, b, c, d, palette.curb);
  else batch.quad(d, c, b, a, palette.curb);
  const aa = [a[0], a[1] - 0.15, a[2]],
    bb = [b[0], b[1] - 0.15, b[2]];
  if ((b[2] - a[2]) * s.nx - (b[0] - a[0]) * s.nz > 0) batch.quad(b, bb, aa, a, palette.curb);
  else batch.quad(a, aa, bb, b, palette.curb);
}

function drawSurveyedJoints(batch, s) {
  const len = distance(s.a, s.b),
    dx = (s.b[0] - s.a[0]) / len,
    dz = (s.b[1] - s.a[1]) / len;
  for (let d = 1.5; d < len - 0.12; d += 1.5) {
    const p = lerp(s.a, s.b, d / len),
      a = [p[0] - s.nx * 0.22, p[1] - s.nz * 0.22];
    let width = 0.25;
    for (; width < 4.2; width += 0.18)
      if (!inPolygon(p[0] - s.nx * width, p[1] - s.nz * width, s.polygon)) break;
    if (width < 0.5) continue;
    const b = [p[0] - s.nx * (width - 0.15), p[1] - s.nz * (width - 0.15)];
    const [ya, yb, yc, yd] = s.offsets || [0, 0, 0, 0],
      t = d / len,
      offset = ya + (yb - ya) * t,
      crossSlope = (yd - ya + (yc - yb - (yd - ya)) * t) / 0.18;
    batch.strip(
      a,
      b,
      -0.008,
      0.008,
      0.312 + offset + crossSlope * 0.22,
      0.312 + offset + crossSlope * (width - 0.15),
      palette.joint,
    );
  }
}

function drawSidewalk(batch, s, detailed = false) {
  const a = s.side * s.offset,
    b = s.side * (s.offset + s.width),
    lo = Math.min(a, b),
    hi = Math.max(a, b);
  if (!detailed) batch.strip(s.a, s.b, lo, hi, s.ya + 0.15, s.yb + 0.15, palette.sidewalk);
  const curb = [s.side * s.offset, s.side * (s.offset + 0.22)].sort((a, b) => a - b);
  if (detailed) batch.strip(s.a, s.b, ...curb, s.ya + 0.155, s.yb + 0.155, palette.curb, 0.155);
  const gutter = [s.side * (s.offset - 0.28), s.side * s.offset].sort((a, b) => a - b);
  if (!detailed) batch.strip(s.a, s.b, ...gutter, s.ya + 0.006, s.yb + 0.006, palette.gutter);
}

function drawCrossing(batch, c, offsetAt) {
  const nx = -c.dz,
    nz = c.dx;
  for (const side of [-1, 1]) {
    const x = c.x + c.dx * side * 1.35,
      z = c.z + c.dz * side * 1.35;
    const a = [x - (nx * c.width) / 2, z - (nz * c.width) / 2],
      b = [x + (nx * c.width) / 2, z + (nz * c.width) / 2];
    batch.strip(a, b, -0.13, 0.13, 0.184 + offsetAt(...a), 0.184 + offsetAt(...b), palette.paint);
  }
  for (const end of [-1, 1]) {
    // A shallow, zero-lip curb ramp and a contrasting 1.2 x .6m warning plate.
    const x = c.x + nx * (c.width / 2 + 0.06) * end,
      z = c.z + nz * (c.width / 2 + 0.06) * end;
    const outer = [x + nx * 2.0 * end, z + nz * 2.0 * end];
    batch.strip(
      [x, z],
      outer,
      -0.9,
      0.9,
      0.166 + offsetAt(x, z),
      0.31 + offsetAt(...outer),
      palette.sidewalk,
      0.025,
    );
    const a = [x + nx * 0.18 * end, z + nz * 0.18 * end],
      b = [x + nx * 0.78 * end, z + nz * 0.78 * end];
    batch.strip(a, b, -0.6, 0.6, 0.19 + offsetAt(...a), 0.23 + offsetAt(...b), palette.tactile);
  }
}

function drawFurniture(batch, item) {
  const { x, z, y, angle, kind, side } = item,
    dx = Math.sin(angle),
    dz = Math.cos(angle),
    nx = -dz,
    nz = dx;
  const at = (u, h, v) => [x + dx * u + nx * v * side, y + h, z + dz * u + nz * v * side];
  const box = (u, h, v, w, hh, d, tint) => {
    const p = at(u, h, v);
    batch.box(...p, w, hh, d, -angle + Math.PI / 2, tint);
  };
  if (kind === 'bench') {
    for (const u of [-0.7, 0.7]) {
      batch.beam(at(u, 0.06, -0.23), at(u, 0.48, -0.23), 0.045, palette.dark);
      batch.beam(at(u, 0.06, 0.23), at(u, 0.85, 0.23), 0.045, palette.dark);
      batch.beam(at(u, 0.65, -0.28), at(u, 0.65, 0.25), 0.04, palette.dark);
    }
    for (let v = -0.22; v < 0.24; v += 0.11) box(0, 0.48, v, 1.9, 0.065, 0.085, palette.wood);
    for (let h = 0.65; h < 0.94; h += 0.11) box(0, h, 0.25, 1.9, 0.085, 0.065, palette.wood);
  } else if (kind === 'bin') {
    box(0, 0.44, 0, 0.54, 0.87, 0.54, palette.dark);
    box(0, 0.91, 0, 0.61, 0.1, 0.61, palette.steel);
    box(0, 0.75, -0.281, 0.34, 0.14, 0.025, 0x151e1c);
    for (let u = -0.2; u <= 0.21; u += 0.1) box(u, 0.4, -0.281, 0.012, 0.65, 0.024, palette.concreteDark);
  } else if (kind === 'cycle-rack') {
    for (const u of [-0.55, 0, 0.55]) {
      batch.beam(at(u, 0, -0.33), at(u, 0.7, -0.33), 0.035, palette.steel, 6);
      batch.beam(at(u, 0.7, -0.33), at(u, 0.8, -0.19), 0.035, palette.steel, 6);
      batch.beam(at(u, 0.8, -0.19), at(u, 0.8, 0.19), 0.035, palette.steel, 6);
      batch.beam(at(u, 0.8, 0.19), at(u, 0.7, 0.33), 0.035, palette.steel, 6);
      batch.beam(at(u, 0.7, 0.33), at(u, 0, 0.33), 0.035, palette.steel, 6);
    }
  } else if (kind === 'bollard') {
    for (const u of [-0.65, 0.65]) {
      batch.beam(at(u, 0, 0), at(u, 0.88, 0), 0.075, palette.dark, 8);
      batch.beam(at(u, 0.66, 0), at(u, 0.73, 0), 0.082, palette.concrete, 8);
    }
  } else if (kind === 'lamp') {
    box(0, 0.15, 0, 0.27, 0.3, 0.27, palette.dark);
    batch.beam(at(0, 0.2, 0), at(0, 6.5, 0), 0.075, palette.dark, 6);
    batch.beam(at(0, 6.5, 0), at(0, 6.75, -1.15), 0.055, palette.dark, 6);
    box(0, 6.72, -1.27, 0.3, 0.13, 0.62, palette.steel);
    box(0, 6.64, -1.27, 0.25, 0.035, 0.51, 0xe5d6b2);
  }
}

function drawJoints(batch, sidewalk) {
  const len = distance(sidewalk.a, sidewalk.b),
    dx = (sidewalk.b[0] - sidewalk.a[0]) / len,
    dz = (sidewalk.b[1] - sidewalk.a[1]) / len;
  for (let d = 1.5; d < len - 0.1; d += 1.5) {
    const p = lerp(sidewalk.a, sidewalk.b, d / len),
      y = sidewalk.ya + ((sidewalk.yb - sidewalk.ya) * d) / len + 0.151;
    const a = [
        p[0] - dz * (sidewalk.offset + 0.24) * sidewalk.side,
        p[1] + dx * (sidewalk.offset + 0.24) * sidewalk.side,
      ],
      b = [
        p[0] - dz * (sidewalk.offset + sidewalk.width) * sidewalk.side,
        p[1] + dx * (sidewalk.offset + sidewalk.width) * sidewalk.side,
      ];
    batch.strip(a, b, -0.009, 0.009, y, y, palette.joint);
  }
}

function bridgeFrame(plan, t, offset = 0, y = plan.level) {
  const h = plan.deck?.heightAtStation(t, offset) ?? bridgeDeckHeight(plan, t);
  return bridgePathPoint(plan, t, offset, y + h - plan.level);
}

function drawConcreteArch(batch, p) {
  const half = concreteArchRibOffset(p),
    ribOffsets = [-half, half];
  for (let span = 0; span < p.spans; span++) {
    const start = span / p.spans,
      end = (span + 1) / p.spans,
      spanLength = p.length / p.spans;
    for (const side of ribOffsets) {
      for (let j = 0; j < 16; j++) {
        const u = j / 16,
          v = (j + 1) / 16,
          crown = p.level - 0.65,
          spring = Math.max(0.2, p.level - Math.min(5.5, spanLength * 0.13));
        const y = (t) => spring + (crown - spring) * Math.sin(Math.PI * t);
        // The City/CSCE heritage references identify Centre's open spandrels.
        // Mission's final rehabilitation concept and Louise's archive views
        // retain solid concrete above the arch. Keep the existing stations;
        // the exact span divisions have not been established by a plan.
        const pa = bridgeFrame(p, start + (end - start) * u, side, y(u)),
          pb = bridgeFrame(p, start + (end - start) * v, side, y(v));
        const pc = bridgeFrame(p, start + (end - start) * v, side, p.level - 0.24),
          pd = bridgeFrame(p, start + (end - start) * u, side, p.level - 0.24);
        if (p.spandrel !== 'open') {
          batch.quad(pa, pb, pc, pd, palette.concrete);
          batch.quad(pd, pc, pb, pa, palette.concrete);
        }
        batch.beam(
          bridgeFrame(p, start + (end - start) * u, side, y(u)),
          bridgeFrame(p, start + (end - start) * v, side, y(v)),
          0.42,
          palette.concrete,
          6,
        );
        const t = start + (end - start) * u,
          bottom = y(u);
        if (j % 2 === 0)
          batch.beam(
            bridgeFrame(p, t, side, bottom),
            bridgeFrame(p, t, side, p.level - 0.25),
            0.17,
            palette.concreteDark,
            4,
          );
      }
    }
  }
}

function drawParkerTruss(batch, p) {
  const steel = p.name.includes('MacDonald') ? 0x6b786a : palette.truss,
    height = p.name.includes('MacDonald') ? 6 : 8,
    spanLength = p.length / p.spans;
  for (let span = 0; span < p.spans; span++) {
    const start = span / p.spans,
      end = (span + 1) / p.spans,
      panels = 8;
    const top = (u) => p.level + height * (0.6 + 0.4 * Math.sin(Math.PI * u));
    for (const side of [-1, 1]) {
      const offset = side * trussHalfWidth(p);
      for (let i = 0; i < panels; i++) {
        const a = i / panels,
          b = (i + 1) / panels,
          ta = start + (end - start) * a,
          tb = start + (end - start) * b;
        const bottomA = bridgeFrame(p, ta, offset, p.level + 0.18),
          bottomB = bridgeFrame(p, tb, offset, p.level + 0.18),
          topA = bridgeFrame(p, ta, offset, top(a)),
          topB = bridgeFrame(p, tb, offset, top(b));
        batch.beam(bottomA, bottomB, 0.16, steel);
        batch.beam(topA, topB, 0.2, steel);
        batch.beam(bottomA, topA, 0.14, steel);
        batch.beam(i < panels / 2 ? bottomA : topA, i < panels / 2 ? topB : bottomB, 0.11, steel);
        // Paired inner flanges make members read as riveted girders up close.
        for (const dy of [-0.085, 0.085])
          batch.beam(
            [topA[0], topA[1] + dy, topA[2]],
            [topB[0], topB[1] + dy, topB[2]],
            0.055,
            palette.concreteDark,
          );
        if (i === panels - 1) batch.beam(bottomB, topB, 0.14, steel);
      }
    }
    for (let i = 0; i <= panels; i++) {
      const u = i / panels,
        t = start + (end - start) * u;
      batch.beam(
        bridgeFrame(p, t, -trussHalfWidth(p), top(u)),
        bridgeFrame(p, t, trussHalfWidth(p), top(u)),
        0.13,
        steel,
      );
      if (i < panels) {
        const tn = start + ((end - start) * (i + 1)) / panels;
        batch.beam(
          bridgeFrame(p, t, -trussHalfWidth(p), top(u)),
          bridgeFrame(p, tn, trussHalfWidth(p), top((i + 1) / panels)),
          0.055,
          steel,
        );
        batch.beam(
          bridgeFrame(p, t, trussHalfWidth(p), top(u)),
          bridgeFrame(p, tn, -trussHalfWidth(p), top((i + 1) / panels)),
          0.055,
          steel,
        );
      }
    }
    if (spanLength > 5)
      batch.beam(
        bridgeFrame(p, start, -trussHalfWidth(p), p.level + height * 0.6),
        bridgeFrame(p, start + 0.012, -trussHalfWidth(p), p.level + height * 0.6 - 0.8),
        0.22,
        steel,
      );
  }
}

function drawNetworkArch(batch, p) {
  for (let span = 0; span < 3; span++) {
    const start = span / 3,
      end = (span + 1) / 3,
      rise = span === 1 ? -2.8 : 11;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 24; i++) {
        const a = i / 24,
          b = (i + 1) / 24;
        const at = (u) =>
          bridgeFrame(
            p,
            start + (end - start) * u,
            side * (p.width / 2 - 0.1 - Math.sin(Math.PI * u) * 0.45),
            p.level + Math.sin(Math.PI * u) * rise,
          );
        batch.beam(at(a), at(b), 0.22, palette.whiteSteel, 8);
      }
      for (let i = 1; i < 15; i++) {
        const u = i / 15,
          v = clamp(u + (i % 2 ? -0.12 : 0.12), 0.03, 0.97);
        batch.beam(
          bridgeFrame(p, start + (end - start) * u, (side * p.width) / 2, p.level + 0.15),
          bridgeFrame(
            p,
            start + (end - start) * v,
            side * (p.width / 2 - 0.1 - Math.sin(Math.PI * v) * 0.45),
            p.level + Math.sin(Math.PI * v) * rise,
          ),
          0.024,
          palette.steel,
          4,
        );
      }
    }
  }
}

function drawWeatheringArch(batch, p, above = false) {
  const offset = p.width / 2 - (above ? 1.6 : 0.4),
    tint = above ? palette.whiteSteel : palette.weathering;
  for (const side of [-1, 1])
    for (let i = 0; i < 28; i++) {
      const a = i / 28,
        b = (i + 1) / 28,
        height = (u) =>
          above ? p.level + Math.sin(Math.PI * u) * 7.5 : 0.1 + Math.sin(Math.PI * u) * (p.level - 0.65);
      batch.beam(
        bridgeFrame(p, a, side * offset, height(a)),
        bridgeFrame(p, b, side * offset, height(b)),
        above ? 0.27 : 0.23,
        tint,
        6,
      );
      if (i % 2 === 1)
        batch.beam(
          bridgeFrame(p, a, side * offset, height(a)),
          bridgeFrame(p, a, side * offset, p.level - 0.12),
          0.035,
          tint,
          4,
        );
    }
}

function drawSuspension(batch, p) {
  const h = 7.4;
  for (const t of [0.07, 0.93]) {
    for (const side of [-1, 1])
      batch.beam(
        bridgeFrame(p, t, side * (p.width / 2 + 0.1), p.level - 0.2),
        bridgeFrame(p, t, side * (p.width / 2 + 0.1), p.level + h),
        0.15,
        palette.steel,
        6,
      );
    batch.beam(
      bridgeFrame(p, t, -p.width / 2 - 0.1, p.level + h),
      bridgeFrame(p, t, p.width / 2 + 0.1, p.level + h),
      0.14,
      palette.steel,
      6,
    );
  }
  const height = (t) => p.level + suspensionCableHeight(t);
  for (const side of [-1, 1]) {
    const samples = suspensionCableSamples();
    for (let i = 1; i < samples.length; i++)
      batch.beam(
        bridgeFrame(p, samples[i - 1], side * (p.width / 2 + 0.1), height(samples[i - 1])),
        bridgeFrame(p, samples[i], side * (p.width / 2 + 0.1), height(samples[i])),
        0.055,
        palette.steel,
        6,
      );
    for (let i = 2; i < 26; i++)
      batch.beam(
        bridgeFrame(p, i / 28, side * (p.width / 2 + 0.1), p.level + 0.12),
        bridgeFrame(p, i / 28, side * (p.width / 2 + 0.1), height(i / 28)),
        0.025,
        palette.steel,
        4,
      );
  }
}

function drawCableStayed(batch, p, layout) {
  // The City describes an A-shaped steel tower and a long stayed river span.
  // Bank attachment is inferred from the actual mapped water boundary; tower
  // height/member sizes are illustrative, not a source engineering model.
  const tower = layout.a,
    rise = 12.5;
  for (const side of [-1, 1]) {
    batch.beam(
      bridgeFrame(p, tower, side * (p.width / 2 + 0.55), -0.25 + p.level),
      bridgeFrame(p, tower, side * 0.12, p.level + rise),
      0.22,
      palette.whiteSteel,
      6,
    );
    for (let i = 1; i <= 8; i++) {
      const forward = tower + ((layout.b - tower) * i) / 9,
        back = Math.max(0.025, tower * (1 - i / 9));
      for (const t of [forward, back])
        batch.beam(
          bridgeFrame(p, tower, side * 0.18, p.level + rise - 0.5),
          bridgeFrame(p, t, side * (p.width / 2 - 0.1), p.level + 0.2),
          0.027,
          palette.steel,
          4,
        );
    }
  }
  batch.beam(
    bridgeFrame(p, tower, -p.width / 2 + 0.1, p.level + 3),
    bridgeFrame(p, tower, p.width / 2 - 0.1, p.level + 3),
    0.14,
    palette.whiteSteel,
    6,
  );
}

function drawLions(batch, p) {
  // Four paired stone guardians face away from the span. The stepped
  // gateway pedestals and reclining silhouettes follow the City's photos.
  const limestone = 0xc2bdab,
    trim = 0xd1c8b3;
  for (const t of [0.06, 0.94]) {
    const direction = t < 0.5 ? -1 : 1;
    for (const side of [-1, 1]) {
      const point = bridgeFrame(p, t, side * (p.width / 2 + 1.05), p.level);
      const q = samplePolyline(p.points, t),
        yaw = -Math.atan2(q.dx, q.dz);
      const local = (u, h, v) => [
        point[0] + q.dx * u * direction - q.dz * v,
        point[1] + h,
        point[2] + q.dz * u * direction + q.dx * v,
      ];
      const block = (u, h, v, w, height, d, tint = limestone) =>
        batch.box(...local(u, h, v), w, height, d, yaw, tint);
      block(0, 0.22, 0, 2.43, 0.44, 2.95);
      block(0, 0.53, 0, 2.22, 0.2, 2.7, trim);
      for (const v of [-0.76, 0.76]) {
        block(0, 1.92, v, 0.56, 2.59, 2.4);
        block(0, 3.11, v, 0.69, 0.23, 2.46, trim);
      }
      block(0, 3.34, 0, 2.37, 0.35, 2.78, trim);
      block(0, 3.58, 0, 2.03, 0.19, 2.42);
      batch.beam(local(-0.74, 3.91, 0), local(0.52, 4.14, 0), 0.39, limestone, 9);
      batch.beam(local(0.42, 4.07, 0), local(0.52, 4.72, 0), 0.37, limestone, 9);
      batch.beam(local(0.48, 4.69, 0), local(0.79, 4.69, 0), 0.29, trim, 8);
      block(0.95, 4.54, 0, 0.49, 0.21, 0.31, trim);
      for (const v of [-0.23, 0.23]) {
        batch.beam(local(0.26, 3.77, v), local(1.07, 3.77, v), 0.125, trim, 7);
        block(0.48, 4.88, v, 0.16, 0.17, 0.15);
      }
      batch.beam(local(-0.83, 3.78, 0.24), local(-1.02, 3.81, -0.28), 0.082, limestone, 6);
    }
  }
}

function drawTrack(batch, a, b, y0, y1, includeSleepers = true, includeBase = true) {
  const len = distance(a, b);
  if (len < 0.02) return;
  const dx = (b[0] - a[0]) / len,
    dz = (b[1] - a[1]) / len;
  if (includeBase)
    batch.strip(a, b, -1.55, 1.55, y0 + RAIL_PROFILE.bedTop, y1 + RAIL_PROFILE.bedTop, 0x74746c);
  for (const side of [-1, 1]) {
    const offset = side * RAIL_PROFILE.halfGauge;
    batch.beam(
      [a[0] - dz * offset, y0 + RAIL_PROFILE.railCenter, a[1] + dx * offset],
      [b[0] - dz * offset, y1 + RAIL_PROFILE.railCenter, b[1] + dx * offset],
      RAIL_PROFILE.railRadius,
      0x9daca5,
      6,
    );
  }
  if (includeSleepers)
    for (let d = 0.3; d < len; d += 0.75) {
      const t = d / len,
        q = lerp(a, b, t),
        y = y0 + (y1 - y0) * t + 0.075;
      batch.beam(
        [q[0] - dz * 1.25, y, q[1] + dx * 1.25],
        [q[0] + dz * 1.25, y, q[1] - dx * 1.25],
        0.075,
        palette.concreteDark,
        4,
      );
    }
}

function drawBridgeGuard(batch, p, guard, side, ta, tb) {
  const a = samplePolyline(p.points, ta),
    b = samplePolyline(p.points, tb),
    aa = [a.x, a.z],
    bb = [b.x, b.z],
    y0 = bridgeDeckHeight(p, ta),
    y1 = bridgeDeckHeight(p, tb),
    offset = side * bridgeGuardOffset(p),
    top = p.level + (p.drive ? 1.18 : 1.2),
    bottom = p.level + 0.18;
  if (guard === 'concrete-road-parapet') {
    const profile = observedBridgeGuardProfile(p, side),
      h0 = p.deck.heightAtStation(ta, offset),
      h1 = p.deck.heightAtStation(tb, offset);
    batch.band(
      bridgeBand(
        p,
        ta,
        tb,
        offset - profile.width / 2,
        offset + profile.width / 2,
        h0 + profile.concreteTop,
        h1 + profile.concreteTop,
      ),
      palette.concrete,
      profile.concreteTop - profile.lower,
    );
    if (profile.capHeight != null) {
      batch.beam(
        bridgeFrame(p, ta, offset, p.level + profile.capHeight),
        bridgeFrame(p, tb, offset, p.level + profile.capHeight),
        profile.capRadius,
        palette.steel,
        6,
      );
      for (const t of bridgeGuardCapStations(p, ta, tb, profile.postSpacing))
        batch.beam(
          bridgeFrame(p, t, offset, p.level + profile.concreteTop),
          bridgeFrame(p, t, offset, p.level + profile.capHeight),
          profile.postRadius,
          palette.steel,
          4,
        );
    }
    return;
  }
  if (guard === 'heritage-concrete') {
    const h0 = p.deck?.heightAtStation(ta, offset) ?? y0,
      h1 = p.deck?.heightAtStation(tb, offset) ?? y1;
    batch.band(
      bridgeBand(p, ta, tb, offset - 0.18, offset + 0.18, h0 + 1.2, h1 + 1.2),
      palette.concrete,
      0.14,
    );
    batch.band(
      bridgeBand(p, ta, tb, offset - 0.16, offset + 0.16, h0 + 0.35, h1 + 0.35),
      palette.concrete,
      0.2,
    );
    return;
  }
  if (guard === 'king-cables' || guard === 'traverse-pickets') {
    const outboard = side * bridgeGuardOffset(p),
      height = p.level + (guard === 'king-cables' ? 0.88 : 1.12);
    batch.beam(
      bridgeFrame(p, ta, outboard, height),
      bridgeFrame(p, tb, outboard, height),
      guard === 'king-cables' ? 0.035 : 0.028,
      guard === 'king-cables' ? palette.steel : palette.whiteSteel,
      6,
    );
    return;
  }
  batch.beam(bridgeFrame(p, ta, offset, top), bridgeFrame(p, tb, offset, top), 0.045, palette.steel, 6);
  batch.beam(
    bridgeFrame(p, ta, offset, bottom + 0.44),
    bridgeFrame(p, tb, offset, bottom + 0.44),
    0.027,
    palette.steel,
    4,
  );
  batch.beam(bridgeFrame(p, ta, offset, bottom), bridgeFrame(p, ta, offset, top), 0.045, palette.steel, 4);
  if ((p.accessOpenings || []).some((o) => o.side === side && Math.abs(o.from - tb) < 1e-8))
    batch.beam(bridgeFrame(p, tb, offset, bottom), bridgeFrame(p, tb, offset, top), 0.045, palette.steel, 4);
}

function drawBridge(batch, p, surfaces) {
  const guard = bridgeGuardStyle(p),
    stayed = p.type === 'cable-stayed' ? cableStayLayout(p, surfaces) : null;
  for (const [i, segment] of p.deck.segments.entries()) {
    const { from, to, a: aa, b: bb, h0: y0, h1: y1 } = segment;
    batch.band(segment.slab, palette.concrete, segment.depth, segment.deckStart, segment.deckEnd);
    for (const { band, kind, thickness } of segment.paving)
      batch.band(
        band,
        kind === 'asphalt'
          ? palette.asphalt
          : kind === 'ballast'
            ? 0x74746c
            : kind === 'guideway-concrete' || kind === 'guideway-plinth'
              ? palette.concrete
              : palette.sidewalk,
        thickness,
        segment.deckStart,
        segment.deckEnd,
      );
    if (p.rail) drawTrack(batch, aa, bb, y0, y1, p.trackFinish !== 'direct-fixation', false);
    for (const side of [-1, 1])
      for (const [ta, tb] of bridgeGuardIntervals(p, side, from, to))
        drawBridgeGuard(batch, p, guard, side, ta, tb);
    if (p.drive && i % 3 === 0) {
      const pa = bridgeFrame(p, from, 0, p.level + 0.012),
        pb = bridgeFrame(p, from + (to - from) * 0.65, 0, p.level + 0.012);
      batch.strip([pa[0], pa[2]], [pb[0], pb[2]], -0.07, 0.07, pa[1], pb[1], palette.paint);
    }
  }
  // Concrete abutments, bearing caps and intermediate piers are distinct from
  // the visible deck. River stage is simplified, and foundations are inferred.
  const supports = stayed?.supports || Array.from({ length: p.spans + 1 }, (_, i) => i / p.spans);
  for (let i = 0; i < supports.length; i++) {
    const t = supports[i],
      q = samplePolyline(p.points, t),
      angle = Math.atan2(q.dx, q.dz),
      deck = bridgeDeckHeight(p, t),
      bearingSeat = p.type === 'parker-truss',
      bottom = surfaces.regionalOffsetAt?.(q.x, q.z) || 0,
      h = deck - bottom - (bearingSeat ? 0.95 : 0.5);
    const own = new Set(p.roads.map((r) => r.id));
    const blocksUnderpass =
      i > 0 &&
      i < supports.length - 1 &&
      [...surfaces.driveIndex.index.near(q.x, q.z, 18)].some(
        (s) =>
          !own.has(s.road.id) &&
          !s.road.bridge &&
          nearestOnSegment(q.x, q.z, s.a, s.b).distance < s.width / 2 + 1,
      );
    if (h > 0.3 && !blocksUnderpass) {
      if (p.lions) {
        // Preserve the lower-deck opening beneath the Centre Street upper deck.
        for (const side of [-1, 1]) {
          const point = bridgeFrame(p, t, side * (p.width / 2 - 1.0));
          point[1] = bottom + h / 2;
          batch.box(...point, 1.1, h, 1.7, angle, palette.concreteDark);
        }
      } else {
        batch.box(
          q.x,
          bottom + h / 2,
          q.z,
          p.width * 0.66,
          h,
          i === 0 || i === p.spans ? 2.4 : 1.2,
          angle,
          palette.concreteDark,
        );
      }
      batch.box(
        q.x,
        deck - (bearingSeat ? 0.8 : 0.4),
        q.z,
        p.width * 0.91,
        0.36,
        1.6,
        angle,
        palette.concrete,
      );
    }
    const a = bridgeFrame(p, t, -p.width / 2, p.level + 0.006),
      b = bridgeFrame(p, t, p.width / 2, p.level + 0.006);
    // Continuous concrete ties do not have a fabricated movement joint at
    // every pier. Independent truss spans do retain their intermediate seam.
    if (i === 0 || i === supports.length - 1 || p.type === 'parker-truss')
      batch.strip([a[0], a[2]], [b[0], b[2]], -0.025, 0.025, a[1], b[1], palette.dark);
  }
  if (p.type === 'concrete-arch') drawConcreteArch(batch, p);
  else if (p.type === 'parker-truss') drawParkerTruss(batch, p);
  else if (p.type === 'network-arch') drawNetworkArch(batch, p);
  else if (p.type === 'weathering-arch') drawWeatheringArch(batch, p);
  else if (p.type === 'twin-arch') drawWeatheringArch(batch, p, true);
  else if (p.type === 'suspension') drawSuspension(batch, p);
  else if (stayed) drawCableStayed(batch, p, stayed);
  else {
    const offsets = p.drive ? [-p.width / 3, 0, p.width / 3] : [-p.width * 0.3, p.width * 0.3];
    for (const offset of offsets)
      for (let j = 1; j < p.points.length; j++)
        batch.beam(
          bridgeFrame(p, (j - 1) / (p.points.length - 1), offset, p.level - 0.6),
          bridgeFrame(p, j / (p.points.length - 1), offset, p.level - 0.6),
          p.type === 'box-girder' ? 0.46 : 0.24,
          p.type === 'jaipur' ? palette.weathering : palette.concreteDark,
          4,
        );
  }
  // Jaipur's completed floral screens and timber seating are fine, open
  // geometry in the bounded nearby tile; no obsolete tied-arch or opaque X.
  if (p.lions) drawLions(batch, p);
}

// At a fork, both road ribbons keep their asphalt. An inferred shoulder can
// occupy only the space outside all carriageways at the same level. Test the
// whole shoulder width so a rail at its outer edge cannot span a merge either.
export function approachRoadEdgeIntervals(segment, side, width, surfaces, rampRoads) {
  const { a, b, road, h0, h1 } = segment,
    len = distance(a, b);
  if (len < 0.01) return [];
  const dx = (b[0] - a[0]) / len,
    dz = (b[1] - a[1]) / len,
    shoulder = (width - roadWidth(road)) / 2,
    midOffset = (side * (width - shoulder)) / 2;
  const nearby = [...surfaces.roadIndex.index.near(...lerp(a, b, 0.5), len / 2 + width / 2 + 16)].filter(
    (other) =>
      other.road.id !== road.id &&
      DRIVABLE.has(other.road.kind) &&
      !other.road.tunnel &&
      !(segment.plan?.roads || []).some((owner) => owner.id === other.road.id),
  );
  if (!nearby.length) return [[0, len]];
  const blocked = [],
    steps = Math.ceil(len / 0.45);
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps,
      [cx, cz] = lerp(a, b, t),
      x = cx - dz * midOffset,
      z = cz + dx * midOffset,
      height = h0 + (h1 - h0) * t;
    if (
      nearby.some((other) => {
        const hit = nearestOnSegment(x, z, other.a, other.b);
        if (hit.distance >= other.width / 2 + shoulder / 2 + 0.08) return false;
        const join = rampRoads.has(other.road.id);
        const level = surfaces.surfaceHeight(hit.x, hit.z, other.road);
        return Math.abs(level - height) < (join ? 1.25 : 0.38);
      })
    )
      blocked.push([(i * len) / steps, ((i + 1) * len) / steps]);
  }
  return subtractIntervals(len, blocked);
}

function drawApproaches(batch, p, surfaces) {
  const rampRoads = p.drive && new Set(p.approaches.map((s) => s.road.id));
  for (const s of p.approaches) {
    const width = s.width ?? (p.peace ? roadWidth(s.road) : p.width);
    const n = Math.max(1, Math.ceil(distance(s.a, s.b) / 8));
    for (let i = 0; i < n; i++) {
      const t0 = i / n,
        t1 = (i + 1) / n,
        a = lerp(s.a, s.b, t0),
        b = lerp(s.a, s.b, t1),
        y0 = surfaces.surfaceHeight(...a, s.road),
        y1 = surfaces.surfaceHeight(...b, s.road);
      if (!p.drive) batch.strip(a, b, -width / 2, width / 2, y0 - 0.05, y1 - 0.05, palette.sidewalk, 0.3);
      if (s.accessBranch) batch.strip(a, b, -width / 2, width / 2, y0, y1, palette.sidewalk);
      // The main road/track batches own the carriageway tops and rail beds.
      const len = distance(a, b),
        dx = (b[0] - a[0]) / len,
        dz = (b[1] - a[1]) / len,
        segment = { ...s, a, b, h0: y0, h1: y1 };
      for (const side of [-1, 1]) {
        const edge = p.drive
          ? approachRoadEdgeIntervals(segment, side, width, surfaces, rampRoads)
          : [[0, len]];
        if (p.drive) {
          const offsets = [(side * (width - 4.2)) / 2, (side * width) / 2].sort((a, b) => a - b);
          const outer = (side * width) / 2;
          for (const [from, to] of edge) {
            const aa = lerp(a, b, from / len),
              bb = lerp(a, b, to / len);
            const ya = y0 + ((y1 - y0) * from) / len,
              yb = y0 + ((y1 - y0) * to) / len;
            if (!p.compactShoulders)
              batch.strip(aa, bb, ...offsets, ya + 0.15, yb + 0.15, palette.sidewalk, 0.15);
            // Only the visible outside fascia belongs to the inferred slab.
            // Its concrete top can peek through independently sloped asphalt
            // at forks and onto an adjacent approach that shares the junction.
            const topA = [aa[0] - dz * outer, ya + 0.003, aa[1] + dx * outer],
              topB = [bb[0] - dz * outer, yb + 0.003, bb[1] + dx * outer],
              bottomA = [topA[0], ya - 0.35, topA[2]],
              bottomB = [topB[0], yb - 0.35, topB[2]];
            if (side === 1) batch.quad(topA, topB, bottomB, bottomA, palette.concreteDark);
            else batch.quad(topB, topA, bottomA, bottomB, palette.concreteDark);
          }
        }
        const crossings = p.rail
          ? [[0, len]]
          : (s.accessBranch ? accessRailIntervals : approachRailIntervals)(segment, side, width, surfaces);
        const intervals = edge.flatMap(([left, right]) =>
          crossings
            .map(([from, to]) => [Math.max(left, from), Math.min(right, to)])
            .filter(([from, to]) => to - from > 0.3),
        );
        for (const [from, to] of intervals) {
          const aa = lerp(a, b, from / len),
            bb = lerp(a, b, to / len),
            yy0 = y0 + ((y1 - y0) * from) / len,
            yy1 = y0 + ((y1 - y0) * to) / len;
          const offset = side * (width / 2 - 0.1),
            pa = [aa[0] - dz * offset, yy0 + 1.15, aa[1] + dx * offset],
            pb = [bb[0] - dz * offset, yy1 + 1.15, bb[1] + dx * offset];
          if (Math.max(yy0, yy1) > 0.65) {
            batch.beam(pa, pb, 0.04, palette.steel, 6);
            batch.beam([pa[0], yy0 + 0.1, pa[2]], pa, 0.04, palette.steel, 4);
          }
        }
      }
    }
  }
}

function drawSkywalk(batch, glass, road) {
  const points = validPoints(road.points),
    level = INFRASTRUCTURE_LIMITS.skywalkLevel * Math.max(1, Math.min(2, Number(road.layer) || 1)),
    width = 2.8,
    height = 2.65;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      len = distance(a, b);
    if (len < 1) continue;
    const dx = (b[0] - a[0]) / len,
      dz = (b[1] - a[1]) / len,
      angle = Math.atan2(dx, dz),
      mid = lerp(a, b, 0.5);
    batch.strip(a, b, -width / 2, width / 2, level, level, palette.skywalk, 0.32);
    batch.strip(
      a,
      b,
      -width / 2 - 0.12,
      width / 2 + 0.12,
      level + height,
      level + height,
      palette.skywalk,
      0.18,
    );
    for (const side of [-1, 1]) {
      const offset = (side * width) / 2;
      glass.box(
        mid[0] - dz * offset,
        level + height / 2,
        mid[1] + dx * offset,
        len,
        height - 0.3,
        0.055,
        -angle + Math.PI / 2,
        palette.glass,
      );
      for (let d = 0; d < len + 0.1; d += 2.2) {
        const p = lerp(a, b, Math.min(1, d / len));
        batch.beam(
          [p[0] - dz * offset, level, p[1] + dx * offset],
          [p[0] - dz * offset, level + height, p[1] + dx * offset],
          0.04,
          palette.skywalk,
        );
      }
      for (const h of [0.15, 1.0, height - 0.1])
        batch.beam(
          [a[0] - dz * offset, level + h, a[1] + dx * offset],
          [b[0] - dz * offset, level + h, b[1] + dx * offset],
          0.045,
          palette.skywalk,
        );
    }
  }
}

function trackPlans(data, surfaces, buildingIndex) {
  const tracks = [],
    supports = [],
    poleIndex = new SpatialIndex(24);
  for (const road of data.rails || []) {
    if (road.tunnel || surfaces.ownsRoad(road) || !['rail', 'light_rail'].includes(road.kind)) continue;
    const points = validPoints(road.points);
    for (let i = 1; i < points.length; i++) {
      const len = distance(points[i - 1], points[i]),
        parts = Math.max(1, Math.ceil(len / 14));
      for (let j = 0; j < parts; j++) {
        const a = lerp(points[i - 1], points[i], j / parts),
          b = lerp(points[i - 1], points[i], (j + 1) / parts),
          mid = lerp(a, b, 0.5);
        if (!inDatasetBounds(data, ...mid)) continue;
        tracks.push({
          a,
          b,
          road,
          y0: surfaces.surfaceHeight(...a, road),
          y1: surfaces.surfaceHeight(...b, road),
        });
      }
    }
    if (road.kind !== 'light_rail') continue;
    const total = points.slice(1).reduce((v, p, i) => v + distance(points[i], p), 0);
    for (let d = 20; d < total - 8; d += 48) {
      const p = samplePolyline(points, d / total);
      if (!inDatasetBounds(data, p.x, p.z)) continue;
      const x = p.x - p.dz * 2.7,
        z = p.z + p.dx * 2.7;
      if (!buildingClear(buildingIndex, surfaces.inWater, x, z, 0.35)) continue;
      if ([...poleIndex.near(x, z, 15)].some((q) => Math.hypot(q.x - x, q.z - z) < 15)) continue;
      const item = {
        x,
        z,
        centerX: p.x,
        centerZ: p.z,
        dx: p.dx,
        dz: p.dz,
        y: surfaces.surfaceHeight(p.x, p.z, road),
        road,
      };
      supports.push(item);
      poleIndex.insert(item, pointBox(x, z));
    }
  }
  return { tracks, supports };
}

function drawTrackDetails(batch, s) {
  const len = distance(s.a, s.b);
  if (len < 0.02) return;
  const dx = (s.b[0] - s.a[0]) / len,
    dz = (s.b[1] - s.a[1]) / len;
  for (let d = 0.3; d < len; d += 0.75) {
    const t = d / len,
      p = lerp(s.a, s.b, t),
      y = s.y0 + (s.y1 - s.y0) * t + 0.075;
    batch.beam(
      [p[0] - dz * 1.25, y, p[1] + dx * 1.25],
      [p[0] + dz * 1.25, y, p[1] - dx * 1.25],
      0.075,
      palette.concreteDark,
      4,
    );
  }
  if (s.road.kind === 'light_rail') {
    batch.beam([s.a[0], s.y0 + 5.8, s.a[1]], [s.b[0], s.y1 + 5.8, s.b[1]], 0.025, palette.steel, 4);
    batch.beam([s.a[0], s.y0 + 6.45, s.a[1]], [s.b[0], s.y1 + 6.45, s.b[1]], 0.025, palette.steel, 4);
    for (let d = 4; d < len; d += 8) {
      const t = d / len,
        p = lerp(s.a, s.b, t),
        y = s.y0 + (s.y1 - s.y0) * t;
      batch.beam([p[0], y + 5.8, p[1]], [p[0], y + 6.45, p[1]], 0.018, palette.steel, 4);
    }
  }
}

function drawCatenarySupport(batch, s) {
  batch.beam([s.x, s.y, s.z], [s.x, s.y + 6.8, s.z], 0.085, palette.steel, 6);
  batch.beam(
    [s.x, s.y + 6.1, s.z],
    [s.centerX + s.dz * 0.65, s.y + 6.1, s.centerZ - s.dx * 0.65],
    0.055,
    palette.steel,
    4,
  );
  batch.beam([s.x, s.y + 6.7, s.z], [s.centerX, s.y + 6.1, s.centerZ], 0.035, palette.steel, 4);
  batch.beam([s.centerX, s.y + 6.1, s.centerZ], [s.centerX, s.y + 5.8, s.centerZ], 0.048, palette.dark, 6);
}

export function selectInfrastructureDetails(definitions, camera, quality = 'balanced') {
  const high = quality === 'high',
    radius = high ? INFRASTRUCTURE_LIMITS.highRadius : INFRASTRUCTURE_LIMITS.balancedRadius,
    limit = high ? INFRASTRUCTURE_LIMITS.highFurniture : INFRASTRUCTURE_LIMITS.balancedFurniture;
  if (camera.position.y > 230) return [];
  return definitions
    .map((item) => ({ item, d: (item.x - camera.position.x) ** 2 + (item.z - camera.position.z) ** 2 }))
    .filter(({ d }) => d < radius ** 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ item }) => item);
}

function infrastructureMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }),
    base = attribute('color', 'vec3'),
    horizontal = smoothstep(0.55, 0.9, normalWorld.y),
    asphalt = float(1).sub(smoothstep(0.002, 0.012, length(base.sub(color(palette.asphalt))))),
    neutral = float(1).sub(smoothstep(0.04, 0.13, max(abs(base.r.sub(base.g)), abs(base.g.sub(base.b))))),
    concrete = step(0.21, dot(base, vec3(0.2126, 0.7152, 0.0722))).mul(neutral),
    pavement = max(asphalt, concrete).mul(horizontal),
    coordinate = positionWorld.xz.mul(48),
    fine = float(1).sub(smoothstep(0.15, 0.75, max(fwidth(coordinate.x), fwidth(coordinate.y)))),
    grit = noise2D(coordinate).sub(0.5).mul(fine),
    weathering = noise2D(positionWorld.xz.mul(0.35)).sub(0.5).mul(0.04),
    wet = cityUniforms.uRoadWetness.mul(pavement),
    snow = cityUniforms.uSnow.mul(pavement);
  // Explicit colour attribute: enabling vertexColors here would multiply the
  // source colours a second time. Only horizontal pavement gets aggregate.
  const dry = base.mul(grit.mul(0.14).add(weathering).mul(pavement).add(1));
  material.colorNode = mix(dry.mul(float(1).sub(wet.mul(0.23))), color(0xe1e9ed), snow.mul(0.85));
  material.emissiveNode = streetLightWash(material.colorNode.mul(pavement));
  material.roughnessNode = mix(
    mix(float(0.9), float(0.3), wet.mul(asphalt.mul(0.5).add(0.5))),
    float(0.94),
    snow,
  );
  material.normalNode = bumpNormal(grit.mul(pavement).mul(0.002));
  return material;
}

export function buildInfrastructureDetailGeometry(tile) {
  const batch = new Batch();
  for (const s of tile.sidewalks) {
    drawJoints(batch, s);
    drawSidewalk(batch, s, true);
  }
  for (const s of tile.curbs) {
    drawSurveyedCurb(batch, s);
    drawSurveyedJoints(batch, s);
  }
  for (const s of tile.tracks) drawTrackDetails(batch, s);
  for (const s of tile.supports) drawCatenarySupport(batch, s);
  for (const s of tile.bridgePickets)
    batch.beam([s.x, s.y, s.z], [s.x, s.y + s.h, s.z], 0.018, palette.steel, 4);
  const beforeConnections = batch.positions.length;
  for (const item of tile.bridgeConnections) drawBridgeConnection(batch, item);
  return {
    geometry: batch.geometry(),
    connectionTriangles: (batch.positions.length - beforeConnections) / 9,
  };
}

export function buildInfrastructure(scene, data, context = {}) {
  const surfaces = context.surfaces || createInfrastructureSurfaces(data, context);
  const definitions = collectStreetPlans(data, { ...context, surfaces });
  const siteExclusions = context.siteExclusions || [],
    inClosedSite = (x, z) => siteExclusions.some((site) => inPolygon(x, z, site)),
    lightingCoverage =
      context.lightingCoverage || context.surveyedLighting?.covers?.bind(context.surveyedLighting);
  let surveyedLampSuppressions = 0,
    surveyedFurnitureSuppressions = 0;
  definitions.furniture = definitions.furniture.filter((item) => {
    if (inClosedSite(item.x, item.z)) return false;
    if (item.kind === 'lamp' && lightingCoverage?.(item.x, item.z)) {
      surveyedLampSuppressions++;
      return false;
    }
    if (context.furnitureCoverage?.(item.kind, item.x, item.z)) {
      surveyedFurnitureSuppressions++;
      return false;
    }
    return true;
  });
  const furnitureIds = new Map(definitions.furniture.map((item, index) => [item, index])),
    signalIds = new Map(definitions.signals.map((item, index) => [item, index])),
    selectionKey = (items, ids) =>
      items
        .map((item) => ids.get(item))
        .sort((a, b) => a - b)
        .join(',');
  const material = infrastructureMaterial();
  const glassMaterial = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.35,
  });
  const size = INFRASTRUCTURE_LIMITS.tileSize,
    tiles = new Map(),
    makeTile = (x, z) => {
      const key = `${Math.floor(x / size)},${Math.floor(z / size)}`;
      if (!tiles.has(key))
        tiles.set(key, {
          key,
          x: (Math.floor(x / size) + 0.5) * size,
          z: (Math.floor(z / size) + 0.5) * size,
          batch: new Batch(),
          sidewalks: [],
          curbs: [],
          tracks: [],
          supports: [],
          bridgePickets: [],
          bridgeConnections: [],
          crossings: [],
          mesh: null,
          detail: null,
        });
      return tiles.get(key);
    };
  for (const s of definitions.sidewalks) {
    const tile = makeTile((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2);
    if (!definitions.surveyed.length) {
      drawSidewalk(tile.batch, s);
      tile.sidewalks.push(s);
    }
  }
  for (const s of definitions.surveyedCurbs)
    makeTile((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2).curbs.push(s);
  const terrainOffsetAt = surfaces.terrainOffsetAt || (() => 0);
  const trackData = trackPlans(data, surfaces, context.buildingIndex),
    railHeads = new Map(),
    staticKey = (x, z) =>
      `${Math.floor(x / INFRASTRUCTURE_LIMITS.staticTileSize)},${Math.floor(z / INFRASTRUCTURE_LIMITS.staticTileSize)}`;
  for (const s of trackData.tracks) {
    const key = staticKey((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2);
    if (!railHeads.has(key)) railHeads.set(key, new Batch());
    drawTrack(railHeads.get(key), s.a, s.b, s.y0, s.y1, false, false);
    makeTile((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2).tracks.push(s);
  }
  for (const s of trackData.supports) if (!inClosedSite(s.x, s.z)) makeTile(s.x, s.z).supports.push(s);
  for (const p of surfaces.plans) {
    if (bridgeGuardStyle(p) !== 'standard') continue;
    const count = Math.max(1, Math.ceil(p.length / 0.68));
    for (let i = 0; i <= count; i++)
      for (const side of [-1, 1]) {
        if (isBridgeGuardOpen(p, i / count, side)) continue;
        const q = bridgeFrame(p, i / count, side * (p.width / 2 - 0.1), p.level + 0.18);
        makeTile(q[0], q[2]).bridgePickets.push({ x: q[0], y: q[1], z: q[2], h: p.drive ? 0.96 : 0.98 });
      }
  }
  const bridgeConnections = collectBridgeConnections(surfaces, {
    heightAt: bridgeDeckHeight,
    includePeace: [...(data.roads || [])].some(isPeaceBridgeRoad),
  });
  for (const item of bridgeConnections.items) makeTile(item.x, item.z).bridgeConnections.push(item);
  const crossingBatch = new Batch();
  let mappedCrossingSuppressions = 0;
  for (const c of definitions.crossings) {
    if (context.mappedCrossings?.covers(c.x, c.z, c.dx, c.dz)) mappedCrossingSuppressions++;
    else drawCrossing(crossingBatch, c, terrainOffsetAt);
  }
  const meshes = [],
    bridges = [];
  for (const tile of tiles.values()) {
    tile.mesh = meshFor(tile.batch, material, 'Raised sidewalks, curbs and pedestrian crossings', false);
    tile.batch = null;
    if (tile.mesh) {
      scene.add(tile.mesh);
      meshes.push(tile.mesh);
    }
  }
  const crossingMesh = meshFor(
    crossingBatch,
    material,
    'Mapped-junction crossing paint and curb-ramp details',
    false,
  );
  if (crossingMesh) {
    scene.add(crossingMesh);
    meshes.push(crossingMesh);
  }
  const railHeadMesh = addStaticBatches(
    scene,
    [...railHeads.values()].map((batch) => batch.geometry()),
    material,
    'Mapped standard-gauge railway and CTrain rails',
  );
  if (railHeadMesh) meshes.push(railHeadMesh);
  const bridgeGroups = new Map();
  for (const p of surfaces.plans) {
    const center = samplePolyline(p.points, 0.5),
      major = p.type !== 'girder',
      key = major ? p.name : `${Math.floor(center.x / 800)},${Math.floor(center.z / 800)}`;
    if (!bridgeGroups.has(key))
      bridgeGroups.set(key, {
        batch: new Batch(),
        name: major ? p.name : 'Bridge and overpass structural tile',
        x: major ? center.x : (Math.floor(center.x / 800) + 0.5) * 800,
        z: major ? center.z : (Math.floor(center.z / 800) + 0.5) * 800,
      });
    const group = bridgeGroups.get(key);
    drawBridge(group.batch, p, surfaces);
    drawApproaches(group.batch, p, surfaces);
  }
  if (surfaces.peace.southLanding) {
    const middle = samplePolyline([peaceA, peaceB], 0.5),
      batch = new Batch(),
      paving = new Batch();
    drawApproaches(batch, { peace: true, drive: false, approaches: surfaces.peace.segments }, surfaces);
    const { rows } = surfaces.peace.southLanding;
    for (let i = 1; i < rows.length; i++) {
      for (let j = 1; j < rows[i].length; j++) {
        const a = rows[i - 1][j - 1],
          c = rows[i][j];
        paving.triangle(a, rows[i - 1][j], c, palette.sidewalk);
        paving.triangle(a, c, rows[i][j - 1], palette.sidewalk);
      }
      for (const j of [0, rows[i].length - 1]) {
        const a = rows[i - 1][j],
          b = rows[i][j];
        if (Math.max(a[1], b[1]) < 0.21) continue;
        const c = [b[0], 0.13, b[2]],
          d = [a[0], 0.13, a[2]];
        if (j === 0) batch.quad(a, b, c, d, palette.concreteDark);
        else batch.quad(b, a, d, c, palette.concreteDark);
      }
    }
    const southPlaza = meshFor(
      paving,
      surfaceMaterial('concrete', context.compactPavement),
      'Peace Bridge south plaza paving',
      false,
    );
    scene.add(southPlaza);
    meshes.push(southPlaza);
    bridgeGroups.set('Peace access pathways', {
      batch,
      name: 'Peace Bridge mapped access branches',
      x: middle.x,
      z: middle.z,
    });
  }
  for (const group of bridgeGroups.values()) {
    const mesh = meshFor(group.batch, material, group.name);
    group.batch = null;
    if (mesh) {
      scene.add(mesh);
      meshes.push(mesh);
      bridges.push({ mesh, x: group.x, z: group.z });
    }
  }
  const skyTiles = new Map();
  for (const road of surfaces.skywalks) {
    const middle = samplePolyline(road.points, 0.5),
      key = staticKey(middle.x, middle.z);
    if (!skyTiles.has(key)) skyTiles.set(key, { solid: new Batch(), glass: new Batch() });
    const tile = skyTiles.get(key);
    drawSkywalk(tile.solid, tile.glass, road);
  }
  for (const [field, mat, name] of [
    ['solid', material, 'Elevated Plus 15 frames and decks'],
    ['glass', glassMaterial, 'Plus 15 glazing'],
  ]) {
    const mesh = addStaticBatches(
      scene,
      [...skyTiles.values()].map((tile) => tile[field].geometry()),
      mat,
      name,
      true,
    );
    if (mesh) meshes.push(mesh);
  }
  let furnitureMesh = null,
    lastFurnitureKey = '',
    activeTileKeys = '',
    lastUpdateX = Infinity,
    lastUpdateZ = Infinity,
    lastQuality = '',
    lastAerial = null;
  // Definitions and tile recipes belong to this world. Retain packed primitives
  // across overlapping nearby selections without retaining the whole city.
  const furnitureCache = new InfrastructureCache(8 * 1024 * 1024, 640),
    signalCache = new InfrastructureCache(4 * 1024 * 1024, 144),
    tileCache = new InfrastructureCache(4 * 1024 * 1024, 32, (entry) => entry.geometry.dispose());
  const signalIndex = new SpatialIndex(80);
  for (const s of definitions.signals) signalIndex.insert(s, pointBox(s.stopX, s.stopZ));
  const signalLensMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, toneMapped: false });
  const signalLenses = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.115, 8, 6),
    signalLensMaterial,
    INFRASTRUCTURE_LIMITS.highSignals * 2,
  );
  signalLenses.name = 'Active traffic and pedestrian signal lenses';
  signalLenses.frustumCulled = false;
  signalLenses.count = 0;
  scene.add(signalLenses);
  let signalMesh = null,
    activeSignals = [],
    lastSignalKey = '',
    signalClock = 0,
    lastSignalTick = -1;
  const signalDummy = new THREE.Object3D(),
    signalColor = new THREE.Color();
  const stats = {
    sidewalkSections: definitions.surveyed.length || definitions.sidewalks.length,
    surveyedSidewalks: definitions.surveyed.length,
    surveyedCurbSections: definitions.surveyedCurbs.length,
    crossings: definitions.crossings.length,
    furniture: definitions.furniture.length,
    surveyedLampSuppressions,
    surveyedFurnitureSuppressions,
    mappedCrossingSuppressions,
    mappedCrossings: context.mappedCrossings?.stats,
    bridgeModels: surfaces.plans.length,
    bridgeAccessRamps: surfaces.accessBranches.stats.fields,
    bridgeAccessRoads: surfaces.accessBranches.stats.roads,
    bridgeAccessSegments: surfaces.accessBranches.stats.segments,
    bridgeAccessMaxGrade: surfaces.accessBranches.stats.maxGrade,
    bridgeBatches: bridges.length,
    bridgeConnectionPrimitives: bridgeConnections.stats.primitives,
    bridgeConnectionBridges: bridgeConnections.stats.bridges,
    bridgeConnectionKinds: bridgeConnections.stats.byKind,
    bridgeConnectionTriangleUpperBound: bridgeConnections.stats.triangleUpperBound,
    liveBridgeConnectionPrimitives: 0,
    liveBridgeConnectionTriangles: 0,
    skywalks: surfaces.skywalks.length,
    trackSections: trackData.tracks.length,
    signalApproaches: definitions.signals.length,
    surveyedSignalSites: definitions.signalInventory.representedSites,
    surveyedSignalInventory: definitions.signalInventory.sites,
    signalControlSites: definitions.signalInventory.controlSites,
    mappedSignalSites: definitions.signalInventory.mappedSites,
    unmatchedSignalSites: definitions.signalInventory.unmatched.length,
    signalSitesWithoutSafePole: definitions.signalInventory.unmatched.filter(
      (s) => s.reason === 'No safe surveyed-sidewalk pole location',
    ).length,
    signalSitesWithoutMappedApproach: definitions.signalInventory.unmatched.filter(
      (s) => s.reason === 'No unambiguous mapped ground approach',
    ).length,
    liveSignalApproaches: 0,
    liveFurniture: 0,
    liveDetailTiles: 0,
    triangles: meshes.reduce((v, m) => v + m.geometry.attributes.position.count / 3, 0),
  };
  const bridgeDetails = buildBridgeDetails(scene, surfaces, {
    heightAt: bridgeDeckHeight,
    includePeace: [...(data.roads || [])].some(isPeaceBridgeRoad),
  });
  stats.bridgeDetailDraws = bridgeDetails.stats.drawCalls;
  stats.animatedBridgeScenes = bridgeDetails.stats.animatedBridges;
  stats.bridgeLightFixtures = bridgeDetails.stats.emissiveBeams;
  stats.peaceInfillSegments = bridgeDetails.stats.cableBeams;
  stats.peaceAccessRoads = surfaces.peace.stats.roads;
  stats.peaceAccessJunctions = surfaces.peace.stats.junctions;
  stats.triangles += bridgeDetails.stats.triangles;
  function updateSignals(timeSeconds = signalClock, force = false) {
    if (Number.isFinite(timeSeconds)) signalClock = timeSeconds;
    const tick = Math.floor(signalClock);
    if (!force && tick === lastSignalTick) return;
    lastSignalTick = tick;
    signalLenses.count = activeSignals.length * 2;
    activeSignals.forEach((item, i) => {
      const s = item.signal,
        phase = signalPhase(signalClock, s.axis, s.seed);
      signalDummy.position.set(...item.vehicle[signalLensIndex(phase)]);
      signalDummy.scale.setScalar(1);
      signalDummy.updateMatrix();
      signalLenses.setMatrixAt(i * 2, signalDummy.matrix);
      signalColor.setHex(phase === 'red' ? 0xff4129 : phase === 'amber' ? 0xffb528 : 0x3ce99b);
      signalLenses.setColorAt(i * 2, signalColor);
      const walk = signalPhase(signalClock, 1 - s.axis, s.seed) === 'green';
      signalDummy.position.set(...item.pedestrian);
      signalDummy.scale.set(0.62, 0.82, 0.6);
      signalDummy.updateMatrix();
      signalLenses.setMatrixAt(i * 2 + 1, signalDummy.matrix);
      signalColor.setHex(walk ? 0xe4f9df : 0xff8b37);
      signalLenses.setColorAt(i * 2 + 1, signalColor);
    });
    signalLenses.instanceMatrix.needsUpdate = true;
    if (signalLenses.instanceColor) signalLenses.instanceColor.needsUpdate = true;
  }
  let activeTiles = new Set(),
    pendingTile,
    readyTile;
  function refreshTileStats() {
    stats.liveDetailTiles = 0;
    stats.liveBridgeConnectionTriangles = 0;
    for (const tile of activeTiles) {
      if (!tile.detail) continue;
      stats.liveDetailTiles++;
      stats.liveBridgeConnectionTriangles += tile.connectionTriangles;
    }
  }
  function attachDetail(tile, { geometry, connectionTriangles }) {
    tile.connectionTriangles = connectionTriangles;
    tile.detail = meshForGeometry(geometry, material, 'Nearby sidewalk slab joints', false) || false;
    if (tile.detail) scene.add(tile.detail);
    refreshTileStats();
  }
  function updateNextDetail(worker) {
    if (readyTile) {
      const { tile, result } = readyTile;
      readyTile = null;
      if (activeTiles.has(tile) && tile.detail === null) {
        attachDetail(tile, result);
        return true;
      }
      result.geometry?.dispose();
    }
    if (pendingTile) return false;
    for (const tile of activeTiles) {
      if (tile.detail !== null) continue;
      const cached = tileCache.take(tile);
      if (cached) {
        attachDetail(tile, cached);
        return true;
      }
      const curbs = tile.curbs.map((s) => {
        const offsets = [
          terrainOffsetAt(...s.a),
          terrainOffsetAt(...s.b),
          terrainOffsetAt(s.b[0] - s.nx * 0.18, s.b[1] - s.nz * 0.18),
          terrainOffsetAt(s.a[0] - s.nx * 0.18, s.a[1] - s.nz * 0.18),
        ];
        return offsets.some(Boolean) ? { ...s, offsets } : s;
      });
      if (!worker.available) {
        worker.stats.fallback++;
        attachDetail(tile, buildInfrastructureDetailGeometry({ ...tile, curbs }));
        return true;
      }
      const { sidewalks, tracks, supports, bridgePickets, bridgeConnections } = tile;
      const request = worker.build('infrastructure', {
        sidewalks,
        curbs,
        tracks,
        supports,
        bridgePickets,
        bridgeConnections,
      });
      if (request) {
        pendingTile = tile;
        request
          .then((result) => {
            readyTile = { tile, result };
          })
          .catch(() => {})
          .finally(() => {
            pendingTile = null;
          });
      }
      return false;
    }
    return false;
  }
  function update(camera, quality = 'balanced', deferDetails = false) {
    const aerial = camera.position.y > 230;
    if (
      Math.hypot(camera.position.x - lastUpdateX, camera.position.z - lastUpdateZ) < 28 &&
      quality === lastQuality &&
      aerial === lastAerial
    )
      return;
    lastUpdateX = camera.position.x;
    lastUpdateZ = camera.position.z;
    lastQuality = quality;
    lastAerial = aerial;
    bridgeDetails.update(camera, quality);
    for (const tile of tiles.values())
      if (tile.mesh)
        tile.mesh.visible =
          Math.hypot(tile.x - camera.position.x, tile.z - camera.position.z) <
          (quality === 'high' ? 5100 : 3900);
    for (const { mesh, x, z } of bridges) {
      const d = Math.hypot(x - camera.position.x, z - camera.position.z);
      mesh.visible = d < 5600;
      mesh.castShadow = d < 800;
    }
    const selected = selectInfrastructureDetails(definitions.furniture, camera, quality),
      furnitureKey = selectionKey(selected, furnitureIds);
    if (furnitureKey !== lastFurnitureKey) {
      lastFurnitureKey = furnitureKey;
      if (furnitureMesh) {
        scene.remove(furnitureMesh);
        furnitureMesh.geometry.dispose();
        furnitureMesh = null;
      }
      const streams = selected.map((item) =>
        primitiveStream(
          furnitureCache,
          item,
          [item.x, item.y, item.z, item.angle, item.kind, item.side],
          drawFurniture,
        ),
      );
      furnitureMesh = meshForGeometry(
        mergeInfrastructureStreams(streams),
        material,
        'Nearby benches, bins, cycle racks and street lamps',
      );
      if (furnitureMesh) scene.add(furnitureMesh);
      stats.liveFurniture = selected.length;
    }
    const near = aerial
      ? []
      : [...tiles.values()]
          .map((t) => ({ t, d: Math.hypot(t.x - camera.position.x, t.z - camera.position.z) }))
          .filter(({ d }) => d < (quality === 'high' ? 650 : 400))
          .sort((a, b) => a.d - b.d)
          .slice(
            0,
            quality === 'high' ? INFRASTRUCTURE_LIMITS.highTiles : INFRASTRUCTURE_LIMITS.balancedTiles,
          )
          .map(({ t }) => t);
    const keys = near.map((t) => t.key).join(';');
    if (keys !== activeTileKeys) {
      activeTileKeys = keys;
      activeTiles = new Set(near);
      for (const tile of tiles.values()) {
        if (activeTiles.has(tile) || tile.detail === null) continue;
        if (!tile.detail) {
          tile.detail = null;
          continue;
        }
        scene.remove(tile.detail);
        const geometry = tile.detail.geometry,
          bytes = Object.values(geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0);
        if (!tileCache.set(tile, { geometry, connectionTriangles: tile.connectionTriangles }, bytes))
          geometry.dispose();
        tile.detail = null;
      }
      stats.liveBridgeConnectionPrimitives = near.reduce((n, t) => n + t.bridgeConnections.length, 0);
      refreshTileStats();
    }
    if (!deferDetails) {
      for (const tile of activeTiles)
        if (tile.detail === null)
          attachDetail(tile, tileCache.take(tile) ?? buildInfrastructureDetailGeometry(tile));
    }
    const nearSignals = aerial
      ? []
      : [...signalIndex.near(camera.position.x, camera.position.z, quality === 'high' ? 600 : 400)]
          .map((s) => ({ s, d: Math.hypot(s.x - camera.position.x, s.z - camera.position.z) }))
          .filter((v) => v.d < (quality === 'high' ? 600 : 400))
          .sort((a, b) => a.d - b.d)
          .slice(
            0,
            quality === 'high' ? INFRASTRUCTURE_LIMITS.highSignals : INFRASTRUCTURE_LIMITS.balancedSignals,
          )
          .map((v) => v.s);
    const signalKey = selectionKey(nearSignals, signalIds);
    if (signalKey !== lastSignalKey) {
      lastSignalKey = signalKey;
      if (signalMesh) {
        scene.remove(signalMesh);
        signalMesh.geometry.dispose();
        signalMesh = null;
      }
      const streams = nearSignals.map((s) => {
        // Re-evaluate evidence guards even for a retained primitive. Corrected
        // heads expire when their source fields change, just as a fresh draw does.
        const head = signalHeadLayout(s);
        return primitiveStream(
          signalCache,
          s,
          [
            s.x,
            s.y,
            s.z,
            s.poleX,
            s.poleZ,
            s.travelX,
            s.travelZ,
            s.citySite?.pedestrianButtons !== false,
            head.housingWidth,
            head.housingHeight,
            head.backingWidth,
            head.backingHeight,
            head.centerOffsetY,
            ...head.lensOffsets.flat(),
          ],
          drawTrafficSignal,
          head,
        );
      });
      activeSignals = streams.map((stream) => stream.descriptor);
      signalMesh = meshForGeometry(
        mergeInfrastructureStreams(streams),
        material,
        'Nearby traffic-signal poles, mast arms and pedestrian heads',
      );
      if (signalMesh) scene.add(signalMesh);
      stats.liveSignalApproaches = activeSignals.length;
      updateSignals(signalClock, true);
    }
  }
  return {
    ...surfaces,
    definitions,
    signals: definitions.signals,
    signalCoverage: definitions.signalInventory,
    meshes,
    tiles,
    bridgeDetails,
    detailCaches: {
      furniture: furnitureCache.stats,
      signals: signalCache.stats,
      tiles: tileCache.stats,
    },
    stats,
    update,
    updateNextDetail,
    updateSignals,
    signalPhase,
    get signalTime() {
      return signalClock;
    },
    trafficSignalAhead(x, z, heading, timeSeconds = signalClock, maxDistance = 60) {
      return trafficSignalAhead(signalIndex.near(x, z, maxDistance), x, z, heading, timeSeconds, maxDistance);
    },
    dispose() {
      furnitureCache.clear();
      signalCache.clear();
      tileCache.clear();
      bridgeDetails.dispose();
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const tile of tiles.values())
        if (tile.detail) {
          scene.remove(tile.detail);
          tile.detail.geometry.dispose();
        }
      if (furnitureMesh) {
        scene.remove(furnitureMesh);
        furnitureMesh.geometry.dispose();
      }
      if (signalMesh) {
        scene.remove(signalMesh);
        signalMesh.geometry.dispose();
      }
      scene.remove(signalLenses);
      signalLenses.geometry.dispose();
      signalLensMaterial.dispose();
      material.dispose();
      glassMaterial.dispose();
    },
  };
}
