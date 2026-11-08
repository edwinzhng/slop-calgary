import { createCityMeshes } from './city-meshes.js';
import { createRegionalMeshContacts } from './regional-mesh-contacts.js';
import {
  SUPPLEMENTAL_CONTACT_REGIONS_URL,
  supplementalContactRegions,
} from './supplemental-contact-regions.js';

const RECOVERED_MANIFEST = new URL('../data/calgary-recovered-meshes.json', import.meta.url);
const RECOVERED_BINARY = new URL('../data/calgary-recovered-meshes.bin', import.meta.url);
const PART_MANIFEST = new URL('../data/calgary-fallback-parts.json', import.meta.url);
const PART_BINARY = new URL('../data/calgary-fallback-parts.bin', import.meta.url);
const HEIGHTS = new URL('../data/calgary-fallback-heights.json', import.meta.url);
const VERIFIED_HEIGHTS = new URL('../data/calgary-verified-heights.json', import.meta.url);
const COMPLEX_HEIGHTS = new URL('../data/calgary-copc-heights.json', import.meta.url);
const SOURCE_EXCLUSIONS = new URL('../data/calgary-source-exclusions.json', import.meta.url);

function validComplexHeight(r) {
  const roof = r.roofEvidence,
    corroboration = r.nrcanCorroboration;
  if (
    r.sourceType !== 'canelevation-complex-roof-height-only' ||
    !r.beforeSource?.includes('estimated') ||
    !r.kind ||
    [
      'roof',
      'carport',
      'bus_shelter',
      'lrt_stations_and_shelters',
      'bridge',
      'tent',
      'miscellaneous_(park_buildings/structures)',
    ].includes(r.kind) ||
    r.measured !== true ||
    r.heightMeasured !== true ||
    r.geometryMeasured !== false ||
    r.roofMeasured !== false ||
    r.roofGeometryReplaced !== false ||
    r.groundDatum !== 'CGVD2013' ||
    r.minHeight !== 0 ||
    !r.geometryFailureReason ||
    !/^[a-f0-9]{64}$/.test(r.clippedPointsSha256 || '') ||
    !roof ||
    !Array.isArray(roof.planeTrainingPoints) ||
    !Array.isArray(roof.planeHeldOutPoints) ||
    !Array.isArray(roof.planeHeldOutCells) ||
    !corroboration ||
    !Array.isArray(r.groundEvidence) ||
    r.groundEvidence.length !== 2 ||
    !Array.isArray(r.sourceTiles) ||
    !r.sourceTiles.length
  )
    return false;
  const values = [
    r.height,
    r.beforeHeight,
    r.ground,
    r.roofP99Elevation,
    r.groundContextSensitivityM,
    r.footprintAreaM2,
    roof.heldOutInlierFraction,
    roof.heldOutP90ErrorM,
    roof.areaSupportFraction,
    roof.boundarySupportFraction,
    roof.p99HoldoutDifferenceM,
    roof.p98ToP995SpreadM,
    roof.roofPoints,
    roof.nearPeakPoints,
    roof.measuredInlierPoints,
    roof.trainingPoints,
    roof.heldOutPoints,
    roof.planeCount,
    corroboration.footprintCoverage,
    corroboration.sourceCoverage,
    corroboration.sourceHeight,
    corroboration.heightDifferenceM,
  ];
  const counts = [
    roof.roofPoints,
    roof.measuredInlierPoints,
    roof.trainingPoints,
    roof.heldOutPoints,
    roof.nearPeakPoints,
    roof.planeCount,
    ...roof.planeTrainingPoints,
    ...roof.planeHeldOutPoints,
    ...roof.planeHeldOutCells,
  ];
  const trainingSupport = roof.planeTrainingPoints.reduce((sum, n) => sum + n, 0);
  return (
    values.every(Number.isFinite) &&
    counts.every((n) => Number.isSafeInteger(n) && n > 0) &&
    roof.trainingPoints >= 100 &&
    roof.heldOutPoints >= 40 &&
    roof.roofPoints === roof.trainingPoints + roof.heldOutPoints &&
    roof.roofPoints >= Math.max(150, r.footprintAreaM2 * 8) &&
    roof.planeCount >= 1 &&
    roof.planeCount <= 6 &&
    roof.planeTrainingPoints.length === roof.planeCount &&
    roof.planeHeldOutPoints.length === roof.planeCount &&
    roof.planeHeldOutCells.length === roof.planeCount &&
    roof.planeTrainingPoints.every((n) => n >= Math.max(90, roof.trainingPoints * 0.065)) &&
    roof.planeHeldOutPoints.every(
      (n, i) => n >= Math.max(20, roof.planeTrainingPoints[i] * 0.15) && n <= roof.heldOutPoints,
    ) &&
    roof.planeHeldOutCells.every((n, i) => n >= 3 && n <= roof.planeHeldOutPoints[i]) &&
    trainingSupport >= roof.trainingPoints * 0.93 &&
    trainingSupport <= roof.trainingPoints &&
    roof.measuredInlierPoints >= trainingSupport + Math.ceil(roof.heldOutPoints * 0.95) &&
    roof.measuredInlierPoints <= roof.roofPoints &&
    roof.nearPeakPoints <= roof.measuredInlierPoints &&
    r.height >= 1.5 &&
    r.height <= 40 &&
    Math.abs(r.height - r.beforeHeight) >= 0.5 &&
    Math.abs(r.height - (r.roofP99Elevation - r.ground)) <= 0.051 &&
    r.groundContextSensitivityM <= 0.1 &&
    r.groundEvidence.every(
      (g, i) =>
        g.contextM === [4, 6][i] &&
        [g.pointCount, g.rmseM, g.supportFraction, ...(g.plane || [])].every(Number.isFinite) &&
        g.plane?.length === 3 &&
        g.pointCount >= 120 &&
        g.rmseM <= 0.12 &&
        g.supportFraction >= 0.65,
    ) &&
    Math.abs(r.groundEvidence[0].plane[2] - r.groundEvidence[1].plane[2]) <= 0.1 &&
    Math.abs(r.groundEvidence[0].plane[2] - r.ground) <= 0.00001 &&
    roof.heldOutInlierFraction >= 0.95 &&
    roof.heldOutP90ErrorM <= 0.12 &&
    roof.areaSupportFraction >= 0.98 &&
    roof.boundarySupportFraction >= 0.95 &&
    roof.p99HoldoutDifferenceM <= 0.2 &&
    roof.p98ToP995SpreadM <= 0.3 &&
    roof.nearPeakPoints >= Math.max(40, roof.measuredInlierPoints * 0.05) &&
    ['Excellent', 'Good', 'Fair'].includes(corroboration.quality) &&
    (corroboration.footprintCoverage >= 0.5 || corroboration.sourceCoverage >= 0.8) &&
    corroboration.heightDifferenceM <= 1 &&
    Math.abs(r.height - corroboration.sourceHeight) <= 1 &&
    r.sourceTiles.every((s) => /^2020\d{4}$/.test(s.acquisitionDate) && s.url?.startsWith('https://'))
  );
}

/** Local files only; original City meshes always take precedence in the scene. */
export async function loadFallbackBuildings({ fetcher = globalThis.fetch, signal } = {}) {
  const contactRegionSource = Promise.resolve()
    .then(() => fetcher(SUPPLEMENTAL_CONTACT_REGIONS_URL, { signal }))
    .then(
      (response) => (response.ok ? response.json() : null),
      () => null,
    )
    .catch(() => null);
  const responses = await Promise.all(
    [
      RECOVERED_MANIFEST,
      RECOVERED_BINARY,
      PART_MANIFEST,
      PART_BINARY,
      HEIGHTS,
      VERIFIED_HEIGHTS,
      COMPLEX_HEIGHTS,
      SOURCE_EXCLUSIONS,
    ].map((url) => fetcher(url, { signal })),
  );
  if (responses.some((response) => !response.ok))
    throw new Error('Supplemental building geometry could not be loaded');
  const [
    recoveredManifest,
    recoveredBinary,
    partManifest,
    partBinary,
    heightManifest,
    verifiedHeightManifest,
    complexHeightManifest,
    sourceExclusionManifest,
  ] = await Promise.all(responses.map((r, i) => (i === 1 || i === 3 ? r.arrayBuffer() : r.json())));
  return createFallbackBuildings({
    recoveredManifest,
    recoveredBinary,
    partManifest,
    partBinary,
    heightManifest,
    verifiedHeightManifest,
    complexHeightManifest,
    sourceExclusionManifest,
    contactRegionManifest: await contactRegionSource,
  });
}

export function createFallbackBuildings({
  recoveredManifest,
  recoveredBinary,
  partManifest,
  partBinary,
  heightManifest,
  verifiedHeightManifest = null,
  complexHeightManifest = null,
  sourceExclusionManifest = null,
  contactRegionManifest = null,
}) {
  if (
    recoveredManifest.meta.baseMapSha256 !== partManifest.meta.baseMapSha256 ||
    partManifest.meta.baseMapSha256 !== heightManifest.meta.baseMapSha256 ||
    !partManifest.meta.primaryApiVerificationSha256 ||
    partManifest.buildings.some((r) => r.parts.some((p) => !p.primaryApiVerified))
  )
    throw new Error('Fallback sources require matching baseline and verified OSM part data');
  if (
    verifiedHeightManifest &&
    (verifiedHeightManifest.meta.baseMapSha256 !== partManifest.meta.baseMapSha256 ||
      verifiedHeightManifest.buildings.some(
        (r) =>
          !Number.isFinite(r.height) ||
          !Number.isFinite(r.ground) ||
          r.measured !== true ||
          r.geometryMeasured !== false ||
          r.roofGeometryReplaced !== false ||
          Math.abs(r.height - (r.roofP99Elevation - r.ground)) > 0.11 ||
          r.beforeHeight - r.height < 25 ||
          r.sourceRoofCheck?.sourceRoofCoverage < 0.95 ||
          r.sourceRoofCheck?.sourceCellCoverage < 0.95 ||
          !r.ownerEvidence?.ownerDocument ||
          r.groundEvidence.length < 2 ||
          r.groundEvidence.some((g) => g.rmseM > 0.1 || g.supportFraction < 0.65) ||
          r.localGroundContextSensitivityM > 0.1,
      ))
  )
    throw new Error('Explicit height overrides require independent ground, roof and owner evidence');
  if (
    complexHeightManifest &&
    (complexHeightManifest.meta.baseMapSha256 !== partManifest.meta.baseMapSha256 ||
      complexHeightManifest.buildings.some((r) => !validComplexHeight(r)))
  )
    throw new Error(
      'Complex roof height corrections require default provenance, supported roof, local ground and independent corroboration',
    );
  if (
    sourceExclusionManifest &&
    (sourceExclusionManifest.meta.baseMapSha256 !== partManifest.meta.baseMapSha256 ||
      sourceExclusionManifest.buildings.some((r) => {
        if (!r.suppressSyntheticBuilding)
          return r.kind !== 'post-source-construction' || !r.sourceEvidence?.url?.startsWith('https://');
        const osm = r.currentOsm;
        return (
          r.kind !== 'mapped-nonbuilding-area' ||
          r.id !== `osm-way-${osm?.id}` ||
          osm?.type !== 'way' ||
          osm?.tags?.building !== 'no' ||
          osm?.primaryApiVerified !== true ||
          !Number.isSafeInteger(osm?.version) ||
          osm.version < 1 ||
          !osm.timestamp ||
          !/^[a-f0-9]{64}$/.test(osm.snapshotSha256 || '') ||
          osm.apiUrl !== `https://api.openstreetmap.org/api/0.6/way/${osm.id}.json`
        );
      }))
  )
    throw new Error(
      'Source semantic suppressions require matching baseline and current primary OSM non-building proof',
    );
  const sourceExclusions = new Map((sourceExclusionManifest?.buildings || []).map((r) => [r.id, r]));
  const isSuppressed = (id) => sourceExclusions.get(id)?.suppressSyntheticBuilding === true;
  const recovered = createCityMeshes(recoveredManifest, recoveredBinary);
  const parts = createCityMeshes(partManifest, partBinary);
  const heights = new Map(heightManifest.buildings.map((r) => [r.id, r]));
  const verifiedHeights = new Map((verifiedHeightManifest?.buildings || []).map((r) => [r.id, r]));
  const complexHeights = new Map((complexHeightManifest?.buildings || []).map((r) => [r.id, r]));
  const ownershipProofs = new Map(
    [
      ...recoveredManifest.meta.coveredFallbacks,
      ...recoveredManifest.meta.ownershipAudit.partialFallbacks,
    ].map((r) => [r.id, r]),
  );
  const get = (id) => {
    if (isSuppressed(id)) return null;
    const actual = recovered.get(id);
    if (actual) return { ...actual, sourceType: 'recovered-city-multipatch', measured: true };
    const mapped = parts.get(id);
    if (mapped) return mapped;
    const verified = verifiedHeights.get(id);
    if (verified) return verified;
    const height = heights.get(id);
    return height
      ? {
          ...height,
          minHeight: 0,
          sourceType: 'nrcan-lidar-height-with-baseline-footprint',
          measured: true,
          geometryMeasured: false,
        }
      : complexHeights.get(id) || null;
  };
  const hasGeometry = (id) => !isSuppressed(id) && (recovered.has(id) || parts.has(id));
  const sourceCollisionParts = (id) => {
    if (isSuppressed(id)) return null;
    const actual = recovered.get(id);
    if (actual)
      return (
        recoveredManifest.meta.modelCollisionParts?.[id] ||
        recoveredManifest.meta.modelFootprints[id].map((p) => ({
          ...p,
          minHeight: actual.minHeight,
          height: actual.height,
        }))
      );
    return parts.get(id)?.collisionParts || null;
  };
  const contactRegions = supplementalContactRegions(contactRegionManifest, {
    recoveredManifest,
    recoveredBinary,
    partManifest,
    partBinary,
  });
  const regionalContacts = createRegionalMeshContacts([
    ...recoveredManifest.buildings.map((r) => ({
      id: r.id,
      source: recovered,
      parts: contactRegions.models?.get(r.id)?.regions || sourceCollisionParts(r.id),
      preserveBands: false,
    })),
    ...partManifest.buildings
      .filter((r) => !recovered.has(r.id) && !contactRegions.accepted)
      .map((r) => ({ id: r.id, source: parts, parts: sourceCollisionParts(r.id), preserveBands: true })),
  ]);
  const collisionParts = (id) =>
    isSuppressed(id)
      ? null
      : contactRegions.models?.get(id)?.kind === 'mapped'
        ? contactRegions.models.get(id).regions
        : regionalContacts.collisionParts(id) || sourceCollisionParts(id);
  return {
    recovered,
    parts,
    heights,
    verifiedHeights,
    complexHeights,
    sourceExclusions,
    sourceExclusionManifest,
    isSuppressed,
    ownershipProofs,
    recoveredManifest,
    partManifest,
    heightManifest,
    verifiedHeightManifest,
    complexHeightManifest,
    hasGeometry,
    get,
    collisionParts,
    clearContactCache: () => regionalContacts.clearProjections(),
    createGeometry(id) {
      if (isSuppressed(id)) return null;
      const source = recovered.has(id) ? recovered : parts;
      const geometry = source.createGeometry(id);
      if (geometry)
        geometry.userData.buildingRecovery = {
          sourceType: recovered.has(id) ? 'recovered-city-multipatch' : 'osm-mapped-parts',
          measuredGeometry: recovered.has(id),
        };
      return geometry;
    },
    // Only the actual recovered source models may prove another fallback body
    // redundant; level-derived OSM parts never silently suppress neighbours.
    coveredFallbacks(renderedModelIds) {
      return new Set(
        recoveredManifest.meta.coveredFallbacks
          .filter((r) => r.modelIds.every((id) => renderedModelIds.has(id)))
          .map((r) => r.id),
      );
    },
    stats: {
      contactRegionSource: { accepted: contactRegions.accepted, reason: contactRegions.reason },
      regionalContacts: regionalContacts.stats,
      recoveredModels: recovered.count,
      mappedPartModels: parts.count,
      measuredHeightCorrections: heights.size,
      verifiedHeightCorrections: verifiedHeights.size,
      complexRoofHeightCorrections: complexHeights.size,
      correctedNonBuildingAreas: [...sourceExclusions.values()].filter((r) => r.suppressSyntheticBuilding)
        .length,
    },
  };
}
