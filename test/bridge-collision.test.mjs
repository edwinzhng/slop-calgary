import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createBridgeCollisionParts, slopingPrism } from '../app/bridge-collision.js';
import { createCameraCollision, footprintContact, movementBody } from '../app/camera-collision.js';
import { SpatialIndex, bounds } from '../app/geo.js';

test('bridge slab clearance follows the slope rather than a flat nominal deck plane', () => {
  const slab = slopingPrism([0, 0], [20, 0], 6, 1, 5, -0.58, 0.15, 'sloping deck');
  assert.ok(Math.abs(slab.heightAt(10, 0) - 3.15) < 1e-8);
  const buildingIndex = new SpatialIndex(20);
  buildingIndex.insert(slab, bounds(slab.ring));
  const camera = createCameraCollision({ buildingIndex, groundHeight: () => 0.2 });
  assert.equal(camera.blocked(new THREE.Vector3(16, 2, 0), 0.24), false, 'below actual raised deck is clear');
  assert.equal(camera.blocked(new THREE.Vector3(4, 1.7, 0), 0.24), true, 'sloping underside blocks the lens');
});

test('visible bridge side rails block sideways travel while leaving the centre and underside open', () => {
  const parts = createBridgeCollisionParts({
    plans: [
      {
        name: 'Test bridge',
        points: [
          [0, 0],
          [0, 30],
        ],
        length: 30,
        width: 6,
        level: 5.4,
        approaches: [],
      },
    ],
  });
  const body = movementBody('walk', 0),
    contact = {};
  assert.ok(parts.barriers.length > 4);
  assert.ok(parts.barriers.some((b) => footprintContact(b, 2.8, 5.4, 15, body, contact)));
  assert.ok(parts.barriers.every((b) => !footprintContact(b, 0, 5.4, 15, body, contact)));
  assert.ok(parts.barriers.every((b) => !footprintContact(b, 2.8, 0.2, 15, body, contact)));
  assert.ok(parts.slabs.every((b) => b.ring.flat().every(Number.isFinite)));
});
