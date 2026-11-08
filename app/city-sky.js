import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { cityUniforms } from './city-uniforms.js';
import {
  asin,
  atan,
  color,
  dot,
  floor,
  fract,
  fwidth,
  If,
  length,
  step,
  vec2,
  vec3,
  vec4,
  float,
  uniform,
  Fn,
  mix,
  mx_noise_float,
  smoothstep,
  normalize,
  positionWorld,
  cameraPosition,
} from 'three/tsl';
import { hash2D } from './render-nodes.js';

// Low cloud and mist tint the horizon as well as the overhead sky.
const layers = {
  overcast: { horizon: 0xaeb8bc, zenith: 0x8f9da9, cover: 1, contrast: 0.63 },
  rain: { horizon: 0x8a9ca8, zenith: 0x535f74, cover: 1, contrast: 1 },
  snow: { horizon: 0xc3d0d8, zenith: 0x8ea4bc, cover: 0.93, contrast: 0.66 },
  fog: { horizon: 0xa4b2b9, zenith: 0xa4b2b9, cover: 1, contrast: 0.07 },
};

export function createCitySky(scene, renderer) {
  const sky = new SkyMesh();
  sky.scale.setScalar(20000);
  sky.renderOrder = -2;
  scene.add(sky);
  const skyU = sky;
  skyU.turbidity.value = 6;
  skyU.rayleigh.value = 1.5;
  skyU.mieCoefficient.value = 0.005;
  skyU.mieDirectionalG.value = 0.85;
  const skyBrightness = uniform(0.16);
  const twilight = uniform(0),
    stars = uniform(0),
    cover = uniform(0),
    cloudContrast = uniform(0),
    cloudTint = uniform(cityUniforms.uSkyTopColor.value.clone());
  const daylight = sky.material.colorNode.rgb;
  sky.material.colorNode = Fn(() => {
    const direction = normalize(positionWorld.sub(cameraPosition)).toVar();
    const height = direction.y;
    const skyColor = cityUniforms.uSkyHorizonColor.toVar();
    If(cover.greaterThan(0), () => {
      const sheet = mx_noise_float(direction.mul(vec3(2.9, 7, 2.9)), 0.42, 0.5);
      const cloud = cloudTint.mul(mix(1, sheet.mul(0.8).add(0.64), cloudContrast));
      skyColor.assign(mix(cityUniforms.uSkyHorizonColor, cloud, smoothstep(0, 0.48, height)));
      If(cover.lessThan(1).and(twilight.equal(0)), () => {
        skyColor.assign(
          mix(daylight.mul(skyBrightness), skyColor, cover.max(float(1).sub(smoothstep(0, 0.13, height)))),
        );
      });
    })
      .ElseIf(twilight.greaterThan(0), () => {
        const night = twilight.sub(1);
        const duskBand = smoothstep(0.02, 0.62, height);
        const azimuthGlow = smoothstep(0.12, 0.96, dot(direction, cityUniforms.uSkySunDir));
        const sunset = mix(color(0x8268a4), color(0xeb9075), azimuthGlow);
        const low = mix(sunset, color(0x283a6b), night);
        const high = mix(color(0x293e87), color(0x0c173b), night);
        const gradient = mix(low, high, duskBand);
        skyColor.assign(mix(cityUniforms.uSkyHorizonColor, gradient, smoothstep(0, 0.075, height)));

        // Keep stars fixed on the sky dome, with an antialiased footprint at
        // phone resolutions. The PMREM pass uses the gradient alone.
        If(stars.greaterThan(0), () => {
          const grid = vec2(atan(direction.z, direction.x).mul(62), asin(height.clamp(-1, 1)).mul(78));
          const cell = floor(grid);
          const pick = hash2D(cell);
          const offset = vec2(hash2D(cell.add(vec2(37, 13))), hash2D(cell.add(vec2(71, 31))))
            .mul(0.6)
            .add(0.2);
          const width = length(fwidth(grid));
          const radius = mix(float(0.045), float(0.115), hash2D(cell.add(vec2(9, 19))));
          const sparkle = float(1).sub(
            smoothstep(radius.mul(0.35), radius.add(width.mul(0.55)), length(fract(grid).sub(offset))),
          );
          const visible = step(0.962, pick)
            .mul(smoothstep(0.09, 0.36, height))
            .mul(float(1).sub(smoothstep(0.35, 0.95, width)));
          skyColor.addAssign(
            mix(color(0x9ebcff), color(0xffe4bb), pick.sub(0.962).div(0.038))
              .mul(sparkle)
              .mul(visible)
              .mul(stars),
          );
        });
      })
      .Else(() => {
        skyColor.assign(
          mix(cityUniforms.uSkyHorizonColor, daylight.mul(skyBrightness), smoothstep(0, 0.07, height)),
        );
      });
    return vec4(skyColor, 1);
  })();
  if (renderer.reversedDepthBuffer) {
    const skyVertex = sky.material.vertexNode;
    sky.material.vertexNode = Fn(() => {
      const p = skyVertex.toVar();
      p.z.assign(0);
      return p;
    })();
  }

  let starBrightness = 0;
  let showSun = true;
  return {
    sky,
    setEnvironment(time, weather, sun, preset, top, horizon) {
      const layer = layers[weather.kind];
      const daylight = time === 'night' ? 0.09 : time === 'dusk' ? 0.37 : time === 'golden' ? 0.82 : 1;
      top.set(layer?.zenith ?? preset.sky);
      horizon.set(layer?.horizon ?? preset.fog);
      if (layer) {
        top.multiplyScalar(daylight);
        horizon.multiplyScalar(daylight);
      }
      twilight.value = time === 'night' ? 2 : time === 'dusk' ? 1 : 0;
      cover.value = layer?.cover ?? 0;
      cloudContrast.value = layer?.contrast ?? 0;
      cloudTint.value.copy(top);
      skyU.turbidity.value = 6 + weather.cloudCover * 12;
      skyU.cloudCoverage.value = 0.4 + weather.cloudCover * 0.55;
      skyU.cloudDensity.value = 0.4 + weather.cloudCover * 0.34;
      skyBrightness.value = 0.16 * (1 - weather.cloudCover * 0.34);
      skyU.sunPosition.value.copy(sun);
      starBrightness = layer ? 0 : time === 'night' ? 1.2 : time === 'dusk' ? 0.54 : 0;
      showSun = weather.cloudCover < 0.6;
    },
    setProbe(active) {
      sky.showSunDisc.value = !active && showSun ? 1 : 0;
      stars.value = active ? 0 : starBrightness;
    },
  };
}
