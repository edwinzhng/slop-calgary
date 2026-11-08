import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { context, mrt, output } from 'three/tsl';
import { createCityPipeline } from '../app/render-pipeline.js';
import { createMobileResolutionBudget } from '../app/render-stability.js';

test('adaptive resolution responds to sustained slow frames and recovers with hysteresis', () => {
  const budget = createMobileResolutionBudget();
  for (let frame = 0; frame < 100; frame++) budget.update(frame % 30 === 0 ? 150 : 16);
  assert.equal(budget.scale, 1);
  budget.update(0);
  for (let frame = 0; frame < 20; frame++) budget.update(28);
  budget.update(1500);
  for (let frame = 0; frame < 20; frame++) budget.update(28);
  assert.equal(budget.scale, 1, 'a suspended frame clears the current sampling window');
  budget.update(0);
  for (const scale of [0.86, 0.74, 0.62]) {
    for (let frame = 0; frame < 30; frame++) budget.update(22);
    assert.equal(budget.scale, scale);
  }
  for (const [before, after] of [
    [0.62, 0.74],
    [0.74, 0.86],
    [0.86, 1],
  ]) {
    for (let frame = 0; frame < 562; frame++) budget.update(16);
    assert.equal(budget.scale, before);
    assert.equal(budget.update(16), true);
    assert.equal(budget.scale, after);
  }
});

function gpuFixture(t) {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(55, 1.6, 0.2, 500),
    geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshStandardNodeMaterial(),
    mesh = new THREE.Mesh(geometry, material),
    rootTarget = new THREE.RenderTarget(17, 23),
    rootMRT = mrt({ output }),
    size = new THREE.Vector2(640, 400),
    draws = [],
    compiles = [],
    nodeFrame = new THREE.NodeFrame();
  mesh.position.z = -10;
  scene.name = 'Test city';
  scene.add(mesh);
  let target = rootTarget,
    attachments = rootMRT,
    cityPass;
  const renderer = {
    backend: { isWebGPUBackend: true },
    samples: 1,
    reversedDepthBuffer: false,
    toneMapping: THREE.ReinhardToneMapping,
    toneMappingExposure: 0.85,
    outputColorSpace: THREE.SRGBColorSpace,
    xr: { enabled: true },
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: false,
    transparent: false,
    opaque: false,
    lighting: false,
    contextNode: context({ root: true }),
    getOutputBufferType: () => THREE.HalfFloatType,
    getOutputRenderTarget: () => null,
    getDrawingBufferSize: (result) => result.copy(size),
    getRenderTarget: () => target,
    setRenderTarget: (value) => {
      target = value;
    },
    getMRT: () => attachments,
    setMRT: (value) => {
      attachments = value;
    },
    render(object, drawCamera) {
      draws.push({ object, camera: drawCamera, ...state(), visible: scene.visible });
      if (object === scene) {
        if (renderer.failCity) throw renderer.failCity;
      } else {
        assert.equal(object.isQuadMesh, true, 'post processing uses the real RenderPipeline quad');
        // Exercise Three's scheduler at the place where it would discover
        // the pass through the post-processing graph. A manual city pass
        // must not run again when a texture consumer updates its nodes.
        nodeFrame.renderer = renderer;
        nodeFrame.frameId++;
        nodeFrame.renderId++;
        nodeFrame.updateBeforeNode(cityPass);
        if (renderer.failPost) throw renderer.failPost;
      }
    },
    async compileAsync(object, drawCamera, rootScene) {
      compiles.push({ object, camera: drawCamera, scene: rootScene, ...state() });
      if (renderer.failCompile) throw renderer.failCompile;
    },
  };
  function state() {
    return {
      target: renderer.getRenderTarget(),
      mrt: renderer.getMRT(),
      toneMapping: renderer.toneMapping,
      outputColorSpace: renderer.outputColorSpace,
      xr: renderer.xr.enabled,
      autoClear: renderer.autoClear,
      autoClearColor: renderer.autoClearColor,
      autoClearDepth: renderer.autoClearDepth,
      autoClearStencil: renderer.autoClearStencil,
      transparent: renderer.transparent,
      opaque: renderer.opaque,
      lighting: renderer.lighting,
      contextNode: renderer.contextNode,
      cameraLayers: camera.layers.mask,
      overrideMaterial: scene.overrideMaterial,
      sceneName: scene.name,
    };
  }
  // Observe the real pass instead of replacing its target, state management,
  // rendering, or scheduler methods with a second implementation.
  const setup = THREE.PassNode.prototype.setup;
  t.mock.method(THREE.PassNode.prototype, 'setup', function (...args) {
    const result = setup.apply(this, args);
    if (this.scene === scene) cityPass = this;
    return result;
  });
  const pipeline = createCityPipeline(renderer, scene, camera);
  assert.ok(cityPass instanceof THREE.PassNode);
  t.after(() => {
    pipeline.dispose();
    rootTarget.dispose();
    geometry.dispose();
    material.dispose();
  });
  return { renderer, pipeline, scene, camera, mesh, cityPass, size, draws, compiles, state };
}

function assertState(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `restore ${key}`);
}

test('WebGPU renders one city MRT pass before the post quad and restores the output transform', (t) => {
  const f = gpuFixture(t),
    root = f.state();
  f.pipeline.render();
  assert.equal(f.draws.length, 2);
  const [city, post] = f.draws;
  assert.equal(city.object, f.scene);
  assert.equal(city.camera, f.camera);
  assert.equal(city.target, f.cityPass.renderTarget);
  assert.equal(city.mrt, f.cityPass.getMRT());
  assert.equal(city.target.samples, 4);
  assert.equal(city.target.storeMultisampledColorBuffer, false);
  assert.deepEqual(
    city.target.textures.map((texture) => texture.name),
    ['output', 'normal', 'metalRough'],
  );
  assert.deepEqual([city.target.width, city.target.height], f.size.toArray());
  assert.equal(city.toneMapping, THREE.NoToneMapping);
  assert.equal(city.outputColorSpace, THREE.ColorManagement.workingColorSpace);
  assert.equal(city.xr, false);
  assert.equal(city.autoClear, true);
  assert.equal(city.transparent, true);
  assert.equal(city.opaque, true);
  assert.equal(post.target, root.target);
  assert.equal(post.mrt, root.mrt);
  const finalColor = post.object.material.fragmentNode;
  assert.equal(finalColor.isRenderOutputNode, true);
  assert.equal(
    finalColor.getToneMapping(),
    root.toneMapping,
    'post processing retains the final tone mapper',
  );
  assert.equal(finalColor.outputColorSpace, root.outputColorSpace);
  assertState(f.state(), root);

  f.size.set(810, 540);
  f.renderer.toneMapping = THREE.CineonToneMapping;
  f.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const nextRoot = f.state();
  f.pipeline.render();
  assert.deepEqual(
    f.draws.map((draw) => (draw.object === f.scene ? 'city' : 'post')),
    ['city', 'post', 'city', 'post'],
  );
  assert.deepEqual([f.cityPass.renderTarget.width, f.cityPass.renderTarget.height], [810, 540]);
  const nextColor = f.draws[3].object.material.fragmentNode;
  assert.equal(nextColor.getToneMapping(), nextRoot.toneMapping);
  assert.equal(nextColor.outputColorSpace, nextRoot.outputColorSpace);
  assertState(f.state(), nextRoot);
});

test('warmup compiles the same city target and MRT state used by live rendering', async (t) => {
  const f = gpuFixture(t),
    root = f.state();
  assert.deepEqual(await f.pipeline.compile(), { jobs: 1, objects: 1 });
  assert.equal(f.draws.length, 2);
  assert.equal(f.draws[0].object, f.scene);
  assert.equal(f.draws[0].visible, false);
  assert.equal(f.scene.visible, true);
  assert.equal(f.compiles.length, 1);
  const compile = f.compiles[0];
  assert.equal(compile.object, f.mesh);
  assert.equal(compile.camera, f.camera);
  assert.equal(compile.scene, f.scene);
  assert.equal(compile.target, f.draws[0].target);
  assert.equal(compile.mrt, f.draws[0].mrt);
  assert.equal(compile.target.samples, 4);
  assert.equal(compile.toneMapping, THREE.NoToneMapping);
  assert.equal(compile.outputColorSpace, THREE.ColorManagement.workingColorSpace);
  assert.equal(compile.xr, false);
  assertState(f.state(), root);
  await f.pipeline.compile();
  assert.equal(f.draws.length, 2, 'a second compile reuses the initialized attachments');
  assertState(f.state(), root);
});

test('a failed city draw restores the root render state before rethrowing', (t) => {
  const f = gpuFixture(t),
    root = f.state(),
    failure = new Error('city render failed');
  const layers = new THREE.Layers();
  layers.set(1);
  f.cityPass.setLayers(layers);
  f.cityPass.overrideMaterial = f.mesh.material;
  f.cityPass.name = 'G-buffer city';
  f.cityPass.lighting = true;
  f.cityPass.contextNode = context({ city: true });
  f.renderer.failCity = failure;
  assert.throws(() => f.pipeline.render(), failure);
  assert.equal(f.draws.length, 1, 'post processing must not consume an incomplete city target');
  assertState(f.state(), root);
  f.renderer.failCity = null;
  f.pipeline.render();
  assert.equal(f.draws.length, 3);
  assertState(f.state(), root);
});

test('a failed post quad restores the root tone mapper, color space and XR state', (t) => {
  const f = gpuFixture(t),
    root = f.state(),
    failure = new Error('post render failed');
  f.renderer.failPost = failure;
  assert.throws(() => f.pipeline.render(), failure);
  assertState(f.state(), root);
  f.renderer.failPost = null;
  f.pipeline.render();
  assert.equal(f.draws.length, 4);
  assertState(f.state(), root);
});

test('failed shader compilation restores render state and scene visibility', async (t) => {
  const f = gpuFixture(t),
    root = f.state(),
    failure = new Error('compile failed');
  f.renderer.failCompile = failure;
  await assert.rejects(f.pipeline.compile(), failure);
  assert.equal(f.scene.visible, true);
  assert.equal(f.scene.matrixWorldAutoUpdate, true);
  assertState(f.state(), root);
});

test('failed warmup rendering restores scene visibility and can be retried', async (t) => {
  const f = gpuFixture(t),
    root = f.state(),
    failure = new Error('warmup render failed');
  f.renderer.failCity = failure;
  await assert.rejects(f.pipeline.compile(), failure);
  assert.equal(f.scene.visible, true);
  assert.equal(f.compiles.length, 0);
  assertState(f.state(), root);
  f.renderer.failCity = null;
  assert.deepEqual(await f.pipeline.compile(), { jobs: 1, objects: 1 });
  assert.equal(f.scene.visible, true);
  assertState(f.state(), root);
});

test('WebGL2 compatibility renders and compiles the scene through the direct path', async () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(),
    mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial()),
    calls = [],
    compiles = [];
  mesh.position.z = -2;
  scene.add(mesh);
  const renderer = {
    backend: { isWebGPUBackend: false },
    toneMappingExposure: 0.85,
    render: (s, c) => calls.push([s, c]),
    compileAsync: async (s, c, root) => {
      compiles.push([s, c, root]);
    },
  };
  const pipeline = createCityPipeline(renderer, scene, camera);
  pipeline.setQuality('high');
  pipeline.setTime('night');
  pipeline.render();
  assert.deepEqual(await pipeline.compile(), { jobs: 1, objects: 1 });
  pipeline.dispose();
  assert.deepEqual(calls, [[scene, camera]]);
  assert.deepEqual(compiles, [[mesh, camera, scene]]);
  assert.equal(renderer.toneMappingExposure, 0.85);
});
