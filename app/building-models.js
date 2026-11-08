import * as THREE from 'three/webgpu';
import { mergeStaticGeometries } from './static-batches.js';
import { translateBuildingY } from './building-ground.js';
import { inside } from './geo.js';
import { referenceWallZones } from './facade-finishes.js';
import { observedBuildingMaterialZones } from './observed-building-materials.js';
import { simmonsBackingEvidence } from './simmons-evidence.js';
import { simmonsWestMaterialEvidence } from './simmons-west-material.js';
import { createLinearPolygonGeometry } from './linear-polygon-geometry.js';

/** Low detail houses use the original footprint and roof height with no underground cap. */
export function createCompactBuildingGeometry(building, height) {
  const roof = createLinearPolygonGeometry(building, height);
  const rings = [building.ring, ...(building.holes || [])];
  const vertexBudget = roof.index.count + rings.reduce((sum, ring) => sum + ring.length * 6, 0);
  const position = new Float32Array(vertexBudget * 3),
    normal = new Float32Array(vertexBudget * 3);
  let offset = 0;
  for (let i = 0; i < roof.index.count; i++) {
    const index = roof.index.getX(i);
    position[offset] = roof.attributes.position.getX(index);
    position[offset + 1] = height;
    position[offset + 2] = roof.attributes.position.getZ(index);
    normal[offset + 1] = 1;
    offset += 3;
  }
  roof.dispose();
  const emit = (point, y, nx, nz) => {
    position[offset] = point[0];
    position[offset + 1] = y;
    position[offset + 2] = point[1];
    normal[offset] = nx;
    normal[offset + 2] = nz;
    offset += 3;
  };
  for (const [index, ring] of rings.entries()) {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const forward = area > 0 === (index === 0);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[forward ? i : (i + 1) % ring.length];
      const b = ring[forward ? (i + 1) % ring.length : i];
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      if (!length) continue;
      const nx = dz / length,
        nz = -dx / length;
      emit(a, 0, nx, nz);
      emit(a, height, nx, nz);
      emit(b, 0, nx, nz);
      emit(b, 0, nx, nz);
      emit(a, height, nx, nz);
      emit(b, height, nx, nz);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position.subarray(0, offset), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal.subarray(0, offset), 3));
  return geometry;
}

const HOUSE = /^(house|detached|semidetached_house|terrace|residential_roof_outline)$/;
const GARAGE = /garage|shed|carport|container/;
function hash(value) {
  let n = 2166136261;
  for (const c of String(value)) {
    n ^= c.charCodeAt(0);
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0) / 4294967295;
}
export function buildingProfile(b, metadata = {}) {
  const seed = hash(b.osmId || b.id),
    kind = HOUSE.test(b.kind) ? b.kind : metadata.kind || b.kind,
    height = Math.max(2.8, Math.min(300, b.height)),
    residential = HOUSE.test(kind) || metadata.smallResidential === true;
  let style =
    height > 55
      ? 0
      : residential
        ? 4
        : GARAGE.test(kind)
          ? 5
          : /warehouse|industrial/.test(kind)
            ? 6
            : /apartments|residential/.test(kind)
              ? 3
              : 1;
  const finish = metadata.material || '';
  if (!residential && /sandstone|limestone|stone|masonry/.test(finish)) style = 2;
  else if (!residential && /brick/.test(finish)) style = 3;
  else if (/glass/.test(finish)) style = 0;
  else if (/metal|steel|corrugated/.test(finish)) style = 6;
  else if (metadata.historic) style = 2;
  const palettes = [
    [0x749fae, 0x526f87, 0x8aa6ac],
    [0xc2aa8f, 0xc6b6a6, 0x97a8a0],
    [0xb3a17c, 0x9d765c, 0xbaab8f],
    [0xad795d, 0xc1a98a, 0xa7a49a],
    [0xdccbbc, 0xb7c0aa, 0xbc9380, 0xaab4bc, 0x9d7b65, 0xb4ae89],
    [0xaaa294, 0xa69c8e, 0xc3b9a6],
    [0xa3a7a1, 0xa8a299, 0x929995],
  ];
  const palette = palettes[style];
  const color = new THREE.Color(palette[Math.floor(seed * palette.length) % palette.length]);
  if (
    metadata.color &&
    (/^#[0-9a-f]{3,6}$/i.test(metadata.color) || Object.hasOwn(THREE.Color.NAMES, metadata.color))
  )
    color.set(metadata.color);
  const levels = Number(metadata.levels);
  const floorHeight =
    levels > 0
      ? Math.max(2.7, Math.min(5, height / levels))
      : style === 0
        ? 3.8
        : style === 6
          ? 5
          : style === 4
            ? 3.5
            : 3.15;
  return {
    style,
    seed,
    color,
    height,
    floorHeight,
    bayWidth:
      style === 0 ? 2.4 : style === 5 ? 3 : style === 6 ? 5.5 : style === 4 ? 2.8 + seed : 2.1 + seed * 0.8,
    pitched: height < 14 && residential && metadata.roofShape !== 'flat',
    residential,
    front: residential && metadata.front,
    roofShape: metadata.roofShape || null,
  };
}

export function decorateBuildingGeometry(g, b, profile) {
  const pos = g.attributes.position,
    norm = g.attributes.normal,
    n = pos.count,
    colors = new Uint8Array(n * 4),
    wallUV = new Float32Array(n * 2),
    profiles = new Uint16Array(n * 4);
  const front = profile.front;
  const cx = b.ring.reduce((sum, p) => sum + p[0], 0) / b.ring.length,
    cz = b.ring.reduce((sum, p) => sum + p[1], 0) / b.ring.length;
  const packed = (value, range) => Math.round(Math.max(0, Math.min(1, value / range)) * 65535);
  const seed = packed(Math.round(profile.seed * 1023), 1023),
    style = packed(profile.style, 7),
    floor = packed(profile.floorHeight, 8),
    bay = packed(profile.bayWidth, 8),
    red = Math.round(profile.color.r * 255),
    green = Math.round(profile.color.g * 255),
    blue = Math.round(profile.color.b * 255);
  const observations = observedBuildingMaterialZones(g, b),
    references = referenceWallZones(g, b),
    materialZones =
      observations && references
        ? [...references.zones, ...observations.zones]
        : (observations || references)?.zones,
    observedProfiles = materialZones && new Map(),
    photoBacking = simmonsBackingEvidence(g, b),
    photoBackingFaces = photoBacking && new Set(photoBacking.triangles),
    photoBrick = photoBacking && new THREE.Color(0x8b5b47),
    westMaterial = simmonsWestMaterialEvidence(g, b),
    westFaces = westMaterial && new Set(westMaterial.triangles),
    westBrick = westMaterial && new THREE.Color(westMaterial.color);
  for (const zone of materialZones || []) {
    const color = new THREE.Color(zone.color);
    observedProfiles.set(zone, {
      red: Math.round(color.r * 255),
      green: Math.round(color.g * 255),
      blue: Math.round(color.b * 255),
      style: packed(zone.style, 7),
      floor: packed(zone.floorHeight, 8),
      bay: packed(zone.bayWidth, 8),
    });
  }
  const packedAttributes = [pos, norm].every(
    (attribute) =>
      attribute.array instanceof Float32Array &&
      attribute.itemSize === 3 &&
      !attribute.normalized &&
      !attribute.isInterleavedBufferAttribute &&
      attribute.getX === THREE.BufferAttribute.prototype.getX &&
      attribute.getY === THREE.BufferAttribute.prototype.getY &&
      attribute.getZ === THREE.BufferAttribute.prototype.getZ,
  );
  if (!materialZones && !photoBacking && !westMaterial && packedAttributes) {
    const positions = pos.array,
      normals = norm.array;
    for (let i = 0; i < n; i++) {
      const c = i * 4,
        uv = i * 2,
        at = i * 3;
      colors[c] = red;
      colors[c + 1] = green;
      colors[c + 2] = blue;
      colors[c + 3] = 255;
      wallUV[uv] = (positions[at] - cx) * normals[at + 2] - (positions[at + 2] - cz) * normals[at];
      if (front && normals[at] * front[0] + normals[at + 2] * front[1] > 0.74) wallUV[uv] += 8192;
      wallUV[uv + 1] = positions[at + 1];
      profiles[c] = style;
      profiles[c + 1] = seed;
      profiles[c + 2] = floor;
      profiles[c + 3] = bay;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const c = i * 4,
        uv = i * 2,
        p = i * 4,
        zone =
          observations?.triangleZones.get(Math.floor(i / 3)) ??
          references?.triangleZones.get(Math.floor(i / 3)),
        observed = zone && observedProfiles.get(zone),
        photographedFace = photoBackingFaces?.has(Math.floor(i / 3)),
        observedWestFace = westFaces?.has(Math.floor(i / 3)),
        brick = photographedFace ? photoBrick : observedWestFace ? westBrick : null;
      colors[c] = brick ? Math.round(brick.r * 255) : (observed?.red ?? red);
      colors[c + 1] = brick ? Math.round(brick.g * 255) : (observed?.green ?? green);
      colors[c + 2] = brick ? Math.round(brick.b * 255) : (observed?.blue ?? blue);
      colors[c + 3] = 255;
      wallUV[uv] = zone?.uAxis
        ? (pos.getX(i) - zone.origin[0]) * zone.uAxis[0] +
          (pos.getZ(i) - zone.origin[1]) * zone.uAxis[1] +
          zone.uOffset
        : (pos.getX(i) - (zone?.origin[0] ?? cx)) * norm.getZ(i) -
          (pos.getZ(i) - (zone?.origin[1] ?? cz)) * norm.getX(i);
      if (!zone && front && norm.getX(i) * front[0] + norm.getZ(i) * front[1] > 0.74) wallUV[uv] += 8192;
      wallUV[uv + 1] = pos.getY(i) - (zone?.uvBase ?? 0);
      // Integer seed survives perspective interpolation without the tiny rounding
      // changes that a high-frequency fragment hash can amplify into twinkling.
      // Style7 adds observed brick and masks only upper inferred glazing. The
      // existing lower opening grid stays in place; no source mesh is split and
      // no extra vertex channel or ground-floor geometry is introduced.
      profiles[p] = photographedFace
        ? packed(photoBacking.style, 7)
        : observedWestFace
          ? packed(westMaterial.style, 7)
          : (observed?.style ?? style);
      profiles[p + 1] = seed;
      profiles[p + 2] = observed?.floor ?? floor;
      profiles[p + 3] = observed?.bay ?? bay;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
  g.setAttribute('wallUV', new THREE.BufferAttribute(wallUV, 2));
  g.setAttribute('buildingProfile', new THREE.BufferAttribute(profiles, 4, true));
  if (observations)
    g.userData.materialEvidence = {
      ...observations.evidence,
      observedFaceTriangles: observations.triangleZones.size,
      geometricChanges: false,
      hiddenSidesObserved: false,
    };
  if (references) g.userData.referenceWallTriangles = references.triangleZones.size;
  if (photoBacking)
    g.userData.photoBackingEvidence = { ...photoBacking, brickColor: 0x8b5b47, colorCalibrated: false };
  if (westMaterial) g.userData.simmonsWestMaterialEvidence = { ...westMaterial, colorCalibrated: false };
  // This material uses physical wallUV, not the generic extrusion UV channel.
  // Position/face normals remain full precision; only colour/profile storage packs.
  g.deleteAttribute('uv');
  return g;
}

// Roofs and cornices use their real footprint. Small rectangular houses receive
// a gable; irregular outlines retain a flat roof rather than an invented roof
// extending into a neighbour. Unmapped roof shapes remain estimates.
export function buildingDetails(b, profile) {
  const ring = b.ring.slice(0, -1),
    out = [];
  if (ring.length < 3) return out;
  let area = 0,
    best = 0,
    axis = [1, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      c = ring[(i + 1) % ring.length],
      dx = c[0] - a[0],
      dz = c[1] - a[1],
      len = Math.hypot(dx, dz);
    area += a[0] * c[1] - c[0] * a[1];
    if (len > best) {
      best = len;
      axis = [dx / len, dz / len];
    }
  }
  area = Math.abs(area) / 2;
  const perp = [-axis[1], axis[0]],
    u = ring.map((p) => p[0] * axis[0] + p[1] * axis[1]),
    v = ring.map((p) => p[0] * perp[0] + p[1] * perp[1]);
  const minU = Math.min(...u),
    maxU = Math.max(...u),
    minV = Math.min(...v),
    maxV = Math.max(...v),
    w = maxU - minU,
    d = maxV - minV;
  const point = (u, v, y) => [u * axis[0] + v * perp[0], y, u * axis[1] + v * perp[1]];
  const box = (width, height, depth, pu, pv, y) => {
    const g = new THREE.BoxGeometry(width, height, depth);
    g.rotateY(-Math.atan2(axis[1], axis[0]));
    const p = point(pu, pv, y);
    g.translate(...p);
    out.push(g);
  };
  if (profile.pitched && w > 4 && d > 4 && area / (w * d) > 0.86 && !b.holes?.length) {
    const low = profile.height + 0.08,
      high = low + Math.min(3.4, d * 0.32),
      mid = (minV + maxV) / 2;
    const a = point(minU - 0.2, minV - 0.25, low),
      c = point(maxU + 0.2, minV - 0.25, low),
      e = point(maxU + 0.2, maxV + 0.25, low),
      f = point(minU - 0.2, maxV + 0.25, low),
      r1 = point(minU - 0.2, mid, high),
      r2 = point(maxU + 0.2, mid, high);
    const positions = [
      ...a,
      ...r1,
      ...c,
      ...c,
      ...r1,
      ...r2,
      ...f,
      ...e,
      ...r1,
      ...e,
      ...r2,
      ...r1,
      ...a,
      ...f,
      ...r1,
      ...c,
      ...r2,
      ...e,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
    g.computeVertexNormals();
    out.push(g);
  } else if (!profile.residential && area > 55 && profile.height > 5) {
    // Roof-edge coping and a recessed mechanical penthouse break the flat-box
    // silhouette while staying within the mapped outer walls.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        c = ring[(i + 1) % ring.length],
        len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 2) continue;
      const g = new THREE.BoxGeometry(len, 0.48, 0.3);
      g.rotateY(-Math.atan2(c[1] - a[1], c[0] - a[0]));
      g.translate((a[0] + c[0]) / 2, profile.height + 0.24, (a[1] + c[1]) / 2);
      out.push(g);
    }
    const pu = (minU + maxU) / 2,
      pv = (minV + maxV) / 2,
      p = point(pu, pv, 0);
    if (
      area > 180 &&
      w > 10 &&
      d > 10 &&
      inside(p[0], p[2], b.ring) &&
      !(b.holes || []).some((h) => inside(p[0], p[2], h))
    ) {
      box(
        Math.min(w * 0.25, 9),
        profile.height > 50 ? 3 : 1.3,
        Math.min(d * 0.25, 6),
        pu,
        pv,
        profile.height + (profile.height > 50 ? 1.5 : 0.65),
      );
      if (profile.height > 70)
        box(Math.min(w * 0.32, 12), 0.35, Math.min(d * 0.32, 8), pu, pv, profile.height + 3.2);
    }
  }
  return out;
}

export function buildRoofDetailGeometry(definitions) {
  const parts = definitions.flatMap(({ b, profile, groundPlacement }) => {
    const geometries = buildingDetails(b, profile);
    for (const geometry of geometries) translateBuildingY(geometry, groundPlacement?.offsetM);
    return geometries;
  });
  if (!parts.length) return null;
  try {
    return mergeStaticGeometries(parts);
  } finally {
    for (const part of parts) part.dispose();
  }
}
