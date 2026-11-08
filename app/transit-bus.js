import * as THREE from 'three/webgpu';
import { createCelActorMaterial } from './materials.js';
import { box, combine, painted } from './travel-geometry.js';
import { roundedBox } from '../js/vehicles.js';

export function createCityBuses(scene, capacity = 18) {
  const white = 0xe4e6e3,
    red = 0xb52b3a,
    silver = 0xa0aaa8,
    glass = 0x2b4950,
    black = 0x263338;
  const parts = [
    painted(roundedBox(1.28, 1.24, 11.96, 0.21, 0.08).translate(0, 1.75, 0), white),
    box(0, 0.43, 0, 2.31, 0.44, 11.7, black),
    box(0, 3.04, -1.4, 1.7, 0.18, 2.7, silver),
    box(0, 2.16, 6.015, 2.23, 0.94, 0.05, glass),
    box(0, 2.76, 5.995, 1.63, 0.23, 0.045, black),
    box(0, 2.76, 6.02, 1.24, 0.054, 0.012, 0xf4aa43),
    box(0, 1.3, 6.012, 2.49, 0.29, 0.07, red),
    box(0, 1.34, -6.01, 2.49, 0.55, 0.08, red),
    box(0, 2.24, -6.015, 1.89, 0.74, 0.05, glass),
  ];
  for (const side of [-1, 1]) {
    parts.push(box(side * 1.282, 1.24, 0, 0.018, 0.46, 11.92, red));
    parts.push(box(side * 1.291, 1.48, 0, 0.018, 0.048, 11.88, 0xe8824d));
    parts.push(box(side * 1.3, 1.76, -4.56, 0.019, 0.42, 2.65, red).rotateX(-side * 0.14));
    for (const z of [-4.85, -3.35, -1.85, -0.35, 1.15, 2.65, 4.15]) {
      const door = side < 0 && (z === -1.85 || z === 4.15);
      parts.push(box(side * 1.291, door ? 1.58 : 2.22, z, 0.023, door ? 1.87 : 0.82, 1.34, glass));
      if (door) parts.push(box(side * 1.306, 1.58, z, 0.018, 1.86, 0.045, black));
    }
    for (const z of [-3.55, 3.45]) {
      parts.push(
        painted(
          new THREE.CylinderGeometry(0.49, 0.49, 0.32, 12)
            .rotateZ(Math.PI / 2)
            .translate(side * 1.11, 0.49, z),
          black,
        ),
      );
      parts.push(
        painted(
          new THREE.CylinderGeometry(0.3, 0.3, 0.045, 10)
            .rotateZ(Math.PI / 2)
            .translate(side * 1.284, 0.49, z),
          silver,
        ),
      );
    }
    parts.push(
      box(side * 1.35, 2.25, 5.64, 0.24, 0.11, 0.12, black),
      box(side * 1.51, 2.19, 5.64, 0.18, 0.31, 0.14, black),
      box(side * 0.95, 0.86, 6.034, 0.41, 0.17, 0.05, 0xf3ead1),
      box(side * 0.97, 1.03, -6.04, 0.2, 0.32, 0.04, 0xdc3135),
    );
  }
  const geometry = combine(
    parts.map((part) => {
      if (!part.index) return part;
      const flat = part.toNonIndexed();
      part.dispose();
      return flat;
    }),
  );
  const mesh = new THREE.InstancedMesh(geometry, createCelActorMaterial(), capacity);
  mesh.name = 'Calgary Transit 40-foot city buses';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
