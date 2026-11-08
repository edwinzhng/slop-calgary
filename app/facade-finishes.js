import imagery from '../data/imagery.json' with { type: 'json' };
import { attributeFingerprint } from './observed-building-materials.js';

const brick = (color, floorHeight, bayWidth, uvBase = 0) => ({
  color,
  floorHeight,
  bayWidth,
  uvBase,
  style: uvBase < 0 ? 7 : 3,
});
const stone = (color, floorHeight, bayWidth) => ({ color, floorHeight, bayWidth, style: 2 });
const panel = (color, floorHeight, bayWidth, style = 1) => ({ color, floorHeight, bayWidth, style });

// Materials describe the measured face, including its architectural bay spacing.
// Lettering dimensions are estimated in metres. Existing shop signs own the
// tenant names; a separate plaque is used for architectural or period lettering.
const finishes = {
  'hexagon-blanco-south': { name: 'Hexagon & Blanco', material: stone(0xc7b594, 3.9, 3.18) },
  'kensington-central-east-upper': {
    name: 'Kensington Central',
    material: panel(0x8e8a80, 3.45, 3.8, 0),
  },
  'wine-market-north': { name: 'Kensington Wine Market', material: brick(0xa37751, 3.8, 3.9) },
  'metro-element-north': { name: 'Metro Element', material: brick(0x88483b, 3.72, 3.4) },
  'metro-element-east': { name: 'Metro Element · east wall', material: brick(0x88483b, 3.72, 3.4) },
  'outdoor-resource-north': {
    name: 'Old Fire Hall No. 6',
    material: brick(0x965a47, 3.9, 3.5),
    sign: { text: 'FIRE HALL No. 6', y: 4.64, width: 4.7, height: 0.56 },
  },
  'milling-company-north': {
    name: 'Calgary Milling Company',
    material: stone(0xb3a184, 4.3, 2.43),
    sign: { text: 'CALGARY MILLING CO.', y: 8.4, width: 5.4, height: 0.48 },
  },
  'hing-wah-west': { name: 'Hing Wah Imports', material: panel(0xccc5ac, 3.42, 2.36) },
  'silver-dragon-sign': {
    name: 'Silver Dragon',
    sign: { text: 'Silver Dragon\nRESTAURANT', y: 5.22, width: 2.52, height: 2.5, paint: '#9c2622' },
  },
  'hi-hostel-west': { name: 'HI Calgary City Centre', material: panel(0x8b9690, 2.8, 2.5) },
  'homewood-north': {
    name: 'Homewood Suites',
    material: panel(0x8d9b9f, 3.56, 3.45),
  },
  'tribune-block-south': {
    name: 'Tribune Block',
    material: stone(0xbbaa87, 4.15, 2.04),
    sign: { text: 'TRIBUNE BLOCK', y: 8.24, width: 4.8, height: 0.5 },
  },
  'legion-001-south': {
    name: 'Royal Canadian Legion Branch 001',
    material: brick(0x8a6d5b, 4.37, 3.45),
    sign: { text: 'ROYAL CANADIAN LEGION', y: 5.65, width: 7.0, height: 0.57 },
  },
  'st-marys-parish-hall-north': {
    name: 'St. Mary’s Parish Hall',
    material: stone(0xa39480, 4.1, 2.86),
    sign: { text: 'ALBERTA BALLET', y: 4.4, width: 3.75, height: 0.5 },
  },
  'bank-montreal-south': {
    name: 'Historic Bank of Montreal',
    material: stone(0xc1b9a7, 5.12, 4.4),
    sign: {
      text: 'BANK OF MONTREAL',
      y: 13.8,
      width: 8.0,
      height: 0.63,
      wall: { a: [472, 12.46], b: [480, 12.753], normal: [-0.036, 0.99935] },
    },
  },
  'national-hotel-south': {
    name: 'National Hotel',
    material: brick(0xc7ad88, 3.36, 2.8),
    sign: { text: 'NATIONAL HOTEL', y: 9.75, width: 7.2, height: 0.55 },
  },
  'national-hotel-corner': { name: 'National Hotel · entrance', material: brick(0xc7ad88, 3.36, 2.8) },
  'national-hotel-east': { name: 'National Hotel · The Nash', material: brick(0xc7ad88, 3.36, 2.8) },
  'irwin-block-west-upper': {
    name: 'Irwin Block',
    material: brick(0x955240, 3.8, 3.8, -6),
    // The vintage paint is on the short south return. The west elevation has
    // its own sash windows, with the individual tenants at street level.
    sign: {
      text: 'UNEEDA BAKERY R.W. LONG',
      y: 7.73,
      width: 8.0,
      height: 0.55,
      wall: { a: [-967.8, -739.8], b: [-959.1, -739.8], normal: [0, 1] },
      paint: '#38352f',
    },
  },
  'haultain-school-name': {
    name: 'Haultain School',
    sign: { text: 'HAULTAIN SCHOOL', y: 3.83, width: 2.46, height: 0.38 },
  },
  'lorraine-name-south': {
    name: 'The Lorraine',
    sign: { text: 'THE LORRAINE', y: 3.1, width: 3.6, height: 0.38 },
  },
  'imperial-bank-south': {
    name: 'Imperial Bank of Canada',
    material: stone(0xb8aa8d, 4.32, 3.16),
    sign: { text: 'IMPERIAL BANK OF CANADA', y: 9.96, width: 8.0, height: 0.52 },
  },
  'imperial-bank-west': {
    name: 'Imperial Bank of Canada · west wall',
    material: stone(0xb8aa8d, 4.32, 3.16),
  },
  'lineham-block-south': {
    name: 'Lineham Block',
    material: brick(0x9c604a, 3.8, 3.21),
    sign: { text: 'LINEHAM BLOCK', y: 14.6, width: 4.65, height: 0.52 },
  },
  'hayden-block-south': { name: 'Hayden Block', material: brick(0x9b624a, 3.75, 3.47) },
  'simmons-north-upper': { name: 'Simmons Building · RiverWalk', material: brick(0x8b5b47, 3.85, 3.65, -6) },
  'simmons-south-upper': { name: 'Simmons Building · south wall', material: brick(0x8b5b47, 3.85, 3.65, -6) },
};

export const facadeReferences = imagery.facades.map((record) => ({ ...record, ...finishes[record.id] }));
export const facadeSourceImages = imagery.images;

// Expanded source positions gate colour and lettering on the observed shell.
const sourceSignatures = {
  'city-outline-28397-0': [600, 3352558530],
  'city-outline-28389-0': [465, 1253048488],
  'city-outline-28257-0': [144, 3989275207],
  'city-outline-28314-0': [210, 3183341856],
  'city-outline-26210-0': [30, 2637332037],
  'city-outline-27892-0': [2085, 3617092441],
  'city-outline-28941-0': [483, 96590601],
  'city-outline-27927-0': [996, 2226405639],
  'city-outline-28216-0': [258, 3882330755],
  'city-outline-28096-0': [1713, 3902908816],
  'city-outline-26560-0': [1428, 3072488872],
  'city-outline-28303-0': [669, 3095861093],
  'city-outline-26922-0': [1341, 3647603200],
  'city-outline-26562-0': [630, 1136256222],
  'city-outline-26848-0': [465, 4155574921],
  'city-outline-28259-0': [507, 237820608],
  'city-outline-28916-0': [300, 3512329584],
  'city-outline-26956-0': [1446, 3926686859],
  'city-outline-26433-0': [4344, 1551926047],
  'hayden-block-source-1413988': [324, 4117273008],
  'city-outline-28650-0': [528, 582512268],
};

export function acceptsFacadeSource(geometry, id, structureIds) {
  const signature = sourceSignatures[id];
  if (!signature || !geometry || geometry.index) return false;
  const [count, hash] = signature,
    position = geometry.attributes.position,
    source = geometry.userData.cityMesh,
    hayden = geometry.userData.haydenBlock;
  const exact =
    source?.id === id &&
    position?.count === count &&
    source.structureIds?.length === structureIds.length &&
    source.structureIds.every((owner, i) => owner === structureIds[i]);
  const fragment = hayden?.measuredSourceModelId === id && hayden.measuredTriangles * 3 === count;
  return (exact || fragment) && attributeFingerprint(position, count) === hash;
}

function wallZone(record) {
  const { a, b, normal, projection, base = 0, height, material } = record,
    width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return {
    ...material,
    id: record.id,
    sourceId: record.wallGeometryBuildingId || record.buildingId,
    structureIds: record.registration.sourceStructureIds,
    origin: a,
    uAxis: [normal[1], -normal[0]],
    uOffset: 0.25 * (material?.bayWidth || 0),
    normal,
    minDot: projection?.normalMinDot ?? 0.98,
    minDepth: projection?.minDepth ?? -0.08,
    maxDepth: projection?.maxDepth ?? 0.08,
    along: [(b[0] - a[0]) / width, (b[1] - a[1]) / width],
    width,
    base,
    top: base + height,
  };
}

const byBuilding = new Map();
for (const record of facadeReferences) {
  if (!record.material) continue;
  const zones = byBuilding.get(record.buildingId) || [];
  zones.push(wallZone(record));
  if (record.id === 'irwin-block-west-upper') {
    zones.push(
      wallZone({
        ...record,
        ...record.sign.wall,
        b: [-952.4, -739.8],
        projection: { minDepth: -0.028, maxDepth: 0.028 },
      }),
    );
  }
  byBuilding.set(record.buildingId, zones);
}

export function referenceWallZones(geometry, building) {
  const candidates = byBuilding.get(building.id);
  if (!candidates || geometry.index) return null;
  // All observed zones for this compound use the same source geometry.
  const { sourceId, structureIds } = candidates[0];
  if (!acceptsFacadeSource(geometry, sourceId, structureIds)) return null;
  const zones = candidates;
  const position = geometry.attributes.position,
    normal = geometry.attributes.normal,
    triangleZones = new Map(),
    [end] = sourceSignatures[sourceId];
  for (let i = 0; i < end; i += 3) {
    if (Math.abs(normal.getY(i)) > 0.12) continue;
    for (const zone of zones) {
      const [nx, nz] = zone.normal;
      if (normal.getX(i) * nx + normal.getZ(i) * nz < zone.minDot) continue;
      let left = Infinity,
        right = -Infinity,
        bottom = Infinity,
        top = -Infinity;
      for (let j = i; j < i + 3; j++) {
        const x = position.getX(j) - zone.origin[0],
          z = position.getZ(j) - zone.origin[1],
          depth = x * nx + z * nz;
        if (depth < zone.minDepth || depth > zone.maxDepth) break;
        const along = x * zone.along[0] + z * zone.along[1];
        left = Math.min(left, along);
        right = Math.max(right, along);
        bottom = Math.min(bottom, position.getY(j));
        top = Math.max(top, position.getY(j));
        if (
          j === i + 2 &&
          Math.min(right, zone.width) - Math.max(left, 0) > Math.min(0.25, (right - left) * 0.25) &&
          Math.min(top, zone.top) - Math.max(bottom, zone.base) > 0.12
        ) {
          triangleZones.set(i / 3, zone);
        }
      }
      if (triangleZones.has(i / 3)) break;
    }
  }
  return triangleZones.size ? { zones, triangleZones } : null;
}
