import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCityMeshes } from './city-meshes.js';
import { createMeshHeightSampler } from './mesh-height-envelope.js';

export const HAYDEN_BLOCK_BASELINE_ID = 'city-outline-28334-0';
export const HAYDEN_BLOCK_SOURCE_ID = 'hayden-block-source-1413988';
export const HAYDEN_BLOCK_SOURCE_SHA256 = '5d3749aac76300186371e7737f6c71253cadfb03057a7563845311dcb876b6c2';
export const HAYDEN_BLOCK_SOURCE_PAYLOAD_SHA256 =
  '3ffe1da5cc94b9eff1a3b3c3a35518266934945afa0d5bfb3915dd3ce422fb41';
export const HAYDEN_BLOCK_MANIFEST_URL = new URL('../data/hayden-block.json', import.meta.url);
export const HAYDEN_BLOCK_BINARY_URL = new URL('../data/hayden-block.bin', import.meta.url);
const SOURCE_FNV1A = 176825810;
const AREA_EPSILON = 0.00002;
const POSITION_EPSILON = 1e-8;

const binaryBytes = (binary) =>
  binary instanceof ArrayBuffer
    ? new Uint8Array(binary)
    : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
const fnv1a = (bytes) => {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
};
const ringPoints = (ring) => {
  if (!Array.isArray(ring)) throw new Error('Hayden footprint needs an explicit ring');
  const points = ring.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
      throw new Error('Hayden footprint coordinates must be finite x/z pairs');
    return [...p];
  });
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1])
    points.pop();
  if (points.length < 3) throw new Error('Hayden footprint needs three distinct vertices');
  return points;
};
function signedArea(ring) {
  const [ox, oz] = ring[0];
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    area += (a[0] - ox) * (b[1] - oz) - (a[1] - oz) * (b[0] - ox);
  }
  return area / 2;
}
export function haydenFootprintArea(poly) {
  return (
    Math.abs(signedArea(ringPoints(poly.ring))) -
    (poly.holes || []).reduce((n, ring) => n + Math.abs(signedArea(ringPoints(ring))), 0)
  );
}
function trianglesOf(poly) {
  const rings = [poly.ring, ...(poly.holes || [])].map(ringPoints),
    vectors = rings.map((ring) => ring.map(([x, z]) => new THREE.Vector2(x, z))),
    flat = rings.flat();
  const faces = THREE.ShapeUtils.triangulateShape(vectors[0], vectors.slice(1));
  const triangles = faces.map((face) => face.map((i) => flat[i]));
  const area = triangles.reduce((n, t) => n + Math.abs(signedArea(t)), 0);
  if (Math.abs(area - haydenFootprintArea(poly)) > AREA_EPSILON || area < AREA_EPSILON)
    throw new Error('Hayden footprint triangulation does not preserve its area/holes');
  return triangles;
}
function triangleIntersectionArea(a, b) {
  const orientation = Math.sign(signedArea(b));
  let points = a;
  for (let i = 0; i < 3 && points.length; i++) {
    const p = b[i],
      q = b[(i + 1) % 3],
      side = (v) => orientation * ((q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0])),
      result = [];
    let previous = points.at(-1),
      previousSide = side(previous);
    for (const current of points) {
      const currentSide = side(current),
        inside = currentSide >= -1e-10,
        wasInside = previousSide >= -1e-10;
      if (inside !== wasInside) {
        const t = previousSide / (previousSide - currentSide);
        result.push([
          previous[0] + (current[0] - previous[0]) * t,
          previous[1] + (current[1] - previous[1]) * t,
        ]);
      }
      if (inside) result.push(current);
      previous = current;
      previousSide = currentSide;
    }
    points = result;
  }
  return points.length < 3 ? 0 : Math.abs(signedArea(points));
}
export function haydenIntersectionArea(a, b) {
  const ta = trianglesOf(a),
    tb = trianglesOf(b);
  let area = 0;
  for (const x of ta) for (const y of tb) area += triangleIntersectionArea(x, y);
  return area;
}
const expectNear = (actual, expected, label) => {
  if (!Number.isFinite(expected) || Math.abs(actual - expected) > AREA_EPSILON)
    throw new Error(`Hayden ${label} does not match the explicit partition proof`);
};

/** Independent runtime area proof. Remainders must cover the entire retained
 * baseline outside the measured fragment, without overlap or lost neighbors. */
export function auditHaydenPartition(partial) {
  const base = partial.baselineDefinition,
    source = partial.sourceFootprint,
    parts = partial.remainderParts,
    proof = partial.partitionProof;
  if (
    base?.id !== HAYDEN_BLOCK_BASELINE_ID ||
    partial.sourceModelId !== HAYDEN_BLOCK_SOURCE_ID ||
    !Array.isArray(parts) ||
    !parts.length ||
    !proof
  )
    throw new Error('Hayden partial compound has no complete ownership contract');
  const baseArea = haydenFootprintArea(base),
    sourceArea = haydenFootprintArea(source),
    coveredArea = haydenIntersectionArea(base, source),
    remainderArea = parts.reduce((n, p) => n + haydenFootprintArea(p), 0);
  let sourceRemainderOverlap = 0,
    remainderPairOverlap = 0,
    outsideBaseline = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i],
      area = haydenFootprintArea(p);
    if (
      p.geometryMeasured !== false ||
      p.inferredWalls !== true ||
      p.baselineBuildingId !== base.id ||
      p.minHeight !== 0 ||
      p.height !== base.height ||
      !p.id ||
      parts.some((other, j) => i !== j && other.id === p.id)
    )
      throw new Error(
        'Hayden remainder must retain explicit baseline height and inferred geometry provenance',
      );
    expectNear(area, p.areaM2, 'remainder area');
    outsideBaseline += Math.max(0, area - haydenIntersectionArea(base, p));
    sourceRemainderOverlap += haydenIntersectionArea(source, p);
    for (let j = i + 1; j < parts.length; j++) remainderPairOverlap += haydenIntersectionArea(p, parts[j]);
  }
  if (
    outsideBaseline > AREA_EPSILON ||
    sourceRemainderOverlap > AREA_EPSILON ||
    remainderPairOverlap > AREA_EPSILON ||
    Math.abs(baseArea - coveredArea - remainderArea) > AREA_EPSILON
  )
    throw new Error('Hayden partition loses baseline area or introduces duplicate/outside fallback volume');
  const result = {
    baselineAreaM2: baseArea,
    measuredFootprintAreaM2: sourceArea,
    baselineCoveredAreaM2: coveredArea,
    baselineCoveredFraction: coveredArea / baseArea,
    measuredOutsideBaselineAreaM2: sourceArea - coveredArea,
    remainderAreaM2: remainderArea,
    replacementUnionAreaM2: sourceArea + remainderArea,
    targetUnionAreaM2: baseArea + sourceArea - coveredArea,
    lostBaselineAreaM2: Math.max(0, baseArea - coveredArea - remainderArea),
    lostSourceAreaM2: 0,
    sourceRemainderOverlapAreaM2: sourceRemainderOverlap,
    remainderPairOverlapAreaM2: remainderPairOverlap,
    replacementTargetSymmetricDifferenceAreaM2: Math.abs(baseArea - coveredArea - remainderArea),
    remainderPieceCount: parts.length,
  };
  for (const [key, actual] of Object.entries(result)) expectNear(actual, proof[key], key);
  expectNear(sourceArea, 284.1988, 'pinned measured footprint');
  return result;
}
function footprintShape(poly) {
  const shape = new THREE.Shape(ringPoints(poly.ring).map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const ring of poly.holes || [])
    shape.holes.push(new THREE.Path(ringPoints(ring).map(([x, z]) => new THREE.Vector2(x, -z))));
  return shape;
}
function baselineIdentity(b) {
  return JSON.stringify({
    id: b.id,
    kind: b.kind,
    source: b.source,
    height: b.height,
    ring: b.ring,
    holes: b.holes || [],
  });
}
function sourceTriangles(record, bytes, quantization) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    vertices = Array.from({ length: record.vertexCount }, (_, i) => {
      const o = record.offset + i * 6;
      return [
        record.origin[0] + view.getInt16(o, true) * quantization,
        view.getInt16(o + 2, true) * quantization,
        record.origin[1] + view.getInt16(o + 4, true) * quantization,
      ];
    }),
    offset = record.offset + record.vertexCount * 6,
    triangles = [];
  for (let i = 0; i < record.indexCount; i += 3) {
    const face = [0, 1, 2].map((j) => vertices[view.getUint16(offset + (i + j) * 2, true)]);
    if (face.some((p) => !p))
      throw new Error('Hayden source triangle index exceeds the exact vertex payload');
    const xz = face.map(([x, , z]) => [x, z]);
    if (Math.abs(signedArea(xz)) > 1e-8) triangles.push({ face, xz });
  }
  return triangles;
}
function roofHeight(triangles, x, z) {
  let result = null;
  for (const { face } of triangles) {
    const [a, b, c] = face,
      abx = b[0] - a[0],
      abz = b[2] - a[2],
      acx = c[0] - a[0],
      acz = c[2] - a[2],
      det = abx * acz - abz * acx,
      u = ((x - a[0]) * acz - (z - a[2]) * acx) / det,
      v = (abx * (z - a[2]) - abz * (x - a[0])) / det;
    if (u < -POSITION_EPSILON || v < -POSITION_EPSILON || u + v > 1 + POSITION_EPSILON) continue;
    const y = a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v;
    result = result === null ? y : Math.max(result, y);
  }
  return result;
}

/** All-or-nothing provider: a measured partial shell never silently consumes the
 * other houses in its coarser baseline compound. No GPU objects are retained. */
export function createHaydenBlock(data, manifest, binary) {
  const partial = manifest?.meta?.partialCompound,
    baseline = data?.buildings?.find((b) => b.id === HAYDEN_BLOCK_BASELINE_ID),
    bytes = binaryBytes(binary);
  if (!partial || !baseline || baselineIdentity(baseline) !== baselineIdentity(partial.baselineDefinition))
    throw new Error(
      'Hayden baseline compound changed; keep its original body until a new partition is proved',
    );
  if (
    data.meta?.origin?.lon !== manifest.meta.origin.lon ||
    data.meta?.origin?.lat !== manifest.meta.origin.lat ||
    partial.baselineMapSha256 !== manifest.meta.baseMapSha256
  )
    throw new Error('Hayden source projection/baseline provenance does not match');
  if (
    bytes.byteLength !== 1156 ||
    fnv1a(bytes) !== SOURCE_FNV1A ||
    manifest.meta.binarySha256 !== HAYDEN_BLOCK_SOURCE_SHA256 ||
    partial.sourceBinarySha256 !== HAYDEN_BLOCK_SOURCE_SHA256 ||
    partial.sourcePayloadSha256 !== HAYDEN_BLOCK_SOURCE_PAYLOAD_SHA256
  )
    throw new Error('Hayden source payload differs from the pinned exact City fragment');
  const source = createCityMeshes(manifest, bytes),
    record = source.get(HAYDEN_BLOCK_SOURCE_ID);
  if (
    source.count !== 1 ||
    !record ||
    record.structureIds?.length !== 1 ||
    record.structureIds[0] !== 1413988 ||
    record.vertexCount !== 82 ||
    record.indexCount !== 324 ||
    record.indexBytes !== 2 ||
    record.ground !== 1047.955 ||
    record.height !== 8.56 ||
    record.minHeight !== -1.42 ||
    record.origin[0] !== -1143.44 ||
    record.origin[1] !== -764.62 ||
    manifest.meta.quantization !== 0.02
  )
    throw new Error('Hayden source identity/datum is ambiguous');
  const partition = auditHaydenPartition(partial),
    projected = sourceTriangles(record, bytes, manifest.meta.quantization),
    footprintTriangles = trianglesOf(partial.sourceFootprint);
  for (const triangle of projected) {
    const area = Math.abs(signedArea(triangle.xz)),
      inside = footprintTriangles.reduce((n, t) => n + triangleIntersectionArea(triangle.xz, t), 0);
    expectNear(inside, area, 'source triangle projection');
  }
  const heightAt = (x, z) => roofHeight(projected, x, z),
    contactHeight = createMeshHeightSampler(projected.map(({ face }) => face.map((p) => p.map(Math.fround)))),
    measuredPart = {
      id: `${HAYDEN_BLOCK_SOURCE_ID}-collision`,
      ...partial.sourceFootprint,
      baselineBuildingId: HAYDEN_BLOCK_BASELINE_ID,
      sourceModelId: HAYDEN_BLOCK_SOURCE_ID,
      sourceType: 'measured-city-partial-shell',
      sourceDates: record.sourceDates,
      sourceDateMeaning: partial.sourceDateMeaning,
      areaM2: partition.measuredFootprintAreaM2,
      geometryMeasured: true,
      inferredWalls: false,
      solidInteriorInferred: true,
      collisionEnvelope: 'source-projection-under-measured-roof',
      minHeight: record.minHeight,
      height: record.height,
      heightAt: (x, z, body) => (body ? contactHeight(x, z, body) : (heightAt(x, z) ?? contactHeight(x, z))),
      ground: record.ground,
      groundMin: record.groundMin,
      groundMax: record.groundMax,
    },
    collisionParts = [measuredPart, ...partial.remainderParts.map((p) => ({ ...p }))],
    combinedRecord = {
      id: HAYDEN_BLOCK_BASELINE_ID,
      sourceType: 'partial-city-shell-with-retained-baseline-remainder',
      measured: false,
      geometryMeasured: false,
      hasMeasuredFragment: true,
      measuredFootprintCoverage: partition.baselineCoveredFraction,
      height: Math.max(record.height, ...partial.remainderParts.map((p) => p.height)),
      minHeight: Math.min(record.minHeight, ...partial.remainderParts.map((p) => p.minHeight)),
      structureIds: record.structureIds,
      sourceDates: record.sourceDates,
      sourceDateMeaning: partial.sourceDateMeaning,
      partialCompound: true,
    };
  const createGeometry = (id) => {
    if (id === HAYDEN_BLOCK_SOURCE_ID) return source.createGeometry(id);
    if (id !== HAYDEN_BLOCK_BASELINE_ID) return null;
    const parts = [source.createGeometry(HAYDEN_BLOCK_SOURCE_ID)];
    try {
      for (const remainder of partial.remainderParts) {
        const g = new THREE.ExtrudeGeometry(footprintShape(remainder), {
          depth: remainder.height,
          bevelEnabled: false,
          steps: 1,
          curveSegments: 1,
        });
        g.rotateX(-Math.PI / 2);
        if (g.index) {
          const expanded = g.toNonIndexed();
          g.dispose();
          parts.push(expanded);
        } else parts.push(g);
      }
      const geometry = mergeGeometries(parts, false);
      if (!geometry) throw new Error('Hayden complete measured/remainder shell could not be constructed');
      geometry.userData.haydenBlock = {
        baselineBuildingId: HAYDEN_BLOCK_BASELINE_ID,
        measuredSourceModelId: HAYDEN_BLOCK_SOURCE_ID,
        measuredTriangles: record.indexCount / 3,
        retainedBaselineRemainderIds: partial.remainderParts.map((p) => p.id),
        entireCompoundMeasured: false,
      };
      return geometry;
    } finally {
      for (const geometry of parts) geometry.dispose();
    }
  };
  // Only expose ownership after every measured/remainder geometry is constructible.
  const probe = createGeometry(HAYDEN_BLOCK_BASELINE_ID);
  try {
    for (const key of ['position', 'normal', 'uv'])
      if (!probe.getAttribute(key)?.array.every(Number.isFinite))
        throw new Error('Hayden partial shell has invalid geometry attributes');
  } finally {
    probe.dispose();
  }
  return {
    ready: true,
    manifest,
    partial,
    source,
    partition,
    replacedBuildingIds: new Set([HAYDEN_BLOCK_BASELINE_ID]),
    sourceModelIds: new Set([HAYDEN_BLOCK_SOURCE_ID]),
    has: (id) => id === HAYDEN_BLOCK_BASELINE_ID || id === HAYDEN_BLOCK_SOURCE_ID,
    hasGeometry: (id) => id === HAYDEN_BLOCK_BASELINE_ID || id === HAYDEN_BLOCK_SOURCE_ID,
    get: (id) =>
      id === HAYDEN_BLOCK_BASELINE_ID
        ? combinedRecord
        : id === HAYDEN_BLOCK_SOURCE_ID
          ? {
              ...record,
              measured: true,
              geometryMeasured: true,
              sourceType: 'measured-city-partial-shell',
              partialCompoundFragment: true,
            }
          : null,
    createGeometry,
    photoWallGeometry: (id) => (id === HAYDEN_BLOCK_SOURCE_ID ? source.createGeometry(id) : null),
    collisionParts: (id) =>
      id === HAYDEN_BLOCK_BASELINE_ID
        ? collisionParts
        : id === HAYDEN_BLOCK_SOURCE_ID
          ? [measuredPart]
          : null,
    roofHeightAt: (id, x, z) => (id === HAYDEN_BLOCK_SOURCE_ID ? heightAt(x, z) : null),
    stats: {
      partialCompounds: 1,
      measuredFragments: 1,
      measuredTriangles: record.indexCount / 3,
      retainedFallbackPieces: partial.remainderParts.length,
      measuredBaselineAreaM2: partition.baselineCoveredAreaM2,
      retainedBaselineAreaM2: partition.remainderAreaM2,
      wholeCompoundsMeasured: 0,
    },
  };
}

export async function loadHaydenBlock(data, { fetcher = globalThis.fetch, signal } = {}) {
  const [sourceMap, jsonResponse, binaryResponse] = await Promise.all([
    data,
    fetcher(HAYDEN_BLOCK_MANIFEST_URL, { signal }),
    fetcher(HAYDEN_BLOCK_BINARY_URL, { signal }),
  ]);
  if (!jsonResponse.ok || !binaryResponse.ok)
    throw new Error(
      `Hayden fragment could not load (${jsonResponse.status}/${binaryResponse.status}); retain baseline compound`,
    );
  const [manifest, binary] = await Promise.all([jsonResponse.json(), binaryResponse.arrayBuffer()]);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', binary),
      sha = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (sha !== HAYDEN_BLOCK_SOURCE_SHA256)
      throw new Error('Hayden source SHA256 mismatch; retain baseline compound');
  }
  return createHaydenBlock(sourceMap, manifest, binary);
}
