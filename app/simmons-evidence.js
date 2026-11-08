// Exact City owner and decoded source fingerprints. No offline/photo calibration
// imports: ordinary building decoration can reject other buildings immediately.
export const SIMMONS_SOURCE_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-28650-0',
  structureId: 1004229,
  sourceRecordDate: '2013-06-10',
  ground: 1043.115,
  positionCount: 528,
  payloadSha256: 'c768002987d3348c1bf1a84b3584fd695e040ed12743f0203a36bb6bb509d123',
  positionSha256: 'a2d6880de3ee4f8bea2bc82cf7f1df58251f3e3c41da38afcc773278ed105e85',
  normalSha256: 'f20d613b20d7587efc4af00b892fd74186c110426b337c2761f981933e77782b',
  positionFNV32: 582512268,
  normalFNV32: 3208821673,
});

function fingerprint(attribute) {
  const a = attribute?.array;
  if (!a) return null;
  let hash = 2166136261;
  for (const byte of new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function matchesSimmonsSource(geometry, source = SIMMONS_SOURCE_EVIDENCE) {
  const city = geometry?.userData?.cityMesh,
    p = geometry?.attributes?.position,
    n = geometry?.attributes?.normal;
  return !!(
    source &&
    city &&
    !geometry.index &&
    city.id === source.buildingId &&
    city.ground === source.ground &&
    city.structureIds?.length === 1 &&
    city.structureIds[0] === source.structureId &&
    p?.count === source.positionCount &&
    n?.count === source.positionCount &&
    fingerprint(p) === source.positionFNV32 &&
    fingerprint(n) === source.normalFNV32
  );
}

const backing = Object.freeze({
  triangles: Object.freeze([22, 23, 42, 43]),
  bandBase: 5,
  style: 7,
  originalStyle: 1,
  geometricChanges: false,
  sourcePayloadSha256: SIMMONS_SOURCE_EVIDENCE.payloadSha256,
});

export function simmonsBackingEvidence(geometry, buildingOrId) {
  const id = typeof buildingOrId === 'string' ? buildingOrId : buildingOrId?.id;
  if (id !== SIMMONS_SOURCE_EVIDENCE.buildingId || !matchesSimmonsSource(geometry)) return null;
  return backing;
}
