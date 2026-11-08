import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  color,
  float,
  interleavedGradientNoise,
  max,
  mix,
  mrt,
  normalWorldGeometry,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { cityUniforms } from './city-uniforms.js';
import { project } from './geo.js';
import { noise2D } from './render-nodes.js';
import regionalProfile from '../data/calgary-horizon.json' with { type: 'json' };
import foothillGrid from '../data/calgary-foothills.json' with { type: 'json' };

const radius = 16000,
  candidateLimit = 8;

export function createRegionalGround(scene, bbox, cityGroundMaterial) {
  const [minX, minZ] = project(bbox.west, bbox.north);
  const [maxX, maxZ] = project(bbox.east, bbox.south);
  const { size, spacingM, unitM, data } = foothillGrid;
  const buffer = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const heights = new DataView(buffer.buffer);
  const blendStart = 580;
  const pad = 520;
  const cityGround = new THREE.Mesh(
    new THREE.PlaneGeometry(maxX - minX + 2 * pad, maxZ - minZ + 2 * pad),
    cityGroundMaterial,
  );
  cityGround.name = 'Calgary ground plane';
  cityGround.rotation.x = -Math.PI / 2;
  cityGround.position.set((minX + maxX) * 0.5, -0.04, (minZ + maxZ) * 0.5);
  cityGround.receiveShadow = true;
  scene.add(cityGround);

  const positions = new Float32Array(size * size * 3),
    colors = new Float32Array(positions.length),
    indices = [],
    ground = new THREE.Color(0x929285),
    grassland = new THREE.Color(0x6c7558),
    hill = new THREE.Color(0x495e49),
    rock = new THREE.Color(0x9a8a6e),
    tint = new THREE.Color();
  // The elevation apron starts beyond the playable rectangle. Taper it into
  // the existing ground plane before measured relief takes over.
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const i = row * size + column;
      const x = (column - (size - 1) * 0.5) * spacingM;
      const z = (row - (size - 1) * 0.5) * spacingM;
      const outside = Math.max(minX - x, x - maxX, minZ - z, z - maxZ);
      const coverage = THREE.MathUtils.smoothstep(outside, blendStart, 2350);
      const elevation = heights.getInt16(i * 2, true) * unitM;
      positions.set([x, -0.1 + elevation * coverage, z], i * 3);
      const relief = THREE.MathUtils.smoothstep(elevation, 25, 160);
      const patch = 0.5 + Math.sin(x * 0.00094 + Math.cos(z * 0.0016)) * Math.sin(z * 0.0013) * 0.5;
      tint
        .copy(grassland)
        .lerp(hill, relief * 0.82)
        .lerp(rock, patch * 0.46);
      tint.lerp(ground, 1 - coverage).toArray(colors, i * 3);
      if (row + 1 < size && column + 1 < size && outside > -spacingM * 2)
        indices.push(i, i + size, i + 1, i + 1, i + size, i + size + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const land = positionWorld.xz.mul(0.0017);
  const patch = noise2D(land.mul(vec2(0.58, 1.24)))
    .mul(0.64)
    .add(noise2D(land.mul(2.8)).mul(0.36));
  const grade = smoothstep(0.85, 0.997, normalWorldGeometry.y);
  const tone = mix(0.68, 1.28, patch).mul(grade.mul(0.33).add(0.67));
  const inHills = smoothstep(0.5, 34, positionWorld.y.add(0.1).abs());
  const diffuse = attribute('color', 'vec3').mul(mix(1, tone, inHills));
  material.colorNode = mix(diffuse, color(0xdde5e4), cityUniforms.uSnow.mul(0.81));
  const foothills = new THREE.Mesh(geometry, material);
  foothills.name = 'Regional elevation apron';
  scene.add(foothills);
  return { cityGround, foothills };
}

export function decodeHorizonProfile(profile = regionalProfile) {
  const { samples, bandsM, cameraHeightM, encoding, refinedSector } = profile;
  const refined =
    profile.version === 2 &&
    refinedSector?.length === 2 &&
    refinedSector.every(Number.isInteger) &&
    refinedSector[0] >= 0 &&
    refinedSector[1] <= 360 &&
    refinedSector[0] < refinedSector[1];
  if (
    (!refined && profile.version !== 1) ||
    samples !== (refined ? 360 + 3 * (refinedSector[1] - refinedSector[0]) : 360) ||
    bandsM?.length !== 3 ||
    cameraHeightM?.length !== 2 ||
    !cameraHeightM.every(Number.isFinite) ||
    cameraHeightM[0] >= cameraHeightM[1] ||
    encoding?.maxCandidates !== candidateLimit ||
    !Number.isFinite(encoding.interceptUnit) ||
    encoding.interceptUnit <= 0 ||
    !bandsM.every(
      (band) => band.length === 2 && band.every(Number.isFinite) && band[0] > 0 && band[1] > band[0],
    ) ||
    encoding.inverseDistanceBase?.length !== bandsM.length ||
    encoding.inverseDistanceUnit?.length !== bandsM.length ||
    !encoding.inverseDistanceBase.every((value) => Number.isFinite(value) && value > 0) ||
    !encoding.inverseDistanceUnit.every((value) => Number.isFinite(value) && value > 0)
  )
    throw new Error('Unsupported regional horizon profile');
  const bearings = Array.from({ length: 360 }, (_, bearing) => bearing).flatMap((bearing) =>
    refined && bearing >= refinedSector[0] && bearing < refinedSector[1]
      ? [bearing, bearing + 0.25, bearing + 0.5, bearing + 0.75]
      : [bearing],
  );
  const bytes = Uint8Array.from(atob(encoding.data), (c) => c.charCodeAt(0)),
    groups = samples * bandsM.length,
    view = new DataView(bytes.buffer),
    coefficients = new Float32Array(groups * candidateLimit * 2);
  let offset = groups;
  for (let group = 0; group < groups; group++) {
    const count = bytes[group],
      band = Math.floor(group / samples),
      start = group * candidateLimit * 2;
    if (!count || count > candidateLimit) throw new Error('Invalid regional horizon candidate count');
    for (let i = 0; i < count; i++) {
      if (offset + 4 > bytes.length) throw new Error('Incomplete regional horizon profile');
      coefficients[start + i * 2] = view.getInt16(offset, true) * encoding.interceptUnit;
      coefficients[start + i * 2 + 1] =
        encoding.inverseDistanceBase[band] +
        view.getUint16(offset + 2, true) * encoding.inverseDistanceUnit[band];
      offset += 4;
    }
    const last = start + (count - 1) * 2;
    for (let i = count; i < candidateLimit; i++) {
      coefficients[start + i * 2] = coefficients[last];
      coefficients[start + i * 2 + 1] = coefficients[last + 1];
    }
  }
  if (offset !== bytes.length) throw new Error('Unexpected regional horizon profile bytes');
  return { samples, bearings, bandsM, cameraHeightM, coefficients };
}

export function createRegionalHorizon(scene, { useMRT = false } = {}) {
  const profile = decodeHorizonProfile(),
    bandsM = profile.bandsM,
    vertices = (profile.samples + 1) * 2,
    positions = new Float32Array(vertices * 3),
    coefficientStride = candidateLimit * 2 * bandsM.length,
    coefficients = new Float32Array(vertices * coefficientStride),
    indices = [],
    layerColors = [uniform(new THREE.Color()), uniform(new THREE.Color()), uniform(new THREE.Color())],
    haze = uniform(new THREE.Color()),
    snowLight = uniform(new THREE.Color()),
    snowVisibility = uniform(0),
    heightRange = profile.cameraHeightM,
    observerHeight = clamp(cameraPosition.y, heightRange[0], heightRange[1]);
  for (let i = 0; i <= profile.samples; i++) {
    const bearing = THREE.MathUtils.degToRad(profile.bearings[i % profile.samples]);
    for (let row = 0; row < 2; row++) {
      const vertex = i * 2 + row;
      positions.set([Math.sin(bearing), row, -Math.cos(bearing)], vertex * 3);
      for (let band = 0; band < bandsM.length; band++) {
        const source = (band * profile.samples + (i % profile.samples)) * candidateLimit * 2;
        for (let candidate = 0; candidate < candidateLimit; candidate++) {
          const at = vertex * coefficientStride + band * candidateLimit * 2 + candidate * 2;
          coefficients[at] = profile.coefficients[source + candidate * 2];
          coefficients[at + 1] = profile.coefficients[source + candidate * 2 + 1];
        }
      }
    }
    if (i < profile.samples) {
      const bottom = i * 2;
      indices.push(bottom, bottom + 2, bottom + 1, bottom + 2, bottom + 3, bottom + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Thirteen attribute locations fit WebGPU/WebGL, but thirteen separate
  // vertex buffers exceed WebGPU's default eight-buffer limit.
  const coefficientBuffer = new THREE.InterleavedBuffer(coefficients, coefficientStride);
  for (let i = 0; i < coefficientStride / 4; i++)
    geometry.setAttribute(`horizon${i}`, new THREE.InterleavedBufferAttribute(coefficientBuffer, 4, i * 4));
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicNodeMaterial({ fog: false, depthWrite: false, alphaToCoverage: true });
  material.lights = false;
  // Source coefficients already include Earth curvature and the local datum.
  // Use actual camera height once; keep world +x east and -z true north.
  const slopes = [];
  for (let band = 0; band < bandsM.length; band++) {
    let slope;
    for (let i = 0; i < candidateLimit / 2; i++) {
      const pairs = attribute(`horizon${band * (candidateLimit / 2) + i}`, 'vec4'),
        first = pairs.x.sub(observerHeight.mul(pairs.y)),
        second = pairs.z.sub(observerHeight.mul(pairs.w));
      slope = slope ? max(slope, max(first, second)) : max(first, second);
    }
    slopes.push(slope);
  }
  const position = attribute('position', 'vec3'),
    outerSlope = max(slopes[0], max(slopes[1], slopes[2])),
    surfaceSlope = mix(-0.8, outerSlope, position.y),
    ridges = varying(vec3(...slopes), 'horizonRidges'),
    sampleSlope = varying(surfaceSlope, 'horizonSample'),
    near = sampleSlope.lessThanEqual(ridges.x),
    middle = sampleSlope.lessThanEqual(ridges.y),
    activeRidge = near.select(ridges.x, middle.select(ridges.y, ridges.z)),
    terrainColor = near.select(layerColors[0], middle.select(layerColors[1], layerColors[2])),
    clearance = max(ridges.x, max(ridges.y, ridges.z)).sub(sampleSlope),
    belowRidge = activeRidge.sub(sampleSlope).max(0),
    ridgeContrast = float(1).sub(smoothstep(0, 0.027, belowRidge)),
    contrast = smoothstep(heightRange[0] - 256, heightRange[0], cameraPosition.y).mul(
      float(1).sub(smoothstep(heightRange[1], heightRange[1] + 256, cameraPosition.y)),
    );
  material.positionNode = cameraPosition.add(
    vec3(position.x.mul(radius), surfaceSlope.mul(radius), position.z.mul(radius)),
  );
  const direction = varying(position.xz, 'horizonDirection');
  const slopeAspect = sin(direction.x.mul(193).add(direction.y.mul(131))).add(
    sin(direction.x.mul(339).sub(direction.y.mul(167))).mul(0.45),
  );
  const snowline = slopeAspect.mul(0.0019).add(0.0054);
  // Keep snow on the upper part of high, distant western ridges even in clear weather.
  const highRock = smoothstep(
    0.015,
    0.028,
    activeRidge.add(observerHeight.mul(middle.select(0.000015, 0.000009))),
  );
  const ridgeSnow = smoothstep(snowline, snowline.add(0.0017), belowRidge)
    .oneMinus()
    .mul(highRock)
    .mul(smoothstep(-0.74, -0.36, direction.x).oneMinus())
    .mul(near.select(0, snowVisibility));
  material.colorNode = mix(haze, mix(terrainColor, snowLight, ridgeSnow), contrast.mul(ridgeContrast));
  // Trim the envelope at ridge crossings with derivative-filtered MSAA coverage,
  // preserving the sampled contours without drawing three full skirts.
  material.opacityNode = clearance;
  material.alphaTestNode = float(0);
  // Unbounded orbit panning can leave the source envelope's measured range.
  material.maskNode = contrast.greaterThan(interleavedGradientNoise(screenCoordinate));
  // The backdrop must never become a reflector or enter the city's shadow pass.
  if (useMRT) material.mrtNode = mrt({ normal: vec3(0, 0, 1), metalRough: vec2(0, 1) });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Regional terrain horizon';
  mesh.frustumCulled = false;
  // Draw after the sky and before the city, including detail that does not write depth.
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  const tint = new THREE.Color(),
    snow = new THREE.Color(0xc8d4d6),
    palettes = {
      day: [0x67765f, 0x506c77, 0x68879d],
      golden: [0x736f58, 0x657678, 0x71859a],
      dusk: [0x4a5554, 0x4d606c, 0x5c7182],
      night: [0x111e26, 0x152634, 0x1b2e3d],
    };
  function setEnvironment(time, weather, fogColor) {
    haze.value.copy(fogColor);
    snowLight.value.set(time === 'golden' ? 0xf6dfc5 : time === 'dusk' ? 0xa4b0d2 : 0xe7edf2);
    snowVisibility.value =
      time === 'night' ? 0 : (time === 'dusk' ? 0.23 : 0.67) / weather.fogMultiplier ** 4;
    const palette = palettes[time] || palettes.golden;
    for (let band = 0; band < layerColors.length; band++) {
      const distance = Math.sqrt(bandsM[band][0] * bandsM[band][1]),
        visibility = 120000 / weather.fogMultiplier ** 3,
        contrast = Math.exp(-Math.LN2 * (distance / visibility) ** 2);
      tint.set(palette[band]).lerp(snow, weather.snow * (band === 0 ? 0.4 : 0.6));
      layerColors[band].value.copy(fogColor).lerp(tint, contrast);
    }
  }
  return {
    mesh,
    setEnvironment,
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
