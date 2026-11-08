import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import { createCivilianPlayer } from '../app/civilian-player.js';
import { createWalkingSupport } from '../app/walk-support.js';
import { buildRecentDevelopments, DEVELOPMENT_MANIFEST, bmoWorld } from '../app/recent-developments.js';

const state = () => ({
  mode: 'walk',
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  speed: 0,
  velocityX: 0,
  velocityZ: 0,
  grounded: true,
  verticalSpeed: 0,
  cameraDistance: 5,
  cameraView: 'chase',
  throttle: 1,
  steering: 0,
});

test('grounded BMO stair contact remains locomotion when footprint support leads the centre tread', async () => {
  const data = JSON.parse(await readFile(new URL('../data/calgary.json', import.meta.url), 'utf8')),
    development = buildRecentDevelopments(new THREE.Scene(), data),
    bmo = DEVELOPMENT_MANIFEST.sites.find((site) => site.id === 'bmo-centre-2024'),
    floor = (x, z, hint) => {
      const y = development.surfaceHeight(x, z);
      return y != null && (!Number.isFinite(hint) || y <= hint + 0.65) ? y : 0.31;
    },
    support = createWalkingSupport({ groundHeight: floor, stepColliders: development.colliders }),
    player = createCivilianPlayer(),
    s = state();
  let leadingFrames = 0,
    contactFrames = 0;
  try {
    s.y = 0.31;
    for (let frame = 0; frame <= 350; frame++) {
      const [x, z] = bmoWorld(bmo, 162.5, 130 - frame * 0.1),
        [nextX, nextZ] = bmoWorld(bmo, 162.5, 129.9 - frame * 0.1);
      s.x = x;
      s.z = z;
      s.y = support(x, z, s.y);
      s.speed = 6;
      s.heading = Math.atan2(nextX - x, nextZ - z);
      s.velocityX = (nextX - x) * 60;
      s.velocityZ = (nextZ - z) * 60;
      player.updateWalk(1 / 60, s, (px, pz) => floor(px, pz, s.y));
      assert.ok(
        player.rig.feet.every(({ ay }) => Math.abs(ay - s.y) < 0.75),
        `Frame ${frame}, support ${s.y}, centre ${floor(x, z, s.y)}, ankles ${player.rig.feet.map(({ ay }) => ay)}`,
      );
      if (frame > 20 && s.y > floor(x, z, s.y) + 0.03) {
        leadingFrames++;
        if (player.rig.feet.some((foot) => !foot.swing)) contactFrames++;
      }
    }
    assert.ok(leadingFrames > 150, 'exercise the real footprint-before-centre stair case');
    assert.ok(contactFrames / leadingFrames > 0.1, `${contactFrames}/${leadingFrames} contact frames`);
    assert.equal(s.y, 11.4);
  } finally {
    player.dispose();
    development.dispose();
  }
});
