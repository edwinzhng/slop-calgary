import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { compileSceneShaders } from '../app/shader-warmup.js';

test('shader jobs overlap independent materials while serializing a shared material and preserving scene state', async () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(),
    geometry = new THREE.BoxGeometry(),
    a = new THREE.MeshBasicMaterial(),
    b = new THREE.MeshBasicMaterial(),
    meshes = [new THREE.Mesh(geometry, a), new THREE.Mesh(geometry, a), new THREE.Mesh(geometry, b)],
    hidden = new THREE.Group(),
    behind = new THREE.Mesh(geometry, b),
    empty = new THREE.InstancedMesh(geometry, a, 1);
  behind.position.z = 100;
  empty.count = 0;
  hidden.visible = false;
  hidden.add(new THREE.Mesh(geometry, b));
  scene.add(...meshes, hidden, behind, empty);
  const activeMaterials = new Set(),
    compiled = [],
    progress = [];
  let concurrent = 0,
    peak = 0;
  try {
    const result = await compileSceneShaders(
      {
        async compileAsync(object, passedCamera, passedScene) {
          assert.equal(passedCamera, camera);
          assert.equal(passedScene, scene);
          assert.equal(scene.matrixWorldAutoUpdate, false);
          assert.equal(activeMaterials.has(object.material), false);
          activeMaterials.add(object.material);
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 8));
          compiled.push(object);
          concurrent--;
          activeMaterials.delete(object.material);
        },
      },
      scene,
      camera,
      { concurrency: 2, onProgress: (p) => progress.push(p.completed) },
    );
    assert.equal(peak, 2);
    assert.deepEqual(new Set(compiled), new Set(meshes));
    assert.deepEqual(result, { jobs: 2, objects: 3 });
    assert.deepEqual(progress, [1, 2]);
    assert.equal(
      meshes.every((mesh) => mesh.frustumCulled),
      true,
    );
    assert.equal(hidden.visible, false);
    assert.equal(empty.visible, true);
    assert.equal(scene.matrixWorldAutoUpdate, true);
  } finally {
    geometry.dispose();
    a.dispose();
    b.dispose();
  }
});

test('a failed compilation waits for every in-flight job before returning renderer ownership', async () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(),
    geometry = new THREE.BoxGeometry(),
    materials = Array.from({ length: 3 }, () => new THREE.MeshBasicMaterial());
  for (const material of materials) scene.add(new THREE.Mesh(geometry, material));
  let active = 0,
    completedSlowJob = false,
    calls = 0;
  try {
    await assert.rejects(
      compileSceneShaders(
        {
          async compileAsync(object) {
            active++;
            calls++;
            try {
              if (object.material === materials[0]) {
                await new Promise((resolve) => setTimeout(resolve, 1));
                throw Error('GPU compile failed');
              }
              await new Promise((resolve) => setTimeout(resolve, 15));
              completedSlowJob = true;
            } finally {
              active--;
            }
          },
        },
        scene,
        camera,
        { concurrency: 2 },
      ),
      /GPU compile failed/,
    );
    assert.equal(active, 0);
    assert.equal(completedSlowJob, true);
    assert.equal(calls, 2, 'no later jobs begin after the failure');
    assert.equal(scene.matrixWorldAutoUpdate, true);
  } finally {
    geometry.dispose();
    for (const material of materials) material.dispose();
  }
});

test('warmup defers two-pass transparent faces while retaining safe material variants', async () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(55, 1.6, 0.2, 100),
    geometry = new THREE.BoxGeometry(),
    opaqueDouble = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    transparentFront = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.FrontSide }),
    transparentBack = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.BackSide }),
    transparentSingle = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
    transparentTwoPass = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      forceSinglePass: false,
    }),
    hiddenTransparent = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      forceSinglePass: false,
      visible: false,
    }),
    materials = [
      opaqueDouble,
      transparentFront,
      transparentBack,
      transparentSingle,
      transparentTwoPass,
      hiddenTransparent,
    ],
    safe = [opaqueDouble, transparentFront, transparentBack, transparentSingle].map(
      (material) => new THREE.Mesh(geometry, material),
    ),
    safeArray = new THREE.Mesh(geometry, [opaqueDouble, transparentBack]),
    deferred = [
      new THREE.Mesh(geometry, transparentTwoPass),
      new THREE.Mesh(geometry, [opaqueDouble, transparentTwoPass]),
      new THREE.InstancedMesh(geometry, transparentTwoPass, 1),
      new THREE.Mesh(geometry, hiddenTransparent),
    ],
    expected = [...safe, safeArray],
    all = [...expected, ...deferred],
    initialSides = materials.map((material) => material.side),
    initialVisibility = materials.map((material) => material.visible),
    compiled = [];
  for (const mesh of all) mesh.position.z = -5;
  scene.add(...all);
  try {
    const result = await compileSceneShaders(
      {
        async compileAsync(object) {
          assert.equal(
            transparentTwoPass.visible,
            false,
            'defer every use of the unsafe material during warmup',
          );
          compiled.push(object);
        },
      },
      scene,
      camera,
    );
    assert.deepEqual(new Set(compiled), new Set(expected));
    assert.deepEqual(result, { jobs: 5, objects: 5 });
    assert.deepEqual(
      materials.map((material) => material.side),
      initialSides,
    );
    assert.deepEqual(
      materials.map((material) => material.visible),
      initialVisibility,
    );
    assert.equal(transparentSingle.forceSinglePass, true);
    assert.equal(transparentTwoPass.forceSinglePass, false);
    assert.ok(
      all.every((object) => object.visible),
      'deferring warmup must not hide live geometry',
    );
    assert.equal(scene.matrixWorldAutoUpdate, true);
  } finally {
    for (const mesh of deferred) if (mesh.isInstancedMesh) mesh.dispose();
    geometry.dispose();
    for (const material of materials) material.dispose();
  }
});

test('a safe mesh parent cannot compile a deferred transparent child through recursive traversal', async () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(55, 1.6, 0.2, 100),
    geometry = new THREE.BoxGeometry(),
    opaque = new THREE.MeshBasicMaterial(),
    transparent = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      forceSinglePass: false,
    }),
    emptyTransparent = transparent.clone(),
    parent = new THREE.Mesh(geometry, opaque),
    child = new THREE.Mesh(geometry, transparent),
    emptyChild = new THREE.InstancedMesh(geometry, emptyTransparent, 1),
    sibling = new THREE.Mesh(geometry, opaque),
    independent = new THREE.Mesh(geometry, opaque),
    childLight = new THREE.PointLight(),
    encountered = new Set(),
    lights = new Set();
  child.add(childLight);
  emptyChild.count = 0;
  parent.position.z = independent.position.z = -5;
  parent.add(child, emptyChild, sibling);
  scene.add(parent, independent);
  try {
    await compileSceneShaders(
      {
        async compileAsync(object) {
          // Three's compileAsync projects the passed root and its visible
          // descendants. Check the work the renderer would actually receive.
          object.traverseVisible((descendant) => {
            if (descendant.isLight) lights.add(descendant);
            if (!descendant.isMesh) return;
            const faces = Array.isArray(descendant.material) ? descendant.material : [descendant.material];
            if (!faces.some((material) => material.visible)) return;
            assert.notEqual(
              descendant,
              child,
              'a deferred material must not leak through a compiled ancestor',
            );
            assert.notEqual(descendant, emptyChild, 'Three also precompiles zero-count child geometry');
            encountered.add(descendant);
          });
        },
      },
      scene,
      camera,
    );
    assert.ok(encountered.has(sibling));
    assert.ok(encountered.has(independent));
    assert.ok(lights.has(childLight), 'deferring a material must retain its child lights');
    assert.equal(child.visible, true);
    assert.equal(transparent.visible, true);
    assert.equal(emptyTransparent.visible, true);
    assert.equal(emptyChild.count, 0);
    assert.equal(transparent.side, THREE.DoubleSide);
    assert.equal(scene.matrixWorldAutoUpdate, true);
  } finally {
    emptyChild.dispose();
    geometry.dispose();
    opaque.dispose();
    transparent.dispose();
    emptyTransparent.dispose();
  }
});

test('a failed warmup leaves deferred transparent objects available for the live render', async () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(55, 1.6, 0.2, 100),
    geometry = new THREE.BoxGeometry(),
    opaque = new THREE.MeshBasicMaterial(),
    transparent = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      forceSinglePass: false,
    }),
    hiddenTransparent = transparent.clone(),
    solid = new THREE.Mesh(geometry, opaque),
    rain = new THREE.InstancedMesh(geometry, transparent, 2),
    hiddenRain = new THREE.Mesh(geometry, hiddenTransparent),
    failure = new Error('warmup failed');
  solid.position.z = rain.position.z = -5;
  hiddenRain.position.z = -5;
  hiddenTransparent.visible = false;
  scene.add(solid, rain, hiddenRain);
  try {
    await assert.rejects(
      compileSceneShaders(
        {
          async compileAsync() {
            assert.equal(transparent.visible, false);
            assert.equal(hiddenTransparent.visible, false);
            assert.equal(rain.visible, true, 'only the material is deferred');
            throw failure;
          },
        },
        scene,
        camera,
      ),
      failure,
    );
    assert.equal(rain.visible, true);
    assert.equal(rain.count, 2);
    assert.equal(rain.material, transparent);
    assert.equal(transparent.visible, true);
    assert.equal(hiddenTransparent.visible, false, 'a previously hidden material stays hidden');
    assert.equal(transparent.side, THREE.DoubleSide);
    assert.equal(scene.matrixWorldAutoUpdate, true);
  } finally {
    rain.dispose();
    geometry.dispose();
    opaque.dispose();
    transparent.dispose();
    hiddenTransparent.dispose();
  }
});
