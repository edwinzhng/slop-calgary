import * as THREE from 'three/webgpu';
import polygonClipping from 'polygon-clipping';
import { seeded } from './geo.js';

// Original paintings on surveyed walls. The addresses and wall orientations
// are references to the city's street art, not reproductions of that art.
export const MURALS = [
  [
    'city-outline-27918-0',
    [1427344, 1376102, 1427290, 1427292, 1427343],
    840,
    [784.95, 4.5, -530.27],
    [1, 0],
    9,
    5,
    'Paper lanterns',
  ],
  ['city-outline-26663-0', [1001293], 126, [49.84, 3.7, 576.98], [0, -1], 9.2, 5.6, 'Wildflowers'],
  ['city-outline-27264-0', [1376555], 225, [595.67, 43.2, 301.55], [1, 0], 17, 75, 'Chinook'],
  ['city-outline-27243-0', [1376632], 39, [2192.94, 2.2, 324.2], [-0.933, -0.36], 16.5, 5.4, 'Elbow River'],
  ['city-outline-27138-0', [1006301], 162, [-472.41, 4, 357], [1, 0], 14, 5, 'Switchbacks'],
  [
    'city-outline-28255-0',
    [1552054, 1552053],
    267,
    [-1149.01, 4.1, -706.62],
    [-0.952, 0.306],
    12,
    6.4,
    'Magpies',
  ],
  ['city-outline-26619-0', [1352575], 1077, [87.07, 7.2, 241.07], [0, 1], 38, 9.4, 'Prairie sky'],
  ['city-outline-28458-0', [1593082], 747, [1515, 4.3, -152.7], [0, 1], 10, 5, 'River refrains'],
];

const targets = new Map(MURALS.map((mural, index) => [mural[0], { mural, index }]));
const TILE = 256;
const SIDE = 3;
const EDGE = 4;

function paint(ctx, i, name) {
  const palettes = [
    ['#26354e', '#edb76e', '#dd5557', '#6abdb5', '#f9dfaa'],
    ['#304959', '#b3cb83', '#e1aa6b', '#c789bc', '#f4dfbb'],
    ['#282943', '#527eab', '#df6b67', '#f3b85e', '#f5dbb5'],
    ['#113c46', '#48a6a5', '#df8d66', '#91c5a7', '#e8d69b'],
    ['#263d58', '#558b97', '#ed8866', '#e8bc62', '#f8e3b3'],
    ['#3c535e', '#6c9a91', '#cf9b73', '#e8cdb4', '#f0e4ce'],
    ['#293754', '#6e87ae', '#dd736b', '#edb96b', '#f8dca9'],
    ['#3d394f', '#527f89', '#b05f8b', '#e5a56e', '#eed2a5'],
  ];
  const [ink, cool, warm, accent, light] = palettes[i];
  const rng = seeded(38 + i * 217);
  const rect = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const shape = (points, color) => {
    ctx.beginPath();
    for (const [j, [x, y]] of points.entries()) j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  const oval = (x, y, rx, ry, rotation, color) => {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };
  rect(0, 0, TILE, TILE, ink);
  if (i === 0) {
    for (const [x, y, color] of [
      [42, 121, warm],
      [89, 160, cool],
      [128, 89, accent],
      [173, 150, warm],
      [216, 105, cool],
    ]) {
      rect(x - 0.8, 10, 1.6, y - 10, light);
      oval(x, y, 24, 37, 0, color);
      oval(x, y, 14, 37, 0, light);
      oval(x, y, 10, 36, 0, color);
      for (const cap of [y - 36, y + 33]) rect(x - 10, cap, 20, 4, ink);
      rect(x - 1, y + 37, 2, 13, light);
    }
  } else if (i === 1) {
    for (let j = 0; j < 19; j++) {
      const x = 18 + rng() * 220,
        y = 33 + rng() * 170,
        bend = 14 - rng() * 28;
      ctx.strokeStyle = cool;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + bend, 255);
      ctx.quadraticCurveTo(x - bend, (255 + y) / 2, x, y);
      ctx.stroke();
      for (let k = 0; k < 5; k++) {
        const a = k * ((Math.PI * 2) / 5);
        oval(x + Math.cos(a) * 7, y + Math.sin(a) * 7, 7, 3.9, a, [warm, light, accent][j % 3]);
      }
      oval(x, y, 3.8, 3.8, 0, ink);
    }
  } else if (i === 2) {
    for (let j = 0; j < 6; j++) {
      ctx.strokeStyle = [cool, warm, accent, light, warm, cool][j];
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(j * 28 - 36, 273);
      ctx.bezierCurveTo(305 - j * 27, 197, -125 + j * 21, 95, 66 + j * 25, -18);
      ctx.stroke();
    }
    for (const [x, y, r] of [
      [53, 48, 19],
      [201, 113, 30],
      [58, 200, 24],
    ]) {
      oval(x, y, r, r * 0.46, 0, light);
      oval(x, y, r * 0.66, r * 0.29, 0, ink);
    }
  } else if (i === 4 || i === 6) {
    oval(170, 65, 47, 45, 0, warm);
    oval(170, 65, 34, 33, 0, accent);
    shape(
      [
        [0, 169],
        [51, 90],
        [77, 124],
        [119, 57],
        [192, 160],
        [223, 125],
        [256, 152],
        [256, 256],
        [0, 256],
      ],
      cool,
    );
    shape(
      [
        [88, 109],
        [119, 57],
        [166, 123],
        [122, 103],
        [109, 119],
        [112, 95],
      ],
      light,
    );
    shape(
      [
        [0, 183],
        [56, 151],
        [82, 166],
        [127, 147],
        [173, 181],
        [216, 147],
        [256, 162],
        [256, 256],
        [0, 256],
      ],
      ink,
    );
    for (let j = 0; j < 5; j++) {
      const y = 185 + j * 15;
      shape(
        [
          [0, y],
          [65, y + 9],
          [156, y - 12],
          [256, y - 1],
          [256, y + 4],
          [157, y - 7],
          [67, y + 15],
          [0, y + 5],
        ],
        [cool, warm, accent][j % 3],
      );
    }
  } else if (i === 5) {
    oval(141, 92, 75, 76, 0, warm);
    for (const [x, y, angle] of [
      [84, 108, -0.52],
      [173, 139, 0.33],
    ]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      shape(
        [
          [-74, 1],
          [-33, -10],
          [-10, 0],
          [6, -16],
          [22, -11],
          [39, -4],
          [24, 1],
          [8, 22],
          [-24, 17],
        ],
        ink,
      );
      shape(
        [
          [-27, 4],
          [-3, -36],
          [13, 6],
          [-7, 19],
        ],
        light,
      );
      oval(18, -8, 2, 2, 0, light);
      ctx.restore();
    }
    for (let j = 0; j < 11; j++)
      shape(
        [
          [j * 25, 255],
          [j * 25 + 15, 187 + rng() * 38],
          [j * 25 + 7, 255],
        ],
        cool,
      );
  } else {
    for (let j = 0; j < 7; j++) {
      ctx.strokeStyle = [cool, accent, light][j % 3];
      ctx.lineWidth = 4 + (j % 3);
      ctx.beginPath();
      ctx.moveTo(-8, 45 + j * 26);
      ctx.bezierCurveTo(66, -25 + j * 28, 185, 143 + j * 26, 266, 48 + j * 26);
      ctx.stroke();
    }
    for (const [x, y, a] of [
      [68, 111, -0.38],
      [153, 151, 0.42],
      [206, 82, -0.29],
    ]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      shape(
        [
          [-22, 0],
          [-46, -17],
          [-43, 17],
        ],
        warm,
      );
      oval(0, 0, 26, 13, 0, warm);
      oval(7, 2, 14, 6, 0, accent);
      oval(16, -4, 2, 2, 0, ink);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 0.14;
  for (let j = 0; j < 520; j++) rect(rng() * TILE, rng() * TILE, 0.8 + rng() * 3, 0.9, j % 3 ? ink : light);
  ctx.globalAlpha = 1;
  rect(0, TILE - 21, TILE, 21, ink);
  ctx.fillStyle = light;
  ctx.font = 'bold 9px system-ui';
  ctx.fillText(name.toUpperCase(), 9, TILE - 8);
}

export function muralGeometry(geometry, definition, index, offset = 0) {
  const [, owners, count, [x, base, z], [nx, nz], width, height] = definition;
  const source = geometry.userData.cityMesh?.structureIds;
  const p = geometry.attributes.position;
  if (p.count !== count || source?.length !== owners.length || !owners.every((id, i) => source[i] === id))
    return null;
  const front = new THREE.Vector3(nx, 0, nz).normalize();
  const origin = new THREE.Vector3(x, base + offset, z);
  const ray = new THREE.Raycaster(
    origin.clone().addScaledVector(front, 1.25),
    front.clone().negate(),
    0,
    2.5,
  );
  const wall = ray.intersectObject(new THREE.Mesh(geometry, probeMaterial))[0];
  if (!wall || Math.abs(wall.face.normal.y) > 0.045 || front.dot(wall.face.normal) < 0.97) return null;
  const n = wall.face.normal,
    right = new THREE.Vector3(n.z, 0, -n.x).normalize();
  const up = n.clone().cross(right);
  const centre = wall.point;
  const normal = geometry.attributes.normal;
  const point = new THREE.Vector3();
  const positions = [],
    uv = [];
  const clip = [
    [
      [-width / 2, -height / 2],
      [width / 2, -height / 2],
      [width / 2, height / 2],
      [-width / 2, height / 2],
      [-width / 2, -height / 2],
    ],
  ];
  for (let i = 0; i < p.count; i += 3) {
    if (point.fromBufferAttribute(normal, i).dot(n) < 0.998) continue;
    const triangle = [];
    for (let j = 0; j < 3; j++) {
      point.fromBufferAttribute(p, i + j).sub(centre);
      if (Math.abs(point.dot(n)) > 0.024) break;
      triangle.push([point.dot(right), point.dot(up)]);
    }
    if (triangle.length !== 3) continue;
    triangle.push(triangle[0]);
    for (const [ring] of polygonClipping.intersection([triangle], clip))
      for (let j = 1; j < ring.length - 2; j++)
        for (const [u, v] of [ring[0], ring[j], ring[j + 1]]) {
          point.copy(centre).addScaledVector(right, u).addScaledVector(up, v).addScaledVector(n, 0.018);
          positions.push(...point.toArray());
          uv.push(
            ((index % SIDE) * TILE + EDGE + (u / width + 0.5) * (TILE - EDGE * 2)) / (TILE * SIDE),
            1 -
              (Math.floor(index / SIDE) * TILE + EDGE + (0.5 - v / height) * (TILE - EDGE * 2)) /
                (TILE * SIDE),
          );
        }
  }
  if (!positions.length) return null;
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  result.computeVertexNormals();
  return result;
}

const probeMaterial = new THREE.MeshBasicMaterial();

export function createCityMurals(scene) {
  let material;
  const painted = [];
  return {
    painted,
    add(building, geometry, offset) {
      const target = targets.get(building.id);
      if (!target || typeof document === 'undefined') return;
      const { mural, index } = target;
      const art = muralGeometry(geometry, mural, index, offset);
      if (!art) return;
      if (!material) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = TILE * SIDE;
        const ctx = canvas.getContext('2d');
        for (const [i, definition] of MURALS.entries()) {
          ctx.save();
          ctx.translate((i % SIDE) * TILE, Math.floor(i / SIDE) * TILE);
          ctx.beginPath();
          ctx.rect(0, 0, TILE, TILE);
          ctx.clip();
          paint(ctx, i, definition[7]);
          ctx.restore();
        }
        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = 4;
        material = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.97 });
      }
      const mesh = new THREE.Mesh(art, material);
      mesh.name = `Calgary mural / ${mural[7]}`;
      mesh.receiveShadow = true;
      scene.add(mesh);
      painted.push(mural[7]);
    },
  };
}
