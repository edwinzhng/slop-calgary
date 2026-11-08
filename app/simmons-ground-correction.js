import evidence from '../data/SIMMONS_OCCLUSION_GROUND.json' with { type: 'json' };

// Compare full JSON values, including holes and every point. The published
// fingerprints document provenance; exact value equality is the runtime gate.
function sameJSON(actual, expected) {
  if (actual === expected) return true;
  if (actual == null || typeof actual !== typeof expected || typeof actual !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return (
    Object.keys(actual).length === keys.length &&
    keys.every((key) => Object.hasOwn(actual, key) && sameJSON(actual[key], expected[key]))
  );
}

const candidate = Object.freeze({
  id: evidence.building.id,
  sourceType: 'exact-city-outline-on-measured-open-ground',
  classification: evidence.classification,
  skipSyntheticBody: true,
  skipSyntheticBuildingCollider: true,
  retainedSourceRecord: true,
  retainedGroundSurfaceIds: Object.freeze(evidence.groundSurfaces.map((r) => r.record.id)),
  footprintEvidenceSha256: evidence.buildingSha256,
  pointClipSha256: evidence.pointClipSha256,
  groundUnionCoverage: evidence.groundUnionCoverage,
  geometryAdded: false,
  terrainChanged: false,
  elevationAssigned: false,
  materialAssigned: false,
  currentArchitectureVerified: false,
});

/**
 * One explicit correction, never a generic no-roof suppression rule.
 * Call once while building the world. The caller must prefer any stronger real
 * geometry/roof provider; this helper considers only the exact baseline record.
 * Complete coverage was independently computed from the three pinned polygons;
 * changing a point, hole, source, or record rejects that unchanged-coverage proof.
 */
export function getSimmonsGroundCorrection(building, surfaceData) {
  if (
    building?.id !== candidate.id ||
    !sameJSON(building, evidence.building) ||
    surfaceData?.meta?.source !== evidence.source.url ||
    surfaceData.meta.surveyYear !== evidence.source.surveyYear ||
    !sameJSON(surfaceData.meta.origin, evidence.source.origin) ||
    !Array.isArray(surfaceData.surfaces)
  )
    return null;
  const required = new Map(evidence.groundSurfaces.map((r) => [r.record.id, r.record]));
  const found = new Set();
  for (const surface of surfaceData.surfaces) {
    if (!surface || typeof surface !== 'object') return null;
    const expected = required.get(surface.id);
    if (!expected) continue;
    if (found.has(surface.id) || !sameJSON(surface, expected)) return null;
    found.add(surface.id);
  }
  return found.size === required.size ? candidate : null;
}
