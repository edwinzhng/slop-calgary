import { SpatialIndex } from './geo.js';

/** Measured trunk radii, with the same inferred height and base as vegetation. */
export function createTreeCollision(records) {
  const index = new SpatialIndex(40);
  for (const tree of records) {
    const radius = tree.profile.radius;
    index.insert(tree, { minX: tree.x - radius, maxX: tree.x + radius, minZ: tree.z - radius, maxZ: tree.z + radius });
  }
  function contact(position, body, out = {}) {
    let deepest = 0,
      nx = 0,
      nz = 0;
    for (const tree of index.near(position.x, position.z, (body.radius ?? 2.5) + 1)) {
      const bottom = tree.baseY ?? 0.12,
        top = bottom + tree.profile.height,
        r = tree.profile.radius;
      if (position.y >= top || position.y + (body.top ?? 1.9) <= bottom) continue;
      const dx = position.x - tree.x,
        dz = position.z - tree.z;
      let depth, tx, tz;
      if (body.car) {
        const x = -dx * body.cos + dz * body.sin,
          z = -dx * body.sin - dz * body.cos;
        const cx = Math.max(-body.hx, Math.min(body.hx, x)),
          cz = Math.max(-body.hz, Math.min(body.hz, z));
        const ux = cx - x,
          uz = cz - z,
          d = Math.hypot(ux, uz);
        if (d >= r) continue;
        if (d > 1e-8) {
          tx = ux / d;
          tz = uz / d;
          depth = r - d;
        } else if (body.hx - Math.abs(x) < body.hz - Math.abs(z)) {
          tx = x >= 0 ? -1 : 1;
          tz = 0;
          depth = r + body.hx - Math.abs(x);
        } else {
          tx = 0;
          tz = z >= 0 ? -1 : 1;
          depth = r + body.hz - Math.abs(z);
        }
        const wx = tx * body.cos + tz * body.sin;
        tz = -tx * body.sin + tz * body.cos;
        tx = wx;
      } else {
        const distance = Math.hypot(dx, dz),
          radius = (body.radius ?? 0.42) + r;
        if (distance >= radius) continue;
        depth = radius - distance;
        tx = distance > 1e-8 ? dx / distance : 1;
        tz = distance > 1e-8 ? dz / distance : 0;
      }
      if (depth > deepest) {
        deepest = depth;
        nx = tx;
        nz = tz;
      }
    }
    if (!deepest) return false;
    out.nx = nx;
    out.nz = nz;
    out.depth = deepest;
    return true;
  }
  const scratch = {};
  return {
    index,
    count: records.length,
    contact,
    blocked: (position, body) => contact(position, body, scratch),
    resolve(position, body) {
      let hit = false;
      for (let i = 0; i < 4; i++) {
        if (!contact(position, body, scratch)) break;
        position.x += scratch.nx * (scratch.depth + 0.002);
        position.z += scratch.nz * (scratch.depth + 0.002);
        hit = true;
      }
      return hit;
    },
  };
}
