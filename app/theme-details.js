import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { inside, nearestOnSegment, project } from './geo.js';

export const TOKYO_DETAIL_LIMITS = Object.freeze({ balanced: 16, high: 28, radius: 260 });
// These are generic Japanese words, not invented claims about mapped businesses.
export const THEME_SIGN_WORDS = Object.freeze([
  '喫茶',
  '食堂',
  '書店',
  '居酒屋',
  'ラーメン',
  '青空',
  '音楽',
  '写真',
]);
const neonColors = [0xf65f94, 0x5cddd9, 0xffba69, 0xe5ec95, 0xb495ff, 0x8bd7b6, 0xfa7a68, 0x96c8fa];

function atlasTexture() {
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(
      new Uint8Array([255, 90, 150, 255, 50, 220, 210, 255, 255, 190, 100, 255, 180, 140, 255, 255]),
      2,
      2,
    );
    tex.needsUpdate = true;
    return tex;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2048;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const vertical = i < 8,
      index = i % 8,
      width = vertical ? 200 : 640,
      height = vertical ? 640 : 160;
    ctx.save();
    ctx.translate((i % 4) * 512, Math.floor(i / 4) * 512);
    ctx.scale(512 / width, 512 / height);
    ctx.fillStyle = '#102026';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = `#${neonColors[index].toString(16).padStart(6, '0')}`;
    ctx.lineWidth = vertical ? 9 : 7;
    ctx.strokeRect(8, 8, width - 16, height - 16);
    ctx.strokeRect(17, 17, width - 34, height - 34);
    ctx.fillStyle = '#fff5e5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 10;
    const chars = [...THEME_SIGN_WORDS[index]];
    ctx.font = `${vertical ? 108 : 95}px "Hiragino Sans", "Noto Sans JP", sans-serif`;
    if (vertical) {
      const step = Math.min(135, 420 / chars.length),
        start = height / 2 - ((chars.length - 1) * step) / 2;
      chars.forEach((letter, j) => ctx.fillText(letter, width / 2, start + j * step));
    } else ctx.fillText(THEME_SIGN_WORDS[index], width / 2, height / 2 + 2);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function exteriorAnchor(destination, world) {
  const [px, pz] = project(destination.lon, destination.lat);
  let best = null;
  for (const b of world.buildingIndex?.near(px, pz, 38) || []) {
    if (
      !b.ring ||
      b.storefrontAnchor === false ||
      b.type === 'bridge-guardrail' ||
      b.type === 'park-furniture' ||
      b.height < 4 ||
      /garage|shed|carport/.test(b.kind || '')
    )
      continue;
    for (let i = 1; i < b.ring.length; i++) {
      const a = b.ring[i - 1],
        c = b.ring[i],
        dx = c[0] - a[0],
        dz = c[1] - a[1],
        len = Math.hypot(dx, dz);
      if (len < 4) continue;
      const p = nearestOnSegment(px, pz, a, c);
      if (p.distance > 24) continue;
      let nx = -dz / len,
        nz = dx / len;
      if (inside(p.x + nx * 0.2, p.z + nz * 0.2, b.ring)) {
        nx *= -1;
        nz *= -1;
      }
      if ((px - p.x) * nx + (pz - p.z) * nz < 0) continue;
      if (world.inWater?.(p.x + nx, p.z + nz)) continue;
      const road = world.roadIndex?.nearest(p.x + nx * 2, p.z + nz * 2, true, 45, true);
      const score = p.distance + Math.min(road?.distance ?? 30, 30) * 0.15;
      if (!best || score < best.score)
        best = {
          x: p.x,
          z: p.z,
          nx,
          nz,
          width: Math.min(len, 7),
          height: b.height,
          b,
          edge: i,
          score,
          destination,
        };
    }
  }
  return best;
}

export function collectThemeAnchors(world, camera, quality = 'balanced') {
  if (camera.position.y > 180) return [];
  const limit = quality === 'high' ? TOKYO_DETAIL_LIMITS.high : TOKYO_DETAIL_LIMITS.balanced;
  const candidates = (world.businessPlaces || [])
    .map((destination) => {
      const [x, z] = project(destination.lon, destination.lat);
      return { destination, d: Math.hypot(x - camera.position.x, z - camera.position.z) };
    })
    .filter((p) => p.d < TOKYO_DETAIL_LIMITS.radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit * 4);
  const anchors = [];
  for (const { destination } of candidates) {
    const anchor = exteriorAnchor(destination, world);
    if (!anchor) continue;
    if (anchors.some((a) => Math.hypot(a.x - anchor.x, a.z - anchor.z) < 6)) continue;
    anchors.push({ ...anchor, seed: Math.abs(Math.round(anchor.x * 11 + anchor.z * 17)) });
    if (anchors.length >= limit) break;
  }
  return anchors;
}

function colorGeometry(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry,
    col = new THREE.Color(hex),
    a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) {
    a[i] = col.r;
    a[i + 1] = col.g;
    a[i + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g !== geometry) geometry.dispose();
  return g;
}

function combine(geometries, material, name) {
  if (!geometries.length) return null;
  const g = mergeGeometries(geometries);
  geometries.forEach((item) => item.dispose());
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

export function createThemeDetails(scene, world) {
  const atlas = atlasTexture(),
    fixtureMaterial = new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.15,
    });
  const signMaterial = new THREE.MeshBasicNodeMaterial({
    map: atlas,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const glowMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, toneMapped: false });
  const lanternMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xca4d35,
    roughness: 0.8,
    emissive: 0xf77e37,
    emissiveIntensity: 0.35,
  });
  let active = false,
    meshes = [],
    lastKey = '',
    lastX = Infinity,
    lastZ = Infinity,
    lastQuality = '',
    lastAerial = false;
  const stats = { activeSigns: 0, activeLanterns: 0, utilityPoles: 0, drawCalls: 0 };
  const clearMeshes = () => {
    for (const mesh of meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    meshes = [];
    stats.activeSigns = stats.activeLanterns = stats.utilityPoles = stats.drawCalls = 0;
  };
  function rebuild(anchors) {
    clearMeshes();
    const fixtures = [],
      signs = [],
      glows = [],
      lanterns = [];
    const add = (array, g, hex) => array.push(colorGeometry(g, hex));
    for (const a of anchors) {
      const angle = Math.atan2(a.nx, a.nz),
        tx = Math.cos(angle),
        tz = -Math.sin(angle);
      const base = Math.max(0, world.groundHeight?.(a.x + a.nx, a.z + a.nz) ?? 0.2),
        vertical = a.seed % 3 !== 0;
      const signWidth = vertical ? 0.84 : Math.min(4.2, a.width * 0.75),
        signHeight = vertical ? Math.min(3.8, Math.max(0.9, a.height - 2.6)) : 0.86;
      const centerY = base + (vertical ? Math.min(a.height - signHeight / 2 - 0.15, 5.1) : 3.7);
      const position = new THREE.Vector3(a.x + a.nx * 0.48, centerY, a.z + a.nz * 0.48);
      const backing = new THREE.BoxGeometry(signWidth + 0.12, signHeight + 0.14, 0.25);
      backing.rotateY(angle);
      backing.translate(...position.toArray());
      add(fixtures, backing, 0x25343c);
      const cell = (a.seed % 8) + (vertical ? 0 : 8),
        sign = new THREE.PlaneGeometry(signWidth, signHeight),
        uv = sign.attributes.uv;
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, ((cell % 4) + uv.getX(i)) / 4, 1 - (Math.floor(cell / 4) + 1 - uv.getY(i)) / 4);
      sign.rotateY(angle);
      sign.translate(position.x + a.nx * 0.132, position.y, position.z + a.nz * 0.132);
      signs.push(sign.toNonIndexed());
      sign.dispose();
      for (const side of [-1, 1]) {
        const edge = new THREE.BoxGeometry(0.045, signHeight + 0.16, 0.035);
        edge.rotateY(angle);
        edge.translate(
          position.x + tx * side * (signWidth / 2 + 0.04) + a.nx * 0.145,
          position.y,
          position.z + tz * side * (signWidth / 2 + 0.04) + a.nz * 0.145,
        );
        add(glows, edge, neonColors[a.seed % neonColors.length]);
      }
      // Brackets and two paper-lantern silhouettes sit against the frontage.
      for (const side of [-1, 1]) {
        const u = side * Math.min(a.width / 2 - 0.35, 1.7),
          x = a.x + tx * u + a.nx * 0.75,
          z = a.z + tz * u + a.nz * 0.75;
        if (world.inWater?.(x, z)) continue;
        const h = base + 2.8;
        const bracket = new THREE.BoxGeometry(0.04, 0.04, 0.9);
        bracket.rotateY(angle);
        bracket.translate(a.x + tx * u + a.nx * 0.4, h + 0.25, a.z + tz * u + a.nz * 0.4);
        add(fixtures, bracket, 0x343b3c);
        const lantern = new THREE.SphereGeometry(0.22, 10, 8);
        lantern.scale(1, 1.35, 1);
        lantern.translate(x, h - 0.12, z);
        lanterns.push(lantern.toNonIndexed());
        lantern.dispose();
        for (const yy of [h + 0.17, h - 0.41]) {
          const cap = new THREE.CylinderGeometry(0.13, 0.13, 0.05, 8);
          cap.translate(x, yy, z);
          add(fixtures, cap, 0x263638);
        }
        for (const yy of [h - 0.3, h - 0.16, h - 0.02]) {
          const rib = new THREE.TorusGeometry(0.213, 0.008, 3, 10);
          rib.rotateX(Math.PI / 2);
          rib.translate(x, yy, z);
          add(fixtures, rib, 0x8b3c2f);
        }
        stats.activeLanterns++;
      }
      // Utility hardware is an optional theme prop placed outside the mapped
      // carriageway; a building-front sign does not grant permission to fill it.
      const px = a.x + a.nx * 2.1 + tx * Math.min(2.2, a.width / 2 - 0.3),
        pz = a.z + a.nz * 2.1 + tz * Math.min(2.2, a.width / 2 - 0.3),
        nearRoad = world.roadIndex?.nearest(px, pz, true, 22);
      const clear =
        !world.inWater?.(px, pz) &&
        ![...(world.buildingIndex?.near(px, pz, 0.3) || [])].some((b) => inside(px, pz, b.ring));
      if (clear && nearRoad && nearRoad.distance > nearRoad.width / 2 + 0.8 && a.seed % 3 === 0) {
        const y = world.groundHeight?.(px, pz) ?? 0.2,
          pole = new THREE.CylinderGeometry(0.075, 0.12, 6.5, 7);
        pole.translate(px, y + 3.25, pz);
        add(fixtures, pole, 0x7c8582);
        const arm = new THREE.BoxGeometry(2.0, 0.07, 0.08);
        arm.rotateY(angle);
        arm.translate(px, y + 6.1, pz);
        add(fixtures, arm, 0x465853);
        for (const side of [-1, 1]) {
          const insulator = new THREE.CylinderGeometry(0.075, 0.06, 0.17, 6);
          insulator.translate(px + tx * side * 0.75, y + 6.23, pz + tz * side * 0.75);
          add(fixtures, insulator, 0xd6d3bd);
        }
        stats.utilityPoles++;
      }
      stats.activeSigns++;
    }
    for (const [g, mat, name] of [
      [fixtures, fixtureMaterial, 'Tokyo-inspired brackets and utility detail'],
      [signs, signMaterial, 'Generated Japanese neon signs'],
      [glows, glowMaterial, 'Neon sign edge tubes'],
      [lanterns, lanternMaterial, 'Tokyo-inspired paper lanterns'],
    ]) {
      const mesh = combine(g, mat, name);
      if (mesh) {
        meshes.push(mesh);
        scene.add(mesh);
      }
    }
    stats.drawCalls = meshes.length;
  }
  return {
    stats,
    setActive(next) {
      active = Boolean(next);
      lastKey = '';
      lastX = Infinity;
      if (!active) clearMeshes();
    },
    update(camera, quality = 'balanced', night = 0) {
      if (!active) return;
      const aerial = camera.position.y > 180;
      signMaterial.color.setScalar(0.9 + Math.max(0, Math.min(1, night)) * 0.4);
      lanternMaterial.emissiveIntensity = 0.25 + Math.max(0, Math.min(1, night)) * 1.05;
      if (
        Math.hypot(camera.position.x - lastX, camera.position.z - lastZ) < 28 &&
        quality === lastQuality &&
        aerial === lastAerial
      )
        return;
      lastX = camera.position.x;
      lastZ = camera.position.z;
      lastQuality = quality;
      lastAerial = aerial;
      const anchors = collectThemeAnchors(world, camera, quality),
        key = anchors.map((a) => `${a.b.id}:${a.edge}:${Math.round(a.x)},${Math.round(a.z)}`).join(';');
      if (key !== lastKey) {
        lastKey = key;
        rebuild(anchors);
      }
    },
    dispose() {
      clearMeshes();
      atlas.dispose();
      fixtureMaterial.dispose();
      signMaterial.dispose();
      glowMaterial.dispose();
      lanternMaterial.dispose();
    },
  };
}
