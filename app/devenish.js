import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, float, floor, fract, fwidth, mix, smoothstep, uv, vec2 } from 'three/tsl';
import { cityUniforms, windowGlow } from './city-uniforms.js';
import { filteredPulse, hash2D } from './render-nodes.js';

const id = 'city-outline-27541-0';
const owners = '1428108,1428107,1428113,1428110,1428112';

function frontageMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.91 });
  const height = uv().y,
    course = height.div(0.083),
    courseRow = floor(course),
    brick = uv().x.div(0.238).add(courseRow.mod(2).mul(0.5)),
    mortar = filteredPulse(fract(course), 0.075, 0.925, fwidth(course).max(0.001)).mul(
      filteredPulse(fract(brick), 0.036, 0.964, fwidth(uv().x).div(0.238).max(0.001)),
    ),
    masonry = mix(color(0x93735d), color(0xb04e32), mortar),
    variation = hash2D(vec2(floor(brick), courseRow)),
    grain = float(1).sub(smoothstep(0.22, 1, fwidth(course))),
    stone = color(0xc1b6a0),
    groundBand = float(1).sub(smoothstep(1.68, 1.81, height)),
    cornice = smoothstep(13.45, 13.67, height).mul(float(1).sub(smoothstep(14.11, 14.23, height)));
  material.colorNode = mix(
    masonry.mul(variation.sub(0.5).mul(grain).mul(0.17).add(1)),
    stone,
    groundBand.max(cornice),
  ).mul(float(1).sub(cityUniforms.uRoadWetness.mul(0.12)));
  return material;
}

// Alberta Register 4664-0259 and the property owner's 17 Avenue and 8 Street
// photographs. Only the matched City compound owns these observed wall faces.
export function addDevenishFrontage(scene, shell, record, groundOffset = 0) {
  if (
    record?.id !== id ||
    record.structureIds?.join(',') !== owners ||
    record.indexCount !== 1977 ||
    shell.index
  )
    return null;
  const base = 0.23 + groundOffset;
  const { position, normal } = shell.attributes;
  const retained = [],
    walls = [],
    normals = [],
    coords = [];
  for (let i = 0; i < position.count; i += 3) {
    const x = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const z = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
    const nx = normal.getX(i),
      nz = normal.getZ(i);
    const exposed =
      (nz > 0.45 && z > 871 && x < -703) || (nx > 0.5 && x > -709) || (nz < -0.55 && z < 865 && x > -781);
    if (!exposed || Math.abs(normal.getY(i)) > 0.4) {
      retained.push(i, i + 1, i + 2);
      continue;
    }
    for (let j = i; j < i + 3; j++) {
      const px = position.getX(j),
        y = position.getY(j),
        pz = position.getZ(j);
      walls.push(px, y, pz);
      normals.push(normal.getX(j), normal.getY(j), normal.getZ(j));
      coords.push((px + 744) * nz - (pz - 868) * nx, y - base);
    }
  }
  if (!walls.length || !retained.length) return null;
  shell.setIndex(retained);
  const facade = new THREE.BufferGeometry();
  facade.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
  facade.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  facade.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  const masonry = new THREE.Mesh(facade, frontageMaterial());
  masonry.name = 'The Devenish / brick and sandstone on surveyed walls';
  masonry.castShadow = masonry.receiveShadow = true;
  scene.add(masonry);

  const pieces = [],
    colliders = [];
  const sandstone = 0xcac2aa,
    sill = 0xaea48e,
    paint = 0xddd8bd,
    black = 0x282b2c;
  const add = (geometry, tint, luminous = 0) => {
    const colours = new Float32Array(geometry.attributes.position.count * 3),
      glass = new Float32Array(colours.length / 3);
    const tintColor = new THREE.Color(tint);
    for (let i = 0; i < glass.length; i++) tintColor.toArray(colours, i * 3);
    glass.fill(luminous);
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('displayGlow', new THREE.BufferAttribute(glass, 1));
    pieces.push(geometry);
  };
  const ray = new THREE.Raycaster(),
    up = new THREE.Vector3(0, 1, 0);
  const mount = (edge, station, h) => {
    const south = edge === 'south',
      east = edge === 'east';
    ray.set(
      new THREE.Vector3(east ? -697 : station, base + h, east ? station : south ? 882 : 851),
      new THREE.Vector3(east ? -1 : 0, 0, east ? 0 : south ? -1 : 1),
    );
    ray.far = 17;
    const hit = ray.intersectObject(masonry)[0];
    if (!hit || Math.abs(hit.face.normal.y) > 0.4) return null;
    const yaw = east ? Math.PI / 2 : south ? -0.043 : Math.PI - 0.043;
    const axis = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const outward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    return {
      yaw,
      at: (u, y, depth) =>
        hit.point.clone().addScaledVector(axis, u).addScaledVector(outward, depth).addScaledVector(up, y),
    };
  };
  const box = (m, u, y, d, w, h, l, tint, glow = 0, tilt = 0) => {
    add(
      new THREE.BoxGeometry(w, h, l)
        .rotateX(tilt)
        .rotateY(m.yaw)
        .translate(...m.at(u, y, d)),
      tint,
      glow,
    );
  };
  const window = (edge, station, h, w, ht, { awning = false, shop = false } = {}) => {
    const m = mount(edge, station, h);
    if (!m) return;
    box(m, 0, 0, 0.051, w + 0.12, ht + 0.11, 0.1, paint);
    box(m, 0, 0, 0.112, w - 0.075, ht - 0.08, 0.04, black);
    for (const side of [-1, 1]) {
      const blue = side === 1 ? 0x446273 : 0x526e79;
      box(m, side * w * 0.246, 0.025, 0.137, w * 0.45, ht - 0.17, 0.012, blue, shop ? 1 : 0.16);
    }
    box(m, 0, 0, 0.154, w - 0.07, 0.075, 0.021, paint);
    box(m, 0, -ht * 0.5 - 0.08, 0.107, w + 0.31, 0.135, 0.29, sill);
    box(m, 0, ht * 0.5 + 0.11, 0.09, w + 0.36, 0.24, 0.23, sandstone);
    if (awning) {
      box(m, 0, ht * 0.42, 0.43, w + 0.22, 0.045, 0.91, black, 0, -0.49);
      box(m, 0, ht * 0.42 - 0.21, 0.83, w + 0.2, 0.13, 0.045, black);
    }
  };
  // The photographed bays are irregular, including the recessed entry
  // landings. Project each window back onto the retained survey planes.
  const southBays = [
    [-706.2, 1.3],
    [-711.2, 2.08],
    [-716.8, 1.55],
    [-721.15, 1.6],
    [-733.15, 1.54],
    [-737.3, 1.65],
    [-742.25, 2.03],
    [-746.2, 1.61],
    [-751.5, 1.65],
    [-755.7, 1.63],
    [-764.95, 1.7],
    [-769.6, 2.05],
    [-774.9, 1.6],
  ];
  for (const [x, width] of southBays) {
    window('south', x, 0.94, width * 0.82, 0.89, { shop: true });
    window('south', x, 3.39, width, 2.12, { awning: true, shop: true });
    window('south', x, 7.36, width, 2.27);
    window('south', x, 11.55, width, 2.19);
  }
  for (const x of [-711.5, -718.1, -722.6, -733, -738.1, -745, -749.1, -754.7, -766.8, -771.1, -776.7]) {
    window('north', x, 3.47, 1.53, 2.13, { awning: true, shop: true });
    window('north', x, 7.42, 1.56, 2.23);
    window('north', x, 11.53, 1.61, 2.19);
  }
  for (const z of [861.87, 874.53]) {
    window('east', z, 3.47, 1.14, 2.1, { awning: true, shop: true });
    window('east', z, 7.52, 1.2, 2.22);
    window('east', z, 11.52, 1.18, 2.16);
  }
  for (const z of [865.05, 867.28, 869.54, 871.77]) window('east', z, 3.34, 2.16, 2.65, { shop: true });

  // The wide 8 Street display sits beneath the two rounded balconies.
  // Model a handful of colourful display silhouettes between its glazing bars.
  for (const [z, tint, skirt] of [
    [864.45, 0x407688, false],
    [865.62, 0x827ca7, true],
    [867.35, 0xb12b61, true],
    [869.18, 0x36555b, false],
    [871.11, 0xbb4e6b, false],
  ]) {
    const m = mount('east', z, 3.03);
    if (!m) continue;
    box(m, 0, -0.95, 0.174, 0.55, 0.12, 0.13, 0xa1a292, 0.18);
    for (const u of [-0.11, 0.11]) box(m, u, -0.58, 0.177, 0.13, 0.64, 0.12, tint, 0.28);
    add(
      new THREE.CylinderGeometry(0.23, skirt ? 0.36 : 0.16, skirt ? 0.85 : 0.54, 7)
        .scale(1, 1, 0.23)
        .rotateY(m.yaw)
        .translate(...m.at(0, skirt ? -0.19 : 0, 0.197)),
      tint,
      0.42,
    );
    for (const u of [-0.24, 0.24]) box(m, u, 0.08, 0.178, 0.105, 0.49, 0.093, tint, 0.18);
    add(
      new THREE.SphereGeometry(0.111, 7, 5)
        .scale(1, 1.3, 0.48)
        .rotateY(m.yaw)
        .translate(...m.at(0, 0.44, 0.207)),
      0xc8c9bc,
      0.26,
    );
  }

  // Layered sandstone above the pilasters, with the stepped ends left in the survey shell.
  for (const [x, w] of [
    [-706.7, 4.7],
    [-714.9, 7.5],
    [-721.6, 4.5],
    [-727.7, 6.2],
    [-735.2, 6.7],
    [-742.8, 7.5],
    [-750.6, 6.9],
    [-759.6, 8.4],
    [-769.0, 9.5],
  ]) {
    const m = mount('south', x, 13.91);
    if (!m) continue;
    box(m, 0, -0.13, 0.124, w, 0.17, 0.29, sill);
    box(m, 0, 0.045, 0.148, w + 0.06, 0.12, 0.37, sandstone);
    box(m, 0, 0.166, 0.154, w + 0.11, 0.11, 0.39, paint);
  }

  const balcony = (edge, station, height, width, depth, curved = false) => {
    const m = mount(edge, station, height);
    if (!m) return;
    const front = (u) => depth + (curved ? 0.67 * (1 - (u / (width * 0.5)) ** 2) : 0);
    const n = curved ? 10 : 4;
    for (let j = 0; j < n; j++) {
      const a = -width / 2 + (j * width) / n,
        b = a + width / n,
        mid = (a + b) / 2;
      const projection = front(mid);
      box(m, mid, -0.12, projection * 0.5, width / n + 0.018, 0.25, projection, sill);
      box(m, mid, -0.015, projection - 0.038, width / n + 0.025, 0.11, 0.16, sandstone);
      box(m, mid, 0.73, projection - 0.048, width / n + 0.025, 0.1, 0.14, sandstone);
    }
    const count = Math.floor(width / 0.23);
    for (let i = 0; i <= count; i++) {
      const u = width * (i / count - 0.5);
      const stem = new THREE.LatheGeometry(
        [
          new THREE.Vector2(0.067, 0),
          new THREE.Vector2(0.054, 0.12),
          new THREE.Vector2(0.075, 0.22),
          new THREE.Vector2(0.04, 0.43),
          new THREE.Vector2(0.05, 0.66),
        ],
        5,
      ).translate(...m.at(u, 0.035, front(u) - 0.06));
      add(stem, sandstone);
    }
    for (const u of [-width * 0.34, width * 0.34])
      box(m, u, -0.57, depth * 0.35, 0.27, 0.16, depth * 0.75, sill, 0, 0.6);
    const ring = [
      [-width / 2, 0],
      [width / 2, 0],
      [width / 2, front(width / 2)],
      [0, front(0)],
      [-width / 2, front(-width / 2)],
    ].map(([u, d]) => {
      const p = m.at(u, 0, d);
      return [p.x, p.z];
    });
    ring.push(ring[0]);
    colliders.push({
      id: `devenish-${edge}-${station}-${height}`,
      ring,
      minHeight: base + height - 0.21,
      height: base + height + 0.79,
      storefrontAnchor: false,
    });
    return m;
  };
  for (const [x, w, d] of [
    [-727.5, 5.75, 2.75],
    [-760.6, 3.65, 2.0],
  ]) {
    for (const h of [5.42, 9.51]) balcony('south', x, h, w, d);
    const entry = mount('south', x, 2.35);
    if (entry) {
      box(entry, 0, -0.41, 0.14, 2.51, 3.0, 0.2, black);
      for (const u of [-w * 0.42, w * 0.42]) {
        add(
          new THREE.CylinderGeometry(0.185, 0.22, 4.38, 9).translate(...entry.at(u, -0.06, d - 0.25)),
          sandstone,
        );
        box(entry, u, -1.93, d - 0.25, 0.53, 0.65, 0.53, sill);
        const c = entry.at(u, 0, d - 0.25);
        const ring = Array.from({ length: 9 }, (_, i) => [
          c.x + Math.sin((i * Math.PI) / 4) * 0.255,
          c.z + Math.cos((i * Math.PI) / 4) * 0.255,
        ]);
        colliders.push({
          id: `devenish-column-${x}-${u}`,
          ring,
          minHeight: base,
          height: base + 4.65,
          storefrontAnchor: false,
        });
      }
    }
  }
  for (const h of [5.05, 9.12]) balcony('east', 867.95, h, 8.3, 1.34, true);

  const relief = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.78 });
  relief.emissiveNode = color(0xe4aa69).mul(attribute('displayGlow')).mul(windowGlow).mul(0.28);
  const detail = new THREE.Mesh(mergeGeometries(pieces), relief);
  detail.name = 'The Devenish / bay windows, awnings and bracketed balconies';
  detail.receiveShadow = true;
  scene.add(detail);
  for (const p of pieces) p.dispose();

  const banner = mount('south', -741.5, 7.0);
  if (banner && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e2120';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e3e0cc';
    ctx.textAlign = 'center';
    ctx.font = 'bold 21px Georgia';
    ctx.fillText('SHOPPES AT THE', 192, 40);
    ctx.font = 'bold 54px Georgia';
    ctx.fillText('DEVENISH', 192, 96);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.07),
      new THREE.MeshStandardNodeMaterial({ map, side: THREE.DoubleSide }),
    );
    sign.position.copy(banner.at(0, 0, 0.76));
    sign.rotation.set(0, banner.yaw + Math.PI / 2, -Math.PI / 2);
    scene.add(sign);
  }
  return {
    colliders,
    triangles: (detail.geometry.index?.count ?? detail.geometry.attributes.position.count) / 3,
  };
}
