import * as THREE from 'three/webgpu';
import { bounds, inPolygon } from './geo.js';
import { cityUniforms } from './city-uniforms.js';
import { color, mix } from 'three/tsl';

const sample = (x, z, salt) => {
  let value = Math.imul(x + salt, 0x85ebca6b) ^ Math.imul(z + salt * 13, 0xc2b2ae35);
  value = Math.imul(value ^ (value >>> 16), 0x27d4eb2d);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
};

export function addIslandPlanting(
  scene,
  habitat,
  { inWater, paved, roadIndex, buildingIndex, groundHeight },
) {
  if (!habitat) return { trees: [], shrubs: 0 };
  const trees = [],
    shrubs = [],
    { minX, minZ, maxX, maxZ } = bounds(habitat.rings.flatMap((area) => area.ring));
  const clear = (x, z, radius) => {
    if (!habitat.rings.some((area) => inPolygon(x, z, area)) || paved(x, z) || inWater(x, z)) return false;
    if ([...buildingIndex.near(x, z)].some((part) => inPolygon(x, z, part))) return false;
    const route = roadIndex.nearest(x, z, false, 8);
    return !route || route.distance > route.width / 2 + radius;
  };
  // The City inventory omits the island's natural trees. Approximate groves
  // from the park plan, retaining the exposed tip, Rise, channels and plaza.
  for (let row = 0; minZ + row * 7 < maxZ; row++)
    for (let column = 0; minX + column * 7 < maxX; column++) {
      const x = minX + (column + 0.2 + sample(column, row, 7) * 0.6) * 7,
        z = minZ + (row + 0.2 + sample(column, row, 11) * 0.6) * 7,
        variety = sample(column, row, 19);
      const rise = ((x - 2120) / 42) ** 2 + ((z + 166) / 34) ** 2 < 1;
      const plaza = x > 2450 && z < 27;
      const gallery = x > 2155 && x < 2400 && z < -74;
      const wetland = x > 2220 && x < 2460 && z >= -74;
      const young = x > 1840 && x < 2100 && z < -176;
      const threshold = gallery ? 0.73 : young ? 0.52 : wetland ? 0.24 : 0.15;
      if (!rise && !plaza && variety < threshold && clear(x, z, gallery ? 3.0 : 2.5)) {
        const willow = wetland || sample(column, row, 29) < 0.13,
          aspen = !willow && sample(column, row, 33) < (gallery ? 0.17 : 0.51);
        trees.push({
          id: `island-grove-${column}-${row}`,
          source: 'inferred-island-planting',
          x,
          z,
          genus: willow ? 'SALIX' : 'POPULUS',
          species: willow ? 'BEBBIANA' : aspen ? 'TREMULOIDES' : 'BALSAMIFERA',
          matureSize: gallery && !willow ? 'LARGE' : willow ? 'SMALL' : 'MEDIUM',
          dbh: (gallery && !willow ? 34 : 8) + sample(column, row, 39) * (gallery ? 43 : 24),
        });
      } else if (!rise && !plaza && sample(column, row, 43) < (wetland ? 0.74 : 0.33) && clear(x, z, 0.85)) {
        shrubs.push({ x, z, wetland, size: 0.55 + sample(column, row, 53) * 0.75, variety });
      }
    }
  if (shrubs.length) {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.96 });
    material.colorNode = mix(color(0x87995a), color(0xe4e9df), cityUniforms.uSnow.mul(0.85));
    const mesh = new THREE.InstancedMesh(geometry, material, shrubs.length * 3);
    const shape = new THREE.Object3D(),
      tint = new THREE.Color(),
      palette = [0xa9ad6e, 0x8d9c78, 0x748357, 0xb0a371];
    for (const [index, { x, z, wetland, size, variety }] of shrubs.entries())
      for (let i = 0; i < 3; i++) {
        const angle = variety * 6.283 + i * 2.4,
          px = x + Math.cos(angle) * size * 0.42,
          pz = z + Math.sin(angle) * size * 0.42;
        shape.position.set(px, groundHeight(px, pz) + size * 0.34, pz);
        shape.rotation.y = angle;
        shape.scale.set(size * (wetland ? 0.45 : 0.68), size * (0.45 + i * 0.08), size * 0.5);
        shape.updateMatrix();
        mesh.setMatrixAt(index * 3 + i, shape.matrix);
        mesh.setColorAt(index * 3 + i, tint.setHex(palette[(index + i) % palette.length]));
      }
    mesh.name = 'St. Patrick’s Island willow and wetland understory';
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
  }
  return { trees, shrubs: shrubs.length };
}
