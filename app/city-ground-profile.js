// Exact intersections with emitted native terrain faces, not a resampled or
// smoothed height curve. Owns bounded CPU buffers; never changes source meshes.
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  multiply = (a, b) => {
    const out = [0, 0, 0, 0];
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length && i + j < 4; j++) out[i + j] += a[i] * b[j];
    return out;
  },
  at = (c, t) => ((c[3] * t + c[2]) * t + c[1]) * t + c[0];
function range(c) {
  const values = [at(c, 0), at(c, 1)],
    a = 3 * c[3],
    b = 2 * c[2],
    d = c[1],
    roots = [];
  if (Math.abs(a) < 1e-20) {
    if (Math.abs(b) > 1e-20) roots.push(-d / b);
  } else {
    const determinant = b * b - 4 * a * d;
    if (determinant >= 0) {
      const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(determinant));
      if (q) {
        roots.push(q / a, d / q);
      } else roots.push(-b / (2 * a));
    }
  }
  for (const t of roots) if (t > 0 && t < 1) values.push(at(c, t));
  return [Math.min(...values), Math.max(...values)];
}
function nativeRange(ground, a, b) {
  const transform = ground.manifest.worldToSource,
    scale = transform.normalizationM,
    u = [(a[0] - transform.inputOrigin[0]) / scale, (b[0] - a[0]) / scale],
    v = [(a[1] - transform.inputOrigin[1]) / scale, (b[1] - a[1]) / scale],
    uu = multiply(u, u),
    vv = multiply(v, v),
    basis = [
      [1],
      u,
      v,
      uu,
      multiply(u, v),
      vv,
      multiply(uu, u),
      multiply(uu, v),
      multiply(u, vv),
      multiply(vv, v),
    ],
    result = transform.coefficients.map((coefficients, axis) => {
      const curve = [transform.outputOrigin[axis], 0, 0, 0];
      for (let i = 0; i < 10; i++)
        for (let k = 0; k < basis[i].length; k++) curve[k] += coefficients[i] * basis[i][k];
      return range(curve);
    }),
    g = ground.manifest.grid;
  return [
    (result[0][0] - g.eastingAtColumn0) / g.stepM,
    (g.northingAtRow0 - result[1][1]) / g.stepM,
    (result[0][1] - g.eastingAtColumn0) / g.stepM,
    (g.northingAtRow0 - result[1][0]) / g.stepM,
  ];
}
export function createCityGroundProfile(
  ground,
  {
    tileCells = 8,
    maxTiles = 128,
    maxCachedBytes = 8000000,
    maxCachedTriangles = 131072,
    maxFaceTests = 1000000,
    maxPieces = 65536,
    maxTilesPerLine = 1024,
  } = {},
) {
  if (
    !ground?.manifest?.worldToSource ||
    typeof ground.contains !== 'function' ||
    typeof ground.createPatchGeometry !== 'function' ||
    ![
      tileCells,
      maxTiles,
      maxCachedBytes,
      maxCachedTriangles,
      maxFaceTests,
      maxPieces,
      maxTilesPerLine,
    ].every((n) => Number.isSafeInteger(n) && n > 0) ||
    tileCells > 32
  )
    throw new Error('Invalid native terrain profile source or budget');
  const cache = new Map(),
    g = ground.manifest.grid,
    stats = {
      profiles: 0,
      faceTests: 0,
      tileBuilds: 0,
      evictions: 0,
      cachedBytes: 0,
      cachedTriangles: 0,
      maximumBytes: 0,
      maximumTriangles: 0,
      maximumTiles: 0,
      unsupportedLengthM: 0,
    };
  let disposed = false;
  const remove = (key) => {
      const value = cache.get(key);
      if (value) {
        stats.cachedBytes -= value.bytes;
        stats.cachedTriangles -= value.triangles;
        cache.delete(key);
      }
    },
    tile = (column, row) => {
      const key = column + ',' + row,
        old = cache.get(key);
      if (old) {
        cache.delete(key);
        cache.set(key, old);
        return old;
      }
      const geometry = ground.createPatchGeometry({
        column,
        row,
        cellsX: Math.min(tileCells, g.width - 1 - column),
        cellsY: Math.min(tileCells, g.height - 1 - row),
      });
      const p = geometry.attributes.position.array,
        index = geometry.index.array;
      geometry.dispose();
      const result = {
        p,
        index,
        column,
        row,
        triangles: index.length / 3,
        bytes: p.byteLength + index.byteLength,
      };
      stats.tileBuilds++;
      if (result.bytes <= maxCachedBytes && result.triangles <= maxCachedTriangles) {
        while (
          cache.size &&
          (cache.size >= maxTiles ||
            stats.cachedBytes + result.bytes > maxCachedBytes ||
            stats.cachedTriangles + result.triangles > maxCachedTriangles)
        ) {
          remove(cache.keys().next().value);
          stats.evictions++;
        }
        cache.set(key, result);
        stats.cachedBytes += result.bytes;
        stats.cachedTriangles += result.triangles;
        stats.maximumBytes = Math.max(stats.maximumBytes, stats.cachedBytes);
        stats.maximumTriangles = Math.max(stats.maximumTriangles, stats.cachedTriangles);
        stats.maximumTiles = Math.max(stats.maximumTiles, cache.size);
      }
      return result;
    };
  return {
    stats,
    profile(a, b) {
      if (disposed) throw new Error('Native terrain profile is disposed');
      if (![a, b].every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
        throw new Error('Invalid native terrain profile segment');
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      if (length < 1e-6) throw new Error('Native terrain profile needs a nonzero segment');
      const r = nativeRange(ground, a, b),
        c0 = Math.max(0, Math.floor(r[0]) - 1),
        r0 = Math.max(0, Math.floor(r[1]) - 1),
        c1 = Math.min(g.width - 2, Math.floor(r[2]) + 1),
        r1 = Math.min(g.height - 2, Math.floor(r[3]) + 1),
        columns = c1 >= c0 ? Math.floor(c1 / tileCells) - Math.floor(c0 / tileCells) + 1 : 0,
        rows = r1 >= r0 ? Math.floor(r1 / tileCells) - Math.floor(r0 / tileCells) + 1 : 0,
        intervals = [],
        pieces = [],
        gaps = [],
        worldEpsilon = 1e-6,
        tolerance = worldEpsilon / length;
      if (columns * rows > maxTilesPerLine) throw new Error('Native terrain profile exceeds tile budget');
      let tests = 0;
      for (let row = Math.floor(r0 / tileCells) * tileCells; rows && row <= r1; row += tileCells)
        for (let col = Math.floor(c0 / tileCells) * tileCells; columns && col <= c1; col += tileCells) {
          const data = tile(col, row),
            p = data.p,
            index = data.index;
          for (let i = 0; i < index.length; i += 3) {
            if (++tests > maxFaceTests) throw new Error('Native terrain profile exceeds face-test budget');
            const ai = index[i] * 3,
              bi = index[i + 1] * 3,
              ci = index[i + 2] * 3,
              ax = p[ai],
              az = p[ai + 2],
              bx = p[bi],
              bz = p[bi + 2],
              cx = p[ci],
              cz = p[ci + 2];
            if (
              Math.max(ax, bx, cx) < Math.min(a[0], b[0]) ||
              Math.min(ax, bx, cx) > Math.max(a[0], b[0]) ||
              Math.max(az, bz, cz) < Math.min(a[1], b[1]) ||
              Math.min(az, bz, cz) > Math.max(a[1], b[1])
            )
              continue;
            const points = [
              [ax, az, p[ai + 1]],
              [bx, bz, p[bi + 1]],
              [cx, cz, p[ci + 1]],
            ];
            const denominator = cross(...points);
            if (Math.abs(denominator) < 1e-12) continue;
            const sign = Math.sign(denominator);
            let lo = 0,
              hi = 1;
            for (let k = 0; k < 3 && hi >= lo; k++) {
              const u = points[k],
                v = points[(k + 1) % 3],
                start = sign * cross(u, v, a),
                delta = sign * ((v[0] - u[0]) * dz - (v[1] - u[1]) * dx);
              if (delta === 0) {
                if (start < 0) {
                  hi = -1;
                  break;
                }
              } else if (delta > 0) lo = Math.max(lo, -start / delta);
              else hi = Math.min(hi, -start / delta);
            }
            if (hi - lo <= 1e-12) continue;
            const height = (t) => {
              const point = [a[0] + dx * t, a[1] + dz * t],
                u = cross(point, points[1], points[2]) / denominator,
                v = cross(points[0], point, points[2]) / denominator;
              return points[0][2] * u + points[1][2] * v + points[2][2] * (1 - u - v);
            };
            const y0 = height(lo),
              y1 = height(hi);
            if (!Number.isFinite(y0) || !Number.isFinite(y1))
              throw new Error('Invalid native terrain profile height');
            intervals.push({ lo, hi, y0, y1, column: col, row, face: i / 3 });
            if (intervals.length > maxPieces * 2)
              throw new Error('Native terrain profile exceeds candidate budget');
          }
        }
      intervals.sort(
        (a, b) => a.lo - b.lo || a.hi - b.hi || a.row - b.row || a.column - b.column || a.face - b.face,
      );
      let cursor = 0;
      for (const part of intervals) {
        if (part.hi <= cursor + 1e-12) continue;
        if (part.lo > cursor + tolerance) gaps.push([cursor, part.lo]);
        const lo = Math.max(cursor, part.lo > cursor + tolerance ? part.lo : cursor),
          fraction = (lo - part.lo) / (part.hi - part.lo),
          y0 = part.y0 + (part.y1 - part.y0) * fraction;
        pieces.push({ ...part, lo, y0 });
        cursor = part.hi;
        if (pieces.length > maxPieces) throw new Error('Native terrain profile exceeds output budget');
      }
      if (cursor < 1 - tolerance) gaps.push([cursor, 1]);
      if (!intervals.length && gaps.length === 0) gaps.push([0, 1]);
      const unsupportedLengthM = gaps.reduce((n, [a, b]) => n + (b - a) * length, 0);
      stats.profiles++;
      stats.faceTests += tests;
      stats.unsupportedLengthM += unsupportedLengthM;
      return {
        a: a.slice(),
        b: b.slice(),
        lengthM: length,
        pieces,
        gaps,
        gapSourceStates: gaps.map(([lo, hi]) => {
          const t = (lo + hi) / 2,
            midpoint = [a[0] + dx * t, a[1] + dz * t],
            bounds = ground.manifest.meta?.worldBounds;
          let insideLo = lo,
            insideHi = hi;
          if (bounds)
            for (const [origin, delta, low, high] of [
              [a[0], dx, bounds[0], bounds[2]],
              [a[1], dz, bounds[1], bounds[3]],
            ]) {
              if (!delta) {
                if (origin < low || origin > high) insideHi = insideLo;
              } else {
                const p = (low - origin) / delta,
                  q = (high - origin) / delta;
                insideLo = Math.max(insideLo, Math.min(p, q));
                insideHi = Math.min(insideHi, Math.max(p, q));
              }
            }
          return {
            lo,
            hi,
            midpoint,
            withinSimulationBoundsLengthM: bounds ? Math.max(0, insideHi - insideLo) * length : null,
            sourceKnownAtMidpoint: ground.contains(...midpoint),
            withinSimulationBounds: bounds
              ? midpoint[0] >= bounds[0] &&
                midpoint[0] <= bounds[2] &&
                midpoint[1] >= bounds[1] &&
                midpoint[1] <= bounds[3]
              : null,
          };
        }),
        unsupportedLengthM,
        supported: gaps.length === 0,
        sourceGridSha256: ground.manifest.sha256,
        sourceInterpolationBoundM: ground.meshErrorM,
      };
    },
    clear() {
      cache.clear();
      stats.cachedBytes = stats.cachedTriangles = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cache.clear();
      stats.cachedBytes = stats.cachedTriangles = 0;
    },
  };
}
