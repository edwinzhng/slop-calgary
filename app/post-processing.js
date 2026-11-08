// Adapted from mrdoob/slop-newyork (MIT); see THIRD_PARTY.md.
import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  dot,
  floor,
  fract,
  mix,
  min,
  max,
  pow,
  smoothstep,
  length,
  screenUV,
  screenSize,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// Scene-linear color grading and lens bloom, composed in the existing final render pass.

// Exposure and white balance belong to the camera, independently of the physical lighting presets.
// Keep exposure restrained for ACES; stronger bloom stays selective so midtones retain their contrast.
const LOOKS = {
  golden: {
    exposure: 1.04,
    contrast: 1.12,
    saturation: 1.08,
    balance: [1.045, 1.0, 0.955],
    bloom: 0.24,
    threshold: 1.2,
  },
  midday: {
    exposure: 1.0,
    contrast: 1.1,
    saturation: 1.06,
    balance: [1.015, 1.0, 0.985],
    bloom: 0.18,
    threshold: 1.35,
  },
  twilight: {
    exposure: 1.06,
    contrast: 1.1,
    saturation: 1.08,
    balance: [1.025, 0.995, 1.015],
    bloom: 0.28,
    threshold: 1.05,
  },
  midnight: {
    exposure: 1.04,
    contrast: 1.08,
    saturation: 1.06,
    balance: [0.985, 1.0, 1.035],
    bloom: 0.3,
    threshold: 1.0,
  },
};

function createPostProcessing(renderer, sceneColor, reflections) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Exposure is applied before bloom so its threshold follows the image's exposed brightness.
  // RenderPipeline performs ACES and the output color-space conversion exactly once, after this graph.
  renderer.toneMappingExposure = 1.0;

  const exposure = uniform(1.0);
  const contrast = uniform(1.0);
  const saturation = uniform(1.0);
  const balance = uniform(new THREE.Vector3(1, 1, 1));
  const exposed = max(sceneColor.rgb.add(reflections.rgb), vec3(0)).mul(exposure).mul(balance);

  // Limit only bloom's peak radiance, scaling RGB together to retain neon and lamp colors.
  // The original HDR image keeps its full range for the tone mapper's highlight shoulder.
  const peak = max(max(exposed.r, exposed.g), exposed.b);
  const bloomInput = vec4(exposed.mul(float(8.0).div(max(peak, 8.0))), 1.0);
  const bloomPass = bloom(bloomInput, 0.24, 0.4, 1.2);
  bloomPass.smoothWidth.value = 0.3;
  bloomPass.setResolutionScale(0.5);

  const outputNode = Fn(() => {
    const color = exposed.add(bloomPass.rgb).toVar();
    const luma = dot(color, vec3(0.2126, 0.7152, 0.0722)).toVar();

    // Gentle cool shadow / warm highlight separation; multiply rather than lifting the black level.
    const shadows = mix(vec3(0.965, 1.005, 1.045), vec3(1), smoothstep(0.02, 0.6, luma));
    const highlights = mix(vec3(1), vec3(1.035, 1.005, 0.965), smoothstep(0.6, 3.0, luma));
    color.mulAssign(shadows.mul(highlights));

    // Contrast pivots around middle gray and scales RGB together, avoiding per-channel gamma shifts.
    color.mulAssign(pow(max(luma, 0.0001).div(0.18), contrast.sub(1.0)));
    const gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
    const chroma = max(max(color.r, color.g), color.b).sub(min(min(color.r, color.g), color.b));
    const vibrance = float(0.1).mul(
      float(1).sub(chroma.div(max(max(max(color.r, color.g), color.b), 0.0001))),
    );
    color.assign(max(mix(vec3(gray), color, saturation.add(vibrance)), vec3(0)));

    // Compress diffuse midtones into soft bands. Work on luminance so warm
    // brick and blue glass keep their hue, and fade out before bright lamps.
    const level = pow(max(gray, 0.001), 0.5).mul(9);
    const band = floor(level).add(smoothstep(0.34, 0.66, fract(level)));
    const ratio = pow(band.div(max(level, 0.01)), 2);
    const diffuse = smoothstep(0.015, 0.06, gray).mul(float(1).sub(smoothstep(0.68, 1.6, gray)));
    color.mulAssign(mix(float(1), ratio, diffuse.mul(0.57)));

    // Normalize by the corner radius so the lens falloff remains subtle in portrait and landscape.
    const aspect = screenSize.x.div(screenSize.y);
    const radius = length(screenUV.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
    const vignette = float(1).sub(smoothstep(0.35, 1.0, radius).mul(0.12));
    return vec4(color.mul(vignette), 1.0);
  })();

  function applyPreset(id) {
    const look = LOOKS[id] || LOOKS.golden;
    exposure.value = look.exposure;
    contrast.value = look.contrast;
    saturation.value = look.saturation;
    balance.value.set(...look.balance);
    bloomPass.strength.value = look.bloom;
    bloomPass.threshold.value = look.threshold;
  }

  applyPreset('golden');
  return {
    outputNode,
    applyPreset,
    setQuality(value) {
      bloomPass.setResolutionScale(value === 'performance' ? 0.25 : value === 'balanced' ? 0.35 : 0.5);
    },
  };
}

export { createPostProcessing };
