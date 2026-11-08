import * as THREE from 'three/webgpu';
import { collectMappedCrossings } from './mapped-crossings.js';
import { createRoadPaintMaterial, expandRoadPaintBounds } from './reference-streets.js';
import { addSpatialBatches } from './static-batches.js';
import { crossingBytePlanes, isCompressedAsset, readAssetBytes } from './asset-bytes.js';

export const BAKED_CROSSINGS_VERSION = 2;
export const BAKED_CROSSINGS_URLS = Object.freeze({
  manifest: new URL('../data/calgary-mapped-crossings.json', import.meta.url),
  binary: new URL('../data/calgary-mapped-crossings.bin', import.meta.url),
});

// Vite embeds local source fingerprints. Players fetch the mesh and manifest only.
const compiledGenerators =
  typeof __CALGARY_CROSSING_GENERATORS__ === 'undefined' ? null : __CALGARY_CROSSING_GENERATORS__;

const loadedAssets = new WeakSet(),
  validatedAssets = new WeakMap();
const textEncoder = new TextEncoder();
const failure = (reason) => ({ ok: false, reason });
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export async function crossingSha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 verification is unavailable');
  if (typeof bytes === 'string') bytes = textEncoder.encode(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
}

/** Hash effective inputs after attributes, transit restrictions and site patches.
 * Object order is intentionally preserved: nearest-segment ties use source order.
 * Full road records include every crossing/access tag and future road attribute.
 */
export async function fingerprintCrossingInputs({ data, surfaceData, terrain }) {
  const roads = JSON.stringify(data.roads);
  const terrainSamples = (terrain?.grids || []).map(
    (g) => new Uint8Array(g.values.buffer, g.values.byteOffset, g.values.byteLength),
  );
  const sampleBytes = new Uint8Array(terrainSamples.reduce((n, b) => n + b.byteLength, 0));
  let offset = 0;
  for (const bytes of terrainSamples) {
    sampleBytes.set(bytes, offset);
    offset += bytes.byteLength;
  }
  const entries = [
    ['roads', roads],
    [
      'supportMap',
      JSON.stringify({ bbox: data.meta?.bbox ?? null, rails: data.rails || [], waters: data.waters || [] }),
    ],
    ['surfaces', JSON.stringify(surfaceData || {})],
    ['terrainManifest', JSON.stringify(terrain?.manifest || null)],
    ['terrainSamples', sampleBytes],
  ];
  const hashes = Object.fromEntries(
    await Promise.all(entries.map(async ([name, bytes]) => [name, await crossingSha256(bytes)])),
  );
  return { hashes, roads };
}

function manifestProblem(manifest, binary, generatorHashes) {
  if (manifest?.version !== BAKED_CROSSINGS_VERSION) return 'Unsupported crossing bake version';
  if (manifest.threeRevision !== THREE.REVISION)
    return `Crossing bake uses Three.js r${manifest.threeRevision}; runtime is r${THREE.REVISION}`;
  const layout = manifest.layout;
  if (
    !Number.isSafeInteger(layout?.vertexCount) ||
    layout.vertexCount < 0 ||
    layout.vertexCount % 4 ||
    layout.vertexCount > 4_000_000
  )
    return 'Invalid crossing vertex budget or quad layout';
  const count = layout.vertexCount,
    crossingBytes = count * 20,
    curbs = layout.curbs;
  if (
    !Number.isSafeInteger(curbs?.count) ||
    curbs.count < 0 ||
    curbs.count > 1_000_000 ||
    curbs.encoding !== 'source-edge-parts-v1' ||
    !Number.isSafeInteger(curbs.fractionCount) ||
    curbs.fractionCount < 0 ||
    curbs.fractionCount > curbs.count ||
    curbs.sourceByteOffset !== crossingBytes ||
    curbs.fractionByteOffset !== Math.ceil((crossingBytes + curbs.count * 20) / 8) * 8 ||
    curbs.byteLength !== curbs.fractionByteOffset + curbs.fractionCount * 16 - crossingBytes
  )
    return 'Invalid surveyed curb layout';
  if (
    layout.byteOrder !== 'little-endian' ||
    layout.positionByteOffset !== 0 ||
    layout.sideByteOffset !== count * 12 ||
    layout.byteLength !== crossingBytes + curbs.byteLength ||
    binary.byteLength !== layout.byteLength
  )
    return 'Invalid crossing binary layout or length';
  if (manifest.stats?.paintQuads !== count / 4) return 'Crossing paint statistics do not match the binary';
  const sourceNames = Object.keys(generatorHashes).sort();
  if (JSON.stringify(Object.keys(manifest.generators || {}).sort()) !== JSON.stringify(sourceNames))
    return 'Crossing generator manifest does not cover the runtime generator set';
  if (
    !manifest.inputs ||
    !['roads', 'supportMap', 'surfaces', 'terrainManifest', 'terrainSamples'].every((name) =>
      /^[a-f0-9]{64}$/.test(manifest.inputs[name] || ''),
    )
  )
    return 'Missing crossing input fingerprints';
  return null;
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok)
    throw new Error(`${url.pathname.split('/').at(-1)} could not be loaded (${response.status})`);
  return readAssetBytes(response, url);
}

/** Start alongside the other city IO. Any verification failure is recoverable. */
export async function loadBakedCrossings({
  fetchImpl = globalThis.fetch,
  manifestUrl = BAKED_CROSSINGS_URLS.manifest,
  binaryUrl = BAKED_CROSSINGS_URLS.binary,
  generatorHashes = compiledGenerators,
} = {}) {
  const start = performance.now();
  try {
    if (!generatorHashes) return failure('Crossing generator fingerprints are unavailable');
    const [manifestBytes, transport] = await Promise.all([
      fetchBytes(fetchImpl, manifestUrl),
      fetchBytes(fetchImpl, binaryUrl),
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const problem = manifestProblem(manifest, transport, generatorHashes);
    if (problem) return failure(problem);
    const binary = isCompressedAsset(binaryUrl)
      ? crossingBytePlanes(new Uint8Array(transport), manifest.layout, true).buffer
      : transport;
    if ((await crossingSha256(binary)) !== manifest.binarySha256)
      return failure('Crossing binary SHA-256 mismatch');
    for (const [name, hash] of Object.entries(generatorHashes))
      if (hash !== manifest.generators[name]) return failure(`Crossing generator changed: ${name}`);
    const floats = new Float32Array(binary, 0, manifest.layout.vertexCount * 5),
      curbs = manifest.layout.curbs,
      coordinates = new Float64Array(binary, curbs.fractionByteOffset, curbs.fractionCount * 2);
    if (!floats.every(Number.isFinite) || !coordinates.every(Number.isFinite))
      return failure('Crossing binary contains non-finite geometry');
    const baked = { ok: true, manifest, binary, loadMs: performance.now() - start };
    loadedAssets.add(baked);
    return baked;
  } catch (error) {
    return failure(`Crossing bake load failed: ${error.message}`);
  }
}

/** Call after the exact effective-road preparation and before mesh creation. */
export async function validateBakedCrossings(baked, context) {
  if (!baked?.ok) return baked || failure('Crossing bake is unavailable');
  if (!loadedAssets.has(baked)) return failure('Crossing bake was not source-verified');
  const start = performance.now();
  try {
    const fingerprints = await fingerprintCrossingInputs(context);
    for (const [name, hash] of Object.entries(fingerprints.hashes))
      if (hash !== baked.manifest.inputs[name]) return failure(`Crossing input changed: ${name}`);
    const layout = baked.manifest.layout.curbs,
      fractions = new Float64Array(baked.binary, layout.fractionByteOffset, layout.fractionCount * 2),
      sources = new Uint32Array(baked.binary, layout.sourceByteOffset, layout.count * 5),
      polygons = (context.surfaceData?.surfaces || []).filter((p) => p.kind === 'Curb Gutter Sidewalk'),
      surveyedCurbs = [];
    let fraction = 0;
    for (let i = 0; i < layout.count; i++) {
      const at = i * 5,
        polygon = polygons[sources[at]],
        ringIndex = sources[at + 1],
        ring = ringIndex === 0 ? polygon?.ring : polygon?.holes?.[ringIndex - 1],
        edge = sources[at + 2],
        flags = sources[at + 3],
        road = context.data.roads[sources[at + 4]],
        part = Math.floor(flags / 4);
      if (!road || !ring || edge >= ring.length)
        return failure('Surveyed curb source index is out of bounds');
      const originalA = ring[edge],
        originalB = ring[(edge + 1) % ring.length],
        parts = Math.ceil(distance(originalA, originalB) / 8);
      if (part >= parts) return failure('Surveyed curb source part is out of bounds');
      const a = lerp(originalA, originalB, part / parts),
        b = lerp(originalA, originalB, (part + 1) / parts),
        length = distance(a, b),
        sign = flags & 2 ? -1 : 1,
        ta = flags & 1 ? fractions[fraction++] : 0,
        tb = flags & 1 ? fractions[fraction++] : 1;
      if (!(ta >= 0 && tb > ta && tb <= 1 + 1e-12))
        return failure('Surveyed curb clipping fraction is out of bounds');
      surveyedCurbs.push({
        a: lerp(a, b, ta),
        b: lerp(a, b, tb),
        nx: (-(b[1] - a[1]) / length) * sign,
        nz: ((b[0] - a[0]) / length) * sign,
        road,
        polygon,
      });
    }
    if (fraction !== fractions.length) return failure('Surveyed curb clipping fraction count does not match');
    const validated = { ...baked, surveyedCurbs, validationMs: performance.now() - start };
    validatedAssets.set(validated, { roads: fingerprints.roads });
    return validated;
  } catch (error) {
    return failure(`Crossing input verification failed: ${error.message}`);
  }
}

/** Same coverage/mesh/stats/dispose interface as buildMappedCrossingMarkings.
 * Root keeps the runtime builder as the fallback for any !ok result above.
 */
export function createBakedCrossingMarkings(scene, roads, baked) {
  const validated = validatedAssets.get(baked);
  if (!validated) throw new Error(baked?.reason || 'Crossing bake inputs were not verified');
  if (JSON.stringify(roads) !== validated.roads) throw new Error('Crossing roads changed after verification');
  const { manifest, binary } = baked,
    count = manifest.layout.vertexCount;
  const positions = new Float32Array(binary, manifest.layout.positionByteOffset, count * 3);
  const sides = new Float32Array(binary, manifest.layout.sideByteOffset, count * 2);
  const normals = new Float32Array(count * 3),
    paints = new Float32Array(count * 3),
    colors = new Float32Array(count * 3);
  const white = new THREE.Color(0xe4e0d5);
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    normals[at + 1] = 1;
    paints[at + 1] = paints[at + 2] = 1;
    colors[at] = white.r;
    colors[at + 1] = white.g;
    colors[at + 2] = white.b;
  }
  const Indices = count > 65535 ? Uint32Array : Uint16Array;
  const indices = new Indices((count / 4) * 6);
  for (let i = 0, j = 0; i < count; i += 4, j += 6) {
    indices[j] = i;
    indices[j + 1] = i + 1;
    indices[j + 2] = i + 2;
    indices[j + 3] = i;
    indices[j + 4] = i + 2;
    indices[j + 5] = i + 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('side', new THREE.BufferAttribute(sides, 2));
  geometry.setAttribute('paint', new THREE.BufferAttribute(paints, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const mesh = addSpatialBatches(
    scene,
    geometry,
    createRoadPaintMaterial(),
    'Mapped Calgary crossing markings; finish dimensions inferred',
    { expandBounds: expandRoadPaintBounds },
  );
  const coverage = collectMappedCrossings(roads);
  return {
    ...coverage,
    mesh,
    stats: structuredClone(manifest.stats),
    dispose() {
      scene.remove(mesh);
      if (mesh.isBatchedMesh) mesh.dispose();
      else mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
