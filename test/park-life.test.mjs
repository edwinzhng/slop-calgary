import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import { SpatialIndex, bounds, inside, inPolygon, makeRoadIndex } from '../app/geo.js';
import { PARK_LIFE_MANIFEST, createParkLife, sampleParkAnimal } from '../app/park-life.js';
import { createParkLifePrototypes } from '../app/park-life-models.js';
import { DOG_PARK } from '../app/discovery-spots.js';
import { LOOKOUT_ROOF_IDS } from '../app/park-structures.js';

const [data, parkData, developments] = await Promise.all(
  ['calgary.json', 'calgary-parks.json', 'calgary-developments.json'].map((name) =>
    readFile(new URL(`../data/${name}`, import.meta.url), 'utf8').then(JSON.parse),
  ),
);
const waterIndex = new SpatialIndex(100),
  buildingIndex = new SpatialIndex(80);
for (const water of data.waters) waterIndex.insert(water, bounds(water.ring));
const exclusions = developments.sites
  .filter((s) => s.status !== 'completed')
  .map((s) => ({ ring: s.footprint }));
for (const building of data.buildings) {
  if (LOOKOUT_ROOF_IDS.includes(building.id)) continue;
  const b = bounds(building.ring),
    x = (b.minX + b.maxX) / 2,
    z = (b.minZ + b.maxZ) / 2;
  if (exclusions.some((p) => inside(x, z, p.ring))) continue;
  buildingIndex.insert(building, b);
}
const world = {
  data,
  waterIndex,
  buildingIndex,
  roadIndex: makeRoadIndex(data.roads),
  groundHeight: () => 0.2,
  inWater: (x, z) => [...waterIndex.near(x, z)].some((w) => inPolygon(x, z, w)),
  developments: { surfaceExclusions: exclusions },
};
const scene = new THREE.Scene(),
  park = createParkLife(scene, world, { parkData });
const angular = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

test('park furniture comes from a complete bounded City inventory with honest normalization and styling', () => {
  assert.equal(PARK_LIFE_MANIFEST.meta.sourceRecords, 2104);
  assert.equal(PARK_LIFE_MANIFEST.meta.completeInventory, true);
  assert.equal(PARK_LIFE_MANIFEST.meta.normalizedSeats, 2068);
  for (const id of [111053, 111366, 111368, 111373]) {
    assert.ok(
      park.seats.some((s) => s.id === `city-seat-${id}` && s.kind === 'table'),
      'mapped table beneath open pavilion',
    );
  }
  assert.ok(PARK_LIFE_MANIFEST.meta.omitted['current-construction-site'] > 0);
  assert.ok(PARK_LIFE_MANIFEST.meta.omitted['overlapping-inventory-point'] > 0);
  assert.ok(
    PARK_LIFE_MANIFEST.seats.every(
      (s) => s.id.startsWith('city-seat-') && s.assetId && s.orientation.startsWith('inferred-'),
    ),
  );
  assert.ok(
    PARK_LIFE_MANIFEST.seats.some((s) => s.parkAsset === 'BRD100' && s.style === 'concrete-block'),
    'photo-informed St Patrick amphitheatre seating',
  );
  assert.ok(park.seats.every((s) => !exclusions.some((p) => inside(s.x, s.z, p.ring))));
  assert.equal(park.colliders.length, park.seats.length);
  assert.ok(
    park.colliders.every(
      (c) => c.source === 'city-seating' && c.inferredShape && c.type === 'park-furniture',
    ),
  );
});

test('wildlife routes respect actual land/water, paving, furniture and current construction masks', () => {
  assert.ok(park.candidates.length > 170, `usable routes ${park.candidates.length}`);
  assert.ok(park.candidates.some((c) => c.habitat === 'st-patrick' && !c.swimming));
  assert.ok(park.candidates.some((c) => c.habitat === 'st-patrick' && c.species === 'squirrel'));
  assert.ok(park.candidates.some((c) => c.species === 'beaver' && !c.swimming));
  assert.equal(park.candidates.filter((c) => c.species === 'dog').length, 3);
  assert.ok(park.candidates.some((c) => c.id === 'pixel' && c.species === 'dog'));
  assert.equal(park.candidates.filter((c) => c.id.startsWith('west-eau-claire-bow-goose-')).length, 5);
  for (const candidate of park.candidates) {
    for (let i = 0; i < candidate.path.length; i++) {
      const a = candidate.path[i],
        b = candidate.path[(i + 1) % candidate.path.length];
      for (const t of [0, 0.25, 0.5, 0.75]) {
        const x = a[0] + (b[0] - a[0]) * t,
          z = a[1] + (b[1] - a[1]) * t;
        assert.ok(!exclusions.some((p) => inside(x, z, p.ring)));
        if (candidate.swimming)
          assert.equal(world.inWater(x, z), true, `${candidate.id} in real mapped water`);
        else if (candidate.species === 'dog')
          assert.ok(inPolygon(x, z, DOG_PARK), 'dog stays inside the fence');
        else
          assert.ok(
            park.isHabitatPoint(x, z, candidate.habitat),
            `${candidate.id} stays on permitted ground`,
          );
      }
    }
  }
  assert.ok(
    park.candidates.filter((c) => c.species === 'beaver').every((c) => c.habitat === 'prince-island'),
  );
});

test('raised furniture colliders occupy their actual level without blocking an underpass', () => {
  const raised = createParkLife(
    new THREE.Scene(),
    { data: {}, groundHeight: () => 7 },
    {
      manifest: {
        meta: { sourceRecords: 1, asOf: 'test' },
        seats: [{ id: 'raised-bench', kind: 'bench', x: 0, z: 0, heading: 0 }],
        animals: [],
        habitats: [],
      },
    },
  );
  assert.equal(raised.colliders.length, 1);
  assert.ok(Math.abs(raised.colliders[0].minHeight - 6.984) < 1e-6);
  assert.ok(Math.abs(raised.colliders[0].height - 7.954) < 1e-6);
  assert.ok(raised.colliders[0].minHeight > 6, 'the space below the bench stays open');
  raised.dispose();
});

test('wildlife follows a raised curved park surface with one cheap terrain sample per active animal', () => {
  let terrainQueries = 0,
    groundQueries = 0;
  const hill = (x) => Math.max(0, Math.sin((Math.PI * x) / 10)) * 9;
  const hillside = createParkLife(
    new THREE.Scene(),
    {
      data: {},
      groundHeight: (x) => {
        groundQueries++;
        return 0.2 + hill(x);
      },
      terrain: {
        offsetAt(x) {
          terrainQueries++;
          return hill(x);
        },
      },
    },
    {
      manifest: {
        meta: { sourceRecords: 0 },
        seats: [],
        habitats: [
          {
            id: 'rise',
            rings: [
              {
                ring: [
                  [-1, -1],
                  [11, -1],
                  [11, 4],
                  [-1, 4],
                ],
              },
            ],
          },
        ],
        animals: [
          {
            id: 'hill-rabbit',
            species: 'rabbit',
            habitat: 'rise',
            phase: 0,
            size: 1,
            period: 2,
            path: [
              [0, 0],
              [10, 0],
              [10, 3],
              [0, 3],
            ],
          },
        ],
      },
    },
  );
  assert.equal(
    hillside.candidates.length,
    1,
    'high terrain is allowed; a bridge deck remains a separate layer',
  );
  const expensiveBefore = groundQueries;
  terrainQueries = 0;
  hillside.update(1 / 60, 1.5, { x: 5, y: 2, z: 0 }, 'balanced');
  const pose = hillside.candidates[0].pose;
  assert.ok(Math.abs(pose.x - 5) < 1e-6);
  assert.ok(Math.abs(pose.baseY - 9.2) < 1e-6, 'curved hill is sampled between cached zero-height endpoints');
  assert.equal(groundQueries, expensiveBefore, 'no per-frame polygon ground lookup');
  assert.equal(terrainQueries, 1);
  hillside.dispose();
});

test('authored animal poses have smooth route, turn, hop and stop transitions over a full minute', () => {
  for (const species of ['rabbit', 'squirrel', 'goose', 'beaver']) {
    const candidate =
      park.candidates.find((c) => c.species === species && !c.swimming) ||
      park.candidates.find((c) => c.species === species);
    let previous = sampleParkAnimal(candidate, 0),
      maxHop = 0,
      maxSpeed = 0;
    for (let i = 1; i <= 7200; i++) {
      const current = sampleParkAnimal(candidate, i / 120);
      for (const value of Object.values(current)) assert.ok(Number.isFinite(value));
      const speed = Math.hypot(current.x - previous.x, current.z - previous.z) * 120;
      maxSpeed = Math.max(maxSpeed, speed);
      maxHop = Math.max(maxHop, current.hop);
      assert.ok(speed < 6.5, `${species} bounded speed ${speed}`);
      assert.ok(Math.abs(angular(current.heading, previous.heading)) < 0.15, `${species} eased heading`);
      assert.ok(Math.abs(current.yOffset - previous.yOffset) < 0.05, `${species} stable vertical pose`);
      previous = current;
    }
    assert.ok(maxSpeed > 0.05, `${species} does move`);
    if (species === 'rabbit')
      assert.ok(maxHop > 0.13 && maxHop < 0.24, 'rabbit visibly hops with zero ground penetration');
  }
});

test('original species prototypes are finite, properly scaled and include distinctive articulated parts', () => {
  const prototypes = createParkLifePrototypes();
  for (const [name, g] of Object.entries(prototypes)) {
    for (const key of ['position', 'normal', 'color'])
      assert.ok([...g.attributes[key].array].every(Number.isFinite), `${name} ${key}`);
    assert.ok(g.attributes.position.count / 3 < 2400, `${name} bounded prototype`);
  }
  assert.ok(prototypes.rabbitEars.boundingBox.max.y > 0.32, 'long dark-tipped ears');
  assert.ok(prototypes.squirrelTail.boundingBox.max.y > 0.5, 'raised bushy curled tail');
  assert.ok(prototypes.gooseNeck.boundingBox.max.y > 0.66, 'distinct long goose neck and chinstrap');
  const tail = prototypes.beaverTail.boundingBox;
  assert.ok(tail.max.y - tail.min.y < 0.08 && tail.max.z - tail.min.z > 0.5, 'beaver tail is a flat paddle');
  assert.ok(prototypes.bench.boundingBox.max.y < 1.05 && prototypes.table.boundingBox.max.y < 0.85);
  Object.values(prototypes).forEach((g) => g.dispose());
});

test('Pixel uses the shepherd parts near the dog park and culls away from it', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1715, 2, -82);
  park.update(0, 15, camera, 'performance');
  assert.equal(park.meshes.pixel.count, 1);
  assert.equal(park.meshes.pixelHead.count, 1);
  assert.equal(park.meshes.pixelForeleg.count, 2);
  assert.equal(park.meshes.pixelHindleg.count, 2);
  camera.position.set(0, 2, 0);
  park.update(0, 16, camera, 'performance');
  assert.equal(park.meshes.pixel.count, 0);
});

test('nearby instance budgets and performance stay bounded through quality changes, flight and warmup', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(330, 2, -990);
  for (const [quality, maxAnimals, maxSeats] of [
    ['low', 16, 24],
    ['balanced', 32, 64],
    ['high', 48, 120],
  ]) {
    for (let i = 0; i < 90; i++) park.update(1 / 60, i / 60 + 10, camera, quality);
    assert.ok(park.stats.activeAnimals > 0 && park.stats.activeAnimals <= maxAnimals);
    assert.ok(park.stats.activeFurniture <= maxSeats);
    assert.ok(park.stats.activeSpecies.beaver <= (quality === 'high' ? 3 : quality === 'balanced' ? 2 : 1));
    for (const mesh of Object.values(park.meshes)) {
      assert.ok(mesh.count <= mesh.instanceMatrix.count);
      assert.ok([...mesh.instanceMatrix.array.slice(0, mesh.count * 16)].every(Number.isFinite));
    }
    assert.ok(park.stats.activeTriangles < 280000);
  }
  assert.equal(park.stats.drawCalls, 21, 'bounded instanced animals, furniture and optional canoe/wake');
  camera.position.set(400, 1400, -990);
  park.update(1, 100, camera, 'high');
  assert.equal(park.stats.activeAnimals, 0, 'high altitude culls small animals');
  assert.equal(park.stats.activeFurniture, 0);
  park.prewarm(camera);
  assert.ok(Object.values(park.meshes).every((m) => m.count === 1 && m.visible));
  park.update(0, 101, camera, 'balanced');
  assert.equal(park.stats.activeAnimals, 0);
  camera.position.set(8000, 2, 8000);
  park.update(0, 102, camera, 'balanced');
  assert.equal(park.stats.activeDrawCalls, 0);
});

test('park-life resources dispose once and leave no scene or geometry allocations behind', () => {
  let geometryDisposals = 0;
  for (const geometry of Object.values(park.prototypes))
    geometry.addEventListener('dispose', () => geometryDisposals++);
  park.dispose();
  park.dispose();
  park.update(1, 400, { x: 0, z: 0 }, 'high');
  assert.equal(scene.children.length, 0);
  assert.equal(geometryDisposals, 21);
});
