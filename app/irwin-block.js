import * as THREE from 'three/webgpu';
import { mergeStaticGeometries } from './static-batches.js';

// Alberta heritage inventory and the dated Kensington storefront reference.
// The measured shell owns its massing and the ground-floor shopfronts are
// placed independently from the four upper windows.
export function addIrwinBlockFrontage(scene, shell, groundOffset = 0) {
  if (shell.userData.cityMesh?.id !== 'city-outline-28259-0' || !shell.userData.referenceWallTriangles)
    return;
  const pieces = [],
    yaw = Math.atan2(-0.99999654, 0.00263157),
    stone = 0xb49c7c,
    mortar = 0x8d5a45,
    sash = 0x434b47,
    glass = 0x52717c;
  function add(geometry, z, y, depth, tint) {
    const x = -967.86 + (z + 755) * 0.00263157;
    geometry.rotateY(yaw).translate(x - depth, y + groundOffset, z);
    const c = new THREE.Color(tint),
      colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pieces.push(geometry);
  }
  const box = (z, y, depth, w, h, d, tint) => add(new THREE.BoxGeometry(w, h, d), z, y, depth, tint);
  const arch = (z, y, depth, w, h, tint) => {
    const opening = new THREE.Shape();
    opening.moveTo(-w / 2, 0);
    opening.lineTo(w / 2, 0);
    opening.lineTo(w / 2, h - 0.22);
    opening.quadraticCurveTo(0, h + 0.21, -w / 2, h - 0.22);
    opening.closePath();
    add(new THREE.ShapeGeometry(opening, 8), z, y, depth, tint);
  };
  for (const z of [-752.9, -749.35, -745.77, -742.14]) {
    arch(z, 4.91, 0.04, 1.39, 2.29, mortar);
    arch(z, 5.03, 0.055, 1.21, 2.08, sash);
    arch(z, 5.13, 0.068, 1.02, 1.88, glass);
    box(z, 6.16, 0.093, 1.1, 0.074, 0.061, sash);
    box(z, 5.98, 0.092, 0.065, 1.78, 0.053, sash);
    box(z, 4.96, 0.106, 1.48, 0.12, 0.27, stone);
  }
  box(-747.42, 4.22, 0.07, 14.9, 0.17, 0.21, stone);
  // The roof datum steps down on the northern middle part of this compound.
  // Keep the ledge under both parapet heights and within the matched west wall.
  box(-747.42, 7.4, 0.055, 14.9, 0.115, 0.15, stone);
  const geometry = mergeStaticGeometries(pieces);
  for (const part of pieces) part.dispose();
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Irwin Block · arched sashes and stone courses';
  mesh.receiveShadow = true;
  scene.add(mesh);
}
