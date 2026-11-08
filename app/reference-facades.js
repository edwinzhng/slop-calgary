// Interior mapping and per-pane reflection adapted from mrdoob/slop-newyork (MIT).
// The room frame follows each surveyed Calgary wall, including diagonal faces.
import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  varying,
  positionWorld,
  normalLocal,
  modelNormalMatrix,
  cameraPosition,
  reflect,
  sin,
  abs,
  floor,
  fract,
  min,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  dot,
  length,
  normalize,
  pow,
  log2,
  exp2,
  sign,
  fwidth,
  If,
} from 'three/tsl';
import { hash2D, filteredPulse } from './render-nodes.js';
import { cityUniforms } from './city-uniforms.js';
export const facadeWorldNormal = varying(
  normalize(modelNormalMatrix.mul(normalLocal)),
  'vCalgaryFacadeNormal',
).normalize();
const distantWindowLight = Fn(([grid, fw, probability, seed, lod]) => {
  const light = float(probability).toVar();
  If(cityUniforms.uInteriorGlow.greaterThan(0.5).and(lod.greaterThan(0.0)), () => {
    const level = log2(max(max(fw.x, fw.y).mul(4.0), 2.0)).toVar();
    const scale = exp2(floor(level)).toVar();
    const cluster = (size) => {
      const p = grid.div(size).toVar();
      const width = fw.div(size).toVar();
      const lit = step(float(1.0).sub(probability), hash2D(floor(p).add(vec2(seed, 73.1))));
      const coverage = filteredPulse(fract(p.x), 0.25, 0.75, width.x).mul(
        filteredPulse(fract(p.y), 0.25, 0.75, width.y),
      );
      return lit.mul(coverage).mul(4.0);
    };
    const clustered = mix(cluster(scale), cluster(scale.mul(2.0)), smoothstep(0.0, 1.0, fract(level)));
    light.assign(mix(probability, clustered, smoothstep(0.5, 1.2, cityUniforms.uInteriorGlow)));
  });
  return light;
});

const evaluateApartmentInterior = Fn(
  ([uCoord, vCoord, winUV, cellId, winWNode, floorHNode, seedNode, warmthNode, litProbNode, fwNode]) => {
    const u = float(uCoord).toVar();
    const v = float(vCoord).toVar();
    const wUV = vec2(winUV).toVar();
    const cid = vec2(cellId).toVar();
    const wW = float(winWNode).toVar();
    const fH = float(floorHNode).toVar();

    // Room module (SkyscraperGenerator.js lines 959-975):
    // Each room spans an INTEGER 2 or 3 window bays wide (~5.4m - 8.1m) and an INTEGER bay phase
    // offset per floor so partition walls ALWAYS land behind masonry piers/mullions, never mid-window!
    const floorIdx = floor(v.div(fH)).toVar();
    const fHash1 = fract(sin(floorIdx.mul(41.3).add(seedNode)).mul(43758.5453));
    const fHash2 = fract(sin(floorIdx.mul(73.7).add(seedNode.mul(1.7))).mul(43758.5453));
    const roomBays = mix(float(2.0), float(3.0), step(0.5, fHash1)).toVar();
    const roomPhase = floor(fHash2.mul(roomBays)).toVar();

    const gridU = u.div(wW);
    const roomU = gridU.add(roomPhase).div(roomBays).toVar();
    const roomIdx = floor(roomU).toVar();
    const roomId = vec2(roomIdx, floorIdx).toVar();

    const roomW = wW.mul(roomBays).toVar();
    const roomH = fH.mul(0.92).toVar();
    const setback = float(0.12);
    const depth = roomH.mul(1.55).toVar();

    // Pixel entry position `origin` in world meters relative to the multi-bay room center:
    // Window sill (wUV.y=0) sits ~0.75m above the room floor; window lintel (wUV.y=1) sits ~0.58m below the ceiling
    const originX = fract(roomU).sub(0.5).mul(roomW).toVar();
    const originY = wUV.y.sub(0.46).mul(roomH.mul(0.62)).toVar();

    // View ray `dir` in world meters in the room's (across, up, depth) frame. `across` runs along the wall's tangent
    // (+x on walls facing ±z, +z on walls facing ±x, turning with walls that follow a non-grid street)
    const rayWorld = normalize(positionWorld.sub(cameraPosition)).toVar();
    const dirX = dot(rayWorld, vec3(facadeWorldNormal.z, 0, facadeWorldNormal.x.negate())).toVar();
    const dirY = rayWorld.y.toVar();
    const dirZ = max(abs(dot(rayWorld, facadeWorldNormal)), 0.05).toVar();

    // Slab intersection with the far planes of the room box:
    // [-halfW .. +halfW] x [-halfH .. +halfH] x [setback .. setback + depth]
    const halfW = roomW.mul(0.5).toVar();
    const halfH = roomH.mul(0.5).toVar();
    const tFarX = halfW
      .sub(originX.mul(sign(dirX)))
      .div(max(abs(dirX), 0.0001))
      .toVar();
    const tFarY = halfH
      .sub(originY.mul(sign(dirY)))
      .div(max(abs(dirY), 0.0001))
      .toVar();
    const tFarZ = setback.add(depth).div(dirZ).toVar();
    const t = min(min(tFarX, tFarY), tFarZ).toVar();
    const hit = vec3(originX.add(dirX.mul(t)), originY.add(dirY.mul(t)), dirZ.mul(t)).toVar();

    // Normalized 0..1 coordinates inside the room box (SkyscraperGenerator.js line 1150)
    const q = clamp(
      vec3(hit.x.div(roomW).add(0.5), hit.y.div(roomH).add(0.5), hit.z.sub(setback).div(depth)),
      vec3(0.0),
      vec3(1.0),
    ).toVar();

    const onBack = step(tFarZ, tFarX).mul(step(tFarZ, tFarY)).toVar();
    const isYPlane = step(tFarY, tFarX).mul(step(tFarY, tFarZ)).toVar();
    const onCeil = isYPlane.mul(step(0.0, dirY)).toVar();
    const onFloor = isYPlane.mul(float(1.0).sub(step(0.0, dirY))).toVar();

    // Per-room hashes & bulb temperature (SkyscraperGenerator.js lines 1162-1171)
    const seed1 = hash2D(roomId.add(vec2(seedNode, 19.4))).toVar();
    const seed2 = hash2D(roomId.add(vec2(seedNode.mul(1.9), 83.1))).toVar();
    const seed3 = hash2D(roomId.add(vec2(63.2, seedNode.mul(0.7)))).toVar();
    const lod = smoothstep(0.3, 0.8, max(fwNode.x, fwNode.y)).toVar();
    const litRoom = step(float(1.0).sub(litProbNode), seed3).toVar();
    const lit = mix(litRoom, 1.0, lod).toVar();

    const warmLight = mix(color(0xffb845), color(0xffe49c), seed1);
    const coolLight = mix(color(0xdfe8ff), color(0x9fb6ff), seed2);
    const lightCol = mix(coolLight, warmLight, step(float(1.0).sub(warmthNode), seed2)).toVar();

    // Room shell: muted plaster walls with skirting board, wood floorboards + rug, ceiling lamp, back-wall door & art
    const wallBase = mix(
      mix(color(0x9a8b73), color(0x6f7a82), seed1),
      color(0xb9ad97),
      seed2.mul(0.6),
    ).toVar();
    const wallCol = mix(wallBase, wallBase.mul(0.5), smoothstep(0.06, 0.04, q.y)).toVar();

    const seam = step(0.92, fract(q.x.mul(7.0)));
    const boards = mix(color(0x4a3320), color(0x6a4c30), seed1).mul(float(1.0).sub(seam.mul(0.3)));
    const rug = mix(color(0x7a3b32), color(0x3a5760), seed2);
    const inRug = step(abs(q.x.sub(0.5)), 0.28).mul(step(abs(q.z.sub(0.58)), 0.25));
    const floorCol = mix(boards, rug, inRug.mul(0.88)).toVar();

    const lamp = smoothstep(0.18, 0.11, length(vec2(q.x.sub(0.5), q.z.sub(0.5)))).mul(float(1.0).sub(lod));
    const ceilBase = mix(wallBase, color(0xe8e2d5), 0.28);
    const ceilCol = mix(ceilBase, lightCol.mul(mix(float(0.85), float(3.8), lit)), lamp).toVar();

    const doorX = mix(float(0.24), float(0.76), seed1);
    const doorCol = mix(color(0x5a4631), color(0x39383c), step(0.5, seed2));
    const inDoor = step(abs(q.x.sub(doorX)), 0.09).mul(step(abs(q.y.sub(0.34)), 0.34));
    const picX = mix(float(0.72), float(0.28), step(0.5, seed1));
    const inPicFrame = step(abs(q.x.sub(picX)), 0.085).mul(step(abs(q.y.sub(0.56)), 0.095));
    const inPicCanvas = step(abs(q.x.sub(picX)), 0.065).mul(step(abs(q.y.sub(0.56)), 0.075));
    const picCol = mix(color(0x2c3a4a), color(0x7a5a3a), fract(seed1.add(seed2)));
    const backWithDoor = mix(wallCol, doorCol, inDoor);
    const backWithFrame = mix(backWithDoor, color(0x141210), inPicFrame);
    const backCol = mix(backWithFrame, picCol, inPicCanvas).toVar();

    const shellCol = mix(mix(mix(wallCol, floorCol, onFloor), ceilCol, onCeil), backCol, onBack).toVar();

    // Soft 3D corner ambient occlusion & depth falloff (SkyscraperGenerator.js lines 1176 & 1213-1216)
    const aoX = smoothstep(0.0, 0.16, q.x)
      .mul(smoothstep(0.0, 0.16, float(1.0).sub(q.x)))
      .toVar();
    const aoY = smoothstep(0.0, 0.16, q.y)
      .mul(smoothstep(0.0, 0.16, float(1.0).sub(q.y)))
      .toVar();
    const aoZ = smoothstep(0.0, 0.16, q.z)
      .mul(smoothstep(0.0, 0.16, float(1.0).sub(q.z)))
      .toVar();
    const edgeAO = mix(mix(aoY.mul(aoZ), aoX.mul(aoZ), isYPlane), aoX.mul(aoY), onBack);
    const shellAO = mix(float(0.66), float(1.0), edgeAO);
    const falloff = mix(float(1.0), float(0.42), q.z);
    const shadedRoom = shellCol.mul(shellAO).mul(falloff).toVar();

    // Curtains hung just inside the glass of each window opening (SkyscraperGenerator.js lines 1274-1302)
    // Parallax shift onto the curtain plane behind the glass
    const cUVx = clamp(wUV.x.add(dirX.div(dirZ).mul(0.06)), 0.0, 1.0).toVar();
    const wSeed1 = hash2D(cid.add(vec2(seedNode.mul(0.8), 41.2))).toVar();
    const wSeed2 = hash2D(cid.add(vec2(17.9, seedNode.mul(1.3)))).toVar();

    const sL = smoothstep(0.18, 1.0, wSeed1);
    const sR = smoothstep(0.18, 1.0, wSeed2);
    const lw = sL.mul(sL).mul(0.48); // Left drape width (0..48% of window width)
    const rw = sR.mul(sR).mul(0.48); // Right drape width (0..48% of window width)
    // Drape edges widen to the pixel footprint & pleats fade to their mean shade once they'd shrink below a few pixels
    const cFw = fwidth(cUVx).toVar();
    const drapeAA = cFw.add(0.015).toVar();
    const inLeftDrape = smoothstep(lw.add(drapeAA), lw.sub(drapeAA), cUVx).mul(step(0.03, lw));
    const inRightDrape = smoothstep(
      float(1.0).sub(rw).sub(drapeAA),
      float(1.0).sub(rw).add(drapeAA),
      cUVx,
    ).mul(step(0.03, rw));
    const inDrape = mix(clamp(max(inLeftDrape, inRightDrape), 0.0, 1.0), 0.29, lod).toVar(); // 0.29: mean drape coverage

    // Domestic curtain fabric palette (cream, taupe, warm grey, dusty blue, sage green, faded terracotta)
    const pick = fract(seed1.mul(5.7)).mul(5.0);
    const sw0 = mix(color(0xcabfa6), color(0xd8cdb8), seed2);
    const sw1 = mix(color(0x8a7a64), color(0x9b8c72), seed2);
    const sw2 = mix(color(0x5f7079), color(0x6f818b), seed2);
    const sw3 = mix(color(0x6c7558), color(0x79835f), seed2);
    const sw4 = mix(color(0x8c5a44), color(0x9a6a52), seed2);
    const fabric = mix(
      mix(mix(mix(sw0, sw1, step(1.0, pick)), sw2, step(2.0, pick)), sw3, step(3.0, pick)),
      sw4,
      step(4.0, pick),
    );
    const pleatWave = sin(cUVx.mul(48.0).add(wSeed1.mul(6.28))).mul(
      float(1.0).sub(smoothstep(0.6, 1.6, cFw.mul(48.0))),
    );
    const pleat = pleatWave.mul(0.205).add(0.945);
    const drapeCol = fabric.mul(pleat).mul(0.92).toVar();

    // A drape only transmits a little of the room's glow (0.20), never out-glowing the interior!
    const bestCol = mix(shadedRoom, drapeCol, inDrape);
    const bestEmit = mix(float(1.0), float(0.2), inDrape);
    const roomWarmth = mix(vec3(1.0), lightCol, lit.mul(0.85));
    const finalRoomCol = bestCol.mul(roomWarmth).mul(mix(float(0.85), float(1.35), lit));

    const distantLit = distantWindowLight(vec2(gridU, v.div(fH)), fwNode, litProbNode, seedNode, lod);
    return vec4(finalRoomCol, mix(litRoom, distantLit, lod).mul(bestEmit));
  },
);

// Geometry remains the surveyed Calgary shell. Interiors and off-screen skyline
// silhouettes are procedural, as in the reference; SSR supplies on-screen reflections.
export function facadeGlazing(uv, cells, seed, tint, width, height) {
  const cellUV = fract(cells);
  const cellId = floor(cells);
  const fw = fwidth(cells).max(0.0001);
  const winUV = clamp(vec2(cellUV.x.sub(0.08).div(0.84), cellUV.y.sub(0.2).div(0.72)), 0, 1);
  // Keep actual parallax rooms for resolvable nearby panes. Running the full
  // room/curtain ray intersection on every roof and subpixel skyline window
  // consumed fragment time without adding visible architectural information.
  const room = Fn(() => {
    const roomCell = vec2(uv.x.div(width).div(2.5), uv.y.div(height));
    const lit = step(0.76, hash2D(floor(roomCell).add(vec2(seed, 73.1))));
    const office = step(0.48, hash2D(vec2(seed, 41.6)));
    const floorTint = mix(color(0xb99165), color(0x9dbdc5), office);
    const simple = vec4(mix(color(0x233d50), floorTint, lit.mul(0.74)), lit.mul(0.63));
    const result = simple.toVar();
    const distance = length(positionWorld.sub(cameraPosition)).toVar();
    const footprint = max(fw.x, fw.y).toVar();
    If(
      distance
        .lessThan(cityUniforms.uFacadeDetailDistance)
        .and(footprint.lessThan(0.5))
        .and(abs(facadeWorldNormal.y).lessThan(0.4)),
      () => {
        const detailed = evaluateApartmentInterior(
          uv.x,
          uv.y,
          winUV,
          cellId,
          width,
          height,
          seed,
          float(0.65),
          float(0.3),
          fw,
        );
        const fade = max(
          smoothstep(
            cityUniforms.uFacadeDetailDistance.mul(0.55),
            cityUniforms.uFacadeDetailDistance,
            distance,
          ),
          smoothstep(0.2, 0.5, footprint),
        );
        result.assign(mix(detailed, simple, fade));
      },
    );
    return result;
  })();
  const paneRandX = hash2D(cellId.add(vec2(seed, 3.7))).sub(0.5);
  const paneRandY = hash2D(cellId.add(vec2(11.3, seed))).sub(0.5);
  const bowX = cellUV.x.sub(0.5).mul(0.11).add(paneRandX.mul(0.09));
  const bowY = cellUV.y.sub(0.55).mul(0.11).add(paneRandY.mul(0.09));
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const nPane = normalize(facadeWorldNormal.add(vec3(bowX, bowY, bowX.negate())));
  const reflectDir = reflect(viewDir.negate(), nPane);
  const fresnel = pow(clamp(float(1).sub(abs(dot(viewDir, nPane))), 0, 1), 2.1);
  const elevation = clamp(reflectDir.y.mul(0.65).add(0.38), 0, 1);
  const azimuth = uv.x.mul(0.045).add(reflectDir.x.mul(3.8)).add(reflectDir.z.mul(3.8));
  const towerHeight = hash2D(vec2(floor(azimuth.mul(2.4)), seed))
    .mul(0.46)
    .add(0.16);
  const edgeAA = fwidth(elevation).add(0.004);
  const inTower = smoothstep(towerHeight.add(edgeAA), towerHeight.sub(edgeAA), elevation);
  const refCols = azimuth.mul(15);
  const refRows = elevation.mul(30);
  const refWindows = filteredPulse(fract(refCols), 0.32, 1, fwidth(refCols)).mul(
    filteredPulse(fract(refRows), 0.32, 1, fwidth(refRows)),
  );
  const reflectedTower = mix(
    color(0x0c1420),
    color(0xd1dcce),
    refWindows.mul(0.27).mul(cityUniforms.uInteriorGlow),
  );
  const skyReflect = mix(
    cityUniforms.uSkyHorizonColor,
    cityUniforms.uSkyTopColor,
    clamp(elevation.mul(1.4), 0, 1),
  );
  const reflection = mix(skyReflect, reflectedTower, inTower.mul(0.62));
  const sunSpec = pow(max(dot(reflectDir, normalize(cityUniforms.uSkySunDir)), 0), 48).mul(1.25);
  const glassTint = mix(color(0x162c42), tint.mul(0.3), 0.32);
  const dirt = float(1)
    .sub(smoothstep(0.2, 0.42, cellUV.y))
    .mul(0.32);
  const interior = mix(room.xyz.mul(color(0xb6c6bf)), glassTint, dirt.add(0.56).clamp(0, 0.92));
  const glazed = mix(interior, reflection, fresnel.mul(0.92).add(0.18)).add(
    cityUniforms.uSunColor.mul(sunSpec),
  );
  const transmission = float(1).sub(fresnel.mul(0.75));
  const light = room.xyz.mul(room.w).mul(transmission).mul(cityUniforms.uInteriorGlow).mul(0.72);
  return { color: glazed, emissive: light, dirt, fw, cellUV };
}
