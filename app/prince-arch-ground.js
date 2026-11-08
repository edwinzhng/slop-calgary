import { createIslandTerrain } from './island-terrain.js';
import evidence from '../data/prince-arch-evidence.json' with { type: 'json' };

export const PRINCE_ARCH_GROUND_URL = new URL('../data/prince-arch-ground.bin', import.meta.url);
export const PRINCE_ARCH_GROUND_BOUNDS = Object.freeze([80, -1162, 144, -1082]);
export const PRINCE_ARCH_GROUND_BLEND_M = 10;
const spec = evidence.localGroundGrid;
const clamp = (v) => Math.max(0, Math.min(1, v)),
  smooth = (v) => {
    const t = clamp(v);
    return t * t * (3 - 2 * t);
  };
function bytesOf(binary) {
  return binary instanceof ArrayBuffer
    ? new Uint8Array(binary)
    : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
}
function fnv1a(bytes) {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}
export function validatePrinceArchGround(binary) {
  const bytes = bytesOf(binary);
  if (
    spec.step !== 2 ||
    spec.width !== 33 ||
    spec.height !== 41 ||
    spec.origin[0] !== 80 ||
    spec.origin[1] !== -1162 ||
    spec.bounds.some((v, i) => v !== PRINCE_ARCH_GROUND_BOUNDS[i]) ||
    bytes.byteLength !== spec.byteLength ||
    bytes.byteLength !== 5412 ||
    fnv1a(bytes) !== spec.fnv1a
  )
    throw new Error('Prince arch ground differs from the validated City DEM crop');
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    values = new Float32Array(source);
  if (!values.every((value) => Number.isFinite(value) && value > 1000 && value < 1100))
    throw new Error('Invalid Prince arch source elevations');
  return values;
}

/** One DEM-constrained positive-relief adaptation, not a second visible ground
 * layer. It returns a standard island terrain provider with copied Float32
 * grids/manifest, so grass, paving, paths, trees and support use the same field.
 * Outside the small source crop the original sample bytes remain untouched.
 */
export function createPrinceArchTerrain(baseTerrain, binary) {
  if (!baseTerrain?.grids?.length || !baseTerrain.manifest)
    throw new Error('Prince arch terrain requires the original island terrain provider');
  if (baseTerrain.princeArchGround)
    throw new Error('Prince arch ground must be applied once, before surface/fixture construction');
  const source = validatePrinceArchGround(binary),
    [minX, minZ, maxX, maxZ] = PRINCE_ARCH_GROUND_BOUNDS,
    lowerAt = evidence.lowerPathCrossing.point,
    baseAtLower = baseTerrain.offsetAt(...lowerAt),
    sample = (x, z) => {
      const u = clamp((x - minX) / (maxX - minX)) * (spec.width - 1),
        v = clamp((z - minZ) / (maxZ - minZ)) * (spec.height - 1),
        ix = Math.min(spec.width - 2, Math.floor(u)),
        iz = Math.min(spec.height - 2, Math.floor(v)),
        tx = u - ix,
        tz = v - iz,
        k = iz * spec.width + ix;
      return (
        (source[k] * (1 - tx) + source[k + 1] * tx) * (1 - tz) +
        (source[k + spec.width] * (1 - tx) + source[k + spec.width + 1] * tx) * tz
      );
    },
    // Both references use the same local resampling. Positive-only clipping is
    // explicit: its interpolation may raise the reference by a few centimetres;
    // record that adapted result rather than claiming exact surveyed headroom.
    localLower = sample(...lowerAt),
    weightAt = (x, z) =>
      x <= minX || x >= maxX || z <= minZ || z >= maxZ
        ? 0
        : smooth(Math.min(x - minX, maxX - x) / PRINCE_ARCH_GROUND_BLEND_M) *
          smooth(Math.min(z - minZ, maxZ - z) / PRINCE_ARCH_GROUND_BLEND_M),
    manifest = structuredClone(baseTerrain.manifest),
    byteLength = Math.max(...manifest.grids.map((g) => g.byteOffset + g.width * g.height * 4)),
    combined = new ArrayBuffer(byteLength);
  let changedSamples = 0,
    maximumDelta = 0,
    negativeResidualSamplesClamped = 0;
  for (let i = 0; i < manifest.grids.length; i++) {
    const grid = manifest.grids[i],
      previous = baseTerrain.grids[i],
      values = new Float32Array(combined, grid.byteOffset, grid.width * grid.height);
    values.set(previous.values);
    if (grid.id !== 'prince-island') continue;
    if (grid.step !== 2) throw new Error('Prince arch adaptation requires the validated 2 m island grid');
    let maximumOffset = 0;
    for (let row = 0; row < grid.height; row++)
      for (let col = 0; col < grid.width; col++) {
        const x = grid.origin.x + col * grid.step,
          z = grid.origin.z + row * grid.step,
          k = row * grid.width + col,
          weight = weightAt(x, z);
        if (weight > 0) {
          const residual = sample(x, z) - localLower,
            target = baseAtLower + Math.max(0, residual),
            old = values[k];
          if (residual < 0) negativeResidualSamplesClamped++;
          values[k] = old + (target - old) * weight;
          if (values[k] !== old) changedSamples++;
          maximumDelta = Math.max(maximumDelta, Math.abs(values[k] - old));
        }
        maximumOffset = Math.max(maximumOffset, values[k]);
      }
    grid.maximumOffset = maximumOffset;
  }
  if (!changedSamples) throw new Error('Prince arch source crop did not overlap the source island grid');
  manifest.meta = {
    ...manifest.meta,
    baseBinarySha256: manifest.meta.sha256,
    princeArchGround: {
      source: evidence.sourceGround.dataset,
      localBinarySha256: spec.sha256,
      localBinaryBytes: spec.byteLength,
      bounds: [...PRINCE_ARCH_GROUND_BOUNDS],
      blendMetres: PRINCE_ARCH_GROUND_BLEND_M,
      sourceVerticalDatum: evidence.sourceGround.verticalDatum,
      adaptation:
        'Positive local bare-earth relief relative to the lower-path sample, blended into the existing flat-city adaptation. No measured bridge deck, rise, thickness or current headroom supplied.',
      localLowerSourceElevation: localLower,
      baseLowerOffset: baseAtLower,
    },
  };
  // The old checksum describes the original binary, not this runtime composition.
  delete manifest.meta.sha256;
  const terrain = createIslandTerrain(manifest, combined);
  manifest.meta.princeArchGround.appliedLowerOffset = terrain.offsetAt(...lowerAt);
  terrain.princeArchGround = Object.freeze({
    ...manifest.meta.princeArchGround,
    changedSamples,
    maximumDelta,
    negativeResidualSamplesClamped,
  });
  terrain.stats.princeArchGround = terrain.princeArchGround;
  return terrain;
}

export async function loadPrinceArchGround({ fetchImpl = globalThis.fetch, signal } = {}) {
  const response = await fetchImpl(PRINCE_ARCH_GROUND_URL, { signal });
  if (!response.ok) throw new Error(`Prince arch ground could not load (${response.status})`);
  const binary = await response.arrayBuffer();
  validatePrinceArchGround(binary);
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', binary),
      hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (hash !== spec.sha256) throw new Error('Prince arch ground SHA-256 mismatch');
  }
  return binary;
}
