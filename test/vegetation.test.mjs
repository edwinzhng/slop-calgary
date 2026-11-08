import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildTreeGeometries, createNeedleAtlas, TREE_SPECIES } from '../app/reference-trees.js';
import { buildSpruceCrown, createVegetation, treeProfile } from '../app/vegetation.js';
import { prepareInstanceMatrices } from '../app/render-instances.js';

const bytes = (array) => Buffer.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));

test('needle sprays have open coverage that survives distant mip levels without another download', () => {
  const texture = createNeedleAtlas();
  try {
    const coverage = (mip) => {
      let covered = 0;
      for (let i = 3; i < mip.data.length; i += 4) if (mip.data[i] >= 128) covered++;
      return covered / (mip.width * mip.height);
    };
    const source = coverage(texture.mipmaps[0]);
    assert.ok(source > 0.15 && source < 0.35, 'the spray stays open instead of becoming a solid polygon');
    for (const mip of texture.mipmaps.filter((level) => level.width >= 4))
      assert.ok(Math.abs(coverage(mip) - source) < 0.05, 'distant needles retain their coverage');
    assert.equal(texture.generateMipmaps, false);
    assert.equal(texture.image.width, 256);
  } finally {
    texture.dispose();
  }
});

test('Calgary crown groups preserve measured trunks and distinguish poplar bark and columnar form', () => {
  const source = { id: 'source-tree', genus: 'POPULUS', species: 'BALSAMIFERA', dbh: 60 };
  const poplar = treeProfile(source),
    aspen = treeProfile({ ...source, species: 'TREMULOIDES' }),
    columnar = treeProfile({ ...source, species: 'TREMULA', name: 'ASPEN, SWEDISH COLUMNAR' }),
    ash = treeProfile({ ...source, genus: 'FRAXINUS' }),
    elm = treeProfile({ ...source, genus: 'ULMUS' });
  assert.deepEqual([ash.species, poplar.species, elm.species], [0, 1, 2]);
  for (const profile of [poplar, aspen, columnar, ash, elm]) {
    assert.equal(profile.radius, 0.3, 'DBH remains authoritative across crown groups');
    assert.equal(profile.height, poplar.height, 'species styling does not invent a measured height');
  }
  assert.ok(poplar.foliageSeed >= 0.5 && aspen.foliageSeed < 0.5);
  assert.ok(columnar.width < poplar.width * 0.5);
  assert.equal(source.species, 'BALSAMIFERA');
  assert.notEqual(
    treeProfile({ id: 'spruce', genus: 'PICEA', species: 'GLAUCA' }).needleTint,
    treeProfile({ id: 'spruce', genus: 'PICEA', species: 'PUNGENS' }).needleTint,
  );
});

test('solid spruce crowns retain upward faces, a narrow silhouette and bounded geometry', () => {
  for (const detailed of [false, true]) {
    const geometry = buildSpruceCrown(detailed);
    try {
      const p = geometry.attributes.position,
        colour = geometry.attributes.color;
      assert.ok(p.count / 3 <= (detailed ? 180 : 120));
      assert.equal(colour.count, p.count);
      assert.ok(p.array.every(Number.isFinite));
      assert.ok(geometry.boundingBox.min.y > 0 && geometry.boundingBox.max.y <= 1.1);
      assert.ok(colour.array.every((v) => v > 0 && v <= 1));
      const normal = geometry.attributes.normal;
      assert.ok(normal.array.every(Number.isFinite));
      for (let i = 0; i < p.count; i += 6) {
        assert.ok(normal.getY(i) > 0, 'top of each whorl faces the sky');
        assert.ok(normal.getY(i + 3) < 0, 'underside faces the ground');
      }
    } finally {
      geometry.dispose();
    }
  }
});

function boundBytes(geometry) {
  return bytes(
    new Float64Array([
      ...geometry.boundingBox.min.toArray(),
      ...geometry.boundingBox.max.toArray(),
      ...geometry.boundingSphere.center.toArray(),
      geometry.boundingSphere.radius,
    ]),
  );
}

function compareGeometry(actual, expected) {
  assert.deepEqual(Object.keys(actual.attributes), Object.keys(expected.attributes));
  for (const name of [...Object.keys(expected.attributes), 'index']) {
    const a = name === 'index' ? actual.index : actual.attributes[name],
      b = name === 'index' ? expected.index : expected.attributes[name];
    assert.equal(a.constructor, b.constructor, `${name} attribute class`);
    assert.equal(a.array.constructor, b.array.constructor, `${name} element type`);
    for (const key of ['itemSize', 'normalized', 'usage', 'gpuType', 'count'])
      assert.equal(a[key], b[key], `${name} ${key}`);
    assert.deepEqual(bytes(a.array), bytes(b.array), `${name} exact source bytes`);
  }
  assert.deepEqual(actual.userData, expected.userData);
  assert.deepEqual(actual.groups, expected.groups);
  assert.deepEqual(actual.drawRange, expected.drawRange);
  assert.deepEqual(boundBytes(actual), boundBytes(expected), 'exact Float64 source bounds');
}

for (const tileMeters of [
  [1.3, 1.15, 1.4, 2.4],
  [1.9, 0.73, 1.8, 3.7],
])
  test(`retained tree levels match independent default builds with tiles ${tileMeters.join('/')}`, () => {
    const originalTiles = tileMeters.slice();
    for (let species = 0; species < TREE_SPECIES.length; species++)
      for (const variant of [0, 1]) {
        const original = buildTreeGeometries(species, variant, tileMeters),
          selected = buildTreeGeometries(species, variant, tileMeters, { levels: [0, 2] });
        try {
          assert.equal(original.length, 3);
          assert.ok(original.every((geometry) => geometry?.isBufferGeometry));
          assert.equal(selected.length, 3);
          assert.equal(1 in selected, false, 'the unused middle geometry is absent');
          for (const lod of [0, 2]) compareGeometry(selected[lod], original[lod]);
          assert.deepEqual(tileMeters, originalTiles, 'tile dimensions stay source-owned');
        } finally {
          for (const geometry of [...original, ...selected]) geometry?.dispose();
        }
      }
  });

test('tree level requests reject unsupported levels before building any geometry', () => {
  for (const levels of [[], [-1], [3], [0.5], [0, undefined]])
    assert.throws(() => buildTreeGeometries(0, 0, [1.3, 1.15, 1.4, 2.4], { levels }), RangeError);
});

function instanceAttributes(mesh) {
  return new Map([
    ['matrix', mesh.instanceMatrix],
    ...(mesh.instanceColor ? [['color', mesh.instanceColor]] : []),
    ...Object.entries(mesh.geometry.attributes).filter(
      ([, attribute]) => attribute.isInstancedBufferAttribute,
    ),
    ...(mesh.geometry.indirect ? [['indirect', mesh.geometry.indirect]] : []),
  ]);
}

function attributeSnapshot(mesh) {
  return new Map(
    [...instanceAttributes(mesh)].map(([name, attribute]) => [
      name,
      { attribute, version: attribute.version, bytes: bytes(attribute.array) },
    ]),
  );
}

function assertNoUploads(mesh, snapshot) {
  for (const [name, attribute] of instanceAttributes(mesh)) {
    const original = snapshot.get(name);
    assert.ok(original, `${mesh.name}: no new ${name} for an empty pool`);
    assert.equal(attribute, original.attribute, `${mesh.name}: ${name} identity`);
    assert.equal(attribute.version, original.version, `${mesh.name}: no ${name} upload version`);
  }
}

function inventoryFixtures() {
  const trees = [];
  for (const [species, genus] of ['FRAXINUS', 'POPULUS', 'ULMUS'].entries())
    for (const variant of [0, 1]) {
      let id;
      for (let i = 0; i < 10000; i++) {
        const candidate = `${genus}-${variant}-${i}`;
        if (treeProfile({ id: candidate }).variant === variant) {
          id = candidate;
          break;
        }
      }
      assert.ok(id, 'fixture covers the requested deterministic variant');
      trees.push(
        {
          id,
          x: 13 + species * 19 + variant * 7,
          z: -11 - species * 5 - variant * 3,
          type: 'Deciduous',
          genus,
          dbh: 9 + species * 23 + variant * 17,
          matureSize: variant ? 'MEDIUM' : 'SMALL',
        },
        {
          id: `${id}-distant`,
          x: -480 + species * 51 + variant * 11,
          z: 330 + species * 3 + variant * 9,
          type: 'Deciduous',
          genus,
          dbh: 180 - species * 13 - variant * 31,
        },
      );
    }
  trees.push(
    { id: 'tower', x: 110, z: -27, genus: 'POPULUS', name: 'SWEDISH COLUMNAR', dbh: 22 },
    { id: 'small-columnar', x: -320, z: 390, genus: 'ACER', name: 'ERECTA', dbh: 4, matureSize: 'SMALL' },
    { id: 'fir', x: -39, z: 15, genus: 'ABIES', dbh: 19, matureSize: 'SMALL' },
    { id: 'pine', x: 91, z: 22, genus: 'PINUS', dbh: 65 },
    { id: 'spruce', x: 320, z: -109, type: 'Evergreen', genus: 'PICEA', dbh: 110 },
    // Record identity, rather than a source identifier, owns the cached data.
    { id: trees[0].id, x: -311, z: -227, genus: 'THUJA', dbh: 31, matureSize: 'MEDIUM' },
    { id: 'late-selection', x: 5000, z: 5000, genus: 'SALIX', dbh: 48 },
  );
  return trees;
}

function selectedInventory(records, camera, quality) {
  const aerial = camera.position.y > 160,
    radius = aerial ? (quality === 'high' ? 2850 : 2150) + 200 : (quality === 'high' ? 940 : 790) + 101,
    cap = aerial ? (quality === 'high' ? 8500 : 6000) : quality === 'high' ? 4600 : 3100;
  return records
    .map((tree) => ({ tree, d: Math.hypot(tree.x - camera.position.x, tree.z - camera.position.z) }))
    .filter(({ d }) => d < radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, cap);
}

// Independent reference for the former per-population Object3D/Color writes.
// It recomputes every selected record, without reading the cached output.
function referencePopulation(meshes, prototypes, selected, camera, quality, previousDetail) {
  const pools = new Map(meshes.map((mesh) => [mesh, []])),
    byGeometry = new Map(meshes.map((mesh) => [mesh.geometry, mesh])),
    evergreenNear = meshes.find((mesh) => mesh.name === 'Surveyed evergreen layered crowns — near'),
    evergreenFar = meshes.find((mesh) => mesh.name === 'Surveyed evergreen layered crowns — distant'),
    trunks = meshes.find((mesh) => mesh.name === 'Surveyed tree trunks'),
    branches = meshes.find((mesh) => mesh.name === 'Surveyed tree branches'),
    object = new THREE.Object3D(),
    tint = new THREE.Color(),
    aerial = camera.position.y > 160;
  let detailedCount = 0,
    detailedBroadleaf = 0;
  const nextDetail = new Set();
  for (const { tree, d } of selected) {
    const p = tree.profile,
      detailed =
        !aerial &&
        d < (quality === 'high' ? 140 : 90) + (previousDetail.has(tree) ? 14 : 0) &&
        detailedCount < (quality === 'high' ? 400 : 220);
    if (detailed) {
      detailedCount++;
      nextDetail.add(tree);
    }
    object.position.set(tree.x, tree.baseY, tree.z);
    object.rotation.set(0, p.seed * Math.PI * 2, 0);
    if (p.form !== 2) {
      const prototype = prototypes[p.species * 2 + p.variant],
        horizontal = p.width / prototype.radius,
        vertical = p.height / prototype.height;
      object.scale.set(horizontal, vertical, horizontal * (0.94 + p.seed * 0.12));
      object.updateMatrix();
      tint
        .setHex(TREE_SPECIES[p.species].tints[Math.floor(p.seed * 2.999)])
        .multiplyScalar(0.86 + p.seed * 0.2);
      const localDBH = 1.37 / vertical,
        t = Math.min(0.99, localDBH / prototype.trunk.top),
        trunkRadius = prototype.trunk.r * (1 - 0.7 * t ** 0.8) * (1 + 0.75 * Math.exp(-localDBH / 0.28)),
        correction = p.radius / Math.max(0.001, trunkRadius * horizontal);
      pools.get(byGeometry.get(detailed ? prototype.near : prototype.far)).push({
        record: tree,
        matrix: new Float32Array(object.matrix.elements),
        aTreeData: new Float32Array([tint.r, tint.g, tint.b, p.species + p.foliageSeed]),
        aTreeShape: new Float32Array([correction, vertical]),
      });
      if (detailed) detailedBroadleaf++;
      continue;
    }
    object.scale.set(p.width, p.height, p.width * (0.88 + p.seed * 0.14));
    object.updateMatrix();
    tint.setHex(p.needleTint).multiplyScalar(0.88 + p.seed * 0.2);
    const matrix = new Float32Array(object.matrix.elements);
    pools
      .get(detailed ? evergreenNear : evergreenFar)
      .push({ record: tree, matrix, color: new Float32Array(tint.toArray()) });
    if (detailed) pools.get(branches).push({ record: tree, matrix });
    object.scale.set(p.radius, p.height * 0.55, p.radius);
    object.position.y = tree.baseY + p.height * 0.275;
    object.updateMatrix();
    pools.get(trunks).push({ record: tree, matrix: new Float32Array(object.matrix.elements) });
  }
  return { pools, detailedCount, detailedBroadleaf, nextDetail };
}

function assertPopulation(meshes, expected, indirectCells, label) {
  for (const mesh of meshes) {
    let rows = expected.pools.get(mesh);
    if (indirectCells) {
      const cells = new Map();
      for (const row of rows) {
        const key = `${Math.floor(row.matrix[12] / 300)},${Math.floor(row.matrix[14] / 300)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(row);
      }
      rows = [...cells.values()].flat();
    }
    assert.equal(mesh.count, rows.length, `${label}: ${mesh.name} count`);
    assert.equal(mesh.visible, rows.length > 0, `${label}: ${mesh.name} visibility`);
    for (const [name, attribute] of instanceAttributes(mesh)) {
      if (name === 'indirect') continue;
      const expectedBytes = Buffer.concat(rows.map((row) => bytes(row[name])));
      assert.deepEqual(
        bytes(attribute.array.subarray(0, rows.length * attribute.itemSize)),
        expectedBytes,
        `${label}: ${mesh.name} ${name} preserves the original Float32 writes`,
      );
    }
  }
}

for (const indirectCells of [false, true])
  test(`lazy tree data matches original math across populations (indirect=${indirectCells})`, () => {
    const scene = new THREE.Scene(),
      source = { trees: inventoryFixtures() },
      originalSource = structuredClone(source),
      vegetation = createVegetation(scene, source, {
        indirectCells,
        groundHeight: (x, z) => 0.12 + Math.sin(x * 0.01) * 0.27 + z * 0.0001,
      }),
      meshes = scene.children.filter((object) => object.isInstancedMesh),
      referenceRecords = vegetation.records.map((record) => ({ ...record, profile: { ...record.profile } })),
      mathReads = new Map(),
      barkReads = new Map(),
      previouslySelected = new Set(),
      camera = new THREE.PerspectiveCamera(68, 1, 0.1, 12000),
      poses = [
        [0, 2, 0, 'balanced'],
        [70, 2, -15, 'high'],
        [-400, 2, 360, 'balanced'],
        [900, 200, 0, 'balanced'],
        [-1000, 200, 300, 'high'],
        [10000, 2, 10000, 'balanced'],
        [5000, 2, 5000, 'high'],
        [0, 2, 0, 'balanced'],
      ];
    for (const mesh of meshes) {
      if (!mesh.geometry.attributes.aTreeShape) continue;
      const getMatrixAt = mesh.getMatrixAt,
        probe = { reads: 0, records: new Set() };
      mesh.getMatrixAt = function (i, matrix) {
        probe.reads++;
        return getMatrixAt.call(this, i, matrix);
      };
      barkReads.set(mesh, probe);
    }
    for (const record of vegetation.records) {
      mathReads.set(record, 0);
      record.profile = new Proxy(Object.freeze(record.profile), {
        get(target, key, receiver) {
          if (['height', 'width', 'radius', 'seed'].includes(key))
            mathReads.set(record, mathReads.get(record) + 1);
          return Reflect.get(target, key, receiver);
        },
      });
      Object.freeze(record);
    }
    let replacedMatrices;
    let previousDetail = new Set();
    try {
      for (const [poseIndex, [x, y, z, quality]] of poses.entries()) {
        camera.position.set(x, y, z);
        const selected = selectedInventory(referenceRecords, camera, quality),
          expected = referencePopulation(
            meshes,
            vegetation.prototypes,
            selected,
            camera,
            quality,
            previousDetail,
          ),
          selectedReferences = new Set(selected.map(({ tree }) => referenceRecords.indexOf(tree))),
          beforeReads = new Map(mathReads),
          beforeBark = new Map([...barkReads].map(([mesh, probe]) => [mesh, probe.reads]));
        vegetation.update(camera, quality);
        previousDetail = expected.nextDetail;
        assertPopulation(meshes, expected, indirectCells, `pose ${poseIndex}`);
        assert.equal(vegetation.stats.visibleTrees, selected.length);
        assert.equal(vegetation.stats.detailedTrees, expected.detailedCount);
        assert.equal(vegetation.stats.detailedBroadleafTrees, expected.detailedBroadleaf);
        for (const [mesh, probe] of barkReads) {
          const firstSelections = expected.pools.get(mesh).filter(({ record }) => !probe.records.has(record));
          assert.equal(
            probe.reads - beforeBark.get(mesh),
            indirectCells ? firstSelections.length : 0,
            `${mesh.name}: bark bounds are derived once per exact record and LOD, with no direct-path work`,
          );
          for (const { record } of firstSelections) probe.records.add(record);
        }
        for (const [i, record] of vegetation.records.entries()) {
          const firstSelection = selectedReferences.has(i) && !previouslySelected.has(record);
          if (firstSelection) {
            assert.ok(mathReads.get(record) > beforeReads.get(record), 'data is built on first selection');
            previouslySelected.add(record);
          } else
            assert.equal(
              mathReads.get(record),
              beforeReads.get(record),
              'cached or unselected data needs no repeated math',
            );
        }
        if (poseIndex === 0) {
          replacedMatrices = new Map(
            meshes.map((mesh) => [
              mesh,
              { attribute: mesh.instanceMatrix, version: mesh.instanceMatrix.version },
            ]),
          );
          prepareInstanceMatrices(scene, true);
          for (const mesh of meshes)
            assert.notEqual(
              mesh.instanceMatrix,
              replacedMatrices.get(mesh).attribute,
              'startup replaces the attribute object',
            );
        } else
          for (const mesh of meshes)
            assert.equal(
              replacedMatrices.get(mesh).attribute.version,
              replacedMatrices.get(mesh).version,
              'population uploads version the current matrix attribute',
            );
      }
      assert.equal(previouslySelected.size, vegetation.records.length);
      assert.ok(
        vegetation.prototypes.some((prototype) => {
          const near = barkReads.get(meshes.find((mesh) => mesh.geometry === prototype.near)),
            far = barkReads.get(meshes.find((mesh) => mesh.geometry === prototype.far));
          return [...near.records].some((record) => far.records.has(record));
        }),
        'the route exercises separate near/far cache entries for the same record',
      );
      assert.deepEqual(source, originalSource);
      assert.deepEqual(
        vegetation.records.map(({ id, x, z, profile }) => ({ id, x, z, ...profile })),
        referenceRecords.map(({ id, x, z, profile }) => ({ id, x, z, ...profile })),
      );
    } finally {
      const geometries = new Set(meshes.map((mesh) => mesh.geometry)),
        materials = new Set(meshes.map((mesh) => mesh.material));
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      vegetation.atlas.texture.dispose();
      scene.clear();
    }
  });

for (const indirectCells of [false, true])
  test(`empty populations stay clean and populated pools remain reachable (indirect=${indirectCells})`, () => {
    const scene = new THREE.Scene(),
      source = {
        trees: [
          { id: 'spruce-near', x: 0, z: 0, type: 'Evergreen', genus: 'PICEA', dbh: 28 },
          { id: 'elm-near', x: 12, z: 0, type: 'Deciduous', genus: 'ULMUS', dbh: 42 },
          { id: 'spruce-far', x: 300, z: 0, type: 'Evergreen', genus: 'PICEA', dbh: 32 },
          { id: 'locust-far', x: 350, z: 0, type: 'Deciduous', genus: 'GLEDITSIA', dbh: 35 },
        ],
      },
      originalSource = structuredClone(source),
      vegetation = createVegetation(scene, source, { indirectCells }),
      meshes = scene.children.filter((object) => object.isInstancedMesh),
      camera = new THREE.PerspectiveCamera(68, 1, 0.1, 5000);
    camera.position.set(0, 2, 10);
    prepareInstanceMatrices(scene, indirectCells);
    const cold = new Map(meshes.map((mesh) => [mesh, attributeSnapshot(mesh)]));
    try {
      assert.equal(meshes.length, 16);
      assert.ok(meshes.every((mesh) => mesh.visible === false && mesh.count === 0));
      vegetation.update(camera);
      const populated = meshes.filter((mesh) => mesh.count > 0),
        empty = meshes.filter((mesh) => mesh.count === 0);
      assert.ok(populated.length > 0 && empty.length > 0);
      assert.equal(vegetation.stats.visibleTrees, source.trees.length);
      for (const mesh of empty) {
        assert.equal(mesh.visible, false);
        assertNoUploads(mesh, cold.get(mesh));
      }
      const populatedState = new Map(meshes.map((mesh) => [mesh, attributeSnapshot(mesh)])),
        away = new THREE.PerspectiveCamera(60, 1, 0.1, 10),
        restored = new THREE.PerspectiveCamera(120, 1, 0.1, 5000);
      away.position.set(10000, 2, 10000);
      away.updateMatrixWorld();
      restored.position.set(150, 100, 500);
      restored.lookAt(150, 0, 0);
      restored.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      if (indirectCells)
        for (const mesh of populated) {
          assert.equal(mesh.visible, true);
          mesh.onBeforeRender(null, scene, away);
          assert.equal(mesh.count, 0);
          assert.equal(mesh.visible, true, 'a culled view must not hide a populated pool');
          mesh.onBeforeRender(null, scene, restored);
          assert.ok(mesh.count > 0, 'another view still reaches the population callback');
          assertNoUploads(mesh, populatedState.get(mesh));
        }
      camera.position.set(10000, 2, 10000);
      vegetation.update(camera);
      assert.equal(vegetation.stats.visibleTrees, 0);
      for (const mesh of meshes) {
        assert.equal(mesh.count, 0);
        assert.equal(mesh.visible, false);
        assertNoUploads(mesh, populatedState.get(mesh));
        for (const attribute of instanceAttributes(mesh).values())
          assert.deepEqual(attribute.updateRanges, []);
      }
      camera.position.x += 20;
      vegetation.update(camera);
      for (const mesh of meshes) assertNoUploads(mesh, populatedState.get(mesh));
      camera.position.set(0, 2, 10);
      vegetation.update(camera);
      for (const mesh of meshes)
        for (const [name, attribute] of instanceAttributes(mesh))
          assert.deepEqual(
            bytes(attribute.array),
            populatedState.get(mesh).get(name).bytes,
            `${mesh.name}: ${name} returns exactly`,
          );
      assert.deepEqual(source, originalSource);
      assert.deepEqual(
        vegetation.records.map(({ id }) => id),
        source.trees.map(({ id }) => id),
      );
    } finally {
      const geometries = new Set(meshes.map((mesh) => mesh.geometry)),
        materials = new Set(meshes.map((mesh) => mesh.material));
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      vegetation.atlas.texture.dispose();
      scene.clear();
    }
  });
