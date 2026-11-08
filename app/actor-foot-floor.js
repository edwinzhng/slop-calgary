import { inPolygon } from './geo.js';

// Animation probes may reach either side of the standing body. A collider top
// is useful only near that body height; a roof above a street walker is not a
// new floor. This matches the navigation step limit without changing physics.
export const ACTOR_FOOT_FLOOR_LIMITS = Object.freeze({ heightBand: 0.48, queryRadius: 2 });

/** Ground/tread probes plus real nearby solid tops for an already grounded actor. */
export function createActorFootFloor(world, state) {
  const elevation = state.y,
    tops =
      state.grounded === true && Number.isFinite(elevation)
        ? world.buildingIndex?.near(state.x, state.z, ACTOR_FOOT_FLOOR_LIMITS.queryRadius)
        : null;
  return (x, z) => {
    let floor = world.groundHeight(x, z, elevation);
    for (const solid of tops || []) {
      if (!solid.ring?.length || !inPolygon(x, z, solid)) continue;
      const top = solid.heightAt?.(x, z) ?? solid.height;
      if (
        !Number.isFinite(top) ||
        Math.abs(top - elevation) > ACTOR_FOOT_FLOOR_LIMITS.heightBand ||
        top <= (solid.minHeightAt?.(x, z) ?? solid.minHeight ?? -Infinity)
      )
        continue;
      if (!Number.isFinite(floor) || top > floor) floor = top;
    }
    return floor;
  };
}
