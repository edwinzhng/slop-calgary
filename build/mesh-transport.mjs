import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { emitCompressedAsset } from './startup-assets.mjs';
import { packMapDataTransport } from './map-data-transport.mjs';
import {
  CITY_MESH_TRANSPORT_HEADER_BYTES,
  CITY_MESH_TRANSPORT_CACHE_WORDS,
  CITY_MESH_TRANSPORT_MAGIC,
  unpackCityMeshTransport,
  validateCityMeshSource,
} from '../app/city-mesh-transport.js';

/** Group coordinates, cache recent source words, then write unsigned varints. */
export function packCityMeshTransport(binary, manifest) {
  const source = validateCityMeshSource(binary, manifest);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const output = new Uint8Array(Math.ceil(source.byteLength * 1.5) + CITY_MESH_TRANSPORT_HEADER_BYTES);
  output.set(CITY_MESH_TRANSPORT_MAGIC);
  new DataView(output.buffer).setUint32(8, source.byteLength, true);
  output.set(source.subarray(0, 16), 12);
  let cursor = CITY_MESH_TRANSPORT_HEADER_BYTES;
  const cache = new Uint32Array(CITY_MESH_TRANSPORT_CACHE_WORDS);
  const write = (value) => {
    while (value >= 128) {
      output[cursor++] = (value & 127) | 128;
      // A uint32 delta with a cache prefix can exceed the bitwise uint32 range.
      value = Math.floor(value / 128);
    }
    output[cursor++] = value;
  };
  const words = (offset, count, stride, bits) => {
    let previous = 0,
      cached = 0;
    for (let i = 0; i < count; i++) {
      const at = offset + i * stride;
      const value = bits === 16 ? view.getUint16(at, true) : view.getUint32(at, true);
      let position = 0;
      while (position < cached && cache[position] !== value) position++;
      if (position < cached) write(position);
      else {
        const delta = bits === 16 ? ((value - previous) << 16) >> 16 : (value - previous) | 0;
        write((((delta << 1) ^ (delta >> 31)) >>> 0) + CITY_MESH_TRANSPORT_CACHE_WORDS);
      }
      if (position === cached && cached < CITY_MESH_TRANSPORT_CACHE_WORDS) cached++;
      if (position === CITY_MESH_TRANSPORT_CACHE_WORDS) position--;
      while (position > 0) {
        cache[position] = cache[position - 1];
        position--;
      }
      cache[0] = value;
      previous = value;
    }
  };
  for (let axis = 0; axis < 3; axis++)
    for (const r of manifest.buildings) words(r.offset + axis * 2, r.vertexCount, 6, 16);
  for (const r of manifest.buildings)
    words(r.offset + r.vertexCount * 6, r.indexCount, r.indexBytes, r.indexBytes * 8);
  return output.slice(0, cursor);
}

const DETAIL_AREAS = [
  [425, -110, 900],
  [-1120, -725, 200],
  [1510, -280, 250],
  [-660, 880, 200],
  [2510, 460, 200],
];

// Explicit owner modules keep production output independent of local audit files.
const DETAIL_SOURCES = [
  'app/building-foundations.js',
  'app/building-ownership.js',
  'app/discovery-spots.js',
  'app/hayden-block.js',
  'app/king-eddy-detail.js',
  'app/landmark-ground.js',
  'app/landmark-telus.js',
  'app/landmarks.js',
  'app/neighborhood-details.js',
  'app/observed-building-materials.js',
  'app/park-structures.js',
  'app/partial-city-buildings.js',
  'app/simmons-evidence.js',
  'app/sunnyside-flood-barrier.js',
  'app/world.js',
  'data/imagery.json',
];

async function coreMeshSource(root, manifest, source) {
  const files = await Promise.all(DETAIL_SOURCES.map((name) => readFile(join(root, name), 'utf8')));
  const protectedIds = new Set(files.flatMap((contents) => contents.match(/city-outline-\d+-\d+/g) || []));
  const buildings = [],
    compactHeights = [],
    parts = [Buffer.from(source.subarray(0, 16))];
  let offset = 16;
  for (const record of manifest.buildings) {
    const [x, z] = record.origin;
    const id = Number(/^city-outline-(\d+)-0$/.exec(record.id)?.[1]);
    if (
      !Number.isInteger(id) ||
      record.height >= 22 ||
      protectedIds.has(record.id) ||
      DETAIL_AREAS.some(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) <= radius)
    ) {
      const size = record.vertexCount * 6 + record.indexCount * record.indexBytes;
      parts.push(source.subarray(record.offset, record.offset + size));
      buildings.push({ ...record, offset });
      offset += size;
    } else {
      compactHeights.push(id, record.height);
    }
  }
  parts[0].writeUInt32LE(buildings.length, 8);
  const binary = Buffer.concat(parts, offset);
  return {
    binary,
    manifest: {
      ...manifest,
      meta: {
        ...manifest.meta,
        binaryBytes: binary.length,
        binarySha256: createHash('sha256').update(binary).digest('hex'),
        counts: { ...manifest.meta.counts, buildings: buildings.length },
      },
      buildings,
      compactHeights,
    },
  };
}

/** Emit full and core profiles with exact source geometry for each retained record. */
export function cityMeshTransportPlugin(root) {
  const modulePath = join(root, 'app/city-meshes.js'),
    manifestPath = join(root, 'data/calgary-meshes.json'),
    binaryPath = join(root, 'data/calgary-meshes.bin');
  return {
    name: 'city-mesh-transport',
    apply: 'build',
    async transform(code, id) {
      if (id !== modulePath) return;
      const url = "new URL('../data/calgary-meshes.bin', import.meta.url)";
      if (!code.includes(url)) throw new Error('City mesh asset URL could not be transformed');
      const [manifestText, source] = await Promise.all([
          readFile(manifestPath, 'utf8'),
          readFile(binaryPath),
        ]),
        manifest = JSON.parse(manifestText),
        core = await coreMeshSource(root, manifest, source);
      const emitMesh = (bytes, metadata, name) => {
        const packed = packCityMeshTransport(bytes, metadata);
        if (!bytes.equals(unpackCityMeshTransport(packed, metadata)))
          throw new Error('City mesh transport failed its lossless build check');
        return emitCompressedAsset(this, name, 'data/calgary-meshes.bin', packed);
      };
      this.addWatchFile(manifestPath);
      this.addWatchFile(binaryPath);
      for (const name of DETAIL_SOURCES) this.addWatchFile(join(root, name));
      const fullBinary = emitMesh(source, manifest, 'calgary-meshes.bin'),
        coreBinary = emitMesh(core.binary, core.manifest, 'calgary-core-meshes.bin');
      const coreManifest = this.emitFile({
        type: 'asset',
        name: 'calgary-core-meshes.json',
        source: JSON.stringify(packMapDataTransport(core.manifest)),
      });
      return {
        code: code
          .replace(url, fullBinary)
          .replace('const CORE_BINARY_URL = CITY_MESH_BINARY_URL;', `const CORE_BINARY_URL = ${coreBinary};`)
          .replace(
            'const CORE_MANIFEST_URL = CITY_MESH_MANIFEST_URL;',
            `const CORE_MANIFEST_URL = new URL(import.meta.ROLLUP_FILE_URL_${coreManifest}, import.meta.url);`,
          ),
        map: null,
      };
    },
  };
}
