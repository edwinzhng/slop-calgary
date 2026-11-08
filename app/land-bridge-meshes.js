import * as THREE from 'three/webgpu';
import { createCityMeshes } from './city-meshes.js';
import { createMeshHeightSampler } from './mesh-height-envelope.js';

export const LAND_BRIDGE_MANIFEST_URL = new URL('../data/LAND_BRIDGE_EVIDENCE_MESHES.json', import.meta.url);
export const LAND_BRIDGE_BINARY_URL = new URL('../data/LAND_BRIDGE_EVIDENCE_MESHES.bin', import.meta.url);
export const LAND_BRIDGE_BINARY_SHA256 = '1ba4a75594c5b15fa60f4290b478d51213a7d386a37a2445b08294b9ae7b7323';
export const LAND_BRIDGE_MANIFEST_SHA256 = 'f42a459dd5a34918bdef2b0cf02d537d47ac7ff92b4672bace93b1a3ff3e3dd6';
export const LAND_BRIDGE_MODEL_IDS = Object.freeze(['land-plus15-city-1095', 'land-plus15-city-1810']);
const EXPECTED = Object.freeze({
  'land-plus15-city-1095': {
    structureId: 1095,
    bridgeId: '1577',
    vertices: 27,
    indices: 138,
    min: 4.5,
    max: 10.04,
    ground: 1047.89,
    caps: 9,
  },
  'land-plus15-city-1810': {
    structureId: 1810,
    bridgeId: '1570',
    vertices: 149,
    indices: 738,
    min: 5.6,
    max: 12.06,
    ground: 1048.915,
    caps: 36,
  },
});
const EPS = 1e-8;
const binaryBytes = (binary) =>
  binary instanceof ArrayBuffer
    ? new Uint8Array(binary)
    : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
function fnv1a(bytes) {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}
function triangleHeight(face, x, z) {
  const [a, b, c] = face,
    abx = b[0] - a[0],
    abz = b[2] - a[2],
    acx = c[0] - a[0],
    acz = c[2] - a[2],
    det = abx * acz - abz * acx;
  if (Math.abs(det) < EPS) return null;
  const u = ((x - a[0]) * acz - (z - a[2]) * acx) / det,
    v = (abx * (z - a[2]) - abz * (x - a[0])) / det;
  if (u < -EPS || v < -EPS || u + v > 1 + EPS) return null;
  return a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
}
function extremumAt(faces, x, z, minimum) {
  let height = null;
  for (const face of faces) {
    const y = triangleHeight(face, x, z);
    if (y !== null) height = height === null ? y : minimum ? Math.min(height, y) : Math.max(height, y);
  }
  return height;
}

/** Two identified, actual City enclosed +15 envelopes. Their source undersides
 * are NOT walking slab tops. This provider never owns a road or invents access.
 * All heights remain relative to the original per-record City mean ground. */
export function createLandBridgeMeshes(manifest, binary) {
  const bytes = binaryBytes(binary);
  if (
    bytes.byteLength !== 2824 ||
    fnv1a(bytes) !== 3462142704 ||
    manifest?.meta?.binarySha256 !== LAND_BRIDGE_BINARY_SHA256 ||
    manifest?.meta?.quantization !== 0.02
  )
    throw new Error('Land bridge source payload differs from the independently validated City shells');
  // Vertex offsets, world origins and collision polygons are part of the exact
  // source contract too. A matching binary cannot authorize moved geometry or
  // an altered ground-filled collider from mismatched metadata.
  if (fnv1a(new TextEncoder().encode(JSON.stringify(manifest))) !== 1790519409)
    throw new Error('Land bridge metadata differs from the independently validated source manifest');
  const source = createCityMeshes(manifest, bytes),
    byId = new Map(),
    active = new Set();
  if (source.count !== LAND_BRIDGE_MODEL_IDS.length)
    throw new Error('Unexpected land bridge source owner count');
  for (const id of LAND_BRIDGE_MODEL_IDS) {
    const record = source.get(id),
      expected = EXPECTED[id];
    if (
      !record ||
      record.structureIds?.length !== 1 ||
      record.structureIds[0] !== expected.structureId ||
      record.officialBridgeId !== expected.bridgeId ||
      record.official?.structure_type !== 'Bridge Enclosed' ||
      record.vertexCount !== expected.vertices ||
      record.indexCount !== expected.indices ||
      record.minHeight !== expected.min ||
      record.height !== expected.max ||
      record.ground !== expected.ground ||
      record.lowerCapTriangleIndices?.length !== expected.caps ||
      record.sourceType !== 'officially-identified-enclosed-city-plus15-shell'
    )
      throw new Error(`Ambiguous land bridge identity, cap or height datum: ${id}`);
    const geometry = source.createGeometry(id),
      p = geometry.getAttribute('position'),
      n = geometry.getAttribute('normal'),
      caps = new Set(record.lowerCapTriangleIndices),
      allFaces = [],
      floor = [],
      upper = [];
    try {
      if (!p.array.every(Number.isFinite) || !n.array.every(Number.isFinite))
        throw new Error(`Invalid land bridge coordinates: ${id}`);
      for (let i = 0; i < p.count; i += 3) {
        const face = [0, 1, 2].map((j) => [p.getX(i + j), p.getY(i + j), p.getZ(i + j)]);
        allFaces.push(face);
        if (caps.has(i / 3)) {
          if (n.getY(i) > -0.5 || face.some((v) => v[1] > record.lowerCapYRange[1] + 0.001))
            throw new Error(`Actual lower cap must face downward: ${id}`);
          floor.push(face);
        } else if (Math.abs(n.getY(i)) > 0.01) upper.push(face);
      }
      if (
        !floor.length ||
        !upper.length ||
        !Array.isArray(record.collisionFootprint?.ring) ||
        record.collisionFootprint.ring.length < 4 ||
        record.collisionFootprint.ring.some((v) => v.length !== 2 || !v.every(Number.isFinite))
      )
        throw new Error(`Missing land bridge collision envelope: ${id}`);
    } finally {
      geometry.dispose();
    }
    byId.set(id, {
      record,
      floor,
      upper,
      // Include measured wall edges too: a wall can extend a few millimetres
      // below an adjacent triangulated cap at quantized source boundaries.
      lowerContact: createMeshHeightSampler(allFaces, { minimum: true }),
      upperContact: createMeshHeightSampler(allFaces),
    });
  }
  // This release proves no complete coarse baseline companion. Refuse any
  // future suppression until its area/identity proof receives its own tests.
  if (manifest.meta.companionProofs?.length !== 0)
    throw new Error('Unvalidated land bridge companion ownership');
  const sourceHeightAt = (id, x, z, minimum) => {
    const entry = byId.get(id);
    return entry ? extremumAt(minimum ? entry.floor : entry.upper, x, z, minimum) : null;
  };
  return {
    ready: true,
    manifest,
    modelIds: LAND_BRIDGE_MODEL_IDS,
    count: byId.size,
    get: (id) => byId.get(id)?.record || null,
    has: (id) => byId.has(id),
    createGeometry: (id) => source.createGeometry(id),
    // Activating a body is a renderer decision, never a side effect of loading.
    markRendered(id, rendered = true) {
      if (!byId.has(id)) throw new Error(`Unknown land bridge owner: ${id}`);
      if (rendered) active.add(id);
      else active.delete(id);
    },
    isRendered: (id) => active.has(id),
    lowerHeightAt: (id, x, z) => sourceHeightAt(id, x, z, true),
    upperHeightAt: (id, x, z) => sourceHeightAt(id, x, z, false),
    collisionParts(id, { heightOffset = 0, activeOnly = true } = {}) {
      if (!Number.isFinite(heightOffset)) throw new Error('Land bridge terrain offset must be finite');
      const entry = byId.get(id);
      if (!entry || (activeOnly && !active.has(id))) return [];
      const r = entry.record;
      return [
        {
          id: `${id}-collision`,
          sourceModelId: id,
          ...r.collisionFootprint,
          sourceType: r.sourceType,
          sourceDates: r.sourceDates,
          sourceDateMeaning: manifest.meta.sourceRecordDateMeaning,
          sourceRoadIds: r.sourceRoadIds,
          officialBridgeId: r.officialBridgeId,
          geometryMeasured: true,
          inferredWalls: false,
          solidInteriorInferred: true,
          collisionEnvelope: 'measured-enclosed-shell-lower-to-upper',
          minHeight: r.minHeight + heightOffset,
          height: r.height + heightOffset,
          minHeightAt: (x, z, body) => entry.lowerContact(x, z, body) + heightOffset,
          heightAt: (x, z, body) => entry.upperContact(x, z, body) + heightOffset,
          ground: r.ground,
          groundMin: r.groundMin,
          groundMax: r.groundMax,
          terrainHeightOffset: heightOffset,
          storefrontAnchor: false,
        },
      ];
    },
    coveredFallbacks: () => [],
    stats: {
      measuredEnclosedShells: byId.size,
      measuredTriangles: manifest.meta.counts.triangles,
      lowerCapWindingRepairs: manifest.meta.counts.lowerCapWindingRepairs,
      inferredWalkingSurfaces: 0,
      suppressedCompanions: 0,
    },
  };
}

export async function loadLandBridgeMeshes({ fetcher = globalThis.fetch, signal } = {}) {
  const [jsonResponse, binaryResponse] = await Promise.all([
    fetcher(LAND_BRIDGE_MANIFEST_URL, { signal }),
    fetcher(LAND_BRIDGE_BINARY_URL, { signal }),
  ]);
  if (!jsonResponse.ok || !binaryResponse.ok)
    throw new Error(
      `Land bridge shells could not load (${jsonResponse.status}/${binaryResponse.status}); retain existing source ownership`,
    );
  const [manifest, binary] = await Promise.all([jsonResponse.json(), binaryResponse.arrayBuffer()]);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', binary),
      hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (hash !== LAND_BRIDGE_BINARY_SHA256) throw new Error('Land bridge binary SHA256 mismatch');
  }
  return createLandBridgeMeshes(manifest, binary);
}

/** Optional bounded two-draw builder. Materials are illustrative unless supplied
 * by the caller; all source vertex/normal attributes remain untouched. */
export function buildLandBridgeMeshes(
  scene,
  provider,
  { material, groundOffsetFor = () => 0, cullDistance = 1800 } = {},
) {
  const ownsMaterial = !material,
    surface =
      material ||
      new THREE.MeshStandardMaterial({
        color: 0x8f999c,
        roughness: 0.6,
        metalness: 0.15,
        side: THREE.FrontSide,
      }),
    meshes = [],
    offsets = new Map();
  try {
    for (const id of provider.modelIds) {
      const record = provider.get(id),
        offset = groundOffsetFor(record);
      if (!Number.isFinite(offset)) throw new Error(`Invalid land bridge terrain offset: ${id}`);
      const geometry = provider.createGeometry(id),
        mesh = new THREE.Mesh(geometry, surface);
      mesh.name = id;
      mesh.position.y = offset;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.landBridgeSource = {
        id,
        officialBridgeId: record.officialBridgeId,
        sourceRoadIds: record.sourceRoadIds,
        walkingSurfaceInferred: false,
      };
      geometry.computeBoundingSphere();
      scene.add(mesh);
      meshes.push(mesh);
      offsets.set(id, offset);
      provider.markRendered(id);
    }
  } catch (error) {
    for (const mesh of meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      provider.markRendered(mesh.name, false);
    }
    if (ownsMaterial) surface.dispose();
    throw error;
  }
  return {
    meshes,
    collisionParts: () =>
      provider.modelIds.flatMap((id) => provider.collisionParts(id, { heightOffset: offsets.get(id) })),
    update(position) {
      for (const mesh of meshes) {
        const sphere = mesh.geometry.boundingSphere,
          x = position.x ?? position[0],
          z = position.z ?? position[2] ?? position[1];
        mesh.visible = Math.hypot(x - sphere.center.x, z - sphere.center.z) <= cullDistance + sphere.radius;
      }
    },
    dispose() {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        provider.markRendered(mesh.name, false);
      }
      if (ownsMaterial) surface.dispose();
    },
  };
}
