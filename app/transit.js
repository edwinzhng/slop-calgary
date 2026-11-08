import * as THREE from 'three/webgpu';
import { abs, attribute, float, max, mix, step, texture, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { windowGlow } from './city-uniforms.js';
import { bounds, DRIVABLE, inPolygon, makeRoadIndex, nearestOnSegment, SpatialIndex } from './geo.js';
import {
  createTransitSimulation,
  prepareTransitRoute,
  projectOnTransitRoute,
  trainBodyContact,
  transitPose,
  TRANSIT_LIMITS,
} from './transit-motion.js';

export { TRANSIT_LIMITS } from './transit-motion.js';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n)),
  smooth = (n) => {
    const u = clamp(n, 0, 1);
    return u * u * (3 - 2 * u);
  },
  distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  up = new THREE.Vector3(0, 1, 0);

function segmentIntersection(a, b, c, d) {
  const ux = b[0] - a[0],
    uz = b[1] - a[1],
    vx = d[0] - c[0],
    vz = d[1] - c[1],
    den = ux * vz - uz * vx;
  if (Math.abs(den) < 1e-7) return null;
  const x = c[0] - a[0],
    z = c[1] - a[1],
    t = (x * vz - z * vx) / den,
    s = (x * uz - z * ux) / den;
  if (t < -0.0001 || t > 1.0001 || s < -0.0001 || s > 1.0001) return null;
  return {
    x: a[0] + ux * t,
    z: a[1] + uz * t,
    t: clamp(t, 0, 1),
    sine: Math.abs(den) / (Math.hypot(ux, uz) * Math.hypot(vx, vz)),
  };
}

export function collectTransitCrossings(data, routes, world) {
  const roadIndex = world.roadIndex || makeRoadIndex(data.roads),
    rails = new Map(data.rails.map((rail) => [rail.id, rail])),
    seen = new Set(),
    crossings = [],
    restricted = new Set(world.transitOnlyRoadIds || []);
  for (const route of routes)
    for (let i = 0; i < route.points.length - 1; i++) {
      if (route.segments[i].tunnel || route.segments[i].bridge) continue;
      const a = route.points[i],
        b = route.points[i + 1],
        mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        len = distance(a, b),
        rail = rails.get(route.segments[i].roadId);
      for (const segment of roadIndex.index.near(...mid, len / 2 + 15)) {
        if (
          !DRIVABLE.has(segment.road.kind) ||
          segment.road.tunnel ||
          segment.road.bridge ||
          restricted.has(segment.road.id) ||
          segment.road.transitOnly
        )
          continue;
        const hit = segmentIntersection(a, b, segment.a, segment.b);
        if (!hit || hit.sine < 0.4) continue;
        const railY = world.surfaceHeight?.(hit.x, hit.z, rail) ?? 0.18,
          roadY = world.surfaceHeight?.(hit.x, hit.z, segment.road) ?? 0.16;
        if (Math.abs(railY - roadY) > 2.5) continue;
        const key = `${route.id}:${segment.road.id}:${Math.round(hit.x / 3)},${Math.round(hit.z / 3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        crossings.push({
          id: key,
          routeId: route.id,
          roadId: segment.road.id,
          x: hit.x,
          z: hit.z,
          y: railY,
          distance: route.cumulative[i] + len * hit.t,
          active: false,
          width: segment.width,
          sourceRailId: rail?.id,
          railDx: (b[0] - a[0]) / len,
          railDz: (b[1] - a[1]) / len,
        });
      }
    }
  return crossings;
}

function polygonCenter(ring) {
  let twiceArea = 0,
    x = 0,
    z = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      weight = a[0] * b[1] - b[0] * a[1];
    twiceArea += weight;
    x += (a[0] + b[0]) * weight;
    z += (a[1] + b[1]) * weight;
  }
  return Math.abs(twiceArea) > 0.001 ? [x / (3 * twiceArea), z / (3 * twiceArea)] : ring[0].slice();
}

export function collectTransitPlatforms(data, source, world) {
  const rails = world.infrastructure?.railIndex || makeRoadIndex(data.rails),
    result = [];
  for (const mapped of source.platforms) {
    const ring = mapped.ring.slice(0, -1),
      center = polygonCenter(ring),
      edge = ring
        .map((a, i) => ({ a, b: ring[(i + 1) % ring.length] }))
        .sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b))[0],
      len = distance(edge.a, edge.b),
      dx = (edge.b[0] - edge.a[0]) / len,
      dz = (edge.b[1] - edge.a[1]) / len,
      along = ring.map((point) => (point[0] - center[0]) * dx + (point[1] - center[1]) * dz),
      across = ring.map((point) => -(point[0] - center[0]) * dz + (point[1] - center[1]) * dx),
      min = Math.min(...along),
      max = Math.max(...along),
      width = Math.max(...across) - Math.min(...across),
      nearest = (x, z) => {
        let found = null;
        for (const segment of rails.index.near(x, z, 35)) {
          if (segment.road.kind !== 'light_rail' || segment.road.tunnel) continue;
          const p = nearestOnSegment(x, z, segment.a, segment.b);
          if (p.distance < (found?.distance ?? 35)) found = { ...p, road: segment.road };
        }
        return found;
      },
      railHeight = (x, z) => {
        const rail = nearest(x, z);
        return rail ? (world.surfaceHeight?.(rail.x, rail.z, rail.road) ?? 0.18) : 0.18;
      },
      elevated = railHeight(...center) - (world.terrain?.regionalOffsetAt?.(...center) || 0) > 1,
      platform = {
        ...mapped,
        ring,
        x: center[0],
        z: center[1],
        dx,
        dz,
        min,
        max,
        length: max - min,
        width,
        heading: Math.atan2(dx, dz),
        elevated,
        railHeight,
        nearestRail: nearest,
        stairEnds: {},
      };
    const bandCount = Math.max(1, Math.ceil(platform.length / 4)),
      bandLength = platform.length / bandCount,
      heights = new Map(),
      bandHeight = (index) => {
        const key = `${!!platform.stairEnds.min}:${!!platform.stairEnds.max}:${index}`;
        if (!heights.has(key)) {
          const local = min + index * bandLength,
            lift = elevated
              ? 1
              : smooth(
                  Math.min(
                    platform.stairEnds.min ? Infinity : local - min,
                    platform.stairEnds.max ? Infinity : max - local,
                  ) / 14,
                );
          heights.set(
            key,
            railHeight(center[0] + dx * local, center[1] + dz * local) +
              (TRANSIT_LIMITS.railHeadAboveDeck + TRANSIT_LIMITS.floorAboveRail) * lift,
          );
        }
        return heights.get(key);
      };
    platform.heightAt = (x, z) => {
      const local = clamp((x - center[0]) * dx + (z - center[1]) * dz, min, max),
        band = Math.min(bandCount - 1, Math.floor((local - min) / bandLength)),
        t = (local - min - band * bandLength) / bandLength;
      return bandHeight(band) + (bandHeight(band + 1) - bandHeight(band)) * t;
    };
    platform.y = platform.heightAt(...center);
    result.push(platform);
  }
  return result;
}

function distanceToPlatform(point, platform) {
  return inPolygon(...point, platform)
    ? 0
    : Math.min(
        ...platform.ring.map(
          (a, i) => nearestOnSegment(...point, a, platform.ring[(i + 1) % platform.ring.length]).distance,
        ),
      );
}

export function alignTransitStops(source, platforms) {
  const stationKey = (name) =>
    name
      .toLowerCase()
      .replace(/^(nb|sb|eb|wb)\s+/, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\b(ctrain|station|staion|stn)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const aligned = source.routes.map((sourceRoute) => {
    const route = prepareTransitRoute(sourceRoute);
    return {
      ...sourceRoute,
      stops: sourceRoute.stops
        .map((stop) => {
          const stopKey = stationKey(stop.name);
          const candidates = platforms
            .map((platform) => {
              const separation = distanceToPlatform(stop.point, platform),
                onRoute = projectOnTransitRoute(route, platform.x, platform.z, 12),
                namedMatch = stopKey.length > 0 && stopKey === stationKey(platform.name);
              return {
                platform,
                separation,
                onRoute,
                namedMatch,
                score:
                  separation < 30
                    ? separation * 4 + (onRoute?.lateral ?? 1000) * 2
                    : separation + (onRoute?.lateral ?? 1000) * 12,
              };
            })
            .filter(
              (item) => item.onRoute && (item.separation < 30 || (item.namedMatch && item.separation < 120)),
            )
            .sort((a, b) => Number(a.separation >= 30) - Number(b.separation >= 30) || a.score - b.score);
          const best = candidates[0];
          if (!best) return { ...stop, alignment: 'GTFS reference; no mapped platform match' };
          return {
            ...stop,
            sourceDistance: stop.distance,
            distance: best.onRoute.distance,
            platformId: best.platform.id,
            alignment:
              best.separation >= 30
                ? 'Station-name and directional track match: offset GTFS marker replaced by actual platform centroid; source position retained'
                : 'Four-car centre aligned with actual mapped platform centroid; GTFS stop position retained as provenance',
          };
        })
        .sort((a, b) => a.distance - b.distance),
    };
  });
  return { ...source, routes: aligned };
}

export function collectStationAccess(data, platforms, world) {
  const stairs = [],
    unresolved = [],
    nearbyCandidates = [],
    seen = new Set(),
    platformIndex = new SpatialIndex(100);
  for (const platform of platforms) platformIndex.insert(platform, bounds(platform.ring));
  for (const road of data.roads.filter((road) => road.kind === 'steps')) {
    const ends = [road.points[0], road.points.at(-1)],
      nearby = new Set();
    for (const point of ends) for (const platform of platformIndex.near(...point, 1)) nearby.add(platform);
    for (const platform of nearby) {
      const distances = ends.map((point) => distanceToPlatform(point, platform));
      if (Math.min(...distances) > 0.35 || seen.has(road.id)) continue;
      seen.add(road.id);
      const record = {
        roadId: road.id,
        platformId: platform.id,
        station: platform.name,
        sourceKind: road.kind,
      };
      if (road.bridge || road.tunnel || Number(road.layer) > 0 || platform.elevated) {
        unresolved.push({
          ...record,
          reason: 'Elevated access needs a connected source-level profile; no arbitrary ground drop inferred',
        });
        continue;
      }
      if (Math.max(...distances) < 0.35) {
        unresolved.push({
          ...record,
          reason: 'Both endpoints are inside platform footprint; interior floor opening is unmeasured',
        });
        continue;
      }
      const inside = distances[0] <= distances[1] ? 0 : 1,
        topPoint = ends[inside],
        bottomPoint = ends[1 - inside],
        points = inside === 1 ? road.points.slice() : road.points.slice().reverse(),
        middle = points[Math.floor(points.length / 2)],
        rail = platform.nearestRail(...middle);
      if (rail && rail.distance < 1.6) {
        unresolved.push({
          ...record,
          reason: 'Potential track-clearance conflict; source stair width/levels require verification',
        });
        continue;
      }
      const length = points.slice(1).reduce((sum, point, i) => sum + distance(point, points[i]), 0),
        along = (topPoint[0] - platform.x) * platform.dx + (topPoint[1] - platform.z) * platform.dz;
      if (along - platform.min < 2) platform.stairEnds.min = true;
      if (platform.max - along < 2) platform.stairEnds.max = true;
      const bottom = world.surfaceHeight?.(...bottomPoint, road) ?? 0.14,
        top = platform.heightAt(...topPoint);
      if (top - bottom < 0.08 || length < 0.3) {
        unresolved.push({
          ...record,
          reason: 'Insufficient measured elevation difference for a separate stair flight',
        });
        continue;
      }
      stairs.push({
        ...record,
        road,
        points,
        bottom,
        top,
        length,
        count: Math.ceil((top - bottom) / 0.17),
        width: 1.8,
        inference: 'Source stair centre line; floor/ground-constrained rise and1.8m width are inferred',
      });
    }
  }
  // Keep the remaining bridge/steps source IDs visible to reviewers. A layer
  // number alone cannot establish whether a station ramp is above a highway,
  // connected to an elevated rail platform, or descending into an underpass.
  for (const road of data.roads.filter(
    (road) => (road.bridge || road.kind === 'steps') && !DRIVABLE.has(road.kind) && road.kind !== 'corridor',
  )) {
    if (seen.has(road.id)) continue;
    const box = bounds(road.points),
      x = (box.minX + box.maxX) / 2,
      z = (box.minZ + box.maxZ) / 2,
      nearest = platforms
        .map((platform) => ({ platform, distance: Math.hypot(platform.x - x, platform.z - z) }))
        .sort((a, b) => a.distance - b.distance)[0];
    if (nearest && nearest.distance < 180 && !world.infrastructure?.ownsRoad?.(road))
      nearbyCandidates.push({
        roadId: road.id,
        platformId: nearest.platform.id,
        station: nearest.platform.name,
        sourceKind: road.kind,
        layer: Number(road.layer) || 0,
        reason: 'Nearby mapped station/access structure without verified connected floor levels',
      });
  }
  for (const platform of platforms) platform.y = platform.heightAt(platform.x, platform.z);
  return { stairs, unresolved, nearbyCandidates };
}

function sampleAccess(stair, at) {
  let distanceLeft = clamp(at, 0, 1) * stair.length;
  for (let i = 1; i < stair.points.length; i++) {
    const a = stair.points[i - 1],
      b = stair.points[i],
      len = distance(a, b);
    if (distanceLeft <= len || i === stair.points.length - 1) {
      const t = clamp(distanceLeft / Math.max(0.001, len), 0, 1);
      return {
        x: a[0] + (b[0] - a[0]) * t,
        z: a[1] + (b[1] - a[1]) * t,
        dx: (b[0] - a[0]) / len,
        dz: (b[1] - a[1]) / len,
      };
    }
    distanceLeft -= len;
  }
}

function clipRing(ring, dx, dz, limit, greater) {
  const result = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      va = a[0] * dx + a[1] * dz - limit,
      vb = b[0] * dx + b[1] * dz - limit,
      aInside = greater ? va >= -1e-8 : va <= 1e-8,
      bInside = greater ? vb >= -1e-8 : vb <= 1e-8;
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const t = va / (va - vb);
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return result;
}

class GeometryBatch {
  constructor() {
    this.parts = [];
  }
  add(geometry, tint = 0xffffff, glow = 0, gloss = 0) {
    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    if (part !== geometry) geometry.dispose();
    part.deleteAttribute('uv');
    const count = part.attributes.position.count,
      c = new THREE.Color(tint),
      colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    part.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    part.setAttribute('lightMask', new THREE.BufferAttribute(new Float32Array(count).fill(glow), 1));
    part.setAttribute('gloss', new THREE.BufferAttribute(new Float32Array(count).fill(gloss), 1));
    this.parts.push(part);
  }
  box(x, y, z, w, h, d, tint, glow = 0, gloss = 0) {
    this.add(new THREE.BoxGeometry(w, h, d).translate(x, y, z), tint, glow, gloss);
  }
  beam(a, b, radius, tint) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      direction = end.clone().sub(start),
      length = direction.length();
    if (length < 0.001) return;
    const matrix = new THREE.Matrix4().compose(
      start.add(end).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()),
      new THREE.Vector3(radius, length, radius),
    );
    this.add(new THREE.CylinderGeometry(1, 1, 1, 6).applyMatrix4(matrix), tint, 0, 0.8);
  }
  triangle(a, b, c, tint) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
    geometry.computeVertexNormals();
    this.add(geometry, tint);
  }
  quad(a, b, c, d, tint) {
    this.triangle(a, b, d, tint);
    this.triangle(b, c, d, tint);
  }
  geometry() {
    const merged = this.parts.length ? mergeGeometries(this.parts, false) : new THREE.BufferGeometry();
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    merged.computeBoundingSphere();
    return merged;
  }
}

function platformGeometry(platforms, stairs = []) {
  const batch = new GeometryBatch();
  for (const platform of platforms) {
    const offset = platform.x * platform.dx + platform.z * platform.dz,
      n = Math.max(1, Math.ceil(platform.length / 4));
    for (let i = 0; i < n; i++) {
      let band = clipRing(
        platform.ring,
        platform.dx,
        platform.dz,
        offset + platform.min + (platform.length * i) / n,
        true,
      );
      band = clipRing(
        band,
        platform.dx,
        platform.dz,
        offset + platform.min + (platform.length * (i + 1)) / n,
        false,
      );
      if (band.length < 3) continue;
      const triangles = THREE.ShapeUtils.triangulateShape(
        band.map(([x, z]) => new THREE.Vector2(x, z)),
        [],
      );
      for (const face of triangles) {
        let [a, b, c] = face.map((index) => [
          band[index][0],
          platform.heightAt(...band[index]),
          band[index][1],
        ]);
        if ((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) < 0) [b, c] = [c, b];
        batch.triangle(a, b, c, 0xaaa99c);
      }
    }
    let area = 0;
    for (let i = 0; i < platform.ring.length; i++) {
      const a = platform.ring[i],
        b = platform.ring[(i + 1) % platform.ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    for (let i = 0; i < platform.ring.length; i++) {
      const a = platform.ring[i],
        b = platform.ring[(i + 1) % platform.ring.length],
        len = distance(a, b),
        nx = (-(b[1] - a[1]) / len) * Math.sign(area),
        nz = ((b[0] - a[0]) / len) * Math.sign(area),
        pieces = Math.max(1, Math.ceil(len / 4));
      for (let j = 0; j < pieces; j++) {
        const t0 = j / pieces,
          t1 = (j + 1) / pieces,
          aa = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
          bb = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
          y0 = platform.heightAt(...aa),
          y1 = platform.heightAt(...bb),
          base0 = platform.railHeight(...aa),
          base1 = platform.railHeight(...bb);
        const wall = [
          [aa[0], base0, aa[1]],
          [bb[0], base1, bb[1]],
          [bb[0], y1, bb[1]],
          [aa[0], y0, aa[1]],
        ];
        if (area > 0) wall.reverse();
        batch.quad(...wall, 0x8e928b);
        const mid = [(aa[0] + bb[0]) / 2, (aa[1] + bb[1]) / 2],
          rail = platform.nearestRail(...mid);
        if (
          rail?.distance < 3.4 &&
          len > 3 &&
          Math.abs(((b[0] - a[0]) * platform.dx + (b[1] - a[1]) * platform.dz) / len) > 0.72
        ) {
          const warning = [
            [aa[0] + nx * 0.04, y0 + 0.016, aa[1] + nz * 0.04],
            [aa[0] + nx * 0.34, y0 + 0.016, aa[1] + nz * 0.34],
            [bb[0] + nx * 0.34, y1 + 0.016, bb[1] + nz * 0.34],
            [bb[0] + nx * 0.04, y1 + 0.016, bb[1] + nz * 0.04],
          ];
          if (area < 0) warning.reverse();
          batch.quad(...warning, 0xd2af4e);
        }
      }
    }
  }
  for (const stair of stairs)
    for (let i = 0; i < stair.count; i++) {
      const p = sampleAccess(stair, (i + 0.5) / stair.count),
        top = stair.bottom + ((stair.top - stair.bottom) * (i + 1)) / stair.count,
        geometry = new THREE.BoxGeometry(
          stair.width,
          Math.max(0.02, top - stair.bottom),
          stair.length / stair.count + 0.003,
        )
          .rotateY(Math.atan2(p.dx, p.dz))
          .translate(p.x, (top + stair.bottom) / 2, p.z);
      batch.add(geometry, 0xa7ac9f);
    }
  return batch.geometry();
}

function trainGeometry(joint = false, retro = false) {
  const batch = new GeometryBatch(),
    white = 0xdce1df,
    red = 0xbc2630,
    dark = 0x263335;
  if (joint) {
    batch.box(0, 2.08, 0, 2.38, 2.0, 0.42, dark);
    for (let z = -0.18; z <= 0.18; z += 0.09) batch.box(0, 2.08, z, 2.44, 2.06, 0.025, 0x4b5553);
    batch.box(0, 0.59, 0, 2.2, 0.42, 2.8, 0x343a38);
  } else {
    batch.box(0, 2.12, 0, 2.65, 2.18, 12.5, white);
    batch.box(0, 1.28, 0, 2.675, retro ? 0.24 : 0.56, 12.55, red);
    if (retro) batch.box(0, 1.48, 0, 2.675, 0.16, 12.55, 0xdb704d);
    batch.box(0, 2.46, -0.18, 2.682, retro ? 0.82 : 1.0, 11.85, 0x284249, 0.045, 1);
    batch.box(0, 3.25, -0.1, 2.58, 0.22, 12.3, 0xb6c1c0, 0, 0.3);
    batch.box(0, 3.53, -1.2, 1.82, 0.4, 3.4, 0x8f9994);
    batch.box(0, 0.72, -0.25, 2.19, 0.56, 10.6, 0x343c39);
    for (const side of [-1, 1]) {
      for (const z of [-3.6, 1.8]) {
        batch.box(side * 1.354, 2.08, z, 0.034, 1.95, 1.42, white);
        batch.box(side * 1.375, 2.42, z, 0.025, 0.98, 1.19, 0x243c42, 0.04, 1);
        batch.box(side * 1.395, 2.05, z, 0.018, 1.88, 0.035, 0x323b39);
        batch.box(side * 1.4, 1.61, z + 0.5, 0.026, 0.09, 0.06, 0xf1dc75, 0.15);
      }
      for (const z of [-5.3, -1.1, 4.25]) batch.box(side * 1.36, 2.45, z, 0.027, 1.02, 0.12, white);
      batch.box(side * 1.36, 1.02, 0, 0.08, 0.12, 11.7, 0xc1cbc7);
      for (const z of [3.75, 5.15])
        batch.add(
          new THREE.CylinderGeometry(0.34, 0.34, 0.18, 10)
            .rotateZ(Math.PI / 2)
            .translate(side * 1.09, 0.56, z),
          0x343b38,
          0,
          0.5,
        );
      batch.box(side * 0.89, 1.44, 6.285, 0.35, 0.15, 0.08, 0xffe9b5, 1);
      batch.box(side * 0.53, 1.15, 6.295, 0.14, 0.1, 0.08, 0xffbcb6, 0.25);
    }
    // Angular white mask around the dark cab front; generated geometry, not a
    // manufacturer CAD asset. All four articulated cars retain their own cabs.
    batch.box(0, 2.43, 6.29, 2.16, 1.08, 0.07, 0x152b32, 0.03, 1);
    if (retro) {
      batch.box(0, 2.43, 6.333, 0.095, 1.09, 0.02, white);
      batch.box(0, 3.02, 6.332, 2.29, 0.14, 0.023, white);
      batch.box(0, 1.68, 6.33, 2.39, 0.22, 0.025, red);
    } else
      for (const side of [-1, 1]) {
        batch.beam([side * 1.18, 3.11, 6.34], [side * 0.82, 1.62, 6.34], 0.08, white);
        batch.beam([side * 0.82, 1.62, 6.34], [side * 0.44, 1.44, 6.34], 0.075, white);
      }
    batch.box(0, 0.85, 6.45, 0.46, 0.24, 0.55, 0x343a39);
    batch.box(0, 3.43, 2.0, 0.88, 0.18, 1.3, dark);
    for (const side of [-1, 1]) {
      batch.beam([side * 0.3, 3.55, 2.0], [side * 0.42, 4.62, 2.55], 0.025, dark);
      batch.beam([side * 0.42, 4.62, 2.55], [side * 0.32, 5.77, 2.0], 0.025, dark);
    }
    batch.beam([-0.7, 5.8, 2.0], [0.7, 5.8, 2.0], 0.035, 0x424d47);
  }
  return batch.geometry();
}

function makeAtlas(source) {
  const texts = [
      ...source.platforms.map((platform) => platform.name.replace(/ Station$/i, '')),
      ...source.routes.map((route) => `${route.route} ${route.headsign}`),
    ],
    columns = 4,
    cellWidth = 320,
    cellHeight = 64,
    rows = Math.ceil(texts.length / columns),
    rects = texts.map((_, i) => [
      (i % columns) / columns,
      1 - (Math.floor(i / columns) + 1) / rows,
      1 / columns,
      1 / rows,
    ]);
  if (typeof document === 'undefined') return { texture: null, rects };
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellWidth;
  canvas.height = rows * cellHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#17272c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  texts.forEach((text, i) => {
    const route = i >= source.platforms.length,
      x = (i % columns) * cellWidth,
      y = Math.floor(i / columns) * cellHeight;
    ctx.fillStyle = route ? '#ffc35d' : '#f0f1e9';
    ctx.font = `600 ${text.length > 27 ? 18 : text.length > 20 ? 21 : 26}px sans-serif`;
    ctx.fillText(text, x + cellWidth / 2, y + cellHeight / 2, cellWidth - 16);
  });
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return { texture: atlas, rects };
}

function signGeometry(platforms, rects) {
  const positions = [],
    uvs = [],
    normals = [];
  platforms.forEach((platform, i) => {
    const y = platform.y + 2.65,
      side = Math.max(0.4, platform.width / 2 - 0.3),
      width = Math.min(4.6, Math.max(2.2, platform.length * 0.05)),
      rect = rects[i];
    for (const direction of [-1, 1]) {
      const x = platform.x - platform.dz * side * direction,
        z = platform.z + platform.dx * side * direction,
        a = [x - (platform.dx * width) / 2, y - 0.3, z - (platform.dz * width) / 2],
        b = [x + (platform.dx * width) / 2, y - 0.3, z + (platform.dz * width) / 2],
        c = [b[0], y + 0.3, b[2]],
        d = [a[0], y + 0.3, a[2]],
        points = direction > 0 ? [a, b, d, b, c, d] : [b, a, c, a, d, c],
        faceUvs =
          direction > 0
            ? [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 0],
                [1, 1],
                [0, 1],
              ]
            : [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 0],
                [1, 1],
                [0, 1],
              ];
      for (let j = 0; j < points.length; j++) {
        positions.push(...points[j]);
        uvs.push(rect[0] + faceUvs[j][0] * rect[2], rect[1] + faceUvs[j][1] * rect[3]);
        normals.push(-platform.dz * direction, 0, platform.dx * direction);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createTransit(scene, world, source, context = {}) {
  const data = world.data,
    railById = new Map(data.rails.map((rail) => [rail.id, rail])),
    routes = source.routes.map(prepareTransitRoute),
    crossings = collectTransitCrossings(data, routes, {
      ...world,
      transitOnlyRoadIds: source.transitOnlyRoadIds,
    }),
    platforms = collectTransitPlatforms(data, source, world),
    access = collectStationAccess(data, platforms, world),
    alignedSource = alignTransitStops(source, platforms),
    simulation = createTransitSimulation(alignedSource, {
      rails: data.rails,
      crossings,
      traffic: context.traffic || [],
      surfaceHeight: (x, z, rail) => world.surfaceHeight?.(x, z, rail) ?? 0.18,
      signalAhead: (x, z, heading, lookAhead) =>
        world.infrastructure?.trafficSignalAhead?.(x, z, heading, world.infrastructure.signalTime, lookAhead),
    }),
    platformIndex = new SpatialIndex(100),
    stairIndex = new SpatialIndex(50),
    crossingIndex = new SpatialIndex(80),
    bodyMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.2 }),
    floorMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.94 }),
    propMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.2 }),
    atlas = makeAtlas(source),
    stationSignMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xe0ddc9 }),
    headsignMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffbc55 }),
    meshes = [];
  bodyMaterial.colorNode = attribute('color', 'vec3');
  bodyMaterial.roughnessNode = mix(float(0.76), float(0.23), attribute('gloss'));
  const lightMask = attribute('lightMask'),
    cabLights = attribute('cabLights'),
    whiteLamp = step(0.8, lightMask),
    redLamp = step(0.2, lightMask).mul(float(1).sub(step(0.3, lightMask))),
    lead = float(1).sub(step(0.1, abs(cabLights.sub(1)))),
    tail = float(1).sub(step(0.1, abs(cabLights.sub(2)))),
    lampMask = float(1).sub(max(whiteLamp, redLamp)).add(whiteLamp.mul(lead)).add(redLamp.mul(tail).mul(3));
  bodyMaterial.emissiveNode = attribute('color', 'vec3')
    .mul(lightMask)
    .mul(lampMask)
    .mul(windowGlow.mul(1.5).add(0.3));
  if (atlas.texture) {
    stationSignMaterial.colorNode = texture(atlas.texture);
    headsignMaterial.colorNode = texture(
      atlas.texture,
      uv().mul(attribute('signRect', 'vec4').zw).add(attribute('signRect', 'vec4').xy),
    );
  }
  const sectionGeometry = trainGeometry(),
    retroGeometry = trainGeometry(false, true),
    jointGeometry = trainGeometry(true),
    sections = new THREE.InstancedMesh(
      sectionGeometry,
      bodyMaterial,
      TRANSIT_LIMITS.highVisible * TRANSIT_LIMITS.cars * 2,
    ),
    retroSections = new THREE.InstancedMesh(retroGeometry, bodyMaterial, TRANSIT_LIMITS.cars * 2),
    joints = new THREE.InstancedMesh(
      jointGeometry,
      bodyMaterial,
      TRANSIT_LIMITS.highVisible * TRANSIT_LIMITS.cars,
    ),
    signPlane = new THREE.PlaneGeometry(1.86, 0.26),
    headsigns = new THREE.InstancedMesh(signPlane, headsignMaterial, TRANSIT_LIMITS.highVisible),
    props = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), propMaterial, 800),
    floor = new THREE.Mesh(platformGeometry(platforms, access.stairs), floorMaterial),
    stationSigns = new THREE.Mesh(signGeometry(platforms, atlas.rects), stationSignMaterial);
  sectionGeometry.setAttribute(
    'cabLights',
    new THREE.InstancedBufferAttribute(
      new Float32Array(TRANSIT_LIMITS.highVisible * TRANSIT_LIMITS.cars * 2),
      1,
    ),
  );
  retroGeometry.setAttribute(
    'cabLights',
    new THREE.InstancedBufferAttribute(new Float32Array(TRANSIT_LIMITS.cars * 2), 1),
  );
  jointGeometry.setAttribute(
    'cabLights',
    new THREE.InstancedBufferAttribute(new Float32Array(TRANSIT_LIMITS.highVisible * TRANSIT_LIMITS.cars), 1),
  );
  signPlane.setAttribute(
    'signRect',
    new THREE.InstancedBufferAttribute(new Float32Array(TRANSIT_LIMITS.highVisible * 4), 4),
  );
  for (const [mesh, name] of [
    [sections, 'Calgary Transit / four-car articulated S200-style trains'],
    [retroSections, 'Calgary Transit / Siemens–Duewag U2-inspired heritage train'],
    [joints, 'CTrain articulation bellows and centre bogies'],
    [headsigns, 'CTrain route headsigns'],
    [props, 'Nearby mapped CTrain platform shelters and furniture'],
    [floor, 'Mapped CTrain platform slabs, tactile edges and inferred end ramps'],
    [stationSigns, 'Mapped CTrain station names'],
  ]) {
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
    if (mesh.isInstancedMesh) {
      mesh.count = 0;
      mesh.frustumCulled = false;
    }
  }
  for (const platform of platforms) platformIndex.insert(platform, bounds(platform.ring));
  for (const stair of access.stairs) {
    for (let i = 1; i < stair.points.length; i++)
      stairIndex.insert(stair, bounds([stair.points[i - 1], stair.points[i]]));
  }
  for (const crossing of crossings)
    crossingIndex.insert(crossing, {
      minX: crossing.x,
      maxX: crossing.x,
      minZ: crossing.z,
      maxZ: crossing.z,
    });
  const dummy = new THREE.Object3D(),
    tint = new THREE.Color(),
    contact = {},
    stats = {
      ...simulation.stats,
      platforms: platforms.length,
      atGradeCrossings: crossings.length,
      visiblePlatforms: 0,
      platformProps: 0,
      drawCalls: meshes.length,
      contacts: 0,
      sourceRows: source.meta.counts,
      maxVisible: TRANSIT_LIMITS.balancedVisible,
      prototypeTriangles:
        sectionGeometry.attributes.position.count / 3 + jointGeometry.attributes.position.count / 3,
      platformTriangles: floor.geometry.attributes.position.count / 3,
    };
  stats.stationStairs = access.stairs.length;
  stats.unresolvedStationAccess = access.unresolved.length;
  stats.nearbyAccessCandidates = access.nearbyCandidates.length;
  let stationCameraX = Infinity,
    stationCameraZ = Infinity,
    stationAerial = null,
    stationQuality = '',
    disposed = false;
  const matrix = (mesh, index, x, y, z, heading, sx = 1, sy = 1, sz = 1, pitch = 0) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(-pitch, heading, 0, 'YXZ');
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  };

  function updatePlatforms(camera, quality) {
    if (
      Math.hypot(camera.position.x - stationCameraX, camera.position.z - stationCameraZ) < 35 &&
      stationQuality === quality &&
      stationAerial === camera.position.y > 250
    )
      return;
    stationCameraX = camera.position.x;
    stationCameraZ = camera.position.z;
    stationAerial = camera.position.y > 250;
    stationQuality = quality;
    const selected =
      camera.position.y > 250
        ? []
        : platforms
            .map((platform) => ({
              platform,
              d: Math.hypot(platform.x - camera.position.x, platform.z - camera.position.z),
            }))
            .filter((item) => item.d < (quality === 'high' ? 700 : 430))
            .sort((a, b) => a.d - b.d)
            .slice(0, quality === 'high' ? TRANSIT_LIMITS.highPlatforms : TRANSIT_LIMITS.balancedPlatforms)
            .map((item) => item.platform);
    let count = 0;
    const box = (platform, along, across, y, w, h, d, color) => {
      if (count >= 800) return;
      const x = platform.x + platform.dx * along - platform.dz * across,
        z = platform.z + platform.dz * along + platform.dx * across;
      matrix(props, count, x, platform.heightAt(x, z) + y, z, platform.heading, w, h, d);
      tint.setHex(color);
      props.setColorAt(count++, tint);
    };
    for (const platform of selected) {
      const cover = [...(world.buildingIndex?.near(platform.x, platform.z, 4) || [])].some(
        (building) =>
          inPolygon(platform.x, platform.z, building) &&
          (building.heightAt?.(platform.x, platform.z) ?? building.height ?? 0) > platform.y + 3,
      );
      const canopyLength = Math.min(32, platform.length * 0.35),
        canopyWidth = clamp(platform.width - 0.5, 1.6, 6.5);
      if (!cover && platform.tags.shelter !== 'no') {
        box(platform, 0, 0, 3.15, canopyWidth, 0.18, canopyLength, 0x899b98);
        box(platform, 0, 0, 3.02, canopyWidth - 0.3, 0.08, canopyLength - 0.3, 0xd0d9d4);
        for (const along of [-canopyLength / 2 + 1.2, 0, canopyLength / 2 - 1.2])
          for (const across of [-canopyWidth / 2 + 0.2, canopyWidth / 2 - 0.2])
            box(platform, along, across, 1.55, 0.13, 3.1, 0.13, 0x5a6c69);
      }
      for (const along of [-platform.length * 0.2, platform.length * 0.2]) {
        box(platform, along, 0, 0.48, Math.min(1.7, platform.width * 0.55), 0.12, 0.46, 0x797a6e);
        box(platform, along, 0, 0.25, 0.09, 0.5, 0.35, 0x515e59);
      }
      for (const along of [-platform.length * 0.28, platform.length * 0.28])
        box(platform, along, 0, 1.35, 0.07, 2.7, 0.07, 0x4b5d5b);
      box(platform, platform.length * 0.1, 0, 0.52, 0.4, 1.04, 0.42, 0x4e6560);
    }
    props.count = count;
    props.instanceMatrix.needsUpdate = true;
    if (props.instanceColor) props.instanceColor.needsUpdate = true;
    stats.visiblePlatforms = selected.length;
    stats.platformProps = count;
  }

  function update(dt, state, camera, quality = 'balanced') {
    if (disposed) return;
    simulation.update(dt, state);
    const high = quality === 'high',
      maxVisible = high ? TRANSIT_LIMITS.highVisible : TRANSIT_LIMITS.balancedVisible,
      radius = high ? TRANSIT_LIMITS.highRadius : TRANSIT_LIMITS.balancedRadius,
      visible =
        camera.position.y > 500
          ? []
          : simulation.trains
              .map((train) => ({
                train,
                d: Math.hypot(train.x - camera.position.x, train.z - camera.position.z),
              }))
              .filter((item) => item.d < radius && item.train.sections.length)
              .sort((a, b) => a.d - b.d)
              .slice(0, maxVisible)
              .map((item) => item.train);
    let count = 0,
      retroCount = 0,
      jointCount = 0,
      signCount = 0;
    for (const train of visible) {
      const retro = train === simulation.trains[2];
      const trainMesh = retro ? retroSections : sections;
      for (const section of train.sections) {
        const slot = retro ? retroCount++ : count++;
        matrix(trainMesh, slot, section.x, section.y, section.z, section.heading, 1, 1, 1, section.pitch);
        trainMesh.geometry.attributes.cabLights.setX(
          slot,
          section.car === 0 && section.side > 0
            ? 1
            : section.car === TRANSIT_LIMITS.cars - 1 && section.side < 0
              ? 2
              : 0,
        );
      }
      for (let car = 0; car < TRANSIT_LIMITS.cars; car++) {
        const pose = transitPose(train.route, train.distance - car * TRANSIT_LIMITS.carSpacing);
        if (pose && !pose.segment.tunnel)
          matrix(joints, jointCount++, pose.x, simulation.height(pose), pose.z, pose.heading);
      }
      const nose = transitPose(train.route, train.distance + 12.78);
      if (nose && !nose.segment.tunnel) {
        matrix(headsigns, signCount, nose.x, simulation.height(nose) + 2.96, nose.z, nose.heading);
        const rect =
          atlas.rects[
            source.platforms.length + source.routes.findIndex((route) => route.id === train.route.id)
          ];
        signPlane.attributes.signRect.setXYZW(signCount++, ...rect);
      }
    }
    sections.count = count;
    retroSections.count = retroCount;
    joints.count = jointCount;
    headsigns.count = signCount;
    for (const mesh of [sections, retroSections, joints, headsigns]) mesh.instanceMatrix.needsUpdate = true;
    signPlane.attributes.signRect.needsUpdate = true;
    sectionGeometry.attributes.cabLights.needsUpdate = true;
    if (retroCount) retroGeometry.attributes.cabLights.needsUpdate = true;
    updatePlatforms(camera, quality);
    Object.assign(stats, simulation.stats, {
      visibleTrains: visible.length,
      renderedSections: count + retroCount,
      retroSections: retroCount,
      maxVisible,
    });
  }

  function hasGroundSupportNear(x, z, radius = 0.5) {
    for (const platform of platformIndex.near(x, z, radius)) {
      if (distanceToPlatform([x, z], platform) <= radius) return true;
    }
    for (const stair of stairIndex.near(x, z, radius + 1))
      for (let i = 1; i < stair.points.length; i++)
        if (nearestOnSegment(x, z, stair.points[i - 1], stair.points[i]).distance <= radius + stair.width / 2)
          return true;
    return false;
  }
  function groundHeight(x, z, elevationHint) {
    let result = null;
    for (const platform of platformIndex.near(x, z)) {
      if (!inPolygon(x, z, platform)) continue;
      const height = platform.heightAt(x, z);
      if (Number.isFinite(elevationHint) && height > elevationHint + 0.65) continue;
      if (result === null || height > result) result = height;
    }
    for (const stair of stairIndex.near(x, z, 2)) {
      let travelled = 0;
      for (let i = 1; i < stair.points.length; i++) {
        const a = stair.points[i - 1],
          b = stair.points[i],
          p = nearestOnSegment(x, z, a, b),
          len = distance(a, b),
          fraction = clamp((travelled + p.t * len) / stair.length, 0, 1),
          height =
            stair.bottom +
            ((stair.top - stair.bottom) * Math.min(stair.count, Math.floor(fraction * stair.count) + 1)) /
              stair.count;
        travelled += len;
        if (p.distance > stair.width / 2) continue;
        if (Number.isFinite(elevationHint) && height > elevationHint + 0.65) continue;
        result = Math.max(result ?? -Infinity, height);
      }
    }
    return result;
  }
  function stationBodyBlocked(position, body) {
    for (const platform of platformIndex.near(position.x, position.z, body.radius ?? 2.5)) {
      if (!inPolygon(position.x, position.z, platform)) continue;
      const top = platform.heightAt(position.x, position.z),
        bottom = platform.railHeight(position.x, position.z);
      if (position.y < top - 0.65 && position.y + (body.top ?? 1.9) > bottom + 0.08) return true;
    }
    for (const stair of stairIndex.near(position.x, position.z, 2)) {
      let travelled = 0;
      for (let i = 1; i < stair.points.length; i++) {
        const a = stair.points[i - 1],
          b = stair.points[i],
          p = nearestOnSegment(position.x, position.z, a, b),
          len = distance(a, b),
          fraction = clamp((travelled + p.t * len) / stair.length, 0, 1),
          top =
            stair.bottom +
            ((stair.top - stair.bottom) * Math.min(stair.count, Math.floor(fraction * stair.count) + 1)) /
              stair.count;
        travelled += len;
        if (
          p.distance < stair.width / 2 &&
          position.y < top - 0.65 &&
          position.y + (body.top ?? 1.9) > stair.bottom + 0.08
        )
          return true;
      }
    }
    return false;
  }
  function bodyBlocked(position, body) {
    if (stationBodyBlocked(position, body)) return true;
    for (const train of simulation.trains) {
      if (Math.hypot(train.x - position.x, train.z - position.z) > 70) continue;
      for (const section of train.sections)
        if (trainBodyContact(position, body, section, contact)) return true;
    }
    return false;
  }
  function resolveMovement(position, body) {
    let hit = stationBodyBlocked(position, body),
      moved = 0;
    for (const train of simulation.trains) {
      if (Math.hypot(train.x - position.x, train.z - position.z) > 70) continue;
      for (const section of train.sections) {
        if (!trainBodyContact(position, body, section, contact)) continue;
        train.speed = 0;
        train.stopDistance = 0;
        train.policyClock = 0;
        const push = Math.min(0.3 - moved, contact.depth + 0.002);
        if (push > 0) {
          position.x += contact.nx * push;
          position.z += contact.nz * push;
          moved += push;
        }
        hit = true;
      }
    }
    if (hit) stats.contacts++;
    return hit;
  }
  function trafficStopDistance(car, lookAhead = 100) {
    const heading = car.edge?.heading ?? car.heading,
      dx = Math.sin(heading),
      dz = Math.cos(heading);
    let closest = Infinity;
    for (const crossing of crossingIndex.near(car.x, car.z, lookAhead)) {
      if (
        !crossing.active ||
        (car.edge?.road?.id && crossing.roadId !== car.edge.road.id) ||
        Math.abs(car.y - crossing.y) > 2.5
      )
        continue;
      const x = crossing.x - car.x,
        z = crossing.z - car.z,
        along = x * dx + z * dz,
        across = Math.abs(x * dz - z * dx);
      // A vehicle already inside the clearance zone must clear it. The train
      // additionally yields to physical vehicles occupying its track corridor.
      if (along <= 6.3 || along > lookAhead || across > crossing.width / 2 + 2) continue;
      closest = Math.min(closest, Math.max(0, along - 6.3));
    }
    return closest;
  }
  return {
    simulation,
    trains: simulation.trains,
    platforms,
    access,
    crossings,
    meshes,
    stats,
    labels: platforms.map((platform) => ({
      name: platform.name,
      x: platform.x,
      z: platform.z,
      height: platform.y + 4.2,
    })),
    audioSources: simulation.trains,
    update,
    hasGroundSupportNear,
    groundHeight,
    bodyBlocked,
    resolveMovement,
    trafficStopDistance,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const material of [
        bodyMaterial,
        floorMaterial,
        propMaterial,
        stationSignMaterial,
        headsignMaterial,
      ])
        material.dispose();
      atlas.texture?.dispose();
    },
  };
}
