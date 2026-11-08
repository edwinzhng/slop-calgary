import * as THREE from 'three/webgpu';
import { attribute, color, mix, smoothstep, texture } from 'three/tsl';
import { windowGlow } from './city-uniforms.js';
import { mergeStaticGeometries } from './static-batches.js';

export const STOREFRONT_LIMIT = 36;
const columns = 4;
const signWidth = 256;
const signHeight = 48;
const displayTop = (STOREFRONT_LIMIT / columns) * signHeight;
const atlasWidth = columns * signWidth;
const atlasHeight = displayTop + 112;
const interiors = {
  hospitality: {
    column: 0,
    back: '#665148',
    upper: '#332d32',
    light: '#dfbb81',
    frame: 0x483a32,
    glow: 0.64,
  },
  retail: { column: 1, back: '#716b5d', upper: '#3e4742', light: '#e5d2ac', frame: 0x333d38, glow: 0.44 },
  service: { column: 2, back: '#72817b', upper: '#3a4d51', light: '#c9d6c3', frame: 0x39454a, glow: 0.26 },
};
const solid = { x: 1008, y: displayTop + 104, w: 0, h: 0 };

function storefrontStyle({ id, kind }) {
  const roll =
    [...String(id)].reduce((hash, character) => Math.imul(hash, 31) + character.charCodeAt(0), 0) >>> 0;
  const hospitality = /^(restaurant|cafe|bar|pub|bakery|fast_food|ice_cream|pastry|deli|tea|coffee)$/.test(
    kind,
  );
  const service = /^(bank|pharmacy|hairdresser|beauty|dry_cleaning|massage|hotel|laundry|car_repair)$/.test(
    kind,
  );
  const interior = hospitality ? interiors.hospitality : service ? interiors.service : interiors.retail;
  return {
    interior,
    fascia: ['#293934', '#493b31', '#343f4a', '#603a40'][roll % 4],
    awning: hospitality && roll % 3 !== 0,
    pair: roll % 4 === 0,
    serif: hospitality && roll % 2 === 0,
  };
}

function paintInteriors(ctx) {
  for (const [kind, { column, back, upper, light }] of Object.entries(interiors)) {
    ctx.save();
    ctx.translate(column * signWidth, displayTop);
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = upper;
    ctx.fillRect(0, 0, 256, 18);
    ctx.fillRect(0, 79, 256, 17);
    ctx.fillStyle = light;
    for (const x of [36, 127, 216]) ctx.fillRect(x - 8, 18, 16, 3);
    if (kind === 'hospitality') {
      for (const x of [36, 127, 216]) ctx.fillRect(x - 1, 4, 2, 16);
      ctx.fillStyle = '#ab8769';
      ctx.fillRect(128, 60, 101, 5);
      ctx.fillStyle = '#45332b';
      ctx.fillRect(137, 65, 82, 24);
      for (const x of [17, 67]) {
        ctx.fillRect(x, 66, 38, 4);
        ctx.fillRect(x + 17, 70, 4, 19);
      }
    } else if (kind === 'retail') {
      ctx.fillStyle = '#453d33';
      for (const y of [47, 70]) {
        ctx.fillRect(14, y, 227, 4);
        for (let i = 0; i < 16; i++) {
          ctx.fillStyle = ['#947761', '#586c6b', '#c1a784', '#746964'][i % 4];
          const h = 6 + ((i * 7) % 14);
          ctx.fillRect(19 + i * 14, y - h, 9, h);
        }
        ctx.fillStyle = '#453d33';
      }
    } else {
      ctx.fillStyle = '#9fa9a2';
      for (const x of [18, 143]) ctx.fillRect(x, 25, 92, 36);
      ctx.fillStyle = '#586f68';
      for (const x of [30, 74, 157, 201]) ctx.fillRect(x, 27, 2, 32);
      ctx.fillStyle = '#42564c';
      ctx.fillRect(117, 59, 22, 23);
    }
    ctx.restore();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(solid.x - 8, solid.y - 8, 16, 16);
}

export function createStorefrontAppearance(scene) {
  let atlas, ctx, mesh;
  function init() {
    const canvas = document.createElement('canvas');
    canvas.width = atlasWidth;
    canvas.height = atlasHeight;
    ctx = canvas.getContext('2d');
    paintInteriors(ctx);
    atlas = new THREE.CanvasTexture(canvas);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.anisotropy = 2;
    const material = new THREE.MeshStandardNodeMaterial();
    const sampled = texture(atlas).rgb;
    const tint = attribute('color', 'vec3');
    const finish = attribute('frontageFinish', 'vec3');
    const night = smoothstep(0.18, 1.35, windowGlow);
    const display = mix(color(0x334f5d), sampled, night.mul(0.36).add(0.51));
    material.colorNode = mix(sampled.mul(tint), display, finish.z);
    material.emissiveNode = sampled.mul(finish.x).mul(night.mul(0.8).add(0.12));
    material.roughnessNode = finish.y;
    material.metalnessNode = finish.z.mul(0.18);
    mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.name = 'Nearby Calgary storefronts';
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  return {
    atlasBytes: Math.round(atlasWidth * atlasHeight * 4 * (4 / 3)),
    create(s, slot, grade) {
      if (!mesh) init();
      const style = storefrontStyle(s.place);
      const w = s.width;
      const h = Math.min(3.35, s.b.height - 0.65);
      const frame = style.interior.frame;
      const sign = {
        x: (slot % columns) * signWidth,
        y: Math.floor(slot / columns) * signHeight,
        w: signWidth,
        h: signHeight,
      };
      const window = { x: style.interior.column * signWidth, y: displayTop, w: signWidth, h: 96 };
      ctx.fillStyle = style.fascia;
      ctx.fillRect(sign.x, sign.y, sign.w, sign.h);
      ctx.strokeStyle = '#aa9c80';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sign.x + 7, sign.y + 5, sign.w - 14, sign.h - 10);
      let size = 24;
      const font = style.serif ? 'Georgia, serif' : 'system-ui, sans-serif';
      ctx.font = `600 ${size}px ${font}`;
      while (ctx.measureText(s.place.name).width > 222 && size > 12) {
        size -= 2;
        ctx.font = `600 ${size}px ${font}`;
      }
      ctx.fillStyle = '#f1e7d4';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.place.name, sign.x + sign.w / 2, sign.y + sign.h / 2, 222);
      const parts = [];
      const yaw = Math.atan2(s.nx, s.nz);
      const append = (geometry, tint, tile = solid, emit = 0, roughness = 0.86, glazing = 0) => {
        geometry.rotateY(yaw).translate(s.x + s.nx * 0.08, grade, s.z + s.nz * 0.08);
        const uv = geometry.attributes.uv;
        const tintValues = new Float32Array(uv.count * 3);
        const finish = new Float32Array(uv.count * 3);
        const c = new THREE.Color(tint);
        for (let i = 0; i < uv.count; i++) {
          const u = tile.w ? tile.x + 4 + uv.getX(i) * (tile.w - 8) : tile.x;
          const v = tile.h ? tile.y + 4 + (1 - uv.getY(i)) * (tile.h - 8) : tile.y;
          uv.setXY(i, u / atlasWidth, 1 - v / atlasHeight);
          c.toArray(tintValues, i * 3);
          finish.set([emit, roughness, glazing], i * 3);
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(tintValues, 3));
        geometry.setAttribute('frontageFinish', new THREE.BufferAttribute(finish, 3));
        parts.push(geometry);
      };
      const box = (x, y, z, width, height, depth, tint, pitch = 0) =>
        append(new THREE.BoxGeometry(width, height, depth).rotateX(pitch).translate(x, y, z), tint);
      const pane = (x, y, z, width, height, tile, emit, glazing) =>
        append(new THREE.PlaneGeometry(width, height).translate(x, y, z), 0xffffff, tile, emit, 0.4, glazing);
      box(0, h * 0.5, 0.046, w, h, 0.14, frame);
      box(0, 0.16, 0.17, w, 0.29, 0.15, 0x8f8573);
      const top = h - 0.65;
      const doorWidth = Math.min(1.38, w * 0.27);
      const left = -w / 2 + 0.17;
      const right = w / 2 - 0.17;
      const doorX = style.pair ? 0 : right - doorWidth / 2;
      const paneHeight = top - 0.42;
      const glassY = (top + 0.32) * 0.5;
      const bays = [[left, doorX - doorWidth / 2 - 0.1]];
      if (style.pair) bays.push([doorX + doorWidth / 2 + 0.1, right]);
      for (const [start, end] of bays) {
        const x = (start + end) / 2;
        const width = end - start;
        pane(x, glassY, 0.135, width, paneHeight, window, style.interior.glow, 1);
        box(x, 0.37, 0.19, width + 0.12, 0.1, 0.22, 0xa49880);
        box(x, top - 0.34, 0.169, width, 0.058, 0.06, frame);
        if (width > 2.6) box(x, glassY, 0.166, 0.058, paneHeight, 0.061, frame);
      }
      pane(doorX, glassY - 0.09, 0.139, doorWidth - 0.12, paneHeight + 0.18, window, 0.17, 1);
      for (const side of [-1, 1]) {
        box(doorX + (side * doorWidth) / 2, top * 0.5, 0.169, 0.081, top, 0.071, frame);
        box(side * (w * 0.5 - 0.073), h * 0.5, 0.16, 0.146, h, 0.12, frame);
      }
      box(doorX + doorWidth * 0.3, 1.02, 0.197, 0.05, 0.25, 0.067, 0xb5a58a);
      box(0, h - 0.28, 0.153, w - 0.2, 0.55, 0.13, frame);
      pane(0, h - 0.28, 0.221, w - 0.29, 0.46, sign, 0.22, 0);
      box(0, h - 0.019, 0.16, w + 0.04, 0.071, 0.25, 0xa69c87);
      if (style.awning && h > 3.05) {
        const cloth = new THREE.Color(style.fascia);
        box(0, h - 0.58, 0.38, w - 0.18, 0.05, 0.61, cloth, 0.29);
        box(0, h - 0.69, 0.67, w - 0.18, 0.12, 0.04, cloth);
      }
      const geometry = mergeStaticGeometries(parts);
      for (const part of parts) part.dispose();
      return geometry;
    },
    update(active, painted) {
      if (!mesh) return 0;
      if (painted) atlas.needsUpdate = true;
      mesh.geometry.dispose();
      mesh.visible = active.length > 0;
      mesh.geometry = active.length ? mergeStaticGeometries(active) : new THREE.BufferGeometry();
      return (mesh.geometry.index?.count ?? 0) / 3;
    },
  };
}
