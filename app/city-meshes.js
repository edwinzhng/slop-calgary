import * as THREE from 'three/webgpu';
import { createMeshHeightCache } from './mesh-height-cache.js';
import { unpackCityMeshTransport } from './city-mesh-transport.js';
import { unpackMapDataTransport } from './map-data-transport.js';
import { readAssetBytes } from './asset-bytes.js';

export const CITY_MESH_MANIFEST_URL = new URL('../data/calgary-meshes.json', import.meta.url);
export const CITY_MESH_BINARY_URL = new URL('../data/calgary-meshes.bin', import.meta.url);
const CORE_MANIFEST_URL = CITY_MESH_MANIFEST_URL;
const CORE_BINARY_URL = CITY_MESH_BINARY_URL;

/** Load genuine City LiDAR roof/wall surfaces; no API key or runtime GIS library. */
export async function loadCityMeshes({ fetcher = globalThis.fetch, signal, core = false } = {}) {
  const manifestUrl = core ? CORE_MANIFEST_URL : CITY_MESH_MANIFEST_URL,
    binaryUrl = core ? CORE_BINARY_URL : CITY_MESH_BINARY_URL;
  const [manifestResponse, binaryResponse] = await Promise.all([
    fetcher(manifestUrl, { signal }),
    fetcher(binaryUrl, { signal }),
  ]);
  if (!manifestResponse.ok || !binaryResponse.ok)
    throw new Error(
      `City building meshes could not load (${manifestResponse.status}/${binaryResponse.status})`,
    );
  const [manifest, binary] = await Promise.all([
    manifestResponse.json().then(unpackMapDataTransport),
    readAssetBytes(binaryResponse, binaryUrl),
  ]);
  return createCityMeshes(manifest, unpackCityMeshTransport(binary, manifest));
}

/**
 * Decode compact centimeter-scale local vertices into Three geometry on demand.
 * Each geometry belongs to its caller. It is not retained in a second GPU/CPU
 * cache, so the renderer can merge building tiles and dispose the source objects.
 *
 * Integration: apply the existing landmark exclusion first, then replace that
 * building's extrusion with createGeometry(b.id). Omit inferred roof details for
 * records with a real mesh. get(b.id).height is the measured maximum above local
 * ground; ground/groundMin/groundMax retain the original absolute elevations.
 */
export function createCityMeshes(manifest, binary) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.buildings))
    throw new Error('Unsupported City mesh manifest');
  const array =
    binary instanceof ArrayBuffer
      ? new Uint8Array(binary)
      : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  const view = new DataView(array.buffer, array.byteOffset, array.byteLength);
  const expected = [67, 71, 77, 69, 83, 72, 49, 0]; // CGMESH1\0
  if (array.byteLength < 16 || expected.some((value, i) => array[i] !== value))
    throw new Error('Invalid City mesh binary header');
  const quantization = view.getFloat32(12, true);
  if (
    view.getUint32(8, true) !== manifest.buildings.length ||
    Math.abs(quantization - manifest.meta.quantization) > 1e-8 ||
    array.byteLength !== manifest.meta.binaryBytes
  )
    throw new Error('City mesh manifest and binary do not match');
  const records = new Map();
  const compactHeights = new Map();
  for (let i = 0; i < (manifest.compactHeights?.length ?? 0); i += 2)
    compactHeights.set(`city-outline-${manifest.compactHeights[i]}-0`, manifest.compactHeights[i + 1]);
  for (const r of manifest.buildings) {
    const bytes = r.vertexCount * 6 + r.indexCount * r.indexBytes;
    if (
      !r.id ||
      records.has(r.id) ||
      !Number.isInteger(r.offset) ||
      r.offset < 16 ||
      !Number.isInteger(r.vertexCount) ||
      r.vertexCount < 3 ||
      !Number.isInteger(r.indexCount) ||
      r.indexCount < 3 ||
      r.indexCount % 3 ||
      ![2, 4].includes(r.indexBytes) ||
      r.offset + bytes > array.byteLength ||
      !r.origin?.every(Number.isFinite) ||
      !Number.isFinite(r.height)
    )
      throw new Error(`Invalid City mesh record: ${r.id}`);
    records.set(r.id, r);
  }

  // A record reuses indexed vertices across many faces. Keep exact doubles
  // for the face-normal calculation; Float32 intermediates change those normals.
  let decodedVertices = new Float64Array(0);
  function createGeometry(id) {
    const r = records.get(id);
    if (!r) return null;
    const n = r.indexCount,
      positions = new Float32Array(n * 3),
      normals = new Float32Array(n * 3),
      indexOffset = r.offset + r.vertexCount * 6,
      q = manifest.meta.quantization;
    if (decodedVertices.length < r.vertexCount * 3) decodedVertices = new Float64Array(r.vertexCount * 3);
    for (let vertex = 0; vertex < r.vertexCount; vertex++) {
      const source = r.offset + vertex * 6,
        at = vertex * 3;
      decodedVertices[at] = r.origin[0] + view.getInt16(source, true) * q;
      decodedVertices[at + 1] = view.getInt16(source + 2, true) * q;
      decodedVertices[at + 2] = r.origin[1] + view.getInt16(source + 4, true) * q;
    }
    // Use the decimal manifest scale to avoid amplifying float32 header rounding
    // over tall towers. The header is only a version/payload consistency check.
    for (let triangle = 0; triangle < n; triangle += 3) {
      const off = indexOffset + triangle * r.indexBytes;
      const i0 = r.indexBytes === 2 ? view.getUint16(off, true) : view.getUint32(off, true);
      const i1 =
        r.indexBytes === 2
          ? view.getUint16(off + r.indexBytes, true)
          : view.getUint32(off + r.indexBytes, true);
      const i2 =
        r.indexBytes === 2
          ? view.getUint16(off + r.indexBytes * 2, true)
          : view.getUint32(off + r.indexBytes * 2, true);
      if (i0 >= r.vertexCount || i1 >= r.vertexCount || i2 >= r.vertexCount)
        throw new Error(`City mesh index out of range: ${id}`);
      const a = i0 * 3,
        b = i1 * 3,
        c = i2 * 3;
      const ax = decodedVertices[a],
        ay = decodedVertices[a + 1],
        az = decodedVertices[a + 2],
        bx = decodedVertices[b],
        by = decodedVertices[b + 1],
        bz = decodedVertices[b + 2],
        cx = decodedVertices[c],
        cy = decodedVertices[c + 1],
        cz = decodedVertices[c + 2];
      const base = triangle * 3;
      positions[base] = ax;
      positions[base + 1] = ay;
      positions[base + 2] = az;
      positions[base + 3] = bx;
      positions[base + 4] = by;
      positions[base + 5] = bz;
      positions[base + 6] = cx;
      positions[base + 7] = cy;
      positions[base + 8] = cz;
      const abx = bx - ax,
        aby = by - ay,
        abz = bz - az,
        acx = cx - ax,
        acy = cy - ay,
        acz = cz - az;
      const nx = aby * acz - abz * acy,
        ny = abz * acx - abx * acz,
        nz = abx * acy - aby * acx,
        magnitude = Math.hypot(nx, ny, nz) || 1;
      const ux = nx / magnitude,
        uy = ny / magnitude,
        uz = nz / magnitude;
      for (let corner = 0; corner < 3; corner++) {
        const offset = base + corner * 3;
        normals[offset] = ux;
        normals[offset + 1] = uy;
        normals[offset + 2] = uz;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    geometry.userData.cityMesh = {
      id,
      structureIds: r.structureIds,
      ground: r.ground,
      sourceDates: Array.isArray(r.sourceDates) ? r.sourceDates.slice() : [],
    };
    return geometry;
  }

  // Contact queries need the same Float32 positions, without expanded face
  // normals or UVs. Decode each indexed source vertex once on a cold contact;
  // the bounded CPU cache expands only its local projection representation.
  function createContactProjection(id) {
    const r = records.get(id);
    if (!r) return null;
    const positions = new Float32Array(r.vertexCount * 3),
      indices = r.indexBytes === 2 ? new Uint16Array(r.indexCount) : new Uint32Array(r.indexCount),
      q = manifest.meta.quantization,
      indexOffset = r.offset + r.vertexCount * 6;
    for (let i = 0; i < r.vertexCount; i++) {
      const at = r.offset + i * 6;
      positions[i * 3] = r.origin[0] + view.getInt16(at, true) * q;
      positions[i * 3 + 1] = view.getInt16(at + 2, true) * q;
      positions[i * 3 + 2] = r.origin[1] + view.getInt16(at + 4, true) * q;
    }
    for (let i = 0; i < r.indexCount; i++) {
      const at = indexOffset + i * r.indexBytes,
        value = r.indexBytes === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
      if (value >= r.vertexCount) throw new Error(`City mesh index out of range: ${id}`);
      indices[i] = value;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
  }
  const contacts = createMeshHeightCache(createContactProjection);
  const undersides = createMeshHeightCache(createContactProjection, { minimum: true });
  return {
    manifest,
    count: records.size,
    stats: manifest.meta.counts,
    compactHeight: (id) => compactHeights.get(id),
    has: (id) => records.has(id),
    get: (id) => records.get(id) || null,
    createGeometry,
    collisionHeightAt: contacts.heightAt,
    collisionBottomAt: undersides.heightAt,
    contactStats: contacts.stats,
    clearContactCache() {
      contacts.clear();
      undersides.clear();
    },
  };
}
