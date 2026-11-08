import { bounds, DRIVABLE, roadWidth, SpatialIndex } from './geo.js';

// Measured low faces can supersede a ground-filled footprint at an actual
// road crossing. Keep this query local to the mapped street and skywalk.
export function createPlus15Clearance(skywalks, roadIndex) {
  const windows = new SpatialIndex(40);
  for (const skywalk of skywalks) {
    for (let i = 1; i < skywalk.points.length; i++) {
      const [ax, az] = skywalk.points[i - 1];
      const sx = skywalk.points[i][0] - ax,
        sz = skywalk.points[i][1] - az;
      for (const { a, b, road } of roadIndex.index.near(ax + sx / 2, az + sz / 2, Math.hypot(sx, sz) / 2)) {
        if (!DRIVABLE.has(road.kind) || road.bridge || road.tunnel || road.transitOnly) continue;
        const rx = b[0] - a[0],
          rz = b[1] - a[1],
          determinant = sx * rz - sz * rx;
        if (Math.abs(determinant) < 0.001) continue;
        const dx = a[0] - ax,
          dz = a[1] - az;
        const skyT = (dx * rz - dz * rx) / determinant,
          roadT = (dx * sz - dz * sx) / determinant;
        if (skyT < 0 || skyT > 1 || roadT < 0 || roadT > 1) continue;
        const x = ax + skyT * sx,
          z = az + skyT * sz;
        const length = Math.hypot(rx, rz),
          ux = rx / length,
          uz = rz / length;
        const width = roadWidth(road) / 2 + 0.35,
          along = 24;
        const extentX = Math.abs(ux) * along + Math.abs(uz) * width;
        const extentZ = Math.abs(uz) * along + Math.abs(ux) * width;
        const box = { minX: x - extentX, maxX: x + extentX, minZ: z - extentZ, maxZ: z + extentZ };
        windows.insert({ x, z, ux, uz, width, along, box }, box);
      }
    }
  }
  return (collider, cityMeshes, offset = 0) => {
    if (!cityMeshes?.collisionBottomAt) return collider;
    const { minX, maxX, minZ, maxZ } = bounds(collider.ring);
    const crossings = [
      ...windows.near((minX + maxX) / 2, (minZ + maxZ) / 2, Math.max(maxX - minX, maxZ - minZ) / 2),
    ].filter(({ box }) => minX <= box.maxX && maxX >= box.minX && minZ <= box.maxZ && maxZ >= box.minZ);
    if (!crossings.length) return collider;
    const onCrossing = (x, z) =>
      crossings.some((crossing) => {
        const dx = x - crossing.x,
          dz = z - crossing.z;
        return (
          Math.abs(dx * crossing.ux + dz * crossing.uz) <= crossing.along &&
          Math.abs(dz * crossing.ux - dx * crossing.uz) <= crossing.width
        );
      });
    return {
      ...collider,
      minHeightAt(x, z, body) {
        if (onCrossing(x, z)) {
          const underside = cityMeshes.collisionBottomAt(collider.id, x, z, body);
          if (underside != null) return underside + offset;
        }
        return collider.minHeightAt?.(x, z, body) ?? collider.minHeight;
      },
    };
  };
}
