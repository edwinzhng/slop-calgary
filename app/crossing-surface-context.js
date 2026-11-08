/** Shared by world creation and the offline crossing bake. The mapped access
 * fields already include their lower terrain attachment; do not lift twice. */
export function applyInfrastructureTerrain(surfaces, terrain) {
  if (!terrain) return surfaces;
  if (surfaces.attachGroundTerrain) {
    surfaces.attachGroundTerrain(terrain);
    return surfaces;
  }
  const surfaceHeight = surfaces.surfaceHeight.bind(surfaces),
    bridgeGroundHeight = surfaces.groundHeight.bind(surfaces),
    offsetAt = (x, z) => terrain.offsetAt(x, z) || 0;
  surfaces.surfaceHeight = (x, z, road) => {
    const y = surfaceHeight(x, z, road),
      offset = y < 0.6 ? offsetAt(x, z) : 0;
    if (!offset) return y;
    const access = surfaces.accessBranches?.surfaceHeight(x, z, road);
    return y + (access == null || Math.abs(access - y) > 1e-6 ? offset : 0);
  };
  surfaces.groundHeight = (x, z, hint) => {
    const y = bridgeGroundHeight(x, z, hint);
    if (y == null) return null;
    const offset = y < 0.6 ? offsetAt(x, z) : 0;
    if (!offset) return y;
    const access = surfaces.accessBranches?.groundHeight(x, z, hint);
    return y + (access == null || Math.abs(access - y) > 1e-6 ? offset : 0);
  };
  return surfaces;
}
