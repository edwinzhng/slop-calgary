import test from 'node:test';
import assert from 'node:assert/strict';
import { R8_SPEC } from '../app/player-car.js';
import { buildCarGeometry, buildSteerableWheelGeo } from '../js/cars.js';
import { movementBody } from '../app/camera-collision.js';

test('R8 geometry has a low two-door silhouette, published length/wheelbase and finite separate wheels', () => {
  const body = buildCarGeometry(R8_SPEC, false);
  body.computeBoundingBox();
  const box = body.boundingBox;
  assert.ok(body.attributes.position.array.every(Number.isFinite));
  assert.ok(Math.abs(box.max.z - box.min.z - 4.429) < 0.001);
  assert.equal(R8_SPEC.wheelZ * 2, 2.65);
  assert.ok(box.max.y > 1.15 && box.max.y < 1.3);
  assert.equal(R8_SPEC.handles.length, 1, 'one door handle per side');
  const collider = movementBody('drive', 0);
  assert.ok(collider.hz >= Math.max(-box.min.z, box.max.z));
  assert.ok(collider.top >= box.max.y);
  for (const side of [-1, 1]) {
    const wheel = buildSteerableWheelGeo(R8_SPEC, side);
    wheel.computeBoundingBox();
    assert.ok(wheel.attributes.position.array.every(Number.isFinite));
    assert.ok(Math.abs(wheel.boundingBox.max.z - wheel.boundingBox.min.z - 0.67) < 0.002);
    assert.ok(
      Math.abs(wheel.boundingBox.max.y + wheel.boundingBox.min.y) < 0.001,
      'wheel spins around its own axle',
    );
    wheel.dispose();
  }
  body.dispose();
});
