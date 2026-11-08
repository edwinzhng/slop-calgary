import * as THREE from 'three/webgpu';
import { color, positionWorld, mix, sin, smoothstep } from 'three/tsl';
import { windowGlow } from './city-uniforms.js';
import { towerLightColor } from './landmark-lighting.js';

// CVU/CTBUH: 190.8 m to tip, observation level 157.6 m. The operator
// identifies SKY360 at 155 m. The white roof and flared drum follow its
// published elevation/photographs; remaining profile radii are estimates.
export const CALGARY_TOWER_PROFILE = Object.freeze({
  tip: 190.8,
  observation: 157.6,
  restaurant: 155,
  roof: 171.1,
  shaftTop: 139,
  podBase: 148,
  podTop: 163.2,
  rimRadius: 17.1,
});

export function buildCalgaryTower({
  beginAt,
  add,
  cylinder,
  beam,
  box,
  replace,
  collision,
  ellipse,
  materials,
}) {
  beginAt('Calgary Tower', 613.25, 165.6, 190.8, 17.3);
  const glow = smoothstep(0.08, 1.3, windowGlow);
  const shaft = new THREE.MeshStandardNodeMaterial({ color: 0xbfbcb0, roughness: 0.87 });
  const wash = towerLightColor();
  shaft.emissiveNode = wash.mul(glow).mul(0.38);
  materials.towerShaft = shaft;
  const roof = new THREE.MeshStandardNodeMaterial({ color: 0xd9ddd9, roughness: 0.54, metalness: 0.18 });
  roof.emissiveNode = wash.mul(glow).mul(0.7);
  materials.towerRoof = roof;
  const glazing = new THREE.MeshStandardNodeMaterial({ color: 0x172d36, roughness: 0.16, metalness: 0.62 });
  glazing.emissiveNode = color(0xe0c08a).mul(glow).mul(0.25);
  materials.towerGlass = glazing;

  cylinder(4.65, 7.1, 139, 0, 69.5, 0, shaft, 96);
  cylinder(9, 7.1, 2.2, 0, 1.1, 0, shaft, 64);
  const lathe = (profile, material, segments = 96) =>
    add(
      new THREE.LatheGeometry(
        profile.map(([r, y]) => new THREE.Vector2(r, y)),
        segments,
      ),
      material,
    );
  lathe(
    [
      [4.65, 137.5],
      [4.8, 139],
      [5.7, 141],
      [7.6, 143.1],
      [10.5, 145.3],
      [14.2, 147.4],
      [14.5, 148],
    ],
    roof,
  );
  // The drum tapers outwards toward its roof. Two dark panoramic bands
  // interrupt the red panels; the roof is white, not another red cylinder.
  const radius = (y) => 14.5 + ((y - 148) / 15.2) * 1.35;
  for (const [low, high, material] of [
    [148, 151.4, materials.red],
    [151.4, 155.4, glazing],
    [155.4, 158, materials.red],
    [158, 161.1, glazing],
    [161.1, 163.2, materials.red],
  ])
    cylinder(radius(high), radius(low), high - low, 0, (low + high) / 2, 0, material, 96);
  cylinder(17.1, 16.2, 0.8, 0, 163.6, 0, roof, 96);
  lathe(
    [
      [16.9, 164],
      [16.6, 164.6],
      [15.5, 165.9],
      [13.7, 167.3],
      [11.2, 168.7],
      [8.4, 169.9],
      [5.6, 170.7],
      [3.1, 171.1],
      [0, 171.1],
    ],
    roof,
  );
  for (let i = 0; i < 64; i++) {
    const a = (i * Math.PI) / 32,
      c = Math.cos(a),
      s = Math.sin(a);
    beam([c * 14.6, 148.1, s * 14.6], [c * 15.93, 163.15, s * 15.93], 0.065, materials.red, 4);
    beam([c * 4.8, 139, s * 4.8], [c * 14.4, 147.8, s * 14.4], 0.035, roof, 4);
    const points = [
      [16.95, 164.2],
      [15.5, 165.9],
      [13.7, 167.3],
      [11.2, 168.7],
      [8.4, 169.9],
      [5.6, 170.7],
    ];
    for (let j = 1; j < points.length; j++)
      beam(
        [c * points[j - 1][0], points[j - 1][1], s * points[j - 1][0]],
        [c * points[j][0], points[j][1], s * points[j][0]],
        0.021,
        materials.steel,
        4,
      );
  }
  // The rooftop cauldron and long, narrow lattice mast account for almost
  // twenty metres above the dome; the old model put that height in the pod.
  cylinder(3.25, 2.35, 3.7, 0, 173.0, 0, materials.dark, 48);
  cylinder(0.08, 0.15, 16.1, 0, 182.75, 0, materials.steel, 12);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    beam([Math.cos(a) * 0.75, 174.85, Math.sin(a) * 0.75], [0, 190.8, 0], 0.045, materials.steel, 5);
    for (let y = 176; y < 189; y += 2.3) {
      const r = (0.75 * (190.8 - y)) / 15.95,
        r2 = (0.75 * (190.8 - y - 2.3)) / 15.95,
        b = a + (Math.PI * 2) / 3;
      beam(
        [Math.cos(a) * r, y, Math.sin(a) * r],
        [Math.cos(b) * r2, y + 2.3, Math.sin(b) * r2],
        0.027,
        materials.steel,
        4,
      );
    }
  }
  // The small north-facing glass-floor box is an exterior extension.
  box(4.3, 2.5, 1.45, 0, 158.9, -16.5, glazing);
  replace(ellipse(17.2, 17.2, 64));
  collision(ellipse(7.2, 7.2, 48), 139);
  collision(ellipse(14.5, 14.5, 64), 148, 139);
  collision(ellipse(16.4, 16.4, 64), 164, 148);
  collision(ellipse(17.1, 17.1, 64), 171.1, 164);
  collision(ellipse(3.3, 3.3, 24), 174.85, 171.1);
  collision(ellipse(0.8, 0.8, 12), 190.8, 174.85);
}
