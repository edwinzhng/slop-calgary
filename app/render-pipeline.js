// Screen-space reflections and lens treatment adapted from Slop New York (MIT).
import * as THREE from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  normalView,
  vec2,
  roughness,
  metalness,
  positionView,
  smoothstep,
} from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { compileSceneShaders } from './shader-warmup.js';

export function createCityPipeline(
  renderer,
  scene,
  camera,
  quality = 'balanced',
  { direct = false, prewarmOffscreen = true } = {},
) {
  // This combined SSR/MRT/bloom graph produced a black final image on the
  // tested WebGL2 backend. Keep its reliable direct path;
  // facade room/environment reflections and all city materials still render.
  if (direct || !renderer.backend.isWebGPUBackend)
    return {
      render: () => renderer.render(scene, camera),
      compile(onProgress) {
        // Road paint only overrides the reflection attachments. A direct
        // framebuffer has neither attachment and needs the ordinary color output.
        scene.traverse((object) => {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            if (material?.mrtNode) material.mrtNode = null;
          }
        });
        return compileSceneShaders(renderer, scene, camera, {
          onProgress,
          prewarmOffscreen: prewarmOffscreen && !renderer.backend.isWebGPUBackend,
        });
      },
      setQuality() {},
      setTime() {},
      dispose() {},
    };
  const scenePass = pass(scene, camera, { samples: 4 });
  // Render the city before the post-processing quad so warmup and live draws
  // share Three's render context instead of compiling the city a second time.
  scenePass.updateBeforeType = THREE.NodeUpdateType.NONE;
  scenePass.setup({ renderer });
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const fade = smoothstep(360, 180, positionView.z.negate());
  const attachments = mrt({
    output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(0.75).select(metalness.mul(fade), 0), roughness),
  });
  attachments.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  attachments.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(attachments);
  const color = scenePass.getTextureNode('output');
  const depth = scenePass.getTextureNode('depth');
  const normal = scenePass.getTextureNode('normal');
  const mr = scenePass.getTextureNode('metalRough');
  const reflections = ssr(color, depth, normal, {
    metalnessNode: mr.r,
    roughnessNode: mr.g,
    camera,
  });
  reflections.blurQuality = 1;
  reflections.maxDistance.value = 42;
  reflections.thickness.value = 0.85;
  reflections.binaryRefine = true;
  reflections.intensity.value = 0.5;
  reflections.screenEdgeFadeBlack = true;
  const mask = mr.r.greaterThan(0).select(smoothstep(0.75, 0.55, mr.g), 0);
  const grade = createPostProcessing(renderer, color, reflections.mul(mask));
  const pipeline = new THREE.RenderPipeline(renderer, grade.outputNode);
  const sceneFrame = { renderer };
  let prepared = false;
  function render() {
    const toneMapping = renderer.toneMapping,
      outputColorSpace = renderer.outputColorSpace,
      xr = renderer.xr.enabled,
      target = renderer.getRenderTarget(),
      previousMRT = renderer.getMRT(),
      autoClear = renderer.autoClear,
      autoClearColor = renderer.autoClearColor,
      autoClearDepth = renderer.autoClearDepth,
      autoClearStencil = renderer.autoClearStencil,
      transparent = renderer.transparent,
      opaque = renderer.opaque,
      lighting = renderer.lighting,
      contextNode = renderer.contextNode,
      layers = camera.layers.mask,
      overrideMaterial = scene.overrideMaterial,
      sceneName = scene.name;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    renderer.xr.enabled = false;
    try {
      scenePass.updateBefore(sceneFrame);
      // The final pipeline captures the player's output transform when it
      // builds its graph. Restore it before the grading pass is prepared.
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      renderer.xr.enabled = xr;
      pipeline.render();
    } finally {
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      renderer.xr.enabled = xr;
      renderer.setRenderTarget(target);
      renderer.setMRT(previousMRT);
      renderer.autoClear = autoClear;
      renderer.autoClearColor = autoClearColor;
      renderer.autoClearDepth = autoClearDepth;
      renderer.autoClearStencil = autoClearStencil;
      renderer.transparent = transparent;
      renderer.opaque = opaque;
      renderer.lighting = lighting;
      renderer.contextNode = contextNode;
      camera.layers.mask = layers;
      scene.overrideMaterial = overrideMaterial;
      scene.name = sceneName;
    }
  }
  function setQuality(value) {
    reflections.resolutionScale = value === 'high' ? 0.5 : value === 'performance' ? 0.12 : 0.27;
    reflections.quality.value = value === 'high' ? 0.25 : value === 'performance' ? 0.1 : 0.18;
    grade.setQuality(value);
  }
  setQuality(quality);
  return {
    antialias: 'MSAA4',
    render,
    async compile(onProgress) {
      // Initialize the actual post-processing attachments before compiling
      // their scene variants; otherwise the first full frame can compile again.
      if (!prepared) {
        const visible = scene.visible;
        scene.visible = false;
        try {
          render();
        } finally {
          scene.visible = visible;
        }
        prepared = true;
      }
      const target = renderer.getRenderTarget(),
        previousMRT = renderer.getMRT(),
        toneMapping = renderer.toneMapping,
        outputColorSpace = renderer.outputColorSpace,
        xr = renderer.xr.enabled;
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(attachments);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      renderer.xr.enabled = false;
      try {
        return await compileSceneShaders(renderer, scene, camera, { onProgress });
      } finally {
        renderer.setMRT(previousMRT);
        renderer.setRenderTarget(target);
        renderer.toneMapping = toneMapping;
        renderer.outputColorSpace = outputColorSpace;
        renderer.xr.enabled = xr;
      }
    },
    setQuality,
    setTime: (id) => grade.applyPreset({ day: 'midday', dusk: 'twilight', night: 'midnight' }[id] || id),
    dispose() {
      pipeline.dispose();
      reflections.dispose();
      scenePass.dispose();
    },
  };
}
