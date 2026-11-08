import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { createCityMeshes } from '../app/city-meshes.js';
import { createNinthAvenueDetails } from '../app/ninth-avenue-details.js';
import { buildingMaterial } from '../app/materials.js';
import {
  NINTH_AVENUE_MATERIAL_EVIDENCE as evidence,
  WORN_STUDIO_MATERIAL_EVIDENCE as wornEvidence,
} from '../app/observed-building-materials.js';
import { createStorefronts } from '../app/storefronts.js';
import { bounds, makeRoadIndex, SpatialIndex } from '../app/geo.js';

const provider = createCityMeshes(
  JSON.parse(fs.readFileSync(new URL('../data/calgary-meshes.json', import.meta.url))),
  fs.readFileSync(new URL('../data/calgary-meshes.bin', import.meta.url)),
);

function wall(source, triangle) {
  const p = source.attributes.position,
    normal = new THREE.Vector3().fromBufferAttribute(source.attributes.normal, triangle * 3),
    ends = new Map();
  for (let i = triangle * 3; i < (triangle + 2) * 3; i++) {
    const x = p.getX(i),
      z = p.getZ(i),
      key = `${x},${z}`;
    if (!ends.has(key)) ends.set(key, new THREE.Vector3(x, p.getY(i), z));
  }
  const [a, b] = [...ends.values()].sort((a, b) => a.x - b.x),
    axis = b.clone().sub(a).setY(0).normalize(),
    length = Math.hypot(b.x - a.x, b.z - a.z);
  return { a, b, normal, axis, length };
}

test('9 Avenue detail binds to the measured faces, keeps source geometry intact and draws exactly three upper bays', () => {
  const source = provider.createGeometry(evidence.buildingId),
    positions = source.attributes.position.array.slice(),
    normals = source.attributes.normal.array.slice(),
    scene = new THREE.Scene(),
    material = new THREE.MeshBasicMaterial(),
    world = {},
    details = createNinthAvenueDetails(scene, world, { sourceGeometry: source, material }),
    [trim, glass] = details.group.children,
    ray = new THREE.Raycaster();
  try {
    assert.equal(details.stats.sourceAccepted, true);
    assert.deepEqual(details.colliders, []);
    assert.equal(details.stats.drawBudget, 2);
    assert.ok(details.stats.triangles < 4000);
    assert.equal(details.stats.networkRequests, 0);
    assert.ok(world.authoredStorefrontBuildingIds.has(evidence.buildingId));
    scene.updateMatrixWorld(true);
    for (const triangle of [4, 19]) {
      const face = wall(source, triangle),
        y = triangle === 4 ? 5.4 : 5.8;
      let groups = 0,
        previousHit = false;
      for (let i = 0; i <= 300; i++) {
        const eye = face.a
          .clone()
          .addScaledVector(face.axis, (i * face.length) / 300)
          .setY(y)
          .addScaledVector(face.normal, 0.25);
        ray.set(eye, face.normal.clone().negate());
        const hit = ray.intersectObject(glass)[0];
        if (hit && !previousHit) groups++;
        if (hit) {
          assert.ok(Math.abs(hit.distance - 0.225) < 0.0003);
          assert.ok(hit.normal.dot(face.normal) > 0.999);
        }
        previousHit = !!hit;
      }
      assert.equal(
        groups,
        3,
        `exactly three upper glass openings on source triangles ${triangle}/${triangle + 1}`,
      );
    }
    const brick = wall(source, 19),
      crown = 8.220000267028809 - 1.08;
    for (const [offset, expected] of [
      [0, true],
      [0.62, false],
    ]) {
      const eye = brick.a
        .clone()
        .addScaledVector(brick.axis, brick.length / 2 + offset)
        .setY(crown - 0.07)
        .addScaledVector(brick.normal, 0.25);
      ray.set(eye, brick.normal.clone().negate());
      assert.equal(
        !!ray.intersectObject(glass)[0],
        expected,
        'shallow arch crown clears the spring at its sides',
      );
    }
    const screen = wall(source, 48);
    ray.set(
      screen.a.clone().addScaledVector(screen.axis, 5).setY(3.9125).addScaledVector(screen.normal, 0.3),
      screen.normal.clone().negate(),
    );
    assert.ok(ray.intersectObject(trim).length > 0, 'visible horizontal screen tie faces outward');
    for (const [triangle, center, head] of [
      [4, 0.18, 2.9],
      [48, null, 2.8],
      [19, 0.17, 3],
    ]) {
      const f = wall(source, triangle),
        u = center === null ? 0.98 : center * f.length;
      for (const y of [0.4, 2.5, head - 0.03]) {
        ray.set(
          f.a.clone().addScaledVector(f.axis, u).setY(y).addScaledVector(f.normal, 0.25),
          f.normal.clone().negate(),
        );
        assert.ok(
          ray.intersectObject(glass).length,
          `entrance ${triangle} remains full-height above paving at y${y}`,
        );
        if (y > 2.2)
          assert.equal(ray.intersectObject(trim).length, 0, 'signs and screen ties leave the doorway clear');
      }
    }
    const profile = glass.geometry.attributes.buildingProfile,
      uv = glass.geometry.attributes.wallUV;
    for (let i = 0; i < profile.count; i++) {
      const cellX = uv.getX(i) / (profile.getW(i) * 8),
        cellY = uv.getY(i) / (profile.getZ(i) * 8);
      assert.equal(profile.getX(i), 0, 'glazing shares the existing reflective glass style');
      assert.ok(cellX - Math.floor(cellX) >= 0.05 && cellX - Math.floor(cellX) <= 0.95);
      assert.ok(cellY - Math.floor(cellY) >= 0.05 && cellY - Math.floor(cellY) <= 0.95);
    }
    for (const mesh of [trim, glass]) {
      const p = mesh.geometry.attributes.position,
        n = mesh.geometry.attributes.normal;
      assert.ok(p.array.every(Number.isFinite));
      assert.ok(n.array.every(Number.isFinite));
      for (let i = 0; i < p.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(p, i),
          candidates = [wall(source, 4), wall(source, 48), wall(source, 19)].filter((f) => {
            const delta = point.clone().sub(f.a).setY(0),
              u = delta.dot(f.axis),
              depth = delta.dot(f.normal);
            return u >= -0.0003 && u <= f.length + 0.0003 && depth >= -0.0003 && depth <= 0.141;
          });
        assert.ok(
          candidates.length > 0,
          'relief stays inside one observed wall span and its bounded shallow depth',
        );
        assert.ok(p.getY(i) >= -1.941 && p.getY(i) < 8.221);
      }
    }
    assert.deepEqual(source.attributes.position.array, positions);
    assert.deepEqual(source.attributes.normal.array, normals);
  } finally {
    details.dispose();
    source.dispose();
    material.dispose();
  }
});

test('changed source geometry or any compound owner suppresses details and leaves generic storefronts available', () => {
  const material = new THREE.MeshBasicMaterial();
  try {
    for (const mutate of [
      (g) => g.attributes.position.setX(0, g.attributes.position.getX(0) + 0.01),
      (g) => g.attributes.normal.setZ(0, g.attributes.normal.getZ(0) + 0.01),
      (g) => g.setIndex([0, 1, 2]),
      (g) => {
        g.userData.cityMesh.structureIds = [...g.userData.cityMesh.structureIds].reverse();
      },
      (g) => {
        g.userData.cityMesh.structureIds = [...g.userData.cityMesh.structureIds, 123];
      },
      (g) => (g.userData.cityMesh.ground += 0.1),
    ]) {
      const source = provider.createGeometry(evidence.buildingId),
        scene = new THREE.Scene(),
        world = {};
      mutate(source);
      const details = createNinthAvenueDetails(scene, world, { sourceGeometry: source, material });
      details.update({ x: 2222, y: 2, z: 322 });
      assert.equal(details.stats.sourceAccepted, false);
      assert.equal(details.group.visible, false);
      assert.equal(scene.children.length, 0);
      assert.equal(world.authoredStorefrontBuildingIds, undefined);
      details.dispose();
      source.dispose();
    }
  } finally {
    material.dispose();
  }
});

test('9 Avenue details follow owner ground placement once and stay bounded through culling, warmup and disposal', () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshBasicMaterial();
  let placements = 0,
    sourceDisposals = 0,
    geometryDisposals = 0,
    materialDisposals = 0;
  material.addEventListener('dispose', () => materialDisposals++);
  const world = {
      authoredStorefrontBuildingIds: new Set(['another-owner']),
      photoWallGeometry(id) {
        const source = provider.createGeometry(id);
        source.addEventListener('dispose', () => sourceDisposals++);
        return source;
      },
      placePhotographicGeometry(geometry, record) {
        assert.ok([evidence.buildingId, wornEvidence.buildingId].includes(record.buildingId));
        assert.equal(geometry.userData.placed, undefined);
        const offset = record.buildingId === evidence.buildingId ? 7 : 3;
        geometry.translate(0, offset, 0);
        geometry.userData.placed = offset;
        placements++;
      },
    },
    details = createNinthAvenueDetails(scene, world, { material });
  for (const mesh of details.group.children) {
    mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
    const expectedOffset = mesh.geometry.userData.source === evidence ? 7 : 3;
    assert.equal(mesh.geometry.userData.placed, expectedOffset);
    assert.ok(mesh.geometry.boundingSphere.center.y > expectedOffset);
  }
  assert.deepEqual(details.acceptedBuildingIds, [evidence.buildingId, wornEvidence.buildingId]);
  assert.equal(sourceDisposals, 2);
  assert.equal(placements, 4);
  const near = { x: 2222, y: 9, z: 322 };
  details.update(near);
  assert.equal(details.group.visible, true);
  details.update({ ...near, x: 2342 });
  assert.equal(details.group.visible, false);
  details.update({ ...near, x: 2342 }, 'high');
  assert.equal(details.group.visible, true);
  details.update({ ...near, y: 95 });
  assert.equal(details.group.visible, false);
  details.setEnabled(false);
  const restore = details.prewarm();
  assert.equal(details.group.visible, true);
  assert.ok(details.group.children.every((mesh) => mesh.frustumCulled === false));
  restore();
  restore();
  assert.equal(details.group.visible, false);
  assert.ok(details.group.children.every((mesh) => mesh.frustumCulled));
  details.setEnabled(true);
  details.update(near);
  const lateRestore = details.prewarm();
  details.dispose();
  details.dispose();
  lateRestore();
  details.update(near);
  assert.equal(details.group.visible, false);
  assert.equal(details.group.parent, null);
  assert.equal(geometryDisposals, 4);
  assert.equal(materialDisposals, 0);
  assert.deepEqual([...world.authoredStorefrontBuildingIds], ['another-owner']);
  material.dispose();
});

test('9 Avenue shares the city glazing shader and owns only its single sign atlas and trim material', (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  let canvases = 0,
    sharedDisposals = 0,
    trimDisposals = 0,
    textureDisposals = 0;
  let wornOnly;
  globalThis.document = {
    createElement() {
      canvases++;
      return { getContext: () => ({ fillRect() {}, fillText() {} }) };
    },
  };
  const source = provider.createGeometry(evidence.buildingId),
    wornSource = provider.createGeometry(wornEvidence.buildingId),
    details = createNinthAvenueDetails(
      new THREE.Scene(),
      {},
      { sourceGeometry: source, wornSourceGeometry: wornSource },
    ),
    [trim, glass, wornTrim, wornGlass] = details.group.children,
    shared = buildingMaterial(),
    onSharedDispose = () => sharedDisposals++;
  shared.addEventListener('dispose', onSharedDispose);
  trim.material.addEventListener('dispose', () => trimDisposals++);
  trim.material.map.addEventListener('dispose', () => textureDisposals++);
  try {
    assert.equal(canvases, 1);
    assert.equal(glass.material, shared);
    assert.equal(wornGlass.material, shared);
    assert.equal(wornTrim.material, trim.material);
    for (let i = 0; i < wornTrim.geometry.attributes.uv.count; i++) {
      assert.ok(Math.abs(wornTrim.geometry.attributes.uv.getX(i) - 0.02) < 1e-7);
      assert.ok(
        Math.abs(wornTrim.geometry.attributes.uv.getY(i) - 0.98) < 1e-7,
        '915 samples only the atlas blank area',
      );
    }
    assert.equal(glass.material.transparent, false);
    assert.equal(glass.material.depthWrite, true);
    details.dispose();
    details.dispose();
    assert.equal(trimDisposals, 1);
    assert.equal(textureDisposals, 1);
    assert.equal(sharedDisposals, 0);
    wornOnly = createNinthAvenueDetails(new THREE.Scene(), {}, { wornSourceGeometry: wornSource });
    assert.equal(wornOnly.stats.wornSourceAccepted, true);
    assert.equal(wornOnly.stats.compoundSourceAccepted, false);
    assert.equal(canvases, 1, 'a 915-only correction does not allocate an unused atlas');
    assert.equal(wornOnly.group.children[0].material.map, null);
    assert.equal(wornOnly.group.children[1].material, shared);
  } finally {
    shared.removeEventListener('dispose', onSharedDispose);
    wornOnly?.dispose();
    details.dispose();
    source.dispose();
    wornSource.dispose();
  }
});

test('915 detail follows only its measured north span with three rose upper groups and two distinct lower panels', () => {
  const source = provider.createGeometry(wornEvidence.buildingId),
    positions = source.attributes.position.array.slice(),
    normals = source.attributes.normal.array.slice(),
    scene = new THREE.Scene(),
    material = new THREE.MeshBasicMaterial(),
    details = createNinthAvenueDetails(scene, {}, { wornSourceGeometry: source, material }),
    [trim, glass] = details.group.children,
    face = wall(source, 6),
    ray = new THREE.Raycaster();
  const groupsAt = (y) => {
    let groups = 0,
      previous = false;
    for (let i = 0; i <= 400; i++) {
      const eye = face.a
        .clone()
        .addScaledVector(face.axis, (i * face.length) / 400)
        .setY(y)
        .addScaledVector(face.normal, 0.25);
      ray.set(eye, face.normal.clone().negate());
      const hit = ray.intersectObject(glass)[0];
      if (hit && !previous) groups++;
      if (hit) {
        assert.ok(Math.abs(hit.distance - 0.225) < 0.0003);
        assert.ok(hit.normal.dot(face.normal) > 0.999);
      }
      previous = !!hit;
    }
    return groups;
  };
  try {
    assert.equal(details.stats.sourceAccepted, true);
    assert.equal(details.stats.compoundSourceAccepted, false);
    assert.equal(details.stats.wornSourceAccepted, true);
    assert.deepEqual(details.acceptedBuildingIds, [wornEvidence.buildingId]);
    assert.ok(Object.isFrozen(details.acceptedBuildingIds));
    assert.equal(details.stats.drawBudget, 2);
    assert.ok(details.stats.triangles < 300);
    assert.equal(details.stats.networkRequests, 0);
    assert.equal(details.stats.pointLights, 0);
    assert.deepEqual(details.colliders, []);
    scene.updateMatrixWorld(true);
    assert.equal(groupsAt(3.9), 3, 'three source-inspired upper opening groups');
    assert.equal(groupsAt(1.5), 2, 'small high-sill east panel and separate broad shopfront');
    assert.equal(groupsAt(0.4), 1, 'the broad low glazing does not assert another doorway');
    assert.equal(groupsAt(-1), 0, 'buried source wall is not an inferred entrance threshold');
    for (const mesh of [trim, glass]) {
      const p = mesh.geometry.attributes.position,
        n = mesh.geometry.attributes.normal;
      assert.equal(mesh.geometry.userData.source, wornEvidence);
      assert.ok(p.array.every(Number.isFinite));
      assert.ok(n.array.every(Number.isFinite));
      for (let i = 0; i < p.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(p, i),
          delta = point.clone().sub(face.a).setY(0),
          u = delta.dot(face.axis),
          depth = delta.dot(face.normal),
          top = 5.420000076293945 + ((5.400000095367432 - 5.420000076293945) * u) / face.length;
        assert.ok(u >= -0.0003 && u <= face.length + 0.0003);
        assert.ok(depth >= -0.0003 && depth <= 0.086);
        assert.ok(
          point.y >= 0.0799 && point.y < top,
          'all detail remains above the visible threshold and below the measured top',
        );
      }
    }
    assert.deepEqual(source.attributes.position.array, positions);
    assert.deepEqual(source.attributes.normal.array, normals);
    details.update({ x: 2203, y: 2, z: 314 });
    assert.equal(details.group.visible, true);
    details.update({ x: 2302, y: 2, z: 322 }, 'low');
    assert.equal(details.group.visible, false);
    details.update({ x: 2302, y: 2, z: 322 });
    assert.equal(details.group.visible, true);
    details.update({ x: 2203, y: 95, z: 314 });
    assert.equal(details.group.visible, false);
    details.setEnabled(false);
    const restore = details.prewarm();
    assert.equal(details.group.visible, true);
    assert.ok(details.group.children.every((mesh) => !mesh.frustumCulled));
    details.dispose();
    restore();
    restore();
    assert.equal(details.group.visible, false);
    assert.ok([trim, glass].every((mesh) => mesh.frustumCulled));
  } finally {
    details.dispose();
    source.dispose();
    material.dispose();
  }
});

test('915 and the neighbouring compound accept and suppress storefront bodies independently', () => {
  const material = new THREE.MeshBasicMaterial();
  try {
    for (const rejectWorn of [true, false]) {
      const source = provider.createGeometry(evidence.buildingId),
        wornSource = provider.createGeometry(wornEvidence.buildingId),
        world = { authoredStorefrontBuildingIds: new Set(['another-owner']) };
      if (rejectWorn) wornSource.userData.cityMesh.sourceDates = ['2013-06-11'];
      else source.attributes.position.setX(0, source.attributes.position.getX(0) + 0.01);
      const details = createNinthAvenueDetails(new THREE.Scene(), world, {
          sourceGeometry: source,
          wornSourceGeometry: wornSource,
          material,
        }),
        accepted = rejectWorn ? evidence.buildingId : wornEvidence.buildingId;
      try {
        assert.equal(details.stats.compoundSourceAccepted, rejectWorn);
        assert.equal(details.stats.wornSourceAccepted, !rejectWorn);
        assert.deepEqual(details.acceptedBuildingIds, [accepted]);
        assert.deepEqual([...world.authoredStorefrontBuildingIds], ['another-owner', accepted]);
        assert.equal(details.group.children.length, 2);
        details.dispose();
        assert.deepEqual([...world.authoredStorefrontBuildingIds], ['another-owner']);
      } finally {
        details.dispose();
        source.dispose();
        wornSource.dispose();
      }
    }
  } finally {
    material.dispose();
  }
});

test('915 body suppression preserves the actual Worn Studio destination and binding', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../data/calgary.json', import.meta.url))),
    places = JSON.parse(fs.readFileSync(new URL('../data/calgary-places.json', import.meta.url))),
    building = data.buildings.find((row) => row.id === wornEvidence.buildingId),
    worn = places.places.find((row) => row.name === 'Worn Studio'),
    buildingIndex = new SpatialIndex(80),
    roadIndex = makeRoadIndex(data.roads);
  buildingIndex.insert(building, bounds(building.ring));
  const baseline = createStorefronts(new THREE.Scene(), { buildingIndex, roadIndex }, [worn]),
    source = provider.createGeometry(wornEvidence.buildingId),
    material = new THREE.MeshBasicMaterial(),
    scene = new THREE.Scene(),
    world = { buildingIndex, roadIndex },
    details = createNinthAvenueDetails(scene, world, { wornSourceGeometry: source, material });
  try {
    const stores = createStorefronts(scene, world, [worn]);
    assert.equal(baseline.facadeCount, 1);
    assert.equal(stores.facadeCount, 0);
    assert.equal(stores.count, 1);
    assert.deepEqual(stores.destinations, baseline.destinations);
    assert.equal(stores.destinations[0].name, 'Worn Studio');
    assert.equal(stores.destinations[0].sub, '915 9 Avenue SE');
    assert.deepEqual(world.businessPlaces, baseline.destinations);
  } finally {
    details.dispose();
    source.dispose();
    material.dispose();
  }
});

test('a second-owner placement failure disposes partial details and both temporary sources before suppressing bodies', () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshBasicMaterial(),
    world = { authoredStorefrontBuildingIds: new Set(['another-owner']) };
  let geometriesDisposed = 0,
    sourcesDisposed = 0,
    materialsDisposed = 0;
  material.addEventListener('dispose', () => materialsDisposed++);
  world.photoWallGeometry = (id) => {
    const source = provider.createGeometry(id);
    source.addEventListener('dispose', () => sourcesDisposed++);
    return source;
  };
  world.placePhotographicGeometry = (geometry, record) => {
    geometry.addEventListener('dispose', () => geometriesDisposed++);
    if (record.buildingId === wornEvidence.buildingId) throw new Error('placement failed');
  };
  try {
    assert.throws(() => createNinthAvenueDetails(scene, world, { material }), /placement failed/);
    assert.equal(geometriesDisposed, 3);
    assert.equal(sourcesDisposed, 2);
    assert.equal(materialsDisposed, 0);
    assert.equal(scene.children.length, 0);
    assert.deepEqual([...world.authoredStorefrontBuildingIds], ['another-owner']);
  } finally {
    material.dispose();
  }
});
