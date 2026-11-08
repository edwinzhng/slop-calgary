// Adapted from mrdoob/slop-newyork, MIT. See LICENSE and THIRD_PARTY.md.
import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  positionWorld,
  normalWorldGeometry,
  cameraPosition,
  sin,
  cos,
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
  fwidth,
  If,
  attribute,
  varying,
  cameraProjectionMatrix,
  cameraViewMatrix,
  positionGeometry,
  screenSize,
  mrt,
} from 'three/tsl';
import { hash2D, noise2D, bumpNormal, lineAA, gridLine } from './render-nodes.js';
import { cityUniforms } from './city-uniforms.js';
import { streetLightWash } from './street-light-wash.js';
const canyonSkyAONode = Fn(() => smoothstep(0, 68, positionWorld.y).mul(0.4).add(0.6));
function roadPuddleField(wx, wz) {
  const nMacro = noise2D(vec2(wx.mul(0.095), wz.mul(0.075)));
  const nMid = noise2D(vec2(wx.mul(0.25).add(19.4), wz.mul(0.22).add(11.8)));
  const nDetail = noise2D(vec2(wx.mul(0.68).sub(7.3), wz.mul(0.68).add(29.1)));
  return nMacro.mul(0.52).add(nMid.mul(0.34)).add(nDetail.mul(0.14));
}

/**
 * Wetness masks over a puddle field, driven by cityUniforms.uRoadWetness (0 = bone dry … 1 = right after a downpour):
 * x = damp stains (darker, satin), y = standing water (mirror-smooth; none on a dry day), z = wet film over everything.
 * Water collects in the field's highest (lowest-lying) spots first, so pools appear, grow & merge as wetness rises;
 * `drainage` raises the water line for better-drained surfaces such as the crowned sidewalk flags.
 */
function roadWetMasks(field, drainage = 0.0) {
  const w = cityUniforms.uRoadWetness;
  const level = mix(float(0.86), float(0.56), clamp(w.sub(0.1).div(0.55), 0.0, 1.0)).add(drainage);
  const damp = smoothstep(level.sub(0.09), level.sub(0.015), field);
  const puddle = smoothstep(level, level.add(0.022), field).mul(smoothstep(0.1, 0.22, w));
  const film = smoothstep(0.2, 0.8, w);
  return vec3(damp, puddle, film);
}

// Distance from p to the nearest border of its jittered 3x3 Voronoi cell (in cell units, ~(F2 - F1) / 2)
const voronoiBorder = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const ip = floor(pv).toVar();
  const fp = fract(pv).toVar();
  const f1 = float(8.0).toVar();
  const f2 = float(8.0).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const id = ip.add(vec2(i, j));
      const site = vec2(i, j).add(
        vec2(hash2D(id), hash2D(id.add(vec2(37.1, 11.7))))
          .mul(0.8)
          .add(0.1),
      );
      const d = length(fp.sub(site)).toVar();
      f2.assign(min(f2, max(f1, d)));
      f1.assign(min(f1, d));
    }
  }
  return f2.sub(f1).mul(0.5);
});

/**
 * Wear & repairs of the asphalt at world xz, `px` metres a pixel: x = hairline crack coverage (block & alligator
 * cracking in worn stretches), y = signed distance to the edge of a rectangular utility-cut patch (m, < 0 inside),
 * z = pothole depth (0 .. 1 at the bottom of the bowl), w = 1 where the 11 m cell has a patch.
 * Cracks are only traced near the camera and in the worn stretches, where they can show.
 */
const roadWear = Fn(([wxz, px]) => {
  // Worn stretches: about a quarter of the roadway, in patches a block or so across
  const worn = smoothstep(0.5, 0.78, noise2D(wxz.mul(0.045).add(71.0))).toVar();

  const crack = float(0.0).toVar();
  If(worn.greaterThan(0.001).and(px.lessThan(0.04)), () => {
    const warp = vec2(noise2D(wxz.mul(2.7)), noise2D(wxz.mul(2.7).add(13.0)))
      .sub(0.5)
      .mul(0.35);
    const cell = 0.55;
    const border = voronoiBorder(wxz.div(cell).add(warp)).mul(cell);
    const width = worn.mul(0.0016).add(0.0012);
    const effWidth = max(width, px.mul(0.6));
    crack.assign(
      float(1.0)
        .sub(smoothstep(effWidth, effWidth.add(px), border))
        .mul(width.div(effWidth))
        .mul(worn)
        .mul(smoothstep(0.04, 0.015, px)),
    );
  });

  // Rectangular utility-cut patches (utility, water & sewer trenches): one 11 m cell in two, kept inside its cell. Some
  // are squarish cuts, others long narrow trenches running along the avenue or across it
  const pCell = floor(wxz.div(11.0));
  const hasPatch = step(0.5, hash2D(pCell.add(vec2(3.7, 8.1))));
  const trench = step(0.6, hash2D(pCell.add(vec2(2.9, 6.3))));
  const alongX = step(0.5, hash2D(pCell.add(vec2(5.5, 9.9))));
  const pCentre = pCell
    .add(0.5)
    .add(
      vec2(hash2D(pCell.add(vec2(1.3, 5.9))), hash2D(pCell.add(vec2(9.2, 2.4))))
        .sub(0.5)
        .mul(mix(float(0.4), float(0.08), trench)),
    )
    .mul(11.0);
  const cutHalf = vec2(
    hash2D(pCell.add(vec2(4.4, 0.6)))
      .mul(1.8)
      .add(0.6),
    hash2D(pCell.add(vec2(7.8, 3.1)))
      .mul(1.4)
      .add(0.5),
  );
  const trenchLong = hash2D(pCell.add(vec2(0.7, 4.8)))
    .mul(2.0)
    .add(2.4);
  const trenchNarrow = hash2D(pCell.add(vec2(6.6, 7.2)))
    .mul(0.25)
    .add(0.3);
  const trenchHalf = mix(vec2(trenchNarrow, trenchLong), vec2(trenchLong, trenchNarrow), alongX);
  const pHalf = mix(cutHalf, trenchHalf, trench);
  const pq = abs(wxz.sub(pCentre)).sub(pHalf);
  const patchDist = max(pq.x, pq.y);

  // Potholes, mostly in the worn stretches: a ragged bowl a hand or two across
  const hCell = floor(wxz.div(7.0));
  const hCentre = hCell
    .add(
      vec2(hash2D(hCell.add(vec2(2.2, 7.7))), hash2D(hCell.add(vec2(6.1, 1.9))))
        .mul(0.6)
        .add(0.2),
    )
    .mul(7.0);
  const hRadius = hash2D(hCell.add(vec2(5.3, 4.2)))
    .mul(0.24)
    .add(0.12);
  const hDist = length(wxz.sub(hCentre)).mul(noise2D(wxz.mul(6.0)).sub(0.5).mul(0.5).add(1.0));
  const hasHole = step(float(0.975).sub(worn.mul(0.12)), hash2D(hCell.add(vec2(8.8, 0.3))));
  const pothole = smoothstep(hRadius.add(px), hRadius.mul(0.35), hDist).mul(hasHole);

  return vec4(crack.mul(float(1.0).sub(step(patchDist, 0.0).mul(hasPatch))), patchDist, pothole, hasPatch);
});

/**
 * "Tar snakes" at world xz, `px` metres a pixel: the meandering 3-5 cm bands of black crack sealant the city pours over
 * the wider cracks, in a broken network of ~2.4 m cells across sealed stretches of the roadway. Wide enough to read
 * from the car, so they are traced further than the hairline cracks, thinning out before they shrink below a pixel.
 */
const roadTarSnakes = Fn(([wxz, px]) => {
  const zone = smoothstep(0.3, 0.48, noise2D(wxz.mul(0.03).add(17.0))).toVar();
  const snake = float(0.0).toVar();
  If(zone.greaterThan(0.001).and(px.lessThan(0.12)), () => {
    const warp = vec2(noise2D(wxz.mul(0.9)), noise2D(wxz.mul(0.9).add(31.0)))
      .sub(0.5)
      .mul(0.6);
    const cell = 2.4;
    const border = voronoiBorder(wxz.div(cell).add(warp)).mul(cell);
    // Only some cracks were sealed: the network breaks up into runs a few metres long
    const keep = smoothstep(0.38, 0.5, noise2D(wxz.mul(0.6).add(5.0)));
    const width = noise2D(wxz.mul(1.7).add(9.0)).mul(0.012).add(0.014);
    const effWidth = max(width, px.mul(0.6));
    snake.assign(
      float(1.0)
        .sub(smoothstep(effWidth, effWidth.add(px), border))
        .mul(width.div(effWidth))
        .mul(zone)
        .mul(keep)
        .mul(smoothstep(0.12, 0.06, px)),
    );
  });
  return snake;
});

/**
 * Unified Calgary Roadway Asphalt, Footprint-Filtered Aggregate `bumpNormal`, Scattered Manholes, Wear & Repairs
 * (block cracking, tar-sealed utility-cut patches & trenches, potholes, tar snakes, oil drips, exposed stone chips, a
 * gentle swell of the paving; see roadWear & roadTarSnakes) & Post-Rain Wetness (upgraded with techniques from
 * CityGenerator.js `createRoadMaterial`).
 * cityUniforms.uRoadWetness drives damp stains, a faint wet sheen & standing puddles (roadWetMasks): bone dry at
 * midday, a few small pools at golden hour, glossy stains & pools mirroring the lights at night. Water's Fresnel rides
 * on metalness (as for the rivers), so puddles reflect the street through SSR at grazing angles yet only darken seen
 * from above.
 * Lane markings are separate geometry built from the road network (js/road-paint.js).
 */
function createRoadSurfaceMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.24,
    roughness: 0.48,
  });

  // Weathered, oxidised asphalt (fresh blacktop only in the newer patches)
  const cAsphaltDark = color(0x3d3f43);
  const cAsphaltLight = color(0x686a6e);
  const cManhole = color(0x4a433c);
  const cOldPatch = color(0x77787a);

  // World size of a pixel: fine texture settles to its mean before it can alias at grazing angles or from the air
  const pixelSize = length(fwidth(positionWorld.xz));
  // Cracks, utility-cut patches & potholes, shared by every channel below (see roadWear)
  const wear = roadWear(positionWorld.xz, pixelSize);
  const crack = wear.x;
  const patchDist = wear.y;
  const pothole = wear.z;
  const patchCover = smoothstep(pixelSize, pixelSize.negate(), patchDist).mul(wear.w);
  // The tar sealing the saw-cut edge of each patch, a few centimetres wide
  const sealWidth = max(float(0.022), pixelSize.mul(0.75));
  const patchSeal = float(1.0)
    .sub(smoothstep(sealWidth, sealWidth.add(pixelSize), abs(patchDist)))
    .mul(float(0.022).div(sealWidth))
    .mul(wear.w);
  // Fresh patches are darker & tighter than the roadway, old ones paler & greyer
  const patchFresh = step(0.55, hash2D(floor(positionWorld.xz.div(11.0)).add(vec2(12.9, 6.6))));
  // Exposed light stone chips in the worn surface, settling to their average where they shrink below a pixel
  const chips = mix(
    float(0.035),
    smoothstep(0.72, 0.8, noise2D(positionWorld.xz.mul(30.0))),
    smoothstep(0.03, 0.012, pixelSize),
  );
  // Tar-snake crack sealant (none over the newer patches)
  const tarSnake = roadTarSnakes(positionWorld.xz, pixelSize).mul(float(1.0).sub(patchCover));
  // Oil & coolant drips from parked & idling cars: ragged dark blots a hand or two across, one 2.5 m cell in three
  const oilCell = floor(positionWorld.xz.div(2.5));
  const oilCentre = oilCell
    .add(
      vec2(hash2D(oilCell.add(vec2(4.1, 2.2))), hash2D(oilCell.add(vec2(8.3, 6.7))))
        .mul(0.6)
        .add(0.2),
    )
    .mul(2.5);
  const oilDist = length(positionWorld.xz.sub(oilCentre)).mul(
    noise2D(positionWorld.xz.mul(5.0)).sub(0.5).mul(0.8).add(1.0),
  );
  const oilRadius = hash2D(oilCell.add(vec2(1.9, 9.4)))
    .mul(0.25)
    .add(0.1);
  const oilDrip = smoothstep(oilRadius.add(pixelSize), oilRadius.mul(0.3), oilDist)
    .mul(step(0.66, hash2D(oilCell.add(vec2(7.7, 3.3)))))
    .mul(
      hash2D(oilCell.add(vec2(2.6, 5.1)))
        .mul(0.6)
        .add(0.4),
    );

  // Circular cast-iron cast-iron manhole covers scattered over the roadway (one 14 m cell in three)
  const mhCell = floor(positionWorld.xz.div(14.0));
  const mhCentre = mhCell
    .add(
      vec2(hash2D(mhCell.add(13.7)), hash2D(mhCell.add(29.1)))
        .mul(0.6)
        .add(0.2),
    )
    .mul(14.0);
  const mhDist = length(positionWorld.xz.sub(mhCentre));
  const hasManhole = step(0.66, hash2D(mhCell));

  // Puddle field & wetness masks shared by every channel below (each node is generated once per fragment); potholes
  // hold water first
  const puddleField = roadPuddleField(positionWorld.x, positionWorld.z).add(pothole.mul(0.45));
  const wet = roadWetMasks(puddleField);
  const damp = wet.x;
  const puddle = wet.y;
  const film = wet.z;
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const waterFresnel = pow(float(1.0).sub(clamp(viewDir.y, 0.0, 1.0)), 5.0)
    .mul(0.98)
    .add(0.02);

  mat.aoNode = canyonSkyAONode();

  mat.colorNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const camDist = length(positionWorld.sub(cameraPosition));
    const detail = smoothstep(240.0, 22.0, camDist);

    // Two-scale aggregate grit, patchwork pours, oily wear stains & tar crack seams
    const microAggregate = mix(
      float(0.5),
      noise2D(vec2(wx.mul(16.0), wz.mul(16.0))),
      smoothstep(0.06, 0.02, pixelSize),
    );
    const fineGrain = mix(
      float(0.5),
      noise2D(vec2(wx.mul(3.2), wz.mul(3.2))),
      smoothstep(0.4, 0.12, pixelSize),
    );
    const patchNoise = noise2D(vec2(wx.mul(0.18), wz.mul(0.18)));
    const oilyStain = smoothstep(0.52, 0.84, noise2D(vec2(wx.mul(0.42), wz.mul(0.42)))).mul(detail);
    const tarSeam = float(1.0)
      .sub(smoothstep(0.0, 0.04, abs(patchNoise.sub(0.52))))
      .mul(0.19)
      .mul(detail);
    // Binder-rich (dark) & ravelled, aggregate-exposed (pale) mottling a stride or so across
    const mottle = noise2D(vec2(wx.mul(0.9), wz.mul(0.9)).add(41.0))
      .mul(0.65)
      .add(noise2D(vec2(wx.mul(2.3), wz.mul(2.3)).add(7.0)).mul(0.35));

    const baseAsphalt = mix(
      cAsphaltDark,
      cAsphaltLight,
      fineGrain
        .mul(0.3)
        .add(microAggregate.mul(0.22))
        .add(patchNoise.mul(0.14))
        .add(smoothstep(0.3, 0.7, mottle).mul(0.18))
        .add(0.036),
    )
      .mul(float(1.0).sub(oilyStain.mul(0.21)))
      .mul(float(1.0).sub(tarSeam));

    // Utility-cut patches with their tar-sealed edges, stone chips, tar snakes, oil drips, cracks & potholes
    const patchCol = mix(mix(baseAsphalt, cOldPatch, 0.45).mul(1.08), baseAsphalt.mul(0.78), patchFresh);
    const repaired = mix(baseAsphalt, patchCol, patchCover)
      .mul(float(1.0).sub(patchSeal.mul(0.3)))
      .add(chips.mul(0.047).mul(float(1.0).sub(patchCover.mul(patchFresh))))
      .mul(float(1.0).sub(tarSnake.mul(0.62)))
      .mul(float(1.0).sub(oilDrip.mul(0.45)))
      .mul(float(1.0).sub(crack.mul(0.65)))
      .mul(float(1.0).sub(pothole.mul(0.4)));

    const isManhole = float(1.0)
      .sub(smoothstep(0.52, 0.6, mhDist))
      .mul(hasManhole)
      .mul(detail);
    const mhRings = sin(mhDist.mul(36.0)).mul(0.15).add(0.85);

    // Water filling the pores darkens the surface: damp stains & pools most, the overall wet film a little
    const wetDarkening = mix(mix(float(1.0), float(0.72), damp), float(0.6), puddle).mul(
      mix(float(1.0), float(0.8), film),
    );
    return mix(repaired, cManhole.mul(mhRings), isManhole).mul(wetDarkening);
  })();

  mat.roughnessNode = Fn(() => {
    const microRough = mix(
      float(0.04),
      noise2D(positionWorld.xz.mul(12.0)).mul(0.08),
      smoothstep(0.08, 0.03, pixelSize),
    );
    // Tar sealant is glossier, oil satin, fresh patches a little tighter, potholes & cracks rougher
    const dry = float(0.9)
      .add(microRough)
      .sub(patchSeal.mul(0.3))
      .sub(tarSnake.mul(0.38))
      .sub(oilDrip.mul(0.18))
      .sub(patchCover.mul(patchFresh).mul(0.06))
      .add(pothole.mul(0.06));
    // The wet film only takes the edge off the asphalt's mattness (a soft sheen, too rough for SSR); real gloss is kept
    // for the damp stains and the standing water
    const filmed = mix(dry, float(0.68), film.mul(0.7));
    const wetRough = mix(filmed, float(0.4), damp.mul(0.85));
    return mix(wetRough, float(0.1), puddle);
  })();

  // Water's Fresnel (F0 = 0.02): weights SSR & trades diffuse for reflection in pools (fully), damp stains (partly) and
  // the wet film (barely)
  mat.metalnessNode = clamp(waterFresnel.mul(1.6), 0.0, 0.85).mul(
    max(puddle, max(damp.mul(0.35), film.mul(0.15))),
  );

  // Footprint-gated asphalt relief via bumpNormal (from CityGenerator.js): a gentle swell & sag of the paving, shallow
  // ruts & ripples, 6 mm ravelled coarse texture + 2.2 mm & 1.6 mm aggregate grit, stone chips, hairline cracks, raised
  // patches with their tar seals, tar-snake beads, pothole bowls and the manhole covers' rims & rings. Steps ramp over
  // >= 2 px so no edge sparkles; the finest relief fades before it shrinks to a pixel. Flattens to mirror-smooth 0.0
  // inside standing rainwater puddles so SSR reflections stay crisp!
  mat.normalNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const coarseFade = smoothstep(0.12, 0.035, pixelSize);
    const midFade = smoothstep(0.035, 0.012, pixelSize);
    const fineFade = smoothstep(0.02, 0.006, pixelSize).mul(float(1.0).sub(film.mul(0.6)));
    const ramp = max(float(0.012), pixelSize.mul(2.0));

    const swell = noise2D(vec2(wx.mul(0.55), wz.mul(0.55)).add(23.0))
      .sub(0.5)
      .mul(0.02)
      .add(
        noise2D(vec2(wx.mul(1.9), wz.mul(1.9)))
          .sub(0.5)
          .mul(0.005),
      );
    const ripples = noise2D(vec2(wx.mul(3.6), wz.mul(3.6)).add(61.0))
      .sub(0.5)
      .mul(0.004)
      .mul(smoothstep(0.3, 0.1, pixelSize));
    const coarseGrit = noise2D(vec2(wx.mul(8.5), wz.mul(8.5)))
      .sub(0.5)
      .mul(0.006)
      .mul(coarseFade);
    const midGrit = noise2D(vec2(wx.mul(19.0), wz.mul(19.0)).add(3.0))
      .sub(0.5)
      .mul(0.0022)
      .mul(midFade);
    const fineGrit = noise2D(vec2(wx.mul(36.0), wz.mul(36.0)))
      .sub(0.5)
      .mul(0.0016)
      .mul(fineFade);
    const chipRelief = chips.mul(0.0015).mul(midFade);
    const snakeBead = tarSnake.mul(0.0018);
    const crackGroove = crack.mul(0.003).mul(smoothstep(0.012, 0.004, pixelSize));
    const patchStep = smoothstep(ramp, ramp.negate(), patchDist).mul(wear.w).mul(0.004);
    const sealBead = float(1.0)
      .sub(smoothstep(0.0, max(float(0.03), ramp), abs(patchDist)))
      .mul(wear.w)
      .mul(0.0015);
    const bowl = pothole.mul(0.03);
    const mhRim = float(1.0)
      .sub(smoothstep(0.0, max(float(0.02), ramp), abs(mhDist.sub(0.58))))
      .mul(0.004);
    const mhPattern = sin(mhDist.mul(36.0))
      .mul(0.0008)
      .mul(step(mhDist, 0.54))
      .mul(smoothstep(0.01, 0.004, pixelSize));
    const manhole = mhPattern.sub(mhRim).mul(hasManhole).mul(coarseFade);

    const height = swell
      .add(ripples)
      .add(coarseGrit)
      .add(midGrit)
      .add(fineGrit)
      .add(chipRelief)
      .add(snakeBead)
      .sub(crackGroove)
      .add(patchStep)
      .add(sealBead)
      .sub(bowl)
      .add(manhole);
    return bumpNormal(height.mul(float(1.0).sub(puddle)));
  })();

  mat.emissiveNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;

    const roadFresnel = pow(clamp(float(1.0).sub(abs(viewDir.y)), 0.0, 1.0), 2.3);

    const skyMirror = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, 0.4).mul(0.1);

    const tsDist = cityUniforms.uTheme;
    const neonPatch = noise2D(vec2(wx.mul(0.15), wz.mul(0.15)));
    const neonCol = mix(color(0xff2a85), color(0x2ad4ff), neonPatch).mul(0.32);
    const reflectCol = mix(skyMirror, neonCol, tsDist.mul(0.65));

    return reflectCol
      .mul(max(puddle, film.mul(0.35)))
      .mul(roadFresnel)
      .mul(cityUniforms.uInteriorGlow)
      .mul(0.07);
  })();

  return mat;
}

function createSidewalkMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.0,
    roughness: 0.88,
  });

  const cConcreteA = color(0xa7a197);
  const cConcreteB = color(0x8e887e);
  const cGumOld = color(0x77756f);
  const cGumNew = color(0x34332f);

  // Damp patches & pools on the flags, shared by every channel below (own field; drains better than the roadway)
  const swField = noise2D(vec2(positionWorld.x.mul(0.14).add(7.4), positionWorld.z.mul(0.14).sub(13.1)))
    .mul(0.65)
    .add(noise2D(vec2(positionWorld.x.mul(0.38), positionWorld.z.mul(0.38))).mul(0.35));
  const swWet = roadWetMasks(swField, 0.06);
  const swPuddle = swWet.y.mul(smoothstep(0.5, 0.9, normalWorldGeometry.y));
  const swFresnel = pow(float(1.0).sub(clamp(normalize(cameraPosition.sub(positionWorld)).y, 0.0, 1.0)), 5.0)
    .mul(0.98)
    .add(0.02);
  const pixelSize = length(fwidth(positionWorld.xz));

  // 5 ft (1.524 m) flags poured in place: the flag, where in it (-0.5 .. 0.5) and how far to its tooled joints (m)
  const FLAG = 1.524;
  const wxz = positionWorld.xz;
  const flagCoord = wxz.div(FLAG);
  const flagId = floor(flagCoord);
  const flagHash = hash2D(flagId);
  const flagLocal = fract(flagCoord).sub(0.5);
  const edgeDist = float(0.5)
    .sub(max(abs(flagLocal.x), abs(flagLocal.y)))
    .mul(FLAG);
  // One flag in seven is a newer, paler replacement that hasn't collected the grime & gum of its neighbours yet
  const replaced = step(0.86, flagHash);
  // 6 mm tooled joints filled with dirt, the grime that collects either side of them and the smooth trowelled margin the
  // jointing tool leaves beyond that (filter-width anti-aliased: each settles to its mean once below a pixel)
  const gridBand = (halfWidth) =>
    max(gridLine(positionWorld.x, FLAG, halfWidth), gridLine(positionWorld.z, FLAG, halfWidth));
  const joints = gridBand(0.003);
  const jointGrime = gridBand(0.018);
  const tooledBand = gridBand(0.045).sub(jointGrime).max(0.0);

  // Flattened chewing gum: a dark fresh blob here and there, grey ghosts of older ones, thickest on busy stretches
  const gumCell = 0.32;
  const gumCoord = wxz.div(gumCell);
  const gumId = floor(gumCoord);
  const gumCentre = vec2(hash2D(gumId.add(vec2(11.3, 2.9))), hash2D(gumId.add(vec2(23.9, 17.4))))
    .mul(0.6)
    .add(0.2);
  const gumRadius = hash2D(gumId.add(vec2(4.1, 31.7)))
    .mul(0.011)
    .add(0.006);
  const gumWobble = noise2D(gumCoord.mul(9.0)).sub(0.5).mul(0.35).add(1.0);
  const gumDist = length(fract(gumCoord).sub(gumCentre)).mul(gumCell).mul(gumWobble);
  const gumDensity = smoothstep(0.3, 0.8, noise2D(wxz.mul(0.07).add(5.3)))
    .mul(0.4)
    .add(0.12)
    .mul(float(1.0).sub(replaced.mul(0.8)));
  const gumAA = max(pixelSize, 0.001);
  const gum = smoothstep(gumRadius.add(gumAA), gumRadius.sub(gumAA.mul(0.5)), gumDist)
    .mul(step(float(1.0).sub(gumDensity), hash2D(gumId.add(vec2(7.7, 3.3)))))
    .mul(smoothstep(0.04, 0.015, pixelSize));
  const gumAge = hash2D(gumId.add(vec2(19.1, 0.7)));

  // Hairline settlement cracks across about one flag in eight, wandering a little
  const crackAngle = hash2D(flagId.add(vec2(5.5, 1.3))).mul(Math.PI);
  const crackOffset = hash2D(flagId.add(vec2(8.8, 6.2)))
    .sub(0.5)
    .mul(0.6);
  const crackWander = noise2D(wxz.mul(7.0))
    .sub(0.5)
    .mul(0.02)
    .add(noise2D(wxz.mul(1.7).add(3.7)).sub(0.5).mul(0.07));
  const crackDist = dot(flagLocal, vec2(cos(crackAngle), sin(crackAngle)))
    .sub(crackOffset)
    .mul(FLAG)
    .add(crackWander);
  const hasCrack = step(0.875, hash2D(flagId.add(vec2(41.7, 9.2)))).mul(float(1.0).sub(replaced));
  const crack = lineAA(crackDist, 0.0012)
    .mul(hasCrack)
    .mul(smoothstep(0.004, 0.02, edgeDist));

  mat.aoNode = canyonSkyAONode();

  mat.colorNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const camDist = length(positionWorld.sub(cameraPosition));
    const detail = smoothstep(190.0, 16.0, camDist);

    // Pour-to-pour tone, broad traffic-worn & weathered stains, and fine exposed aggregate
    const tone = noise2D(vec2(wx.mul(0.48), wz.mul(0.48)));
    const stainField = noise2D(vec2(wx.mul(0.8), wz.mul(0.8)).add(17.0))
      .mul(0.65)
      .add(noise2D(vec2(wx.mul(2.6), wz.mul(2.6))).mul(0.35));
    const stain = smoothstep(0.52, 0.86, stainField).mul(mix(float(0.24), float(0.08), replaced));
    const grit = noise2D(vec2(wx.mul(14.0), wz.mul(14.0)))
      .sub(0.5)
      .mul(0.07)
      .mul(detail)
      .mul(smoothstep(0.07, 0.02, pixelSize));
    // Cloudy trowel & curing mottling a hand or two across
    const mottle = noise2D(vec2(wx.mul(3.1), wz.mul(3.1)).add(41.0))
      .mul(0.6)
      .add(noise2D(vec2(wx.mul(7.3), wz.mul(7.3))).mul(0.4))
      .sub(0.5)
      .mul(0.12)
      .mul(smoothstep(0.15, 0.05, pixelSize));
    const aggregate = noise2D(vec2(wx.mul(55.0), wz.mul(55.0)))
      .sub(0.5)
      .mul(0.08)
      .mul(smoothstep(0.02, 0.006, pixelSize));

    const flagTone = flagHash
      .sub(0.5)
      .mul(0.2)
      .add(1.0)
      .mul(mix(float(1.0), float(1.1), replaced));
    const concrete = mix(cConcreteB, cConcreteA, tone)
      .mul(flagTone)
      .mul(float(1.0).sub(stain))
      .mul(mottle.add(1.0))
      .add(grit.add(aggregate).mul(0.6))
      .mul(tooledBand.mul(0.06).add(1.0))
      .mul(float(1.0).sub(jointGrime.mul(0.18)));

    const withGum = mix(
      concrete,
      mix(cGumNew, cGumOld, gumAge),
      gum.mul(mix(float(0.9), float(0.45), gumAge)),
    );
    const withJoints = withGum
      .mul(float(1.0).sub(joints.mul(0.55).mul(detail)))
      .mul(float(1.0).sub(crack.mul(0.45)));

    // Post-rain damp patches, pools & the overall wet film darken the flags
    return withJoints
      .mul(mix(float(1.0), float(0.72), max(swWet.x, swPuddle)))
      .mul(mix(float(1.0), float(0.8), swWet.z));
  })();

  mat.roughnessNode = Fn(() => {
    const dry = float(0.9).sub(flagHash.mul(0.06)).sub(tooledBand.mul(0.1)).sub(gum.mul(0.25));
    const wetRough = mix(dry, float(0.55), max(swWet.z, swWet.x.mul(0.7)));
    return mix(wetRough, float(0.2), swPuddle);
  })();

  // Water's Fresnel (F0 = 0.02) on pools & the wet film, as for the roadway
  mat.metalnessNode = clamp(swFresnel.mul(1.6), 0.0, 0.85).mul(max(swPuddle, swWet.z.mul(0.3)));

  // 6 mm tooled joint grooves with rounded edges, flags heaved a little out of true by tree roots & frost, hairline
  // cracks, gum blobs and concrete grain via bumpNormal. Edges ramp over >= 2 px so nothing sparkles along the joints.
  mat.normalNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const camDist = length(positionWorld.sub(cameraPosition));
    const detail = smoothstep(140.0, 14.0, camDist);
    const rampPx = pixelSize.mul(2.0);

    const groove = float(1.0)
      .sub(smoothstep(0.003, max(float(0.012), rampPx), edgeDist))
      .mul(0.006)
      .mul(smoothstep(0.02, 0.006, pixelSize));
    const tiltAngle = hash2D(flagId.add(vec2(2.3, 13.1))).mul(Math.PI * 2.0);
    const tiltSlope = hash2D(flagId.add(vec2(29.3, 3.7)))
      .mul(0.012)
      .mul(float(1.0).sub(replaced));
    const tilt = dot(flagLocal, vec2(cos(tiltAngle), sin(tiltAngle)))
      .mul(FLAG)
      .mul(tiltSlope)
      .mul(smoothstep(0.0, max(float(0.06), pixelSize.mul(3.0)), edgeDist));
    const grain = noise2D(vec2(wx.mul(4.5), wz.mul(4.5)))
      .sub(0.5)
      .mul(0.003);
    const pores = noise2D(vec2(wx.mul(38.0), wz.mul(38.0)))
      .sub(0.5)
      .mul(0.0008)
      .mul(smoothstep(0.012, 0.004, pixelSize));
    const height = grain
      .add(pores)
      .add(tilt)
      .sub(groove)
      .sub(crack.mul(0.0015))
      .add(gum.mul(0.0008))
      .mul(detail)
      .mul(float(1.0).sub(swPuddle));
    return bumpNormal(height);
  })();

  return mat;
}

export { createRoadSurfaceMaterial, createSidewalkMaterial };

const _transparentEffectMRT = mrt({ normal: vec4(0), metalRough: vec4(0) });
export const ROAD_PAINT_MAX_WIDEN = 16;

export function expandRoadPaintBounds(geometry) {
  const side = geometry.attributes.side;
  if (side?.itemSize !== 2 || side.count !== geometry.attributes.position.count)
    throw new Error('Road paint bounds require a side offset for every vertex');
  let paddingX = 0,
    paddingZ = 0,
    paddingRadius = 0;
  for (let i = 0; i < side.count; i++) {
    const x = side.getX(i),
      z = side.getY(i);
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('Road paint side offsets must be finite');
    paddingX = Math.max(paddingX, Math.abs(x));
    paddingZ = Math.max(paddingZ, Math.abs(z));
    paddingRadius = Math.max(paddingRadius, Math.hypot(x, z));
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // The position shader can move an edge by up to (max widen - 1) side
  // offsets. Store both bounds before BatchedMesh caches each spatial piece.
  const extra = ROAD_PAINT_MAX_WIDEN - 1;
  geometry.boundingBox.expandByVector(new THREE.Vector3(paddingX * extra, 0, paddingZ * extra));
  geometry.boundingSphere.radius += paddingRadius * extra;
  return geometry;
}

function createRoadPaintMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    metalness: 0.0,
  });
  mat.mrtNode = _transparentEffectMRT; // SSR keeps seeing the asphalt (and its puddles) underneath

  const paint = attribute('paint', 'vec3');
  const side = attribute('side', 'vec2');
  const sideOffset = vec3(side.x, 0.0, side.y);

  // How much to widen the strip so it is at least 1.5 px wide on screen (1 when it already is)
  const widen = Fn(() => {
    const viewProjection = cameraProjectionMatrix.mul(cameraViewMatrix);
    const edge = viewProjection.mul(vec4(positionGeometry, 1.0));
    const centre = viewProjection.mul(vec4(positionGeometry.sub(sideOffset), 1.0));
    const halfWidthPx = length(edge.xy.div(edge.w).sub(centre.xy.div(centre.w)).mul(screenSize).mul(0.5));
    const inFront = step(0.05, min(edge.w, centre.w));
    return clamp(float(0.75).div(max(halfWidthPx, 0.001)), 1.0, ROAD_PAINT_MAX_WIDEN)
      .mul(inFront)
      .max(1.0);
  })();
  mat.positionNode = positionGeometry.add(sideOffset.mul(widen.sub(1.0)));

  // Exact box filter of the dashes (on for `duty` of each period) over the pixel footprint
  const t = paint.x.div(paint.y);
  const footprint = max(fwidth(t), 0.0001);
  const duty = paint.z;
  const onSoFar = (x) =>
    floor(x)
      .mul(duty)
      .add(clamp(fract(x).sub(float(1.0).sub(duty).mul(0.5)), 0.0, duty));
  const dashes = onSoFar(t.add(footprint.mul(0.5)))
    .sub(onSoFar(t.sub(footprint.mul(0.5))))
    .div(footprint);

  const xz = positionWorld.xz;
  const detail = smoothstep(70.0, 15.0, length(positionWorld.sub(cameraPosition)));
  const wear = mix(
    float(0.5),
    noise2D(xz.mul(0.8))
      .mul(0.6)
      .add(noise2D(xz.mul(2.3)).mul(0.4)),
    detail,
  );
  mat.opacityNode = dashes
    .mul(varying(float(1.0).div(widen)))
    .mul(smoothstep(0.1, 0.6, wear).mul(0.4).add(0.55));

  const wet = roadWetMasks(roadPuddleField(positionWorld.x, positionWorld.z)); // same pools & film as the asphalt
  mat.colorNode = vec3(mix(float(1.0), float(0.72), wet.y).mul(mix(float(1.0), float(0.86), wet.z)));
  mat.emissiveNode = streetLightWash(attribute('color', 'vec3').mul(0.58));
  mat.roughnessNode = mix(mix(float(0.62), float(0.42), wet.z), float(0.2), wet.y);
  mat.aoNode = canyonSkyAONode();

  return mat;
}

export { createRoadPaintMaterial };
