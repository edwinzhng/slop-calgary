import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bounds, SpatialIndex } from '../app/geo.js';
import { createActorFootFloor } from '../app/actor-foot-floor.js';
import { createCanElevationRoofs } from '../app/copc-roofs.js';
import { createCivilianPlayer } from '../app/civilian-player.js';
import { createPlayerBicycle } from '../app/player-bicycle.js';

const rectangle = (a, b, c, d) => [
  [a, b],
  [c, b],
  [c, d],
  [a, d],
];
const indexedWorld = (solids, groundHeight = () => 0.2) => {
  const buildingIndex = new SpatialIndex(8);
  for (const solid of solids) buildingIndex.insert(solid, bounds(solid.ring));
  return { buildingIndex, groundHeight };
};

test('grounded foot probes follow real sloping tops while preserving courtyard holes and roof edges', () => {
  const world = indexedWorld([
      {
        ring: rectangle(-4, -4, 4, 4),
        holes: [rectangle(-0.5, -0.5, 0.5, 0.5)],
        height: 12.4,
        minHeight: 0,
        heightAt: (x) => 12 + x * 0.1,
      },
    ]),
    floor = createActorFootFloor(world, { x: 1, z: 0, y: 12.1, grounded: true });
  assert.equal(floor(1, 0), 12.1);
  assert.equal(floor(2, 0), 12.2, 'use the measured/local top callback, not the maximum envelope');
  assert.equal(floor(-1, 0), 11.9);
  assert.equal(floor(0, 0), 0.2, 'a courtyard opening supplies no invented roof support');
  assert.equal(floor(5, 0), 0.2, 'an actual edge/gap releases the foot contact');
});

test('street walkers, airborne actors and tread probes retain their existing floor layer', () => {
  const world = indexedWorld([{ ring: rectangle(-4, -4, 4, 4), height: 12, minHeight: 11.82 }]);
  assert.equal(createActorFootFloor(world, { x: 0, z: 0, y: 0.2, grounded: true })(0, 0), 0.2);
  assert.equal(createActorFootFloor(world, { x: 0, z: 0, y: 12.1, grounded: false })(0, 0), 0.2);
  const treadWorld = indexedWorld([], (x, _z, hint) => {
    assert.equal(hint, 2);
    return x > 0 ? 2 : 1.82;
  });
  const tread = createActorFootFloor(treadWorld, { x: 0, z: 0, y: 2, grounded: true });
  assert.equal(tread(0.1, 0), 2);
  assert.equal(tread(-0.1, 0), 1.82, 'leading-foot stair support must not flatten individual treads');
});

test('the civilian player poses uphill, in a jump, and on the bike using one shared mesh', () => {
  const player = createCivilianPlayer(),
    bike = createPlayerBicycle(),
    floor = (_x, z) => 4 + 0.07 * z,
    state = { x: 45, z: 25, y: 0, heading: 0, grounded: true, cameraView: 'chase', cameraDistance: 5 };
  for (let frame = 0; frame < 120; frame++) {
    state.z += 5.4 / 60;
    state.y = floor(state.x, state.z);
    player.updateWalk(1 / 60, state, floor);
    for (const { ax: x, ay: y, az: z } of player.rig.feet) {
      assert.ok(Math.abs(x - state.x) < 0.4 && Math.abs(z - state.z) < 1);
      assert.ok(y > floor(x, z) && y < floor(x, z) + 0.6);
    }
  }
  assert.ok(Math.abs(player.rig.speed - 2.7) < 0.01);
  assert.equal(player.group.children.length, 1);
  state.grounded = false;
  state.y += 1;
  player.updateWalk(1 / 60, state, floor);
  assert.ok(player.rig.feet.every(({ ax, ay, az }) => ay > floor(ax, az) + 0.8));

  bike.group.position.set(45, 10, 36);
  player.updateRide(0, bike, state);
  assert.equal(player.group.children[0].count, 1);
  player.updateRide(0, bike, { ...state, cameraView: 'first' });
  assert.equal(player.group.visible, false);
  player.dispose();
  bike.dispose();
});

test('the civilian retains planted contacts on an actual measured pitched roof above the street', async () => {
  const [manifest, rawRoofs] = await Promise.all([
      readFile(new URL('../data/calgary-copc-roofs.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../data/calgary-copc-roofs.bin', import.meta.url)),
    ]),
    roofs = createCanElevationRoofs(
      manifest,
      rawRoofs.buffer.slice(rawRoofs.byteOffset, rawRoofs.byteOffset + rawRoofs.byteLength),
    ),
    id = 'city-outline-25071-0',
    record = roofs.get(id),
    world = indexedWorld(roofs.collisionParts(id)),
    player = createCivilianPlayer();
  assert.ok(record?.roofOnly, 'the source-proven tent keeps its measured gable and open underside');
  const state = {
    mode: 'walk',
    x: record.centroid[0] - 6,
    z: record.centroid[1] + 2,
    y: 0,
    heading: Math.PI / 2,
    speed: 1.5,
    velocityX: 1.5,
    velocityZ: 0,
    grounded: true,
    verticalSpeed: 0,
    cameraDistance: 5,
    cameraView: 'chase',
  };
  let contacts = 0;
  try {
    for (let frame = 0; frame < 240; frame++) {
      state.x += state.speed / 60;
      state.y = roofs.roofHeightAt(id, state.x, state.z);
      assert.ok(state.y > 4 && state.y < 6, 'exercise a real elevated/sloping surface');
      player.updateWalk(1 / 60, state, createActorFootFloor(world, state));
      if (frame > 30)
        for (const foot of player.rig.feet) {
          contacts += Number(!foot.swing);
          assert.ok(
            foot.ay > state.y - 0.1 && foot.ay < state.y + 0.65,
            'no foot follows the distant street',
          );
        }
    }
    assert.ok(contacts > 120, `${contacts} planted foot contacts should survive elevated roof traversal`);
  } finally {
    player.dispose();
  }
});
