import { createCityMeshes } from './city-meshes.js';
import { BufferAttribute } from 'three/webgpu';
import { createRegionalMeshContacts } from './regional-mesh-contacts.js';
import { unpackMapDataTransport } from './map-data-transport.js';

const MANIFEST = new URL('../data/calgary-copc-roofs.json', import.meta.url);
const BINARY = new URL('../data/calgary-copc-roofs.bin', import.meta.url);
export const OPEN_ROOF_THICKNESS_M = 0.18;
const ROOF_QUANTIZATION_TOLERANCE_M = 0.055;
const invalid = () => new Error('Measured roofs require source provenance and validated fit evidence');

function roofHeight(record, x, z) {
  const localX = x - record.centroid[0],
    localZ = z - record.centroid[1];
  return Math.min(...record.roofPlanesLocalToCentroid.map(([a, b, c]) => a * localX + b * localZ + c));
}

function validEnvelope(record) {
  if (record.roofOnly !== true) return record.inferredWalls === true && record.minHeight === 0;
  return (
    record.inferredWalls === false &&
    record.wallTriangles === 0 &&
    record.storefrontAnchor === false &&
    record.inferredCollisionThicknessM === OPEN_ROOF_THICKNESS_M &&
    Number.isInteger(record.roofTriangles) &&
    record.roofTriangles >= 1 &&
    record.indexCount === record.roofTriangles * 3 &&
    Number.isFinite(record.minHeight) &&
    record.minHeight > 1.2 &&
    record.minHeight < record.height &&
    Array.isArray(record.collisionParts) &&
    record.collisionParts.length > 0
  );
}

function boundaryEdges(geometry) {
  const p = geometry.attributes.position,
    edges = new Map();
  for (let i = 0; i < p.count; i += 3)
    for (let j = 0; j < 3; j++) {
      const a = [p.getX(i + j), p.getY(i + j), p.getZ(i + j)],
        k = i + ((j + 1) % 3),
        b = [p.getX(k), p.getY(k), p.getZ(k)],
        ka = a.join(','),
        kb = b.join(','),
        key = ka < kb ? `${ka}/${kb}` : `${kb}/${ka}`;
      const previous = edges.get(key);
      if (previous) previous.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  if ([...edges.values()].some((e) => e.count > 2)) throw invalid();
  return [...edges.values()].filter((e) => e.count === 1);
}

function validRing(ring) {
  return (
    Array.isArray(ring) &&
    ring.length >= 3 &&
    ring.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
  );
}

function validateOpenRoof(record, geometry) {
  const p = geometry.attributes.position,
    n = geometry.attributes.normal;
  let minimum = Infinity,
    maximum = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    if (
      !Number.isFinite(x + y + z) ||
      n.getY(i) < 0.45 ||
      Math.abs(y - roofHeight(record, x, z)) > ROOF_QUANTIZATION_TOLERANCE_M
    )
      throw invalid();
    minimum = Math.min(minimum, y);
    maximum = Math.max(maximum, y);
  }
  // Vertex agreement alone cannot detect a flat triangle drawn across a gable
  // ridge: its corners may all touch the fitted envelope while its centre does
  // not. Keep the rendered surface and collision plane consistent internally.
  for (let i = 0; i < p.count; i += 3) {
    const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3,
      y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3,
      z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    if (Math.abs(y - roofHeight(record, x, z)) > ROOF_QUANTIZATION_TOLERANCE_M) throw invalid();
  }
  if (
    Math.abs(record.minHeight - (minimum - OPEN_ROOF_THICKNESS_M)) > ROOF_QUANTIZATION_TOLERANCE_M ||
    Math.abs(record.height - maximum) > ROOF_QUANTIZATION_TOLERANCE_M
  )
    throw invalid();
  for (const part of record.collisionParts) {
    if (
      !part ||
      !validRing(part.ring) ||
      !Array.isArray(part.holes || []) ||
      !(part.holes || []).every(validRing) ||
      !Number.isFinite(part.minHeight + part.height) ||
      part.minHeight >= part.height
    )
      throw invalid();
    const heights = [part.ring, ...(part.holes || [])].flatMap((r) =>
      r.map(([x, z]) => roofHeight(record, x, z)),
    );
    if (
      Math.abs(part.minHeight - (Math.min(...heights) - OPEN_ROOF_THICKNESS_M)) >
        ROOF_QUANTIZATION_TOLERANCE_M ||
      Math.abs(part.height - Math.max(...heights)) > ROOF_QUANTIZATION_TOLERANCE_M
    )
      throw invalid();
  }
  const edges = boundaryEdges(geometry);
  if (edges.length < 3) throw invalid();
  return edges;
}

/** Keep measured top vertices first; add only an explicitly inferred thin band. */
function addOpenRoofBand(geometry, edges) {
  const p = geometry.attributes.position,
    n = geometry.attributes.normal,
    sourceCount = p.count,
    extraCount = sourceCount + edges.length * 6,
    positions = new Float32Array((sourceCount + extraCount) * 3),
    normals = new Float32Array(positions.length);
  positions.set(p.array);
  normals.set(n.array);
  let out = sourceCount * 3;
  for (let i = 0; i < sourceCount; i += 3)
    for (const j of [0, 2, 1]) {
      const k = i + j;
      positions.set([p.getX(k), p.getY(k) - OPEN_ROOF_THICKNESS_M, p.getZ(k)], out);
      normals.set([-n.getX(k), -n.getY(k), -n.getZ(k)], out);
      out += 3;
    }
  for (const { a, b } of edges) {
    const al = [a[0], a[1] - OPEN_ROOF_THICKNESS_M, a[2]],
      bl = [b[0], b[1] - OPEN_ROOF_THICKNESS_M, b[2]],
      dx = b[0] - a[0],
      dz = b[2] - a[2],
      length = Math.hypot(dx, dz) || 1,
      normal = [-dz / length, 0, dx / length];
    for (const q of [a, al, bl, a, bl, b]) {
      positions.set(q, out);
      normals.set(normal, out);
      out += 3;
    }
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array((sourceCount + extraCount) * 2), 2));
  return {
    sourceTopTriangles: sourceCount / 3,
    inferredUndersideTriangles: sourceCount / 3,
    inferredRoofEdgeTriangles: edges.length * 2,
  };
}

/** Local measured roof fits; closed facades and open roof thickness stay inferred. */
export async function loadCanElevationRoofs({ fetcher = globalThis.fetch, signal } = {}) {
  const [manifestResponse, binaryResponse] = await Promise.all([
    fetcher(MANIFEST, { signal }),
    fetcher(BINARY, { signal }),
  ]);
  if (!manifestResponse.ok || !binaryResponse.ok)
    throw new Error('Measured roof reconstructions could not be loaded');
  const [manifest, binary] = await Promise.all([
    manifestResponse.json().then(unpackMapDataTransport),
    binaryResponse.arrayBuffer(),
  ]);
  return createCanElevationRoofs(manifest, binary);
}

export function createCanElevationRoofs(manifest, binary) {
  if (
    !manifest?.meta?.baseMapSha256 ||
    manifest.meta.project !== 'Calgary_West_utm11_2020' ||
    !manifest.buildings?.every(
      (r) =>
        r.sourceType === 'canelevation-fitted-roof' &&
        r.measuredRoof === true &&
        r.measuredGeometry === false &&
        validEnvelope(r) &&
        r.groundDatum === 'CGVD2013' &&
        r.height >= 1.5 &&
        r.height <= 40 &&
        r.fit?.trainingPoints >= 100 &&
        r.fit.heldOutPoints >= 40 &&
        r.fit.ground?.pointCount >= 60 &&
        r.fit.ground.rmseM <= 0.16 &&
        r.fit.ground.supportFraction >= 0.45 &&
        r.fit.heldOutInlierFraction >= 0.9 &&
        r.fit.heldOutP90ErrorM <= 0.14 &&
        r.fit.areaSupportFraction >= 0.94 &&
        r.fit.boundarySupportFraction >= 0.9 &&
        (r.independentNRCanContourMatch === true || r.fit.acceptanceClass === 'direct-cloud') &&
        (r.fit.acceptanceClass !== 'direct-cloud' ||
          (r.fit.heldOutInlierFraction >= 0.95 &&
            r.fit.heldOutP90ErrorM <= 0.12 &&
            r.fit.areaSupportFraction >= 0.98 &&
            r.fit.boundarySupportFraction >= 0.95 &&
            r.fit.ground.rmseM <= 0.12 &&
            r.fit.ground.supportFraction >= 0.65)) &&
        r.fit.planeCount >= 1 &&
        r.fit.planeCount <= 6 &&
        Array.isArray(r.roofPlanesLocalToCentroid) &&
        r.roofPlanesLocalToCentroid.length === r.fit.planeCount &&
        r.roofPlanesLocalToCentroid.every(
          (plane) => Array.isArray(plane) && plane.length === 3 && plane.every(Number.isFinite),
        ) &&
        Array.isArray(r.fit.faces) &&
        r.fit.faces.length === r.fit.planeCount &&
        r.fit.faces.every(
          (face) =>
            face.trainingPoints >= 90 &&
            face.rmseM <= 0.13 &&
            face.validationPoints >=
              Math.max(
                r.fit.acceptanceClass === 'direct-cloud' ? 20 : 12,
                // Face areas are serialized to four decimals. Preserve the
                // original integer support gate across that rounding alone.
                Math.ceil(face.areaM2 * (r.fit.acceptanceClass === 'direct-cloud' ? 3 : 2) - 0.0002),
              ),
        ),
    )
  )
    throw invalid();
  const models = createCityMeshes(manifest, binary);
  const openEdges = new Map(),
    openParts = new Map();
  for (const record of manifest.buildings.filter((r) => r.roofOnly === true)) {
    if (
      !Array.isArray(record.centroid) ||
      record.centroid.length !== 2 ||
      !record.centroid.every(Number.isFinite)
    )
      throw invalid();
    const geometry = models.createGeometry(record.id);
    try {
      openEdges.set(record.id, validateOpenRoof(record, geometry));
    } finally {
      geometry.dispose();
    }
    openParts.set(
      record.id,
      record.collisionParts.map((part) => ({
        ...part,
        roofOnly: true,
        inferredWalls: false,
        type: 'fitted-open-roof',
        storefrontAnchor: false,
        inferredCollisionThicknessM: OPEN_ROOF_THICKNESS_M,
        heightAt: (x, z) => roofHeight(record, x, z),
        minHeightAt: (x, z) => roofHeight(record, x, z) - OPEN_ROOF_THICKNESS_M,
      })),
    );
  }
  const contactSource = {
    manifest: models.manifest,
    createGeometry(id) {
      const geometry = models.createGeometry(id);
      if (geometry && models.get(id).roofOnly === true) addOpenRoofBand(geometry, openEdges.get(id));
      return geometry;
    },
  };
  const regionalContacts = createRegionalMeshContacts(
    manifest.buildings.map((record) => ({
      id: record.id,
      source: contactSource,
      parts: record.collisionParts,
      preserveBands: false,
      suspended: record.roofOnly === true,
    })),
  );
  const collisionParts = new Map();
  return {
    ...models,
    hasGeometry: models.has,
    collisionParts(id) {
      if (collisionParts.has(id)) return collisionParts.get(id);
      const record = models.get(id);
      if (!record) return null;
      const local = regionalContacts.collisionParts(id);
      if (!local) return openParts.get(id) || record.collisionParts || null;
      const result = local.map((part) => ({
        ...part,
        ...(record.roofOnly
          ? {
              roofOnly: true,
              inferredWalls: false,
              type: 'fitted-open-roof',
              storefrontAnchor: false,
              inferredCollisionThicknessM: OPEN_ROOF_THICKNESS_M,
            }
          : {}),
        heightAt: (x, z, body) => (body ? part.heightAt(x, z, body) : roofHeight(record, x, z)),
        ...(record.roofOnly
          ? {
              minHeightAt: (x, z, body) =>
                body ? part.minHeightAt(x, z, body) : roofHeight(record, x, z) - OPEN_ROOF_THICKNESS_M,
            }
          : {}),
      }));
      collisionParts.set(id, result);
      return result;
    },
    regionalContactStats: regionalContacts.stats,
    clearContactCache() {
      regionalContacts.clearProjections();
      models.clearContactCache();
    },
    roofHeightAt(id, x, z) {
      const record = models.get(id);
      if (!record || !Number.isFinite(x) || !Number.isFinite(z)) return null;
      return roofHeight(record, x, z);
    },
    minHeightAt(id, x, z) {
      const record = models.get(id);
      if (!record || !Number.isFinite(x) || !Number.isFinite(z)) return null;
      return record.roofOnly === true ? roofHeight(record, x, z) - OPEN_ROOF_THICKNESS_M : record.minHeight;
    },
    createGeometry(id) {
      const geometry = models.createGeometry(id);
      if (geometry) {
        const record = models.get(id),
          open = record.roofOnly === true;
        const band = open ? addOpenRoofBand(geometry, openEdges.get(id)) : null;
        geometry.userData.buildingRecovery = {
          sourceType: 'canelevation-fitted-roof',
          measuredRoof: true,
          measuredGeometry: false,
          inferredWalls: record.inferredWalls,
          ...(open
            ? {
                roofOnly: true,
                storefrontAnchor: false,
                inferredCollisionThicknessM: OPEN_ROOF_THICKNESS_M,
                inferredRenderThicknessM: OPEN_ROOF_THICKNESS_M,
                ...band,
              }
            : {}),
        };
      }
      return geometry;
    },
  };
}
