import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SpatialIndex, bounds, inPolygon } from './geo.js';
import { createStreetDetailPrototypes } from './street-detail-models.js';
import { unpackMapDataTransport } from './map-data-transport.js';

export const STREET_DETAILS_DATA_URL = new URL('../data/calgary-street-details.json', import.meta.url);
const FAMILIES = ['hydrant', 'bollard', 'bollard-round', 'waste', 'waste-box', 'fountain'];
export const STREET_DETAIL_LIMITS = Object.freeze({
  low: Object.freeze({
    assets: 100,
    radius: 150,
    altitude: 110,
    fineRadius: 38,
    fineAssets: 28,
    planters: 12,
    triangles: 45000,
  }),
  balanced: Object.freeze({
    assets: 220,
    radius: 240,
    altitude: 180,
    fineRadius: 65,
    fineAssets: 72,
    planters: 28,
    triangles: 115000,
  }),
  high: Object.freeze({
    assets: 360,
    radius: 360,
    altitude: 280,
    fineRadius: 95,
    fineAssets: 128,
    planters: 48,
    triangles: 220000,
  }),
  maxDraws: FAMILIES.length * 2 + 1,
  maxMaterials: 1,
  maxPointLights: 0,
  maxTextures: 0,
  planterCache: 128,
  newPlanterModelsPerFrame: 4,
});
const EMPTY = Object.freeze({ records: [], beds: [], barriers: [] }),
  ACTIVE = new Set(['ACTIVE', 'INSTALLED']),
  aliasKind = (kind) => (kind === 'bin' ? 'waste' : kind),
  finite = (value, fallback = 0.2) => (Number.isFinite(value) ? value : fallback),
  boxAt = (x, z, r = 0) => ({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });

export async function loadStreetDetailsData() {
  const response = await fetch(STREET_DETAILS_DATA_URL);
  if (!response.ok) throw new Error(`City street assets: HTTP ${response.status}`);
  const data = unpackMapDataTransport(await response.json());
  if (!Array.isArray(data.records) || !Array.isArray(data.beds) || !data.meta?.completeBoundedSourceTransfer)
    throw new Error('Invalid or incomplete City street asset inventory');
  return data;
}

function buildingAt(x, z, height, ground, index) {
  for (const item of index?.near(x, z, 0.5) || []) {
    if (!item.ring || !inPolygon(x, z, item)) continue;
    const bottom =
        typeof item.minHeightAt === 'function' ? item.minHeightAt(x, z) : finite(item.minHeight, 0),
      top = typeof item.heightAt === 'function' ? item.heightAt(x, z) : item.height;
    if (Number.isFinite(top) && top > ground + 0.05 && bottom < ground + height) return true;
  }
  return false;
}
function pointProfile(record) {
  // The private feed's P/S code domain is not defined in its public schema.
  // Keep S rows as evidence rather than assume a freestanding three-port body.
  if (record.kind === 'hydrant' && record.owner === 'PRIV' && record.type === 'S') return null;
  if (record.kind === 'hydrant')
    return {
      family: 'hydrant',
      radius: 0.33,
      height: 0.94,
      sx: 1,
      sy: 1,
      sz: 1,
      tint: 0xffffff,
      collision: true,
    };
  if (record.kind === 'bollard') {
    // The HIL679 Kensington plaza row has dark round-capped posts in the
    // May 2022 Mapillary photos 5310582548999188 and 573421877833340.
    // Restrict that historical appearance to the observed row. Dimensions,
    // mounting and present-day finish remain inferred.
    const round =
      record.source === '8wgh-srzu' &&
      record.assetCode === 'HIL679' &&
      record.type === 'FIXED' &&
      record.material === 'METAL' &&
      record.x >= -1166.5 &&
      record.x <= -1140.5 &&
      record.z >= -737 &&
      record.z <= -735;
    return {
      family: round ? 'bollard-round' : 'bollard',
      radius: 0.11,
      height: 0.95,
      sx: 0.1,
      sy: 0.95,
      sz: 0.1,
      tint: round ? 0xffffff : record.material === 'TIMBER' ? 0xa8814b : 0x58645a,
      collision: true,
    };
  }
  if (record.kind === 'fountain') {
    if (record.type !== 'DRINKING FOUNTAIN' && record.type !== 'DOGGIE FOUNTAIN') return null;
    const dog = record.type === 'DOGGIE FOUNTAIN';
    return {
      family: 'fountain',
      radius: dog ? 0.31 : 0.23,
      height: dog ? 0.24 : 1,
      sx: dog ? 1.4 : 1,
      sy: dog ? 0.24 : 1,
      sz: dog ? 1.4 : 1,
      tint: 0xffffff,
      collision: true,
    };
  }
  if (record.kind === 'waste') {
    const box = !['DECORATIVE', 'LITTER BASKET'].includes(record.type),
      double = /DOUBLE|COMBO/.test(record.type),
      dumpster = /DUMPSTER/.test(record.type),
      sx = dumpster ? (record.type.includes('LARGE') ? 2.7 : 2) : double ? 1.8 : 1,
      sy = dumpster ? 1.2 : 1,
      sz = dumpster ? 1.4 : 1,
      recycle = /RECYCLE/.test(record.type) && !/COMBO/.test(record.type);
    return {
      family: box ? 'waste-box' : 'waste',
      radius: box ? Math.hypot(0.36 * sx, 0.39 * sz) : 0.36,
      height: 1.03 * sy,
      sx,
      sy,
      sz,
      tint: recycle ? 0x73a9ec : 0xd0d7cd,
      collision: true,
    };
  }
  return null;
}

/** Pure preparation preserves source coordinates; unsafe records are counted,
 * never pushed to a made-up sidewalk location. Ground callback must select the
 * underlying terrain/paving layer, not an overhead bridge or roof. */
export function prepareStreetDetails(data = EMPTY, options = {}) {
  const groundHeight = options.groundHeight || (() => 0.2),
    points = [],
    planters = [],
    skipped = [],
    counts = {},
    index = new SpatialIndex(40),
    planterIndex = new SpatialIndex(40),
    occupied = new SpatialIndex(2),
    siteMasks = options.siteExclusions || [],
    waters = options.waters || [],
    seatIndex = new SpatialIndex(8),
    waterIndex = new SpatialIndex(100),
    siteIndex = new SpatialIndex(100);
  for (const water of waters) if (water.ring) waterIndex.insert(water, bounds(water.ring));
  for (const site of siteMasks) if (site.ring) siteIndex.insert(site, bounds(site.ring));
  for (const seat of options.existingSeats || []) seatIndex.insert(seat, boxAt(seat.x, seat.z));
  const omit = (row, reason) => {
      skipped.push({ id: row.id, kind: row.kind, reason });
      counts[reason] = (counts[reason] || 0) + 1;
    },
    inSite = (x, z) => [...siteIndex.near(x, z)].some((p) => inPolygon(x, z, p)),
    inWater = options.inWater || ((x, z) => [...waterIndex.near(x, z)].some((p) => inPolygon(x, z, p))),
    safePoint = (x, z, radius, height, base, checkRoad = true) => {
      if (inSite(x, z)) return 'current-site-mask';
      if (inWater(x, z)) return 'mapped-water';
      if (buildingAt(x, z, height, base, options.buildingIndex)) return 'occupied-building';
      for (const seat of seatIndex.near(x, z, 1.2))
        if (Math.hypot(x - seat.x, z - seat.z) < radius + 0.45) return 'mapped-seating-conflict';
      const road = checkRoad ? options.roadIndex?.nearest(x, z, true, 28) : null;
      if (
        road &&
        !road.road.bridge &&
        road.road.kind !== 'service' &&
        road.distance < Math.max(0, road.width / 2 - 0.85)
      )
        return 'mapped-carriageway';
      return null;
    };
  for (const row of data.records || []) {
    if (!Number.isFinite(row.x) || !Number.isFinite(row.z)) {
      omit(row, 'invalid-position');
      continue;
    }
    if (row.status && !ACTIVE.has(row.status)) {
      omit(row, 'inactive-source');
      continue;
    }
    const profile = pointProfile(row);
    if (!profile) {
      omit(row, row.kind === 'hydrant' ? 'unresolved-private-hydrant-code' : 'unsupported-physical-type');
      continue;
    }
    const baseY = finite(groundHeight(row.x, row.z, 0.2));
    const conflict = safePoint(row.x, row.z, profile.radius, profile.height, baseY);
    if (conflict) {
      omit(row, conflict);
      continue;
    }
    const duplicate = [...occupied.near(row.x, row.z, 0.12)].find(
      (p) => p.kind === row.kind && p.type === row.type && Math.hypot(p.x - row.x, p.z - row.z) < 0.1,
    );
    if (duplicate) {
      omit(row, 'coincident-same-type');
      duplicate.sourceRefs.push(row.id);
      continue;
    }
    const road = options.roadIndex?.nearest(row.x, row.z, false, 35),
      dx = road ? road.x - row.x : 0,
      dz = road ? road.z - row.z : 1,
      heading = Math.atan2(dx, dz),
      item = {
        ...row,
        profile,
        baseY,
        y: baseY,
        heading,
        headingInferred: true,
        geometryInferred: true,
        finishInferred: true,
        mountingHeightInferred: true,
        sourceRefs: [row.id],
        storefrontAnchor: false,
      };
    points.push(item);
    index.insert(item, boxAt(item.x, item.z));
    occupied.insert(item, boxAt(item.x, item.z));
  }
  for (const row of data.beds || []) {
    // A VAULT is an at-grade tree pit, not a 45cm concrete container. Soil
    // cells/trenches and broad planting beds remain evidence-only data.
    const raised = row.type === 'PLANTER LOCATION',
      vault = row.type === 'VAULT';
    if ((!raised && !vault) || (row.status && !ACTIVE.has(row.status))) continue;
    if (row.attributeConflicts) {
      omit(row, 'conflicting-bed-source-attributes');
      continue;
    }
    for (let i = 0; i < (row.polygons || []).length; i++) {
      const polygon = row.polygons[i],
        bb = bounds(polygon.ring),
        x = (bb.minX + bb.maxX) / 2,
        z = (bb.minZ + bb.maxZ) / 2,
        part = {
          ...row,
          ...polygon,
          id: `${row.id}-part-${i}`,
          x,
          z,
          kind: raised ? 'planter' : 'tree-vault',
        };
      if (
        !Number.isFinite(x + z) ||
        row.area < 0.1 ||
        row.area > 60 ||
        Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) > 16
      ) {
        omit(part, 'large-or-degenerate-bed');
        continue;
      }
      if (polygon.ring.length > 150) {
        omit(part, 'complex-bed-footprint');
        continue;
      }
      const baseY = finite(groundHeight(x, z, 0.2)),
        height = raised ? 0.45 : 0.013,
        samples = [[x, z], ...polygon.ring],
        conflict = samples
          .map(([px, pz], j) => safePoint(px, pz, 0, height, finite(groundHeight(px, pz, 0.2)), j === 0))
          .find(Boolean);
      if (conflict) {
        omit(part, conflict);
        continue;
      }
      // Grates are permitted around surveyed trees; no extra tree or shrub is
      // authored at the centre of every vault.
      const item = {
        ...part,
        baseY,
        height,
        raised,
        grated: vault && row.grate === 'YES',
        heightInferred: true,
        materialInferred: true,
        storefrontAnchor: false,
      };
      planters.push(item);
      planterIndex.insert(item, bb);
    }
  }
  const colliders = points
      .filter((p) => p.profile.collision)
      .map((p) => ({
        id: p.id,
        x: p.x,
        z: p.z,
        baseY: p.baseY,
        profile: { radius: p.profile.radius, height: p.profile.height },
        storefrontAnchor: false,
      })),
    footprints = planters
      .filter((p) => p.raised)
      .map((p) => {
        const groundValues = p.ring.map(([x, z]) => finite(groundHeight(x, z, 0.2)));
        return {
          id: p.id,
          ring: p.ring,
          holes: p.holes,
          minHeight: Math.min(...groundValues),
          height: Math.max(...groundValues) + p.height,
          minHeightAt: (x, z) => finite(groundHeight(x, z, 0.2)),
          heightAt: (x, z) => finite(groundHeight(x, z, 0.2)) + p.height,
          storefrontAnchor: false,
          type: 'surveyed-planter',
        };
      });
  return {
    records: points,
    planters,
    index,
    planterIndex,
    colliders,
    footprints,
    skipped,
    stats: {
      sourcePoints: (data.records || []).length,
      retainedPoints: points.length,
      retainedByKind: Object.fromEntries(
        [...new Set(points.map((p) => p.kind))].map((kind) => [
          kind,
          points.filter((p) => p.kind === kind).length,
        ]),
      ),
      sourceBeds: (data.beds || []).length,
      retainedPlanters: planters.filter((p) => p.raised).length,
      retainedVaults: planters.filter((p) => !p.raised).length,
      sourceBarrierRecords: (data.barriers || []).length,
      colliders: colliders.length,
      footprints: footprints.length,
      skipped: counts,
    },
  };
}

function paint(geometry, tint) {
  geometry.deleteAttribute('uv');
  const colors = new Float32Array(geometry.attributes.position.count * 3),
    c = new THREE.Color(tint);
  for (let i = 0; i < geometry.attributes.position.count; i++) c.toArray(colors, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
function scanIntervals(polygon, z) {
  const xs = [];
  for (const ring of [polygon.ring, ...(polygon.holes || [])])
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1],
        b = ring[i];
      if (a[1] > z !== b[1] > z) xs.push(a[0] + ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]));
    }
  xs.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < xs.length; i += 2) if (xs[i] - xs[i - 1] > 0.02) intervals.push([xs[i - 1], xs[i]]);
  return intervals;
}
export function createPlanterGeometry(items, groundHeight = () => 0.2) {
  const parts = [];
  for (const item of items) {
    const shape = new THREE.Shape(item.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const hole of item.holes || [])
      shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
    const top = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
      p = top.attributes.position;
    for (let i = 0; i < p.count; i++)
      p.setY(i, finite(groundHeight(p.getX(i), p.getZ(i), 0.2)) + (item.raised ? item.height : 0.004));
    top.computeVertexNormals();
    parts.push(paint(top, item.raised ? 0x52462d : 0x413b2b));
    const positions = [],
      colors = [],
      tint = new THREE.Color(item.raised ? 0xb4b2a3 : 0x6a736a),
      triangle = (a, b, c) => {
        positions.push(...a, ...b, ...c);
        for (let i = 0; i < 3; i++) colors.push(tint.r, tint.g, tint.b);
      };
    for (const ring of [item.ring, ...(item.holes || [])])
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1],
          b = ring[i],
          ay = finite(groundHeight(...a, 0.2)),
          by = finite(groundHeight(...b, 0.2)),
          h = item.raised ? item.height : 0.013;
        const p0 = [a[0], ay + 0.01, a[1]],
          p1 = [b[0], by + 0.01, b[1]],
          p2 = [b[0], by + h, b[1]],
          p3 = [a[0], ay + h, a[1]];
        triangle(p0, p1, p2);
        triangle(p0, p2, p3);
        // Source ring winding is not a material/front-face claim. Both visible
        // wall sides share a tiny bounded ribbon, including hole boundaries.
        triangle(p2, p1, p0);
        triangle(p3, p2, p0);
        if (item.raised) {
          const dx = b[0] - a[0],
            dz = b[1] - a[1],
            length = Math.hypot(dx, dz);
          if (length > 0.001) {
            let nx = (-dz / length) * 0.035,
              nz = (dx / length) * 0.035;
            if (!inPolygon((a[0] + b[0]) / 2 + nx, (a[1] + b[1]) / 2 + nz, item)) {
              nx = -nx;
              nz = -nz;
            }
            const q0 = [a[0], ay + h + 0.004, a[1]],
              q1 = [b[0], by + h + 0.004, b[1]],
              q2 = [b[0] + nx, by + h + 0.004, b[1] + nz],
              q3 = [a[0] + nx, ay + h + 0.004, a[1] + nz];
            triangle(q0, q2, q1);
            triangle(q0, q3, q2);
            triangle(q1, q2, q0);
            triangle(q2, q3, q0);
          }
        }
      }
    const wall = new THREE.BufferGeometry();
    wall.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    wall.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    wall.computeVertexNormals();
    parts.push(wall);
    if (item.grated) {
      const bb = bounds(item.ring),
        linePositions = [],
        lineColors = [],
        grey = new THREE.Color(0x7d877b),
        add = (a, b, c) => {
          linePositions.push(...a, ...b, ...c);
          for (let i = 0; i < 3; i++) lineColors.push(grey.r, grey.g, grey.b);
        };
      for (let z = bb.minZ + 0.12; z < bb.maxZ; z += 0.18)
        for (const [a, b] of scanIntervals(item, z)) {
          const ya = finite(groundHeight(a, z, 0.2)) + 0.009,
            yb = finite(groundHeight(b, z, 0.2)) + 0.009,
            p0 = [a, ya, z - 0.011],
            p1 = [b, yb, z - 0.011],
            p2 = [b, yb, z + 0.011],
            p3 = [a, ya, z + 0.011];
          add(p0, p2, p1);
          add(p0, p3, p2);
        }
      const grate = new THREE.BufferGeometry();
      grate.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      grate.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
      grate.computeVertexNormals();
      parts.push(grate);
    }
  }
  if (!parts.length) return null;
  // ShapeGeometry is indexed while custom ribbons are not; keep one common
  // non-indexed attribute schema before merging into the shared material.
  const common = parts.map((g) => {
    const out = g.index ? g.toNonIndexed() : g;
    g.deleteAttribute('uv');
    out.deleteAttribute('uv');
    return out;
  });
  const merged = mergeGeometries(common, false);
  for (const g of new Set([...parts, ...common])) g.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function createStreetDetails(scene, options = {}) {
  const data = options.data || EMPTY,
    prepared = prepareStreetDetails(data, options),
    prototypes = createStreetDetailPrototypes(),
    material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.14 }),
    meshes = new Map(),
    keys = new Map(),
    dummy = new THREE.Object3D(),
    color = new THREE.Color(),
    max = STREET_DETAIL_LIMITS.high.assets,
    ground = options.groundHeight || (() => 0.2);
  for (const family of FAMILIES)
    for (const lod of ['fine', 'coarse']) {
      const key = `${family}-${lod}`,
        mesh = new THREE.InstancedMesh(prototypes[key], material, max);
      mesh.name = `City mapped ${family} / ${lod}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
      meshes.set(key, mesh);
    }
  let planterMesh = null,
    planterKey = '',
    previous = null,
    disposed = false,
    activePlanters = [],
    pointTriangles = 0,
    currentLimit = STREET_DETAIL_LIMITS.balanced;
  const planterCache = new Map();
  const stats = {
    ...prepared.stats,
    drawCalls: 0,
    maximumDrawCalls: STREET_DETAIL_LIMITS.maxDraws,
    materials: 1,
    textures: 0,
    pointLights: 0,
    liveAssets: 0,
    livePlanters: 0,
    liveTriangles: 0,
    selectionPasses: 0,
    instanceWrites: 0,
    geometryBuilds: 0,
    planterModelBuilds: 0,
    pendingPlanterModels: 0,
    planterCacheEntries: 0,
    prototypeTriangles: Object.fromEntries(
      Object.entries(prototypes).map(([key, g]) => [
        key,
        g.index ? g.index.count / 3 : g.attributes.position.count / 3,
      ]),
    ),
  };
  function updatePlanters(force = false) {
    let budget = force ? currentLimit.planters : STREET_DETAIL_LIMITS.newPlanterModelsPerFrame;
    for (const item of activePlanters)
      if (!planterCache.has(item.id) && budget > 0) {
        const geometry = createPlanterGeometry([item], ground);
        budget--;
        if (geometry) {
          planterCache.set(item.id, geometry);
          stats.planterModelBuilds++;
        }
      }
    const available = activePlanters.filter((item) => planterCache.has(item.id)),
      nextKey = available.map((i) => i.id).join('|');
    if (nextKey !== planterKey) {
      if (planterMesh) {
        scene.remove(planterMesh);
        planterMesh.geometry.dispose();
        planterMesh = null;
      }
      planterKey = nextKey;
      if (available.length) {
        const geometry = mergeGeometries(
          available.map((item) => planterCache.get(item.id)),
          false,
        );
        geometry.computeBoundingSphere();
        planterMesh = new THREE.Mesh(geometry, material);
        planterMesh.name = 'City actual planter / tree-vault footprints';
        planterMesh.castShadow = false;
        scene.add(planterMesh);
        stats.geometryBuilds++;
      }
    }
    const activeIds = new Set(activePlanters.map((item) => item.id));
    for (const [id, geometry] of planterCache) {
      if (planterCache.size <= STREET_DETAIL_LIMITS.planterCache) break;
      if (!activeIds.has(id)) {
        geometry.dispose();
        planterCache.delete(id);
      }
    }
    let triangles = pointTriangles;
    if (
      planterMesh &&
      triangles + planterMesh.geometry.attributes.position.count / 3 > currentLimit.triangles
    )
      planterMesh.visible = false;
    else if (planterMesh) {
      planterMesh.visible = true;
      triangles += planterMesh.geometry.attributes.position.count / 3;
    }
    stats.pendingPlanterModels = activePlanters.length - available.length;
    stats.planterCacheEntries = planterCache.size;
    stats.livePlanters = planterMesh?.visible ? available.length : 0;
    stats.liveTriangles = triangles;
    stats.drawCalls = [...meshes.values()].filter((m) => m.visible).length + (planterMesh?.visible ? 1 : 0);
  }
  function update(camera, quality = 'balanced', force = false) {
    if (disposed) return;
    const p = camera.position || camera,
      limit = STREET_DETAIL_LIMITS[quality] || STREET_DETAIL_LIMITS.balanced;
    if (
      !force &&
      previous &&
      previous.quality === quality &&
      Math.hypot(p.x - previous.x, p.z - previous.z) < 6 &&
      Math.abs((p.y || 0) - previous.y) < 4
    ) {
      if (stats.pendingPlanterModels) updatePlanters();
      return;
    }
    currentLimit = limit;
    previous = { x: p.x, y: p.y || 0, z: p.z, quality };
    stats.selectionPasses++;
    const candidates = [...prepared.index.near(p.x, p.z, limit.radius)]
        .map((item) => ({ item, distance: Math.hypot(item.x - p.x, item.z - p.z) }))
        .filter(
          ({ item, distance }) =>
            distance < limit.radius && Math.abs((p.y || 0) - item.baseY) < limit.altitude,
        )
        .sort((a, b) => a.distance - b.distance || a.item.id.localeCompare(b.item.id)),
      selected = new Map();
    let count = 0,
      fineCount = 0,
      triangles = 0;
    for (const { item, distance } of candidates) {
      if (count >= limit.assets) break;
      let lod = distance < limit.fineRadius && fineCount < limit.fineAssets ? 'fine' : 'coarse',
        key = `${item.profile.family}-${lod}`,
        cost = stats.prototypeTriangles[key];
      if (triangles + cost > limit.triangles && lod === 'fine') {
        lod = 'coarse';
        key = `${item.profile.family}-${lod}`;
        cost = stats.prototypeTriangles[key];
      }
      if (triangles + cost > limit.triangles) continue;
      if (!selected.has(key)) selected.set(key, []);
      selected.get(key).push(item);
      count++;
      triangles += cost;
      if (lod === 'fine') fineCount++;
    }
    for (const [key, mesh] of meshes) {
      const items = (selected.get(key) || []).sort((a, b) => a.id.localeCompare(b.id)),
        identity = items.map((i) => i.id).join('|');
      mesh.visible = items.length > 0;
      if (keys.get(key) === identity) continue;
      keys.set(key, identity);
      mesh.count = items.length;
      items.forEach((item, i) => {
        dummy.position.set(item.x, item.baseY, item.z);
        dummy.rotation.set(0, item.heading, 0);
        dummy.scale.set(item.profile.sx, item.profile.sy, item.profile.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setHex(item.profile.tint);
        mesh.setColorAt(i, color);
        stats.instanceWrites++;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    activePlanters = [...prepared.planterIndex.near(p.x, p.z, limit.radius)]
      .filter(
        (item) =>
          Math.hypot(item.x - p.x, item.z - p.z) < limit.radius &&
          Math.abs((p.y || 0) - item.baseY) < limit.altitude,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z) || a.id.localeCompare(b.id),
      )
      .slice(0, limit.planters)
      .sort((a, b) => a.id.localeCompare(b.id));
    stats.liveAssets = count;
    pointTriangles = triangles;
    updatePlanters(force);
  }
  return {
    records: prepared.records,
    planters: prepared.planters,
    colliders: prepared.colliders,
    footprints: prepared.footprints,
    skipped: prepared.skipped,
    stats,
    meshes,
    update,
    prewarm: (camera, quality) => update(camera, quality, true),
    covers(kind, x, z, radius = 10) {
      const wanted = aliasKind(kind);
      for (const p of prepared.index.near(x, z, radius))
        if (p.kind === wanted && Math.hypot(p.x - x, p.z - z) < radius) return true;
      return false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes.values()) {
        scene.remove(mesh);
        mesh.dispose();
      }
      if (planterMesh) {
        scene.remove(planterMesh);
        planterMesh.geometry.dispose();
      }
      for (const geometry of planterCache.values()) geometry.dispose();
      planterCache.clear();
      for (const geometry of Object.values(prototypes)) geometry.dispose();
      material.dispose();
    },
  };
}
