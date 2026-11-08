import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import {
  BAKED_CROSSINGS_URLS,
  createBakedCrossingMarkings,
  fingerprintCrossingInputs,
  loadBakedCrossings,
  validateBakedCrossings,
} from '../app/baked-crossings.js';
import { crossingGeneratorHashes, verifyCrossingCache } from '../build/crossing-cache.mjs';
import { createMemorialUnderpass } from '../app/memorial-underpass.js';
import { createInfrastructureSurfaces } from '../app/infrastructure.js';
import { makeRoadGraph } from '../app/geo.js';
import { buildMappedCrossingMarkings, collectMappedCrossings } from '../app/mapped-crossings.js';
import { prepareCrossingBake, buildCrossingBakeReference, sha256 } from '../tools/bake-mapped-crossings.mjs';

const sources = new Map();
async function fileFetch(url) {
  const path = fileURLToPath(url);
  if (!sources.has(path)) sources.set(path, await fs.readFile(path));
  return new Response(sources.get(path));
}
const manifestPath = new URL('../data/calgary-mapped-crossings.json', import.meta.url);
const manifest = JSON.parse(await fs.readFile(manifestPath));
const prepared = await prepareCrossingBake();
const generatorHashes = await crossingGeneratorHashes(fileURLToPath(new URL('../', import.meta.url)));
const requests = [];

function paintQuadMultiset(geometry) {
  const attributes = Object.keys(geometry.attributes)
      .sort()
      .map((name) => geometry.attributes[name]),
    count = geometry.attributes.position.count,
    quads = [];
  assert.equal(count % 4, 0);
  assert.equal(geometry.index.count, (count / 4) * 6);
  for (let first = 0; first < count; first += 4) {
    const chunks = attributes.map((attribute) => {
      const size = attribute.array.BYTES_PER_ELEMENT;
      return new Uint8Array(
        attribute.array.buffer,
        attribute.array.byteOffset + first * attribute.itemSize * size,
        4 * attribute.itemSize * size,
      );
    });
    const localIndices = new Uint32Array(6);
    for (let i = 0; i < 6; i++) localIndices[i] = geometry.index.getX((first / 4) * 6 + i) - first;
    quads.push(sha256(Buffer.concat([...chunks, new Uint8Array(localIndices.buffer)])));
  }
  return sha256(quads.sort().join(''));
}

const loaded = await loadBakedCrossings({
  generatorHashes,
  fetchImpl: (url) => {
    requests.push(url);
    return fileFetch(url);
  },
});

test('the bake pins every source and exact geometry/height generator, including Three.js revision', async () => {
  assert.equal(loaded.ok, true, loaded.reason);
  assert.equal(manifest.threeRevision, THREE.REVISION);
  const packageData = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url)));
  assert.match(packageData.dependencies.three, new RegExp(`^0\\.${manifest.threeRevision}\\.\\d+$`));
  for (const [name, hash] of Object.entries(manifest.sources))
    assert.equal(
      sha256(await fs.readFile(new URL(`../${name}`, import.meta.url))),
      hash,
      `Rebake changed input ${name}`,
    );
  assert.equal(requests.length, 2, 'only the mesh and manifest need network requests');
  assert.deepEqual(generatorHashes, manifest.generators);
  await verifyCrossingCache(fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual((await fingerprintCrossingInputs(prepared)).hashes, manifest.inputs);
});

test('baked paint preserves the exact source bytes and runtime spatial batches, with live crossing coverage', async (t) => {
  const reference = buildCrossingBakeReference(prepared);
  const scene = new THREE.Scene();
  let baked, fallback;
  try {
    const validated = await validateBakedCrossings(loaded, prepared);
    assert.equal(validated.ok, true, validated.reason);
    assert.ok(validated.surveyedCurbs.length > 1000);
    assert.deepEqual(validated.surveyedCurbs, reference.surveyedCurbs);
    const roads = new Set(prepared.data.roads),
      polygons = new Set(reference.context.groundSurfaces.sidewalkPolygons);
    for (const curb of validated.surveyedCurbs) {
      assert.ok(roads.has(curb.road), 'retain exact live road ownership');
      assert.ok(polygons.has(curb.polygon));
    }
    const start = performance.now();
    baked = createBakedCrossingMarkings(scene, prepared.data.roads, validated);
    const buildMs = performance.now() - start;
    assert.deepEqual(baked.stats, reference.markings.stats);
    assert.equal(baked.mesh.isBatchedMesh, true);
    for (const name of ['position', 'side', 'normal', 'paint', 'color']) {
      const actual = baked.mesh.geometry.attributes[name].array;
      const expected = reference.markings.mesh.geometry.attributes[name].array;
      assert.equal(
        sha256(new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength)),
        manifest.attributes[name],
      );
      assert.equal(actual.constructor, expected.constructor);
      assert.equal(actual.length, expected.length);
      assert.equal(
        baked.mesh.geometry.attributes[name].normalized,
        reference.markings.mesh.geometry.attributes[name].normalized,
      );
      assert.ok(actual.every(Number.isFinite));
    }
    assert.equal(
      sha256(new Uint8Array(reference.markings.mesh.geometry.index.array.buffer)),
      manifest.attributes.index,
    );
    const expectedQuads = paintQuadMultiset(reference.markings.mesh.geometry);
    assert.equal(
      paintQuadMultiset(baked.mesh.geometry),
      expectedQuads,
      'every source quad retains its raw attributes, clipping, height and winding',
    );
    fallback = buildMappedCrossingMarkings(new THREE.Scene(), prepared.data.roads, reference.context);
    assert.equal(fallback.mesh.isBatchedMesh, true);
    assert.deepEqual(fallback.stats, baked.stats);
    assert.equal(
      paintQuadMultiset(fallback.mesh.geometry),
      expectedQuads,
      'the runtime fallback renders the same complete quads',
    );
    const coverage = collectMappedCrossings(prepared.data.roads);
    assert.equal(baked.records.length, coverage.records.length);
    for (const record of coverage.records) {
      const segment = record.segments[0],
        x = (segment.a[0] + segment.b[0]) / 2,
        z = (segment.a[1] + segment.b[1]) / 2;
      assert.equal(
        baked.covers(x, z, -segment.uz, segment.ux),
        coverage.covers(x, z, -segment.uz, segment.ux),
      );
    }
    assert.equal(scene.children.length, 1);
    assert.equal(baked.mesh.receiveShadow, true);
    assert.equal(baked.mesh.geometry.attributes.position.count, manifest.stats.paintQuads * 4);
    t.diagnostic(
      JSON.stringify({
        runtimeBuilderMs: Math.round(reference.buildMs),
        bakedMeshMs: Math.round(buildMs),
        inputValidationMs: Math.round(validated.validationMs),
        vertices: manifest.layout.vertexCount,
        curbBuilderMs: Math.round(reference.curbBuildMs),
        curbs: validated.surveyedCurbs.length,
      }),
    );
    let geometryDisposed = false,
      materialDisposed = false;
    baked.mesh.geometry.addEventListener('dispose', () => {
      geometryDisposed = true;
    });
    baked.mesh.material.addEventListener('dispose', () => {
      materialDisposed = true;
    });
    baked.dispose();
    baked = null;
    assert.equal(scene.children.length, 0);
    assert.ok(geometryDisposed && materialDisposed);
  } finally {
    fallback?.dispose();
    baked?.dispose();
    reference.dispose();
  }
});

test('missing, corrupt, incompatible, and stale-generator assets give explicit recoverable reasons', async () => {
  const corrupted = await loadBakedCrossings({
    generatorHashes,
    fetchImpl: async (url) => {
      const response = await fileFetch(url),
        bytes = new Uint8Array(await response.arrayBuffer());
      if (url.href === BAKED_CROSSINGS_URLS.binary.href) bytes[80] ^= 1;
      return new Response(bytes);
    },
  });
  assert.equal(corrupted.ok, false);
  assert.match(corrupted.reason, /binary SHA-256 mismatch/);
  const changedGenerator = await loadBakedCrossings({
    generatorHashes: { ...generatorHashes, 'app/mapped-crossings.js': 'changed generator' },
    fetchImpl: fileFetch,
  });
  assert.equal(changedGenerator.ok, false);
  assert.match(changedGenerator.reason, /generator changed: app\/mapped-crossings.js/);
  for (const patch of [{ version: 100 }, { threeRevision: '1' }, { layout: { vertexCount: 3 } }]) {
    const result = await loadBakedCrossings({
      generatorHashes,
      fetchImpl: async (url) =>
        url.href === BAKED_CROSSINGS_URLS.manifest.href
          ? new Response(JSON.stringify({ ...manifest, ...patch }))
          : fileFetch(url),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /version|Three.js|vertex budget/);
  }
  const missing = await loadBakedCrossings({
    generatorHashes,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /could not be loaded \(404\)/);
  assert.throws(() => createBakedCrossingMarkings(new THREE.Scene(), [], loaded), /inputs were not verified/);
});

test('effective input checks reject changed coordinates, width, layer, bridge, tunnel, transit and crossing tags', async () => {
  const road = {
    id: 'fixture',
    kind: 'footway',
    width: 3,
    layer: 0,
    bridge: false,
    tunnel: false,
    transitOnly: false,
    footway: 'crossing',
    sourceTags: { 'crossing:markings': 'lines' },
    points: [
      [0, 0],
      [4, 4],
    ],
  };
  const context = { data: { roads: [road], rails: [], waters: [] }, surfaceData: { surfaces: [] } };
  const original = (await fingerprintCrossingInputs(context)).hashes;
  for (const [key, value] of Object.entries({
    kind: 'cycleway',
    width: 4,
    layer: 1,
    bridge: true,
    tunnel: true,
    transitOnly: true,
    points: [
      [0, 0],
      [5, 4],
    ],
    sourceTags: { 'crossing:markings': 'ladder' },
  })) {
    const changed = { ...context, data: { ...context.data, roads: [{ ...road, [key]: value }] } };
    assert.notEqual((await fingerprintCrossingInputs(changed)).hashes.roads, original.roads, key);
  }
  const originalWidth = prepared.data.roads[0].width;
  prepared.data.roads[0].width = 0.501;
  const staleRoad = await validateBakedCrossings(loaded, prepared);
  if (originalWidth === undefined) delete prepared.data.roads[0].width;
  else prepared.data.roads[0].width = originalWidth;
  assert.equal(staleRoad.ok, false);
  assert.match(staleRoad.reason, /input changed: roads/);
  const badSurfaces = await validateBakedCrossings(loaded, { ...prepared, surfaceData: { surfaces: [] } });
  assert.equal(badSurfaces.ok, false);
  assert.match(badSurfaces.reason, /input changed: surfaces/);
  const values = prepared.terrain.grids[0].values,
    originalSample = values[0];
  values[0] = originalSample + 0.25;
  const badTerrain = await validateBakedCrossings(loaded, prepared);
  values[0] = originalSample;
  assert.equal(badTerrain.ok, false);
  assert.match(badTerrain.reason, /input changed: terrainSamples/);
  const validated = await validateBakedCrossings(loaded, prepared);
  assert.equal(validated.ok, true, validated.reason);
  const originalTransitOnly = prepared.data.roads[0].transitOnly;
  prepared.data.roads[0].transitOnly = !prepared.data.roads[0].transitOnly;
  assert.throws(
    () => createBakedCrossingMarkings(new THREE.Scene(), prepared.data.roads, validated),
    /roads changed after verification/,
  );
  if (originalTransitOnly === undefined) delete prepared.data.roads[0].transitOnly;
  else prepared.data.roads[0].transitOnly = originalTransitOnly;
});

test('invalid curb recipes fail validation and retain the runtime fallback', async () => {
  for (const kind of ['source', 'part', 'fraction']) {
    const bytes = new Uint8Array(await (await fileFetch(BAKED_CROSSINGS_URLS.binary)).arrayBuffer()),
      view = new DataView(bytes.buffer),
      curbs = manifest.layout.curbs;
    if (kind === 'source') view.setUint32(curbs.sourceByteOffset, 0xffffffff, true);
    if (kind === 'part') view.setUint32(curbs.sourceByteOffset + 12, 0xfffffffc, true);
    if (kind === 'fraction') view.setFloat64(curbs.fractionByteOffset, 2, true);
    const edited = { ...manifest, binarySha256: sha256(bytes) },
      loaded = await loadBakedCrossings({
        generatorHashes,
        fetchImpl: (url) =>
          Promise.resolve(
            new Response(url.href === BAKED_CROSSINGS_URLS.manifest.href ? JSON.stringify(edited) : bytes),
          ),
      });
    assert.equal(loaded.ok, true, loaded.reason);
    const validated = await validateBakedCrossings(loaded, prepared);
    assert.equal(validated.ok, false, kind);
    assert.match(validated.reason, /Surveyed curb .*out of bounds/, kind);
    assert.equal(validated.surveyedCurbs, undefined);
  }
});

test('neighbourhood relief follows the same triangles used by paving and road markings', () => {
  const { terrain } = prepared;
  for (const [x, z] of [
    [680, -1270],
    [2440, -1690],
    [-1098, 1790],
    [1692, 1190],
  ])
    assert.ok(terrain.regionalOffsetAt(x, z) > 15, `Missing neighbourhood grade at ${x},${z}`);
  assert.equal(terrain.regionalOffsetAt(0, -833), 0);

  const slab = new THREE.BufferGeometry();
  slab.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([640, 0.15, -1264, 679, 0.15, -1237, 696, 0.15, -1287], 3),
  );
  const draped = terrain.drapeGeometry(slab);
  const { position } = draped.attributes;
  assert.ok(draped.index.count > 3);
  for (let i = 0; i < draped.index.count; i += 3) {
    const a = draped.index.getX(i),
      b = draped.index.getX(i + 1),
      c = draped.index.getX(i + 2);
    const middle = (sample) =>
      (sample.call(position, a) + sample.call(position, b) + sample.call(position, c)) / 3;
    assert.ok(
      Math.abs(
        middle(position.getY) - 0.15 - terrain.offsetAt(middle(position.getX), middle(position.getZ)),
      ) < 2e-4,
    );
  }
  draped.dispose();
});

test('westbound Memorial Drive retains its covered floor and a separate upper grade', () => {
  const { data, terrain } = prepared;
  const crossing = createMemorialUnderpass(data, terrain);
  const [a, b] = crossing.road.points;
  const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  assert.equal(crossing.groundHeight(...middle, 0.25), 0.16);
  assert.equal(crossing.groundHeight(...middle, 6), null);
  assert.equal(crossing.heightAt(...a, crossing.road), 0.16);
  assert.equal(crossing.heightAt(...b, crossing.road), 0.16);
  assert.equal(
    makeRoadGraph(data.roads, crossing.allows).edges.filter(({ road }) => road === crossing.road).length,
    1,
  );
  function panel([x, z]) {
    return new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([x - 0.5, 6, z, x, 6, z - 0.5, x + 0.5, 6, z], 3),
    );
  }
  const roof = panel(middle);
  assert.equal(crossing.cutSurface(roof), roof);
  const mouth = crossing.cutSurface(panel(a));
  assert.equal(mouth.attributes.position.count, 0);
  mouth.dispose();
  roof.dispose();
});

test('the upper Centre Street south joint supports cars across the ramp/deck wedge', () => {
  const { data, terrain } = prepared;
  const surface = createInfrastructureSurfaces(data, { terrain });
  const x = 651.268,
    hint = 7.44;
  for (let z = -668.7; z > -669.2; z -= 0.004)
    assert.ok(Math.abs((surface.groundHeight(x, z, hint) ?? -100) - hint) < 0.06, `Lost deck at ${z}`);
  assert.equal(surface.groundHeight(x, -668.858, 0.2), null, 'the deck cannot grab a traveller below');
});
