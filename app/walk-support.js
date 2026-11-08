import { bounds, inPolygon, SpatialIndex } from './geo.js';

export const WALK_SUPPORT_LIMITS = Object.freeze({ stepUp: 0.48, samples: 8, footprintMargin: 0.003 });
const STEP_TYPES = new Set([
  'development-stair',
  'development-landing',
  'landmark-step',
  'bridge-stair-deck',
  'bridge-stair-landing',
  'bridge-deck',
  'bridge-bank-access',
  'park-step',
]);
const DIRECTIONS = Array.from({ length: WALK_SUPPORT_LIMITS.samples }, (_, i) => {
  const angle = (i * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
});

/** Footprint support for explicitly supplied walkable slabs, without raising ordinary terrain or roofs. */
export function createWalkingSupport({ groundHeight, stepColliders = [], transit = () => null }) {
  const index = new SpatialIndex(24);
  for (const collider of stepColliders) {
    if (!STEP_TYPES.has(collider.type) || !collider.ring?.length) continue;
    const box = bounds(collider.ring);
    index.insert({ collider, box }, box);
  }
  return (x, z, elevationHint, radius = 0.42) => {
    const base = groundHeight(x, z, elevationHint),
      hint = Number.isFinite(elevationHint) ? elevationHint : base,
      limit = hint + WALK_SUPPORT_LIMITS.stepUp,
      // An inscribed eight-point probe misses a circle's leading edge between
      // vertices. Circumscribe the real body and include a 3mm seam tolerance.
      probeRadius =
        Math.max(0, Number.isFinite(radius) ? radius : 0.42) / Math.cos(Math.PI / 8) +
        WALK_SUPPORT_LIMITS.footprintMargin,
      candidates = [...index.near(x, z, probeRadius)].filter(({ box }) => {
        const dx = Math.max(box.minX - x, 0, x - box.maxX),
          dz = Math.max(box.minZ - z, 0, z - box.maxZ);
        return dx * dx + dz * dz <= probeRadius * probeRadius;
      }),
      currentTransit = typeof transit === 'function' ? transit() : transit,
      nearbyTransit = !!currentTransit?.hasGroundSupportNear?.(x, z, probeRadius);
    if (!candidates.length && !nearbyTransit) return base;
    let support = base;
    const accept = (height) => {
      if (
        Number.isFinite(height) &&
        height <= limit + 1e-7 &&
        (!Number.isFinite(support) || height > support)
      )
        support = height;
    };
    for (const [dx, dz] of DIRECTIONS) {
      const px = x + dx * probeRadius,
        pz = z + dz * probeRadius;
      for (const { collider } of candidates) {
        if (!inPolygon(px, pz, collider)) continue;
        accept(collider.heightAt?.(px, pz) ?? collider.height);
      }
      if (nearbyTransit) accept(currentTransit.groundHeight(px, pz, hint));
    }
    return support;
  };
}
