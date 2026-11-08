import * as THREE from 'three/webgpu';
import {
  abs,
  cameraPosition,
  color,
  dot,
  vec2,
  float,
  normalWorldGeometry,
  normalize,
  positionWorld,
  uv,
  floor,
  fract,
  fwidth,
  max,
  mix,
  smoothstep,
} from 'three/tsl';
import { windowGlow } from './city-uniforms.js';
import { hash2D, filteredPulse, bumpNormal } from './render-nodes.js';
import { brookfieldLightColor } from './landmark-lighting.js';
import { KING_EDDY_DETAIL } from './king-eddy-detail.js';

export function kingEddyBrick() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0.015 });
  const row = positionWorld.y.div(0.075),
    column = uv()
      .x.mul(72 / 0.23)
      .add(fract(floor(row).mul(0.5)).mul(0.5)),
    fw = max(fwidth(row), fwidth(column)).max(0.0001),
    detail = float(1).sub(smoothstep(0.1, 0.7, fw)),
    brick = filteredPulse(fract(row), 0.07, 0.94, fwidth(row).max(0.0001)).mul(
      filteredPulse(fract(column), 0.035, 0.965, fwidth(column).max(0.0001)),
    ),
    variation = hash2D(vec2(floor(column), floor(row)))
      .sub(0.5)
      .mul(0.1)
      .mul(detail),
    buff = mix(color(0xb7ad92), color(0xc5b58e).mul(variation.add(1)), mix(float(0.85), brick, detail)),
    cornice = smoothstep(KING_EDDY_DETAIL.corniceBase, KING_EDDY_DETAIL.corniceBase + 0.045, positionWorld.y);
  // Photo colour families, not calibrated reflectance. The height band follows
  // the low hotel only; neighbouring measured ceramic vessels retain their glaze.
  mat.colorNode = mix(buff, color(0x343b40), cornice);
  mat.normalNode = bumpNormal(float(1).sub(brick).mul(-0.001).mul(detail).mul(float(1).sub(cornice)));
  mat.userData.kingEddyObservedBrick = true;
  return mat;
}

export function studioBellCeramic({ bronze = false } = {}) {
  // Royal Tichelaar specifies 34 × 14.8 cm tiles, semi-matt graphite/bronze
  // glazes: tichelaar.com/projects/129/studio-bell-calgary. The observed exterior
  // has upright rectangular courses, not the former large diamond checker.
  // Joint width, palette and reflectance remain approximate.
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.38,
    metalness: 0.3,
  });
  const tile = uv().div(vec2(0.148, 0.34));
  const fw = fwidth(tile).max(0.0001);
  const body = filteredPulse(fract(tile.x), 0.016, 0.984, fw.x).mul(
    filteredPulse(fract(tile.y), 0.016, 0.984, fw.y),
  );
  const sample = hash2D(floor(tile));
  const detail = float(1).sub(smoothstep(0.15, 0.8, max(fw.x, fw.y)));
  const view = abs(dot(normalWorldGeometry, normalize(cameraPosition.sub(positionWorld))));
  const wall = float(1).sub(smoothstep(0.4, 0.76, abs(normalWorldGeometry.y)));
  const glaze = mix(
    color(bronze ? 0x63564e : 0x535d66),
    color(bronze ? 0x907d69 : 0x7d8791),
    smoothstep(0.09, 0.92, view).mul(0.68).add(0.12),
  ).mul(float(1).add(sample.sub(0.5).mul(0.18).mul(detail)));
  mat.colorNode = mix(color(0x5f656a), mix(color(bronze ? 0x504237 : 0x404a57), glaze, body), wall);
  mat.roughnessNode = mix(float(0.65), float(0.29).add(sample.mul(0.12).mul(detail)), body.mul(wall));
  mat.normalNode = bumpNormal(float(1).sub(body).mul(-0.0014).mul(detail).mul(wall));
  return mat;
}

export function brookfieldCrownMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x96afb9, roughness: 0.35, metalness: 0.24 });
  const height = smoothstep(232.8, 247, positionWorld.y);
  const light = brookfieldLightColor().mul(height.mul(0.2).add(0.85));
  mat.emissiveNode = light.mul(smoothstep(0.08, 1.4, windowGlow)).mul(1.65);
  return mat;
}

export function architecturalLED(hex = 0x91cdff, strength = 2) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x657c88, roughness: 0.6, metalness: 0.2 });
  mat.emissiveNode = color(hex)
    .mul(smoothstep(0.08, 1.4, windowGlow))
    .mul(strength);
  mat.userData.noShadow = true;
  return mat;
}
