import { createMeshHeightSampler } from './mesh-height-envelope.js';
const mix = (a, b, t) => a + (b - a) * t;
/** A narrow inferred closure below an already eligible measured wall rim. The
 * source top stays rigid. Only its lower edge follows actual native faces.
 */
export function nativeFoundationSpan({
  a,
  b,
  top0,
  top1,
  nx,
  nz,
  profile,
  sourceBuildingId,
  startId = 0,
  thickness = 0.12,
  bottomOffsetM = -0.06,
  maxExtensionM = 4,
  maxTriangles = 65536,
}) {
  if (
    ![top0, top1, nx, nz, thickness, bottomOffsetM, maxExtensionM].every(Number.isFinite) ||
    thickness <= 0 ||
    thickness > 0.3 ||
    bottomOffsetM < -0.1 ||
    bottomOffsetM > 0 ||
    maxExtensionM <= 0 ||
    maxExtensionM > 4 ||
    !Number.isSafeInteger(maxTriangles) ||
    maxTriangles <= 0
  )
    throw new Error('Invalid native foundation bounds');
  const line = profile.profile(a, b),
    positions = [],
    colliders = [],
    segments = [],
    length = line.lengthM,
    stats = {
      profilePieces: line.pieces.length,
      unsupportedLengthM: line.unsupportedLengthM,
      terrainCoveredLengthM: 0,
      overLimitLengthM: 0,
      collapsedLengthM: 0,
      emittedLengthM: 0,
      maximumExtensionM: 0,
      maximumObservedGapM: -Infinity,
      minimumObservedGapM: Infinity,
    };
  for (const p of line.pieces) {
    const gap0 = mix(top0, top1, p.lo) - p.y0 - bottomOffsetM,
      gap1 = mix(top0, top1, p.hi) - p.y1 - bottomOffsetM,
      cuts = [0, 1];
    stats.maximumObservedGapM = Math.max(stats.maximumObservedGapM, gap0, gap1);
    stats.minimumObservedGapM = Math.min(stats.minimumObservedGapM, gap0, gap1);
    if (gap0 !== gap1)
      for (const target of [0, maxExtensionM]) {
        const t = (target - gap0) / (gap1 - gap0);
        if (t > 0 && t < 1) cuts.push(t);
      }
    cuts.sort((a, b) => a - b);
    for (let k = 1; k < cuts.length; k++) {
      const lo = cuts[k - 1],
        hi = cuts[k],
        t0 = mix(p.lo, p.hi, lo),
        t1 = mix(p.lo, p.hi, hi),
        spanLength = (t1 - t0) * length,
        gap = mix(gap0, gap1, (lo + hi) / 2);
      if (gap <= 0) {
        stats.terrainCoveredLengthM += spanLength;
        continue;
      }
      if (gap > maxExtensionM) {
        stats.overLimitLengthM += spanLength;
        continue;
      }
      const x0 = Math.fround(mix(a[0], b[0], t0)),
        z0 = Math.fround(mix(a[1], b[1], t0)),
        x1 = Math.fround(mix(a[0], b[0], t1)),
        z1 = Math.fround(mix(a[1], b[1], t1)),
        low0 = Math.fround(mix(p.y0, p.y1, lo) + bottomOffsetM),
        low1 = Math.fround(mix(p.y0, p.y1, hi) + bottomOffsetM),
        high0 = Math.max(low0, Math.fround(mix(top0, top1, t0))),
        high1 = Math.max(low1, Math.fround(mix(top0, top1, t1))),
        quad = [
          [x0, low0, z0],
          [x1, low1, z1],
          [x1, high1, z1],
          [x0, high0, z0],
        ];
      if (Math.hypot(x1 - x0, z1 - z0) < 1e-6 || Math.max(high0 - low0, high1 - low1) <= 0) {
        stats.collapsedLengthM += spanLength;
        continue;
      }
      let faces = [
        [0, 1, 2],
        [0, 2, 3],
      ];
      if ((z1 - z0) * nx - (x1 - x0) * nz > 0) faces = faces.map(([a, b, c]) => [a, c, b]);
      for (const face of faces) {
        const q = face.map((i) => quad[i]),
          verticalExtent = Math.max(...q.map((p) => p[1])) - Math.min(...q.map((p) => p[1]));
        if (!verticalExtent) continue;
        // A crossing can reduce one side to a single point. Skip only its
        // genuinely collapsed triangle; retain the other half of the wedge.
        const area2 =
          Math.hypot(x1 - x0, z1 - z0) * (face.includes(1) && face.includes(2) ? high1 - low1 : high0 - low0);
        if (area2 <= 1e-12) continue;
        if (positions.length / 9 >= maxTriangles)
          throw new Error('Native foundations exceed triangle budget');
        positions.push(...q.flat());
      }
      const ring = [
          [x0, z0],
          [x1, z1],
          [Math.fround(x1 - nx * thickness), Math.fround(z1 - nz * thickness)],
          [Math.fround(x0 - nx * thickness), Math.fround(z0 - nz * thickness)],
        ],
        plane = (y0, y1) => {
          const q = ring.map(([x, z], i) => [x, i === 0 || i === 3 ? y0 : y1, z]);
          return [
            [q[0], q[1], q[2]],
            [q[0], q[2], q[3]],
          ];
        },
        nativeFoundation = {
          sourceGridSha256: line.sourceGridSha256,
          bottomOffsetM,
          sourceBuildingId,
          inferred: true,
        };
      colliders.push({
        id: `inferred-foundation:${sourceBuildingId}:${startId + colliders.length}`,
        sourceBuildingId,
        kind: 'inferredFoundation',
        ring,
        minHeight: Math.min(low0, low1),
        height: Math.max(high0, high1),
        heightAt: createMeshHeightSampler(plane(high0, high1)),
        minHeightAt: createMeshHeightSampler(plane(low0, low1), { minimum: true }),
        nativeFoundation,
        inferred: true,
      });
      segments.push({
        a: [x0, z0],
        b: [x1, z1],
        bottom: [low0, low1],
        top: [high0, high1],
        sourceBuildingId,
        sourceGridSha256: line.sourceGridSha256,
      });
      stats.emittedLengthM += spanLength;
      stats.maximumExtensionM = Math.max(stats.maximumExtensionM, high0 - low0, high1 - low1);
    }
  }
  if (stats.minimumObservedGapM === Infinity) stats.minimumObservedGapM = null;
  if (stats.maximumObservedGapM === -Infinity) stats.maximumObservedGapM = null;
  return { positions, colliders, segments, stats };
}
