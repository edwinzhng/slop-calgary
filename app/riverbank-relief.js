import * as THREE from 'three/webgpu';
import { seeded } from './geo.js';

// Shore points come from the mapped water polygons. The cross sections are
// inferred in metres from the north-bank and RiverWalk reference photographs.
const reaches = [
  {
    name: 'North Bow grass and stone bank',
    water: 'osm-relation-7741236-0',
    ends: [
      [-723.1, -772.6],
      [-584.8, -894.9],
    ],
    direction: -1,
    side: -1,
    section: [
      [0, 0.09],
      [1.65, 0.19],
      [3.45, 0.46],
      [5.55, 0.52],
      [8.9, 0.08],
    ],
    colors: [0xa8a190, 0x73805d, 0x738448, 0x81934f],
  },
  {
    name: 'Simmons RiverWalk stone terraces',
    water: 'osm-way-134580524-0',
    ends: [
      [1518.9, -324.1],
      [1605.9, -267.3],
    ],
    direction: 1,
    side: 1,
    section: [
      [0, 0.09],
      [1.75, 0.24],
      [2.8, 0.24],
      [2.8, 0.42],
      [3.8, 0.42],
      [3.8, 0.6],
      [4.8, 0.6],
      [4.8, 0.78],
      [5.9, 0.78],
      [5.9, 0.96],
      [7.15, 0.96],
      [11.6, 0.08],
    ],
    colors: [
      0x9c9584, 0x758355, 0x707369, 0x8e9082, 0x6e7266, 0x99998a, 0x707369, 0x8e9082, 0x6e7266, 0x99998a,
      0x74824c,
    ],
    planting: [
      [1539, 1548],
      [1560, 1569],
      [1584, 1591],
    ],
  },
];

const mix = (a, b, t) => a + (b - a) * t;

export function buildRiverbankRelief(scene, waters) {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.96 });
  const banks = [];
  for (const reach of reaches) {
    const ring = waters.find((water) => water.id === reach.water)?.ring.slice(0, -1);
    if (!ring) continue;
    const [start, end] = reach.ends.map(([x, z]) => ring.findIndex((p) => p[0] === x && p[1] === z));
    if (start < 0 || end < 0) continue;
    const shore = [ring[start]];
    for (let at = start; at !== end;) {
      at = (at + reach.direction + ring.length) % ring.length;
      if (ring[at][0] <= shore.at(-1)[0]) break;
      shore.push(ring[at]);
    }
    if (shore.at(-1) !== ring[end]) continue;
    const points = [shore[0]];
    for (let i = 1; i < shore.length; i++) {
      const a = shore[i - 1],
        b = shore[i],
        count = Math.ceil((b[0] - a[0]) / 3);
      for (let j = 1; j <= count; j++) points.push([mix(a[0], b[0], j / count), mix(a[1], b[1], j / count)]);
    }
    const minX = points[0][0],
      maxX = points.at(-1)[0];
    const profile = (x, height) => mix(0.09, height, Math.min(1, (x - minX) / 9, (maxX - x) / 9));
    const positions = [],
      colors = [];
    const shades = reach.colors.map((paint) => new THREE.Color(paint).toArray());
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      for (let j = 1; j < reach.section.length; j++) {
        const vertex = ([x, z], [offset, y]) => [x, profile(x, y), z + reach.side * offset];
        const a0 = vertex(a, reach.section[j - 1]),
          b0 = vertex(b, reach.section[j - 1]);
        const a1 = vertex(a, reach.section[j]),
          b1 = vertex(b, reach.section[j]);
        if (reach.side === 1) positions.push(...a0, ...a1, ...b0, ...b0, ...a1, ...b1);
        else positions.push(...a0, ...b0, ...a1, ...b0, ...b1, ...a1);
        for (let k = 0; k < 6; k++) colors.push(...shades[j - 1]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = reach.name;
    mesh.receiveShadow = true;
    scene.add(mesh);
    banks.push({
      reach,
      points,
      minX,
      maxX,
      profile,
      keys: new Set(shore.slice(1, -1).map((p) => p.join(','))),
    });
  }

  const heightAt = (x, z) => {
    for (const { reach, points, minX, maxX, profile } of banks) {
      if (x < minX || x > maxX) continue;
      const i = points.findIndex(([px]) => px >= x);
      const a = points[Math.max(0, i - 1)],
        b = points[Math.max(1, i)];
      const t = (x - a[0]) / (b[0] - a[0]);
      const offset = reach.side * (z - mix(a[1], b[1], t));
      if (offset < 0 || offset > reach.section.at(-1)[0]) continue;
      for (let j = 1; j < reach.section.length; j++) {
        const [low, y0] = reach.section[j - 1],
          [high, y1] = reach.section[j];
        if (offset >= high || high === low) continue;
        const v = (offset - low) / (high - low);
        const a0 = profile(a[0], y0),
          b0 = profile(b[0], y0);
        const a1 = profile(a[0], y1),
          b1 = profile(b[0], y1);
        return t + v <= 1
          ? a0 + t * (b0 - a0) + v * (a1 - a0)
          : b1 + (1 - t) * (a1 - b1) + (1 - v) * (b0 - b1);
      }
      return profile(x, reach.section.at(-1)[1]);
    }
    return null;
  };

  const random = seeded(724);
  for (const { reach, points } of banks) {
    const details = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardNodeMaterial({ roughness: 0.96, flatShading: true }),
      (points.length - 1) * 8,
    );
    const transform = new THREE.Object3D(),
      tint = new THREE.Color();
    let slot = 0;
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1],
        b = points[j];
      for (let i = 0; i < 8; i++) {
        const t = random(),
          x = mix(a[0], b[0], t);
        const planting = i > 4 && reach.planting?.some(([start, end]) => x > start && x < end);
        const z =
          mix(a[1], b[1], t) + reach.side * (planting ? 3.6 + random() * 3.2 : 0.24 + random() * 1.42);
        const y = heightAt(x, z);
        if (y == null) continue;
        transform.position.set(x, y + (planting ? 0.15 : 0.025), z);
        transform.rotation.set(0, random() * 6.28, 0);
        if (planting)
          transform.scale.set(0.38 + random() * 0.34, 0.27 + random() * 0.25, 0.28 + random() * 0.42);
        else transform.scale.set(0.11 + random() * 0.24, 0.06 + random() * 0.12, 0.11 + random() * 0.22);
        transform.updateMatrix();
        details.setMatrixAt(slot, transform.matrix);
        details.setColorAt(
          slot++,
          tint
            .setHex(planting ? (i === 7 ? 0x7d8847 : 0x53673b) : 0xb4aa98)
            .multiplyScalar(0.65 + random() * 0.4),
        );
      }
    }
    details.count = slot;
    details.name = `${reach.name} / riprap and plants`;
    details.receiveShadow = true;
    scene.add(details);
  }
  return {
    heightAt,
    replacesEdge: (water, point) =>
      banks.some(({ reach, keys }) => reach.water === water && keys.has(point.join(','))),
  };
}
