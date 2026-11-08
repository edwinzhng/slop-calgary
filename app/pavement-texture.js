import * as THREE from 'three/webgpu';
import { color, float, max, mix, positionWorld, smoothstep, texture } from 'three/tsl';
import { seeded } from './geo.js';
import { gridLine } from './render-nodes.js';
import { cityUniforms } from './city-uniforms.js';

let pavement;
function pavementTexture() {
  if (pavement) return pavement;
  const size = 256;
  const random = seeded(17411);
  const octave = (cells) => {
    const lattice = Float32Array.from({ length: cells * cells }, random);
    const at = (x, y) => lattice[(y % cells) * cells + (x % cells)];
    return (u, v) => {
      const x = Math.floor(u * cells),
        y = Math.floor(v * cells);
      const a = u * cells - x,
        b = v * cells - y;
      const sx = a * a * (3 - 2 * a),
        sy = b * b * (3 - 2 * b);
      return THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(at(x, y), at(x + 1, y), sx),
        THREE.MathUtils.lerp(at(x, y + 1), at(x + 1, y + 1), sx),
        sy,
      );
    };
  };
  const broad = octave(8),
    patch = octave(23),
    wear = octave(48);
  // Utility cuts and small resurfaced strips live in the existing alpha channel.
  const repairs = [
    [0.21, 0.19, 0.053, 0.119, 0.04],
    [0.7, 0.78, 0.163, 0.039, -0.06],
    [0.56, 0.37, 0.048, 0.032, 0.12],
    [0.93, 0.58, 0.068, 0.024, -0.03],
  ];
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const u = ((i % size) + 0.5) / size,
      v = (Math.floor(i / size) + 0.5) / size;
    const p = i * 4;
    pixels[p] = 255 * (broad(u, v) * 0.64 + patch(u, v) * 0.36);
    pixels[p + 1] = 255 * (random() * 0.7 + wear(u, v) * 0.3);
    pixels[p + 2] = 255 * patch(u, v);
    let repair = 0;
    for (const [x, y, halfWidth, halfLength, skew] of repairs) {
      const dx = u - x;
      const dy = v - y;
      const edge = Math.max(Math.abs(dx + dy * skew) - halfWidth, Math.abs(dy - dx * skew) - halfLength);
      const brokenEdge = edge + (wear(u, v) - 0.5) * 0.011;
      if (brokenEdge < 0) repair = Math.max(repair, brokenEdge > -0.009 ? 0.94 : 0.46);
    }
    pixels[p + 3] = 255 * repair;
  }
  pavement = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  pavement.wrapS = pavement.wrapT = THREE.RepeatWrapping;
  pavement.generateMipmaps = true;
  pavement.minFilter = THREE.LinearMipmapLinearFilter;
  pavement.magFilter = THREE.LinearFilter;
  pavement.anisotropy = 4;
  pavement.name = 'Generated pavement grain';
  pavement.needsUpdate = true;
  return pavement;
}

export function createCompactPavementMaterial(kind) {
  const road = kind === 'asphalt';
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: road ? 0.89 : 0.92 });
  // A shared, repeatable grain mip chain replaces several fragment noise
  // graphs on the touch profile. Slab joints remain analytically filtered.
  const grain = texture(pavementTexture(), positionWorld.xz.div(road ? 26 : 14));
  const base = road
    ? mix(color(0x3d4145), color(0x66696d), grain.r.mul(0.7).add(grain.g.mul(0.3)))
    : mix(color(0x99958e), color(0xc4c0b5), grain.r.mul(0.78).add(grain.g.mul(0.22)));
  const seams = road
    ? float(0)
    : max(gridLine(positionWorld.x, 1.524, 0.007), gridLine(positionWorld.z, 1.524, 0.007));
  const wetness = cityUniforms.uRoadWetness;
  const damp = smoothstep(0.35, 0.72, grain.b).mul(wetness);
  mat.colorNode = base.mul(
    float(1)
      .sub(seams.mul(0.32))
      .sub(road ? grain.a.mul(0.42) : float(0))
      .sub(damp.mul(road ? 0.28 : 0.2)),
  );
  mat.roughnessNode = float(road ? 0.89 : 0.92).sub(damp.mul(0.31));
  return mat;
}
