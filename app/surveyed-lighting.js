import * as THREE from 'three/webgpu';
import { attribute, float, floor, mix, positionWorld, smoothstep, step, uniform, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SpatialIndex, bounds, inside, nearestOnSegment } from './geo.js';
import { windowGlow } from './city-uniforms.js';
import { hash2D } from './render-nodes.js';
import { unpackMapDataTransport } from './map-data-transport.js';

export const SURVEYED_LIGHTING_DATA_URL = new URL('../data/calgary-lighting.json', import.meta.url);
const EMPTY_MANIFEST = Object.freeze({ types: {}, records: [] });
export async function loadSurveyedLightingData() {
  const response = await fetch(SURVEYED_LIGHTING_DATA_URL);
  if (!response.ok) throw new Error(`City lighting data: HTTP ${response.status}`);
  const data = unpackMapDataTransport(await response.json());
  if (!Array.isArray(data.records) || !data.types) throw new Error('Invalid City lighting inventory');
  return data;
}
export const SURVEYED_LIGHTING_LIMITS = Object.freeze({
  low: Object.freeze({ heads: 80, radius: 300, altitude: 175 }),
  balanced: Object.freeze({ heads: 192, radius: 490, altitude: 275 }),
  high: Object.freeze({ heads: 320, radius: 630, altitude: 400 }),
  maxDraws: 9,
  pointLights: 0,
});

const POLE_TYPES = new Set(['cobrahead', 'high-mast', 'post', 'globe', 'acorn', 'bollard']);
// Match complete inventoried model numbers. Other shoeboxes and Galleons
// without a light-square count do not establish this housing configuration.
const GALLEON_HEADS = new Map([
  ['AE02LEDE1T2R', 'galleon-2'],
  ['GLEONAE02E1T3', 'galleon-2'],
  ['GLEONAE04LEDE1T3', 'galleon-4'],
]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finiteHeight = (value, fallback = 0.2) => (Number.isFinite(value) ? value : fallback);
const tempColor = (kelvin) => {
  // A restrained illustrative appearance, never manufacturer photometry.
  const tint = new THREE.Color();
  if (kelvin <= 2400) return tint.setHex(0xffb65f);
  if (kelvin <= 3000) return tint.setHex(0xffd5a4);
  if (kelvin <= 3500) return tint.setHex(0xffe6c7);
  if (kelvin <= 4000) return tint.setHex(0xf4f2e3);
  return tint.setHex(0xd8e8ff);
};

function decorate(geometry, color = 0x39423f, emission = 0) {
  geometry.deleteAttribute('uv');
  const n = geometry.attributes.position.count,
    colors = new Float32Array(n * 3),
    mask = new Float32Array(n),
    c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    c.toArray(colors, i * 3);
    mask[i] = emission;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('lampEmission', new THREE.BufferAttribute(mask, 1));
  return geometry;
}

function combined(parts) {
  const geometries = parts.map(({ geometry, color, emission = 0, position }) => {
    if (position) geometry.translate(...position);
    return decorate(geometry, color, emission);
  });
  const output = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  output.computeBoundingBox();
  output.computeBoundingSphere();
  return output;
}

/** Simplified authored fixture shapes; source inventory does not supply meshes. */
export function createLightingPrototypes() {
  const lathe = (points, segments = 10) =>
    new THREE.LatheGeometry(
      points.map((p) => new THREE.Vector2(...p)),
      segments,
    );
  const body = 0x35413e,
    top = 0x69726b,
    lens = 0xe1e6dd;
  const stem = decorate(new THREE.CylinderGeometry(0.72, 1, 1, 7).translate(0, 0.5, 0), body);
  const arm = decorate(new THREE.CylinderGeometry(0.8, 1, 1, 6), top);
  const cobra = combined([
    {
      geometry: lathe(
        [
          [0, -0.45],
          [0.65, -0.42],
          [1, -0.25],
          [1, 0.27],
          [0.65, 0.45],
          [0, 0.48],
        ],
        12,
      )
        .rotateX(Math.PI / 2)
        .scale(0.19, 0.085, 1),
      color: top,
    },
    {
      geometry: new THREE.BoxGeometry(0.245, 0.018, 0.51),
      position: [0, -0.075, 0.015],
      color: lens,
      emission: 1,
    },
    ...[-0.22, -0.1, 0.02, 0.14].map((z) => ({
      geometry: new THREE.BoxGeometry(0.27, 0.025, 0.025),
      position: [0, 0.077, z],
      color: body,
    })),
    { geometry: new THREE.BoxGeometry(0.12, 0.13, 0.18), position: [0, 0.015, -0.39], color: body },
  ]);
  // Legacy Galleon AE catalogue: 1–4 squares share a 394 × 553 × 100 mm case.
  // https://www.cooperlighting.com/api/assets/v1/file/CLS/content/a0016ce7e4d947ebbe7bad3f014c163f/McGraw-Edison-Galleon-LED-Brochure.pdf
  // Square spacing and finish remain inferred; no optional mount or sensor is
  // established by the inventory. Keep the existing inferred supports.
  const galleon = (squares) =>
    combined([
      {
        geometry: new THREE.BoxGeometry(0.394, 0.096, 0.553),
        position: [0, 0.002, 0],
        color: body,
      },
      ...Array.from({ length: squares }, (_, i) => ({
        geometry: new THREE.BoxGeometry(0.146, 0.004, 0.146),
        position: [i % 2 ? 0.09 : -0.09, -0.048, 0.17 - Math.floor(i / 2) * 0.17],
        color: lens,
        emission: 1,
      })),
    ]);
  const post = combined([
    {
      geometry: lathe(
        [
          [0, -0.22],
          [0.2, -0.2],
          [0.24, -0.12],
          [0.19, -0.04],
          [0.16, 0],
        ],
        12,
      ),
      color: body,
    },
    {
      geometry: lathe(
        [
          [0.16, 0],
          [0.23, 0.08],
          [0.28, 0.25],
          [0.25, 0.46],
          [0.13, 0.62],
          [0, 0.64],
        ],
        12,
      ),
      color: lens,
      emission: 1,
    },
    {
      geometry: lathe(
        [
          [0, 0.61],
          [0.12, 0.62],
          [0.26, 0.56],
          [0.3, 0.51],
          [0.29, 0.48],
        ],
        12,
      ),
      color: body,
    },
    { geometry: new THREE.SphereGeometry(0.055, 6, 4), position: [0, 0.68, 0], color: top },
    ...[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((a) => ({
      geometry: new THREE.CylinderGeometry(0.012, 0.012, 0.49, 4),
      position: [Math.sin(a) * 0.22, 0.25, Math.cos(a) * 0.22],
      color: body,
    })),
  ]);
  const globe = combined([
    { geometry: new THREE.CylinderGeometry(0.13, 0.2, 0.16, 10), position: [0, -0.05, 0], color: body },
    { geometry: new THREE.SphereGeometry(0.3, 12, 8), position: [0, 0.26, 0], color: lens, emission: 1 },
    { geometry: new THREE.CylinderGeometry(0.13, 0.1, 0.035, 8), position: [0, 0.55, 0], color: body },
  ]);
  const bar = combined([
    { geometry: new THREE.BoxGeometry(0.76, 0.11, 0.17), color: body },
    {
      geometry: new THREE.BoxGeometry(0.68, 0.015, 0.125),
      position: [0, -0.062, 0],
      color: lens,
      emission: 1,
    },
    ...[-0.31, 0.31].map((x) => ({
      geometry: new THREE.BoxGeometry(0.025, 0.13, 0.2),
      position: [x, 0, 0],
      color: top,
    })),
  ]);
  const ground = combined([
    { geometry: new THREE.CylinderGeometry(0.11, 0.11, 0.006, 10), color: top },
    {
      geometry: new THREE.CylinderGeometry(0.084, 0.084, 0.002, 10),
      position: [0, 0.004, 0],
      color: lens,
      emission: 1,
    },
  ]);
  return { stem, arm, cobra, 'galleon-2': galleon(2), 'galleon-4': galleon(4), post, globe, bar, ground };
}

function nearestWall(x, z, index, maxDistance = 4) {
  let best = null;
  for (const building of index?.near(x, z, maxDistance) || []) {
    if (building.storefrontAnchor === false || !building.ring || !(building.height > 2.5)) continue;
    const ring = building.ring;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const hit = nearestOnSegment(x, z, a, b);
      if (hit.distance > maxDistance || (best && hit.distance >= best.distance)) continue;
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz) || 1;
      let nx = -dz / length,
        nz = dx / length;
      if (inside(hit.x + nx * 0.2, hit.z + nz * 0.2, ring)) {
        nx = -nx;
        nz = -nz;
      }
      best = { ...hit, nx, nz, building };
    }
  }
  return best;
}

function inBuilding(x, z, index, baseY) {
  for (const b of index?.near(x, z) || []) {
    if (b.storefrontAnchor === false || !b.ring) continue;
    if (b.height < baseY + 0.2 || (b.minHeight || 0) > baseY + 2) continue;
    if (inside(x, z, b.ring)) return true;
  }
  return false;
}

/** Resolve mounting once. All invented dimensions stay labeled as inferred. */
export function prepareSurveyedLights(source = EMPTY_MANIFEST, options = {}) {
  const groundHeight = options.groundHeight || (() => 0.2),
    exclusions = options.siteExclusions || [],
    index = new SpatialIndex(48),
    coverage = new SpatialIndex(48),
    supportIndex = new SpatialIndex(1),
    supports = [],
    records = [],
    skipped = {},
    addSkip = (key) => {
      skipped[key] = (skipped[key] || 0) + 1;
    };
  const slabs = options.bridgeColliders?.slabs || [];
  const slabIndex = new SpatialIndex(48);
  for (const slab of slabs) slabIndex.insert(slab, bounds(slab.ring));
  for (const sourceRecord of source.records || []) {
    const type = source.types[sourceRecord.type];
    if (!type) {
      addSkip('unknown-source-type');
      continue;
    }
    const { x, z } = sourceRecord,
      category = type.category;
    if (!Number.isFinite(x + z)) {
      addSkip('invalid-coordinate');
      continue;
    }
    if (exclusions.some((e) => inside(x, z, e.ring || e.footprint || e))) {
      addSkip('current-construction-site');
      continue;
    }
    if (['feature', 'bridge-feature', 'unresolved'].includes(category)) {
      addSkip(category);
      continue;
    }
    const baseY = finiteHeight(groundHeight(x, z, sourceRecord.pathBridge ? undefined : 0.2));
    let y,
      heading = sourceRecord.heading || 0,
      kind = 'cobra',
      support;
    if (POLE_TYPES.has(category)) {
      const height =
        category === 'bollard'
          ? 1.05
          : category === 'high-mast'
            ? 16
            : category === 'cobrahead'
              ? (type.watts || 50) >= 150
                ? 10.5
                : 8.2
              : category === 'globe'
                ? 4.7
                : category === 'acorn'
                  ? 4.8
                  : /mini|walkway|greenway/i.test(type.description)
                    ? 4.2
                    : 5.5;
      const radius =
        category === 'high-mast'
          ? 0.17
          : category === 'bollard'
            ? 0.1
            : category === 'cobrahead'
              ? 0.1
              : 0.085;
      const armLength = category === 'cobrahead' ? 1.6 : 0;
      let sx = x - Math.sin(heading) * armLength,
        sz = z - Math.cos(heading) * armLength;
      let supportY = finiteHeight(groundHeight(sx, sz, sourceRecord.pathBridge ? undefined : 0.2), baseY);
      if (inBuilding(sx, sz, options.buildingIndex, supportY)) {
        // A public point may coincide with a roof or facade. Do not turn that
        // uncertainty into a pole through an occupied building.
        if (!inBuilding(x, z, options.buildingIndex, baseY)) {
          sx = x;
          sz = z;
          supportY = baseY;
        } else {
          addSkip('pole-base-inside-building');
          continue;
        }
      }
      if (options.deckConflictsWithSupport?.(sx, sz, supportY, supportY + height)) {
        // A point from the fixture inventory does not identify which deck it
        // belongs to. An inferred pole must not pierce an open travel lane.
        addSkip('pole-in-bridge-roadway');
        continue;
      }
      for (const candidate of supportIndex.near(x, z, 0.45))
        if (
          Math.hypot(candidate.sourceX - x, candidate.sourceZ - z) <= 0.45 &&
          Math.abs(candidate.baseY - supportY) < 0.35 &&
          Math.abs(candidate.profile.height - height) < 1
        ) {
          support = candidate;
          break;
        }
      if (!support) {
        support = {
          id: `support-${sourceRecord.id}`,
          sourceIds: [],
          sourceX: x,
          sourceZ: z,
          x: sx,
          z: sz,
          baseY: supportY,
          sourceBaseY: baseY,
          profile: { height, radius },
          inferred: true,
          storefrontAnchor: false,
        };
        supports.push(support);
        supportIndex.insert(support, { minX: x, maxX: x, minZ: z, maxZ: z });
      }
      support.sourceIds.push(sourceRecord.id);
      y = support.baseY + support.profile.height;
      kind =
        category === 'cobrahead' || category === 'high-mast'
          ? 'cobra'
          : category === 'globe'
            ? 'globe'
            : 'post';
      if (category === 'bollard') kind = 'bar';
      if (category === 'cobrahead') {
        const model = type.description
          ?.match(/\(([^)]+)\)/)?.[1]
          .replace(/[\s-]/g, '')
          .toUpperCase();
        kind = GALLEON_HEADS.get(model) || kind;
      }
    } else if (category === 'ground') {
      y = baseY;
      kind = 'ground';
    } else if (category === 'wall') {
      const wall = nearestWall(x, z, options.buildingIndex);
      if (!wall) {
        addSkip('wall-mount-not-resolved');
        continue;
      }
      y = baseY + Math.min(3.2, Math.max(1.9, wall.building.height - baseY - 0.5));
      heading = Math.atan2(wall.nx, wall.nz);
      kind = 'bar';
    } else if (category === 'underpass') {
      let ceiling = Infinity;
      for (const slab of slabIndex.near(x, z))
        if (inside(x, z, slab.ring)) {
          const below = slab.minHeightAt?.(x, z) ?? slab.minHeight;
          if (below > baseY + 1.9) ceiling = Math.min(ceiling, below);
        }
      for (const b of options.buildingIndex?.near(x, z) || [])
        if (b.ring && inside(x, z, b.ring)) {
          const below = b.minHeightAt?.(x, z) ?? b.minHeight;
          if (below > baseY + 1.9) ceiling = Math.min(ceiling, below);
        }
      if (!Number.isFinite(ceiling)) {
        addSkip('underpass-ceiling-not-resolved');
        continue;
      }
      y = ceiling - 0.09;
      kind = 'bar';
    } else {
      addSkip('unsupported-mount');
      continue;
    }
    const record = {
      ...sourceRecord,
      sourceX: x,
      sourceZ: z,
      category,
      kind,
      y,
      baseY: support?.baseY ?? baseY,
      heading,
      support,
      tint: tempColor(type.kelvin),
      inferredMount: true,
    };
    records.push(record);
    index.insert(record, { minX: x, maxX: x, minZ: z, maxZ: z });
    if (support) coverage.insert(record, { minX: x, maxX: x, minZ: z, maxZ: z });
  }
  // Multiple heads at one source coordinate are recorded individually. A single
  // shared support and small radial spread is an explicitly inferred layout.
  for (const support of supports) support.heads = [];
  for (const r of records) if (r.support) r.support.heads.push(r);
  for (const support of supports) {
    if (support.heads.length >= 2) {
      if (!inBuilding(support.sourceX, support.sourceZ, options.buildingIndex, support.sourceBaseY)) {
        support.x = support.sourceX;
        support.z = support.sourceZ;
        support.baseY = support.sourceBaseY;
      }
      for (const [i, r] of support.heads.entries()) {
        const angle = (i * Math.PI * 2) / support.heads.length + r.heading;
        r.x = support.sourceX + Math.sin(angle) * 0.72;
        r.z = support.sourceZ + Math.cos(angle) * 0.72;
        r.y = support.baseY + support.profile.height;
        r.baseY = support.baseY;
        r.heading = angle;
        r.inferredClusterOffset = 0.72;
      }
    }
    delete support.heads;
  }
  return {
    records,
    supports,
    index,
    skipped,
    covers(x, z, radius = 30) {
      if (!Number.isFinite(x + z + radius) || radius < 0) return false;
      for (const r of coverage.near(x, z, radius))
        if (Math.hypot(r.sourceX - x, r.sourceZ - z) <= radius) return true;
      return false;
    },
  };
}

/** Real inventory positions, inferred fixtures, one material, zero light objects. */
export function createSurveyedLighting(scene, options = {}) {
  const source = options.data || EMPTY_MANIFEST,
    prepared = prepareSurveyedLights(source, options),
    geometries = createLightingPrototypes(),
    mask = attribute('lampEmission'),
    tint = attribute('lampTint', 'vec3'),
    material = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.48 }),
    max = SURVEYED_LIGHTING_LIMITS.high.heads,
    meshes = {},
    matrix = new THREE.Matrix4(),
    quaternion = new THREE.Quaternion(),
    euler = new THREE.Euler(0, 0, 0, 'YXZ'),
    point = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    up = new THREE.Vector3(0, 1, 0),
    direction = new THREE.Vector3(),
    white = new THREE.Color(1, 1, 1),
    usedSupports = new Set();
  const view = uniform(new THREE.Vector3()),
    fadeEnd = uniform(300),
    fadeDistance = positionWorld.sub(view).length(),
    coverage = float(1).sub(smoothstep(fadeEnd.sub(75), fadeEnd, fadeDistance)),
    dither = hash2D(floor(positionWorld.xz.mul(18)).add(floor(positionWorld.y.mul(21))));
  material.alphaTest = 0.5;
  material.opacityNode = step(dither, coverage);
  // Explicit colour nodes keep metal neutral while instance colour tints only
  // the glass. windowGlow is shared with all building and bridge night lighting.
  material.colorNode = attribute('color').mul(mix(vec3(1), tint, mask));
  material.emissiveNode = tint.mul(mask).mul(windowGlow).mul(coverage).mul(4.2);
  for (const [kind, geometry] of Object.entries(geometries)) {
    const mesh = new THREE.InstancedMesh(geometry, material, kind === 'stem' ? max * 2 : max);
    mesh.name = `City surveyed lighting: ${kind}`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Custom instanced tint avoids Three's automatic instanceColor multiplication
    // colouring the metal too. Every batch has the same attributes at prewarm.
    geometry.setAttribute(
      'lampTint',
      new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3).fill(1), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    scene.add(mesh);
    meshes[kind] = mesh;
  }
  const stats = {
    sourceHeads: source.records.length,
    availableHeads: prepared.records.length,
    supports: prepared.supports.length,
    skipped: prepared.skipped,
    activeHeads: 0,
    activeSupports: 0,
    activeInstances: 0,
    activeTriangles: 0,
    draws: 0,
    maxDraws: Object.keys(meshes).length,
    pointLights: 0,
    materials: 1,
    runtimeTextures: 0,
    rebuilds: 0,
    headLimit: 0,
  };
  let disposed = false,
    lastX = Infinity,
    lastY = Infinity,
    lastZ = Infinity,
    lastQuality,
    colliderCache;
  const add = (kind, x, y, z, sx, sy, sz, heading = 0, tint = white, pitch = 0) => {
    const mesh = meshes[kind],
      slot = mesh.count;
    if (slot >= mesh.instanceMatrix.count) return;
    quaternion.setFromEuler(euler.set(pitch, heading, 0, 'YXZ'));
    matrix.compose(point.set(x, y, z), quaternion, scale.set(sx, sy, sz));
    mesh.setMatrixAt(slot, matrix);
    mesh.geometry.attributes.lampTint.setXYZ(slot, tint.r, tint.g, tint.b);
    mesh.count++;
  };
  const beam = (a, b, radius) => {
    const mesh = meshes.arm,
      slot = mesh.count;
    if (slot >= mesh.instanceMatrix.count) return;
    direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const length = direction.length();
    if (length < 0.01) return;
    quaternion.setFromUnitVectors(up, direction.multiplyScalar(1 / length));
    matrix.compose(
      point.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
      quaternion,
      scale.set(radius, length, radius),
    );
    mesh.setMatrixAt(slot, matrix);
    mesh.geometry.attributes.lampTint.setXYZ(slot, 1, 1, 1);
    mesh.count++;
  };
  function update(camera, quality = 'balanced') {
    if (disposed) return;
    const p = camera.position || camera,
      x = p.x ?? 0,
      y = p.y ?? 2,
      z = p.z ?? 0;
    if (!Number.isFinite(x + y + z)) return;
    view.value.set(x, y, z);
    // At rest this is only a few comparisons; no all-inventory scan, transforms,
    // sorting, geometry updates, material mutation or GPU uploads.
    if (lastQuality === quality && Math.hypot(x - lastX, z - lastZ) < 20 && Math.abs(y - lastY) < 12) return;
    lastX = x;
    lastY = y;
    lastZ = z;
    lastQuality = quality;
    const limits = SURVEYED_LIGHTING_LIMITS[quality] || SURVEYED_LIGHTING_LIMITS.balanced;
    stats.headLimit = limits.heads;
    stats.rebuilds++;
    for (const mesh of Object.values(meshes)) mesh.count = 0;
    usedSupports.clear();
    const candidates = [];
    for (const r of prepared.index.near(x, z, limits.radius + 65)) {
      const horizontal = Math.hypot(r.x - x, r.z - z),
        vertical = Math.abs(y - r.y);
      if (horizontal < limits.radius + 65 && vertical < limits.altitude)
        candidates.push({ r, distance: horizontal * horizontal + vertical * vertical });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    fadeEnd.value =
      candidates.length > limits.heads
        ? Math.min(limits.radius, Math.max(30, Math.sqrt(candidates[limits.heads - 1].distance) - 26))
        : limits.radius;
    for (const { r } of candidates.slice(0, limits.heads)) {
      const support = r.support;
      if (support && !usedSupports.has(support)) {
        usedSupports.add(support);
        const { x: bx, z: bz, baseY, profile } = support;
        add('stem', bx, baseY, bz, profile.radius, profile.height, profile.radius);
        add(
          'stem',
          bx,
          baseY,
          bz,
          profile.radius * 1.8,
          Math.min(0.3, profile.height * 0.07),
          profile.radius * 1.8,
        );
      }
      if (support && Math.hypot(r.x - support.x, r.z - support.z) > 0.16)
        beam(
          [support.x, r.y - 0.32, support.z],
          [r.x - Math.sin(r.heading) * 0.24, r.y + 0.015, r.z - Math.cos(r.heading) * 0.24],
          0.045,
        );
      if (r.kind === 'ground') add('ground', r.x, r.y, r.z, 1, 1, 1, r.heading, r.tint);
      else if (r.category === 'high-mast') add(r.kind, r.x, r.y, r.z, 1.35, 1.3, 1.1, r.heading, r.tint);
      else if (r.category === 'bollard') add(r.kind, r.x, r.y, r.z, 0.42, 0.65, 1, r.heading, r.tint);
      else
        add(
          r.kind,
          r.x,
          r.y,
          r.z,
          1,
          r.category === 'post' ? 0.8 : 1,
          1,
          r.heading,
          r.tint,
          r.category === 'wall' ? Math.PI / 2 : 0,
        );
    }
    stats.activeHeads = Math.min(candidates.length, limits.heads);
    stats.activeSupports = usedSupports.size;
    stats.activeInstances = 0;
    stats.activeTriangles = 0;
    stats.draws = 0;
    for (const mesh of Object.values(meshes)) {
      mesh.visible = mesh.count > 0;
      if (mesh.count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.lampTint.needsUpdate = true;
        stats.draws++;
        stats.activeInstances += mesh.count;
        stats.activeTriangles +=
          (mesh.count * (mesh.geometry.index?.count || mesh.geometry.attributes.position.count)) / 3;
      }
    }
  }
  return {
    ...prepared,
    meshes: Object.values(meshes),
    material,
    stats,
    get colliders() {
      // Consumers with a shared compact cylinder index should use supports.
      // Lazily retaining the legacy polygon contract avoids broadphase overhead.
      if (!colliderCache)
        colliderCache = prepared.supports.map((s) => ({
          id: s.id,
          type: 'surveyed-light-pole',
          storefrontAnchor: false,
          inferredShape: true,
          ring: Array.from({ length: 8 }, (_, i) => [
            s.x + Math.sin((i * Math.PI) / 4) * s.profile.radius,
            s.z + Math.cos((i * Math.PI) / 4) * s.profile.radius,
          ]),
          minHeight: s.baseY,
          height: s.baseY + s.profile.height,
        }));
      return colliderCache;
    },
    update,
    prewarm(camera, quality = 'balanced') {
      lastQuality = undefined;
      update(camera, quality);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of Object.values(meshes)) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.dispose();
      }
      material.dispose();
      colliderCache = undefined;
    },
  };
}
