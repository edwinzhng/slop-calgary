import { createCityGroundProfile } from './city-ground-profile.js';
import * as THREE from 'three/webgpu';
import { bounds, SpatialIndex, inPolygon, roadWidth, DRIVABLE, makeRoadIndex, inside } from './geo.js';
import { createStaticPolygonQueries, containsPreparedPolygon } from './polygon-queries.js';
import { buildingMaterial, waterMaterial, surfaceMaterial, facadeMaterial } from './materials.js';
import {
  buildingProfile,
  decorateBuildingGeometry,
  buildRoofDetailGeometry,
  createCompactBuildingGeometry,
} from './building-models.js';
import { createDetailWorker } from './detail-worker.js';
import { buildLandmarks } from './landmarks.js';
import { addDevenishFrontage } from './devenish.js';
import { addIrwinBlockFrontage } from './irwin-block.js';
import { createRegionalGround } from './regional-horizon.js';
import {
  addArrisWest,
  addSuperstorePodium,
  splitSuperstorePodium,
  SUPERSTORE_PLACE_ID,
  SUPERSTORE_PODIUM_ID,
} from './east-village-podium.js';
import { createMemorialUnderpass } from './memorial-underpass.js';
import { addIslandPlanting } from './island-planting.js';
import { createVegetation } from './vegetation.js';
import { createGroundSurfaces } from './ground-surfaces.js';
import { createInfrastructureSurfaces, buildInfrastructure, isPeaceBridgeRoad } from './infrastructure.js';
import { footprintContact, movementBody } from './camera-collision.js';
import { buildRoadMarkings } from './road-markings.js';
import { createRailClearance, trimRailCollider, trimRailGeometry } from './rail-clearance.js';
import { createParks } from './parks.js';
import { buildWesternTowerLights } from './landmark-west.js';
import { coveredFallbacks, fallbackVolumeKey } from './building-ownership.js';
import { appendHillsideFootings, buildInferredFoundations } from './building-foundations.js';
import { buildRecentDevelopments } from './recent-developments.js';
import { createBridgeCollisionParts } from './bridge-collision.js';
import { createTreeCollision } from './tree-collision.js';
import { buildParkStructures } from './park-structures.js';
import { createSurveyedLighting } from './surveyed-lighting.js';
import { createStreetLightWash } from './street-light-wash.js';
import { createWalkingSupport } from './walk-support.js';
import { createParkArt } from './park-art.js';
import {
  addSeventeenthAvenueBanners,
  buildNeighborhoodDetails,
  enzoProfile,
  ev606Profile,
} from './neighborhood-details.js';
import { isMappedCrossing, roadSurfaceKind } from './road-attributes.js';
import { buildMappedCrossingMarkings } from './mapped-crossings.js';
import { createStreetDetails } from './street-details.js';
import parkLifeManifest from '../data/calgary-park-life.json' with { type: 'json' };
import { applyInfrastructureTerrain } from './crossing-surface-context.js';
import { validateBakedCrossings, createBakedCrossingMarkings } from './baked-crossings.js';
import {
  createNorthBowOverpass,
  buildNorthBowOverpass,
  attachNorthBowSurfaces,
} from './north-bow-overpass.js';
import { buildLandBridgeMeshes } from './land-bridge-meshes.js';
import { createPrinceArchModel, buildPrinceArch, attachPrinceArchSurfaces } from './prince-arch.js';
import { getSimmonsGroundCorrection } from './simmons-ground-correction.js';
import { prepareSunnysideBarrier, buildSunnysideBarrier } from './sunnyside-flood-barrier.js';
import { orientSurfaceUpward } from './surface-winding.js';
import { createBuildingGroundPlacement } from './building-ground.js';
import { createMappedBridgeSupport, mappedBridgeFootprintBlocked } from './mapped-bridge-support.js';
import { createFordCrossings, buildFordDetails } from './ford-crossings.js';
import {
  addStaticBatches,
  mergeStaticGeometries,
  setStaticBatchPartVisible,
  setStaticBatchPartShadowVisible,
} from './static-batches.js';
import { createLinearPolygonGeometry as flatGeometry } from './linear-polygon-geometry.js';
import { buildRiverbankRelief } from './riverbank-relief.js';

const standard = (color, roughness = 0.85) => new THREE.MeshStandardNodeMaterial({ color, roughness });
function shape(poly) {
  const s = new THREE.Shape(poly.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const ring of poly.holes || [])
    s.holes.push(new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}
export function createRoadRibbonGeometry(points, width, y = 0.12) {
  const p = new Float32Array(points.length * 6),
    IndexArray = points.length * 2 - 1 >= 65535 ? Uint32Array : Uint16Array,
    idx = new IndexArray(Math.max(0, points.length - 1) * 6);
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)],
      b = points[Math.min(points.length - 1, i + 1)],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      len = Math.hypot(dx, dz) || 1,
      py = typeof y === 'function' ? y(i / (points.length - 1), points[i], i) : y,
      at = i * 6;
    p[at] = points[i][0] - ((dz / len) * width) / 2;
    p[at + 1] = py;
    p[at + 2] = points[i][1] + ((dx / len) * width) / 2;
    p[at + 3] = points[i][0] + ((dz / len) * width) / 2;
    p[at + 4] = py;
    p[at + 5] = points[i][1] - ((dx / len) * width) / 2;
    if (i) {
      const j = i * 2,
        index = (i - 1) * 6;
      idx[index] = j - 2;
      idx[index + 1] = j;
      idx[index + 2] = j - 1;
      idx[index + 3] = j - 1;
      idx[index + 4] = j;
      idx[index + 5] = j + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

export function createJoinedRoadRibbon(points, width, heightAt) {
  const path = points.filter(
    (p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.0001,
  );
  if (path.length < 3) return createRoadRibbonGeometry(path, width, heightAt);
  const positions = [],
    indices = [],
    directions = [],
    half = width / 2;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0],
      dz = path[i][1] - path[i - 1][1],
      length = Math.hypot(dx, dz);
    directions.push({ x: dx / length, z: dz / length, length });
  }
  let previous;
  for (let i = 0; i < path.length; i++) {
    const [x, z] = path[i],
      y = heightAt(i / (path.length - 1), path[i], i),
      a = directions[Math.max(0, i - 1)],
      b = directions[Math.min(i, directions.length - 1)],
      dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)),
      turn = a.x * b.z - a.z * b.x,
      ratio = 1 + dot,
      ax = -(a.z + b.z) * half,
      az = (a.x + b.x) * half,
      travel = (half * Math.abs(turn)) / Math.max(ratio, 1e-7),
      limit = Math.min(a.length, b.length) * 0.43;
    const push = (dx, dz) => {
      const index = positions.length / 3;
      positions.push(x + dx, y, z + dz);
      return index;
    };
    let incoming, outgoing;
    if (ratio >= 0.78 && travel <= limit) {
      incoming = outgoing = [push(ax / ratio, az / ratio), push(-ax / ratio, -az / ratio)];
    } else {
      // A long miter on a tight bend can cross the next section and fold the
      // pavement back over itself. Keep full outside width and bevel the join.
      const side = turn < 0 ? -1 : 1;
      const factor = Math.min(1 / Math.max(ratio, 1e-7), limit / Math.max(half * Math.abs(turn), 1e-7), 1);
      const inner = push(side * ax * factor, side * az * factor);
      const outsideA = push(side * a.z * half, -side * a.x * half);
      const outsideB = push(side * b.z * half, -side * b.x * half);
      if (side === 1) {
        incoming = [inner, outsideA];
        outgoing = [inner, outsideB];
        indices.push(inner, outsideB, outsideA);
      } else {
        incoming = [outsideA, inner];
        outgoing = [outsideB, inner];
        indices.push(inner, outsideA, outsideB);
      }
    }
    if (previous) indices.push(previous[0], incoming[0], previous[1], previous[1], incoming[0], incoming[1]);
    previous = outgoing;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function fillRoadJunctions(nodes, add, drape) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let count = 0;
  for (const arms of nodes.values()) {
    if (arms.length < 2 || new Set(arms.map(({ road }) => road.id)).size < 2) continue;
    if (arms.some(({ y }) => Math.abs(y - arms[0].y) > 0.025)) continue;
    if (!arms.some(({ nx, nz }) => Math.abs(arms[0].nx * nz - arms[0].nz * nx) > 0.12)) continue;
    const points = arms.flatMap(({ p: [x, z], nx, nz, half }) => [
      [x + nx * half, z + nz * half],
      [x - nx * half, z - nz * half],
    ]);
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const hull = (sorted) => {
      const result = [];
      for (const p of sorted) {
        while (result.length > 1 && cross(result.at(-2), result.at(-1), p) <= 1e-8) result.pop();
        result.push(p);
      }
      return result.slice(0, -1);
    };
    const ring = [...hull(points), ...hull(points.slice().reverse())];
    if (ring.length < 3) continue;
    ring.push(ring[0]);
    const widest = arms.reduce((a, b) => (b.half > a.half ? b : a));
    const geometry = flatGeometry({ ring }, widest.y + 0.0015);
    geometry.deleteAttribute('uv');
    add(widest.road, drape(geometry));
    count++;
  }
  return count;
}
function densify(points, step = 8) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let j = 1; j <= n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return out;
}
function mergedMesh(scene, geos, mat, name, shadows = false, cellSize = 0) {
  if (!geos.length) return null;
  if (cellSize) {
    const cells = new Map(),
      preserveIndices = geos.every((geometry) => geometry.index !== null);
    for (const geometry of geos) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox,
        key = `${Math.floor((box.min.x + box.max.x) / 2 / cellSize)},${Math.floor((box.min.z + box.max.z) / 2 / cellSize)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(geometry);
    }
    const pieces = [];
    for (const geometries of cells.values()) {
      pieces.push(mergeStaticGeometries(geometries, { preserveIndices }));
      for (const geometry of geometries) geometry.dispose();
    }
    return addStaticBatches(scene, pieces, mat, name, shadows);
  }
  const g = mergeStaticGeometries(geos);
  geos.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = shadows;
  scene.add(mesh);
  // Merged world geometry already contains its final world-space placement.
  mesh.updateMatrixWorld(true);
  mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false;
  return mesh;
}

export async function buildWorld(scene, data, onProgress = () => {}, enrichment = {}) {
  const nativeProviders = [
    enrichment.buildingGround,
    enrichment.landmarkGround,
    enrichment.structureGround,
  ].filter(Boolean);
  if (new Set(nativeProviders).size > 1)
    throw new Error('Native attachment hooks must share one native ground provider');
  const nativeGround = nativeProviders[0];
  const terrain = enrichment.terrain;
  const terrainOffset = (x, z) => terrain?.offsetAt(x, z) || 0;
  const drape = (g) => terrain?.drapeGeometry(g) || g;
  const buildingGround = enrichment.buildingGround
    ? createBuildingGroundPlacement(enrichment.buildingGround)
    : terrain?.regionalOffsetAt
      ? createBuildingGroundPlacement(null, { reliefAt: terrain.regionalOffsetAt })
      : null;
  const buildMs = {};
  let phaseStart = performance.now();
  const phase = (name) => {
    const now = performance.now();
    buildMs[name] = Math.round((now - phaseStart) * 100) / 100;
    phaseStart = now;
  };
  const chunks = [],
    buildingIndex = new SpatialIndex(80),
    waterIndex = new SpatialIndex(180),
    waterQueries = createStaticPolygonQueries(),
    preparedWaters = new WeakMap();
  const windingRoads = new Map(),
    surfaceWinding = {
      repairedRoadTriangles: 0,
      repairedRiverBankTriangles: 0,
      repairedRailCorridorTriangles: 0,
    };
  await onProgress(0.22, 'Building Calgary landmarks');
  const landmark = buildLandmarks(scene, {
    cityMeshes: enrichment.cityMeshes,
    data,
    ...(enrichment.landmarkGround ? { ground: enrichment.landmarkGround } : {}),
  });
  const landmarkGround = landmark.groundPlacement;
  const developments = buildRecentDevelopments(
    scene,
    data,
    enrichment.structureGround ? { ground: enrichment.structureGround } : {},
  );
  landmark.exclusions.push(...developments.exclusions);
  landmark.colliders.push(...developments.colliders);
  landmark.labels.push(...developments.labels);
  phase('landmarks');
  const excludedInfrastructure = new Set(
    (enrichment.cityMeshes?.manifest.meta.infrastructureExclusions || [])
      .map((record) => record.buildingId)
      .filter(Boolean),
  );
  const metadata = new Map((enrichment.buildings || []).map((b) => [b.id, b]));
  const roadIndex = makeRoadIndex(data.roads);
  const underpass = createMemorialUnderpass(data, terrain);
  const groundMaterial = surfaceMaterial('ground');
  createRegionalGround(scene, data.meta.bbox, groundMaterial);
  terrain?.addGround?.(scene, groundMaterial, underpass?.cutSurface);
  for (const water of data.waters) {
    waterIndex.insert(water, bounds(water.ring));
    preparedWaters.set(water, waterQueries.preparePolygon(water));
  }
  const inWater = (x, z) => {
    for (const water of waterIndex.near(x, z))
      if (containsPreparedPolygon(x, z, water, preparedWaters.get(water))) return true;
    return false;
  };
  const fordCrossings = createFordCrossings(data.roads, enrichment.surfaceData || {}, {
    inWater,
    waterHeight: () => 0.075,
  });
  await onProgress(0.24, 'Laying surveyed sidewalks');
  const groundSurfaces = createGroundSurfaces(scene, enrichment.surfaceData || {}, {
    buildingIndex,
    roadIndex,
    inWater,
    terrain,
    cutSurface: underpass?.cutSurface,
    compactPavement: enrichment.touchGraphics,
    registerSurfaceGeometry: fordCrossings.registerSurfaceGeometry,
  });
  const northBowModel = createNorthBowOverpass(data, {
    roadIndex,
    groundHeightAt: (x, z) =>
      Math.max(0.14 + terrainOffset(x, z), groundSurfaces.groundHeight(x, z) ?? -Infinity),
  });
  const infrastructureSurfaces = createInfrastructureSurfaces(data, {
    terrain,
    roadIndex,
    inWater,
    bridgeConnections: northBowModel?.bridgeConnections,
    pathGroundHeight: (x, z) => 0.14 + terrainOffset(x, z),
  });
  applyInfrastructureTerrain(infrastructureSurfaces, terrain);
  attachNorthBowSurfaces(infrastructureSurfaces, northBowModel);
  const fordDetails = buildFordDetails(scene, fordCrossings, { terrain });
  landmark.colliders.push(...fordDetails.colliders);
  const parkStructures = buildParkStructures(scene, {
    cityMeshes: enrichment.cityMeshes,
    data,
    groundHeight: (x, z) =>
      infrastructureSurfaces.groundHeight(x, z) ??
      groundSurfaces.groundHeight(x, z) ??
      0.2 + terrainOffset(x, z),
    ...(enrichment.structureGround
      ? {
          ground: enrichment.structureGround,
          surfaceData: enrichment.surfaceData,
          parkData: enrichment.parkData,
        }
      : {}),
  });
  landmark.colliders.push(...parkStructures.colliders);
  landmark.labels.push(...parkStructures.labels);
  mergedMesh(
    scene,
    data.waters.map((w) => flatGeometry(w, 0.075)),
    waterMaterial(enrichment.touchGraphics),
    'Bow and Elbow rivers',
  );
  const parks = enrichment.parkData
    ? createParks(scene, enrichment.parkData, { terrain, cutSurface: underpass?.cutSurface })
    : null;
  for (const part of underpass?.addStructure(scene) || []) buildingIndex.insert(part, bounds(part.ring));
  const neighborhoods = buildNeighborhoodDetails(scene, {
    data,
    parkData: enrichment.parkData,
    cityMeshes: enrichment.cityMeshes,
    inWater,
    paved: (x, z) => parks?.groundHeight(x, z, true) != null || groundSurfaces.groundHeight(x, z) != null,
    groundHeight: (x, z) =>
      groundSurfaces.groundHeight(x, z) ?? parks?.groundHeight(x, z) ?? 0.14 + terrainOffset(x, z),
    turfHeight: (x, z) =>
      parks?.groundHeight(x, z) != null && parks.groundHeight(x, z, true) == null
        ? parks.groundHeight(x, z)
        : null,
  });
  const authoredStorefrontPlaceIds = new Set();
  landmark.colliders.push(...neighborhoods.colliders);
  landmark.labels.push(...neighborhoods.labels);
  const northBowOverpass = northBowModel ? buildNorthBowOverpass(scene, northBowModel) : null;
  const princeArchModel = createPrinceArchModel(data, {
    terrain,
    groundHeightAt: (x, z) =>
      Math.max(0.14 + terrainOffset(x, z), groundSurfaces.groundHeight(x, z) ?? -Infinity),
  });
  attachPrinceArchSurfaces(infrastructureSurfaces, princeArchModel);
  const princeArch = princeArchModel.ready ? buildPrinceArch(scene, princeArchModel) : null;
  const parkArt = createParkArt(scene, {
    inWater,
    siteExclusions: developments.surfaceExclusions,
    groundHeight: (x, z, hint) => {
      const bridge = infrastructureSurfaces.groundHeight(x, z, hint);
      if (bridge != null) return bridge;
      const pavement = groundSurfaces.groundHeight(x, z),
        park = parks?.groundHeight(x, z);
      return pavement != null || park != null
        ? Math.max(pavement ?? -Infinity, park ?? -Infinity)
        : 0.2 + terrainOffset(x, z);
    },
  });
  landmark.colliders.push(...parkArt.colliders);
  landmark.labels.push(...parkArt.labels);
  if (!parks)
    mergedMesh(
      scene,
      data.parks.map((p) => drape(flatGeometry(p, 0.045))),
      surfaceMaterial('grass'),
      'Calgary parks',
    );
  // Broad, subdued banks define the turquoise waterways while retaining polygon islands.
  const bank = [];
  const riverbank = buildRiverbankRelief(scene, data.waters);
  for (const w of data.waters)
    for (const ring of [w.ring, ...(w.holes || [])]) {
      const geometry = createRoadRibbonGeometry(ring, 5, (_t, point) =>
        riverbank.replacesEdge(w.id, point) ? 0.072 : 0.09,
      );
      const position = geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        if (!inPolygon(position.getX(i), position.getZ(i), w)) continue;
        const [x, z] = ring[Math.floor(i / 2)];
        position.setXYZ(i, x, position.getY(i), z);
      }
      geometry.computeVertexNormals();
      surfaceWinding.repairedRiverBankTriangles += orientSurfaceUpward(geometry);
      bank.push(geometry);
    }
  mergedMesh(scene, bank, standard(0xb2b29a), 'River banks');
  await onProgress(0.25, 'Laying streets and river crossings');
  const mappedBridgeSupport = createMappedBridgeSupport(data.roads, {
    ownsRenderedRoad: (r) =>
      infrastructureSurfaces.ownsRoad(r) || isPeaceBridgeRoad(r) || isMappedCrossing(r),
    inWater,
    surfaceHeight: (x, z, r) => infrastructureSurfaces.surfaceHeight(x, z, r),
    pavingHeight: (x, z) => {
      const a = groundSurfaces.groundHeight(x, z),
        b = parks?.groundHeight(x, z, true);
      return a != null || b != null ? Math.max(a ?? -Infinity, b ?? -Infinity) : null;
    },
  });
  const roadMaterialGroups = new Map(),
    roadJunctions = new Map(),
    paintSurfaces = new Map();
  const addRoadGeometry = (road, geometry) => {
    const repairs = orientSurfaceUpward(geometry);
    surfaceWinding.repairedRoadTriangles += repairs;
    if (repairs) windingRoads.set(road.id, (windingRoads.get(road.id) || 0) + repairs);
    mappedBridgeSupport.registerGeometry(road, geometry);
    if (
      terrain?.regionalOffsetAt &&
      (infrastructureSurfaces.hasRoadApproach(road) || underpass?.owners.has(road.id))
    ) {
      if (!paintSurfaces.has(road.id)) paintSurfaces.set(road.id, []);
      paintSurfaces.get(road.id).push(geometry);
    }
    const finish = roadSurfaceKind(road);
    const material = finish === 'asphalt' && !DRIVABLE.has(road.kind) ? 'path-asphalt' : finish;
    if (!roadMaterialGroups.has(material)) roadMaterialGroups.set(material, []);
    roadMaterialGroups.get(material).push(geometry);
  };
  for (const r of data.roads) {
    if (
      (r.tunnel && !underpass?.allows(r)) ||
      r.kind === 'corridor' ||
      isMappedCrossing(r) ||
      r.points.length < 2 ||
      infrastructureSurfaces.ownsRoad(r) ||
      isPeaceBridgeRoad(r)
    )
      continue;
    const drive = DRIVABLE.has(r.kind),
      w = roadWidth(r);
    // Raised branch ramps own their exact profiles and cut endpoints. Render
    // only the source path remainder here, including any ordinary flat tail.
    let sourceRuns = (northBowModel?.unownedRuns(r) ?? [r.points]).flatMap(
      (points) => infrastructureSurfaces.accessBranches?.unownedRuns({ ...r, points }) ?? [points],
    );
    const landing = infrastructureSurfaces.peace.southLanding;
    if (!drive && !r.bridge && !r.tunnel && landing) sourceRuns = sourceRuns.flatMap(landing.outsideRuns);
    for (const sourceRun of sourceRuns) {
      const overTerrain = terrain && sourceRun.some(([x, z]) => terrain.contains(x, z));
      const bowPath = r.id === 'osm-way-180764948-0' && r.kind === 'cycleway';
      const raisedApproach = drive && infrastructureSurfaces.hasRoadApproach(r),
        tunnelApproach = underpass?.owners.has(r.id);
      const points = densify(
        sourceRun,
        raisedApproach || tunnelApproach || (!drive && (overTerrain || bowPath)) ? 3 : 8,
      );
      const level = (_t, p) => {
        const base = infrastructureSurfaces.surfaceHeight(p[0], p[1], r);
        // An explicit finish on a sidewalk/path should remain visible on top
        // of the older generic pavement classification, without lifting roads.
        if (drive || !r.surface || r.bridge) return base;
        const pavement = groundSurfaces.groundHeight(...p);
        return pavement == null ? base : Math.max(base, pavement + 0.012);
      };
      if (!drive && (overTerrain || bowPath)) {
        // Actual surveyed paving owns its shape/width. A second centreline ribbon
        // can intersect it after independent terrain triangulation and flash.
        let run = [];
        const flush = () => {
          if (run.length > 1)
            addRoadGeometry(
              r,
              drape(createRoadRibbonGeometry(run, w, (_t, p) => level(_t, p) - terrainOffset(...p))),
            );
          run = [];
        };
        const paved = (x, z) =>
          bowPath
            ? groundSurfaces.groundHeight(x, z, 'Pathways') != null
            : (!r.surface || roadSurfaceKind(r) === 'concrete') &&
              (groundSurfaces.groundHeight(x, z) != null || parks?.groundHeight(x, z, true) != null);
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1],
            b = points[i];
          if (paved(...a) && paved(...b) && paved((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) {
            flush();
            continue;
          }
          if (!run.length) run.push(a);
          run.push(b);
        }
        flush();
        continue;
      }
      // The ribbon centreline already shares the navigation height. Drape its
      // width as well, without applying the centreline elevation twice.
      const ribbon = drive ? createJoinedRoadRibbon : createRoadRibbonGeometry;
      const g = ribbon(points, w, (_t, p) => level(_t, p) - terrainOffset(...p));
      const rendered = drape(g);
      if (tunnelApproach) {
        const positions = rendered.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          const y = underpass.heightAt(positions.getX(i), positions.getZ(i), r);
          if (y != null) positions.setY(i, y);
        }
        rendered.computeVertexNormals();
      }
      addRoadGeometry(r, rendered);
      if (drive && !r.bridge && sourceRun.length > 1) {
        for (const [p, q] of [
          [sourceRun[0], sourceRun[1]],
          [sourceRun.at(-1), sourceRun.at(-2)],
        ]) {
          const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const y = level(0, p) - terrainOffset(...p);
          if (length < 0.01 || (y > 0.5 && !raisedApproach)) continue;
          const key = `${p[0]}:${p[1]}:${r.layer ?? 0}:${roadSurfaceKind(r)}`;
          if (!roadJunctions.has(key)) roadJunctions.set(key, []);
          roadJunctions
            .get(key)
            .push({ road: r, p, y, half: w / 2, nx: (p[1] - q[1]) / length, nz: (q[0] - p[0]) / length });
        }
      }
    }
  }
  surfaceWinding.filledRoadJunctions = fillRoadJunctions(roadJunctions, addRoadGeometry, drape);
  for (const [material, geometries] of roadMaterialGroups)
    mergedMesh(
      scene,
      geometries,
      surfaceMaterial(material, enrichment.touchGraphics),
      `Mapped Calgary street/path surface: ${material}`,
      false,
      1000,
    );
  const roadMarkings = buildRoadMarkings(scene, data.roads, infrastructureSurfaces, {
    terrain,
    renderedRoads: paintSurfaces,
  });
  paintSurfaces.clear();
  phase('surfacesRoadsParks');
  const bakedCrossings = await validateBakedCrossings(enrichment.bakedCrossings, {
    data,
    surfaceData: enrichment.surfaceData || {},
    terrain,
  });
  const mappedCrossings = bakedCrossings.ok
    ? createBakedCrossingMarkings(scene, data.roads, bakedCrossings)
    : buildMappedCrossingMarkings(scene, data.roads, {
        surfaces: infrastructureSurfaces,
        groundSurfaces,
        terrain,
        roadIndex,
      });
  const railGeo = [];
  for (const r of data.rails) {
    if (r.tunnel || infrastructureSurfaces.ownsRoad(r)) continue;
    const points = terrain?.regionalOffsetAt ? densify(r.points, 8) : r.points;
    const geometry = drape(
      createRoadRibbonGeometry(
        points,
        3.4,
        (_t, point) => infrastructureSurfaces.surfaceHeight(...point, r) - terrainOffset(...point),
      ),
    );
    surfaceWinding.repairedRailCorridorTriangles += orientSurfaceUpward(geometry);
    railGeo.push(geometry);
  }
  mergedMesh(scene, railGeo, surfaceMaterial('rail'), 'Rail and CTrain corridors', false, 1000);
  phase('mappedCrossings');
  await onProgress(0.4, 'Raising the Calgary skyline');
  const groups = new Map();
  const railClearance = createRailClearance(
    infrastructureSurfaces.railIndex,
    infrastructureSurfaces.surfaceHeight,
  );
  const railBuildingCuts = { meshes: 0, colliders: 0 };
  const fallbackVolumes = new Set(),
    partialCompoundsRendered = new Set();
  let count = 0,
    measured = 0,
    meshCount = 0,
    removedDuplicates = 0,
    exactFallbackDuplicatesRemoved = 0,
    sourceBuildingSuppressions = 0;
  const openGroundCorrections = new Map();
  const sunnysidePlan = prepareSunnysideBarrier(data, enrichment);
  for (const b of data.buildings) {
    const correction = getSimmonsGroundCorrection(b, enrichment.surfaceData);
    if (
      correction &&
      !ev606Profile(b) &&
      !enrichment.cityMeshes?.has(b.id) &&
      !enrichment.cityMeshes?.get(b.id) &&
      !enrichment.fallbackBuildings?.hasGeometry(b.id) &&
      !enrichment.haydenBlock?.hasGeometry(b.id) &&
      !enrichment.partialBuildings?.hasGeometry(b.id) &&
      !enrichment.measuredRoofs?.get(b.id)
    )
      openGroundCorrections.set(b.id, correction);
  }
  // Preserve the source record and all existing municipal paving. This exact
  // evidence gate removes only an unsupported synthetic body and its collider;
  // any real body/roof provider or source drift keeps ordinary ownership.
  const sourceSuppressed = (b) =>
    openGroundCorrections.has(b.id) ||
    (sunnysidePlan.accepted && b.id === sunnysidePlan.building.id) ||
    (!enrichment.cityMeshes?.has(b.id) && enrichment.fallbackBuildings?.isSuppressed?.(b.id));
  const isLandmark = (b, cx, cz) =>
    landmark.exclusions.some((e) => {
      if (e.preserveNames?.some((n) => n.toLowerCase() === (b.name || '').toLowerCase())) return false;
      const names = e.names || [e.name];
      if (b.name && names.some((n) => n && n.toLowerCase() === b.name.toLowerCase())) return true;
      return e.ring ? inside(cx, cz, e.ring) : Math.hypot(cx - e.x, cz - e.z) < e.radius;
    });
  const renderedModels = new Set([...landmark.measuredLandmarks, ...parkStructures.replacedBuildingIds]);
  for (const b of data.buildings) {
    if (
      sourceSuppressed(b) ||
      (!enrichment.cityMeshes?.has(b.id) &&
        !enrichment.fallbackBuildings?.hasGeometry(b.id) &&
        !enrichment.haydenBlock?.hasGeometry(b.id) &&
        !enrichment.partialBuildings?.hasGeometry(b.id)) ||
      b.kind === 'bridge'
    )
      continue;
    const bb = bounds(b.ring);
    if (!isLandmark(b, (bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2)) renderedModels.add(b.id);
  }
  const duplicates = coveredFallbacks(enrichment.cityMeshes?.manifest.meta, renderedModels);
  for (const id of enrichment.fallbackBuildings?.coveredFallbacks(renderedModels) || []) duplicates.add(id);
  const ownershipProofs = new Map(
    [
      ...(enrichment.cityMeshes?.manifest.meta.coveredFallbacks || []),
      ...(enrichment.cityMeshes?.manifest.meta.ownershipAudit?.partialFallbacks || []),
      ...(enrichment.fallbackBuildings?.ownershipProofs.values() || []),
    ].map((proof) => [proof.id, proof]),
  );
  const buildingById = buildingGround && new Map(data.buildings.map((b) => [b.id, b]));
  const coveredOwnerFor = (id) => {
    const provider = enrichment.cityMeshes?.has(id)
      ? enrichment.cityMeshes
      : enrichment.fallbackBuildings?.recovered;
    const building = buildingById.get(id),
      box = building && bounds(building.ring),
      separateStructure =
        building &&
        (parkStructures.replacedBuildingIds.has(id) ||
          isLandmark(building, (box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2));
    return {
      building,
      record: provider?.get(id),
      provider,
      ...(separateStructure
        ? {
            placement: landmarkGround?.placementFor(id) ||
              parkStructures.groundPlacement?.placementFor(id) || {
                offsetM: 0,
                method: 'unchanged-separate-structure-scope',
              },
          }
        : {}),
    };
  };
  for (const b of data.buildings) {
    if (sourceSuppressed(b)) {
      sourceBuildingSuppressions++;
      continue;
    }
    if (b.kind === 'bridge' || (excludedInfrastructure.has(b.id) && !enrichment.cityMeshes?.has(b.id)))
      continue;
    const box = bounds(b.ring),
      cx = (box.minX + box.maxX) / 2,
      cz = (box.minZ + box.maxZ) / 2;
    if (isLandmark(b, cx, cz) || parkStructures.replacedBuildingIds.has(b.id)) continue;
    const primaryRecord = enrichment.cityMeshes?.get(b.id);
    const fittedRoof =
      !primaryRecord &&
      !enrichment.fallbackBuildings?.hasGeometry(b.id) &&
      !enrichment.haydenBlock?.hasGeometry(b.id) &&
      !enrichment.partialBuildings?.hasGeometry(b.id)
        ? enrichment.measuredRoofs?.get(b.id)
        : null;
    const supplementalRecord = primaryRecord
      ? null
      : enrichment.haydenBlock?.get(b.id) ||
        enrichment.partialBuildings?.get(b.id) ||
        fittedRoof ||
        enrichment.fallbackBuildings?.get(b.id);
    const geometrySource = primaryRecord
      ? enrichment.cityMeshes
      : enrichment.haydenBlock?.hasGeometry(b.id)
        ? enrichment.haydenBlock
        : enrichment.partialBuildings?.hasGeometry(b.id)
          ? enrichment.partialBuildings
          : enrichment.fallbackBuildings?.hasGeometry(b.id)
            ? enrichment.fallbackBuildings
            : fittedRoof
              ? enrichment.measuredRoofs
              : null;
    // A recovered surveyed compound also supersedes older mapped part volumes
    // on its proven companions. Its owner must be active before this can apply.
    const covered = !primaryRecord && duplicates.has(b.id);
    const meshRecord = covered ? null : geometrySource?.get(b.id);
    const proof = covered ? ownershipProofs.get(b.id) : null;
    const compactHeight = enrichment.cityMeshes?.compactHeight?.(b.id);
    const sourceHeight =
      proof?.occupiedHeightMax ?? meshRecord?.height ?? supplementalRecord?.height ?? compactHeight;
    const ev606 = !sourceHeight && ev606Profile(b);
    const infill = ev606 || (!sourceHeight && enzoProfile(b));
    const height = sourceHeight ?? (infill ? infill.height : Math.max(2.8, Math.min(300, b.height)));
    const placement =
      buildingGround && !covered
        ? buildingGround.attach(
            b,
            meshRecord || supplementalRecord,
            geometrySource || enrichment.fallbackBuildings,
          )
        : null;
    if (ev606)
      landmark.labels.push({ name: 'EV606', x: cx, z: cz, height: height + 4 + (placement?.offsetM || 0) });
    const placeCollider = (part) =>
      placement
        ? buildingGround.placeCollider(part, placement)
        : covered && buildingGround
          ? buildingGround.coveredCollider(part, proof, coveredOwnerFor)
          : part;
    const insertCollider = (part) => {
      const partBox = bounds(part.ring);
      const cuts = railClearance.find(b, partBox, part.minHeight, part.height);
      const sections = trimRailCollider(part, cuts);
      if (sections.length !== 1 || sections[0] !== part) railBuildingCuts.colliders++;
      for (const section of sections)
        buildingIndex.insert(section, section === part ? partBox : bounds(section.ring));
    };
    const collisionParts = !covered && !primaryRecord && geometrySource?.collisionParts(b.id);
    if (collisionParts?.length) {
      for (const part of collisionParts)
        insertCollider(
          placeCollider({
            ...b,
            ...part,
            height: part.height,
            minHeight: part.minHeight,
            ...(fittedRoof && !part.heightAt
              ? { heightAt: (x, z) => enrichment.measuredRoofs.roofHeightAt(b.id, x, z) }
              : {}),
          }),
        );
    } else
      insertCollider(
        placeCollider({
          ...b,
          height,
          minHeight: meshRecord?.minHeight ?? proof?.occupiedHeightMin ?? -1,
          ...(primaryRecord && geometrySource.collisionHeightAt
            ? { heightAt: (x, z, body) => geometrySource.collisionHeightAt(b.id, x, z, body) }
            : {}),
        }),
      );
    if (!meshRecord && duplicates.has(b.id)) {
      removedDuplicates++;
      continue;
    }
    if (!meshRecord) {
      const volume = fallbackVolumeKey(b, height, proof?.occupiedHeightMin ?? -1);
      if (fallbackVolumes.has(volume)) {
        exactFallbackDuplicatesRemoved++;
        continue;
      }
      fallbackVolumes.add(volume);
    }
    const sourceMetadata = metadata.get(b.osmId) || metadata.get(b.id);
    const kind = sourceMetadata?.kind || b.kind,
      footprintBoxArea = (box.maxX - box.minX) * (box.maxZ - box.minZ),
      possibleHouse =
        /house|detached|terrace|residential/.test(kind) &&
        !/garage|apartment/.test(kind) &&
        height < 14 &&
        footprintBoxArea < 460,
      untypedHome =
        /^(yes|unclassified)$/.test(kind) &&
        !b.name &&
        height < 11 &&
        footprintBoxArea >= 45 &&
        footprintBoxArea < 310,
      street = possibleHouse || untypedHome ? roadIndex.nearest(cx, cz, true, 55, true) : null,
      smallResidential =
        possibleHouse || (untypedHome && street?.road.kind === 'residential' && street.distance <= 36),
      front =
        smallResidential && street && street.distance > 1 && street.distance <= 55
          ? [(street.x - cx) / street.distance, (street.z - cz) / street.distance]
          : null;
    const shelter =
      b.id === 'city-outline-28774-0' &&
      meshRecord?.structureIds.length === 1 &&
      meshRecord.structureIds[0] === 1001382 &&
      meshRecord.indexCount === 1956;
    const school =
      b.id === 'city-outline-28910-0' &&
      meshRecord?.structureIds.length === 1 &&
      meshRecord.structureIds[0] === 1382531 &&
      meshRecord.indexCount === 2424;
    const profile = buildingProfile(
      { ...b, height },
      infill ||
        (shelter || school
          ? { ...sourceMetadata, material: 'brick', color: shelter ? '#a47056' : '#a46b57' }
          : smallResidential
            ? { ...sourceMetadata, smallResidential, front }
            : sourceMetadata),
    );
    const gx = Math.floor(cx / 300),
      gz = Math.floor(cz / 300),
      key = `${gx},${gz}`;
    if (!groups.has(key))
      groups.set(key, {
        geos: [],
        definitions: [],
        x: (gx + 0.5) * 300,
        z: (gz + 0.5) * 300,
        ...(buildingGround ? { groundPlacements: [], vertexCount: 0 } : {}),
      });
    let g = meshRecord
      ? geometrySource.createGeometry(b.id)
      : compactHeight != null
        ? createCompactBuildingGeometry(b, height)
        : new THREE.ExtrudeGeometry(shape(b), {
            depth: height,
            bevelEnabled: false,
            steps: 1,
            curveSegments: 1,
          }).rotateX(-Math.PI / 2);
    decorateBuildingGeometry(g, b, profile);
    if (placement) buildingGround.placeGeometry(g, placement);
    const low = (meshRecord?.minHeight ?? 0) + (placement?.offsetM || 0);
    const cuts = railClearance.find(b, box, low, height + (placement?.offsetM || 0));
    const cleared = trimRailGeometry(g, cuts);
    const clippedForRail = cleared !== g;
    if (clippedForRail) railBuildingCuts.meshes++;
    g = cleared;
    if (!g.attributes.position.count) {
      g.dispose();
      continue;
    }
    const reliefAt = terrain?.regionalOffsetAt;
    const lowRim = meshRecord?.minHeight ?? 0;
    if (
      !clippedForRail &&
      reliefAt &&
      placement?.offsetM > 0.3 &&
      lowRim <= 0.35 &&
      !['roof', 'carport', 'canopy'].includes(b.kind) &&
      b.ring.some(([x, z]) => reliefAt(x, z) < placement.offsetM + lowRim - 0.24)
    ) {
      const tile = groups.get(key);
      tile.hillsideFootings ||= [];
      appendHillsideFootings(tile.hillsideFootings, g, placement.offsetM + lowRim, reliefAt);
    }
    if (b.id === 'city-outline-28259-0') addIrwinBlockFrontage(scene, g, placement?.offsetM);
    const devenish = addDevenishFrontage(scene, g, primaryRecord, placement?.offsetM);
    if (devenish) {
      for (const part of devenish.colliders) buildingIndex.insert(part, bounds(part.ring));
      neighborhoods.authoredStorefrontBuildingIds.add(b.id);
      neighborhoods.stats.devenishTriangles = devenish.triangles;
    }
    if (b.id === SUPERSTORE_PODIUM_ID) {
      const finish = splitSuperstorePodium(g, primaryRecord, placement?.offsetM);
      if (finish) {
        addSuperstorePodium(scene, finish, placement?.offsetM);
        authoredStorefrontPlaceIds.add(SUPERSTORE_PLACE_ID);
        const arris = addArrisWest(scene, placement?.offsetM);
        buildingIndex.insert(arris, bounds(arris.ring));
        landmark.labels.push({ name: arris.name, x: 1185.9, z: -197.5, height: arris.height + 4 });
      }
    }
    if (placement) {
      const group = groups.get(key),
        count = g.index?.count ?? g.attributes.position.count;
      group.groundPlacements.push({ id: b.id, start: group.vertexCount, count, placement });
      group.vertexCount += count;
    }
    groups.get(key).geos.push(g);
    if (meshRecord && geometrySource === enrichment.partialBuildings) partialCompoundsRendered.add(b.id);
    if (!meshRecord && !clippedForRail)
      groups.get(key).definitions.push({
        b: { ...b, height },
        profile,
        ...(placement ? { groundPlacement: placement } : {}),
      });
    else if (primaryRecord) meshCount++;
    count++;
    if (primaryRecord || supplementalRecord?.measured || /lidar|\+osm/i.test(b.source || '')) measured++;
    if (count % 1500 === 0 && typeof requestAnimationFrame === 'function') {
      await onProgress(
        0.4 + Math.min(0.24, (count / data.buildings.length) * 0.24),
        'Reconstructing surveyed roofs and walls',
      );
    }
  }
  for (const group of groups.values()) {
    const m = mergedMesh(
      scene,
      group.geos,
      buildingMaterial(enrichment.touchGraphics),
      'Building tile',
      true,
    );
    chunks.push({
      mesh: m,
      x: group.x,
      z: group.z,
      definitions: group.definitions,
      detail: null,
      ...(buildingGround ? { groundPlacements: group.groundPlacements } : {}),
    });
  }
  if (enrichment.buildingCellDraws === true) {
    const regions = new Map();
    for (const chunk of chunks) {
      const key = `${Math.floor(chunk.x / 1200)},${Math.floor(chunk.z / 1200)}`;
      if (!regions.has(key)) regions.set(key, []);
      regions.get(key).push(chunk);
    }
    for (const region of regions.values()) {
      if (region.length < 2) continue;
      const mesh = addStaticBatches(
        scene,
        region.map((chunk) => chunk.mesh.geometry),
        buildingMaterial(enrichment.touchGraphics),
        'Building region',
        true,
        { requireIndirect: true },
      );
      if (!mesh) continue;
      region.forEach((chunk, index) => {
        scene.remove(chunk.mesh);
        chunk.mesh = mesh;
        chunk.batchIndex = index;
      });
    }
  }
  for (const b of landmark.colliders || []) buildingIndex.insert(b, bounds(b.ring));
  const landBridgeMeshes = enrichment.landBridgeMeshes
    ? buildLandBridgeMeshes(scene, enrichment.landBridgeMeshes, {
        material: facadeMaterial(0),
        groundOffsetFor: (record) => terrainOffset(...record.origin),
      })
    : null;
  for (const collider of landBridgeMeshes?.collisionParts() || [])
    buildingIndex.insert(collider, bounds(collider.ring));
  const sunnysideBarrier = buildSunnysideBarrier(scene, sunnysidePlan, { terrain });
  for (const collider of sunnysideBarrier.colliders || [])
    buildingIndex.insert(collider, bounds(collider.ring));
  const bridgeColliders = createBridgeCollisionParts(infrastructureSurfaces);
  if (northBowModel) {
    bridgeColliders.slabs.push(...northBowModel.slabs);
    bridgeColliders.barriers.push(...northBowModel.barriers);
    bridgeColliders.stats.slabs = bridgeColliders.slabs.length;
    bridgeColliders.stats.guardrails += northBowModel.guards.length + northBowModel.stairGuards.length;
    bridgeColliders.stats.columns = (bridgeColliders.stats.columns || 0) + northBowModel.columns.length;
    for (const slab of northBowModel.slabs) buildingIndex.insert(slab, bounds(slab.ring));
  }
  if (princeArchModel.ready) {
    bridgeColliders.slabs.push(...princeArchModel.slabs);
    bridgeColliders.barriers.push(...princeArchModel.guards);
    bridgeColliders.stats.slabs = bridgeColliders.slabs.length;
    bridgeColliders.stats.guardrails += princeArchModel.guards.length;
    for (const slab of princeArchModel.slabs) buildingIndex.insert(slab, bounds(slab.ring));
  }
  for (const rail of bridgeColliders.barriers) buildingIndex.insert(rail, bounds(rail.ring));
  phase('buildingDecodeAndMerge');
  const hillsideFootings = [];
  for (const tile of groups.values()) {
    if (!tile.hillsideFootings?.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(tile.hillsideFootings, 3));
    geometry.computeVertexNormals();
    hillsideFootings.push(geometry);
    tile.hillsideFootings = null;
  }
  addStaticBatches(scene, hillsideFootings, surfaceMaterial('concrete'), 'Calgary hillside foundations');
  const foundationGround = landmarkGround
    ? { offsetFor: (id) => buildingGround?.offsetFor(id) ?? landmarkGround.offsetFor(id) }
    : buildingGround;
  const nativeProfile = nativeGround && foundationGround ? createCityGroundProfile(nativeGround) : null;
  let foundations;
  try {
    foundations = buildInferredFoundations(scene, data, enrichment.cityMeshes, {
      material: facadeMaterial(3),
      materialForBuilding: (b) =>
        facadeMaterial(b.name === 'The Bow' ? 1 : /Keynote/.test(b.name || '') ? 0 : 3),
      ...(foundationGround
        ? { buildingGround: foundationGround, ...(nativeProfile ? { nativeProfile } : {}) }
        : {}),
    });
  } finally {
    nativeProfile?.dispose();
  }
  for (const collider of foundations.colliders) buildingIndex.insert(collider, bounds(collider.ring));
  const westernLights = buildWesternTowerLights(
    scene,
    data,
    enrichment.cityMeshes,
    enrichment.buildings || [],
    buildingGround ? { buildingGround } : {},
  );
  await onProgress(0.67, 'Planting trees and placing streetlights');
  const islandPlanting = addIslandPlanting(
    scene,
    parkLifeManifest.habitats.find((habitat) => habitat.id === 'st-patrick'),
    {
      inWater,
      roadIndex,
      buildingIndex,
      paved: (x, z) => parks?.groundHeight(x, z, true) != null || groundSurfaces.groundHeight(x, z) != null,
      groundHeight: (x, z) => parks?.groundHeight(x, z) ?? 0.045 + terrainOffset(x, z),
    },
  );
  const vegetation = createVegetation(
    scene,
    {
      trees: [...(enrichment.trees || []), ...islandPlanting.trees].filter(
        (t) =>
          !developments.surfaceExclusions.some((e) => inside(t.x, t.z, e.ring)) &&
          // The old solid volume excluded these source trees. Keep that same
          // exclusion; replacing its body must not resurrect unreviewed trees
          // inside the inspected construction/footing corridor.
          !(sunnysidePlan.accepted && inPolygon(t.x, t.z, sunnysidePlan.vegetationExclusion)),
      ),
    },
    {
      buildingIndex,
      inWater,
      groundHeight: (x, z) => 0.045 + terrainOffset(x, z),
      indirectCells: enrichment.vegetationCellDraws === true,
    },
  );
  const surveyedLighting = enrichment.lightingData
    ? createSurveyedLighting(scene, {
        data: enrichment.lightingData,
        buildingIndex,
        bridgeColliders,
        deckConflictsWithSupport: infrastructureSurfaces.deckConflictsWithSupport,
        siteExclusions: developments.surfaceExclusions,
        groundHeight: (x, z, hint) => {
          const development = developments.surfaceHeight(x, z);
          if (development != null && (!Number.isFinite(hint) || development <= hint + 0.65))
            return development;
          const bridge = infrastructureSurfaces.groundHeight(x, z, hint);
          if (bridge != null) return bridge;
          const pavement = groundSurfaces.groundHeight(x, z),
            park = parks?.groundHeight(x, z);
          return pavement != null || park != null
            ? Math.max(pavement ?? -Infinity, park ?? -Infinity)
            : 0.2 + terrainOffset(x, z);
        },
      })
    : null;
  const streetLightWash = createStreetLightWash(surveyedLighting?.records || []);
  neighborhoods.stats.avenueBanners = addSeventeenthAvenueBanners(scene, surveyedLighting?.supports);
  const streetDetails = enrichment.streetDetailData
    ? createStreetDetails(scene, {
        data: enrichment.streetDetailData,
        buildingIndex,
        roadIndex,
        waters: data.waters,
        siteExclusions: developments.surfaceExclusions,
        existingSeats: parkLifeManifest.seats || [],
        // A City XY record does not identify an overpass deck. Resolve the low
        // terrain/paving layer explicitly instead of raising hydrants onto bridges.
        groundHeight: (x, z) => {
          const development = developments.surfaceHeight(x, z);
          const grade = 0.2 + terrainOffset(x, z);
          if (development != null && development <= grade + 0.65) return development;
          const bridge = infrastructureSurfaces.groundHeight(x, z, grade);
          if (bridge != null) return bridge;
          const pavement = groundSurfaces.groundHeight(x, z),
            park = parks?.groundHeight(x, z);
          return pavement != null || park != null
            ? Math.max(pavement ?? -Infinity, park ?? -Infinity)
            : 0.2 + terrainOffset(x, z);
        },
      })
    : null;
  for (const footprint of streetDetails?.footprints || [])
    buildingIndex.insert(footprint, bounds(footprint.ring));
  const trunks = createTreeCollision([
    ...vegetation.records,
    ...(surveyedLighting?.supports || []),
    ...(streetDetails?.colliders || []),
  ]);
  phase('foundationsLightsAndVegetation');
  await onProgress(0.71, 'Connecting bridges and street furniture');
  const infrastructure = buildInfrastructure(scene, data, {
    surfaces: infrastructureSurfaces,
    compactPavement: enrichment.touchGraphics,
    buildingIndex,
    sidewalkPolygons: groundSurfaces.sidewalkPolygons,
    surveyedCurbs: bakedCrossings.ok ? bakedCrossings.surveyedCurbs : undefined,
    signalSites: enrichment.signalSites || [],
    siteExclusions: developments.surfaceExclusions,
    surveyedLighting,
    mappedCrossings,
    furnitureCoverage: streetDetails?.covers,
  });
  phase('infrastructure');
  await onProgress(0.75, 'Connecting the neighbourhoods');
  const crossingGroundHeight = (x, z, hint) => {
    const a = infrastructureSurfaces.groundHeight(x, z, hint),
      b = mappedBridgeSupport.groundHeight(x, z, hint);
    if (a == null) return b;
    if (b == null) return a;
    return Number.isFinite(hint) ? (Math.abs(a - hint) <= Math.abs(b - hint) ? a : b) : Math.max(a, b);
  };
  const groundHeight = (x, z, elevationHint) => {
    const tunnel = underpass?.groundHeight(x, z, elevationHint);
    if (tunnel != null) return tunnel;
    const developmentLevel = developments.surfaceHeight(x, z);
    if (
      developmentLevel !== null &&
      (!Number.isFinite(elevationHint) || developmentLevel <= elevationHint + 0.65)
    )
      return developmentLevel;
    const platformLevel = world.transit?.groundHeight(x, z, elevationHint);
    if (platformLevel != null) return platformLevel;
    const bridgeLevel = crossingGroundHeight(x, z, elevationHint);
    if (bridgeLevel != null) return bridgeLevel;
    const fordLevel = fordCrossings.groundHeight(x, z, elevationHint);
    if (fordLevel != null) return fordLevel;
    const pavement = groundSurfaces.groundHeight(x, z),
      park = parks?.groundHeight(x, z),
      bank = riverbank.heightAt(x, z);
    return pavement != null || park != null || bank != null
      ? Math.max(pavement ?? -Infinity, park ?? -Infinity, bank ?? -Infinity)
      : 0.2 + terrainOffset(x, z);
  };
  const contact = { nx: 0, nz: 0, depth: 0 };
  const waterBlocked = (x, z, altitude, body) => {
    if (altitude < 3 && inWater(x, z)) {
      const support = crossingGroundHeight(x, z, altitude);
      if (
        (support == null || Math.abs(support - altitude) > 0.65) &&
        !fordCrossings.permitsBody({ x, y: altitude, z }, body)
      )
        return true;
    }
    if (
      body &&
      mappedBridgeFootprintBlocked({ x, y: altitude, z }, body, {
        support: mappedBridgeSupport,
        inWater,
        crossingHeight: crossingGroundHeight,
      })
    )
      return true;
    if (body && fordCrossings.footprintBlocked({ x, y: altitude, z }, body, crossingGroundHeight))
      return true;
    return false;
  };
  const bodyBlocked = (position, body) => {
    for (const b of buildingIndex.near(
      position.x,
      position.z,
      Math.max(body.extX ?? body.radius, body.extZ ?? body.radius),
    )) {
      if (footprintContact(b, position.x, position.y, position.z, body, contact)) return true;
    }
    return (
      trunks.blocked(position, body) ||
      waterBlocked(position.x, position.z, position.y, body) ||
      !!world.transit?.bodyBlocked(position, body) ||
      !!world.pedestrianBlocked?.(position, body) ||
      !!world.trafficBlocked?.(position, body)
    );
  };
  const collision = (x, z, radius = 0, altitude = 0) =>
    bodyBlocked({ x, y: altitude, z }, movementBody('walk', 0, radius));
  const resolveMovement = (position, body) => {
    let collided = false;
    for (let iteration = 0; iteration < 5; iteration++) {
      let hit = false;
      for (const b of buildingIndex.near(
        position.x,
        position.z,
        Math.max(body.extX ?? body.radius, body.extZ ?? body.radius),
      )) {
        if (!footprintContact(b, position.x, position.y, position.z, body, contact)) continue;
        position.x += contact.nx * (contact.depth + 0.002);
        position.z += contact.nz * (contact.depth + 0.002);
        collided = hit = true;
      }
      if (!hit) break;
    }
    const trafficHit = !!world.resolveTrafficMovement?.(position, body);
    const transitHit = !!world.transit?.resolveMovement(position, body);
    const treeHit = trunks.resolve(position, body);
    return (
      collided ||
      trafficHit ||
      transitHit ||
      !!world.pedestrianBlocked?.(position, body) ||
      treeHit ||
      waterBlocked(position.x, position.z, position.y, body)
    );
  };
  const roofMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x73746d,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  let roofTiles = new Set(),
    pendingRoof,
    readyRoof,
    detailWorker;
  function attachRoof(tile, geometry) {
    tile.detail = false;
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, roofMaterial);
    mesh.name = 'Roof detail tile';
    mesh.receiveShadow = true;
    scene.add(mesh);
    tile.detail = mesh;
  }
  function updateNextRoof(worker) {
    if (readyRoof) {
      const { tile, geometry } = readyRoof;
      readyRoof = null;
      if (roofTiles.has(tile) && tile.detail === null) {
        attachRoof(tile, geometry);
        return;
      }
      geometry?.dispose();
    }
    if (pendingRoof) return;
    for (const tile of roofTiles) {
      if (tile.detail !== null) continue;
      if (!worker.available) {
        worker.stats.fallback++;
        attachRoof(tile, buildRoofDetailGeometry(tile.definitions));
        return;
      }
      const recipe = tile.definitions.map(({ b, profile, groundPlacement }) => ({
        b: { ring: b.ring, holes: b.holes },
        profile: { height: profile.height, pitched: profile.pitched, residential: profile.residential },
        groundPlacement: groundPlacement && { offsetM: groundPlacement.offsetM },
      }));
      const request = worker.build('roof', recipe);
      if (request) {
        pendingRoof = tile;
        request
          .then(({ geometry }) => {
            readyRoof = { tile, geometry };
          })
          .catch(() => {})
          .finally(() => {
            pendingRoof = null;
          });
      }
      return;
    }
  }
  const world = {
    data,
    authoredStorefrontBuildingIds: neighborhoods.authoredStorefrontBuildingIds,
    authoredStorefrontPlaceIds,
    ...(buildingGround ? { buildingGround } : {}),
    ...(buildingGround || landmarkGround || parkStructures.groundPlacement
      ? {
          placePhotographicGeometry: (geometry, record) => {
            const id = record.wallGeometryBuildingId || record.buildingId,
              ordinary = buildingGround?.offsetFor(id) != null,
              special = landmarkGround?.offsetFor(id) != null,
              park = parkStructures.groundPlacement?.offsetFor(id) != null;
            if ([ordinary, special, park].filter(Boolean).length > 1)
              throw new Error(`Ambiguous photographic ground owner ${id}`);
            if (park) return parkStructures.groundPlacement.placePhotographicGeometry(geometry, record);
            return special
              ? landmarkGround.placePhotographicGeometry(geometry, record)
              : buildingGround?.placePhotographicGeometry(geometry, record) || geometry;
          },
        }
      : {}),
    photoWallGeometry: (id) =>
      enrichment.haydenBlock?.photoWallGeometry(id) ||
      (partialCompoundsRendered.has(enrichment.partialBuildings?.get(id)?.baselineBuildingId)
        ? enrichment.partialBuildings.photoWallGeometry(id)
        : null) ||
      enrichment.cityMeshes?.createGeometry(id) ||
      null,
    landmark,
    roadIndex,
    buildingIndex,
    waterIndex,
    chunks,
    collision,
    bodyBlocked,
    resolveMovement,
    inWater,
    groundHeight,
    allowsTunnel: underpass?.allows,
    crossingGroundHeight,
    mappedBridgeSupport,
    fordCrossings,
    fordDetails,
    surfaceHeight: (x, z, road) => infrastructureSurfaces.surfaceHeight(x, z, road),
    infrastructure,
    northBowModel,
    northBowOverpass,
    princeArchModel,
    princeArch,
    landBridgeMeshes,
    sunnysideBarrier,
    groundSurfaces,
    roadMarkings,
    vegetation,
    trunks,
    terrain,
    surveyedLighting,
    streetDetails,
    parks,
    parkStructures,
    parkArt,
    westernLights,
    foundations,
    developments,
    bridgeColliders,
    stats: {
      buildMs,
      railBuildingCuts,
      recentDevelopments: developments.stats,
      supplementalBuildings: enrichment.fallbackBuildings?.stats,
      haydenBlock: enrichment.haydenBlock?.stats || {
        accepted: false,
        reason: enrichment.haydenBlockError || 'not supplied',
      },
      partialBuildings: enrichment.partialBuildings
        ? {
            ...enrichment.partialBuildings.stats,
            accepted: true,
            renderedPartialCompounds: partialCompoundsRendered.size,
          }
        : { accepted: false, reason: enrichment.partialBuildingsError || 'not supplied' },
      measuredRoofFits: enrichment.measuredRoofs?.count || 0,
      measuredRoofContacts: enrichment.measuredRoofs?.regionalContactStats || null,
      parkStructures: parkStructures.stats,
      parkArt: parkArt.stats,
      neighborhoods: neighborhoods.stats,
      islandTerrain: terrain?.stats,
      islandPlanting: { trees: vegetation.stats.inferredTrees, shrubs: islandPlanting.shrubs },
      ...(buildingGround ? { ordinaryBuildingGround: buildingGround.stats } : {}),
      surveyedLighting: surveyedLighting?.stats,
      streetLightWash: streetLightWash.stats,
      streetDetails: streetDetails?.stats,
      ...parks?.stats,
      ...westernLights.stats,
      buildings: count,
      cityMeshes: meshCount,
      duplicateExtrusionsRemoved: removedDuplicates,
      exactFallbackDuplicatesRemoved,
      sourceBuildingSuppressions,
      simmonsGroundCorrection: {
        applied: openGroundCorrections.size > 0,
        records: [...openGroundCorrections.values()],
      },
      inferredFoundationBuildings: foundations.stats.buildings,
      inferredFoundationTriangles: foundations.stats.triangles,
      trees: vegetation.stats.surveyedTrees,
      vegetationCells: vegetation.stats.cellDraws,
      roads: data.roads.length,
      measured,
      cityMeshContacts: enrichment.cityMeshes?.contactStats || null,
      surveyedSurfaces: groundSurfaces.stats.surveyedSurfaces,
      surveyedPolygonQueries: groundSurfaces.stats.polygonQueries,
      waterPolygonQueries: waterQueries.stats,
      surfaceWinding: {
        ...surfaceWinding,
        repairedRoads: [...windingRoads]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, triangles]) => ({ id, triangles })),
      },
      mappedCrossings: mappedCrossings.stats,
      bakedCrossings: {
        accepted: bakedCrossings.ok,
        reason: bakedCrossings.reason || null,
        loadMs: bakedCrossings.loadMs,
        validationMs: bakedCrossings.validationMs,
      },
      northBowOverpass: northBowModel ? { ...northBowModel.stats, ...northBowOverpass.stats } : null,
      princeArch: princeArchModel.ready
        ? { ...princeArchModel.stats, ...princeArch.stats }
        : { accepted: false, reason: princeArchModel.reason },
      landBridgeMeshes: enrichment.landBridgeMeshes?.stats || {
        unavailable: enrichment.landBridgeMeshError || 'not supplied',
      },
      sunnysideBarrier: sunnysideBarrier.stats,
      surveyedSidewalks: groundSurfaces.stats.surveyedSidewalks,
      bridges: infrastructure.stats.bridgeModels,
      bridgeNightDetails: {
        drawCalls: infrastructure.stats.bridgeDetailDraws,
        animatedScenes: infrastructure.stats.animatedBridgeScenes,
        fixtures: infrastructure.stats.bridgeLightFixtures,
        peaceInfillSegments: infrastructure.stats.peaceInfillSegments,
      },
      bridgeCollisions: bridgeColliders.stats,
      get bridgePhysicalDetails() {
        return {
          bridges: infrastructure.stats.bridgeConnectionBridges,
          primitives: infrastructure.stats.bridgeConnectionPrimitives,
          triangleUpperBound: infrastructure.stats.bridgeConnectionTriangleUpperBound,
          livePrimitives: infrastructure.stats.liveBridgeConnectionPrimitives,
          liveTriangles: infrastructure.stats.liveBridgeConnectionTriangles,
        };
      },
      skywalks: infrastructure.stats.skywalks,
      crossings: infrastructure.stats.crossings,
    },
    updateLocalDetails() {
      detailWorker ??= createDetailWorker();
      world.stats.detailWorker = detailWorker.stats;
      if (!infrastructure.updateNextDetail(detailWorker)) updateNextRoof(detailWorker);
    },
    update(camera, quality = 'balanced', { deferDetails = false } = {}) {
      const mobile = enrichment.touchGraphics && quality === 'performance';
      const max = quality === 'high' ? 6500 : mobile ? 3600 : 4800;
      for (const c of chunks) {
        const d = Math.hypot(c.x - camera.position.x, c.z - camera.position.z);
        if (c.batchIndex === undefined) {
          c.mesh.visible = d < max;
          c.mesh.castShadow = !mobile && d < 650;
        } else {
          setStaticBatchPartVisible(c.mesh, c.batchIndex, d < max);
          setStaticBatchPartShadowVisible(c.mesh, c.batchIndex, !mobile && d < 650);
        }
      }
      // Only nearby roofs need separate geometry. The tower and collision
      // shells are already present while these optional tiles are generated.
      roofTiles = new Set(
        chunks
          .map((c) => ({ c, d: Math.hypot(c.x - camera.position.x, c.z - camera.position.z) }))
          .filter(
            ({ c, d }) => c.definitions.length && d < (mobile ? 440 : camera.position.y > 180 ? 1700 : 750),
          )
          .sort((a, b) => a.d - b.d)
          .slice(0, quality === 'high' ? 24 : mobile ? 4 : 12)
          .map(({ c }) => c),
      );
      for (const c of chunks) {
        if (roofTiles.has(c)) {
          if (!deferDetails && c.detail === null) attachRoof(c, buildRoofDetailGeometry(c.definitions));
        } else if (c.detail) {
          scene.remove(c.detail);
          c.detail.geometry.dispose();
          c.detail = null;
        }
      }
      vegetation.update(camera, quality);
      infrastructure.update(camera, quality, deferDetails);
      landBridgeMeshes?.update(camera.position);
      sunnysideBarrier.update(camera, quality);
      groundSurfaces.update(camera, quality);
      parks?.update(camera, quality);
      parkStructures.update(camera, quality);
      parkArt.update(camera, quality);
      surveyedLighting?.update(camera, mobile ? 'low' : quality);
      streetLightWash.update(camera);
      streetDetails?.update(camera, quality);
      northBowOverpass?.update(camera);
      princeArch?.update(camera, quality);
    },
  };
  world.walkSupportHeight = createWalkingSupport({
    groundHeight,
    stepColliders: [
      ...landmark.walkSlabs,
      ...developments.colliders,
      ...neighborhoods.steps,
      ...(northBowModel?.slabs || []),
      ...(princeArchModel.ready ? princeArchModel.slabs : []),
    ],
    transit: () => world.transit,
  });
  return world;
}
