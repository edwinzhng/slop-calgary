#!/usr/bin/env node
/** Reproduce the production map-preparation and surface factories offline. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three/webgpu';
import { applyRoadAttributes } from '../app/road-attributes.js';
import { applySiteOverlays } from '../app/site-overlays.js';
import { collectSurveyedCurbs, createInfrastructureSurfaces } from '../app/infrastructure.js';
import { applyInfrastructureTerrain } from '../app/crossing-surface-context.js';
import { createGroundSurfaces } from '../app/ground-surfaces.js';
import { createIslandTerrain } from '../app/island-terrain.js';
import { withNeighbourhoodTerrain } from '../app/neighbourhood-terrain.js';
import { createMemorialUnderpass } from '../app/memorial-underpass.js';
import { createPrinceArchTerrain } from '../app/prince-arch-ground.js';
import { createPrinceArchModel, attachPrinceArchSurfaces } from '../app/prince-arch.js';
import { createNorthBowOverpass, attachNorthBowSurfaces } from '../app/north-bow-overpass.js';
import { bounds, inPolygon, makeRoadIndex, SpatialIndex } from '../app/geo.js';
import { buildMappedCrossingMarkings } from '../app/mapped-crossings.js';
import { BAKED_CROSSINGS_VERSION, fingerprintCrossingInputs } from '../app/baked-crossings.js';
import { crossingGeneratorHashes } from '../build/crossing-cache.mjs';

export const CROSSING_SOURCE_FILES = Object.freeze([
  'data/calgary.json',
  'data/calgary-road-attributes.json',
  'data/calgary-pathway-finishes.json',
  'data/calgary-transit.json',
  'data/calgary-parks.json',
  'data/calgary-site-overlay.json',
  'data/calgary-surfaces.json',
  'data/calgary-island-relief.json',
  'data/calgary-island-relief.bin',
  'data/calgary-neighbourhood-terrain.json',
  'data/calgary-neighbourhood-terrain.bin',
  'data/prince-arch-evidence.json',
  'data/prince-arch-ground.bin',
]);
export const CROSSING_BAKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function prepareCrossingBake(root = CROSSING_BAKE_ROOT) {
  const bytes = Object.fromEntries(
    await Promise.all(
      CROSSING_SOURCE_FILES.map(async (name) => [name, await fs.readFile(path.join(root, name))]),
    ),
  );
  const json = (name) => JSON.parse(bytes[`data/${name}.json`]);
  const data = json('calgary');
  applyRoadAttributes(data, json('calgary-road-attributes'));
  const transitOnly = new Set(json('calgary-transit').transitOnlyRoadIds);
  for (const road of data.roads) if (transitOnly.has(road.id)) road.transitOnly = true;
  data.parks = json('calgary-parks').mapParks;
  applySiteOverlays(data, json('calgary-site-overlay'));
  const surfaceData = json('calgary-surfaces');
  const baseTerrain = createIslandTerrain(
    json('calgary-island-relief'),
    arrayBuffer(bytes['data/calgary-island-relief.bin']),
  );
  const terrain = withNeighbourhoodTerrain(
    createPrinceArchTerrain(baseTerrain, arrayBuffer(bytes['data/prince-arch-ground.bin'])),
    arrayBuffer(bytes['data/calgary-neighbourhood-terrain.bin']),
  );
  return {
    data,
    surfaceData,
    terrain,
    sources: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)])),
  };
}

export function buildCrossingBakeReference({ data, surfaceData, terrain }) {
  const scene = new THREE.Scene(),
    roadIndex = makeRoadIndex(data.roads);
  const waterIndex = new SpatialIndex(180),
    buildingIndex = new SpatialIndex(80);
  for (const water of data.waters) waterIndex.insert(water, bounds(water.ring));
  const inWater = (x, z) => [...waterIndex.near(x, z)].some((water) => inPolygon(x, z, water));
  // Use the actual factory, including its style/holes/bounds rules. The world
  // creates it with an empty building index at the same stage of construction.
  const groundSurfaces = createGroundSurfaces(scene, surfaceData, {
    buildingIndex,
    roadIndex,
    inWater,
    terrain,
    cutSurface: createMemorialUnderpass(data, terrain)?.cutSurface,
  });
  const northBow = createNorthBowOverpass(data, {
    roadIndex,
    groundHeightAt: (x, z) =>
      Math.max(0.14 + terrain.offsetAt(x, z), groundSurfaces.groundHeight(x, z) ?? -Infinity),
  });
  const surfaces = applyInfrastructureTerrain(
    createInfrastructureSurfaces(data, {
      terrain,
      roadIndex,
      inWater,
      bridgeConnections: northBow?.bridgeConnections,
      pathGroundHeight: (x, z) => 0.14 + terrain.offsetAt(x, z),
    }),
    terrain,
  );
  attachNorthBowSurfaces(surfaces, northBow);
  attachPrinceArchSurfaces(
    surfaces,
    createPrinceArchModel(data, {
      terrain,
      groundHeightAt: (x, z) =>
        Math.max(0.14 + terrain.offsetAt(x, z), groundSurfaces.groundHeight(x, z) ?? -Infinity),
    }),
  );
  const start = performance.now();
  const markings = buildMappedCrossingMarkings(scene, data.roads, {
    spatialBatches: false,
    roadIndex,
    surfaces,
    groundSurfaces,
    terrain,
  });
  const buildMs = performance.now() - start;
  const curbStart = performance.now(),
    curbRecipes = [],
    surveyedCurbs = collectSurveyedCurbs(groundSurfaces.sidewalkPolygons, surfaces, (recipe) =>
      curbRecipes.push(recipe),
    ),
    curbBuildMs = performance.now() - curbStart;
  return {
    scene,
    markings,
    buildMs,
    surveyedCurbs,
    curbRecipes,
    curbBuildMs,
    context: { roadIndex, surfaces, groundSurfaces, terrain },
    dispose() {
      markings.dispose();
      const geometries = new Set(),
        materials = new Set();
      scene.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          if (material) materials.add(material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      scene.clear();
    },
  };
}

export async function bakeMappedCrossings(root = CROSSING_BAKE_ROOT) {
  const prepared = await prepareCrossingBake(root),
    reference = buildCrossingBakeReference(prepared);
  try {
    const geometry = reference.markings.mesh.geometry,
      count = geometry.attributes.position.count;
    const curbs = reference.curbRecipes,
      fractionCount = curbs.filter((curb) => curb.ta !== 0 || curb.tb !== 1).length,
      fractionByteOffset = Math.ceil((count * 20 + curbs.length * 20) / 8) * 8,
      curbLayout = {
        encoding: 'source-edge-parts-v1',
        count: curbs.length,
        fractionCount,
        sourceByteOffset: count * 20,
        fractionByteOffset,
        byteLength: fractionByteOffset + fractionCount * 16 - count * 20,
      },
      binary = Buffer.alloc(count * 20 + curbLayout.byteLength),
      fractions = new Float64Array(binary.buffer, binary.byteOffset + fractionByteOffset, fractionCount * 2),
      curbSources = new Uint32Array(
        binary.buffer,
        binary.byteOffset + curbLayout.sourceByteOffset,
        curbs.length * 5,
      ),
      roads = new Map(prepared.data.roads.map((road, i) => [road, i])),
      polygons = new Map(reference.context.groundSurfaces.sidewalkPolygons.map((polygon, i) => [polygon, i]));
    Buffer.from(geometry.attributes.position.array.buffer).copy(binary, 0);
    Buffer.from(geometry.attributes.side.array.buffer).copy(binary, count * 12);
    let fraction = 0;
    for (let i = 0; i < curbs.length; i++) {
      const curb = curbs[i];
      const road = roads.get(curb.road),
        polygon = polygons.get(curb.polygon),
        ring = [curb.polygon.ring, ...(curb.polygon.holes || [])].indexOf(curb.ring),
        clipped = curb.ta !== 0 || curb.tb !== 1;
      if (road === undefined || polygon === undefined) throw new Error('Surveyed curb has an unknown source');
      curbSources.set(
        [polygon, ring, curb.edge, curb.part * 4 + Number(curb.flipped) * 2 + Number(clipped), road],
        i * 5,
      );
      if (clipped) {
        fractions[fraction++] = curb.ta;
        fractions[fraction++] = curb.tb;
      }
    }
    const inputs = (await fingerprintCrossingInputs(prepared)).hashes;
    const generators = await crossingGeneratorHashes(root);
    const attributes = Object.fromEntries(
      ['position', 'side', 'normal', 'paint', 'color'].map((name) => [
        name,
        sha256(new Uint8Array(geometry.attributes[name].array.buffer)),
      ]),
    );
    attributes.index = sha256(new Uint8Array(geometry.index.array.buffer));
    const manifest = {
      version: BAKED_CROSSINGS_VERSION,
      threeRevision: THREE.REVISION,
      meta: {
        description:
          'Exact offline output of mapped crossing paint and surveyed sidewalk curb selection; detail dimensions remain inferred.',
        command: 'node tools/bake-mapped-crossings.mjs',
        sourceOrder: ['road attributes', 'transit-only roads', 'mapped parks', 'site overlays'],
        sourceLicenses: ['OpenStreetMap ODbL 1.0', 'City of Calgary Open Data Licence'],
        geometrySource: 'app/mapped-crossings.js',
      },
      layout: {
        byteOrder: 'little-endian',
        vertexCount: count,
        positionByteOffset: 0,
        sideByteOffset: count * 12,
        byteLength: binary.length,
        indices: 'deterministic 4-vertex / 6-index quads',
        curbs: curbLayout,
      },
      binarySha256: sha256(binary),
      inputs,
      sources: prepared.sources,
      generators,
      attributes,
      stats: reference.markings.stats,
    };
    // Publish a coherent pair; runtime SHA validation rejects partial publication.
    await fs.writeFile(path.join(root, 'data/calgary-mapped-crossings.bin.tmp'), binary);
    await fs.writeFile(
      path.join(root, 'data/calgary-mapped-crossings.json.tmp'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    await fs.rename(
      path.join(root, 'data/calgary-mapped-crossings.bin.tmp'),
      path.join(root, 'data/calgary-mapped-crossings.bin'),
    );
    await fs.rename(
      path.join(root, 'data/calgary-mapped-crossings.json.tmp'),
      path.join(root, 'data/calgary-mapped-crossings.json'),
    );
    return {
      manifest,
      bytes: binary.length,
      gzipBytes: gzipSync(binary).length,
      builderMs: reference.buildMs,
      curbBuilderMs: reference.curbBuildMs,
    };
  } finally {
    reference.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await bakeMappedCrossings();
  console.log(
    JSON.stringify({
      vertices: result.manifest.layout.vertexCount,
      quads: result.manifest.stats.paintQuads,
      bytes: result.bytes,
      gzipBytes: result.gzipBytes,
      builderMs: Math.round(result.builderMs),
      curbs: result.manifest.layout.curbs.count,
      curbBuilderMs: Math.round(result.curbBuilderMs),
    }),
  );
}
