import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { emitCompressedAsset } from './startup-assets.mjs';
import {
  MAP_COORDINATE_SCALES,
  MAP_COORDINATE_SEQUENCE,
  MAP_BINARY_COORDINATES,
  MAP_DATA_TRANSPORT,
  MAP_NEGATIVE_ZERO,
  MAP_RECORDS,
  MAP_COLUMNS,
  unpackBinaryMapData,
  unpackMapDataTransport,
} from '../app/map-data-transport.js';

export function packMapDataTransport(data, { records = true } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Map data transport requires a source object');
  const compact = (node) => {
    // JSON.stringify normally changes -0 into 0, even in uncompressed records.
    if (Object.is(node, -0)) return [MAP_NEGATIVE_ZERO];
    if (Array.isArray(node)) {
      if (
        [
          MAP_COORDINATE_SEQUENCE,
          MAP_BINARY_COORDINATES,
          MAP_NEGATIVE_ZERO,
          MAP_RECORDS,
          MAP_COLUMNS,
          MAP_DATA_TRANSPORT,
        ].includes(node[0])
      )
        throw new Error('Map source data uses a reserved transport marker');
      if (
        node.length >= 3 &&
        node.every(
          (p) =>
            Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && !Object.is(n, -0)),
        )
      ) {
        // Choose an exact decimal representation; never round a source coordinate.
        const scale = MAP_COORDINATE_SCALES.find((q) =>
          node.every((p) =>
            p.every((n) => Number.isSafeInteger(Math.round(n * q)) && Math.round(n * q) / q === n),
          ),
        );
        if (scale) {
          const result = [MAP_COORDINATE_SEQUENCE, scale];
          let x = 0,
            z = 0;
          for (const point of node) {
            const nextX = Math.round(point[0] * scale),
              nextZ = Math.round(point[1] * scale),
              dx = nextX - x,
              dz = nextZ - z;
            if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dz)) return node.map(compact);
            result.push(dx, dz);
            x = nextX;
            z = nextZ;
          }
          return result;
        }
      }
      const values = node.map(compact);
      if (
        records &&
        node.length >= 4 &&
        node.every((value) => value && !Array.isArray(value) && typeof value === 'object')
      ) {
        const schemas = [],
          schemaIds = new Map(),
          columns = [],
          order = values.map((value) => {
            const keys = Object.keys(value),
              signature = JSON.stringify(keys);
            let id = schemaIds.get(signature);
            if (id === undefined) {
              id = schemas.length;
              schemaIds.set(signature, id);
              schemas.push(keys);
              columns.push(keys.map(() => []));
            }
            for (let k = 0; k < keys.length; k++) columns[id][k].push(value[keys[k]]);
            return id;
          }),
          table = [MAP_COLUMNS, schemas, order, columns];
        if (JSON.stringify(table).length < JSON.stringify(values).length * 0.95) return table;
      }
      return values;
    }
    if (node && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, compact(value)]));
    return node;
  };
  return [MAP_DATA_TRANSPORT, compact(data)];
}

export const MAP_TRANSPORT_SOURCES = Object.freeze([
  ['main', 'calgary'],
  ['main', 'calgary-surfaces'],
  ['main', 'calgary-parks'],
  ['main', 'calgary-trees'],
  ['main', 'calgary-places'],
  ['main', 'calgary-signals'],
  ['main', 'calgary-transit'],
  ['city-meshes', 'calgary-meshes'],
  ['copc-roofs', 'calgary-copc-roofs'],
  ['road-attributes', 'calgary-road-attributes'],
  ['street-details', 'calgary-street-details'],
  ['surveyed-lighting', 'calgary-lighting'],
]);

const binaryMaps = new Set(['calgary', 'calgary-surfaces', 'calgary-parks']);

// These feeds carry duplicate lat/lon and inventory fields. The renderer uses
// the projected coordinates and model inputs, while attribution stays intact.
const treeFields = ['id', 'x', 'z', 'genus', 'species', 'name', 'type', 'matureSize', 'dbh', 'heritage'];
const lightFields = ['id', 'x', 'z', 'type', 'heading', 'pathBridge'];
function selectFields(records, fields) {
  return records.map((record) =>
    Object.fromEntries(
      fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]),
    ),
  );
}

export function packBinaryMapData(packed) {
  const bytes = [];
  const extract = (node) => {
    if (Array.isArray(node)) {
      if (node[0] === MAP_COORDINATE_SEQUENCE && node.slice(2).every((v) => (v | 0) === v)) {
        for (let i = 2; i < node.length; i++) {
          let value = ((node[i] << 1) ^ (node[i] >> 31)) >>> 0;
          while (value >= 128) {
            bytes.push((value & 127) | 128);
            value >>>= 7;
          }
          bytes.push(value);
        }
        return [MAP_BINARY_COORDINATES, node[1], (node.length - 2) / 2];
      }
      return node.map(extract);
    }
    if (node && typeof node === 'object') for (const key of Object.keys(node)) node[key] = extract(node[key]);
    return node;
  };
  const json = Buffer.from(JSON.stringify(extract(packed)));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length);
  return Buffer.concat([header, json, Buffer.from(bytes)]);
}

/** Compact required downloads without changing their authoring sources. */
export function mapDataTransportPlugin(root) {
  return {
    name: 'map-data-transport',
    apply: 'build',
    async transform(code, id) {
      const sources = MAP_TRANSPORT_SOURCES.filter(([owner]) => id === join(root, `app/${owner}.js`));
      if (!sources.length) return;
      for (const [, name, options] of sources) {
        const path = join(root, `data/${name}.json`),
          url = `new URL('../data/${name}.json', import.meta.url)`;
        if (!code.includes(url)) throw new Error(`Map asset URL could not be transformed: ${name}`);
        const original = JSON.parse(await readFile(path, 'utf8'));
        if (name === 'calgary-trees') original.trees = selectFields(original.trees, treeFields);
        if (name === 'calgary-lighting') original.records = selectFields(original.records, lightFields);
        const packed = packMapDataTransport(original, options);
        const binary = binaryMaps.has(name) ? packBinaryMapData(packed) : null;
        const json = binary ? null : JSON.stringify(packed);
        const restored = binary
          ? unpackBinaryMapData(Uint8Array.from(binary).buffer)
          : unpackMapDataTransport(JSON.parse(json));
        if (!isDeepStrictEqual(restored, original) || JSON.stringify(restored) !== JSON.stringify(original))
          throw new Error(`Map transport failed its lossless build check: ${name}`);
        this.addWatchFile(path);
        if (binary) {
          code = code.replace(url, emitCompressedAsset(this, name, `data/${name}.json`, binary));
          continue;
        }
        const reference = this.emitFile({
          type: 'asset',
          name: `${name}.json`,
          originalFileName: `data/${name}.json`,
          source: json,
        });
        code = code.replace(url, `new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)`);
      }
      return { code, map: null };
    },
  };
}
