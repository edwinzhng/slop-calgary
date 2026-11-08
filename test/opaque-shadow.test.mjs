import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, positionGeometry, vec3, vec4 } from 'three/tsl';
import NodeBuilder from 'three/src/nodes/core/NodeBuilder.js';
import Renderer from 'three/src/renderers/common/Renderer.js';
import { buildingMaterial, facadeMaterial } from '../app/materials.js';

function colorBranch(material) {
  const call = material.colorNode;
  assert.equal(call?.isShaderCallNodeInternal, true, 'opaque shading retains a build-time color branch');
  assert.equal(call.rawInputs.length, 1);
  return { call, originalColor: call.rawInputs[0] };
}

function builderFor(mesh, renderer, material, camera) {
  const builder = new NodeBuilder(mesh, renderer, null);
  builder.material = material;
  builder.camera = camera;
  builder.setShaderStage('fragment');
  return builder;
}

for (const [name, factory] of [
  ['surveyed building material', buildingMaterial],
  ['palette facade material', () => facadeMaterial(0)],
  ['vertex-color facade material', () => facadeMaterial(8)],
]) {
  test(`${name} keeps its main color and casts opaque shadows without building facade shading`, () => {
    const material = factory().clone(),
      { call, originalColor } = colorBranch(material),
      geometry = new THREE.BoxGeometry(3, 8, 5),
      mesh = new THREE.Mesh(geometry, material),
      parent = new THREE.Group(),
      scene = new THREE.Scene(),
      sun = new THREE.DirectionalLight(),
      override = new THREE.NodeMaterial();
    // This optimization must be revisited if a factory gains cutouts or any
    // other source of non-opaque alpha. Photographic facades use other materials.
    assert.equal(material.opacity, 1);
    assert.equal(material.transparent, false);
    assert.equal(material.alphaTest, 0);
    assert.equal(material.alphaHash, false);
    for (const property of [
      'map',
      'alphaMap',
      'opacityNode',
      'alphaTestNode',
      'maskNode',
      'maskShadowNode',
      'castShadowNode',
    ])
      assert.equal(material[property], null, property);

    material.positionNode = positionGeometry.add(vec3(0.2, 0.4, -0.6));
    material.castShadowPositionNode = positionGeometry.add(vec3(-0.3, 0.5, 0.7));
    material.depthNode = float(0.4);
    const positionNode = material.positionNode,
      shadowPositionNode = material.castShadowPositionNode,
      depthNode = material.depthNode,
      normalNode = material.normalNode,
      geometryBefore = Object.fromEntries(
        Object.entries(geometry.attributes).map(([attribute, value]) => [attribute, value.array.slice()]),
      ),
      indexBefore = geometry.index.array.slice();
    mesh.position.set(2, 4, -6);
    parent.position.set(30, 7, -20);
    parent.rotation.y = 0.7;
    parent.scale.set(2, 3, 4);
    parent.add(mesh);
    scene.add(parent, sun);
    scene.updateMatrixWorld(true);
    const matrixBefore = mesh.matrixWorld.clone();
    sun.castShadow = true;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.7;
    const biasBefore = sun.shadow.bias,
      normalBiasBefore = sun.shadow.normalBias;
    override.isShadowPassMaterial = true;
    override.colorNode = vec4(0, 0, 0, 1);
    scene.overrideMaterial = override;

    const originalBuild = Object.getOwnPropertyDescriptor(originalColor, 'build'),
      stop = new Error('The main facade color graph was requested');
    let colorBuilds = 0,
      shadowDraws = 0;
    Object.defineProperty(originalColor, 'build', {
      configurable: true,
      value() {
        colorBuilds++;
        throw stop;
      },
    });
    const renderer = {
      _currentSourceMaterial: null,
      _cacheShadowNodes: new WeakMap(),
      _getShadowNodes: Renderer.prototype._getShadowNodes,
      shadowMap: { type: THREE.PCFShadowMap, transmitted: false },
      debug: { diagnostics: { keywords: false } },
      _handleObjectFunction(object, passedMaterial, passedScene, camera) {
        shadowDraws++;
        assert.equal(object, mesh);
        assert.equal(object.geometry, geometry);
        assert.equal(passedScene, scene);
        assert.equal(camera, sun.shadow.camera);
        assert.equal(passedMaterial, override);
        assert.equal(passedMaterial.positionNode, shadowPositionNode);
        assert.equal(passedMaterial.depthNode, depthNode);
        assert.equal(passedMaterial.side, THREE.BackSide);
        const builder = builderFor(object, renderer, passedMaterial, camera);
        let shadowColor = call.getOutputNode(builder).outputNode;
        while (shadowColor.isVarNode) shadowColor = shadowColor.node;
        assert.equal(shadowColor.isConstNode, true, 'shadow color is independent of facade shading');
        const type = shadowColor.getNodeType(builder);
        assert.ok(['vec3', 'color', 'vec4'].includes(type));
        // Three expands a vec3 color with alpha one; an explicit vec4 must
        // retain that opacity too. No shader source formatting is assumed.
        assert.equal(type === 'vec4' ? shadowColor.value.w : 1, 1, 'shadow alpha remains fully opaque');
        builder.flowStagesNode(passedMaterial.colorNode, 'vec4');
        assert.equal(colorBuilds, 0, 'the shadow graph never requests the complex color graph');
        assert.equal(builder.nodes.has(originalColor), false);
        assert.equal(builder.uniforms.fragment.length, 0, 'opaque shadow alpha needs no facade uniforms');
      },
    };
    try {
      // Exercise the real override and colorNode.a selection without a device.
      // Rasterized shadow equivalence remains a browser check.
      Renderer.prototype.renderObject.call(
        renderer,
        mesh,
        scene,
        sun.shadow.camera,
        geometry,
        material,
        null,
        null,
      );
      assert.equal(shadowDraws, 1);

      const mainBuilder = builderFor(mesh, renderer, material, new THREE.PerspectiveCamera()),
        mainColor = call.getOutputNode(mainBuilder).outputNode;
      assert.equal(mainColor, originalColor, 'main shading returns the exact original color node');
      assert.throws(
        () => mainColor.build(mainBuilder),
        (error) => error === stop,
      );
      assert.equal(colorBuilds, 1, 'the complex graph remains available to the main pass');

      assert.equal(material.positionNode, positionNode);
      assert.equal(material.castShadowPositionNode, shadowPositionNode);
      assert.equal(material.depthNode, depthNode);
      assert.equal(material.normalNode, normalNode);
      assert.equal(material.opacity, 1);
      assert.equal(sun.shadow.bias, biasBefore);
      assert.equal(sun.shadow.normalBias, normalBiasBefore);
      assert.equal(mesh.parent, parent);
      assert.equal(mesh.matrixWorld.equals(matrixBefore), true);
      assert.deepEqual(geometry.index.array, indexBefore);
      for (const [attribute, array] of Object.entries(geometryBefore))
        assert.deepEqual(geometry.attributes[attribute].array, array);
      assert.equal(renderer._currentSourceMaterial, null);
    } finally {
      if (originalBuild) Object.defineProperty(originalColor, 'build', originalBuild);
      else delete originalColor.build;
      geometry.dispose();
      material.dispose();
      override.dispose();
    }
  });
}
