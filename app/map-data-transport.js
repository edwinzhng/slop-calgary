import { isCompressedAsset, readAssetBytes } from './asset-bytes.js';

export const MAP_DATA_TRANSPORT = 'CGMAP1';
export const MAP_COORDINATE_SEQUENCE = '@calgary/xy1';
export const MAP_BINARY_COORDINATES = '@calgary/xy2';
export const MAP_NEGATIVE_ZERO = '@calgary/negative-zero';
export const MAP_RECORDS = '@calgary/rows1';
export const MAP_COLUMNS = '@calgary/columns1';
export const MAP_COORDINATE_SCALES = [1, 10, 100, 1000, 10000];

const validSchemas = (schemas) =>
  Array.isArray(schemas) &&
  schemas.length > 0 &&
  schemas.every(
    (keys) =>
      Array.isArray(keys) &&
      keys.every((key) => typeof key === 'string') &&
      new Set(keys).size === keys.length,
  );

function setRecordField(record, key, value) {
  // JSON's own __proto__ field must not change the restored object's prototype.
  if (key === '__proto__')
    Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
  else record[key] = value;
}

function expandColumns(node, expand) {
  const [, schemas, order, columns] = node;
  if (
    node.length !== 4 ||
    !validSchemas(schemas) ||
    !Array.isArray(order) ||
    !Array.isArray(columns) ||
    columns.length !== schemas.length
  )
    throw new Error('Invalid map column schemas');
  const counts = new Array(schemas.length).fill(0);
  for (const id of order) {
    if (!Number.isInteger(id) || id < 0 || id >= schemas.length)
      throw new Error('Invalid map column record order');
    counts[id]++;
  }
  for (let id = 0; id < schemas.length; id++)
    if (
      !Array.isArray(columns[id]) ||
      columns[id].length !== schemas[id].length ||
      columns[id].some((column) => !Array.isArray(column) || column.length !== counts[id])
    )
      throw new Error('Invalid map record column length');
  const records = new Array(order.length),
    groups = schemas.map(() => []);
  for (let i = 0; i < order.length; i++) {
    const record = {};
    groups[order[i]].push(record);
    records[i] = record;
  }
  for (let id = 0; id < schemas.length; id++) {
    const keys = schemas[id],
      group = groups[id];
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k],
        column = columns[id][k];
      if (key === '__proto__')
        for (let row = 0; row < group.length; row++) setRecordField(group[row], key, expand(column[row]));
      else for (let row = 0; row < group.length; row++) group[row][key] = expand(column[row]);
    }
  }
  return records;
}

/** Restore exact source records and coordinates from the download format. */
export function unpackMapDataTransport(data, coordinateBytes) {
  if (!data || typeof data !== 'object') throw new Error('Invalid map data transport envelope');
  if (!Array.isArray(data)) return data;
  if (data[0] !== MAP_DATA_TRANSPORT) throw new Error('Unsupported map data transport');
  if (data.length !== 2 || !data[1] || typeof data[1] !== 'object' || Array.isArray(data[1]))
    throw new Error('Invalid map data transport envelope');
  let cursor = 0;
  const readDelta = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = coordinateBytes[cursor++];
      if (byte === undefined || (shift === 28 && byte > 15))
        throw new Error('Invalid packed map coordinate delta');
      value |= (byte & 127) << shift;
      if (byte < 128) return (value >>> 1) ^ -(value & 1);
    }
  };
  const expand = (node) => {
    if (Array.isArray(node)) {
      if (node[0] === MAP_COLUMNS) return expandColumns(node, expand);
      if (node[0] === MAP_RECORDS) {
        const schemas = node[1],
          rows = node[2];
        if (node.length !== 3 || !validSchemas(schemas) || !Array.isArray(rows))
          throw new Error('Invalid map record schemas');
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (
            !Array.isArray(row) ||
            !Number.isInteger(row[0]) ||
            row[0] < 0 ||
            row[0] >= schemas.length ||
            row.length !== schemas[row[0]].length + 1
          )
            throw new Error('Invalid map record row');
          const keys = schemas[row[0]],
            record = {};
          for (let k = 0; k < keys.length; k++) setRecordField(record, keys[k], expand(row[k + 1]));
          rows[i] = record;
        }
        return rows;
      }
      if (node[0] === MAP_NEGATIVE_ZERO) {
        if (node.length !== 1) throw new Error('Invalid map negative-zero value');
        return -0;
      }
      if (node[0] === MAP_BINARY_COORDINATES) {
        const [, scale, count] = node;
        if (
          node.length !== 3 ||
          !MAP_COORDINATE_SCALES.includes(scale) ||
          !Number.isSafeInteger(count) ||
          count < 3 ||
          !coordinateBytes ||
          count > (coordinateBytes.length - cursor) / 2
        )
          throw new Error('Invalid packed map coordinate sequence');
        const points = new Array(count);
        let x = 0,
          z = 0;
        for (let i = 0; i < count; i++) {
          x += readDelta();
          z += readDelta();
          if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z))
            throw new Error('Map coordinate delta overflows its integer range');
          points[i] = [x / scale, z / scale];
        }
        return points;
      }
      if (node[0] === MAP_COORDINATE_SEQUENCE) {
        const scale = node[1];
        if (node.length < 8 || node.length % 2 || !MAP_COORDINATE_SCALES.includes(scale))
          throw new Error('Invalid map coordinate sequence');
        const points = new Array((node.length - 2) / 2);
        let x = 0,
          z = 0;
        for (let i = 2; i < node.length; i += 2) {
          if (!Number.isSafeInteger(node[i]) || !Number.isSafeInteger(node[i + 1]))
            throw new Error('Invalid map coordinate delta');
          x += node[i];
          z += node[i + 1];
          if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z))
            throw new Error('Map coordinate delta overflows its integer range');
          points[(i - 2) / 2] = [x / scale, z / scale];
        }
        return points;
      }
      for (let i = 0; i < node.length; i++) node[i] = expand(node[i]);
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) node[key] = expand(node[key]);
    }
    return node;
  };
  const result = expand(data[1]);
  if (coordinateBytes && cursor !== coordinateBytes.length)
    throw new Error('Unexpected trailing map coordinate bytes');
  return result;
}

export function unpackBinaryMapData(buffer) {
  if (buffer.byteLength < 4) throw new Error('Missing packed map header');
  const jsonLength = new DataView(buffer).getUint32(0, true);
  if (jsonLength > buffer.byteLength - 4) throw new Error('Truncated packed map metadata');
  const json = new TextDecoder().decode(new Uint8Array(buffer, 4, jsonLength));
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('Invalid packed map envelope');
  return unpackMapDataTransport(data, new Uint8Array(buffer, 4 + jsonLength));
}

export async function readMapData(response, url) {
  if (isCompressedAsset(url)) return unpackBinaryMapData(await readAssetBytes(response, url));
  return unpackMapDataTransport(await response.json());
}
