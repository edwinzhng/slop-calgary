import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  attribute,
  positionWorld,
  normalWorld,
  fract,
  floor,
  sin,
  dot,
  step,
  mix,
  abs,
  time,
  fwidth,
  max,
  smoothstep,
  clamp,
  normalize,
  cameraPosition,
  length,
} from 'three/tsl';
import { cityUniforms, windowGlow } from './city-uniforms.js';
import { createRoadSurfaceMaterial, createSidewalkMaterial } from './reference-streets.js';
import { facadeWorldNormal, facadeGlazing } from './reference-facades.js';
import { bumpNormal, filteredPulse, noise2D } from './render-nodes.js';
import { PARK_AGGREGATE_FINISHES } from './park-finishes.js';
import { createCompactPavementMaterial } from './pavement-texture.js';
import { streetLightWash } from './street-light-wash.js';

export { windowGlow, cityUniforms } from './city-uniforms.js';
const cache = new Map();
const palettes = [0x889ca4, 0x647b86, 0xaab4b6, 0xb2a393, 0x9a8473, 0x69808c, 0xb8b1a1, 0xb59691];
// Three's shadow override samples colorNode.a even for vec3 inputs. These
// surfaces are opaque, so its alpha requires none of their facade shading.
const opaqueSurfaceColor = Fn(([mainColor], builder) =>
  builder.material.isShadowPassMaterial ? vec3(0) : mainColor,
);
// Integrate the window edge over a pixel footprint rather than sampling a
// hard step. Tiny distant windows then fade steadily instead of sparkling.
function filteredBand(coordinate, start, end) {
  return filteredPulse(fract(coordinate), start, end, fwidth(coordinate).max(0.0001));
}
export function facadeMaterial(index = 0) {
  index = Math.abs(index) % 9;
  if (cache.has(index)) return cache.get(index);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.39, metalness: 0.32 });
  const p = positionWorld;
  const side = float(1).sub(step(0.12, abs(facadeWorldNormal.y)));
  const across = p.x.mul(facadeWorldNormal.z).sub(p.z.mul(facadeWorldNormal.x));
  const width = float(index < 3 ? 2.9 : 2.4),
    height = float(index < 3 ? 3.7 : 3.2);
  const local = vec2(across, p.y),
    cells = vec2(across.div(width), p.y.div(height));
  const windows = filteredBand(cells.x, index < 3 ? 0.025 : 0.14, index < 3 ? 0.975 : 0.86)
    .mul(filteredBand(cells.y, 0.19, 0.97))
    .mul(side);
  const base = index === 8 ? attribute('color', 'vec3') : color(palettes[index]);
  const glass = facadeGlazing(local, cells, float(index * 17 + 3), base, width, height);
  mat.colorNode = opaqueSurfaceColor(mix(base.mul(0.55), glass.color, windows));
  mat.roughnessNode = mix(float(0.6), float(0.06).add(glass.dirt.mul(0.15)), windows);
  mat.metalnessNode = windows.mul(0.72);
  mat.emissiveNode = glass.emissive.mul(windows);
  cache.set(index, mat);
  return mat;
}

let cityBuildingMaterial, mobileBuildingMaterial;
export function buildingMaterial(lightweight = false) {
  const cached = lightweight ? mobileBuildingMaterial : cityBuildingMaterial;
  if (cached) return cached;
  const data = attribute('buildingProfile', 'vec4').mul(vec4(7, 1023, 8, 8)),
    encodedUV = attribute('wallUV', 'vec2'),
    base = attribute('color', 'vec3');
  const is = (id) => float(1).sub(step(0.4, abs(data.x.sub(id))));
  const glassTower = is(0),
    commercial = is(1),
    house = is(4),
    front = step(4096, encodedUV.x).mul(house),
    uv = vec2(encodedUV.x.sub(front.mul(8192)), encodedUV.y),
    homes = house.add(is(3)),
    garage = is(5),
    industrial = is(6),
    brick = is(2).add(is(3)).add(is(7)),
    brickHeight = mix(float(0.075), float(0.28), is(2));
  // Genuine LiDAR roofs include steep pitched faces. Only near-vertical faces
  // receive facade windows; the original broad cutoff put windows on gables.
  const side = float(1).sub(step(0.12, abs(facadeWorldNormal.y)));
  const cells = vec2(uv.x.div(data.w), uv.y.div(data.z));
  const detail = float(1).sub(smoothstep(0.09, 0.38, max(fwidth(cells.x), fwidth(cells.y))));
  const houseInset = house.mul(mix(0.045, 0.104, step(0.5, fract(data.y.mul(0.079)))));
  const openingBase = mix(0.18, 0.24, house);
  const openingTop = mix(0.81, 0.71, house);
  const houseBay = fract(
    floor(cells.x)
      .add(floor(data.y.mul(0.17)))
      .mul(0.618),
  );
  const bay = filteredBand(cells.x, houseInset.add(0.16), float(0.84).sub(houseInset)).mul(
    float(1).sub(house.mul(step(0.79, houseBay))),
  );
  const doorCenter = mix(-0.65, 0.65, step(0.5, fract(data.y.mul(0.153))));
  const doorEdge = abs(uv.x.sub(doorCenter));
  const door = float(1)
    .sub(smoothstep(0.46, 0.53, doorEdge))
    .mul(smoothstep(0.03, 0.13, uv.y))
    .mul(float(1).sub(smoothstep(2.11, 2.22, uv.y)))
    .mul(front)
    .mul(detail)
    .mul(side);
  const window = bay
    .mul(filteredBand(cells.y, openingBase, openingTop))
    .mul(detail)
    .mul(side)
    .mul(float(1).sub(garage))
    .mul(float(1).sub(industrial.mul(0.75)));
  const pane = filteredBand(cells.x, 0.025, 0.975)
    .mul(filteredBand(cells.y, 0.03, 0.96))
    .mul(detail)
    .mul(side)
    .mul(glassTower);
  const averageWindow = side
    .mul(float(1).sub(garage))
    .mul(float(1).sub(industrial.mul(0.75)))
    .mul(mix(0.52, 0.21, homes));
  // Style7 suppresses generic glazing in observed photo/detail bands at UV y5
  // and above. Their source-guarded UVs retain other areas' opening grids.
  const photographedUpper = is(7).mul(step(5, uv.y));
  const mask = mix(averageWindow, max(window, pane), detail).mul(float(1).sub(photographedUpper));
  // Plinths and masonry trim follow the same ground level and bay spacing as
  // the wall. Authored style 7 keeps its existing finish.
  const ordinaryWall = commercial.add(is(2)).add(is(3)).add(house);
  const plinth = float(1)
    .sub(smoothstep(0.34, 0.63, uv.y))
    .mul(ordinaryWall);
  const sill = bay.mul(filteredBand(cells.y, openingBase.sub(0.048), openingBase));
  const lintel = bay.mul(filteredBand(cells.y, openingTop, openingTop.add(0.049)));
  const masonryTrim = sill.add(lintel.mul(0.63)).mul(ordinaryWall).mul(detail).mul(side);
  const sash = bay
    .mul(filteredBand(cells.y, 0.44, 0.471))
    .mul(house)
    .mul(detail)
    .mul(side);
  const sidingRow = uv.y.div(0.17);
  const sidingFade = float(1).sub(smoothstep(0.11, 0.48, fwidth(sidingRow)));
  const siding = float(1)
    .sub(filteredBand(sidingRow, 0.035, 0.98))
    .mul(house)
    .mul(sidingFade);
  const groundFinish = mix(base, base.mul(0.79), plinth);
  const trimColor = mix(base, color(0xd3c4ab), 0.46);
  const cell = floor(cells);
  const seed = fract(
    sin(dot(cell.add(floor(data.y.add(0.5)).mul(17)), vec2(12.9898, 78.233))).mul(43758.5453),
  );
  if (lightweight) {
    const mat = new THREE.MeshBasicNodeMaterial();
    const sun = smoothstep(-0.12, 0.64, dot(facadeWorldNormal, cityUniforms.uSkySunDir));
    const night = smoothstep(0.18, 1.6, windowGlow);
    const course = uv.y.div(brickHeight);
    const mortar = float(1)
      .sub(filteredBand(course, 0.08, 0.94))
      .mul(brick)
      .mul(float(1).sub(smoothstep(0.1, 0.5, fwidth(course))));
    const wall = mix(groundFinish, trimColor, masonryTrim.mul(0.75).add(mortar.mul(0.2)))
      .mul(mix(0.72, 1.16, sun))
      .mul(float(1).sub(siding.mul(0.12)));
    const glass = mix(color(0x466276), color(0x89a7b5), glassTower.mul(0.42).add(sun.mul(0.36))).mul(
      seed.sub(0.5).mul(detail).mul(0.14).add(1),
    );
    const roof = mix(color(0x565751), base.mul(0.8), industrial.mul(0.7));
    const opening = mask.mul(float(1).sub(sash));
    const daylight = mix(roof, mix(mix(wall, glass, opening), base.mul(0.49), door), side);
    const litWindows = opening.mul(mix(float(0.2), step(0.68, seed), detail)).mul(night);
    const snow = cityUniforms.uSnow.mul(smoothstep(0.35, 0.85, facadeWorldNormal.y));
    mat.colorNode = opaqueSurfaceColor(
      mix(daylight, color(0xe9eff2), snow)
        .mul(mix(float(1), float(0.18), night))
        .add(color(0xffd6a0).mul(litWindows).mul(0.84)),
    );
    mobileBuildingMaterial = mat;
    return mat;
  }
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.72, metalness: 0.08 });
  const glazing = facadeGlazing(uv, cells, floor(data.y.add(0.5)), base, data.w, data.z);
  const glass = mix(glazing.color, color(0x536a71), homes.mul(0.39));
  const brickRow = uv.y.div(brickHeight);
  const brickColumn = uv.x
    .div(mix(float(0.24), float(0.6), is(2)))
    .add(fract(floor(brickRow).mul(0.5)).mul(0.5));
  const masonryDetail = float(1).sub(smoothstep(0.08, 0.65, max(fwidth(brickRow), fwidth(brickColumn))));
  const mortar = float(1)
    .sub(filteredBand(brickRow, 0.08, 0.94).mul(filteredBand(brickColumn, 0.04, 0.96)))
    .mul(brick)
    .mul(masonryDetail);
  const course = filteredBand(uv.y.div(data.z), 0.0, 0.055).mul(side).mul(detail);
  const ribs = float(1)
    .sub(filteredBand(uv.x.div(0.22), 0.1, 0.95))
    .mul(industrial)
    .mul(masonryDetail);
  const mortarColor = mix(color(0xc5bfb0), color(0xb3a18d), is(7));
  const wall = mix(groundFinish, mortarColor, mortar.mul(0.28)).mul(
    float(1).sub(siding.mul(0.14)).sub(ribs.mul(0.18)),
  );
  const frame = float(1)
    .sub(filteredBand(cells.x, 0.035, 0.965).mul(filteredBand(cells.y, 0.035, 0.965)))
    .mul(glassTower)
    .mul(detail)
    .mul(side);
  const garageDoor = filteredBand(uv.x.div(3.2), 0.07, 0.93)
    .mul(float(1).sub(smoothstep(2.3, 2.4, uv.y)))
    .mul(garage)
    .mul(side);
  const garagePanels = mix(color(0x777d77), color(0xa3a69b), filteredBand(uv.y.div(0.4), 0.04, 0.94));
  const frameColor = mix(base.mul(0.4), color(0xa4adb1), 0.16);
  const opening = mask.mul(float(1).sub(sash));
  let facade = mix(mix(wall, glass, opening), color(0x9c9b90), course.mul(0.28));
  facade = mix(facade, trimColor, masonryTrim.mul(0.84));
  facade = mix(facade, frameColor, frame.mul(0.9));
  facade = mix(mix(facade, garagePanels, garageDoor), base.mul(0.46), door);
  const roofLines = filteredBand(positionWorld.x.add(positionWorld.z).div(0.3), 0.0, 0.06)
    .mul(masonryDetail)
    .mul(house);
  const roof = mix(color(0x51524d), base.mul(0.8), industrial.mul(0.8)).mul(
    float(1).sub(roofLines.mul(0.18)),
  );
  const themeColor = mix(color(0xa8bed0), color(0xd3b6ce), seed).mul(0.76);
  facade = mix(facade, facade.mul(themeColor).mul(1.1), cityUniforms.uTheme.mul(0.42));
  const snow = cityUniforms.uSnow.mul(smoothstep(0.35, 0.85, facadeWorldNormal.y));
  mat.colorNode = opaqueSurfaceColor(mix(mix(roof, facade, side), color(0xe9eff2), snow.mul(0.92)));
  mat.roughnessNode = mix(mix(float(0.82), float(0.05).add(glazing.dirt.mul(0.18)), opening), 0.92, snow);
  mat.metalnessNode = opening.mul(mix(float(0.18), float(0.72), glassTower)).mul(float(1).sub(snow));
  mat.aoNode = smoothstep(-0.1, 2.4, uv.y).mul(0.18).add(0.82);
  const distance = length(positionWorld.sub(cameraPosition));
  const reliefFade = float(1)
    .sub(smoothstep(18, 140, distance))
    .mul(float(1).sub(smoothstep(0.03, 0.1, max(glazing.fw.x, glazing.fw.y))))
    .mul(side);
  const relief = frame
    .mul(0.014)
    .add(masonryTrim.mul(0.012))
    .add(mortar.mul(-0.004))
    .add(siding.mul(-0.002))
    .add(ribs.mul(0.006));
  mat.normalNode = bumpNormal(relief.mul(reliefFade));
  mat.emissiveNode = glazing.emissive.mul(opening).mul(float(1).sub(snow));
  cityBuildingMaterial = mat;
  return mat;
}

const surfaces = new Map();
export function surfaceMaterial(kind = 'concrete', compact = false) {
  const key = compact && (kind === 'asphalt' || kind === 'concrete') ? `compact-${kind}` : kind;
  if (surfaces.has(key)) return surfaces.get(key);
  if (kind === 'asphalt' || kind === 'concrete') {
    const mat = compact
      ? createCompactPavementMaterial(kind)
      : kind === 'asphalt'
        ? createRoadSurfaceMaterial()
        : createSidewalkMaterial();
    const originalColor = mat.colorNode;
    const originalRoughness = mat.roughnessNode;
    const snow = cityUniforms.uSnow.mul(smoothstep(0.5, 0.9, normalWorld.y));
    const tracks = smoothstep(
      0.25,
      0.8,
      sin(positionWorld.x.mul(0.16))
        .mul(sin(positionWorld.z.mul(0.12)))
        .mul(0.5)
        .add(0.5),
    );
    mat.colorNode = mix(
      originalColor,
      color(0xe1e9ed),
      snow.mul(kind === 'asphalt' ? tracks.mul(0.6).add(0.28) : 0.9),
    );
    mat.roughnessNode = mix(originalRoughness, 0.92, snow);
    mat.emissiveNode = streetLightWash(mat.colorNode, kind === 'asphalt' ? 1 : 0.55);
    surfaces.set(key, mat);
    return mat;
  }
  const values = {
    asphalt: [0x434846, 0.96],
    'path-asphalt': [0x747674, 0.96],
    concrete: [0xb4b3a7, 0.94],
    grass: [0x909a76, 1],
    turf: [0x758e4a, 0.98],
    natural: [0x587b4b, 1],
    'park-ground': [0x888a68, 1],
    ground: [0x929285, 1],
    brick: [0x927767, 0.93],
    wood: [0x8d7961, 0.92],
    ...PARK_AGGREGATE_FINISHES,
    pavers: [0x9a8c7b, 0.94],
    'turf-pavers': [0x9b9a85, 0.94],
    metal: [0x858a88, 0.58],
    rail: [0x68655c, 0.95],
  };
  const [base, roughness] = values[kind] || values.concrete;
  const mat = new THREE.MeshStandardNodeMaterial({ color: base, roughness });
  const p = positionWorld;
  if (['path-asphalt', 'brick', 'pavers', 'turf-pavers', 'park-aggregate', 'park-ground'].includes(kind))
    mat.emissiveNode = streetLightWash(color(base), kind === 'path-asphalt' ? 0.55 : 0.27);
  if (['pavers', 'brick', 'turf-pavers'].includes(kind)) {
    // Nominal authored patterns; the source names the finish, not joint pitch.
    const along = p.z.mul(kind === 'brick' ? 10 : 2);
    const unstaggered = p.x.mul(kind === 'brick' ? 5 : 3.2);
    const row = floor(along);
    const across = unstaggered.add(row.mul(0.5));
    const infill = kind === 'turf-pavers',
      gapX = infill ? 0.16 : 0.018,
      gapZ = infill ? 0.16 : kind === 'brick' ? 0.025 : 0.022;
    // Derivatives of the row offset include a discontinuity at every course.
    // Filter only the continuous coordinates and converge to the tile average.
    const span = fwidth(unstaggered).max(0.0001);
    const detail = float(1).sub(smoothstep(0.12, 0.58, max(span, fwidth(along))));
    const joints = filteredPulse(fract(across), gapX, 1 - gapX, span).mul(
      filteredBand(along, gapZ, 1 - gapZ),
    );
    const block = mix(float((1 - 2 * gapX) * (1 - 2 * gapZ)), joints, detail);
    const grainDetail = float(1).sub(smoothstep(0.18, 0.74, max(fwidth(p.x), fwidth(p.z)).mul(35)));
    const grain = noise2D(p.xz.mul(35)).sub(0.5).mul(0.045).mul(grainDetail);
    const variation = noise2D(vec2(floor(across), row))
      .sub(0.5)
      .mul(0.16)
      .mul(detail)
      .add(0.99);
    const dry = mix(color(infill ? 0x5b7547 : 0x77766c), color(base).mul(variation.add(grain)), block);
    const snow = cityUniforms.uSnow.mul(smoothstep(0.5, 0.95, normalWorld.y));
    mat.colorNode = mix(
      dry.mul(float(1).sub(cityUniforms.uRoadWetness.mul(0.16))),
      color(0xe5edef),
      snow.mul(0.9),
    );
    mat.roughnessNode = mix(0.94, 0.53, cityUniforms.uRoadWetness);
    mat.normalNode = bumpNormal(joints.mul(detail).mul(0.002));
    // A mapped finish and older surveyed asphalt can occupy the same grade.
    // Give the explicit surface a stable render priority at that shared plane.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    surfaces.set(kind, mat);
    return mat;
  }
  if (kind === 'wood') {
    const boards = filteredBand(p.x.mul(5), 0.014, 0.986);
    const grainCoordinate = p.x.mul(46).add(noise2D(p.xz.mul(0.8)).mul(4));
    const grain = sin(grainCoordinate)
      .mul(float(1).sub(smoothstep(0.3, 1.5, fwidth(grainCoordinate))))
      .mul(0.035);
    const dry = color(base).mul(boards.mul(0.18).add(0.82).add(grain));
    const snow = cityUniforms.uSnow.mul(smoothstep(0.5, 0.95, normalWorld.y));
    mat.colorNode = mix(dry, color(0xe5edef), snow.mul(0.9));
    mat.normalNode = bumpNormal(boards.mul(0.003));
    surfaces.set(kind, mat);
    return mat;
  }
  if (['turf', 'natural', 'park-ground', 'grass'].includes(kind)) {
    const pixel = max(fwidth(p.x), fwidth(p.z));
    const blades = noise2D(p.xz.mul(vec2(18, 34)))
      .sub(0.5)
      .mul(smoothstep(0.06, 0.01, pixel));
    const meadow = noise2D(p.xz.mul(vec2(0.35, 0.48)));
    const tint = mix(color(0xa6be9a), color(0xf4de9c), smoothstep(0.47, 0.67, meadow));
    const groundColor = color(base)
      .mul(mix(vec3(1), tint, 0.24))
      .mul(blades.mul(0.16).add(1.03));
    mat.colorNode = mix(groundColor, color(0xe4ebed), cityUniforms.uSnow.mul(0.92));
    mat.normalNode = bumpNormal(blades.mul(0.002));
    surfaces.set(kind, mat);
    return mat;
  }
  const fine = p.x.mul(kind === 'grass' ? 9 : 27).add(p.z.mul(19));
  const fade = float(1).sub(smoothstep(0.3, 2.5, fwidth(fine)));
  const aggregate = sin(fine)
    .mul(sin(p.x.mul(17).sub(p.z.mul(31))))
    .mul(fade)
    .mul(0.035);
  const broad = sin(p.x.mul(0.15).add(p.z.mul(0.09)))
    .mul(sin(p.z.mul(0.23)))
    .mul(0.025);
  const parkFinish = kind === 'park-aggregate' ? attribute('parkFinish', 'vec4') : null,
    baseColor = parkFinish ? parkFinish.rgb : color(base);
  if (parkFinish) mat.roughnessNode = parkFinish.a;
  mat.colorNode = mix(
    baseColor.mul(aggregate.add(broad).add(0.98)),
    color(0xe5edef),
    cityUniforms.uSnow.mul(smoothstep(0.5, 0.95, normalWorld.y)).mul(0.9),
  );
  surfaces.set(kind, mat);
  return mat;
}
export function waterMaterial(lightweight = false) {
  const flow = positionWorld.xz.sub(vec2(time.mul(0.73), time.mul(0.23)));
  const bend = sin(flow.x.mul(0.24).add(flow.y.mul(0.19))).mul(0.86);
  const cross = flow.y.mul(2.65).sub(flow.x.mul(0.37)).add(bend);
  const drift = flow.y.mul(1.19).add(flow.x.mul(0.13)).add(bend);
  const swell = sin(flow.y.mul(0.94).sub(flow.x.mul(0.21)).add(time.mul(0.41)));
  const detail = float(1).sub(smoothstep(0.48, 1.9, fwidth(cross)));
  const roll = sin(drift).mul(0.47).add(swell.mul(0.33)).add(sin(cross).mul(detail).mul(0.2));
  const streak = smoothstep(0.37, 0.85, roll).mul(0.055);
  if (lightweight) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const grazing = float(1).sub(abs(normalize(cameraPosition.sub(positionWorld)).y));
    const glint = smoothstep(0.2, 0.8, roll).mul(0.18);
    const night = smoothstep(0.18, 1.6, windowGlow);
    mat.colorNode = mix(color(0x236874), color(0x75bdb8), grazing.mul(0.46).add(glint)).mul(
      mix(float(1), float(0.27), night),
    );
    return mat;
  }
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b9994,
    roughness: 0.24,
    metalness: 0.36,
    side: THREE.DoubleSide,
  });
  mat.colorNode = mix(color(0x387d7e), color(0x71b4aa), streak.add(0.31).add(roll.mul(0.033)));
  mat.normalNode = bumpNormal(roll.mul(0.011));
  mat.roughnessNode = float(0.29).sub(streak.mul(0.18));
  return mat;
}

export function createCelActorMaterial({ shadowColor = 0x6b829f } = {}) {
  const mat = new THREE.MeshBasicNodeMaterial();
  const key = normalize(mix(vec3(-0.45, 0.85, 0.6), cityUniforms.uSkySunDir, 0.32));
  const light = dot(normalWorld, key);
  const shade = mix(color(shadowColor), color(0xb7c4ce), smoothstep(-0.11, 0.05, light));
  const bands = mix(shade, color(0xfff4dd), smoothstep(0.49, 0.61, light));
  const night = smoothstep(0.22, 1.6, windowGlow);
  mat.colorNode = opaqueSurfaceColor(
    attribute('color', 'vec3')
      .mul(bands)
      .mul(mix(float(1), float(0.58), night)),
  );
  return mat;
}
