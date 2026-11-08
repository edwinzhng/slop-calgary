// Adapted from mrdoob/slop-newyork (MIT); see LICENSE and THIRD_PARTY.md.
import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  attribute,
  positionLocal,
  positionGeometry,
  positionWorld,
  positionViewDirection,
  normalLocal,
  normalView,
  normalViewGeometry,
  normalWorld,
  frontFacing,
  time,
  texture,
  uv,
  sin,
  abs,
  fract,
  floor,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  dot,
  normalize,
  pow,
} from 'three/tsl';
import { noise2D } from './render-nodes.js';
import { cityUniforms } from './city-uniforms.js';
const canyonSkyAONode = Fn(() => smoothstep(0, 60, positionWorld.y).mul(0.4).add(0.6));
class FoliageLightingModel extends THREE.PhysicalLightingModel {
  direct(lightData, builder) {
    const { lightDirection, lightColor, reflectedLight } = lightData;
    const translucency = builder.material.translucencyNode;
    if (translucency) {
      const scatter = normalize(lightDirection.add(normalView.mul(0.3)));
      const through = pow(clamp(dot(positionViewDirection, scatter.negate()), 0.0, 1.0), 3.0);
      reflectedLight.directDiffuse.addAssign(lightColor.mul(translucency).mul(through));
    }
    super.direct(lightData, builder);
  }
}

class TreeNodeMaterial extends THREE.MeshStandardNodeMaterial {
  static get type() {
    return 'TreeNodeMaterial';
  }

  constructor(parameters) {
    super(parameters);
    this.translucencyNode = null;
    this.treeShapeNode = null;
  }

  setupPosition(builder) {
    // Calgary's public inventory measures DBH. Correct only the low bark before
    // the instance transform, preserving the original branch/card architecture.
    if (this.treeShapeNode) positionLocal.assign(this.treeShapeNode);
    return super.setupPosition(builder);
  }

  setupLightingModel() {
    return new FoliageLightingModel();
  }
}

// Position displacement limits also bound independently culled tree cells.
export const TREE_WIND_LIMITS = Object.freeze({
  directionX: 0.86,
  directionZ: 0.51,
  heightM: 11,
  lean: 0.2,
  rock: 0.06,
  bob: 0.05,
  flutter: 0.03,
  flutterStrengthExtra: 0.25,
});

export function treeWindBoundsPadding(geometry) {
  const position = geometry.attributes.position,
    tree = geometry.attributes.aTree,
    limits = TREE_WIND_LIMITS;
  if (!tree) return 0;
  const swayScale = Math.hypot(limits.directionX, limits.directionZ) * Math.hypot(limits.lean, limits.rock);
  let padding = 0;
  for (let i = 0; i < position.count; i++) {
    const sway = swayScale * (position.getY(i) / limits.heightM) ** 2,
      bob = limits.bob * Math.abs(tree.getZ(i)),
      flutter = limits.flutter * (1 + limits.flutterStrengthExtra) * Math.abs(tree.getX(i) * tree.getZ(i));
    // Instance normals are normalized before the position node. Sway is
    // horizontal, bob is vertical and flutter can point in any direction.
    padding = Math.max(padding, Math.hypot(sway, bob) + flutter);
  }
  return padding + 0.01;
}

// Prevailing wind (xz, blowing from the west-north-west across Manhattan)
const TREE_WIND = vec2(TREE_WIND_LIMITS.directionX, TREE_WIND_LIMITS.directionZ);

/**
 * Instanced street & park tree material (js/trees.js): bark tubes and alpha-tested leaf cards in ONE draw per mesh.
 * Geometry attributes:
 * - uv: leaf-atlas coordinates on the cards; on the bark (metres round the stem, metres along it)
 * - normal: on the cards, crown-shell normals (out from the crown centre, blended with the card face), so a crown
 *   shades as one leafy volume and both sides of a card light alike (the back faces keep them unflipped)
 * - aTree (vec4): x = 1 on leaf cards / 0 on bark, y = crown occlusion (0 deep inside .. 1 on the outer shell),
 *   z = sway weight (0 on the trunk .. 1 at the twig tips & cards), w = per-card random (leaf flutter phase)
 * - aTreeData (instanced vec4): rgb = per-tree linear foliage tint, w = species index + per-tree random fraction
 *   (0 ash: grey furrows; 1 poplar/aspen: pale bark when the fraction is below 0.5; 2 elm: dark furrows)
 * Leaf atlas texels: r = leaf brightness, g = per-leaf hue jitter, b = twig / stalk mask, a = coverage (its mipmaps
 * keep the coverage, so distant crowns stay full).
 * Shading: per-tree tint with sun-yellowed & cooler leaves, deep leaves darker and occluded from the sky, sunlight
 * shining through the leaves toward the camera (FoliageLightingModel), alpha-to-coverage leaf edges on the MSAA scene
 * pass (alpha-tested in the shadow maps: dappled shadows). Wind: gusts rolling across the city sway the crowns
 * (shadows follow), branches bob and leaves flutter.
 */
function createTreeMaterial(leafAtlas, { measuredTrunks = false } = {}) {
  const mat = new TreeNodeMaterial({
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    metalness: 0.0,
    roughness: 0.8,
  });

  const aTree = attribute('aTree', 'vec4');
  const aData = attribute('aTreeData', 'vec4');
  const isLeaf = aTree.x;
  const solidLeaf = step(1, aTree.w);
  const crownAO = aTree.y;
  const rnd = fract(aData.w);
  const species = floor(aData.w);
  const leaf = texture(leafAtlas, uv());
  if (measuredTrunks) {
    const shape = attribute('aTreeShape', 'vec2');
    mat.treeShapeNode = Fn(() => {
      const g = positionGeometry;
      const lowBark = float(1)
        .sub(isLeaf)
        .mul(float(1).sub(smoothstep(1.8, 3.2, g.y.mul(shape.y))));
      const radius = mix(float(1), shape.x, lowBark);
      return vec3(g.x.mul(radius), g.y, g.z.mul(radius));
    })();
  }

  // Wind. positionLocal is already instanced (world space); positionGeometry is the tree's own frame (metres)
  mat.positionNode = Fn(() => {
    const p = positionLocal;
    const g = positionGeometry;
    const phase = rnd.mul(6.2832);
    // gusts rolling downwind across the city
    const gust = sin(time.mul(0.5).sub(dot(p.xz, TREE_WIND).mul(0.045)))
      .mul(0.5)
      .add(0.5);
    const strength = gust.mul(gust).mul(0.7).add(0.3);
    // the whole tree bends with height, leaning downwind and rocking across it
    const h = g.y.div(TREE_WIND_LIMITS.heightM);
    const bend = h.mul(h);
    const lean = sin(time.mul(0.85).add(phase)).mul(0.45).add(0.55).mul(strength).mul(TREE_WIND_LIMITS.lean);
    const rock = sin(time.mul(0.67).add(phase.mul(1.7)))
      .mul(TREE_WIND_LIMITS.rock)
      .mul(strength);
    const sway = vec3(
      TREE_WIND.x.mul(lean).sub(TREE_WIND.y.mul(rock)),
      0.0,
      TREE_WIND.y.mul(lean).add(TREE_WIND.x.mul(rock)),
    ).mul(bend);
    // branches bob, the phase flowing smoothly through the crown so joints stay together
    const bob = sin(time.mul(2.1).add(g.x.mul(0.9)).add(g.z.mul(0.7)).add(phase))
      .mul(TREE_WIND_LIMITS.bob)
      .mul(aTree.z)
      .mul(strength);
    // leaves flutter, every card on its own
    const flutter = sin(time.mul(8.0).add(aTree.w.mul(37.0)).add(g.y.mul(2.0)))
      .mul(TREE_WIND_LIMITS.flutter)
      .mul(isLeaf)
      .mul(aTree.z)
      .mul(strength.add(TREE_WIND_LIMITS.flutterStrengthExtra));
    return p
      .add(sway)
      .add(vec3(0.0, bob, 0.0))
      .add(normalLocal.mul(flutter));
  })();

  // Coverage: leaf cards from the atlas; bark is opaque from outside (its back faces are dropped)
  const alpha = mix(float(frontFacing), leaf.a, isLeaf.sub(solidLeaf));
  mat.alphaTest = 0.5;

  mat.colorNode = Fn(() => {
    // Leaves: per-tree tint x atlas brightness, a share of sun-yellowed and of cooler leaves, brown twigs & stalks,
    // darker deep in the crown
    const tint = aData.xyz;
    const shade = smoothstep(0.23, 0.42, leaf.r)
      .mul(0.35)
      .add(smoothstep(0.49, 0.65, leaf.r).mul(0.32));
    const base = tint.mul(mix(leaf.r.mul(1.4), shade.add(0.35), 0.56));
    const warm = smoothstep(0.62, 1.0, leaf.g).mul(0.55);
    const cool = smoothstep(0.38, 0.0, leaf.g).mul(0.45);
    const leafCol = mix(
      mix(base, base.mul(vec3(1.25, 1.08, 0.5)), warm),
      base.mul(vec3(0.8, 0.92, 1.05)),
      cool,
    );
    const foliage = mix(leafCol, color(0x4a3b2c), leaf.b).mul(crownAO.mul(0.45).add(0.55));

    // Inferred bark in metre UVs: grey furrows for ash/elm, pale poplar with darker scars.
    const bu = uv();
    const n1 = noise2D(vec2(bu.x.mul(5.0), bu.y.mul(1.1)).add(rnd.mul(17.0)));
    const n2 = noise2D(bu.mul(vec2(3.2, 1.9)).add(rnd.mul(31.0)));
    const ridge = float(1.0).sub(abs(n1.sub(0.5).mul(2.0)));
    const furrowed = mix(color(0x393932), color(0x77766a), smoothstep(0.35, 0.9, ridge));
    const poplarBark = mix(color(0xb5ba9c), color(0x5a6253), smoothstep(0.66, 0.8, n2));
    const bark = mix(furrowed, poplarBark, species.equal(1).and(rnd.lessThan(0.5))).mul(
      crownAO.mul(0.4).add(0.6),
    );

    const sunSide = dot(normalWorld, vec3(-0.37, 0.82, 0.44));
    const tier = smoothstep(-0.1, 0.03, sunSide)
      .mul(0.26)
      .add(smoothstep(0.48, 0.59, sunSide).mul(0.23));
    const clump = tint.mul(tier.add(0.72).add(fract(aTree.w).mul(0.16)));
    const surface = mix(bark, mix(foliage, clump, solidLeaf), isLeaf);
    const snow = cityUniforms.uSnow.mul(smoothstep(0.1, 0.8, normalWorld.y));
    return vec4(mix(surface, color(0xe7edf0), snow.mul(0.92)), alpha);
  })();

  mat.roughnessNode = mix(float(0.93), float(0.72).sub(leaf.r.mul(0.1)), isLeaf);

  // Card normals are crown-shell normals on both faces: no back-face flip
  mat.normalNode = normalViewGeometry;

  // Sky light: street-canyon occlusion, deep inside the crown far less
  mat.aoNode = canyonSkyAONode().mul(crownAO.mul(0.75).add(0.25));

  // Light through the leaves: yellow-green, strongest out on the thin shell
  mat.translucencyNode = aData.xyz
    .mul(vec3(1.0, 1.2, 0.45))
    .mul(leaf.r.mul(1.5))
    .mul(crownAO.mul(0.8).add(0.2))
    .mul(isLeaf)
    .mul(float(1).sub(cityUniforms.uSnow.mul(0.7)));

  return mat;
}

export { createTreeMaterial };
