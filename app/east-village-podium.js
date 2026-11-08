import * as THREE from 'three/webgpu';
import { color, float, floor, fract, fwidth, mix, smoothstep, uv, vec2 } from 'three/tsl';
import { windowGlow } from './city-uniforms.js';
import { filteredPulse, hash2D } from './render-nodes.js';

export const SUPERSTORE_PODIUM_ID = 'city-outline-28536-0';
export const SUPERSTORE_PLACE_ID = 'osm-node-7578776948';

function podiumMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.44, metalness: 0.18 });
  const panel = uv().div(vec2(1.65, 0.45));
  const seam = (axis) => filteredPulse(fract(axis), 0.023, 0.977, fwidth(axis).max(0.0001));
  const rows = seam(panel.y);
  const frame = seam(panel.x);
  const y = uv().y;
  const interLevel = float(1).sub(smoothstep(0.37, 0.49, y.sub(4.55).abs()));
  const fascia = smoothstep(8.15, 8.27, y).max(interLevel);
  const bulkhead = smoothstep(0.25, 0.38, y);
  const glass = frame.mul(bulkhead);
  const warmInterior = color(0xd3aa70);
  const tint = hash2D(vec2(floor(panel.x), floor(y.div(4.55))));
  const ceiling = smoothstep(0.07, 0.23, y.sub(3.58).abs()).mul(smoothstep(0.07, 0.23, y.sub(7.45).abs()));
  const pane = mix(
    mix(color(0x416777), color(0x87a2a9), smoothstep(0.7, 7.5, y)).mul(tint.mul(0.13).add(0.94)),
    color(0xb4a487),
    float(1).sub(ceiling).mul(0.19),
  );
  const variation = hash2D(vec2(floor(panel.x), floor(panel.y)))
    .mul(0.12)
    .add(0.94);
  const cladding = mix(
    mix(color(0x694338), color(0xa66a4f).mul(variation), rows),
    color(0x645e58),
    smoothstep(11.9, 12.2, y),
  );
  const trim = mix(color(0x424647), color(0x9b9f98), bulkhead);
  mat.colorNode = mix(mix(trim, pane, glass), cladding, fascia);
  mat.roughnessNode = mix(mix(float(0.55), float(0.19), glass), 0.66, fascia);
  mat.emissiveNode = warmInterior.mul(glass).mul(float(1).sub(fascia)).mul(windowGlow).mul(0.075);
  return mat;
}

// Observed 6 Avenue and lower 4 Street walls of the City podium. The source
// mesh also owns tower geometry, roof terraces and several adjacent shops.
export function splitSuperstorePodium(geometry, record, groundOffset = 0) {
  if (
    record?.id !== SUPERSTORE_PODIUM_ID ||
    record.structureIds?.length !== 1 ||
    record.structureIds[0] !== 2396775 ||
    record.indexCount !== 3135 ||
    geometry.index
  )
    return null;
  const { position, normal } = geometry.attributes;
  const shell = [],
    facade = [],
    normals = [],
    coords = [];
  for (let i = 0; i < position.count; i += 3) {
    const x = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const z = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
    const nx = normal.getX(i),
      nz = normal.getZ(i);
    const bottom = Math.min(position.getY(i), position.getY(i + 1), position.getY(i + 2)) - groundOffset;
    const top = Math.max(position.getY(i), position.getY(i + 1), position.getY(i + 2)) - groundOffset;
    const streetFace = (nz > 0.76 && z > -174 && x >= 1175) || (nx > 0.76 && x > 1298 && z > -219);
    if (Math.abs(normal.getY(i)) > 0.3 || !streetFace || bottom > 9.5 || top > 20) {
      shell.push(i, i + 1, i + 2);
      continue;
    }
    for (let j = i; j < i + 3; j++) {
      const px = position.getX(j),
        y = position.getY(j),
        pz = position.getZ(j);
      facade.push(px, y, pz);
      normals.push(normal.getX(j), normal.getY(j), normal.getZ(j));
      coords.push((px - 1240) * nz - (pz + 170) * nx, y - groundOffset);
    }
  }
  if (!facade.length) return null;
  geometry.setIndex(shell);
  const finish = new THREE.BufferGeometry();
  finish.setAttribute('position', new THREE.Float32BufferAttribute(facade, 3));
  finish.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  finish.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  return finish;
}

export function addSuperstorePodium(scene, finish, groundOffset = 0) {
  const mesh = new THREE.Mesh(finish, podiumMaterial());
  mesh.name = '5th & Third / Superstore podium finish';
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  if (typeof document === 'undefined') return;

  const ray = new THREE.Raycaster(
    new THREE.Vector3(1286, 7.08 + groundOffset, -157),
    new THREE.Vector3(0, 0, -1),
  );
  const [wall] = ray.intersectObject(mesh);
  if (!wall) return;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 104;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4eae1';
  ctx.font = 'bold 35px system-ui';
  ctx.fillText('REAL CANADIAN', 256, 35);
  ctx.fillStyle = '#ef4c44';
  ctx.font = '900 60px system-ui';
  ctx.fillText('SUPERSTORE', 256, 93);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(10.9, 2.18),
    new THREE.MeshBasicNodeMaterial({ map, alphaTest: 0.42 }),
  );
  sign.name = 'Real Canadian Superstore fascia lettering';
  sign.position.copy(wall.point).addScaledVector(wall.face.normal, 0.08);
  sign.rotation.y = Math.atan2(wall.face.normal.x, wall.face.normal.z);
  scene.add(sign);
}

// OpenStreetMap relation 21113398 v1, projected to the city frame. The
// 2020 City mesh includes Arris East and the podium, preceding West.
const arrisWestRing = [
  [1200.52, -205.03],
  [1203.21, -205.03],
  [1204.54, -212.65],
  [1170.22, -219.24],
  [1170.31, -216.21],
  [1169.35, -216.41],
  [1169.27, -214.74],
  [1171.07, -202.43],
  [1171.46, -199.75],
  [1169.3, -199.75],
  [1170.44, -192.86],
  [1168.22, -192.9],
  [1169.7, -187.15],
  [1167.64, -187.37],
  [1167.35, -177.68],
  [1199.44, -175.79],
  [1202.99, -185.84],
  [1198.66, -187.26],
];
export function addArrisWest(scene, groundOffset = 0) {
  const lower = 14.05 + groundOffset;
  // CTBUH records the 142 m architectural top. The stepped parapet and
  // balcony envelopes follow the architect's elevations at game resolution.
  const top = 142 + groundOffset;
  const outline = arrisWestRing.map(([x, z]) => new THREE.Vector2(x, z));
  if (!THREE.ShapeUtils.isClockWise(outline)) outline.reverse();
  const positions = [],
    coords = [];
  const push = ([x, z], y, u) => {
    positions.push(x, y, z);
    coords.push(u, y - lower);
  };
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i],
      b = outline[(i + 1) % outline.length],
      width = a.distanceTo(b);
    const cap = (v) => top - (v.y > -185 ? 1.6 : 0) - (v.x < 1172 ? 1.8 : 0);
    push(a.toArray(), lower, 0);
    push(b.toArray(), lower, width);
    push(a.toArray(), cap(a), 0);
    push(b.toArray(), lower, width);
    push(b.toArray(), cap(b), width);
    push(a.toArray(), cap(a), 0);
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  walls.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  walls.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.32, roughness: 0.26 });
  const bays = uv().div(vec2(1.52, 3.24));
  const pane = (axis, lo, hi) => filteredPulse(fract(axis), lo, hi, fwidth(axis).max(0.0001));
  const glazing = pane(bays.x, 0.021, 0.979).mul(pane(bays.y, 0.09, 0.96));
  const occupancy = hash2D(floor(bays));
  const glass = mix(color(0x36546a), color(0x657f90), occupancy.mul(0.36).add(0.25));
  material.colorNode = mix(color(0x9aa6ac), glass, glazing);
  const windowDetail = float(1).sub(smoothstep(0.18, 0.7, fwidth(bays.y)));
  material.emissiveNode = color(0xffcf99)
    .mul(glazing)
    .mul(occupancy.greaterThan(0.8))
    .mul(windowDetail)
    .mul(windowGlow)
    .mul(0.22);
  const shell = new THREE.Mesh(walls, material);
  shell.name = 'Arris West / folded curtain wall';
  shell.castShadow = shell.receiveShadow = true;
  scene.add(shell);

  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x89979d, roughness: 0.64, metalness: 0.24 });
  const roof = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape(outline.map(({ x, y }) => new THREE.Vector2(x, -y))))
      .rotateX(-Math.PI / 2)
      .translate(0, top - 4.3, 0),
    metal,
  );
  roof.name = 'Arris West / inset roof';
  scene.add(roof);
  const balcony = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), metal, 38);
  balcony.name = 'Arris West / staggered balcony slabs';
  balcony.castShadow = balcony.receiveShadow = true;
  const transform = new THREE.Object3D();
  for (let floor = 0; floor < balcony.count; floor++) {
    const progress = floor / (balcony.count - 1);
    transform.position.set(1178.4 + progress * 10.6, lower + 2.1 + floor * 3.24, -177.34 + progress * 0.61);
    transform.rotation.y = -0.059 + (progress - 0.5) * 0.07;
    transform.scale.set(11.4, 0.2, 2.28);
    transform.updateMatrix();
    balcony.setMatrixAt(floor, transform.matrix);
  }
  scene.add(balcony);
  return {
    id: 'osm-relation-21113398',
    name: 'Arris West',
    ring: arrisWestRing,
    minHeight: lower,
    height: top,
    storefrontAnchor: false,
  };
}
