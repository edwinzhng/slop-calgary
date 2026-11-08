import * as THREE from 'three/webgpu';
import polygonClipping from 'polygon-clipping';
import { bounds, SpatialIndex } from './geo.js';
import { splitTerrainPolygon } from './terrain-polygons.js';
import { TRANSIT_LIMITS } from './transit-motion.js';

const HALF_WIDTH = TRANSIT_LIMITS.carWidth / 2 + 0.42;
const HEADROOM = 4.8;
const FOOTROOM = 0.42;
const boxesOverlap = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;

export function createRailClearance(railIndex, railHeight) {
  const index = new SpatialIndex(80);
  for (const { a, b, road } of railIndex.segments) {
    if (road.tunnel || !['rail', 'light_rail'].includes(road.kind)) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pieces = Math.ceil(length / 12);
    const dx = (b[0] - a[0]) / length;
    const dz = (b[1] - a[1]) / length;
    for (let i = 0; i < pieces; i++) {
      const start = (i * length) / pieces;
      const span = length / pieces;
      const x = a[0] + dx * start;
      const z = a[1] + dz * start;
      const y0 = railHeight(x, z, road);
      const y1 = railHeight(x + dx * span, z + dz * span, road);
      const along = ([px, , pz]) => (px - x) * dx + (pz - z) * dz;
      const across = ([px, , pz]) => (pz - z) * dx - (px - x) * dz;
      const level = (px, pz) => y0 + ((y1 - y0) * along([px, 0, pz])) / span;
      // Only add a short overlap at source bends so adjacent clearance volumes
      // meet without cutting into neighboring blocks at dead ends.
      const from = i === 0 ? -0.65 : 0;
      const to = span + (i === pieces - 1 ? 0.65 : 0);
      const at = (d, s) => [x + dx * d - dz * s, z + dz * d + dx * s];
      const ring = [
        at(from, -HALF_WIDTH),
        at(to, -HALF_WIDTH),
        at(to, HALF_WIDTH),
        at(from, HALF_WIDTH),
        at(from, -HALF_WIDTH),
      ];
      const box = bounds(ring);
      index.insert(
        {
          road,
          ring,
          box,
          level,
          low: Math.min(level(...at(from, 0)), level(...at(to, 0))) - FOOTROOM,
          high: Math.max(level(...at(from, 0)), level(...at(to, 0))) + HEADROOM,
          planes: [
            (v) => from - along(v),
            (v) => along(v) - to,
            (v) => -HALF_WIDTH - across(v),
            (v) => across(v) - HALF_WIDTH,
            ([px, py, pz]) => level(px, pz) - FOOTROOM - py,
            ([px, py, pz]) => py - level(px, pz) - HEADROOM,
          ],
        },
        box,
      );
    }
  }
  return {
    find(building, box, minHeight, maxHeight) {
      // This is a locomotive maintenance shop with rail sidings inside.
      // Preserve its real enclosure rather than open the full shed to the yard.
      if (building.id === 'city-outline-27812-0' && building.name === 'Alyth Diesel Shop') return [];
      const x = (box.minX + box.maxX) / 2;
      const z = (box.minZ + box.maxZ) / 2;
      const radius = Math.max(box.maxX - x, box.maxZ - z);
      return [...index.near(x, z, radius)].filter(
        (cut) => boxesOverlap(box, cut.box) && maxHeight > cut.low && minHeight < cut.high,
      );
    },
  };
}

function trimFace(polygon, planes) {
  let inside = polygon;
  const outside = [];
  for (const plane of planes) {
    const sides = inside.map(plane);
    if (sides.every((side) => side <= 1e-7)) continue;
    if (sides.every((side) => side >= -1e-7)) return null;
    const [kept, rejected] = splitTerrainPolygon(inside, plane);
    if (kept.length < 3) return null;
    if (rejected.length >= 3) outside.push(rejected);
    inside = kept;
  }
  return outside;
}

export function trimRailGeometry(geometry, cuts) {
  if (!cuts.length) return geometry;
  // Keep source facade attributes with the original face when an edge is split.
  const { position, ...attributes } = geometry.attributes;
  const channels = [['position', position], ...Object.entries(attributes)];
  const output = channels.map(() => []);
  const read = (i) => {
    const vertex = geometry.index ? geometry.index.getX(i) : i;
    return channels.flatMap(([, attribute]) =>
      Array.from(attribute.array.subarray(vertex * attribute.itemSize, (vertex + 1) * attribute.itemSize)),
    );
  };
  const emit = (v) => {
    let offset = 0;
    for (let i = 0; i < channels.length; i++) {
      const end = offset + channels[i][1].itemSize;
      output[i].push(...v.slice(offset, end));
      offset = end;
    }
  };
  let changed = false;
  for (let i = 0; i < (geometry.index?.count ?? position.count); i += 3) {
    const a = read(i),
      b = read(i + 1),
      c = read(i + 2);
    const box = {
      minX: Math.min(a[0], b[0], c[0]),
      maxX: Math.max(a[0], b[0], c[0]),
      minZ: Math.min(a[2], b[2], c[2]),
      maxZ: Math.max(a[2], b[2], c[2]),
    };
    const low = Math.min(a[1], b[1], c[1]),
      high = Math.max(a[1], b[1], c[1]);
    let pieces = [[a, b, c]];
    for (const cut of cuts) {
      if (!boxesOverlap(box, cut.box) || low > cut.high || high < cut.low) continue;
      pieces = pieces.flatMap((piece) => {
        const kept = trimFace(piece, cut.planes);
        if (!kept) return [piece];
        changed = true;
        return kept;
      });
      if (!pieces.length) break;
    }
    for (const piece of pieces)
      for (let j = 2; j < piece.length; j++) {
        emit(piece[0]);
        emit(piece[j - 1]);
        emit(piece[j]);
      }
  }
  if (!changed) return geometry;
  const clipped = new THREE.BufferGeometry();
  for (let i = 0; i < channels.length; i++) {
    const [name, attribute] = channels[i];
    clipped.setAttribute(
      name,
      new THREE.BufferAttribute(
        attribute.array.constructor.from(output[i], attribute.normalized ? Math.round : (value) => value),
        attribute.itemSize,
        attribute.normalized,
      ),
    );
  }
  clipped.userData = { ...geometry.userData };
  geometry.dispose();
  return clipped;
}

export function trimRailCollider(collider, cuts) {
  let parts = [collider];
  for (const cut of cuts) {
    parts = parts.flatMap((part) => {
      if (part.height <= cut.low || part.minHeight >= cut.high || !boxesOverlap(bounds(part.ring), cut.box))
        return [part];
      const footprint = [part.ring, ...(part.holes || [])];
      const overlap = polygonClipping.intersection(footprint, [cut.ring]);
      if (!overlap.length) return [part];
      const kept = polygonClipping
        .difference(footprint, [cut.ring])
        .map(([ring, ...holes]) => ({ ...part, ring, holes }));
      for (const [ring, ...holes] of overlap) {
        const floor = Math.min(...ring.map(([x, z]) => cut.level(x, z))) + HEADROOM;
        const ceiling = Math.max(...ring.map(([x, z]) => cut.level(x, z))) - FOOTROOM;
        if (floor < part.height)
          kept.push({
            ...part,
            ring,
            holes,
            minHeight: Math.max(part.minHeight, floor),
            minHeightAt: (x, z, body) =>
              Math.max(part.minHeightAt?.(x, z, body) ?? part.minHeight, cut.level(x, z) + HEADROOM),
          });
        if (cut.road.bridge && ceiling > part.minHeight)
          kept.push({
            ...part,
            ring,
            holes,
            height: Math.min(part.height, ceiling),
            heightAt: (x, z, body) =>
              Math.min(part.heightAt?.(x, z, body) ?? part.height, cut.level(x, z) - FOOTROOM),
          });
      }
      return kept;
    });
  }
  return parts;
}
