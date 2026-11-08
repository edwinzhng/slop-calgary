import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  float,
  floor,
  fract,
  mix,
  normalWorld,
  positionWorld,
  sin,
  step,
  time,
  vec2,
} from 'three/tsl';
import { facadeGlazing } from './reference-facades.js';
import { windowGlow } from './city-uniforms.js';
import { telusLightColor } from './landmark-lighting.js';

// The silhouette is the City's measured 3D surface, not rotated floor slabs.
// References and the datum discrepancy: data/TELUS_SKY_AUDIT.md.
export const TELUS_SKY = Object.freeze({
  buildingId: 'city-outline-28341-0',
  structureId: 2327658,
  x: 584.92,
  z: -109.19,
  rotation: -0.045,
  publishedHeight: 225.4,
  measuredHeight: 224.86,
  sourceDate: '2020-10-01',
  columns: 12,
  minX: -24.85,
  maxX: 26.72,
});
const localPoint = (x, y, z) => {
  const dx = x - TELUS_SKY.x,
    dz = z - TELUS_SKY.z,
    c = Math.cos(TELUS_SKY.rotation),
    s = Math.sin(TELUS_SKY.rotation);
  return [dx * c - dz * s, y, dx * s + dz * c];
};
export function telusLocalGeometry(geometry) {
  const g = geometry.clone(),
    p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, ...localPoint(p.getX(i), p.getY(i), p.getZ(i)));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
const area = (ring) =>
  ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) * 0.5;
function removeCollinear(ring) {
  let points = ring;
  for (let pass = 0; pass < 4; pass++) {
    const reduced = points.filter((b, i) => {
      const a = points[(i + points.length - 1) % points.length],
        c = points[(i + 1) % points.length],
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      return Math.abs(cross) > 1e-5;
    });
    if (reduced.length < 3 || reduced.length === points.length) break;
    points = reduced;
  }
  return points;
}

/** Horizontal outer loops cut from the source triangles, in local x/z. */
export function telusSection(geometry, height) {
  const p = geometry.attributes.position,
    index = geometry.index?.array,
    count = index?.length ?? p.count,
    nodes = new Map(),
    edges = new Map();
  const point = (i) => [p.getX(i), p.getY(i), p.getZ(i)],
    key = (q) => `${Math.round(q[0] * 10000)},${Math.round(q[1] * 10000)}`;
  const node = (q) => {
    const k = key(q);
    if (!nodes.has(k)) nodes.set(k, { point: q, adjacent: new Set() });
    return k;
  };
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map((j) => point(index ? index[i + j] : i + j));
    if (height <= Math.min(...triangle.map((q) => q[1])) || height >= Math.max(...triangle.map((q) => q[1])))
      continue;
    const hits = [];
    for (let j = 0; j < 3; j++) {
      const a = triangle[j],
        b = triangle[(j + 1) % 3];
      if (a[1] < height === b[1] < height) continue;
      const t = (height - a[1]) / (b[1] - a[1]);
      hits.push([a[0] + t * (b[0] - a[0]), a[2] + t * (b[2] - a[2])]);
    }
    if (hits.length !== 2) continue;
    const a = node(hits[0]),
      b = node(hits[1]);
    if (a === b) continue;
    const id = [a, b].sort().join('/');
    if (edges.has(id)) continue;
    edges.set(id, [a, b]);
    nodes.get(a).adjacent.add(b);
    nodes.get(b).adjacent.add(a);
  }
  const used = new Set(),
    rings = [];
  for (const [start, first] of edges.values()) {
    const edgeId = (a, b) => [a, b].sort().join('/');
    if (used.has(edgeId(start, first))) continue;
    const ring = [nodes.get(start).point];
    let previous = start,
      current = first,
      closed = false;
    for (let steps = 0; steps < edges.size + 1; steps++) {
      used.add(edgeId(previous, current));
      if (current === start) {
        closed = true;
        break;
      }
      ring.push(nodes.get(current).point);
      const next = [...nodes.get(current).adjacent].find(
        (k) => k !== previous && !used.has(edgeId(current, k)),
      );
      if (!next) break;
      previous = current;
      current = next;
    }
    if (closed && ring.length >= 3 && Math.abs(area(ring)) > 2) rings.push(removeCollinear(ring));
  }
  return rings.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
}

/** Sample the real north/south facade, rather than extrapolating a taper. */
export function telusFacadeSampler(geometry) {
  const p = geometry.attributes.position,
    index = geometry.index?.array,
    count = index?.length ?? p.count,
    faces = [];
  for (let i = 0; i < count; i += 3) {
    const v = [0, 1, 2].map((j) => {
      const n = index ? index[i + j] : i + j;
      return [p.getX(n), p.getY(n), p.getZ(n)];
    });
    const [a, b, c] = v,
      denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-7) continue;
    faces.push({
      v,
      denominator,
      minX: Math.min(...v.map((q) => q[0])),
      maxX: Math.max(...v.map((q) => q[0])),
      minY: Math.min(...v.map((q) => q[1])),
      maxY: Math.max(...v.map((q) => q[1])),
    });
  }
  return (x, y, side) => {
    let result = side > 0 ? -Infinity : Infinity;
    for (const face of faces) {
      if (x < face.minX - 0.001 || x > face.maxX + 0.001 || y < face.minY - 0.001 || y > face.maxY + 0.001)
        continue;
      const [a, b, c] = face.v,
        u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / face.denominator,
        v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / face.denominator;
      if (u < -0.0001 || v < -0.0001 || u + v > 1.0001) continue;
      const z = u * a[2] + v * b[2] + (1 - u - v) * c[2];
      result = side > 0 ? Math.max(result, z) : Math.min(result, z);
    }
    return Number.isFinite(result) ? result : null;
  };
}

/** Broad, real facade planes of a floor section, including every stepped bay. */
export function telusFacadePanels(geometry, height, sample = telusFacadeSampler(geometry)) {
  const panels = [];
  for (const ring of telusSection(geometry, height)) {
    for (let i = 0; i < ring.length; i++) {
      let a = ring[i],
        b = ring[(i + 1) % ring.length];
      if (a[0] > b[0]) [a, b] = [b, a];
      const width = b[0] - a[0];
      if (width < 2.7 || Math.abs(b[1] - a[1]) > width * 0.18) continue;
      const x = (a[0] + b[0]) * 0.5,
        z = (a[1] + b[1]) * 0.5;
      for (const side of [-1, 1]) {
        const face = sample(x, height, side);
        if (face === null || Math.abs(face - z) > 0.035) continue;
        const count = Math.max(1, Math.round(width / 4.2));
        for (let bay = 0; bay < count; bay++) {
          const t0 = bay / count,
            t1 = (bay + 1) / count;
          panels.push({
            a: [a[0] + width * t0, a[1] + (b[1] - a[1]) * t0],
            b: [a[0] + width * t1, a[1] + (b[1] - a[1]) * t1],
            side,
          });
        }
      }
    }
  }
  return panels;
}
function telusGlass() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0.42 });
  mat.name = 'TELUS Sky measured curtain wall';
  const p = positionWorld,
    dx = p.x.sub(TELUS_SKY.x),
    dz = p.z.sub(TELUS_SKY.z),
    u = dx
      .mul(Math.cos(TELUS_SKY.rotation))
      .sub(dz.mul(Math.sin(TELUS_SKY.rotation)))
      .sub(TELUS_SKY.minX),
    h = mix(float(4), float(3), step(118, p.y)),
    v = p.y.div(h),
    office = float(1).sub(step(55, p.y)),
    windowWidth = mix(float(4.3), float(8.6), office),
    rowOffset = fract(floor(p.y.sub(3.84).div(4)).mul(0.5)).mul(office),
    cells = vec2(u.div(windowWidth).sub(rowOffset), v),
    glazing = facadeGlazing(vec2(u, p.y), cells, float(4861), color(0x98b5c0), windowWidth, h),
    side = float(1).sub(step(0.32, abs(normalWorld.y)));
  mat.colorNode = mix(color(0xb5b8b1), glazing.color, side);
  mat.emissiveNode = glazing.emissive.mul(side);
  mat.roughnessNode = mix(float(0.85), float(0.2), side);
  mat.metalnessNode = side.mul(0.4);
  return mat;
}
function telusLEDs() {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xb4bbb9, roughness: 0.42, metalness: 0.2 });
  material.name = 'TELUS Sky north/south inverted-L light frames';
  const light = telusLightColor();
  // Slow, original colors; no copied Coupland animation or rapid flicker.
  material.emissiveNode = light.mul(windowGlow.sub(0.25).max(0)).mul(1.4);
  return material;
}
function fallback(helpers) {
  const { box, materials, ringLoft } = helpers,
    ring = (y, t) =>
      Array.from({ length: 12 }, (_, i) => {
        const x = TELUS_SKY.minX + ((i + 0.5) * (TELUS_SKY.maxX - TELUS_SKY.minX)) / 12;
        return [x, y, -17.5 + t * (x * 0.34 + 9)];
      });
  // Only isolated geometry tests omit the dataset. Runtime uses the measured branch.
  box(51.6, 58, 35.5, 0.9, 29, 0.5, materials.curtain);
  const rows = [58, 90, 120, 150, 217].map((y) => {
    const t = THREE.MathUtils.smoothstep(y, 58, 150),
      north = ring(y, t),
      south = ring(y, t)
        .reverse()
        .map((p) => [p[0], p[1], p[2] + 35.5 - t * 18]);
    return [...north, ...south];
  });
  ringLoft(rows, materials.curtain);
}
export function buildTelusSky(helpers) {
  const { beginAt, beam, add, replace, collision, materials, cityMeshes, data } = helpers,
    record = cityMeshes?.get(TELUS_SKY.buildingId),
    height = record?.height ?? TELUS_SKY.measuredHeight;
  beginAt('TELUS Sky', TELUS_SKY.x, TELUS_SKY.z, height, 34, TELUS_SKY.rotation);
  const mapped = data?.buildings?.find((b) => b.id === TELUS_SKY.buildingId),
    baseRing = mapped?.ring?.map(([x, z]) => {
      const p = localPoint(x, 0, z);
      return [p[0], p[2]];
    }) ?? [
      [-25.7, -18.5],
      [26.8, -18.5],
      [26.8, 19.3],
      [-25.7, 19.3],
    ];
  replace(baseRing);
  if (!record) {
    fallback(helpers);
    collision(baseRing, height);
    return { surveyed: false, source: 'test-only approximate envelope', windowModules: 0 };
  }
  const worldGeometry = cityMeshes.createGeometry(TELUS_SKY.buildingId),
    geometry = telusLocalGeometry(worldGeometry);
  worldGeometry.dispose();
  const sample = telusFacadeSampler(geometry),
    bands = [0, 12, 48, 60, 68, 76, 84, 92, 100, 108, 116, 122, 128, 134, 140, 146, 153, 213, 218, 221, 225],
    sections = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const lower = bands[i],
      upper = Math.min(height, bands[i + 1]);
    if (upper <= lower) continue;
    const rings = telusSection(geometry, lower + 0.033);
    if (rings.length) {
      for (const ring of rings) collision(ring, upper, Math.max(0, lower));
      sections.push({ minHeight: lower, maxHeight: upper, rings: rings.length });
    }
  }
  const glass = telusGlass(),
    led = telusLEDs();
  materials.telusSurveyedGlass = glass;
  materials.telusLEDs = led;
  const floorRows = [];
  for (let y = 3.84; y < 117.9; y += 4) floorRows.push([y, y + 4]);
  for (let y = 118.54; y < 218.6; y += 3) floorRows.push([y, y + 3]);
  let windows = 0,
    lightLength = 0;
  for (const [floorY, topY] of floorRows) {
    const cy = (floorY + topY) * 0.5;
    let panels = telusFacadePanels(geometry, cy, sample);
    if (cy < 55) {
      const grouped = [],
        offset = Math.round((cy - 5.84) / 4) % 2;
      for (const side of [-1, 1]) {
        const row = panels.filter((p) => p.side === side).sort((a, b) => a.a[0] - b.a[0]);
        for (let i = 0; i < row.length;) {
          const a = row[i],
            b = row[i + 1],
            single = i === 0 && offset;
          if (!single && b && Math.hypot(a.b[0] - b.a[0], a.b[1] - b.a[1]) < 0.1) {
            grouped.push({ a: a.a, b: b.b, side });
            i += 2;
          } else {
            grouped.push(a);
            i++;
          }
        }
      }
      panels = grouped;
    }
    for (const panel of panels) {
      const { side, a, b } = panel,
        x = (a[0] + b[0]) * 0.5,
        z = (a[1] + b[1]) * 0.5;
      let bottom = floorY + 0.17,
        top = topY - 0.17;
      // A sampled pixel can end at a real roof/terrace partway through a
      // nominal window row. Clip the frame there instead of floating its top
      // outside the measured wall or bridging a large setback in empty air.
      const sameFace = (y) => {
        const value = sample(x, y, side);
        return value !== null && Math.abs(value - z) < 0.55;
      };
      const clip = (end) => {
        let inside = cy,
          outside = end;
        for (let j = 0; j < 9; j++) {
          const mid = (inside + outside) * 0.5;
          if (sameFace(mid)) inside = mid;
          else outside = mid;
        }
        return inside;
      };
      if (!sameFace(bottom)) bottom = clip(bottom) + 0.05;
      if (!sameFace(top)) top = clip(top) - 0.05;
      if (top - bottom < 1.35) continue;
      const point = (t, y, offset = 0.075) => {
        const xx = a[0] + (b[0] - a[0]) * t,
          zz = sample(xx, y, side);
        return zz === null ? null : [xx, y, zz + side * offset];
      };
      const corners = [point(0.025, bottom), point(0.975, bottom), point(0.975, top), point(0.025, top)];
      if (corners.some((p) => !p)) continue;
      for (let edge = 0; edge < 4; edge++)
        beam(corners[edge], corners[(edge + 1) % 4], edge === 0 ? 0.105 : 0.075, materials.white, 4);
      const panes = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.15));
      for (let pane = 1; pane < panes; pane++) {
        const middleBottom = point(pane / panes, bottom + 0.1),
          middleTop = point(pane / panes, top - 0.1);
        if (middleBottom && middleTop) beam(middleBottom, middleTop, 0.032, materials.dark, 4);
      }
      // Two strips form the owner's north/south inverted-L layout. Their end
      // points are separately projected onto the real 3D facade, including its
      // shallow curve, rather than a box aligned to an imagined floor stack.
      const ledA = point(0.05, top - 0.12, 0.17),
        ledB = point(0.95, top - 0.12, 0.17),
        ledC = point(0.05, bottom + 0.12, 0.17);
      if (ledA && ledB && ledC) {
        beam(ledA, ledB, 0.038, led, 4);
        beam(ledA, ledC, 0.038, led, 4);
        lightLength +=
          Math.hypot(...ledA.map((v, i) => v - ledB[i])) + Math.hypot(...ledA.map((v, i) => v - ledC[i]));
      }
      windows++;
    }
  }
  (helpers.addSource || add)(geometry, glass);
  return {
    surveyed: true,
    buildingId: TELUS_SKY.buildingId,
    structureId: record.structureIds?.[0],
    sourceDate: record.sourceDates?.[0],
    height,
    windowModules: windows,
    modeledLightLength: lightLength,
    sections,
  };
}
