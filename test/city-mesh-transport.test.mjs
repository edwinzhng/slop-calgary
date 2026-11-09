import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import { build } from 'vite';
import { packCityMeshTransport } from '../build/mesh-transport.mjs';
import { MAP_TRANSPORT_SOURCES, packMapDataTransport } from '../build/map-data-transport.mjs';
import { unpackCityMeshTransport } from '../app/city-mesh-transport.js';
import { CITY_MESH_MANIFEST_URL, createCityMeshes, loadCityMeshes } from '../app/city-meshes.js';
import * as THREE from 'three/webgpu';
import { buildingProfile, decorateBuildingGeometry } from '../app/building-models.js';
import { MURALS } from '../app/city-murals.js';
import {
  MAP_DATA_TRANSPORT,
  unpackBinaryMapData,
  unpackMapDataTransport,
} from '../app/map-data-transport.js';

const root = fileURLToPath(new URL('../', import.meta.url)),
  manifest = JSON.parse(await fs.readFile(new URL('../data/calgary-meshes.json', import.meta.url))),
  source = await fs.readFile(new URL('../data/calgary-meshes.bin', import.meta.url)),
  packed = packCityMeshTransport(source, manifest);

function fixture(indexBytes = 2) {
  const vertices = [0, -32768, 32767, -1, 0, -32768, 32767, -1, 0],
    indices = indexBytes === 2 ? [65535, 0, 32768] : [0xffffffff, 0x7fffffff, 0];
  const record = { id: 'fixture', offset: 16, vertexCount: 3, indexCount: 3, indexBytes },
    bytes = new Uint8Array(16 + vertices.length * 2 + indices.length * indexBytes),
    view = new DataView(bytes.buffer);
  bytes.set([67, 71, 77, 69, 83, 72, 49, 0]);
  view.setUint32(8, 1, true);
  view.setFloat32(12, 0.01, true);
  vertices.forEach((value, i) => view.setInt16(16 + i * 2, value, true));
  indices.forEach((value, i) => {
    const at = 16 + vertices.length * 2 + i * indexBytes;
    if (indexBytes === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
  });
  return {
    bytes,
    manifest: { version: 1, meta: { binaryBytes: bytes.length, quantization: 0.01 }, buildings: [record] },
  };
}

test('City face normals retain double precision before Float32 placement and reject invalid indices', () => {
  for (const width of [2, 4]) {
    const f = fixture(width),
      record = f.manifest.buildings[0],
      view = new DataView(f.bytes.buffer);
    Object.assign(record, { origin: [10000.1234, 20000.4321], height: 1 });
    [0, 0, 0, 1, 1, 0, 0, 0, 1].forEach((v, i) => view.setInt16(16 + i * 2, v, true));
    for (let i = 0; i < 3; i++)
      if (width === 2) view.setUint16(34 + i * width, i, true);
      else view.setUint32(34 + i * width, i, true);
    const provider = createCityMeshes(f.manifest, f.bytes),
      geometry = provider.createGeometry('fixture');
    try {
      assert.deepEqual(
        geometry.attributes.position.array,
        new Float32Array([
          10000.1234, 0, 20000.4321, 10000.1334, 0.01, 20000.4321, 10000.1234, 0, 20000.4421,
        ]),
      );
      assert.deepEqual(
        geometry.attributes.normal.array,
        new Float32Array(Array.from({ length: 3 }, () => [Math.SQRT1_2, -Math.SQRT1_2, 0]).flat()),
      );
      const retained = geometry.attributes.position.array.slice();
      if (width === 2) view.setUint16(34, 3, true);
      else view.setUint32(34, 3, true);
      assert.throws(() => provider.createGeometry('fixture'), /index out of range/);
      assert.deepEqual(
        geometry.attributes.position.array,
        retained,
        'scratch decoding never aliases caller geometry',
      );
    } finally {
      geometry.dispose();
    }
  }
});

test('ordinary facade packing matches the getter path, including signed zero and arbitrary attribute getters', () => {
  const source = new THREE.BufferGeometry();
  source.setAttribute('position', new THREE.Float32BufferAttribute([-0, -0, 0, 4, 3, 2, -2, 7, 3], 3));
  source.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0.3, 0.4, 0.5, -0, -1, 0], 3));
  const fallback = source.clone(),
    read = fallback.attributes.position.getX;
  let calls = 0;
  fallback.attributes.position.getX = function (index) {
    calls++;
    return read.call(this, index);
  };
  const building = {
      id: 'unobserved-fixture',
      height: 7,
      ring: [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 0],
      ],
    },
    profile = buildingProfile(building);
  try {
    decorateBuildingGeometry(source, building, profile);
    decorateBuildingGeometry(fallback, building, profile);
    assert.ok(calls > 0);
    for (const [name, attribute] of Object.entries(source.attributes))
      assert.deepEqual(attribute.array, fallback.attributes[name].array, name);
  } finally {
    source.dispose();
    fallback.dispose();
  }
});

test('the complete city restores every measured byte and reduces a Brotli-compressed first download', (t) => {
  const start = performance.now(),
    restored = unpackCityMeshTransport(packed, manifest),
    decodeMs = performance.now() - start,
    options = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    originalBrotli = brotliCompressSync(source, options).byteLength,
    packedBrotli = brotliCompressSync(packed, options).byteLength;
  assert.deepEqual(Buffer.from(restored), source);
  assert.equal(Buffer.from(packed.subarray(0, 8)).toString(), 'CGPACK3\0');
  assert.ok(packed.byteLength < source.byteLength * 0.6);
  assert.ok(packedBrotli < originalBrotli * 0.65);
  assert.equal(unpackCityMeshTransport(source, manifest).buffer, source.buffer);
  t.diagnostic(
    JSON.stringify({
      original: source.byteLength,
      packed: packed.byteLength,
      originalBrotli,
      packedBrotli,
      decodeMs,
    }),
  );
});

test('legacy CGPACK2 coordinate and index streams remain readable', () => {
  const legacy = [
    [2, 'Q0dQQUNLMgAoAAAAQ0dNRVNIMQABAAAACtcjPAAB//8D//8D//8DAf7/AwL//wMBAv//Aw=='],
    [4, 'Q0dQQUNLMgAuAAAAQ0dNRVNIMQABAAAACtcjPAAB//8D//8D//8DAf7/AwL//wMB/////w/9////Dw=='],
  ];
  for (const [indexBytes, encoded] of legacy) {
    const f = fixture(indexBytes);
    assert.deepEqual(unpackCityMeshTransport(Buffer.from(encoded, 'base64'), f.manifest), f.bytes);
  }
});

test('recent words survive cache hits, recency changes and eviction in both index widths', () => {
  const values = [0, 65535, 32768, 7, 0, 7, 65535, 8, 9, 10, 11, 12, 13, 14, 15, 0, 32768];
  for (const indexBytes of [2, 4]) {
    const f = fixture(indexBytes),
      record = { ...f.manifest.buildings[0], vertexCount: values.length * 2, indexCount: 51 },
      bytes = new Uint8Array(16 + record.vertexCount * 6 + record.indexCount * indexBytes),
      view = new DataView(bytes.buffer);
    bytes.set(f.bytes.subarray(0, 16));
    for (let i = 0; i < record.vertexCount; i++) {
      for (let axis = 0; axis < 3; axis++)
        view.setUint16(record.offset + i * 6 + axis * 2, values[(i + axis * 3) % values.length], true);
    }
    for (let i = 0; i < record.indexCount; i++) {
      const value = values[i % values.length],
        at = record.offset + record.vertexCount * 6 + i * indexBytes;
      if (indexBytes === 2) view.setUint16(at, value, true);
      else view.setUint32(at, i % 19 === 0 ? 0xffffffff : value, true);
    }
    const repeated = {
      ...f.manifest,
      meta: { ...f.manifest.meta, binaryBytes: bytes.length },
      buildings: [record],
    };
    assert.deepEqual(unpackCityMeshTransport(packCityMeshTransport(bytes, repeated), repeated), bytes);
  }
});

test('coordinate and 16/32-bit index word extremes survive wrapping deltas and offset views', () => {
  for (const indexBytes of [2, 4]) {
    const f = fixture(indexBytes),
      buffer = new Uint8Array(f.bytes.length + 16);
    buffer.set(f.bytes, 7);
    const sourceView = buffer.subarray(7, 7 + f.bytes.length),
      transport = packCityMeshTransport(sourceView, f.manifest),
      padded = new Uint8Array(transport.byteLength + 11);
    padded.set(transport, 3);
    assert.deepEqual(
      unpackCityMeshTransport(padded.subarray(3, 3 + transport.byteLength), f.manifest),
      f.bytes,
    );
    assert.deepEqual(unpackCityMeshTransport(transport.buffer, f.manifest), f.bytes);
  }
});

test('multiple records preserve independent coordinate predictors and mixed index widths', () => {
  const a = fixture(2),
    b = fixture(4),
    bytes = new Uint8Array(a.bytes.length + b.bytes.length - 16),
    view = new DataView(bytes.buffer);
  bytes.set(a.bytes);
  bytes.set(b.bytes.subarray(16), a.bytes.length);
  view.setUint32(8, 2, true);
  const mixed = {
    version: 1,
    meta: { binaryBytes: bytes.length, quantization: 0.01 },
    buildings: [
      { ...a.manifest.buildings[0], id: 'first' },
      { ...b.manifest.buildings[0], id: 'second', offset: a.bytes.length },
    ],
  };
  assert.deepEqual(unpackCityMeshTransport(packCityMeshTransport(bytes, mixed), mixed), bytes);
});

test('32-bit cache misses reject values above the reserved 33-bit range', () => {
  const f = fixture(4);
  // Zero coordinates use exactly one code per word, before the first uint32 index.
  f.bytes.fill(0, 16, 34);
  const transport = packCityMeshTransport(f.bytes, f.manifest),
    indexOffset = 28 + 9,
    invalid = new Uint8Array(transport.length + 4);
  invalid.set(transport.subarray(0, indexOffset));
  invalid.set([0x88, 0x80, 0x80, 0x80, 0x10], indexOffset);
  invalid.set(transport.subarray(indexOffset + 1), indexOffset + 5);
  assert.throws(() => unpackCityMeshTransport(invalid, f.manifest), /overflows/);
});

test('corrupt headers, layouts, lengths and malformed varints are rejected', () => {
  const f = fixture(),
    transport = packCityMeshTransport(f.bytes, f.manifest),
    checkMutation = (mutate, pattern) => {
      const bad = transport.slice();
      mutate(bad, new DataView(bad.buffer));
      assert.throws(() => unpackCityMeshTransport(bad, f.manifest), pattern);
    };
  checkMutation((bytes) => (bytes[0] ^= 1), /header/);
  checkMutation((bytes) => (bytes[6] = 49), /header/);
  checkMutation((bytes, view) => view.setUint32(8, f.bytes.length + 1, true), /decoded length/);
  checkMutation((bytes) => (bytes[12] = 0), /source header/);
  checkMutation((bytes, view) => view.setUint32(20, 2, true), /source header/);
  checkMutation((bytes, view) => view.setFloat32(24, NaN, true), /source header/);
  checkMutation((bytes) => bytes.set([255, 255, 4], 28), /overflows/);
  checkMutation((bytes) => bytes.set([128, 128, 128], 28), /overflows/);
  checkMutation((bytes) => bytes.set([128, 0], 28), /Noncanonical/);
  checkMutation((bytes) => (bytes[28] = 0), /cache reference/);
  assert.throws(() => unpackCityMeshTransport(transport.slice(0, -1), f.manifest), /Truncated/);
  const trailing = new Uint8Array(transport.length + 1);
  trailing.set(transport);
  assert.throws(() => unpackCityMeshTransport(trailing, f.manifest), /Trailing/);
  assert.throws(() => unpackCityMeshTransport(transport.slice(0, 30), f.manifest), /payload length/);
  assert.throws(
    () => unpackCityMeshTransport(transport, { ...f.manifest, meta: { ...f.manifest.meta, binaryBytes: 1 } }),
    /byte length/,
  );
  assert.throws(
    () =>
      unpackCityMeshTransport(transport, {
        ...f.manifest,
        buildings: [{ ...f.manifest.buildings[0], offset: 18 }],
      }),
    /layout/,
  );
  assert.throws(
    () =>
      unpackCityMeshTransport(transport, {
        ...f.manifest,
        buildings: [{ ...f.manifest.buildings[0], indexBytes: 3 }],
      }),
    /layout/,
  );
  assert.throws(() => packCityMeshTransport(f.bytes.slice(0, -1), f.manifest), /byte length/);
});

test('the loader accepts the packed city with only its existing manifest and binary requests', async () => {
  const requested = [],
    meshes = await loadCityMeshes({
      fetcher: async (url) => {
        requested.push(url);
        return url.href === CITY_MESH_MANIFEST_URL.href
          ? new Response(JSON.stringify(packMapDataTransport(manifest)))
          : new Response(packed);
      },
    });
  assert.equal(requested.length, 2);
  assert.equal(meshes.count, manifest.buildings.length);
  const geometry = meshes.createGeometry(manifest.buildings[0].id);
  assert.ok(geometry.attributes.position.array.every(Number.isFinite));
  geometry.dispose();
});

test('production emits independent full and core survey assets without preloading both', async () => {
  const result = await build({
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    root,
    logLevel: 'silent',
    build: { write: false },
  });
  const asset = (pattern) => {
      const matches = result.output.filter((item) => item.type === 'asset' && pattern.test(item.fileName));
      assert.equal(matches.length, 1, String(pattern));
      return matches[0];
    },
    full = asset(/^assets\/calgary-meshes\.bin-.*\.cgz$/),
    core = asset(/^assets\/calgary-core-meshes\.bin-.*\.cgz$/),
    coreMeta = unpackMapDataTransport(
      JSON.parse(Buffer.from(asset(/^assets\/calgary-core-meshes-.*\.json$/).source)),
    ),
    chunks = result.output.filter((item) => item.type === 'chunk'),
    code = chunks.map((item) => item.code).join('\n');
  assert.deepEqual(gunzipSync(full.source), Buffer.from(packed));
  assert.ok(core.source.length < full.source.length * 0.3);
  const coreBytes = unpackCityMeshTransport(gunzipSync(core.source), coreMeta);
  const coreIds = new Set(coreMeta.buildings.map(({ id }) => id));
  for (const [id] of MURALS) assert.ok(coreIds.has(id), `mural wall ${id} needs its full survey mesh`);
  const byId = new Map(manifest.buildings.map((r) => [r.id, r]));
  const simplified = new Map();
  for (let i = 0; i < coreMeta.compactHeights.length; i += 2)
    simplified.set(`city-outline-${coreMeta.compactHeights[i]}-0`, coreMeta.compactHeights[i + 1]);
  for (const record of coreMeta.buildings) {
    const original = byId.get(record.id);
    assert.deepEqual({ ...record, offset: original.offset }, original);
    const size = record.vertexCount * 6 + record.indexCount * record.indexBytes;
    assert.ok(
      Buffer.from(coreBytes.subarray(record.offset, record.offset + size)).equals(
        source.subarray(original.offset, original.offset + size),
      ),
    );
    byId.delete(record.id);
  }
  assert.equal(byId.size, simplified.size);
  for (const [id, record] of byId) assert.equal(simplified.get(id), record.height);
  assert.ok(code.includes(full.fileName));
  assert.ok(code.includes(core.fileName));
  assert.ok(!code.includes('ROLLUP_FILE_URL_'));
  assert.ok(!code.includes('../data/calgary-meshes.bin'));
  const html = result.output.find((item) => item.fileName === 'index.html').source,
    preloads = [
      ...html.matchAll(
        /<link rel="preload" as="fetch" href="([^"]+)" crossorigin="anonymous" fetchpriority="low">/g,
      ),
    ].map((match) => match[1]);
  assert.deepEqual(preloads, [
    '/' + result.output.find((item) => item.originalFileNames?.includes('data/calgary.json')).fileName,
  ]);
  const defaultAssets = result.output.filter(
    ({ fileName }) =>
      !/^assets\/(calgary-meshes[-.]|calgary-street-details-|calgary-player\.glb-)/.test(fileName) &&
      !fileName.endsWith('.jpg'),
  );
  const defaultBytes = defaultAssets.reduce((sum, item) => {
    const bytes = item.type === 'chunk' ? item.code : item.source;
    return (
      sum +
      (/\.(css|json|js|html|svg)$/.test(item.fileName)
        ? gzipSync(bytes).byteLength
        : Buffer.byteLength(bytes))
    );
  }, 0);
  assert.ok(defaultBytes < 9_400_000, `Default city and all compact imagery use ${defaultBytes} wire bytes`);
  for (const [, name] of MAP_TRANSPORT_SOURCES) {
    const matches = result.output.filter(
      (item) => item.type === 'asset' && item.originalFileNames.includes(`data/${name}.json`),
    );
    assert.equal(matches.length, 1, `${name} must not emit a second uncompressed asset`);
    const packed = Buffer.from(matches[0].source);
    const expected = JSON.parse(await fs.readFile(new URL(`../data/${name}.json`, import.meta.url)));
    if (['calgary', 'calgary-surfaces', 'calgary-parks'].includes(name)) {
      assert.ok(matches[0].fileName.endsWith('.cgz'));
      assert.deepEqual(unpackBinaryMapData(Uint8Array.from(gunzipSync(packed)).buffer), expected);
      const oldWireSize = gzipSync(JSON.stringify(packMapDataTransport(expected))).length;
      assert.ok(packed.length < oldWireSize * 0.92, `${name} must save bytes on the wire`);
    } else {
      const encoded = JSON.parse(packed.toString());
      assert.equal(encoded[0], MAP_DATA_TRANSPORT);
      if (name === 'calgary-trees')
        for (const tree of expected.trees) {
          delete tree.lon;
          delete tree.lat;
        }
      if (name === 'calgary-lighting')
        expected.records = expected.records.map(({ id, x, z, type, heading, pathBridge }) => ({
          id,
          x,
          z,
          type,
          heading,
          pathBridge,
        }));
      assert.deepEqual(unpackMapDataTransport(encoded), expected);
    }
    assert.ok(code.includes(matches[0].fileName));
  }
});
