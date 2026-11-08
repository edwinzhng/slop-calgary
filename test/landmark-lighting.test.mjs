import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { paletteCycle, updateLandmarkLighting, lightingUniforms } from '../app/landmark-lighting.js';
const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
test('landmark colour changes remain continuous across the loop seam without strobing', () => {
  const palette = [0xff3020, 0x20aaff, 0x9c60ef];
  const period = 72;
  assert.ok(distance(paletteCycle(0, palette), paletteCycle(period, palette)) < 1e-8);
  let before = paletteCycle(0, palette);
  for (let t = 0.1; t < 150; t += 0.1) {
    const next = paletteCycle(t, palette);
    assert.ok(distance(next, before) < 0.08);
    assert.ok(next.toArray().every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
    before = next;
  }
});
test('night shows animate their shared uniforms while reduced motion freezes the display', () => {
  updateLandmarkLighting(10);
  const before = lightingUniforms.towerA.value.clone();
  const bridgeBefore = lightingUniforms.reconciliation.value.clone();
  updateLandmarkLighting(30);
  assert.ok(distance(before, lightingUniforms.towerA.value) > 0.2);
  assert.ok(distance(bridgeBefore, lightingUniforms.reconciliation.value) > 0.2);
  updateLandmarkLighting(10, true);
  const frozen = lightingUniforms.towerA.value.clone();
  const bridgeFrozen = lightingUniforms.reconciliation.value.clone();
  updateLandmarkLighting(40, true);
  assert.equal(lightingUniforms.time.value, 0);
  assert.ok(frozen.equals(lightingUniforms.towerA.value));
  assert.ok(bridgeFrozen.equals(lightingUniforms.reconciliation.value));
});
