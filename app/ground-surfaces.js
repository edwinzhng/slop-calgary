import * as THREE from 'three/webgpu';
import polygonClipping from 'polygon-clipping';
import { addStaticBatches, mergeStaticGeometries } from './static-batches.js';
import { bounds, SpatialIndex, inPolygon, seeded } from './geo.js';
import { surfaceMaterial } from './materials.js';
import { createCarInstances } from './car-instances.js';
import { createStaticPolygonQueries, containsPreparedPolygon } from './polygon-queries.js';
import { createLinearPolygonGeometry } from './linear-polygon-geometry.js';
import { createParkingBoxBatch } from './parking-box-batch.js';
import { trafficVehicleModel, TRAFFIC_PAINTS } from './traffic.js';

const isConcordPlaza = (surface) =>
  surface.id === 'city-surface-21455-0' &&
  surface.ring.length === 43 &&
  surface.ring[0]?.[0] === -454.12 &&
  surface.ring[0]?.[1] === -781.55;

export function surfaceStyle(surface) {
  if (isConcordPlaza(surface)) return { material: 'concrete', y: 0.15 };
  const kind = surface.kind;
  if (kind === 'Curb Gutter Sidewalk') return { material: 'concrete', y: 0.31 };
  if (surface.material === 'Gravel' || kind === 'Ball Diamond') return { material: 'gravel', y: 0.11 };
  if (surface.material === 'Pavement')
    return {
      material: kind === 'Pathways' ? 'path-asphalt' : 'asphalt',
      y: kind === 'Roads Paved' ? 0.115 : 0.15,
    };
  return { material: 'concrete', y: kind === 'Pathways' ? 0.135 : 0.15 };
}

function renderedPaving(surface) {
  // At the 9 Street crossing the older paved polygon includes broad approach
  // flares and leftover islands. Keep the mapped through path and its curb
  // connections separate in this reach. Elsewhere the City polygon owns paving.
  if (
    surface.id !== 'city-surface-20880-0' ||
    surface.kind !== 'Pathways' ||
    surface.ring.length !== 200 ||
    !surface.ring.some(([x, z]) => x === -642.28 && z === -866.55)
  )
    return [surface];
  const reach = [
    [-703, -935],
    [-611, -935],
    [-611, -798],
    [-703, -798],
    [-703, -935],
  ];
  return polygonClipping
    .difference([surface.ring, ...(surface.holes || [])], [reach])
    .map(([ring, ...holes]) => ({ ...surface, ring, holes }));
}

// Parking bays are inferred inside a surveyed parking polygon. Requiring all
// corners to remain in its exterior preserves courtyards, buildings and holes.
export function parkingLayout(surface, maxCount = 100) {
  if (!/Parking/i.test(surface.kind)) return [];
  const ring = surface.ring.slice(0, -1);
  let longest = 0,
    axis = [1, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) {
      longest = length;
      axis = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    }
  }
  const across = [-axis[1], axis[0]];
  const u = ring.map((p) => p[0] * axis[0] + p[1] * axis[1]);
  const v = ring.map((p) => p[0] * across[0] + p[1] * across[1]);
  const minU = Math.min(...u),
    maxU = Math.max(...u),
    minV = Math.min(...v),
    maxV = Math.max(...v);
  if (maxU - minU < 5.5 || maxV - minV < 5.9) return [];
  const toWorld = (pu, pv) => [pu * axis[0] + pv * across[0], pu * axis[1] + pv * across[1]];
  const result = [];
  const depth = maxV - minV,
    rowStep = 16.2;
  for (let row = 0, pv = minV + 3.2; pv < maxV - 2.7 && result.length < maxCount; row++, pv += rowStep) {
    for (const offset of depth > 15 ? [0, 10.8] : [0]) {
      if (pv + offset > maxV - 2.7) continue;
      for (let pu = minU + 2; pu < maxU - 1.6 && result.length < maxCount; pu += 2.7) {
        const corners = [
          [-1.25, -2.55],
          [1.25, -2.55],
          [1.25, 2.55],
          [-1.25, 2.55],
        ].map(([a, b]) => toWorld(pu + a, pv + offset + b));
        if (!corners.every(([x, z]) => inPolygon(x, z, surface))) continue;
        const [x, z] = toWorld(pu, pv + offset);
        result.push({
          x,
          z,
          corners,
          heading: Math.atan2(across[0], across[1]) + (offset ? Math.PI : 0),
          row,
          y: surfaceStyle(surface).y,
        });
      }
    }
  }
  return result;
}

export function createGroundSurfaces(scene, surfaceData, context = {}) {
  const surfaces = (surfaceData.surfaces || []).flatMap(renderedPaving),
    sidewalkPolygons = [],
    lots = [],
    parkingAisles = new SpatialIndex(96);
  for (const { a, b, road } of context.roadIndex?.segments || []) {
    if (road.sourceTags?.service !== 'parking_aisle') continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    parkingAisles.insert({ mid }, bounds([mid]));
  }
  const index = new SpatialIndex(160),
    polygonQueries = createStaticPolygonQueries(),
    groups = new Map(),
    meshes = [],
    batches = new Map();
  let triangleCount = 0;
  function flush(key) {
    const group = groups.get(key);
    if (!group?.geometries.length) return;
    const geometry = mergeStaticGeometries(group.geometries);
    group.geometries.forEach((g) => g.dispose());
    group.geometries = [];
    group.vertices = 0;
    if (!batches.has(group.material)) batches.set(group.material, []);
    batches.get(group.material).push(geometry);
    triangleCount += (geometry.index?.count || geometry.attributes.position.count) / 3;
  }
  for (const surface of surfaces) {
    const box = bounds(surface.ring),
      style = surfaceStyle(surface);
    index.insert({ surface, box, ...style, prepared: polygonQueries.preparePolygon(surface) }, box);
    if (surface.kind === 'Curb Gutter Sidewalk') sidewalkPolygons.push(surface);
    const x = (box.minX + box.maxX) / 2,
      z = (box.minZ + box.maxZ) / 2;
    // City paving includes plazas and driveways. Require an independently
    // mapped parking aisle before adding stripes and parked cars.
    if (/Parking/i.test(surface.kind) && !isConcordPlaza(surface)) {
      const radius = Math.max(box.maxX - x, box.maxZ - z);
      for (const { mid } of parkingAisles.near(x, z, radius)) {
        if (!inPolygon(mid[0], mid[1], surface)) continue;
        lots.push({ surface, x, z });
        break;
      }
    }
    const source = createLinearPolygonGeometry(surface, style.y);
    const flat = context.cutSurface?.(source) || source;
    const geometry = context.terrain?.drapeGeometry(flat) || flat;
    if (!geometry.attributes.position.count) {
      geometry.dispose();
      continue;
    }
    context.registerSurfaceGeometry?.(surface, geometry);
    const key = `${style.material}/${Math.floor((box.minX + box.maxX) / 2 / 800)},${Math.floor((box.minZ + box.maxZ) / 2 / 800)}`;
    if (!groups.has(key)) groups.set(key, { material: style.material, geometries: [], vertices: 0 });
    const group = groups.get(key);
    group.geometries.push(geometry);
    group.vertices += geometry.attributes.position.count;
    if (group.vertices > 90000) flush(key);
  }
  // A point query visits one existing 160 m bucket. Sorting its unique source
  // records once lets the first containing polygon reproduce the original
  // maximum-height result, without a temporary Set or lower-surface tests.
  // Keep the generic SpatialIndex radius/deduplication behavior unchanged.
  for (const bucket of index.cells.values()) bucket.sort((a, b) => b.y - a.y);
  for (const key of groups.keys()) flush(key);
  for (const [material, pieces] of batches)
    meshes.push(
      addStaticBatches(
        scene,
        pieces,
        surfaceMaterial(material, context.compactPavement),
        'Surveyed Calgary pavement and sidewalks',
      ),
    );
  const paint = new THREE.MeshStandardNodeMaterial({ color: 0xd8d4bf, roughness: 0.97 });
  const wheelStopMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xa5a69a, roughness: 0.95 });
  const cars = createCarInstances(scene, {
    name: 'Inferred parked cars within surveyed parking areas',
    capacity: 40,
  });
  const object = new THREE.Object3D(),
    carColor = new THREE.Color();
  let activeKey = '',
    stripeMesh = null,
    stopMesh = null,
    lastX = Infinity,
    lastZ = Infinity,
    lastQuality = '',
    lastAerial,
    parked = [];
  function updateCars(camera, quality) {
    cars.begin(quality);
    for (const car of parked)
      cars.add(
        car.id,
        car.matrix,
        car.color,
        Math.hypot(car.matrix.elements[12] - camera.position.x, car.matrix.elements[14] - camera.position.z),
        0,
        0,
        0,
        0,
        car.model,
      );
    cars.end();
  }
  const stats = {
    surveyedSurfaces: surfaces.length,
    polygonQueries: polygonQueries.stats,
    surveyedSidewalks: sidewalkPolygons.length,
    triangles: triangleCount,
    parkingAreas: lots.length,
    liveParkingBays: 0,
    parkedCars: 0,
  };
  function update(camera, quality = 'balanced') {
    const aerial = camera.position.y > 190;
    if (
      Math.hypot(camera.position.x - lastX, camera.position.z - lastZ) < 18 &&
      quality === lastQuality &&
      aerial === lastAerial
    )
      return;
    lastX = camera.position.x;
    lastZ = camera.position.z;
    lastQuality = quality;
    lastAerial = aerial;
    const selected = aerial
      ? []
      : lots
          .map((lot) => ({ lot, d: Math.hypot(lot.x - camera.position.x, lot.z - camera.position.z) }))
          .filter(({ d }) => d < (quality === 'high' ? 350 : 230))
          .sort((a, b) => a.d - b.d)
          .slice(0, quality === 'high' ? 14 : 8)
          .map(({ lot }) => lot);
    const key = `${quality}:${selected.map((lot) => lot.surface.id).join(',')}`;
    if (key === activeKey) {
      updateCars(camera, quality);
      return;
    }
    activeKey = key;
    parked = [];
    for (const mesh of [stripeMesh, stopMesh])
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
    stripeMesh = stopMesh = null;
    const stripes = createParkingBoxBatch(context.terrain),
      stops = createParkingBoxBatch(context.terrain);
    let carCount = 0,
      bays = 0;
    for (const lot of selected) {
      lot.layout ||= parkingLayout(lot.surface);
      const lotSeed = Number(lot.surface.id.match(/\d+/)?.[0]) || 1;
      const random = seeded(lotSeed),
        vehicleMix = seeded(lotSeed ^ 0xa851);
      for (let i = 0; i < lot.layout.length; i++) {
        const stall = lot.layout[i],
          model = trafficVehicleModel(vehicleMix()),
          occupied = random() < 0.25,
          paintIndex = Math.floor(random() * TRAFFIC_PAINTS.length);
        if (
          context.buildingIndex &&
          [...context.buildingIndex.near(stall.x, stall.z, 2)].some((b) => inPolygon(stall.x, stall.z, b))
        )
          continue;
        if (context.inWater?.(stall.x, stall.z)) continue;
        bays++;
        for (let edge = 0; edge < 3; edge++) {
          const a = stall.corners[edge],
            b = stall.corners[edge + 1],
            len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          stripes.add(
            len,
            0.008,
            0.075,
            -Math.atan2(b[1] - a[1], b[0] - a[0]),
            (a[0] + b[0]) / 2,
            stall.y + 0.012,
            (a[1] + b[1]) / 2,
          );
        }
        if (occupied && carCount < (quality === 'high' ? 40 : 22)) {
          const offset = (x, z) => context.terrain?.offsetAt(x, z) || 0;
          const sin = Math.sin(stall.heading),
            cos = Math.cos(stall.heading);
          const pitch = -Math.atan2(
            offset(stall.x + sin * 2.15, stall.z + cos * 2.15) -
              offset(stall.x - sin * 2.15, stall.z - cos * 2.15),
            4.3,
          );
          const roll = Math.atan2(
            offset(stall.x + cos * 0.8, stall.z - sin * 0.8) -
              offset(stall.x - cos * 0.8, stall.z + sin * 0.8),
            1.6,
          );
          object.position.set(stall.x, stall.y + 0.02 + offset(stall.x, stall.z), stall.z);
          object.rotation.set(pitch, stall.heading, roll, 'YXZ');
          object.scale.setScalar(1);
          object.updateMatrix();
          carColor.setHex(TRAFFIC_PAINTS[paintIndex]);
          parked.push({
            id: `${lot.surface.id}:${i}`,
            matrix: object.matrix.clone(),
            model,
            color: carColor.clone(),
          });
          carCount++;
          stops.add(
            1.6,
            0.11,
            0.15,
            stall.heading,
            stall.x + Math.sin(stall.heading) * 2.15,
            stall.y + 0.065,
            stall.z + Math.cos(stall.heading) * 2.15,
          );
        }
      }
    }
    const add = (batch, mat, name) => {
      const geometry = batch.finish();
      if (!geometry) return null;
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.name = name;
      mesh.receiveShadow = true;
      scene.add(mesh);
      return mesh;
    };
    stripeMesh = add(stripes, paint, 'Inferred parking stall markings');
    stopMesh = add(stops, wheelStopMaterial, 'Inferred concrete wheel stops');
    updateCars(camera, quality);
    stats.liveParkingBays = bays;
    stats.parkedCars = carCount;
  }
  return {
    surfaces,
    sidewalkPolygons,
    stats,
    meshes,
    update,
    groundHeight(x, z, kind) {
      const bucket = index.cells.get(`${Math.floor(x / index.size)},${Math.floor(z / index.size)}`);
      for (const item of bucket || [])
        if (
          (!kind || item.surface.kind === kind) &&
          x >= item.box.minX &&
          x <= item.box.maxX &&
          z >= item.box.minZ &&
          z <= item.box.maxZ &&
          containsPreparedPolygon(x, z, item.surface, item.prepared)
        )
          return item.y + (context.terrain?.offsetAt(x, z) || 0);
      return null;
    },
  };
}
