import * as THREE from 'three/webgpu';
import { uniform, float, color, mix, sin, cos, positionWorld, smoothstep, abs } from 'three/tsl';

// Original animated shows informed by the physical fixtures. These are not
// recordings of Northern Lights or a live/calendar-accurate lighting schedule.
export const lightingUniforms = {
  time: uniform(0),
  towerA: uniform(new THREE.Color(0xe43e48)),
  towerB: uniform(new THREE.Color(0xffc78a)),
  brookfield: uniform(new THREE.Color(0xb7dcff)),
  reconciliation: uniform(new THREE.Color(0xffc995)),
};
const towerPalette = [0xe43e48, 0xf6c65b, 0x32b6ed, 0x8573e6, 0xf3efff];
const brookPalette = [0xb7dcff, 0xb7dcff, 0x6fa8f4, 0xa888e8, 0x74d7d3, 0xb7dcff];
const bridgePalette = [0xffc995, 0x77c9ef, 0xc390ef, 0x73d5ad, 0xe8f0ed];
const a = new THREE.Color(),
  b = new THREE.Color();
const smooth = (t) => t * t * (3 - 2 * t);
export function paletteCycle(seconds, palette, hold = 18, blend = 6, out = new THREE.Color()) {
  const duration = hold + blend,
    period = duration * palette.length;
  const t = ((seconds % period) + period) % period,
    slot = Math.floor(t / duration),
    local = t - slot * duration;
  a.setHex(palette[slot]);
  b.setHex(palette[(slot + 1) % palette.length]);
  return out.lerpColors(a, b, smooth(Math.max(0, Math.min(1, (local - hold) / blend))));
}
let lastColorTick = -1;
export function updateLandmarkLighting(seconds, reducedMotion = false) {
  const t = reducedMotion ? 0 : Math.max(0, seconds);
  lightingUniforms.time.value = t;
  const tick = Math.floor(t * 20);
  if (tick === lastColorTick) return;
  lastColorTick = tick;
  paletteCycle(t, towerPalette, 18, 6, lightingUniforms.towerA.value);
  paletteCycle(t + 8, towerPalette, 18, 6, lightingUniforms.towerB.value);
  paletteCycle(t + 9, brookPalette, 15, 7, lightingUniforms.brookfield.value);
  paletteCycle(t + 12, bridgePalette, 12, 8, lightingUniforms.reconciliation.value);
}

export function towerLightColor() {
  const t = lightingUniforms.time;
  const band = sin(positionWorld.y.mul(0.03).sub(t.mul(0.09)))
    .mul(0.5)
    .add(0.5);
  return mix(lightingUniforms.towerA, lightingUniforms.towerB, band);
}

export function brookfieldLightColor() {
  const t = lightingUniforms.time,
    dx = positionWorld.x.sub(411.55),
    dz = positionWorld.z.add(153.6);
  // A broad moving highlight travels around the curved crown, without moving
  // geometry, CPU per-fixture updates, or additional point lights.
  const heading = t.mul(0.12),
    sweep = dx
      .mul(cos(heading))
      .add(dz.mul(sin(heading)))
      .div(34);
  const patch = smoothstep(0.45, 0.95, sweep).mul(0.3);
  return lightingUniforms.brookfield.mul(float(0.75).add(patch));
}

export function telusLightColor() {
  const t = lightingUniforms.time,
    p = positionWorld;
  const curtain = sin(
    p.y
      .mul(0.052)
      .add(sin(p.x.mul(0.072).add(t.mul(0.15))).mul(2.4))
      .sub(t.mul(0.24)),
  );
  const drift = sin(p.y.mul(0.019).sub(p.x.mul(0.043)).add(t.mul(0.13)))
    .mul(0.5)
    .add(0.5);
  const aurora = mix(
    mix(color(0x24d9a5), color(0x3c74e9), curtain.mul(0.5).add(0.5)),
    color(0xb457e0),
    drift.mul(0.76),
  );
  const diagonal = sin(p.y.mul(0.085).add(p.x.mul(0.13)).sub(t.mul(0.27)))
    .mul(0.5)
    .add(0.5);
  const geometric = mix(color(0xf39d64), color(0x8175ef), smoothstep(0.25, 0.75, diagonal));
  const interlude = smoothstep(0.82, 0.99, sin(t.mul(0.075)));
  return mix(aurora, geometric, interlude).mul(float(0.72).add(abs(curtain).mul(0.28)));
}
