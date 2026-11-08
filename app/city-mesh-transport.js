const SOURCE_MAGIC = [67, 71, 77, 69, 83, 72, 49, 0]; // CGMESH1\0
export const CITY_MESH_TRANSPORT_MAGIC = [67, 71, 80, 65, 67, 75, 51, 0]; // CGPACK3\0
export const CITY_MESH_TRANSPORT_HEADER_BYTES = 28;
// CGPACK3 assigns codes 0–7 to the current record stream's most recent words.
export const CITY_MESH_TRANSPORT_CACHE_WORDS = 8;
const LEGACY_TRANSPORT_MAGIC = [67, 71, 80, 65, 67, 75, 50, 0]; // CGPACK2\0

export function cityMeshBytes(binary) {
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary);
  if (ArrayBuffer.isView(binary)) return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  throw new TypeError('City meshes require binary data');
}

/** The packed stream uses the source manifest's exact, contiguous record layout. */
export function validateCityMeshLayout(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.buildings))
    throw new Error('Unsupported City mesh manifest');
  let offset = 16,
    values = 0;
  for (const record of manifest.buildings) {
    if (
      record.offset !== offset ||
      !Number.isSafeInteger(record.vertexCount) ||
      record.vertexCount < 3 ||
      !Number.isSafeInteger(record.indexCount) ||
      record.indexCount < 3 ||
      record.indexCount % 3 ||
      ![2, 4].includes(record.indexBytes)
    )
      throw new Error(`Invalid City mesh transport layout: ${record.id}`);
    offset += record.vertexCount * 6 + record.indexCount * record.indexBytes;
    values += record.vertexCount * 3 + record.indexCount;
    if (!Number.isSafeInteger(offset) || offset > 0x7fffffff)
      throw new Error('City mesh transport exceeds the supported byte budget');
  }
  if (offset !== manifest.meta?.binaryBytes)
    throw new Error('City mesh transport byte length does not match the manifest');
  return { byteLength: offset, values };
}

function validateSourceHeader(bytes, manifest) {
  if (bytes.byteLength < 16 || SOURCE_MAGIC.some((value, i) => bytes[i] !== value))
    throw new Error('Invalid City mesh source header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16),
    quantization = view.getFloat32(12, true);
  if (
    view.getUint32(8, true) !== manifest.buildings.length ||
    !Number.isFinite(quantization) ||
    !(manifest.meta?.quantization > 0) ||
    Math.abs(quantization - manifest.meta.quantization) > 1e-8
  )
    throw new Error('City mesh source header does not match the manifest');
}

export function validateCityMeshSource(binary, manifest) {
  const bytes = cityMeshBytes(binary),
    layout = validateCityMeshLayout(manifest);
  if (bytes.byteLength !== layout.byteLength)
    throw new Error('City mesh source byte length does not match the manifest');
  validateSourceHeader(bytes, manifest);
  return bytes;
}

/** Restore every source byte; the transport changes no vertices, indices or precision. */
export function unpackCityMeshTransport(binary, manifest) {
  const bytes = cityMeshBytes(binary);
  if (SOURCE_MAGIC.every((value, i) => bytes[i] === value)) return bytes;
  if (LEGACY_TRANSPORT_MAGIC.every((value, i) => bytes[i] === value))
    return unpackLegacyCityMeshTransport(bytes, manifest);
  if (
    bytes.byteLength < CITY_MESH_TRANSPORT_HEADER_BYTES ||
    CITY_MESH_TRANSPORT_MAGIC.some((v, i) => bytes[i] !== v)
  )
    throw new Error('Invalid City mesh transport header');
  const layout = validateCityMeshLayout(manifest);
  const packedView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (packedView.getUint32(8, true) !== layout.byteLength)
    throw new Error('City mesh transport decoded length does not match the manifest');
  const payloadBytes = bytes.byteLength - CITY_MESH_TRANSPORT_HEADER_BYTES;
  if (payloadBytes < layout.values || payloadBytes > layout.values * 5)
    throw new Error('Invalid City mesh transport payload length');
  validateSourceHeader(bytes.subarray(12, CITY_MESH_TRANSPORT_HEADER_BYTES), manifest);
  const output = new Uint8Array(layout.byteLength);
  output.set(bytes.subarray(12, CITY_MESH_TRANSPORT_HEADER_BYTES));
  const view = new DataView(output.buffer);
  let cursor = CITY_MESH_TRANSPORT_HEADER_BYTES;
  const read = (first, bits) => {
    let value = first & 127;
    const limit = bits === 16 ? 3 : 5;
    for (let group = 1; group < limit; group++) {
      if (cursor === bytes.byteLength) throw new Error('Truncated City mesh transport value');
      const byte = bytes[cursor++],
        part = byte & 127;
      // A uint32 delta plus the cache-code prefix can require a 33rd bit.
      if (group === 4) value += part * 0x10000000;
      else value |= part << (group * 7);
      if (
        group === limit - 1 &&
        (byte & 128 || value > (bits === 16 ? 65535 : 0xffffffff) + CITY_MESH_TRANSPORT_CACHE_WORDS)
      )
        throw new Error('City mesh transport value overflows its source word');
      if (!(byte & 128)) {
        if (part === 0) throw new Error('Noncanonical City mesh transport value');
        return value;
      }
    }
    throw new Error('Invalid City mesh transport value');
  };
  const words = (offset, count, stride, bits) => {
    let previous = 0,
      cached = 0;
    // Scalar slots avoid typed-array shifts in the full-city startup decode.
    let c0 = 0,
      c1 = 0,
      c2 = 0,
      c3 = 0,
      c4 = 0,
      c5 = 0,
      c6 = 0,
      c7 = 0;
    for (let i = 0; i < count; i++) {
      if (cursor === bytes.byteLength) throw new Error('Truncated City mesh transport value');
      let code = bytes[cursor++];
      if (code & 128) code = read(code, bits);
      let value;
      if (code < CITY_MESH_TRANSPORT_CACHE_WORDS && code >= cached)
        throw new Error('Invalid City mesh transport cache reference');
      switch (code) {
        case 0:
          value = c0;
          break;
        case 1:
          value = c1;
          c1 = c0;
          break;
        case 2:
          value = c2;
          c2 = c1;
          c1 = c0;
          break;
        case 3:
          value = c3;
          c3 = c2;
          c2 = c1;
          c1 = c0;
          break;
        case 4:
          value = c4;
          c4 = c3;
          c3 = c2;
          c2 = c1;
          c1 = c0;
          break;
        case 5:
          value = c5;
          c5 = c4;
          c4 = c3;
          c3 = c2;
          c2 = c1;
          c1 = c0;
          break;
        case 6:
          value = c6;
          c6 = c5;
          c5 = c4;
          c4 = c3;
          c3 = c2;
          c2 = c1;
          c1 = c0;
          break;
        case 7:
          value = c7;
          c7 = c6;
          c6 = c5;
          c5 = c4;
          c4 = c3;
          c3 = c2;
          c2 = c1;
          c1 = c0;
          break;
        default:
          const delta = code - CITY_MESH_TRANSPORT_CACHE_WORDS;
          value = (previous + ((delta >>> 1) ^ -(delta & 1))) >>> 0;
          if (bits === 16) value &= 65535;
          c7 = c6;
          c6 = c5;
          c5 = c4;
          c4 = c3;
          c3 = c2;
          c2 = c1;
          c1 = c0;
          if (cached < CITY_MESH_TRANSPORT_CACHE_WORDS) cached++;
      }
      c0 = value;
      const at = offset + i * stride;
      if (bits === 16) view.setUint16(at, value, true);
      else view.setUint32(at, value, true);
      previous = value;
    }
  };
  for (let axis = 0; axis < 3; axis++)
    for (const r of manifest.buildings) words(r.offset + axis * 2, r.vertexCount, 6, 16);
  for (const r of manifest.buildings)
    words(r.offset + r.vertexCount * 6, r.indexCount, r.indexBytes, r.indexBytes * 8);
  if (cursor !== bytes.byteLength) throw new Error('Trailing bytes in City mesh transport');
  return output;
}

function unpackLegacyCityMeshTransport(binary, manifest) {
  const bytes = cityMeshBytes(binary);
  // Authoring tools and unbundled development continue to read the original format.
  if (SOURCE_MAGIC.every((value, i) => bytes[i] === value)) return bytes;
  if (
    bytes.byteLength < CITY_MESH_TRANSPORT_HEADER_BYTES ||
    LEGACY_TRANSPORT_MAGIC.some((value, i) => bytes[i] !== value)
  )
    throw new Error('Invalid City mesh transport header');
  const layout = validateCityMeshLayout(manifest),
    packedView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    payloadBytes = bytes.byteLength - CITY_MESH_TRANSPORT_HEADER_BYTES;
  if (packedView.getUint32(8, true) !== layout.byteLength)
    throw new Error('City mesh transport decoded length does not match the manifest');
  // Each source word uses at least one and at most five bytes. Check before allocating.
  if (payloadBytes < layout.values || payloadBytes > layout.values * 5)
    throw new Error('Invalid City mesh transport payload length');
  validateSourceHeader(bytes.subarray(12, CITY_MESH_TRANSPORT_HEADER_BYTES), manifest);
  const output = new Uint8Array(layout.byteLength),
    view = new DataView(output.buffer);
  output.set(bytes.subarray(12, CITY_MESH_TRANSPORT_HEADER_BYTES));
  let cursor = CITY_MESH_TRANSPORT_HEADER_BYTES;
  const read = (bits) => {
    if (cursor === bytes.byteLength) throw new Error('Truncated City mesh transport value');
    const first = bytes[cursor++];
    if (first < 128) return first;
    let value = first & 127;
    const limit = bits === 16 ? 3 : 5;
    for (let group = 1; group < limit; group++) {
      if (cursor === bytes.byteLength) throw new Error('Truncated City mesh transport value');
      const byte = bytes[cursor++],
        part = byte & 127;
      if (group === limit - 1 && (part > (bits === 16 ? 3 : 15) || byte & 128))
        throw new Error('City mesh transport value overflows its source word');
      value |= part << (group * 7);
      if (!(byte & 128)) {
        if (part === 0) throw new Error('Noncanonical City mesh transport value');
        return value >>> 0;
      }
    }
    throw new Error('Invalid City mesh transport value');
  };
  for (let axis = 0; axis < 3; axis++) {
    for (const record of manifest.buildings) {
      let previous = 0;
      for (let i = 0; i < record.vertexCount; i++) {
        const delta = read(16),
          value = (previous + ((delta >>> 1) ^ -(delta & 1))) & 65535;
        view.setUint16(record.offset + i * 6 + axis * 2, value, true);
        previous = value;
      }
    }
  }
  for (const record of manifest.buildings) {
    let previous = 0;
    const indexOffset = record.offset + record.vertexCount * 6;
    for (let i = 0; i < record.indexCount; i++) {
      const delta = read(record.indexBytes * 8),
        value = (previous + ((delta >>> 1) ^ -(delta & 1))) >>> 0,
        at = indexOffset + i * record.indexBytes;
      if (record.indexBytes === 2) {
        view.setUint16(at, value, true);
        previous = value & 65535;
      } else {
        view.setUint32(at, value, true);
        previous = value;
      }
    }
  }
  if (cursor !== bytes.byteLength) throw new Error('Trailing bytes in City mesh transport');
  return output;
}
