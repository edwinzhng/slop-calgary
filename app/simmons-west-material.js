import { matchesSimmonsSource, SIMMONS_SOURCE_EVIDENCE } from './simmons-evidence.js';

const west = Object.freeze({
  triangles: Object.freeze([20, 21]),
  style: 3,
  originalStyle: 1,
  color: 0x8b5b47,
  glazingUnchanged: true,
  geometricChanges: false,
  photoRegistered: false,
  authoredOpenings: false,
  colorCalibrated: false,
  currentArchitectureVerified: false,
  observedAt: '2016-03-25',
  sourceImages: Object.freeze(['commons-79822844', 'commons-79822857']),
  sourcePayloadSha256: SIMMONS_SOURCE_EVIDENCE.payloadSha256,
});

/**
 * Warm brick observed on the historic west wall in both licensed photographs.
 * Neither frame contains both west-wall endpoints, so no full-wall photo warp
 * or inferred opening model is claimed. Style3 adds fine masonry while keeping
 * the existing style1 glazing mask; seed/grid/UV channels remain caller-owned.
 */
export function simmonsWestMaterialEvidence(geometry, buildingOrId) {
  const id = typeof buildingOrId === 'string' ? buildingOrId : buildingOrId?.id;
  if (id !== SIMMONS_SOURCE_EVIDENCE.buildingId || !matchesSimmonsSource(geometry)) return null;
  return west;
}
