import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCityMeshes } from './city-meshes.js';
import {
  projectedMeshHeightAt as roofAt,
  createMeshHeightSampler as createPartialRoofSampler,
} from './mesh-height-envelope.js';
export { createMeshHeightSampler as createPartialRoofSampler } from './mesh-height-envelope.js';

export const PARTIAL_BUILDING_MANIFEST_URL = new URL(
  '../data/PARTIAL_BUILDING_EVIDENCE_MESHES.json',
  import.meta.url,
);
export const PARTIAL_BUILDING_BINARY_URL = new URL(
  '../data/PARTIAL_BUILDING_EVIDENCE_MESHES.bin',
  import.meta.url,
);
export const PARTIAL_BUILDING_BINARY_SHA256 =
  'd79cb7ae2f7617dfcdbf23fc086a4219818f37a8b35babfe10ff2895372ee620';
export const PARTIAL_BUILDING_MANIFEST_SHA256 =
  'b1e6b5cfb8422372e901f12a73abf9769892b017b4390d5b802a4c7efb41e176';
const EXPECTED_IDS = [
  'city-outline-23213-0',
  'city-outline-13362-0',
  'city-outline-20647-0',
  'city-outline-14240-0',
  'city-outline-26066-0',
];
const AREA_EPS = 0.00002;
const bytesOf = (binary) =>
  binary instanceof ArrayBuffer
    ? new Uint8Array(binary)
    : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
function fnv1a(bytes) {
  let n = 2166136261;
  for (const b of bytes) n = Math.imul(n ^ b, 16777619) >>> 0;
  return n;
}
function ringPoints(ring) {
  if (
    !Array.isArray(ring) ||
    ring.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
  )
    throw new Error('Invalid partial-source footprint');
  const points = ring.map((p) => [...p]);
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1])
    points.pop();
  if (points.length < 3) throw new Error('Partial-source footprint needs three vertices');
  return points;
}
function signedArea(ring) {
  const [ox, oz] = ring[0];
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    n += (a[0] - ox) * (b[1] - oz) - (a[1] - oz) * (b[0] - ox);
  }
  return n / 2;
}
export function partialFootprintArea(poly) {
  return (
    Math.abs(signedArea(ringPoints(poly.ring))) -
    (poly.holes || []).reduce((n, ring) => n + Math.abs(signedArea(ringPoints(ring))), 0)
  );
}
function footprintTriangles(poly) {
  const rings = [poly.ring, ...(poly.holes || [])].map(ringPoints),
    flat = rings.flat(),
    [ox, oz] = rings[0][0],
    vectors = rings.map((ring) => ring.map(([x, z]) => new THREE.Vector2(x - ox, z - oz)));
  const faces = THREE.ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)),
    triangles = faces.map((face) => face.map((i) => flat[i]));
  const area = triangles.reduce((n, t) => n + Math.abs(signedArea(t)), 0);
  if (Math.abs(area - partialFootprintArea(poly)) > AREA_EPS)
    throw new Error('Partial footprint triangulation lost area or a courtyard');
  return triangles;
}
function triangleOverlap(a, b) {
  const orientation = Math.sign(signedArea(b));
  if (orientation === 0) return 0;
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
        inside = currentSide >= 0,
        wasInside = previousSide >= 0;
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
export function partialIntersectionArea(a, b) {
  const aa = footprintTriangles(a),
    bb = footprintTriangles(b);
  let result = 0;
  for (const ta of aa) for (const tb of bb) result += triangleOverlap(ta, tb);
  return result;
}
export function partialPlaneHeight(plane, x, z) {
  const [a, b, c] = plane.coefficients,
    [ox, oz] = plane.origin;
  return a * (x - ox) + b * (z - oz) + c;
}
const near = (a, b, label) => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > AREA_EPS)
    throw new Error(`Partial composition ${label} proof does not match`);
};
function identity(b) {
  return JSON.stringify({
    id: b.id,
    kind: b.kind,
    source: b.source,
    height: b.height,
    ring: b.ring,
    holes: b.holes || [],
  });
}

/** Independent polygon triangulation/clipping proof. Even subpixel source-seam
 * ownership remains represented instead of silently discarded as tiny area. */
export function auditPartialComposition(compound) {
  const base = compound.baselineDefinition,
    proof = compound.partitionProof,
    footprints = Object.values(compound.sourceFootprints || {}).flat(),
    parts = compound.remainderParts;
  if (
    !base ||
    base.id !== compound.baselineId ||
    !proof ||
    !footprints.length ||
    !Array.isArray(parts) ||
    !parts.length
  )
    throw new Error('Incomplete partial building composition');
  const baseArea = partialFootprintArea(base),
    sourceArea = footprints.reduce((n, p) => n + partialFootprintArea(p), 0),
    coveredArea = footprints.reduce((n, p) => n + partialIntersectionArea(base, p), 0),
    remainderArea = parts.reduce((n, p) => n + partialFootprintArea(p), 0);
  let overlap = 0,
    pairOverlap = 0,
    outside = 0,
    sourcePairOverlap = 0;
  const partIds = new Set();
  for (let i = 0; i < footprints.length; i++)
    for (let j = i + 1; j < footprints.length; j++)
      sourcePairOverlap += partialIntersectionArea(footprints[i], footprints[j]);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i],
      area = partialFootprintArea(p);
    if (
      !p.id ||
      partIds.has(p.id) ||
      p.baselineBuildingId !== base.id ||
      p.geometryMeasured !== false ||
      p.inferredWalls !== true ||
      p.minHeight !== 0
    )
      throw new Error('Partial remainder ownership/provenance is invalid');
    partIds.add(p.id);
    near(area, p.areaM2, 'remainder area');
    if (p.quantizationSeam) {
      const plane = p.sourceRoofPlane,
        triangle = plane?.sourceTriangle;
      if (
        p.ownershipRetained !== true ||
        p.roofMeasured !== true ||
        p.baselineOriginalHeight !== base.height ||
        area > 0.05 ||
        p.sourceRoofCoverage < 0.99999 ||
        p.maximumBoundaryExtrapolationM > 1e-7 ||
        !compound.sourceModelIds.includes(p.sourceModelId) ||
        plane?.coefficients?.length !== 3 ||
        plane?.origin?.length !== 2 ||
        ![...plane.coefficients, ...plane.origin].every(Number.isFinite) ||
        triangle?.length !== 3 ||
        triangle.some((v) => v.length !== 3 || !v.every(Number.isFinite))
      )
        throw new Error('Unproved original-roof quantization seam');
      for (const vertex of triangle)
        near(partialPlaneHeight(plane, vertex[0], vertex[2]), vertex[1], 'original roof plane');
      near(Math.max(...p.ring.map(([x, z]) => partialPlaneHeight(plane, x, z))), p.height, 'seam roof bound');
    } else if (p.height !== base.height || p.sourceType !== 'retained-baseline-remainder')
      throw new Error('Ordinary partial remainder changed the baseline height');
    outside += Math.max(0, area - partialIntersectionArea(base, p));
    for (const footprint of footprints) overlap += partialIntersectionArea(footprint, p);
    for (let j = i + 1; j < parts.length; j++) pairOverlap += partialIntersectionArea(p, parts[j]);
  }
  if (
    Math.max(
      outside,
      overlap,
      pairOverlap,
      sourcePairOverlap,
      Math.abs(baseArea - coveredArea - remainderArea),
    ) > AREA_EPS
  )
    throw new Error('Partial composition loses area or duplicates another body');
  const result = {
    baselineAreaM2: baseArea,
    sourceAreaM2: sourceArea,
    baselineCoveredAreaM2: coveredArea,
    baselineCoveredFraction: coveredArea / baseArea,
    sourceOutsideBaselineAreaM2: sourceArea - coveredArea,
    remainderAreaM2: remainderArea,
    replacementUnionAreaM2: sourceArea + remainderArea,
    targetUnionAreaM2: baseArea + sourceArea - coveredArea,
    lostBaselineAreaM2: Math.max(0, baseArea - coveredArea - remainderArea),
    lostSourceAreaM2: 0,
    sourceRemainderOverlapAreaM2: overlap,
    remainderPairOverlapAreaM2: pairOverlap,
    targetSymmetricDifferenceAreaM2: Math.abs(baseArea - coveredArea - remainderArea),
  };
  for (const [key, value] of Object.entries(result)) near(value, proof[key], key);
  return result;
}
function shapeOf(poly) {
  const s = new THREE.Shape(ringPoints(poly.ring).map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const hole of poly.holes || [])
    s.holes.push(new THREE.Path(ringPoints(hole).map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}
function projectedFaces(geometry) {
  const position = geometry.getAttribute('position'),
    result = [];
  for (let i = 0; i < position.count; i += 3) {
    const face = [0, 1, 2].map((j) => [position.getX(i + j), position.getY(i + j), position.getZ(i + j)]);
    if (Math.abs(signedArea(face.map(([x, , z]) => [x, z]))) > 1e-8) result.push(face);
  }
  return result;
}

function remainderGeometry(part) {
  const g = new THREE.ExtrudeGeometry(shapeOf(part), {
    depth: part.height,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  if (part.quantizationSeam) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++)
      if (p.getY(i) > 0.00001) p.setY(i, partialPlaneHeight(part.sourceRoofPlane, p.getX(i), p.getZ(i)));
    p.needsUpdate = true;
    g.computeVertexNormals();
  }
  if (!g.index) return g;
  const expanded = g.toNonIndexed();
  g.dispose();
  return expanded;
}

/** Validate complete source/remainder compositions without automatic activation.
 * The world must install a COMPLETE composition before skipping its original
 * baseline; measured fragments alone never consume the inferred remainder. */
export function createPartialBuildings(data, manifest, binary) {
  return createPartialBuildingBatch(data, manifest, binary, {
    binaryBytes: 5872,
    binaryFnv: 3866507842,
    binarySha256: PARTIAL_BUILDING_BINARY_SHA256,
    manifestFnv: 622730834,
    sourceCount: 5,
    ids: EXPECTED_IDS,
  });
}

/** Shared proof for independently pinned batches. The caller supplies audited
 * source pins; baseline/source/remainder validation remains identical per batch.
 */
export function createPartialBuildingBatch(data, manifest, binary, pins) {
  const bytes = bytesOf(binary);
  if (
    bytes.byteLength !== pins.binaryBytes ||
    fnv1a(bytes) !== pins.binaryFnv ||
    manifest?.meta?.binarySha256 !== pins.binarySha256
  )
    throw new Error('Partial source binary differs from the pinned original City export');
  if (fnv1a(new TextEncoder().encode(JSON.stringify(manifest))) !== pins.manifestFnv)
    throw new Error('Partial source manifest/partition differs from the pinned evidence');
  if (
    data?.meta?.origin?.lon !== manifest.meta.origin.lon ||
    data.meta.origin.lat !== manifest.meta.origin.lat
  )
    throw new Error('Partial source projection differs from the baseline map');
  const source = createCityMeshes(manifest, bytes),
    compounds = new Map(),
    sourceToCompound = new Map(),
    sourceFaces = new Map(),
    partsById = new Map();
  if (source.count !== pins.sourceCount || manifest.meta.partialCompounds?.length !== pins.ids.length)
    throw new Error('Partial source owner count changed');
  for (const compound of manifest.meta.partialCompounds) {
    const base = data.buildings.find((b) => b.id === compound.baselineId);
    if (
      !pins.ids.includes(compound.baselineId) ||
      compounds.has(compound.baselineId) ||
      !base ||
      identity(base) !== identity(compound.baselineDefinition)
    )
      throw new Error('Partial baseline changed; retain its complete original fallback');
    const partition = auditPartialComposition(compound),
      collision = [];
    for (const id of compound.sourceModelIds) {
      const record = source.get(id);
      if (!record || record.baselineBuildingId !== base.id || sourceToCompound.has(id))
        throw new Error('Partial source body ownership is ambiguous');
      const geometry = source.createGeometry(id);
      let faces;
      try {
        faces = projectedFaces(geometry);
      } finally {
        geometry.dispose();
      }
      sourceFaces.set(id, faces);
      sourceToCompound.set(id, compound);
      const contactHeight = createPartialRoofSampler(faces);
      for (const [i, footprint] of compound.sourceFootprints[id].entries())
        collision.push({
          id: `${id}-collision-${i + 1}`,
          ...footprint,
          baselineBuildingId: base.id,
          sourceModelId: id,
          sourceType: 'measured-city-partial-fragment',
          geometryMeasured: true,
          inferredWalls: false,
          solidInteriorInferred: true,
          minHeight: record.minHeight,
          height: record.height,
          heightAt: contactHeight,
          ground: record.ground,
          groundMin: record.groundMin,
          groundMax: record.groundMax,
          sourceDates: record.sourceDates,
          sourceDateMeaning: manifest.meta.sourceRecordDateMeaning,
        });
    }
    for (const p of compound.remainderParts)
      collision.push({
        ...p,
        ...(p.quantizationSeam
          ? {
              heightAt: createPartialRoofSampler(
                footprintTriangles(p).map((triangle) =>
                  triangle.map(([x, z]) => [x, partialPlaneHeight(p.sourceRoofPlane, x, z), z]),
                ),
              ),
              storefrontAnchor: false,
              solidInteriorInferred: true,
            }
          : {}),
      });
    partsById.set(base.id, collision);
    compounds.set(base.id, { compound, partition });
  }
  const createGeometry = (id) => {
    if (source.has(id)) return source.createGeometry(id);
    const entry = compounds.get(id);
    if (!entry) return null;
    const parts = entry.compound.sourceModelIds.map((sourceId) => source.createGeometry(sourceId));
    try {
      for (const p of entry.compound.remainderParts) parts.push(remainderGeometry(p));
      const geometry = mergeGeometries(parts, false);
      if (!geometry) throw new Error('Complete partial measured/remainder geometry could not be built');
      geometry.userData.partialCity = {
        baselineBuildingId: id,
        sourceModelIds: entry.compound.sourceModelIds,
        measuredTriangles: entry.compound.sourceModelIds.reduce(
          (n, sourceId) => n + source.get(sourceId).indexCount / 3,
          0,
        ),
        wholeCompoundMeasured: false,
        retainedFallbackIds: entry.compound.remainderParts.map((r) => r.id),
      };
      return geometry;
    } finally {
      for (const g of parts) g.dispose();
    }
  };
  // No replacement ownership is exposed until every whole composition exists.
  for (const id of compounds.keys()) {
    const probe = createGeometry(id);
    try {
      for (const name of ['position', 'normal', 'uv'])
        if (!probe.getAttribute(name)?.array.every(Number.isFinite))
          throw new Error('Partial composition has invalid attributes');
    } finally {
      probe.dispose();
    }
  }
  const get = (id) => {
    if (source.has(id))
      return { ...source.get(id), geometryMeasured: true, measured: true, partialCompoundFragment: true };
    const entry = compounds.get(id);
    if (!entry) return null;
    const records = entry.compound.sourceModelIds.map((id) => source.get(id));
    return {
      id,
      sourceType: 'partial-city-fragments-with-retained-baseline-remainder',
      measured: false,
      geometryMeasured: false,
      hasMeasuredFragments: true,
      partialCompound: true,
      wholeCompoundMeasured: false,
      measuredFootprintCoverage: entry.partition.baselineCoveredFraction,
      height: Math.max(entry.compound.baselineDefinition.height, ...records.map((r) => r.height)),
      minHeight: Math.min(0, ...records.map((r) => r.minHeight)),
      structureIds: records.flatMap((r) => r.structureIds),
      sourceDates: [...new Set(records.flatMap((r) => r.sourceDates))],
      sourceDateMeaning: manifest.meta.sourceRecordDateMeaning,
    };
  };
  return {
    ready: true,
    active: false,
    manifest,
    source,
    replacedBuildingIds: new Set(compounds.keys()),
    sourceModelIds: new Set(sourceToCompound.keys()),
    has: (id) => source.has(id) || compounds.has(id),
    hasGeometry: (id) => source.has(id) || compounds.has(id),
    get,
    createGeometry,
    photoWallGeometry: (id) => (source.has(id) ? source.createGeometry(id) : null),
    collisionParts: (id) =>
      partsById.get(id) ||
      (sourceToCompound.has(id)
        ? partsById
            .get(sourceToCompound.get(id).baselineId)
            .filter((p) => p.sourceModelId === id && p.geometryMeasured === true)
        : null),
    roofHeightAt: (id, x, z) => (sourceFaces.has(id) ? roofAt(sourceFaces.get(id), x, z) : null),
    composition: (id) => compounds.get(id) || null,
    stats: {
      proposedPartialCompounds: compounds.size,
      measuredFragments: source.count,
      measuredTriangles: manifest.meta.counts.triangles,
      retainedFallbackPieces: manifest.meta.counts.retainedFallbackPieces,
      originalRoofSupportedSeamPieces: manifest.meta.counts.originalRoofSupportedSeamPieces,
      fullyMeasuredCompounds: 0,
      currentArchitectureVerified: 0,
    },
  };
}

export async function loadPartialBuildings(data, { fetcher = globalThis.fetch, signal } = {}) {
  const [sourceMap, jsonResponse, binaryResponse] = await Promise.all([
    data,
    fetcher(PARTIAL_BUILDING_MANIFEST_URL, { signal }),
    fetcher(PARTIAL_BUILDING_BINARY_URL, { signal }),
  ]);
  if (!jsonResponse.ok || !binaryResponse.ok)
    throw new Error('Partial building assets unavailable; retain complete fallback ownership');
  const [manifest, binary] = await Promise.all([jsonResponse.json(), binaryResponse.arrayBuffer()]);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', binary),
      hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (hash !== PARTIAL_BUILDING_BINARY_SHA256) throw new Error('Partial building source SHA256 mismatch');
  }
  return createPartialBuildings(sourceMap, manifest, binary);
}
