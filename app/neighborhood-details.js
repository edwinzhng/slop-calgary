import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bounds, inPolygon, nearestOnSegment, seeded } from './geo.js';
import ev606Site from '../data/SIMMONS_OCCLUSION_GROUND.json' with { type: 'json' };
import { bloomBeamCollider } from './park-art.js';
import { buildDiscoverySpots } from './discovery-spots.js';
import { buildHighPark } from './high-park.js';
import { buildChinatownDetails } from './chinatown.js';
import { createLinearPolygonGeometry } from './linear-polygon-geometry.js';

// City outline under the completed six-storey building (ATLRG's EV606).
export const EV606_ID = 'city-outline-28658-0';
export function ev606Profile(building) {
  const outline = ev606Site.building;
  return building.id === EV606_ID &&
    building.source === outline.source &&
    building.height === outline.height &&
    !building.holes?.length &&
    building.ring.length === outline.ring.length &&
    building.ring.every(([x, z], i) => x === outline.ring[i][0] && z === outline.ring[i][1])
    ? { height: 19.2, levels: 6, material: 'brick', color: '#e1ded2' }
    : null;
}

export function enzoProfile(building) {
  // The map's old podium was assigned a default height. The completed street
  // elevation has a single retail floor and a recessed residential volume.
  if (
    building.id === 'city-outline-27351-0' &&
    building.source === 'city-outline+estimated' &&
    building.height === 10 &&
    building.ring.length === 15 &&
    building.ring[0].join(',') === '-625.8,898.8'
  )
    return { height: 4.65, levels: 1, material: 'brick', color: '#756d66' };
  if (
    building.id === 'city-outline-27350-0' &&
    building.source === 'city-outline+osm' &&
    building.height === 19.8 &&
    building.ring[0].join(',') === '-613.8,905.1'
  )
    return { height: 19.8, levels: 5, material: 'brick', color: '#787069' };
  return null;
}

const up = new THREE.Vector3(0, 1, 0);

export function buildNeighborhoodDetails(
  scene,
  { data, parkData, groundHeight, turfHeight, cityMeshes, inWater, paved },
) {
  const groups = new Map(),
    colliders = [],
    labels = [],
    authoredStorefrontBuildingIds = new Set(),
    stats = { galleriaTrees: 0, flowerBeds: 0, deltaPlanters: 0, pulseTower: false, plazaTheatre: false };
  const add = (district, geometry, paint) => {
    if (geometry.index) {
      const flat = geometry.toNonIndexed();
      geometry.dispose();
      geometry = flat;
    }
    const tint = new THREE.Color(paint),
      colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (!groups.has(district)) groups.set(district, []);
    groups.get(district).push(geometry);
  };
  const box = (district, x, y, z, w, h, d, paint, yaw = 0) =>
    add(district, new THREE.BoxGeometry(w, h, d).rotateY(yaw).translate(x, y, z), paint);
  const beam = (district, a, b, bottom, top, paint, sides = 6) => {
    const direction = b.clone().sub(a);
    add(
      district,
      new THREE.CylinderGeometry(top, bottom, direction.length(), sides)
        .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()))
        .translate(...a.clone().lerp(b, 0.5)),
      paint,
    );
  };
  const rectangle = (id, x, z, w, d, minHeight, height, yaw = 0) => {
    const sin = Math.sin(yaw),
      cos = Math.cos(yaw),
      ring = [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ].map(([a, b]) => [x + a * cos + b * sin, z - a * sin + b * cos]);
    ring.push(ring[0]);
    const part = { id, ring, minHeight, height, storefrontAnchor: false };
    colliders.push(part);
    return part;
  };
  const sign = (name, text, x, y, z, w, h, yaw, ink, paper) => {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (paper) {
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, 512, 128);
    }
    ctx.fillStyle = ink;
    const lines = text.split('\n');
    const ghost = name.startsWith('Simmons');
    ctx.font = ghost
      ? '900 83px Helvetica Neue, sans-serif'
      : paper
        ? lines.length === 1
          ? 'bold 80px system-ui'
          : 'bold 42px system-ui'
        : 'bold 99px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [i, line] of lines.entries())
      ctx.fillText(line, 256, lines.length === 1 ? 67 : 40 + i * 48, 486);
    if (ghost) {
      ctx.fillRect(8, 113, 496, 3);
      const scatter = seeded(231);
      ctx.fillStyle = '#665c53';
      for (let i = 0; i < 2100; i++) ctx.fillRect(scatter() * 512, scatter() * 128, 1 + scatter() * 5, 1.1);
      ctx.fillStyle = '#5e4e45';
      for (let row = 10; row < 128; row += 9) ctx.fillRect(0, row, 512, 0.65);
    }
    if (name === 'Lang’s Grocery fascia') {
      ctx.fillStyle = '#d9af53';
      for (const x of [0, 512]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 128);
        ctx.lineTo(x + (x === 0 ? 23 : -23), 64);
        ctx.closePath();
        ctx.fill();
      }
    }
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      ghost
        ? new THREE.MeshStandardNodeMaterial({ map, roughness: 0.96 })
        : new THREE.MeshBasicNodeMaterial({ map, alphaTest: paper ? 0 : 0.5 }),
    );
    mesh.name = name;
    mesh.rotation.y = yaw;
    mesh.position.set(x, y, z);
    scene.add(mesh);
    return mesh;
  };

  // The surveyed street face and city shell remain the theater's owner.
  // Relief follows the north wall of the City model (1006683).
  const plaza = cityMeshes?.get('city-outline-28253-0');
  if (plaza?.structureIds.length === 1 && plaza.structureIds[0] === 1006683 && plaza.indexCount === 126) {
    const x = -1123.71,
      z = -725.93,
      yaw = -2.828;
    const floor = groundHeight(x - 0.85, z - 2.6);
    const point = (u, v) => [
      x + Math.cos(yaw) * u + Math.sin(yaw) * v,
      z - Math.sin(yaw) * u + Math.cos(yaw) * v,
    ];
    const put = (u, y, v, w, h, d, paint) => {
      const [px, pz] = point(u, v);
      box('Kensington Plaza', px, floor + y, pz, w, h, d, paint, yaw);
    };
    const plaster = 0xe8dfce,
      metal = 0x213337,
      glass = 0x334550;
    const outline = new THREE.Shape();
    const parapet = [
      [-7.43, 0],
      [7.43, 0],
      [7.43, 7.5],
      [6.3, 7.5],
      [6.3, 7.9],
      [4.85, 8.07],
      [4.85, 7.8],
      [3.25, 7.8],
      [3.25, 8.55],
      [0, 9.34],
      [-3.25, 8.55],
      [-3.25, 7.8],
      [-4.85, 7.8],
      [-4.85, 8.07],
      [-6.3, 7.9],
      [-6.3, 7.5],
      [-7.43, 7.5],
    ];
    outline.moveTo(...parapet[0]);
    for (const edge of parapet.slice(1)) outline.lineTo(...edge);
    outline.closePath();
    const [fx, fz] = point(0, 0.115);
    add(
      'Kensington Plaza',
      new THREE.ExtrudeGeometry(outline, { depth: 0.29, bevelEnabled: false })
        .rotateY(yaw)
        .translate(fx, floor, fz),
      plaster,
    );
    for (const u of [-3.29, 3.29]) put(u, 4.08, 0.42, 0.15, 8.15, 0.14, 0xd2c6b4);
    for (const u of [-5.44, 0, 5.44]) {
      put(u, 5.31, 0.425, 2.3, 1.23, 0.045, glass);
      for (const offset of [-1.12, -0.37, 0.37, 1.12]) put(u + offset, 5.31, 0.46, 0.065, 1.3, 0.07, metal);
      put(u, 4.68, 0.48, 2.38, 0.11, 0.1, metal);
    }
    for (const u of [-1.59, 1.59]) {
      put(u, 1.21, 0.45, 2.52, 2.42, 0.08, 0x39352e);
      for (const offset of [-0.62, 0.62]) {
        put(u + offset, 1.24, 0.51, 1.12, 2.19, 0.045, glass);
        put(u + offset, 1.02, 0.55, 0.91, 0.1, 0.07, 0xad956e);
      }
    }
    for (const u of [-3.65, 3.65]) {
      put(u, 1.59, 0.45, 0.73, 1.08, 0.06, metal);
      put(u, 1.59, 0.49, 0.61, 0.94, 0.025, 0x9c846d);
    }
    put(0, 3.77, 1.36, 7.2, 1.15, 1.82, metal);
    put(0, 4.38, 1.37, 7.61, 0.15, 1.98, metal);
    put(0, 3.17, 1.37, 7.49, 0.1, 1.93, 0x41453e);
    const [cx, cz] = point(0, 1.36);
    rectangle('plaza-theatre-marquee', cx, cz, 7.61, 1.98, floor + 3.12, floor + 4.46, yaw);
    for (const u of [-2.9, 2.9]) {
      const [ax, az] = point(u, 2.32),
        [bx, bz] = point(u, 0.47);
      beam(
        'Kensington Plaza',
        new THREE.Vector3(ax, floor + 4.41, az),
        new THREE.Vector3(bx, floor + 5.8, bz),
        0.027,
        0.027,
        metal,
        5,
      );
    }
    const [ax, az] = point(0, 2.29);
    sign(
      'Plaza Theatre marquee',
      'THEPLAZA.CA\nINDEPENDENT CINEMA',
      ax,
      floor + 3.78,
      az,
      6.85,
      1.03,
      yaw,
      '#303637',
      '#e6dfc6',
    );
    const [sx, sz] = point(0, 0.421);
    sign('Plaza Theatre name', 'P L A Z A', sx, floor + 7.59, sz, 5.88, 1.45, yaw, '#21343e', null);
    // The black patio parasols are visible in Tourism Calgary's street photo.
    for (const [u, v] of [
      [-5.4, 4.35],
      [5.35, 4.02],
    ]) {
      const [px, pz] = point(u, v),
        y = groundHeight(px, pz);
      beam(
        'Kensington Plaza',
        new THREE.Vector3(px, y, pz),
        new THREE.Vector3(px, y + 2.8, pz),
        0.045,
        0.033,
        0x2a2d2a,
        6,
      );
      add(
        'Kensington Plaza',
        new THREE.ConeGeometry(1.67, 0.49, 8).rotateY(yaw).translate(px, y + 2.59, pz),
        0x24262a,
      );
      add(
        'Kensington Plaza',
        new THREE.CylinderGeometry(0.54, 0.54, 0.07, 10).translate(px, y + 0.78, pz),
        0x363e38,
      );
      beam(
        'Kensington Plaza',
        new THREE.Vector3(px, y, pz),
        new THREE.Vector3(px, y + 0.79, pz),
        0.077,
        0.061,
        0x303631,
        6,
      );
      rectangle(`plaza-patio-table-${u}`, px, pz, 1.06, 1.06, y, y + 0.83, yaw);
      rectangle(`plaza-parasol-${u}`, px, pz, 2.9, 2.9, y + 2.37, y + 2.86, yaw);
    }
    labels.push({ name: 'Plaza Theatre', x, z, height: 12 });
    stats.plazaTheatre = true;
  }

  const simmons = cityMeshes?.get('city-outline-28650-0');
  if (
    simmons?.structureIds.length === 1 &&
    simmons.structureIds[0] === 1004229 &&
    simmons.indexCount === 528
  ) {
    // Measured north and south wall planes from the registered licensed photos.
    // The lettering sits directly on the surveyed brick walls.
    for (const [x, z, nx, nz] of [
      [1551.57855, -253.41988, 0.266346, -0.963877],
      [1542.36005, -221.13, -0.26492, 0.964271],
    ]) {
      sign(
        'Simmons painted sign',
        'SIMMONS LIMITED',
        x + nx * 0.016,
        7.81,
        z + nz * 0.016,
        19.6,
        1.42,
        Math.atan2(nx, nz),
        '#e2dace',
        '#413f3a',
      );
    }
    const district = 'Simmons river-facing steel canopy',
      x = 1551.57855,
      z = -253.41988,
      nx = 0.266346,
      nz = -0.963877,
      yaw = Math.atan2(nx, nz),
      floor = groundHeight(x + nx * 1.5, z + nz * 1.5);
    const point = (u, v) => [x + nz * u + nx * v, z - nx * u + nz * v];
    const put = (u, h, v, w, ht, d, tint) => {
      const [px, pz] = point(u, v);
      box(district, px, floor + h, pz, w, ht, d, tint, yaw);
    };
    const steel = 0x282725,
      trim = 0x41423b;
    put(0, 1.79, 0.041, 26.0, 3.57, 0.08, 0x946552);
    for (let row = 0; row < 23; row++)
      put(0, 0.24 + row * 0.147, 0.085, 25.9, 0.013, 0.023, row % 4 ? 0xa37a62 : 0x7d5f50);
    put(0, 3.82, 2.96, 29.4, 0.36, 0.24, steel);
    put(0, 3.82, 0.17, 29.4, 0.27, 0.24, steel);
    for (let u = -14.5; u <= 14.5; u += 0.71) put(u, 3.91, 1.58, 0.07, 0.12, 2.92, trim);
    for (const u of [-14.45, -9.7, -4.8, 0.05, 5.05, 9.85, 14.45]) {
      put(u, 1.85, 2.96, 0.23, 3.7, 0.25, steel);
      const [px, pz] = point(u, 2.96);
      rectangle(`simmons-canopy-post-${u}`, px, pz, 0.23, 0.25, floor, floor + 3.7, yaw);
      put(u, 2.74, 2.76, 0.08, 0.19, 0.09, 0xe3b274);
    }
    rectangle('simmons-canopy-roof', ...point(0, 1.58), 29.4, 3, floor + 3.64, floor + 4, yaw);
    for (const [u, w] of [
      [-6.7, 2.75],
      [-1.5, 3.52],
      [4.7, 2.98],
      [9.58, 2.3],
    ]) {
      put(u, 1.5, 0.08, w + 0.16, 3, 0.08, steel);
      put(u, 1.5, 0.14, w - 0.2, 2.76, 0.045, 0x526a63);
      for (const offset of [-w / 2, 0, w / 2]) put(u + offset, 1.5, 0.2, 0.078, 3.01, 0.07, steel);
      put(u, 2.62, 0.2, w, 0.08, 0.07, steel);
    }
    for (const [u, width, text, paper] of [
      [-10.5, 6.4, 'PHIL & SEBASTIAN', '#343732'],
      [1.75, 5.7, 'SIDEWALK CITIZEN', '#313631'],
      [11.55, 3.6, 'charbar', '#c8b194'],
    ]) {
      const [px, pz] = point(u, 3.104);
      sign(
        `RiverWalk ${text}`,
        text,
        px,
        floor + 3.48,
        pz,
        width,
        0.39,
        yaw,
        paper === '#c8b194' ? '#262621' : '#eee4cd',
        paper,
      );
    }
    for (const u of [6.55, 9.25, 11.95]) {
      put(u, 0.27, 3.75, 2.48, 0.54, 0.79, steel);
      put(u, 0.65, 3.75, 2.22, 0.35, 0.59, 0x51623c);
      rectangle(`simmons-patio-planter-${u}`, ...point(u, 3.75), 2.48, 0.79, floor, floor + 0.82, yaw);
    }
    for (const u of [-12.1, -9.6, -7.4]) {
      put(u, 0.76, 1.75, 1.04, 0.07, 0.8, 0x9c7251);
      for (const side of [-0.36, 0.36]) put(u + side, 0.39, 1.75, 0.08, 0.75, 0.07, steel);
      rectangle(`simmons-cafe-table-${u}`, ...point(u, 1.75), 1.04, 0.8, floor, floor + 0.8, yaw);
    }
    authoredStorefrontBuildingIds.add('city-outline-28650-0');
  }

  // RiverWalk's photographed slatted platforms use broad folded metal
  // sides and low timber decks. Keep the central walkway between them clear.
  for (const [x, z] of [
    [1538.6, -269.8],
    [1552.8, -272.3],
    [1564.4, -264.6],
  ]) {
    if (!inWater || inWater(x, z)) continue;
    const y = groundHeight(x, z),
      name = 'Simmons RiverWalk furniture',
      yaw = -0.27;
    box(name, x, y + 0.225, z, 2.97, 0.43, 0.78, 0x9aa19b, yaw);
    box(name, x, y + 0.073, z, 2.78, 0.13, 0.65, 0x646c66, yaw);
    for (let i = 0; i < 6; i++) {
      const d = (i - 2.5) * 0.117;
      box(name, x + Math.sin(yaw) * d, y + 0.462, z + Math.cos(yaw) * d, 2.9, 0.056, 0.098, 0xa29883, yaw);
    }
    rectangle(`simmons-bench-${x}`, x, z, 2.97, 0.78, y, y + 0.49, yaw);
  }
  // Long planting beds and seat walls appear in the RiverWalk aerial. Leave
  // the through route open between the river terraces and the café frontage.
  const plazaPlants = seeded(418);
  for (const [x, z, width, depth] of [
    [1533.6, -278.6, 7.2, 2.3],
    [1555.5, -277.2, 5.5, 2.1],
    [1570.5, -269, 6.8, 2.2],
  ]) {
    if (inWater(x, z)) continue;
    const y = groundHeight(x, z),
      yaw = -0.43,
      district = 'Simmons plaza planting and seat walls';
    box(district, x, y + 0.19, z, width, 0.38, depth, 0xaaa598, yaw);
    box(district, x, y + 0.4, z, width - 0.25, 0.05, depth - 0.25, 0x514b35, yaw);
    for (let i = 0; i < Math.floor(width * 4); i++) {
      const u = (plazaPlants() - 0.5) * (width - 0.4),
        v = (plazaPlants() - 0.5) * (depth - 0.4);
      const px = x + Math.cos(yaw) * u + Math.sin(yaw) * v,
        pz = z - Math.sin(yaw) * u + Math.cos(yaw) * v;
      add(
        district,
        new THREE.IcosahedronGeometry(0.21 + plazaPlants() * 0.17, 0)
          .scale(1.28, 0.7, 1)
          .translate(px, y + 0.51, pz),
        i % 4 === 0 ? 0x899652 : 0x5c743d,
      );
    }
    rectangle(`simmons-plaza-bed-${x}`, x, z, width, depth, y, y + 0.58, yaw);
  }

  const shelter = cityMeshes?.get('city-outline-28774-0');
  if (
    shelter?.structureIds.length === 1 &&
    shelter.structureIds[0] === 1001382 &&
    shelter.indexCount === 1956
  ) {
    const x = 1313.9,
      z = -344,
      y = groundHeight(x + 1, z);
    sign(
      'Calgary Drop-In Centre entrance',
      'CALGARY DROP-IN CENTRE',
      x,
      y + 3.3,
      z,
      4.2,
      0.65,
      1.61,
      '#f4eadb',
      '#51443b',
    );
    // The long south wing has tall arched green windows below buff brick.
    const a = [1289.11, -328.86],
      b = [1309.57, -337.38],
      yaw = Math.atan2(a[1] - b[1], b[0] - a[0]);
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    const wing = (u, h, v, w, ht, d, paint) =>
      box('Calgary Drop-In Centre', a[0] + c * u + s * v, h, a[1] - s * u + c * v, w, ht, d, paint, yaw);
    wing(11.1, 20.15, 0.031, 22.16, 12.6, 0.075, 0xad835f);
    wing(11.1, 13.71, 0.063, 22.15, 0.31, 0.14, 0xc1a685);
    wing(11.1, 26.41, 0.17, 22.15, 0.22, 0.37, 0x4e5f54);
    for (let u = 1.55; u < 22; u += 2.79) wing(u, 20.11, 0.102, 1.49, 7.2, 0.061, 0x58706a);
    const arched = (w, h) => {
      const f = new THREE.Shape();
      f.moveTo(-w / 2, 0);
      f.lineTo(w / 2, 0);
      f.lineTo(w / 2, h * 0.68);
      f.quadraticCurveTo(w * 0.31, h, 0, h);
      f.quadraticCurveTo(-w * 0.31, h, -w / 2, h * 0.68);
      f.closePath();
      return f;
    };
    for (const u of [3.05, 8.4, 13.75, 19.1]) {
      for (const [v, w, h, offset, paint] of [
        [0.08, 4.31, 3.47, 0, 0xb99c7b],
        [0.09, 4.03, 3.22, 0.09, 0x4e6962],
      ]) {
        add(
          'Calgary Drop-In Centre',
          new THREE.ShapeGeometry(arched(w, h), 9)
            .rotateY(yaw)
            .translate(a[0] + c * u + s * v, 8.72 + offset, a[1] - s * u + c * v),
          paint,
        );
      }
      for (const lane of [-1.19, 0, 1.19]) wing(u + lane, 9.99, 0.134, 0.07, 2.38, 0.061, 0x344c47);
      wing(u, 10.03, 0.133, 3.95, 0.069, 0.052, 0x344c47);
    }
    labels.push({ name: 'Calgary Drop-In Centre', x: 1275, z: -342, height: 35 });
  }

  // Stephen Avenue Galleria Trees. Two broad, twisting steel blades hold
  // one cupped louver crown. Photo proportions; ten bases along the block.
  const galleria = 'Stephen Avenue',
    whiteSteel = 0xedece0;
  const steelMember = (a, b, w, d, across) => {
    const along = b.clone().sub(a),
      height = along.length();
    along.normalize();
    const depth = across.clone().cross(along).normalize();
    const width = along.clone().cross(depth).normalize();
    const rotation = new THREE.Matrix4().makeBasis(width, along, depth);
    add(
      galleria,
      new THREE.BoxGeometry(w, height + 0.04, d).applyMatrix4(rotation).translate(...a.clone().lerp(b, 0.5)),
      whiteSteel,
    );
  };
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const x = 138 + i * 25.4 + (side === 1 ? 2.8 : 0),
        z = 3 + ((x - 104) * 8.2) / 172 + side * 6.35,
        y = groundHeight(x, z),
        point = (along, height, inward) => new THREE.Vector3(x + along, y + height, z - side * inward);
      const ribbon = (t, sign) => {
        const angle = (t * 1.32 - 0.2) * Math.PI,
          radius = 0.56 + Math.sin(t * Math.PI) * 0.7;
        return point(
          sign * Math.cos(angle) * radius,
          0.21 + t * 13.7,
          sign * Math.sin(angle) * radius + t * t * 0.58,
        );
      };
      for (const sign of [-1, 1]) {
        for (let k = 1; k <= 28; k++) {
          const t = k / 28,
            a = ribbon((k - 1) / 28, sign),
            b = ribbon(t, sign);
          const across = point(
            Math.cos((t * 1.32 - 0.2) * Math.PI),
            0,
            Math.sin((t * 1.32 - 0.2) * Math.PI),
          ).sub(point(0, 0, 0));
          const width = 0.66 + Math.sin(Math.PI * t) * 0.18;
          steelMember(a, b, width, 0.24, across);
          const part = bloomBeamCollider(
            a.toArray(),
            b.toArray(),
            width / 2,
            `galleria-${side}-${i}-${sign}-${k}`,
            'galleria-steel-blade',
          );
          colliders.push({ ...part, sourceId: 'galleria-trees' });
        }
      }
      for (const t of [0.06, 0.085, 0.11]) {
        beam(galleria, ribbon(t, -1), ribbon(t, 1), 0.072, 0.072, whiteSteel, 7);
      }
      box(galleria, x, y + 0.08, z, 1.8, 0.16, 1.52, 0xa5a49b);
      rectangle(`galleria-foot-${side}-${i}`, x, z, 1.8, 1.52, y, y + 0.16);

      // The leaf is a concave steel frame with straight parallel louvers.
      // Each rib grows continuously from a blade into the canopy edge.
      const fan = (t, u) => {
        const span = 0.7 + 4.65 * Math.sin(t * 1.7);
        const cup = u * u;
        return point(
          span * u + 0.36 * t,
          13.78 + (9.7 - 2.6 * cup) * t + 0.33 * Math.sin(Math.PI * t),
          0.6 + (5.9 - 1.7 * cup) * t - 0.38 * Math.sin(t * Math.PI),
        );
      };
      const widthAxis = new THREE.Vector3(1, 0, 0);
      for (const u of [-1, -0.34, 0.34, 1]) {
        for (let k = 1; k <= 16; k++) {
          steelMember(fan((k - 1) / 16, u), fan(k / 16, u), Math.abs(u) === 1 ? 0.27 : 0.19, 0.38, widthAxis);
        }
      }
      for (let k = 1; k <= 15; k++) {
        const t = 0.22 + (0.78 * k) / 15;
        for (let j = 0; j < 6; j++) {
          steelMember(
            fan(t, j / 3 - 1),
            fan(t, (j + 1) / 3 - 1),
            k === 15 ? 0.23 : 0.105,
            k === 15 ? 0.31 : 0.13,
            up,
          );
        }
      }
      stats.galleriaTrees++;
    }
  }
  labels.push({ name: 'Galleria Trees', x: 194, z: 7, height: 26 });

  // The 2015 City scan ends at the Pulse construction deck (55.2 m).
  // Continue from that western roof, while keeping the measured podium and Fuse.
  const evolution = cityMeshes?.get('city-outline-28510-0');
  if (
    evolution?.structureIds.length === 1 &&
    evolution.structureIds[0] === 2254087 &&
    evolution.indexCount === 4575
  ) {
    const x = 1385.45,
      z = -175.6,
      yaw = -0.052,
      base = 55.12,
      floorHeight = 3.07;
    const district = 'Evolution',
      slab = 0xd9d9cd,
      glass = 0x496370,
      mullion = 0x8a9c99;
    const local = (u, v) => [
      x + u * Math.cos(yaw) + v * Math.sin(yaw),
      z - u * Math.sin(yaw) + v * Math.cos(yaw),
    ];
    const put = (u, y, v, w, h, d, color) => {
      const [px, pz] = local(u, v);
      box(district, px, y, pz, w, h, d, color, yaw);
    };
    const tiers = [
      { start: 0, end: 11, w: 30.2, d: 26.1, v: 0 },
      { start: 11, end: 13, w: 27.8, d: 23.6, v: 0.7 },
      { start: 13, end: 14, w: 24.8, d: 21.1, v: 1.55 },
    ];
    for (const { start, end, w, d, v } of tiers) {
      const low = base + start * floorHeight,
        high = base + end * floorHeight;
      const [px, pz] = local(0, v);
      put(0, (low + high) / 2, v, w, high - low, d, glass);
      rectangle(`pulse-tier-${start}`, px, pz, w, d, low, high, yaw);
      for (let j = start; j < end; j++) {
        const y = base + j * floorHeight;
        put(0, y + 0.1, v, w + 0.28, 0.22, d + 0.28, slab);
        for (const side of [-1, 1]) {
          for (let column = 1; column < 14; column++) {
            const u = w * (column / 14 - 0.5);
            put(u, y + 1.55, v + side * (d / 2 + 0.022), 0.105, 2.9, 0.07, mullion);
          }
          for (let column = 1; column < 12; column++) {
            const p = v + d * (column / 12 - 0.5);
            put(side * (w / 2 + 0.022), y + 1.55, p, 0.075, 2.9, 0.1, mullion);
          }
          // Repeating corner terraces have a shallow return around the side.
          const u = side * (w / 2 - 2.05),
            p = v - d / 2 - 0.65;
          put(u, y + 0.1, p, 6.3, 0.22, 1.65, slab);
          put(u, y + 0.66, p - 0.79, 6.3, 0.93, 0.09, 0x8da3aa);
          put(u, y + 1.12, p - 0.79, 6.34, 0.08, 0.1, slab);
          const [bx, bz] = local(u, p);
          rectangle(`pulse-balcony-${j}-${side}`, bx, bz, 6.3, 1.65, y, y + 1.16, yaw);
        }
      }
      put(0, high - 0.12, v, w + 0.3, 0.24, d + 0.3, slab);
    }
    const crownBase = base + 14 * floorHeight,
      crownTop = 101.5;
    const [cx, cz] = local(-5.5, 4.4);
    put(-5.5, (crownBase + crownTop) / 2, 4.4, 12.6, crownTop - crownBase, 10.5, 0xbbbdb4);
    put(-5.5, crownTop - 0.17, 4.4, 12.94, 0.34, 10.7, slab);
    rectangle('pulse-elevator-crown', cx, cz, 12.94, 10.7, crownBase, crownTop, yaw);
    labels.push({ name: 'Evolution · Pulse', x, z, height: 111 });
    stats.pulseTower = true;
  }

  const ev606 = data.buildings.find((b) => b.id === EV606_ID);
  if (ev606 && ev606Profile(ev606) && !cityMeshes?.has(EV606_ID)) {
    // ATLRG photographs show a charcoal ground floor, deep window reveals,
    // and groups of pale slab balconies across the river and street fronts.
    for (const [a, b] of [
      [ev606.ring[7], ev606.ring[8]],
      [ev606.ring[6], ev606.ring[7]],
      [ev606.ring[3], ev606.ring[4]],
    ]) {
      const x = (a[0] + b[0]) / 2,
        z = (a[1] + b[1]) / 2,
        width = Math.hypot(a[0] - b[0], a[1] - b[1]),
        yaw = Math.atan2(a[1] - b[1], b[0] - a[0]);
      const c = Math.cos(yaw),
        s = Math.sin(yaw),
        y = groundHeight(x + s, z + c);
      const put = (u, v, h, w, l, d, paint) =>
        box('EV606', x + c * u + s * v, y + h, z - s * u + c * v, w, l, d, paint, yaw);
      put(0, 0.12, 1.76, width - 0.4, 3.36, 0.13, 0x263e46);
      for (let u = -width / 2 + 0.6; u < width / 2 - 0.3; u += 2.8)
        put(u, 0.2, 1.77, 0.105, 3.38, 0.12, 0x85948c);
      put(0, 0.26, 3.57, width - 0.2, 0.18, 0.54, 0xdad9cd);
      for (let floor = 0; floor < 5; floor++) {
        const h = 4.03 + floor * 3.07,
          u = width * (floor < 3 ? 0.18 : -0.21),
          v = 0.42;
        put(u, 0.13, h + 1.12, 4.4, 2.31, 0.07, 0x425d68);
        put(u, v, h, 4.62, 0.14, 0.76, 0xd9d9cc);
        put(u, 0.81, h + 0.47, 4.62, 0.85, 0.08, 0x829ea4);
        if (a === ev606.ring[3]) put(0, 0.11, h + 2.84, width - 0.25, 0.09, 0.16, 0xb6b5ab);
        rectangle(
          `ev606-balcony-${x}-${floor}`,
          x + c * u + s * v,
          z - s * u + c * v,
          4.62,
          0.8,
          y + h - 0.07,
          y + h + 0.9,
          yaw,
        );
      }
      if (a === ev606.ring[7] || a === ev606.ring[3])
        sign(
          'EV606 entry',
          '606',
          x + s * 0.22,
          y + 2.78,
          z + c * 0.22,
          1.95,
          0.82,
          yaw,
          '#fff1c0',
          '#263e46',
        );
    }
  }

  // OSM node 12550044676 pins the gazebo in the western Tomkins plaza.
  const steps = [];
  const gazebo = 'Tomkins Park',
    gx = -672.503,
    gz = 867.822,
    gy = groundHeight(gx, gz);
  for (let i = 0; i < 3; i++) {
    const radius = 3.75 - i * 0.28,
      bottom = gy + i * 0.145,
      top = bottom + 0.145;
    add(
      gazebo,
      new THREE.CylinderGeometry(radius, radius, 0.145, 28).translate(gx, (bottom + top) / 2, gz),
      0xa5a39a,
    );
    const ring = Array.from({ length: 28 }, (_, j) => [
      gx + Math.cos((j * Math.PI) / 14) * radius,
      gz + Math.sin((j * Math.PI) / 14) * radius,
    ]);
    const part = {
      id: `tomkins-gazebo-step-${i}`,
      type: 'park-step',
      ring,
      minHeight: bottom,
      height: top,
      storefrontAnchor: false,
    };
    colliders.push(part);
    steps.push(part);
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4,
      x = gx + Math.cos(angle) * 2.84,
      z = gz + Math.sin(angle) * 2.84;
    beam(
      gazebo,
      new THREE.Vector3(x, gy + 0.43, z),
      new THREE.Vector3(x, gy + 3.55, z),
      0.119,
      0.099,
      0xe4dfce,
      8,
    );
    rectangle(`tomkins-gazebo-column-${i}`, x, z, 0.24, 0.24, gy + 0.43, gy + 3.55);
  }
  const dome = [
    [0, 3.44],
    [3.22, 3.44],
    [3.22, 3.57],
    [3.03, 3.73],
    [2.88, 4.08],
    [2.35, 4.6],
    [1.55, 5.04],
    [0.66, 5.29],
    [0.2, 5.38],
    [0, 5.58],
  ].map(([r, h]) => new THREE.Vector2(r, h));
  add(gazebo, new THREE.LatheGeometry(dome, 32).translate(gx, gy, gz), 0x963e38);
  const ring = Array.from({ length: 28 }, (_, i) => [
    gx + Math.cos((i * Math.PI) / 14) * 3.22,
    gz + Math.sin((i * Math.PI) / 14) * 3.22,
  ]);
  colliders.push({
    id: 'tomkins-gazebo-roof',
    ring,
    minHeight: gy + 3.44,
    height: gy + 5.58,
    heightAt: (x, z) => gy + 3.58 + Math.max(0, 1 - Math.hypot(x - gx, z - gz) / 3.22) * 1.97,
    storefrontAnchor: false,
  });

  // 831/833 17 Avenue SW. The House retains its City roof and massing;
  // the grocery storefront meets its narrow mapped street frontage.
  const house = cityMeshes?.get('city-outline-25810-0');
  if (house?.structureIds.length === 1 && house.structureIds[0] === 1001321) {
    const district = 'House 831 and Lang’s Grocery',
      x = -658.6,
      z = 896.79,
      y = groundHeight(x, z - 0.7);
    const put = (u, h, v, w, ht, d, tint) => box(district, x + u, y + h, z - v, w, ht, d, tint);
    const cream = 0xd9d4bd,
      frame = 0xc2c3b7;
    put(0, 1.48, 0.08, 7.72, 2.95, 0.17, 0xe1ddca);
    put(-0.71, 1.44, 0.18, 5.48, 1.86, 0.09, 0x506460);
    put(2.85, 1.31, 0.19, 1.18, 2.45, 0.1, 0x293b41);
    for (const u of [-3.46, -2.1, -0.72, 0.66, 2.03, 2.28, 3.44])
      put(u, 1.47, 0.25, 0.065, 2.08, 0.075, frame);
    put(-0.7, 2.52, 0.205, 5.5, 0.3, 0.065, 0x898876);
    put(0.0, 3.18, 0.54, 7.74, 0.77, 0.24, 0xb52c30);
    const hood = new THREE.BoxGeometry(7.72, 1.36, 0.075).rotateX(-0.42).translate(x, y + 4.08, z - 0.24);
    add(district, hood, cream);
    for (let i = 0; i < 41; i++) {
      const rib = new THREE.BoxGeometry(0.027, 1.31, 0.06)
        .rotateX(-0.42)
        .translate(x - 3.79 + i * 0.1895, y + 4.08, z - 0.295);
      add(district, rib, 0xa6a999);
    }
    rectangle('langs-awning', x, z - 0.37, 7.72, 0.83, y + 2.83, y + 4.72);
    sign(
      'Lang’s Grocery fascia',
      "LANG'S GROCERY",
      x,
      y + 3.18,
      z - 0.67,
      7.7,
      0.71,
      Math.PI,
      '#fff0d2',
      '#a9222a',
    );
    sign(
      'Lang’s Grocery parking panel',
      'PARKING AT REAR',
      x - 0.61,
      y + 0.29,
      z - 0.205,
      5.48,
      0.34,
      Math.PI,
      '#a6433c',
      '#ddd9c8',
    );

    const hx = -651.04,
      hz = 899.83,
      hy = groundHeight(hx, hz - 1);
    const houseBox = (u, h, v, w, ht, d, tint) => box(district, hx + u, hy + h, hz - v, w, ht, d, tint);
    houseBox(0, 1.76, 0.12, 6.7, 3.5, 0.21, 0xe6e1d2);
    for (let h = 0.32; h < 3.51; h += 0.155) houseBox(0, h, 0.24, 6.7, 0.014, 0.04, 0xb9b6a9);
    houseBox(-1.39, 1.62, 0.267, 1.68, 1.76, 0.052, 0x526062);
    houseBox(1.21, 1.32, 0.268, 1.02, 2.4, 0.058, 0x35433d);
    for (const u of [-2.29, -1.39, -0.49]) houseBox(u, 1.61, 0.308, 0.067, 1.87, 0.052, 0xe1decc);
    houseBox(0, 3.19, 1.1, 6.77, 0.13, 2.21, 0x6b746a);
    houseBox(0, 3.4, 1.1, 6.85, 0.19, 2.28, 0xd5cdb7);
    houseBox(0, 5.14, 0.08, 1.57, 1.58, 0.17, 0xe7dfc7);
    houseBox(0, 5.14, 0.19, 1.3, 1.31, 0.1, 0x495957);
    houseBox(0, 5.14, 0.25, 0.065, 1.32, 0.09, 0xd8cfb6);
    houseBox(0, 5.17, 0.25, 1.32, 0.069, 0.09, 0xd8cfb6);
    rectangle('house-831-porch-roof', hx, hz - 1.1, 6.77, 2.21, hy + 3.125, hy + 3.26);
    for (const u of [-3.08, 3.08]) {
      houseBox(u, 1.61, 2.09, 0.105, 3.22, 0.105, 0xe8e2cf);
      rectangle(`house-831-porch-post-${u}`, hx + u, hz - 2.09, 0.105, 0.105, hy, hy + 3.23);
    }
    sign(
      'House 831 identity',
      'HOUSE 831',
      hx,
      hy + 2.72,
      hz - 0.276,
      3.35,
      0.44,
      Math.PI,
      '#eae6d5',
      '#37413c',
    );
    for (let i = 0; i < 3; i++) {
      const w = 2.23,
        d = 1.86 - i * 0.37,
        bottom = hy + i * 0.128,
        top = bottom + 0.128,
        sz = hz - 1.25 + i * 0.185;
      box(district, hx + 0.72, (bottom + top) / 2, sz, w, 0.128, d, 0x9e8e79);
      const step = rectangle(`house-831-step-${i}`, hx + 0.72, sz, w, d, bottom, top);
      step.type = 'park-step';
      steps.push(step);
    }
    authoredStorefrontBuildingIds.add(house.id);
  }

  const street = '17 Avenue storefronts';
  const storefront = (x, z, width, height, name, frame, paper, ink = '#fff3db') => {
    const y = groundHeight(x, z - 0.5);
    const put = (u, h, v, w, ht, d, paint) => box(street, x + u, y + h, z - v, w, ht, d, paint);
    put(0, height * 0.49, 0.16, width, height * 0.98, 0.23, frame);
    put(0, height * 0.41, 0.3, width - 0.34, height * 0.65, 0.09, 0x334541);
    put(0, 0.16, 0.33, width - 0.08, 0.22, 0.13, 0x9c9180);
    for (const u of [-width * 0.29, -width * 0.11, width * 0.16, width * 0.38]) {
      put(u, height * 0.43, 0.361, 0.067, height * 0.68, 0.09, frame);
      put(u + 0.09, height * 0.29, 0.358, 0.19, height * 0.37, 0.035, 0x5a6d63);
    }
    put(0, height - 0.73, 0.37, width - 0.25, 0.16, 0.15, frame);
    if (name)
      sign(
        `17 Avenue ${name}`,
        name,
        x,
        y + height - 0.39,
        z - 0.318,
        width - 0.22,
        0.51,
        Math.PI,
        ink,
        paper,
      );
  };
  const shops = cityMeshes?.get('city-outline-27440-0');
  if (shops?.indexCount === 351 && shops.structureIds.join(',') === '1551884,1551885') {
    storefront(-665.85, 897.3, 5.75, 3.34, 'COBS BREAD', 0x3a3930, '#69303b');
    storefront(-671.2, 897.3, 4.65, 3.24, 'PANAGO', 0x4d4a43, '#25252a');
    storefront(-677.24, 897.3, 6.62, 3.24, 'RAMEN TAKA', 0x61594d, '#723d36');
    storefront(-682.05, 897.72, 2.75, 3.04, 'SUBWAY', 0x5b6854, '#315541');
    authoredStorefrontBuildingIds.add(shops.id);
  }

  const podium = data.buildings.find((building) => building.id === 'city-outline-27351-0');
  const enzo = data.buildings.find((building) => building.id === 'city-outline-27350-0');
  if (
    podium &&
    enzo &&
    enzoProfile(podium) &&
    enzoProfile(enzo) &&
    !cityMeshes?.has(podium.id) &&
    !cityMeshes?.has(enzo.id)
  ) {
    const district = 'Enzo’s brick piers and setback',
      y = groundHeight(-628.5, 898.0);
    for (const [x, w, text, ink, paper] of [
      [-643.7, 4.75, 'RUNNING ROOM', '#f5e8d5', '#9f252c'],
      [-638.1, 5.9, 'silk & snow', '#ece3cd', '#393431'],
      [-631.4, 5.0, null],
      [-625.85, 4.6, 'ENZO', '#ede3c8', '#4a4139'],
      [-620.23, 5.85, 'CHIPOTLE', '#fff1e0', '#9d3b2c'],
      [-613.5, 5.35, 'ANIÁN', '#f3ead8', '#3b3d36'],
    ])
      storefront(x, 898.72, w, 3.79, text, 0x312d2a, paper, ink);
    box(district, -625.85, y + 3.14, 898.0, 4.92, 0.19, 1.7, 0x4e4942);
    rectangle('enzo-entry-canopy', -625.85, 898.0, 4.92, 1.7, y + 3.04, y + 3.24);
    box(district, -628, y + 4.37, 898.58, 36.6, 0.24, 0.45, 0xa19a8a);
    for (const x of [-642.2, -637.5, -632.7, -628, -623.3, -618.6, -614]) {
      const wing = x === -642.2 || x === -614;
      for (let level = 0; level < 5; level++) {
        const h = y + 5.9 + level * 2.86;
        box(district, x, h, 904.94, wing ? 2.0 : 3.63, 2.11, 0.21, 0x343835);
        box(district, x, h + 0.03, 904.81, wing ? 1.72 : 3.25, 1.81, 0.12, level % 2 ? 0x69807e : 0x526f73);
        for (const u of [-0.71, 0.65]) box(district, x + u, h, 904.72, 0.065, 1.86, 0.06, 0x292d2c);
        if (!wing && level !== 4) box(district, x - 1.94, h, 904.65, 0.26, 2.92, 0.55, 0x847c74);
      }
    }
    authoredStorefrontBuildingIds.add(podium.id);
    authoredStorefrontBuildingIds.add(enzo.id);
  }

  const royal = cityMeshes?.get('city-outline-27323-0');
  if (royal?.structureIds.length === 1 && royal.structureIds[0] === 1004732 && royal.indexCount === 1413) {
    const district = 'Mount Royal Block',
      frame = 0x2f3533,
      stone = 0xb9ab91,
      glass = 0x567682,
      y = groundHeight(-582, 896.7);
    const westFace = (x) => 898.125 - (x + 588) * 0.003;
    const eastFace = (x) => 897.72 - (x + 550) * 0.003;
    const arch = (x, z, floor, w, h, paint, yaw = Math.PI, depth = 0) => {
      const shape = new THREE.Shape();
      shape.moveTo(-w * 0.5, 0);
      shape.lineTo(w * 0.5, 0);
      shape.lineTo(w * 0.5, h * 0.82);
      shape.quadraticCurveTo(0, h * 1.15, -w * 0.5, h * 0.82);
      shape.closePath();
      add(
        district,
        new THREE.ShapeGeometry(shape, 12)
          .rotateY(yaw)
          .translate(x + Math.sin(yaw) * depth, floor, z + Math.cos(yaw) * depth),
        paint,
      );
    };
    for (const [x, width, name, paper] of [
      [-595.6, 6.8, 'ARC’TERYX', '#2d302c'],
      [-589.1, 5.2, 'BLACK SHEEP', '#43362b'],
      [-581.2, 5.8, 'FJÄLLRÄVEN', '#282a25'],
    ])
      storefront(
        x,
        westFace(x),
        width,
        4.05,
        name,
        frame,
        paper,
        name === 'FJÄLLRÄVEN' ? '#dc5d49' : undefined,
      );
    for (const [x, w] of [
      [-598.03, 2.46],
      [-594.32, 2.47],
      [-588.9, 4.62],
      [-583.11, 2.31],
      [-579.65, 2.33],
    ]) {
      const z = westFace(x) - 0.12;
      arch(x, z, y + 5.94, w + 0.17, 2.93, frame);
      arch(x, z - 0.019, y + 6.04, w, 2.73, glass);
      for (const d of [-0.25, 0, 0.25])
        box(district, x + w * d, y + 7.21, z - 0.04, 0.056, 2.34, 0.046, frame);
      box(district, x, y + 7.97, z - 0.04, w, 0.071, 0.056, frame);
      box(district, x, y + 5.91, z, w + 0.32, 0.09, 0.31, stone);
    }
    for (const [x, w] of [
      [-595.85, 6.1],
      [-581.3, 5.82],
    ]) {
      const z = westFace(x) - 0.087;
      for (const edge of [-1, 1]) {
        box(district, x, y + 4.8 + edge * 0.49, z, w, 0.115, 0.18, stone);
        box(district, x + edge * w * 0.5, y + 4.8, z, 0.115, 1.05, 0.18, stone);
      }
    }
    const deckX = -588.94,
      deckZ = westFace(deckX) - 0.49;
    box(district, deckX, y + 5.65, deckZ, 5.32, 0.23, 1.0, frame);
    box(district, deckX, y + 6.43, deckZ - 0.48, 5.4, 0.092, 0.13, frame);
    for (let i = 0; i <= 30; i++)
      box(district, deckX - 2.64 + i * 0.176, y + 6.01, deckZ - 0.46, 0.028, 0.8, 0.041, frame);
    rectangle('mount-royal-black-sheep-balcony', deckX, deckZ, 5.4, 1.1, y + 5.53, y + 6.49);

    const portal = (x, z, yaw, title, width, paper) => {
      const floor = groundHeight(x, z - 0.5);
      const normalX = Math.sin(yaw),
        normalZ = Math.cos(yaw);
      const put = (u, h, v, w, ht, d, tint) =>
        box(
          district,
          x + Math.cos(yaw) * u + normalX * v,
          floor + h,
          z - normalX * u + normalZ * v,
          w,
          ht,
          d,
          tint,
          yaw,
        );
      put(0, 2.15, 0.09, width, 4.3, 0.23, stone);
      put(0, 4.32, 0.13, width + 0.17, 0.21, 0.33, 0xd0c5aa);
      put(0, 0.14, 0.13, width + 0.13, 0.28, 0.31, 0x9e9a8d);
      arch(x, z, floor + 0.17, width * 0.76, 2.87, 0xd1c8b4, yaw, 0.224);
      arch(x, z, floor + 0.22, width * 0.66, 2.69, frame, yaw, 0.238);
      arch(x, z, floor + 0.3, width * 0.6, 2.54, glass, yaw, 0.249);
      put(0, 1.39, 0.27, 0.06, 2.23, 0.049, frame);
      put(0, 2.23, 0.27, width * 0.6, 0.073, 0.045, frame);
      sign(
        title,
        title,
        x + normalX * 0.23,
        floor + 3.52,
        z + normalZ * 0.23,
        width * 0.87,
        0.4,
        yaw,
        '#f0e8d3',
        paper,
      );
    };
    portal(-568.28, 896.06, Math.PI, 'MOUNT ROYAL BLOCK', 3.6, '#333935');
    portal(-535.05, 899.83, 2.365, 'SHOPPERS DRUG MART', 4.6, '#b83636');

    const rectangularWindow = (x, z, h, width, height) => {
      box(district, x, y + h, z - 0.075, width, height, 0.16, frame);
      box(district, x, y + h, z - 0.166, width - 0.12, height - 0.15, 0.043, glass);
      for (const u of [-1 / 3, 0, 1 / 3])
        box(district, x + width * u, y + h, z - 0.195, 0.047, height, 0.051, frame);
      box(district, x, y + h + height * 0.29, z - 0.198, width, 0.062, 0.051, frame);
    };
    rectangularWindow(-568.28, 896.06, 7.14, 2.6, 2.62);
    rectangularWindow(-568.28, 896.06, 11.47, 1.84, 1.0);
    for (const [x, z, width] of [
      [-573.09, 898.42, 2.46],
      [-561.48, 898.85, 3.52],
    ]) {
      storefront(x, z, width, 3.91, null, frame);
      rectangularWindow(x, z, 7.13, width - 0.26, 2.53);
    }
    for (const x of [-555.3, -549.6, -543.92]) {
      const z = eastFace(x);
      storefront(x, z, 5.06, 4.05, null, frame);
      rectangularWindow(x, z, 7.35, 4.92, 2.68);
    }
    sign(
      'Shoppers Drug Mart / 17 Avenue fascia',
      'SHOPPERS DRUG MART',
      -549.6,
      y + 4.45,
      eastFace(-549.6) - 0.224,
      16.5,
      0.77,
      Math.PI,
      '#fff0df',
      '#ba3b36',
    );
    box(district, -549.6, y + 9.99, eastFace(-549.6) - 0.115, 21.3, 0.2, 0.29, stone);
    box(district, -587.92, y + 9.95, westFace(-587.92) - 0.115, 23.3, 0.2, 0.29, stone);
    authoredStorefrontBuildingIds.add(royal.id);
  }

  // Brick sign and pale stone cap mark the north lawn of Western Canada High.
  const school = cityMeshes?.get('city-outline-28910-0');
  if (school?.structureIds.length === 1 && school.structureIds[0] === 1382531) {
    const x = -371.4,
      z = 904.5,
      y = groundHeight(x, z);
    box('Western Canada High School', x, y + 0.42, z, 13.1, 0.83, 0.72, 0x9a5849);
    box('Western Canada High School', x, y + 0.86, z, 13.28, 0.12, 0.84, 0xd6c5a9);
    rectangle('western-canada-brick-marker', x, z, 13.28, 0.84, y, y + 0.92);
    sign(
      'Western Canada High School',
      'WESTERN CANADA HIGH SCHOOL',
      x,
      y + 0.47,
      z - 0.373,
      12.4,
      0.51,
      Math.PI,
      '#f0ddbb',
      null,
    );
  }

  // Native riparian planting and rock armor on the water side of the mapped
  // pathway. A fixed shoreline reach avoids placing scenery on dry paths.
  if (inWater && paved) {
    const shoreline = data.waters.find((water) => water.id === 'osm-relation-7741236-0');
    const rng = seeded(1878);
    const stones = [0x9e9a8c, 0x777e74, 0x8a8174, 0xb1a896, 0x686e6a];
    const district = 'West Eau Claire riverbank';
    for (const [i, a] of (shoreline?.ring || []).entries()) {
      const b = shoreline.ring[(i + 1) % shoreline.ring.length];
      if (
        Math.min(a[0], b[0]) < -685 ||
        Math.max(a[0], b[0]) > -449 ||
        Math.min(a[1], b[1]) < -876 ||
        Math.max(a[1], b[1]) > -780 ||
        b[0] <= a[0]
      )
        continue;
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      const nx = -dz / length,
        nz = dx / length;
      for (let j = 1; j < length; j += 1.18) {
        const x = a[0] + (dx * j) / length,
          z = a[1] + (dz * j) / length;
        if (!inWater(x - nx * 2, z - nz * 2) || inWater(x + nx * 1.4, z + nz * 1.4)) continue;
        for (let row = 0; row < 3; row++) {
          const d = -0.42 + row * 0.56 + rng() * 0.31,
            px = x + nx * d,
            pz = z + nz * d;
          if (paved(px, pz)) continue;
          const r = 0.23 + rng() * 0.48,
            h = r * (0.44 + rng() * 0.31),
            y = 0.105 + row * 0.082;
          add(
            district,
            new THREE.DodecahedronGeometry(r, 0)
              .rotateY(rng() * 6.28)
              .scale(1, h / r, 0.82)
              .translate(px, y, pz),
            stones[Math.floor(rng() * stones.length)],
          );
          if (row === 2 && r > 0.47)
            rectangle(`bow-rock-${i}-${j}`, px, pz, r * 1.35, r * 1.12, y - h, y + h);
        }
        const d = 1.4 + rng() * 1.9,
          px = x + nx * d,
          pz = z + nz * d;
        if (!paved(px, pz) && !inWater(px, pz) && rng() > 0.38) {
          const ground = groundHeight(px, pz),
            radius = 0.3 + rng() * 0.45;
          add(
            district,
            new THREE.IcosahedronGeometry(radius, 0)
              .scale(1, 0.72, 0.82)
              .translate(px, ground + radius * 0.38, pz),
            rng() > 0.55 ? 0x647f4e : 0x7d8d58,
          );
          for (let k = 0; k < 4; k++) {
            const vx = px + (rng() - 0.5) * 1.25,
              vz = pz + (rng() - 0.5) * 1.25;
            if (paved(vx, vz)) continue;
            beam(
              district,
              new THREE.Vector3(vx, ground, vz),
              new THREE.Vector3(vx + (rng() - 0.5) * 0.28, ground + 0.32 + rng() * 0.48, vz),
              0.033,
              0.006,
              0x979955,
              4,
            );
          }
        }
      }
    }
  }

  // Delta Garden's City planting polygons already separate the plaza paths.
  // The photos establish the concrete edges and tiered profiles; rises are inferred.
  const delta = 'West Eau Claire Delta Garden';
  const deltaRises = [
    0.47, 0.56, 0.72, 0.62, 0.55, 0.42, 0.66, 0.6, 0.48, 0.45, 0.52, 0.54, 0.64, 0.29, 0.31,
  ];
  for (const planter of parkData?.ground || []) {
    const match = /^park-ground-(38(?:6[3-9]|7[0-7]))$/.exec(planter.id);
    if (!match || planter.holes?.length || planter.ring.length < 4) continue;
    const area = bounds(planter.ring);
    if (area.minX < -447 || area.maxX > -358 || area.minZ < -842 || area.maxZ > -778) continue;
    const ring = planter.ring,
      n = Number(match[1]),
      rise = deltaRises[n - 3863],
      base = Math.min(...ring.map(([x, z]) => groundHeight(x, z))) - 0.03,
      top = Math.max(...ring.map(([x, z]) => groundHeight(x, z))) + rise,
      shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    add(
      delta,
      new THREE.ExtrudeGeometry(shape, { depth: top - base, bevelEnabled: false, steps: 1 })
        .rotateX(-Math.PI / 2)
        .translate(0, base, 0),
      0xc7c3b4,
    );
    add(delta, createLinearPolygonGeometry(planter, top + 0.006), 0x657649);
    const edges = [];
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1],
        b = ring[i],
        length = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (length < 0.02) continue;
      const yaw = Math.atan2(a[1] - b[1], b[0] - a[0]);
      const x = (a[0] + b[0]) / 2,
        z = (a[1] + b[1]) / 2;
      edges.push({ a, b, length, x, z, yaw });
      box(delta, x, top + 0.022, z, length, 0.072, 0.17, 0xd8d2c2, yaw);
    }
    const seat = edges.reduce((best, edge) => (!best || edge.length > best.length ? edge : best), null);
    if ((n === 3865 || n === 3873) && seat?.length > 3) {
      for (let slat = -1; slat <= 1; slat++) {
        const d = slat * 0.093;
        box(
          delta,
          seat.x + Math.sin(seat.yaw) * d,
          top + 0.078,
          seat.z + Math.cos(seat.yaw) * d,
          Math.min(4.6, seat.length - 0.5),
          0.041,
          0.084,
          0x9b7355,
          seat.yaw,
        );
      }
    }
    colliders.push({
      id: `delta-planter-${n}`,
      ring,
      minHeight: base,
      height: top + 0.1,
      storefrontAnchor: false,
    });
    const random = seeded(n);
    const stems = [0x879653, 0xaaab68, 0x657944, 0x9d925d];
    const flowers = [0xe0b750, 0xc3924c, 0xccc2a7, 0x929ab9];
    const clusters = Math.min(65, Math.ceil((area.maxX - area.minX) * (area.maxZ - area.minZ) * 0.48));
    for (let i = 0; i < clusters; i++) {
      const x = area.minX + random() * (area.maxX - area.minX),
        z = area.minZ + random() * (area.maxZ - area.minZ);
      if (!inPolygon(x, z, planter) || edges.some(({ a, b }) => nearestOnSegment(x, z, a, b).distance < 0.31))
        continue;
      const h = 0.28 + random() * 0.48,
        tint = stems[Math.floor(random() * stems.length)];
      for (let blade = 0; blade < 5; blade++) {
        const angle = (blade * Math.PI * 2) / 5 + random() * 0.9;
        const start = new THREE.Vector3(x, top, z);
        const end = start
          .clone()
          .add(
            new THREE.Vector3(Math.cos(angle) * 0.21, h * (0.69 + random() * 0.43), Math.sin(angle) * 0.21),
          );
        beam(delta, start, end, 0.043, 0.003, tint, 3);
        if (blade === 0 && random() > 0.55)
          add(
            delta,
            new THREE.IcosahedronGeometry(0.061, 0).scale(1, 0.55, 1).translate(...end),
            flowers[Math.floor(random() * flowers.length)],
          );
      }
    }
    stats.deltaPlanters++;
  }

  // Low seasonal bedding sits inside existing Tomkins turf polygons.
  const random = seeded(208);
  for (const [x, z, length, width] of [
    [-637, 862.2, 4.3, 1.55],
    [-609, 863, 5.2, 1.8],
    [-575, 864.6, 5.5, 1.9],
    [-554, 864.9, 3.3, 1.6],
  ]) {
    const ring = [
      [x - length / 2, z - width / 2],
      [x + length / 2, z - width / 2],
      [x + length / 2, z + width / 2],
      [x - length / 2, z + width / 2],
    ];
    if (!ring.every(([a, b]) => turfHeight(a, b) != null)) continue;
    const y = turfHeight(x, z);
    box('Tomkins Park', x, y + 0.035, z, length, 0.09, width, 0x61493d);
    for (let j = 0; j < Math.round(length * width * 11); j++) {
      const a = x + (random() - 0.5) * (length - 0.16),
        b = z + (random() - 0.5) * (width - 0.12),
        h = 0.16 + random() * 0.24;
      const stem = new THREE.Vector3(a, y + 0.08, b),
        top = stem.clone().add(new THREE.Vector3((random() - 0.5) * 0.11, h, (random() - 0.5) * 0.11));
      beam('Tomkins Park', stem, top, 0.024, 0.012, 0x47643b, 4);
      const palette = [0xe7aa36, 0xdf7d9d, 0x926ab6, 0xf2e7c5, 0xd9724b];
      add(
        'Tomkins Park',
        new THREE.IcosahedronGeometry(0.095 + random() * 0.06, 0).scale(1, 0.48, 1).translate(...top),
        palette[Math.floor(random() * palette.length)],
      );
    }
    stats.flowerBeds++;
  }

  buildChinatownDetails({ cityMeshes, sign, box, add, labels });
  buildDiscoverySpots({ add, box, beam, rectangle, labels, groundHeight });
  const highPark = buildHighPark({ add, box, beam, rectangle, sign, labels, cityMeshes, steps });
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82 });
  for (const [name, parts] of groups) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    for (const part of parts) part.dispose();
    mesh.name = `Calgary neighborhood detail / ${name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  return { colliders, labels, stats, steps, authoredStorefrontBuildingIds, highPark };
}

const avenueBannerPoles = new Set([
  'support-city-light-1110388221',
  'support-city-light-1110388231',
  'support-city-light-1110388233',
  'support-city-light-1110388162',
  'support-city-light-1110388171',
]);

// The Devenish and Mount Royal Block exterior photos show red district
// banners on the acorn lights. Use those surveyed poles as the mounts.
export function addSeventeenthAvenueBanners(scene, supports = []) {
  if (typeof document === 'undefined') return 0;
  const mounts = supports.filter((support) => avenueBannerPoles.has(support.id));
  if (!mounts.length) return 0;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#a32c3e';
  ctx.fillRect(0, 0, 128, 192);
  ctx.fillStyle = '#be3948';
  ctx.fillRect(7, 9, 114, 174);
  ctx.fillStyle = '#ffe6bf';
  ctx.textAlign = 'center';
  ctx.font = 'italic 900 71px Georgia';
  ctx.fillText('17', 62, 94);
  ctx.fillRect(25, 106, 78, 2.2);
  ctx.font = 'bold 13px system-ui';
  ctx.fillText('EAT · SHOP', 64, 130);
  ctx.fillText('PLAY · EXPLORE', 64, 153);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const panels = [],
    mountsGeometry = [];
  for (const { x, baseY, z, profile } of mounts) {
    const y = baseY + Math.min(profile.height - 1.27, 3.45);
    mountsGeometry.push(new THREE.BoxGeometry(1.44, 0.039, 0.046).translate(x, y + 0.53, z));
    for (const side of [-1, 1])
      for (const face of [-1, 1])
        panels.push(
          new THREE.PlaneGeometry(0.56, 1.0)
            .rotateY(face < 0 ? Math.PI : 0)
            .translate(x + side * 0.39, y, z + face * 0.008),
        );
  }
  const banner = new THREE.Mesh(
    mergeGeometries(panels),
    new THREE.MeshStandardNodeMaterial({ map, roughness: 0.98 }),
  );
  banner.name = '17 Avenue district banners';
  banner.receiveShadow = true;
  const arms = new THREE.Mesh(
    mergeGeometries(mountsGeometry),
    new THREE.MeshStandardNodeMaterial({ color: 0x26312f, roughness: 0.82 }),
  );
  scene.add(banner, arms);
  for (const geometry of [...panels, ...mountsGeometry]) geometry.dispose();
  return mounts.length * 2;
}
