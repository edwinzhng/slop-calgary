import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import manifest from '../data/calgary-developments.json' with { type: 'json' };
import { inside, bounds } from './geo.js';
import { createStructureGroundPlacement } from './structure-ground.js';

// Buildings are modelled from the cited current plans and construction notices.
// No architectural photograph, speculative finished arena or borrowed BIM is loaded.
export const DEVELOPMENT_MANIFEST = manifest;
const UP = new THREE.Vector3(0, 1, 0);
const C = {
  copper: 0x9e5744,
  copperLight: 0xba7561,
  concrete: 0x84847e,
  pale: 0xb4b1a7,
  glass: 0x23454d,
  steel: 0x5c6262,
  roof: 0x45494a,
  paving: 0xb9b5a8,
  earth: 0x6d6657,
  grass: 0x617348,
  tree: 0x54683e,
  dark: 0x242e30,
  orange: 0xd59832,
};
const hash = (n) => {
  const q = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return q - Math.floor(q);
};
const rounded = (x) => Math.round(x * 1000) / 1000;

export function bmoWorld(site, u, v) {
  const c = Math.cos(site.rotation),
    s = Math.sin(site.rotation);
  return [site.anchor[0] + u * c + v * s, site.anchor[1] - u * s + v * c];
}

export function bmoLocal(site, x, z) {
  const c = Math.cos(site.rotation),
    s = Math.sin(site.rotation);
  x -= site.anchor[0];
  z -= site.anchor[1];
  return [x * c - z * s, x * s + z * c];
}

/** Official plan pixel coordinates bilinearly registered to mapped site corners. */
export function scotiaPlanPoint(site, x, y) {
  const u = (x - site.planPixels.origin[0]) / site.planPixels.size[0];
  const v = (y - site.planPixels.origin[1]) / site.planPixels.size[1];
  const [a, b, c, d] = site.planQuad;
  return [0, 1].map((j) => (1 - v) * ((1 - u) * a[j] + u * b[j]) + v * ((1 - u) * d[j] + u * c[j]));
}

export function bmoCanopyPoint(site, t, across = 0) {
  const p = site.canopyControls;
  const interpolate = (k) =>
    (1 - t) ** 3 * p[0][k] +
    3 * (1 - t) ** 2 * t * p[1][k] +
    3 * (1 - t) * t * t * p[2][k] +
    t ** 3 * p[3][k];
  const u = interpolate(0),
    v = interpolate(1),
    y = interpolate(2),
    width = interpolate(3);
  const du =
    3 * (1 - t) ** 2 * (p[1][0] - p[0][0]) +
    6 * (1 - t) * t * (p[2][0] - p[1][0]) +
    3 * t * t * (p[3][0] - p[2][0]);
  const dv =
    3 * (1 - t) ** 2 * (p[1][1] - p[0][1]) +
    6 * (1 - t) * t * (p[2][1] - p[1][1]) +
    3 * t * t * (p[3][1] - p[2][1]);
  const length = Math.hypot(du, dv) || 1;
  const xz = bmoWorld(site, u + (across * width * dv) / length, v - (across * width * du) / length);
  return [xz[0], y + 1.3 * across * across, xz[1]];
}

function cleanRing(ring) {
  const result = ring.map((p) => [...p]);
  if (
    result.length > 3 &&
    Math.hypot(result[0][0] - result.at(-1)[0], result[0][1] - result.at(-1)[1]) < 0.001
  )
    result.pop();
  return result;
}

function rect(x, z, width, depth) {
  return [
    [x - width / 2, z - depth / 2],
    [x + width / 2, z - depth / 2],
    [x + width / 2, z + depth / 2],
    [x - width / 2, z + depth / 2],
  ];
}

/** One mesh per shared material for the entire current-development overlay. */
export function buildRecentDevelopments(scene, data = {}, options = {}) {
  const source = options.manifest || manifest;
  const groundPlacement = options.ground ? createStructureGroundPlacement(options.ground, { data }) : null;
  let activePlacement;
  let activeSite;
  const buckets = new Map(),
    meshes = [],
    colliders = [],
    labels = [],
    exclusions = [];
  const stats = {
    sites: source.sites.length,
    triangles: 0,
    drawCalls: 0,
    bmoParts: 0,
    canopyLights: 0,
    scotiaFins: 0,
    cranes: 0,
    runtimeTextures: 0,
    constructionSites: 0,
    excludedBuildingIds: [],
    sourceDate: source.meta.asOf,
  };
  const materials = {
    copper: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.73,
      side: THREE.DoubleSide,
    }),
    concrete: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.91,
      side: THREE.DoubleSide,
    }),
    glass: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.22,
      metalness: 0.6,
      side: THREE.DoubleSide,
    }),
    steel: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.58,
      metalness: 0.72,
      side: THREE.DoubleSide,
    }),
    ground: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
    dark: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.28,
      side: THREE.DoubleSide,
    }),
    foliage: new THREE.MeshStandardNodeMaterial({ color: 0xffffff, vertexColors: true, roughness: 1 }),
    safety: new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.64,
      metalness: 0.3,
    }),
    artwork: new THREE.MeshStandardNodeMaterial({
      color: 0x24b5bb,
      roughness: 0.5,
      metalness: 0.45,
      side: THREE.DoubleSide,
    }),
    light: new THREE.MeshStandardNodeMaterial({
      color: 0xffd5a1,
      emissive: 0xffc07d,
      emissiveIntensity: 0,
      roughness: 0.4,
    }),
  };
  materials.light.userData.noShadow = true;
  materials.glass.userData.noShadow = true;
  const add = (geometry, kind, tint = 0xffffff, matrix) => {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const name of Object.keys(g.attributes))
      if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
    const rgb = new THREE.Color(tint),
      colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = rgb.r;
      colors[i + 1] = rgb.g;
      colors[i + 2] = rgb.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (groundPlacement) groundPlacement.placeGeometry(g, activePlacement, 'authored-development');
    else if (options.captureOwnership)
      g.userData = {
        ...g.userData,
        structureSourceId: activeSite.id,
        structureGroundRole: 'authored-development',
      };
    if (!buckets.has(kind)) buckets.set(kind, []);
    buckets.get(kind).push(g);
  };
  const box = (w, h, d, x, y, z, kind = 'concrete', tint = C.concrete, angle = 0) => {
    if (!(w > 0 && h > 0 && d > 0)) return;
    const matrix = new THREE.Matrix4().makeRotationY(angle);
    matrix.setPosition(x, y, z);
    add(new THREE.BoxGeometry(w, h, d), kind, tint, matrix);
  };
  const beam = (a, b, width = 0.12, kind = 'steel', tint = C.steel, depth = width) => {
    const pa = new THREE.Vector3(...a),
      pb = new THREE.Vector3(...b),
      direction = pb.clone().sub(pa);
    if (direction.length() < 0.001) return;
    const matrix = new THREE.Matrix4().compose(
      pa.add(pb).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(UP, direction.clone().normalize()),
      new THREE.Vector3(1, 1, 1),
    );
    add(new THREE.BoxGeometry(width, direction.length(), depth), kind, tint, matrix);
  };
  const quad = (a, b, c, d, kind, tint) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    add(g, kind, tint);
  };
  const slab = (ring, bottom, top, kind = 'concrete', tint = C.concrete) => {
    const p = cleanRing(ring),
      shape = new THREE.Shape(p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, steps: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, bottom, 0);
    add(g, kind, tint);
  };
  const collider = (site, ring, height, minHeight = 0, heightAt) => {
    const record = {
      id: `${site.id}-${colliders.length}`,
      name: site.name,
      ring: cleanRing(ring),
      height,
      minHeight,
      ...(heightAt ? { heightAt } : {}),
      sourceIds: site.sourceIds,
      development: site.id,
    };
    colliders.push(record);
    return record;
  };
  const fence = (site, ring, closed = true, height = 2.35) => {
    const p = cleanRing(ring);
    for (let i = 0; i < p.length - (closed ? 0 : 1); i++) {
      const a = p[i],
        b = p[(i + 1) % p.length],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]),
        n = Math.ceil(length / 3);
      if (length < 0.05) continue;
      const dx = (b[0] - a[0]) / length,
        dz = (b[1] - a[1]) / length;
      for (let j = 0; j < n; j++) {
        const lo = j / n,
          hi = (j + 1) / n,
          x = a[0] + (b[0] - a[0]) * lo,
          z = a[1] + (b[1] - a[1]) * lo;
        const x2 = a[0] + (b[0] - a[0]) * hi,
          z2 = a[1] + (b[1] - a[1]) * hi;
        box(0.07, height, 0.07, x, height / 2 + 0.22, z, 'steel', C.steel);
        quad([x, 0.22, z], [x2, 0.22, z2], [x2, height + 0.22, z2], [x, height + 0.22, z], 'dark', 0x526268);
        beam([x, height + 0.26, z], [x2, height + 0.26, z2], 0.055, 'steel', 0xa4a9a7);
        for (const v of [0.7, 1.6]) beam([x, v, z], [x2, v + 0.5, z2], 0.018, 'steel', 0x9ba4a4);
        if (j % 4 === 0)
          box(0.08, 0.55, 0.8, (x + x2) / 2, 1.5, (z + z2) / 2, 'safety', 0xd8ad47, Math.atan2(dx, dz));
      }
      const width = 0.22,
        ringStrip = [
          [a[0] - dz * width, a[1] + dx * width],
          [b[0] - dz * width, b[1] + dx * width],
          [b[0] + dz * width, b[1] - dx * width],
          [a[0] + dz * width, a[1] - dx * width],
        ];
      collider(site, ringStrip, height + 0.3);
    }
  };
  const crane = (x, z, height, angle = 0) => {
    const transform = (u, y, v) => [
      x + u * Math.cos(angle) + v * Math.sin(angle),
      y,
      z - u * Math.sin(angle) + v * Math.cos(angle),
    ];
    const segment = 3.4;
    for (let y = 0.25; y < height; y += segment) {
      for (const u of [-1.1, 1.1])
        for (const v of [-1.1, 1.1])
          beam(transform(u, y, v), transform(u, Math.min(y + segment, height), v), 0.19, 'safety', C.orange);
      for (const u of [-1.1, 1.1]) {
        beam(
          transform(u, y, -1.1),
          transform(u, Math.min(y + segment, height), 1.1),
          0.09,
          'safety',
          C.orange,
        );
        beam(
          transform(-1.1, y, u),
          transform(1.1, Math.min(y + segment, height), u),
          0.09,
          'safety',
          C.orange,
        );
      }
    }
    for (let u = -17; u < 56; u += 3.65) {
      for (const v of [-0.7, 0.7]) {
        beam(transform(u, height, v), transform(u + 3.65, height, v), 0.16, 'safety', C.orange);
        beam(transform(u, height + 1.8, 0), transform(u + 3.65, height + 1.8, 0), 0.13, 'safety', C.orange);
        beam(transform(u, height, v), transform(u + 3.65, height + 1.8, 0), 0.1, 'safety', C.orange);
      }
    }
    const cabin = transform(-2, height - 1.1, 1.4);
    box(2.5, 2.1, 2, ...cabin, 'glass', 0x6d8786, angle);
    const counter = transform(-15, height - 0.6, 0);
    box(4.5, 2.7, 2.9, ...counter, 'concrete', C.concrete, angle);
    beam(transform(33, height, 0), transform(33, Math.max(9, height - 30), 0), 0.055, 'steel', 0x303b40);
    stats.cranes++;
  };

  function buildBmo(site) {
    const point = (u, y, v) => {
      const p = bmoWorld(site, u, v);
      return [p[0], y, p[1]];
    };
    const localBox = (w, h, d, u, y, v, kind = 'concrete', tint = C.concrete) => {
      const p = bmoWorld(site, u, v);
      box(w, h, d, p[0], y, p[1], kind, tint, site.rotation);
    };
    const localRing = (r) => r.map(([u, v]) => bmoWorld(site, u, v));
    const upper = localRing(site.upperRing);
    const groundRing = localRing(site.groundRing);
    // Keep the northern retained halls. The base compound missed Hall F entirely.
    for (const part of site.parts) {
      const modern = part.name === 'Hall A1' || part.name === 'Hall A2';
      const height = modern ? 11.4 : part.height || Math.max(4.4, part.levels * 3.4);
      const bottom = part.minLevel ? 11.4 : 0.2;
      if (part.roof) continue;
      if (height <= bottom) continue;
      slab(part.ring, bottom, height, modern ? 'glass' : 'concrete', modern ? C.glass : C.pale);
      slab(part.ring, height, height + 0.32, 'dark', C.roof);
      collider(site, part.ring, height + 0.32, bottom > 0.3 ? bottom : 0);
      stats.bmoParts++;
      if (part.name && !modern) {
        const bb = bounds(part.ring),
          x = (bb.minX + bb.maxX) / 2,
          z = (bb.minZ + bb.maxZ) / 2;
        // Low mechanical units and rooflights, confined to the actual hall roof.
        for (let k = -1; k <= 1; k++) {
          const u = x + k * 10,
            v = z + k * 7;
          if (inside(u, v, part.ring)) box(4, 0.9, 2.5, u, height + 0.8, v, 'steel', 0x9faaa9, site.rotation);
        }
      }
    }
    // The source level-1 contour includes the front public concourse and curved
    // café, well beyond the exhibition-hall walls. Omitting it floats the facade.
    slab(groundRing, 0.2, 4.5, 'glass', C.glass);
    slab(groundRing, 4.5, 11.4, 'concrete', 0x757872);
    collider(site, groundRing, 11.4);
    slab(upper, 11.4, 22, 'glass', C.glass);
    slab(upper, 22, site.roofHeight, 'copper', C.copper);
    slab(upper, site.roofHeight, site.roofHeight + 0.22, 'copper', C.copperLight);
    collider(site, upper, site.roofHeight + 0.22, 11.4);
    // The new body follows the actual curved exterior outline. Rectangular panels
    // form the short/long horizontal bands visible in the completed official view.
    const ring = cleanRing(upper);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.25) continue;
      const dx = (b[0] - a[0]) / length,
        dz = (b[1] - a[1]) / length;
      const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const sign = inside(midpoint[0] - 0.2 * dz, midpoint[1] + 0.2 * dx, ring) ? -1 : 1;
      const normal = [-dz * sign * 0.045, dx * sign * 0.045];
      const face = (lo, hi, y, h, kind, tint) =>
        quad(
          [a[0] + dx * lo + normal[0], y, a[1] + dz * lo + normal[1]],
          [a[0] + dx * hi + normal[0], y, a[1] + dz * hi + normal[1]],
          [a[0] + dx * hi + normal[0], y + h, a[1] + dz * hi + normal[1]],
          [a[0] + dx * lo + normal[0], y + h, a[1] + dz * lo + normal[1]],
          kind,
          tint,
        );
      const modules = Math.ceil(length / 3.9);
      for (let row = 0; row < 11; row++)
        for (let column = 0; column < modules; column++) {
          const lo = (column * length) / modules + 0.035,
            hi = ((column + 1) * length) / modules - 0.035;
          if (hi <= lo) continue;
          const variation = hash(i * 127 + row * 43 + column * 11);
          const tint = new THREE.Color(C.copper).multiplyScalar(0.82 + variation * 0.34);
          const isWindow = row > 1 && row < 9 && variation > 0.77 && length > 7;
          face(
            lo,
            hi,
            22 + row * 1.36 + 0.035,
            1.28,
            isWindow ? 'glass' : 'copper',
            isWindow ? 0x253c40 : tint,
          );
        }
      // Two public levels have fine mullions and a continuous concrete slab band.
      face(0, length, 11.42, 0.48, 'concrete', C.concrete);
      face(0, length, 21.6, 0.4, 'concrete', C.pale);
      for (let s = 0; s < length; s += 2.8) {
        const x = a[0] + dx * s + normal[0] * 1.5,
          z = a[1] + dz * s + normal[1] * 1.5;
        beam([x, 11.9, z], [x, 21.6, z], 0.085, 'steel', 0x626c6b);
      }
    }
    // Main ground doors, shaded by the real upper-storey overhang.
    for (let u = 0; u < 88; u += 3.1) {
      localBox(2.65, 3.3, 0.1, u, 1.85, 95.45, 'glass', 0x34505a);
      localBox(0.085, 3.4, 0.18, u - 1.36, 1.85, 95.45, 'steel', C.steel);
      localBox(2.72, 0.1, 0.18, u, 3.58, 95.45, 'steel', C.steel);
    }
    // Source-informed curved canopy ribbon: top and underside remain separated,
    // the plaza underneath stays open, and no ground-blocking whole-roof collider.
    const segments = 48,
      crossSegments = 10,
      thickness = 1.15;
    for (let i = 0; i < segments; i++) {
      const lo = i / segments,
        hi = (i + 1) / segments;
      for (let j = 0; j < crossSegments; j++) {
        const a = j / crossSegments - 0.5,
          b = (j + 1) / crossSegments - 0.5;
        const p = bmoCanopyPoint(site, lo, a),
          q = bmoCanopyPoint(site, hi, a),
          r = bmoCanopyPoint(site, hi, b),
          s = bmoCanopyPoint(site, lo, b);
        quad(p, q, r, s, 'copper', new THREE.Color(C.copperLight).multiplyScalar(0.85 + 0.12 * (j % 3)));
        quad(
          p.map((v, k) => (k === 1 ? v - thickness : v)),
          s.map((v, k) => (k === 1 ? v - thickness : v)),
          r.map((v, k) => (k === 1 ? v - thickness : v)),
          q.map((v, k) => (k === 1 ? v - thickness : v)),
          'dark',
          0x453d36,
        );
        if (i % 3 === 0 && j % 2 === 0) {
          const m = bmoCanopyPoint(site, (lo + hi) / 2, (a + b) / 2);
          box(0.13, 0.08, 0.13, m[0], m[1] - thickness - 0.055, m[2], 'light', 0xffffff);
          stats.canopyLights++;
        }
      }
      for (const across of [-0.5, 0.5]) {
        const a = bmoCanopyPoint(site, lo, across),
          b = bmoCanopyPoint(site, hi, across);
        quad(a, b, [b[0], b[1] - thickness, b[2]], [a[0], a[1] - thickness, a[2]], 'copper', C.copperLight);
      }
      if (i % 3 === 0) {
        const colliderHi = Math.min(1, (i + 3) / segments);
        const corners = [
          bmoCanopyPoint(site, lo, -0.5),
          bmoCanopyPoint(site, colliderHi, -0.5),
          bmoCanopyPoint(site, colliderHi, 0.5),
          bmoCanopyPoint(site, lo, 0.5),
        ];
        const min = Math.min(...corners.map((p) => p[1])) - thickness,
          max = Math.max(...corners.map((p) => p[1]));
        collider(
          site,
          corners.map((p) => [p[0], p[2]]),
          max,
          min,
        );
      }
    }
    // Standing seams follow the full curved copper surface, with no huge textures.
    for (let j = 0; j <= 24; j++)
      for (let i = 0; i < segments; i++) {
        const a = bmoCanopyPoint(site, i / segments, j / 24 - 0.5),
          b = bmoCanopyPoint(site, (i + 1) / segments, j / 24 - 0.5);
        a[1] += 0.035;
        b[1] += 0.035;
        beam(a, b, 0.035, 'copper', 0xb67e66);
      }
    for (const [u, v, radius, height] of [
      [113, 138, 2.1, 6.0],
      [136, 119, 1.1, 9.8],
    ]) {
      const p = point(u, height / 2 + 0.2, v),
        g = new THREE.CylinderGeometry(radius * 0.7, radius, height, 16);
      g.translate(...p);
      add(g, 'copper', C.copper);
      collider(
        site,
        localRing(
          Array.from({ length: 12 }, (_, j) => [
            u + Math.cos((j * Math.PI) / 6) * radius,
            v + Math.sin((j * Math.PI) / 6) * radius,
          ]),
        ),
        height + 0.2,
      );
    }
    // Public plaza. Its measured published area is metadata; paving outline and
    // furniture placement are approximate, aligned to completed-source views.
    const plaza = localRing([
      [-38, 100],
      [67, 104],
      [90, 111],
      [131, 101],
      [178, 100],
      [185, 117],
      [155, 153],
      [-20, 153],
      [-44, 126],
    ]);
    slab(plaza, 0.205, 0.285, 'ground', C.paving);
    for (let u = -32; u < 173; u += 8)
      for (let v = 105; v < 151; v += 6) {
        const p = bmoWorld(site, u, v);
        if (!inside(p[0], p[1], plaza)) continue;
        localBox(7.94, 0.012, 0.045, u, 0.295, v, 'ground', 0x898a83);
      }
    // Stairs rise toward the second-level balcony under the eastern ribbon.
    const stair = { u: 162.5, minV: 100, maxV: 128, width: 17.5, bottom: 0.285, top: 11.4, steps: 64 };
    for (let i = 0; i < stair.steps; i++) {
      const run = (stair.maxV - stair.minV) / stair.steps,
        v = stair.maxV - (i + 0.5) * run,
        y = stair.bottom + ((i + 1) / stair.steps) * (stair.top - stair.bottom);
      localBox(
        stair.width,
        y - stair.bottom,
        run + 0.014,
        stair.u,
        (y + stair.bottom) / 2,
        v,
        'concrete',
        i % 8 === 0 ? 0xbcb8ac : C.pale,
      );
      if (i % 8 === 0)
        localBox(stair.width, 0.04, 0.055, stair.u, y + 0.025, v + run * 0.45, 'light', 0xffe3b0);
    }
    for (const u of [stair.u - stair.width / 2 + 0.3, stair.u + stair.width / 2 - 0.3]) {
      for (let i = 0; i <= 8; i++) {
        const v = stair.maxV - ((stair.maxV - stair.minV) * i) / 8,
          y = stair.bottom + ((stair.top - stair.bottom) * i) / 8;
        beam(point(u, y, v), point(u, y + 1.05, v), 0.06, 'steel', 0x8a918e);
      }
      beam(
        point(u, stair.bottom + 1.05, stair.maxV),
        point(u, stair.top + 1.05, stair.minV),
        0.07,
        'steel',
        0xa4aaa4,
      );
    }
    const stairRing = localRing(
      rect(stair.u, (stair.minV + stair.maxV) / 2, stair.width, stair.maxV - stair.minV),
    );
    const treadHeight = (v) => {
      const step = Math.min(
        stair.steps,
        Math.max(1, Math.ceil(((stair.maxV - v) / (stair.maxV - stair.minV)) * stair.steps)),
      );
      return stair.bottom + (step / stair.steps) * (stair.top - stair.bottom);
    };
    const stairsHeight = (x, z) => {
      const [u, v] = bmoLocal(site, x, z);
      if (Math.abs(u - stair.u) > stair.width / 2 || v < stair.minV || v > stair.maxV) return null;
      return treadHeight(v);
    };
    walkSurfaces.push({ ring: stairRing, heightAt: stairsHeight, development: site.id });
    // Collision keeps the real solid wedge below every tread, including side
    // approaches. Clamp the height sample outside the footprint so a body whose
    // radius overlaps an edge still sees the nearest solid riser.
    Object.assign(
      collider(site, stairRing, stair.top, stair.bottom, (x, z) =>
        treadHeight(Math.max(stair.minV, Math.min(stair.maxV, bmoLocal(site, x, z)[1]))),
      ),
      { type: 'development-stair', storefrontAnchor: false },
    );
    localBox(30, 0.5, 6, 153.5, 11.15, 97, 'concrete', C.pale);
    const landingRing = localRing(rect(153.5, 97, 30, 6));
    walkSurfaces.push({ ring: landingRing, heightAt: () => 11.4, development: site.id });
    Object.assign(collider(site, landingRing, 11.4, 10.9), {
      type: 'development-landing',
      storefrontAnchor: false,
    });
    // Spirit of Water: original low-polygon interpretation, published 70-ft height.
    const art = point(34, 0.285, 126);
    const shaft = new THREE.CylinderGeometry(0.11, 0.42, site.artworkHeight, 9);
    shaft.translate(art[0], art[1] + site.artworkHeight / 2, art[2]);
    add(shaft, 'artwork');
    for (let k = 0; k < 17; k++) {
      const a = (k * Math.PI * 2) / 17,
        r = 3.5 + hash(k * 3) * 4.3,
        h = 2.0 + hash(k + 89) * 4.2;
      const base = [art[0] + Math.cos(a) * 0.5, art[1] + 0.1, art[2] + Math.sin(a) * 0.5];
      const tip = [art[0] + Math.cos(a) * r, art[1] + h, art[2] + Math.sin(a) * r];
      const side = [art[0] + Math.cos(a + 0.3) * r * 0.5, art[1] + 0.7, art[2] + Math.sin(a + 0.3) * r * 0.5];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...base, ...tip, ...side], 3));
      add(g, 'artwork', 0xffffff);
    }
    for (const [u, v] of [
      [-22, 120],
      [-16, 135],
      [9, 145],
      [53, 147],
      [74, 144],
      [92, 137],
      [163, 141],
    ]) {
      const p = point(u, 0.65, v);
      box(5, 0.7, 2.5, ...p, 'concrete', C.concrete, site.rotation);
      const trunk = point(u, 2.1, v),
        g = new THREE.CylinderGeometry(0.18, 0.24, 3, 6);
      g.translate(...trunk);
      add(g, 'dark', 0x655846);
      const foliage = new THREE.IcosahedronGeometry(2.3, 1);
      foliage.scale(0.9, 1.4, 0.9);
      foliage.translate(...point(u, 5, v));
      add(foliage, 'foliage', C.tree);
    }
    for (let u = -32; u < 170; u += 6) {
      const p = point(u, 0.8, 151.5);
      box(0.16, 1.05, 0.16, ...p, 'steel', 0x717573);
    }
    labels.push({
      name: 'BMO Centre · expanded 2024',
      x: site.anchor[0] + 50,
      z: site.anchor[1] + 20,
      height: 51,
    });
  }

  function buildScotia(site) {
    const plan = (x, y, h = 0) => {
      const p = scotiaPlanPoint(site, x, y);
      return [p[0], h, p[1]];
    };
    const ring = site.mainFootprintPixels.map(([x, y]) => scotiaPlanPoint(site, x, y));
    slab(site.footprint, 0.205, 0.29, 'ground', C.earth);
    slab(ring, 0.3, 1.15, 'concrete', C.concrete);
    // Ground-level concourse and a lower frame remain open, unlike a finished box.
    for (const y of [8.3, 16.2]) slab(ring, y, y + 0.45, 'concrete', C.concrete);
    collider(site, ring, 18);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let k = 0; k < Math.ceil(distance / 7.5); k++) {
        const t = k / Math.ceil(distance / 7.5),
          x = a[0] + (b[0] - a[0]) * t,
          z = a[1] + (b[1] - a[1]) * t;
        box(0.6, 17, 0.6, x, 8.8, z, 'concrete', 0x9b9b93);
      }
    }
    // Cauldron roof exterior: rounded quadrilateral, not the seating-bowl ellipse.
    const control = [
      [761, 415],
      [1112, 368],
      [1177, 401],
      [1205, 672],
      [1180, 744],
      [844, 801],
      [784, 770],
      [747, 478],
    ];
    const curve = new THREE.CatmullRomCurve3(
      control.map(([x, y]) => new THREE.Vector3(...plan(x, y, 32))),
      true,
      'centripetal',
    );
    const roof = curve
      .getPoints(80)
      .slice(0, -1)
      .map((p) => [p.x, p.z]);
    slab(roof, 31.65, site.roofHeight, 'steel', 0x767c79);
    collider(site, roof, site.roofHeight, 18);
    for (let i = 0; i < roof.length; i += 2) {
      const a = roof[i],
        b = roof[(i + 2) % roof.length];
      beam([a[0], 18.2, a[1]], [a[0], 31.7, a[1]], 0.24, 'steel', C.steel);
      beam([a[0], 31.4, a[1]], [b[0], 31.4, b[1]], 0.28, 'steel', C.steel);
      if (i % 4 === 0) beam([a[0], 18.2, a[1]], [b[0], 31.3, b[1]], 0.15, 'steel', C.steel);
      beam([a[0], 22.4, a[1]], [b[0], 22.4, b[1]], 0.18, 'steel', C.steel);
    }
    // Published 56 m / 12 m-deep main-truss dimensions. The roof deck is already
    // installed; only exposed ends/perimeter of this representative frame show.
    for (let k = 0; k < 10; k++) {
      const centre = plan(798 + k * 34, 560, 0),
        a = [centre[0], 19.5, centre[2] - 28],
        b = [centre[0], 19.5, centre[2] + 28];
      for (const y of [19.5, 31.5]) beam([a[0], y, a[2]], [b[0], y, b[2]], 0.28, 'steel', 0x626a6b);
      for (let j = 0; j < 7; j++) {
        const z = a[2] + j * 8;
        beam([a[0], 19.5, z], [a[0], 31.5, z + 8], 0.18, 'steel', 0x626a6b);
        beam([a[0], 31.5, z], [a[0], 19.5, z + 8], 0.15, 'steel', 0x626a6b);
      }
    }
    // A small run of the first copper cauldron fins, not a completed lit facade.
    for (let i = 0; i < 12; i++) {
      const t = 0.55 + i * 0.0028,
        p = curve.getPoint(t),
        q = curve.getPoint((t + 0.001) % 1),
        angle = Math.atan2(q.x - p.x, q.z - p.z);
      box(0.28, 11.5, 1.5, p.x, 25.7, p.z, 'copper', C.copperLight, angle);
      stats.scotiaFins++;
    }
    // East-side multilevel parkade is a construction frame, with no finished art.
    const parkade = [
      [1199, 435],
      [1293, 435],
      [1293, 744],
      [1204, 744],
    ].map((p) => scotiaPlanPoint(site, ...p));
    for (const y of [4.1, 8.2, 12.3]) slab(parkade, y, y + 0.32, 'concrete', 0x8e908a);
    for (const px of [1207, 1282])
      for (let py = 445; py < 744; py += 31) {
        const p = plan(px, py, 6.2);
        box(0.55, 12.1, 0.55, ...p, 'concrete', C.concrete);
      }
    // Community rink is below grade. At street level its planned public-plaza roof
    // is half covered. A dark construction opening represents the uncovered half;
    // there is deliberately no invented above-ground community-arena warehouse.
    const community = site.communityPixels.map((p) => scotiaPlanPoint(site, ...p));
    slab(community, 0.31, 0.33, 'dark', 0x273439);
    const half = [
      [1123, 789],
      [1190, 789],
      [1190, 870],
      [1123, 870],
    ].map((p) => scotiaPlanPoint(site, ...p));
    slab(half, 0.34, 0.56, 'concrete', C.concrete);
    for (let px = 1124; px < 1257; px += 12)
      beam(plan(px, 791, 0.48), plan(px, 868, 0.48), 0.16, 'steel', 0x9b9e97);
    // Southwest entry glass progressing; upper/lower surrounding faces stay open.
    const glassA = plan(792, 835, 0.5),
      glassB = plan(947, 812, 0.5);
    quad(glassA, glassB, [glassB[0], 9.6, glassB[2]], [glassA[0], 9.6, glassA[2]], 'glass', 0x40626c);
    for (let k = 0; k <= 12; k++) {
      const t = k / 12,
        x = glassA[0] + (glassB[0] - glassA[0]) * t,
        z = glassA[2] + (glassB[2] - glassA[2]) * t;
      beam([x, 0.4, z], [x, 9.8, z], 0.1, 'steel', 0x878e8c);
    }
    // Stephenson reassembly frame at its new north frontage. The dismantled old
    // historic building is not left standing at its obsolete 13 Avenue location.
    for (const px of [1038, 1062])
      for (const py of [340, 379]) beam(plan(px, py, 0.3), plan(px, py, 7.8), 0.18, 'steel', C.steel);
    for (const py of [340, 379]) beam(plan(1038, py, 7.8), plan(1062, py, 7.8), 0.18, 'steel', C.steel);
    fence(site, site.footprint);
    crane(...scotiaPlanPoint(site, 719, 340), 61, 0.4);
    crane(...scotiaPlanPoint(site, 1266, 815), 54, -1.1);
    // Materials, site cabins and deliveries on the still-unbuilt northeast parcel.
    for (let k = 0; k < 4; k++) {
      const p = plan(1164 + k * 28, 330, 1.65);
      box(7, 2.8, 3, ...p, 'dark', k % 2 ? 0x77847f : 0x4a6870, -0.045);
      for (let row = 0; row < 3; row++) {
        const q = plan(1165 + k * 28, 369 + row * 9, 0.5);
        box(5, 0.5, 1.3, ...q, 'steel', 0x8d8f8a, -0.045);
      }
    }
    labels.push({ name: 'Scotia Place · construction · opens fall 2027', x: 1404, z: 621, height: 46 });
    stats.constructionSites++;
  }

  function buildCleared(site) {
    slab(site.footprint, 0.205, 0.29, 'ground', 0x918d7e);
    // A cleared lot, rather than a fabricated future station or recreation design.
    const b = bounds(site.footprint);
    for (let z = b.minZ + 6; z < b.maxZ; z += 9) {
      const line = [];
      for (let x = b.minX + 3; x < b.maxX; x += 7) if (inside(x, z, site.footprint)) line.push([x, 0.301, z]);
      for (let k = 1; k < line.length; k++) beam(line[k - 1], line[k], 0.04, 'ground', 0x7c7b6b);
    }
    labels.push({
      name: 'Former Eau Claire Market · cleared 2025',
      x: (b.minX + b.maxX) / 2,
      z: (b.minZ + b.maxZ) / 2,
      height: 12,
    });
  }

  function buildOlympic(site) {
    slab(site.footprint, 0.205, 0.33, 'ground', C.earth);
    fence(site, site.footprint);
    const b = bounds(site.footprint);
    // A representative erection stage in the western theatre footprint. The exact
    // current height is not published, so the 22 m frame is marked approximate.
    const west = rect(829, -8, 40, 74);
    slab(west, 0.35, 1.2, 'concrete', C.concrete);
    for (const x of [811, 823, 835, 847])
      for (const z of [-42, -20, 2, 24]) {
        box(0.65, 21.6, 0.65, x, 11.9, z, 'concrete', 0x90928a);
        for (const y of [8, 15, 22.4]) beam([811, y, z], [847, y, z], 0.28, 'steel', C.steel);
        if (x === 811 || x === 847)
          for (const y of [8, 15, 22.4]) beam([x, y, -42], [x, y, 24], 0.28, 'steel', C.steel);
      }
    for (const z of [-42, 24]) {
      box(35, 12, 0.45, 829, 6.5, z, 'concrete', 0x93948d);
    }
    collider(site, west, 22.4);
    // New east pavilion foundations only; avoid the future completed green roof.
    for (const x of [932, 943]) beam([x, 0.6, -36], [x, 0.6, 24], 0.65, 'concrete', 0x9e9e94);
    for (const z of [-36, -14, 8, 24]) beam([931, 0.6, z], [944, 0.6, z], 0.65, 'concrete', 0x9e9e94);
    for (let k = 0; k < 6; k++)
      box(6, 0.35, 1.8, 883 + (k % 2) * 15, 0.54, -38 + Math.floor(k / 2) * 15, 'steel', 0x797f7e);
    crane(862, 25, 40, 0.35);
    labels.push({
      name: 'Werklund Centre / Olympic Plaza · construction',
      x: (b.minX + b.maxX) / 2,
      z: -5,
      height: 35,
    });
    stats.constructionSites++;
  }

  const walkSurfaces = [];
  for (const site of source.sites) {
    activeSite = site;
    activePlacement = groundPlacement?.site(site);
    const labelStart = labels.length;
    exclusions.push({
      name: site.name,
      names: site.excludeNames || [site.name],
      ring: site.footprint,
      development: site.id,
      preserveNames: site.preserveNames || [],
    });
    if (site.id === 'bmo-centre-2024') buildBmo(site);
    else if (site.id === 'scotia-place-construction') buildScotia(site);
    else if (site.id === 'eau-claire-cleared') buildCleared(site);
    else if (site.id === 'werklund-olympic') buildOlympic(site);
    if (groundPlacement)
      for (let k = labelStart; k < labels.length; k++) {
        labels[k].height += activePlacement.offsetM;
        labels[k].structureGround = activePlacement;
      }
  }
  if (groundPlacement) {
    for (const c of colliders)
      Object.assign(c, groundPlacement.placeCollider(c, groundPlacement.placementFor(c.development)));
    for (let k = 0; k < walkSurfaces.length; k++)
      walkSurfaces[k] = groundPlacement.placeWalkSurface(
        walkSurfaces[k],
        groundPlacement.placementFor(walkSurfaces[k].development),
      );
    groundPlacement.disposeSampling();
  }
  for (const [kind, geometries] of buckets) {
    let start = 0;
    const ranges =
      (groundPlacement || options.captureOwnership) &&
      geometries.map((g) => {
        const count = g.attributes.position.count,
          range = {
            start,
            count,
            placement: g.userData.structureGround,
            ownerId: g.userData.structureGround?.ownerId || g.userData.structureSourceId,
            role: g.userData.structureGroundRole,
          };
        start += count;
        return range;
      });
    const geometry = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!geometry) throw new Error(`Could not merge recent development ${kind}`);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const mesh = new THREE.Mesh(geometry, materials[kind]);
    mesh.name = `Recent Calgary developments / ${kind}`;
    mesh.castShadow = !materials[kind].userData.noShadow && !['ground', 'foliage'].includes(kind);
    mesh.receiveShadow = kind !== 'light';
    if (ranges) mesh.userData.structureGroundRanges = ranges;
    scene.add(mesh);
    meshes.push(mesh);
    stats.triangles += geometry.attributes.position.count / 3;
  }
  stats.drawCalls = meshes.length;
  stats.excludedBuildingIds = (data.buildings || [])
    .filter((b) => {
      const bb = bounds(b.ring),
        x = (bb.minX + bb.maxX) / 2,
        z = (bb.minZ + bb.maxZ) / 2;
      return exclusions.some(
        (e) =>
          inside(x, z, e.ring) &&
          !e.preserveNames.some((n) => n.toLowerCase() === (b.name || '').toLowerCase()),
      );
    })
    .map((b) => b.id);
  const sites = source.sites.map((site) => ({ site, box: bounds(site.footprint) }));
  let lastLight = -1,
    disposed = false;
  return {
    meshes,
    materials,
    exclusions,
    colliders,
    labels,
    stats,
    ...(groundPlacement ? { groundPlacement, walkSurfaces } : {}),
    // Parent can suppress stale parks, water/pool, procedural plants and furniture
    // inside these construction sites before those batches are generated.
    surfaceExclusions: source.sites
      .filter((s) => s.status !== 'completed')
      .map((s) => ({ id: s.id, ring: s.footprint })),
    transportExclusions: source.sites
      .filter((s) => s.id === 'scotia-place-construction')
      .map((s) => ({ id: s.id, ring: s.footprint })),
    surfaceHeight(x, z) {
      for (const surface of walkSurfaces) if (inside(x, z, surface.ring)) return surface.heightAt(x, z);
      return null;
    },
    update(elapsed = 0, night = 0, camera = null, quality = 'balanced') {
      if (disposed) return;
      const p = camera?.position || camera;
      let distance = 0;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z))
        distance = Math.min(
          ...sites.map(({ box: b }) =>
            Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minZ - p.z, 0, p.z - b.maxZ)),
          ),
        );
      const visible = distance < (quality === 'high' ? 2800 : 2100);
      for (const mesh of meshes) {
        mesh.visible = visible;
        mesh.castShadow =
          visible &&
          distance < 420 &&
          quality !== 'low' &&
          !mesh.material.userData.noShadow &&
          !/ground|foliage/.test(mesh.name);
      }
      // One gentle shared colour evolution for original canopy lighting, with no
      // per-pixel dynamic lights or rapid brightness modulation.
      const tick = Math.floor(elapsed * 10);
      if (tick !== lastLight) {
        materials.light.emissive.setHSL((0.075 + elapsed / 190) % 1, 0.55, 0.6);
        lastLight = tick;
      }
      materials.light.emissiveIntensity = Math.max(0, Math.min(1, night)) * 2.2;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
