// Sparse, source-checked visual observations. These change facade attributes,
// never the measured City surface or a building's collision/roof geometry.
// Each observation retains its exact source shell and dated photo reference.
export const ALT_HOTEL_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-28441-0',
  structureId: 2408819,
  sourceRecordDate: '2020-10-04',
  sourceGround: 1042.89,
  sourcePositionCount: 792,
  sourcePayloadSha256: '21609ed7e1d12b9bafb6d429469c37a3b9035599fdd0e3ac110228c16c9ffd7b',
  positionSha256: 'd530bd03630107cbaaa497434c8b3c86e2f429e2b6c56f922e94b471d530ff5c',
  normalSha256: '896612e5d4f268d4ad8b47151cbe0d924ca930076654c17ad1cd3760631156af',
  photoUrl: 'https://commons.wikimedia.org/wiki/File:Alt_Hotel_Calgary_East_Village.jpg',
  photoCapture: '2026-09-15 20:26:51',
});

export const HEXAGON_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-28397-0',
  structureId: 1005183,
  sourceRecordDate: '2012-10-19',
  sourceGround: 1047.68,
  sourcePositionCount: 600,
  sourcePayloadSha256: '3de1b7718231a789de5738d0fa44d0ecadaa3d59e3fd87e4dba351c6d9de6d89',
  positionSha256: '90b5f23a0be11d8209e409e4c4f7e1384e0662b706da5a2126cea2163fed5b80',
  normalSha256: 'c5d35f86faa13fd4313d17c0abf5bfd8732961063745e0307b3a17dced37492f',
  photoUrl: 'https://www.mapillary.com/app/?pKey=573421877833340&focus=photo',
  photoCapture: '2022-05-29T23:23:53.889Z',
});

export const POINTE_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-28316-0',
  structureId: 1006692,
  sourceRecordDate: '2012-10-19',
  sourceGround: 1048.205,
  sourcePositionCount: 459,
  sourcePayloadSha256: 'e5244510b2c33ca9c4cf88b1d0a9cb33d89325a77a36f2e4a00598a768c68df2',
  positionSha256: 'adcacb694743f2d1bc296279c81b9e5d4d761e7b3f1972bbcbd019f7e63372c7',
  normalSha256: 'a9b3923fbdbbb4cfa22704d76f1f9f8f7c1ee25a3e8a9037e8c2200a9cc51540',
  photoUrl: 'https://www.mapillary.com/app/?pKey=5310582548999188&focus=photo',
  photoCapture: '2022-05-29T23:20:37.488Z',
  photoCreator: 'lionfish16',
  photoLicense: 'CC BY-SA 4.0',
});

// Inferred from the dated photograph; the original measured bay supplies the
// curve and wall normals. These are not surveyed opening or sign dimensions.
export const POINTE_BAY_FINISH = Object.freeze({
  color: 0x203b38,
  floorHeight: 3.25,
  bands: Object.freeze([
    Object.freeze({ id: 'shop-fascia', bottom: 2.35, top: 3.25 }),
    Object.freeze({ id: 'middle-spandrel', bottom: 5.45, top: 6.5 }),
    Object.freeze({ id: 'name-crown', bottom: 9.05, top: 10.3 }),
  ]),
});

export const NINTH_AVENUE_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-27163-0',
  structureIds: Object.freeze([1524002, 1524004, 1524006, 1524007]),
  sourceRecordDate: '2013-06-10',
  sourceGround: 1042.191,
  sourcePositionCount: 183,
  sourcePayloadSha256: '646a60821a29a5f0af197e11e1345621ce72a6f6d737aac3270732bb92d9312a',
  positionSha256: 'ab98899c765e75d833022bc76fe93471767adc40bb07681013dcb34e9c68c6c5',
  normalSha256: 'd0d8628f33ced8e9078cba3aa9b555ab381523876d28fa306572de0adf2ffbac',
  photoUrl: 'https://www.mapillary.com/app/?pKey=1043155969549769&focus=photo',
  additionalPhotoUrls: Object.freeze(['https://www.mapillary.com/app/?pKey=1102038576968340&focus=photo']),
  photoCapture: '2018-08-04T16:15:49.214Z',
  photoCreator: 'lvl5',
  photoLicense: 'CC BY-SA 4.0',
});

export const WORN_STUDIO_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-27243-0',
  structureIds: Object.freeze([1376632]),
  sourceRecordDate: '2013-06-10',
  sourceGround: 1042.345,
  sourcePositionCount: 39,
  sourcePayloadSha256: '551aa6ab4b22c2ef13950533df855222d40f3b92f03a1a229d827c7e9445986e',
  positionSha256: '4b71ac87ae8af10ab4fb91dc55d1e11dd6e3649777ef4d4ea6396d95b4d6ae0d',
  normalSha256: 'c31f43d03a6a72c91c9bfc46c6045a6799d2e96879427f09c85451827347f037',
  photoUrl:
    'https://www.google.com/maps/@51.0430701,-114.0403686,1043a,65y,165h,90t/data=!3m8!1e1!3m6!1sCIHM0ogKEICAgIC7sfbCLA!2e10!3e12!6shttps:%2F%2Flh3.googleusercontent.com%2Fgpms-cs-s%2FAM4Q-U_x6G2E1qdYHERsgnLuiHsqfxkmvQtjY5gU8xI0UKjsBXqo-cTKLasUJfQolAVEbET-7n3naUvU7wZ44eeCSzHSdTNixoelEexz0pttCGCH7zlEnc8_AABN_dHCg1erHcFihard%3Dw900-h600-k-no-pi0-ya100.27849578857422-ro0-fo100!7i10560!8i5280',
  photoCapture: '2024-08',
  photoCreator: 'City of Calgary TMC',
  photoLicense: 'Copyrighted public-viewer reference; no imagery copied',
  businessUrl: 'https://wornstudioyyc.com/pages/about-us',
});

const SOUTH_ORIGIN = Object.freeze([1563.31, -154.82]);
const EAST_ORIGIN = Object.freeze([1595.05, -154.28]);
const GRID = Object.freeze({
  name: 'observed-charcoal-upper-grid',
  color: 0x343840,
  style: 1,
  // Three small pane rows/four pane columns per modular-room bay are a
  // procedural approximation of the observed factory-like grid. Thick room
  // spandrels and every actual opening are not reconstructed by this material.
  floorHeight: (34.82 - 8.86) / 8 / 3,
  bayWidth: 3.53 / 4,
  uvBase: 8.86,
});
const BLANK = Object.freeze({
  name: 'observed-charcoal-logo-panel',
  color: 0x343840,
  // Existing style 5 suppresses punched windows. Its low garage-door branch
  // cannot activate: this band retains absolute y >= 8.92 m, well above 2.4 m.
  // No new shader/material permutation or draw call is required.
  style: 5,
  floorHeight: (34.82 - 8.86) / 8,
  bayWidth: 3.53,
  uvBase: 0,
});
const PODIUM = Object.freeze({
  name: 'observed-pale-glazed-podium',
  color: 0x9aafaa,
  style: 0,
  floorHeight: 4.45,
  bayWidth: 1.42,
  uvBase: 0,
});

// Triangle order belongs to the pinned expanded City payload, not an OSM
// extrusion. The checks below disable these observations if source surfaces or
// winding change. Hidden north/west faces and all roofs remain untouched.
const ZONES = Object.freeze([
  Object.freeze({ ...GRID, triangles: Object.freeze([28, 29, 30, 31]), origin: SOUTH_ORIGIN }),
  Object.freeze({ ...GRID, triangles: Object.freeze([18, 19, 78, 79]), origin: EAST_ORIGIN }),
  Object.freeze({ ...BLANK, triangles: Object.freeze([22, 23, 26, 27, 70, 71]), origin: EAST_ORIGIN }),
  Object.freeze({ ...BLANK, triangles: Object.freeze([24, 25, 80, 81]), origin: SOUTH_ORIGIN }),
  Object.freeze({ ...PODIUM, triangles: Object.freeze([138, 139, 142, 143]), origin: SOUTH_ORIGIN }),
  Object.freeze({ ...PODIUM, triangles: Object.freeze([136, 137]), origin: EAST_ORIGIN }),
]);
const HEXAGON_ZONES = Object.freeze([
  Object.freeze({
    name: 'observed-white-south-wall-without-invented-windows',
    color: 0xe0ded8,
    style: 5,
    floorHeight: 3.2,
    bayWidth: 2.5,
    // The photo carries the observed openings. The unphotographed lower band
    // remains plain; shifting this windowless style's UV height above 2.4 m
    // also disables its unrelated generic low-garage-door branch.
    uvBase: -10,
    origin: Object.freeze([-1166.68, -761.71]),
    triangles: Object.freeze([97, 98, 110, 111]),
  }),
]);

// The dated views establish these three visible frontages. Their individual
// openings and screen relief are authored separately against this same guard.
const NINTH_AVENUE_ZONES = Object.freeze([
  Object.freeze({
    name: 'observed-blue-north-frontage',
    color: 0x354f73,
    style: 5,
    floorHeight: 8,
    bayWidth: 3.24,
    uvBase: -8.5,
    origin: Object.freeze([2208.39990234375, 316.2099914550781]),
    uAxis: Object.freeze([0.933769680585, 0.357874536144]),
    uOffset: 0,
    triangles: Object.freeze([4, 5]),
  }),
  Object.freeze({
    name: 'observed-warm-charcoal-north-frontage',
    color: 0x494e48,
    style: 5,
    floorHeight: 8,
    bayWidth: 3,
    uvBase: -8.5,
    origin: Object.freeze([2217.64, 319.79]),
    triangles: Object.freeze([48, 49]),
  }),
  Object.freeze({
    name: 'observed-red-brick-north-frontage',
    color: 0x8d5041,
    // Style7 retains brickwork but suppresses the generic glazing above UV y5.
    // This offset puts the complete observed face in that windowless band.
    style: 7,
    floorHeight: 8,
    bayWidth: 2.249246531014621,
    uvBase: -8.5,
    origin: Object.freeze([2214.9636363636364, 341.09090909090907]),
    triangles: Object.freeze([19, 20]),
  }),
]);

// The north-frontage view establishes pale paint and rose frames. The mural,
// sign artwork and unobserved sides are excluded; opening dimensions are inferred.
const WORN_STUDIO_ZONES = Object.freeze([
  Object.freeze({
    name: 'observed-pale-915-north-frontage',
    color: 0xd7d8ce,
    style: 5,
    floorHeight: 8,
    bayWidth: 3.24,
    uvBase: -8.5,
    origin: Object.freeze([2197.5, 312.3800048828125]),
    uAxis: Object.freeze([0.932567257061012, 0.3609962756839747]),
    uOffset: 0,
    triangles: Object.freeze([6, 7]),
  }),
]);

function pointeZones(geometry) {
  const zones = [
    {
      name: 'observed-red-north-masonry',
      color: 0xa65347,
      style: 1,
      floorHeight: 3.5,
      bayWidth: 4,
      uvBase: 0,
      origin: [-1209.61, -735.54],
      triangles: [100, 101],
    },
  ];
  const position = geometry.attributes.position;
  let previous,
    distance = 0;
  // Follow the measured faceted bay, rather than projecting each facet from
  // a different normal. Shared corners then retain continuous pane spacing.
  // Colours, pane pitch and floor bands remain authored approximations of the
  // photograph; signs, crown panels and individual openings are not surveyed.
  for (let triangle = 48; triangle <= 80; triangle += 2) {
    const endpoints = [];
    for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
      const point = [position.getX(i), position.getZ(i)];
      if (!endpoints.some(([x, z]) => x === point[0] && z === point[1])) endpoints.push(point);
    }
    let [a, b] = endpoints;
    if (previous ? a[0] !== previous[0] || a[1] !== previous[1] : a[0] > b[0]) [a, b] = [b, a];
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz);
    zones.push({
      name: 'observed-curved-dark-glazing',
      color: 0x344c4e,
      style: 0,
      floorHeight: POINTE_BAY_FINISH.floorHeight,
      bayWidth: 0.75,
      uvBase: 0,
      origin: a,
      uAxis: [dx / length, dz / length],
      uOffset: distance,
      triangles: [triangle, triangle + 1],
    });
    previous = b;
    distance += length;
  }
  return zones;
}

export function attributeFingerprint(attribute, count = attribute?.count) {
  if (attribute?.itemSize !== 3 || !(attribute.array instanceof Float32Array) || count > attribute.count)
    return null;
  const array = attribute.array,
    bytes = new Uint8Array(array.buffer, array.byteOffset, count * 3 * Float32Array.BYTES_PER_ELEMENT);
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}

/** A one-time attribute-only override for the exact inspected source shell.
 * Fast fingerprints gate accidental source/order drift; actual-payload tests
 * independently pin cryptographic hashes and every selected face's bounds. */
const EVOLUTION_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-28510-0',
  structureId: 2254087,
  sourceRecordDate: '2015-05-10',
  sourceGround: 1042.555,
  sourcePositionCount: 4575,
  photoUrl: 'https://bosadevelopment.com/project/fuse-at-evolution/',
});

const CONCORD_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-28330-0',
  structureId: 2316834,
  sourceRecordDate: '2018-08-20',
  sourceGround: 1047.405,
  sourcePositionCount: 1701,
  photoUrl: 'https://www.starlinewindows.com/gallery/high-rise/the-concord-calgary',
});

function concordZones(geometry) {
  const origin = [-376.27, -762.93];
  const glass = {
    style: 0,
    color: 0x8eabb5,
    floorHeight: 3.34,
    bayWidth: 1.62,
    uvBase: 0,
    origin,
    triangles: [],
  };
  const stone = {
    style: 5,
    color: 0xbbbbb0,
    floorHeight: 3.34,
    bayWidth: 1.62,
    uvBase: 0,
    origin,
    triangles: [],
  };
  const { position, normal } = geometry.attributes;
  for (let i = 0; i < position.count; i += 3) {
    if (Math.abs(normal.getY(i)) > 0.12) continue;
    const heights = [position.getY(i), position.getY(i + 1), position.getY(i + 2)];
    (Math.max(...heights) - Math.min(...heights) < 0.66 ? stone : glass).triangles.push(i / 3);
  }
  return [glass, stone];
}

const MOUNT_ROYAL_MATERIAL_EVIDENCE = Object.freeze({
  buildingId: 'city-outline-27323-0',
  structureId: 1004732,
  sourceGround: 1050.86,
  sourcePositionCount: 1413,
  photoUrl: 'https://fcr.ca/properties/alberta/calgary/mount-royal/mount-royal-block/',
});

function mountRoyalZones(geometry) {
  const brick = {
    style: 7,
    color: 0x9f573f,
    floorHeight: 4.6,
    bayWidth: 3.8,
    uvBase: -5.25,
    origin: [-570, 898],
    triangles: [],
  };
  const { position, normal } = geometry.attributes;
  for (let i = 0; i < position.count; i += 3) {
    const z = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
    if (normal.getZ(i) < -0.62 && Math.abs(normal.getY(i)) < 0.2 && z < 904) brick.triangles.push(i / 3);
  }
  return [brick];
}

function evolutionZones(geometry) {
  const position = geometry.attributes.position,
    normal = geometry.attributes.normal,
    origin = [1425.16, -196.63],
    podium = {
      style: 2,
      color: 0x9a614c,
      floorHeight: 3.28,
      bayWidth: 2.8,
      uvBase: 0,
      origin,
      triangles: [],
    },
    tower = {
      style: 0,
      color: 0x7295a1,
      floorHeight: 3.06,
      bayWidth: 1.78,
      uvBase: 0,
      origin,
      triangles: [],
    };
  for (let i = 0; i < position.count; i += 3) {
    if (Math.abs(normal.getY(i)) > 0.12) continue;
    const high = Math.max(position.getY(i), position.getY(i + 1), position.getY(i + 2));
    (high < 11.25 ? podium : tower).triangles.push(i / 3);
  }
  return [podium, tower];
}

export function observedBuildingMaterialZones(geometry, building) {
  let evidence, zones, positions, normals;
  if (building.id === ALT_HOTEL_MATERIAL_EVIDENCE.buildingId) {
    evidence = ALT_HOTEL_MATERIAL_EVIDENCE;
    zones = ZONES;
    positions = 369320280;
    normals = 207336966;
  } else if (building.id === HEXAGON_MATERIAL_EVIDENCE.buildingId) {
    evidence = HEXAGON_MATERIAL_EVIDENCE;
    zones = HEXAGON_ZONES;
    positions = 3352558530;
    normals = 2890394614;
  } else if (building.id === POINTE_MATERIAL_EVIDENCE.buildingId) {
    evidence = POINTE_MATERIAL_EVIDENCE;
    positions = 783468549;
    normals = 3633332993;
  } else if (building.id === NINTH_AVENUE_MATERIAL_EVIDENCE.buildingId) {
    evidence = NINTH_AVENUE_MATERIAL_EVIDENCE;
    zones = NINTH_AVENUE_ZONES;
    positions = 3757841660;
    normals = 308530485;
  } else if (building.id === WORN_STUDIO_MATERIAL_EVIDENCE.buildingId) {
    evidence = WORN_STUDIO_MATERIAL_EVIDENCE;
    zones = WORN_STUDIO_ZONES;
    positions = 2631992459;
    normals = 3945593089;
  } else if (building.id === EVOLUTION_MATERIAL_EVIDENCE.buildingId) {
    evidence = EVOLUTION_MATERIAL_EVIDENCE;
    positions = 2391027053;
    normals = 3440306516;
  } else if (building.id === CONCORD_MATERIAL_EVIDENCE.buildingId) {
    evidence = CONCORD_MATERIAL_EVIDENCE;
    positions = 2091946062;
    normals = 2402215198;
  } else if (building.id === MOUNT_ROYAL_MATERIAL_EVIDENCE.buildingId) {
    evidence = MOUNT_ROYAL_MATERIAL_EVIDENCE;
    positions = 1631963929;
    normals = 214226164;
  } else return null;
  const source = geometry.userData.cityMesh,
    structureIds = evidence.structureIds || [evidence.structureId];
  if (
    source?.id !== building.id ||
    !Array.isArray(source.structureIds) ||
    source.structureIds?.length !== structureIds.length ||
    source.structureIds.some((id, i) => id !== structureIds[i]) ||
    source.ground !== evidence.sourceGround ||
    (evidence === WORN_STUDIO_MATERIAL_EVIDENCE &&
      (!Array.isArray(source.sourceDates) ||
        source.sourceDates.length !== 1 ||
        source.sourceDates[0] !== evidence.sourceRecordDate)) ||
    geometry.index ||
    geometry.attributes.position?.count !== evidence.sourcePositionCount ||
    attributeFingerprint(geometry.attributes.position) !== positions ||
    attributeFingerprint(geometry.attributes.normal) !== normals
  )
    return null;
  if (!zones)
    zones =
      evidence === EVOLUTION_MATERIAL_EVIDENCE
        ? evolutionZones(geometry)
        : evidence === CONCORD_MATERIAL_EVIDENCE
          ? concordZones(geometry)
          : evidence === MOUNT_ROYAL_MATERIAL_EVIDENCE
            ? mountRoyalZones(geometry)
            : pointeZones(geometry);
  return {
    evidence,
    zones,
    triangleZones: new Map(zones.flatMap((zone) => zone.triangles.map((id) => [id, zone]))),
  };
}
