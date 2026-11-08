import * as THREE from 'three/webgpu';

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const raw = (attribute, index, component) => attribute.array[index * attribute.itemSize + component];
const neighbours = [0, 0, -1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];

/** Canonical native terrain faces shared by paving and physical support. This
 * adapter is deliberately separate from scientific bilinear source queries.
 * It is not enabled by main: water, structures, traffic and terrain LOD still
 * need their coordinated scene bindings. */
export function createCitySurfaceTerrain(
  ground,
  {
    tileCells = 16,
    maxCachedTiles = 32,
    maxCachedTileTriangles = 131072,
    maxCachedCells = 1024,
    maxCachedCellTriangles = 16384,
    maxOutputVertices = 6000000,
    maxFaceTests = 12000000,
  } = {},
) {
  if (
    !ground?.manifest?.grid ||
    typeof ground.createPatchGeometry !== 'function' ||
    typeof ground.sourceCoordinates !== 'function' ||
    typeof ground.contains !== 'function'
  )
    throw new Error('Canonical surfaces require the validated native ground provider');
  if (
    ![
      tileCells,
      maxCachedTiles,
      maxCachedTileTriangles,
      maxCachedCells,
      maxCachedCellTriangles,
      maxOutputVertices,
      maxFaceTests,
    ].every((n) => Number.isSafeInteger(n) && n > 0) ||
    tileCells > 32
  )
    throw new Error('Invalid canonical surface budgets');
  const grid = ground.manifest.grid,
    tiles = new Map(),
    cells = new Map(),
    scratch = [0, 0],
    stats = {
      drapedGeometries: 0,
      inputTriangles: 0,
      outputTriangles: 0,
      faceTests: 0,
      tileBuilds: 0,
      cellBuilds: 0,
      tileEvictions: 0,
      cellEvictions: 0,
      cachedTileTriangles: 0,
      cachedCellTriangles: 0,
      maximumSourceInterpolationErrorM: ground.meshErrorM,
      supportQueries: 0,
      unsupportedQueries: 0,
      sourceGridSha256: ground.manifest.sha256,
    };
  function native(x, z, out) {
    ground.sourceCoordinates(x, z, out);
    out[0] = (out[0] - grid.eastingAtColumn0) / grid.stepM;
    out[1] = (grid.northingAtRow0 - out[1]) / grid.stepM;
    return out;
  }
  function buffers(column, row, cellsX, cellsY) {
    const geometry = ground.createPatchGeometry({ column, row, cellsX, cellsY });
    const p = geometry.attributes.position.array,
      index = geometry.index.array;
    geometry.dispose();
    return { p, index, triangles: index.length / 3 };
  }
  function cachePut(cache, key, value, maxEntries, maxTriangles, counter, evictionCounter) {
    if (value.triangles > maxTriangles) return value;
    while (cache.size && (cache.size >= maxEntries || stats[counter] + value.triangles > maxTriangles)) {
      const oldest = cache.keys().next().value;
      stats[counter] -= cache.get(oldest).triangles;
      cache.delete(oldest);
      stats[evictionCounter]++;
    }
    cache.set(key, value);
    stats[counter] += value.triangles;
    return value;
  }
  const touch = (cache, key) => {
    const value = cache.get(key);
    if (value) {
      cache.delete(key);
      cache.set(key, value);
    }
    return value;
  };
  function cell(column, row) {
    if (column < 0 || row < 0 || column >= grid.width - 1 || row >= grid.height - 1) return null;
    const key = row * grid.width + column,
      found = touch(cells, key);
    if (found) return found;
    const value = buffers(column, row, 1, 1);
    stats.cellBuilds++;
    return cachePut(
      cells,
      key,
      value,
      maxCachedCells,
      maxCachedCellTriangles,
      'cachedCellTriangles',
      'cellEvictions',
    );
  }
  function tile(column, row) {
    const c0 = Math.floor(column / tileCells) * tileCells,
      r0 = Math.floor(row / tileCells) * tileCells,
      key = r0 * grid.width + c0,
      found = touch(tiles, key);
    if (found) return found;
    const width = Math.min(tileCells, grid.width - 1 - c0),
      height = Math.min(tileCells, grid.height - 1 - r0),
      value = buffers(c0, r0, width, height),
      counts = new Uint32Array(width * height + 1),
      owners = new Uint32Array(value.triangles),
      order = new Uint32Array(value.triangles);
    for (let t = 0; t < value.triangles; t++) {
      let x = 0,
        z = 0;
      for (let k = 0; k < 3; k++) {
        const i = value.index[t * 3 + k] * 3;
        x += value.p[i];
        z += value.p[i + 2];
      }
      native(x / 3, z / 3, scratch);
      const c = Math.max(0, Math.min(width - 1, Math.floor(scratch[0]) - c0)),
        r = Math.max(0, Math.min(height - 1, Math.floor(scratch[1]) - r0));
      owners[t] = r * width + c;
      counts[owners[t] + 1]++;
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const cursors = counts.slice();
    for (let i = 0; i < owners.length; i++) order[cursors[owners[i]]++] = i;
    Object.assign(value, { column: c0, row: r0, width, counts, order });
    stats.tileBuilds++;
    return cachePut(
      tiles,
      key,
      value,
      maxCachedTiles,
      maxCachedTileTriangles,
      'cachedTileTriangles',
      'tileEvictions',
    );
  }
  function face(value, t) {
    return [0, 1, 2].map((k) => {
      const i = value.index[t * 3 + k] * 3;
      return [value.p[i], value.p[i + 2], value.p[i + 1]];
    });
  }
  function heightAt(triangle, x, z) {
    const [a, b, c] = triangle,
      denominator = cross(a, b, c);
    if (Math.abs(denominator) < 1e-12) return null;
    const q = [x, z],
      u = cross(q, b, c) / denominator,
      v = cross(a, q, c) / denominator,
      w = 1 - u - v;
    if (Math.min(u, v, w) < -1e-9) return null;
    return a[2] * u + b[2] * v + c[2] * w;
  }
  function offsetAt(x, z) {
    stats.supportQueries++;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !ground.contains(x, z)) {
      stats.unsupportedQueries++;
      return null;
    }
    native(x, z, scratch);
    const column = Math.min(grid.width - 2, Math.floor(scratch[0])),
      row = Math.min(grid.height - 2, Math.floor(scratch[1]));
    // Float32 placement can put a native-grid boundary on the neighbouring
    // source cell by a fraction of a millimetre. Try neighbours only on a miss.
    for (let neighbour = 0; neighbour < neighbours.length; neighbour += 2) {
      const value = cell(column + neighbours[neighbour], row + neighbours[neighbour + 1]);
      if (!value) continue;
      for (let t = 0; t < value.triangles; t++) {
        const ai = value.index[t * 3] * 3,
          bi = value.index[t * 3 + 1] * 3,
          ci = value.index[t * 3 + 2] * 3,
          p = value.p,
          ax = p[ai],
          az = p[ai + 2],
          bx = p[bi],
          bz = p[bi + 2],
          cx = p[ci],
          cz = p[ci + 2],
          denominator = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        if (Math.abs(denominator) < 1e-12) continue;
        const u = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / denominator,
          v = ((x - ax) * (cz - az) - (z - az) * (cx - ax)) / denominator,
          w = 1 - u - v;
        if (Math.min(u, v, w) >= -1e-9) return p[ai + 1] * u + p[bi + 1] * v + p[ci + 1] * w;
      }
    }
    stats.unsupportedQueries++;
    return null;
  }
  function clip(polygon, a, b, sign) {
    const output = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const p = polygon[j],
        q = polygon[i],
        pa = sign * cross(a, b, p),
        qa = sign * cross(a, b, q),
        pin = pa >= 0,
        qin = qa >= 0;
      if (pin !== qin) {
        const t = pa / (pa - qa);
        output.push(p.map((value, k) => value + (q[k] - value) * t));
      }
      if (qin) output.push(q);
    }
    return output;
  }
  function drapeGeometry(geometry, options) {
    // Existing callers also pass a numeric subdivision hint. Regional bounds
    // are explicit and apply only to planar paving, never split solid objects.
    const region = options && typeof options === 'object' ? options.bounds : null;
    if (
      region &&
      (!Array.isArray(region) ||
        region.length !== 4 ||
        !region.every(Number.isFinite) ||
        region[0] >= region[2] ||
        region[1] >= region[3])
    )
      throw new Error('Invalid canonical surface region');
    const source = geometry.attributes.position,
      sourceIndex = geometry.index,
      count = sourceIndex?.count ?? source.count;
    if (count % 3 || source.itemSize !== 3 || source.isInterleavedBufferAttribute)
      throw new Error('Canonical draping requires ordinary complete triangle attributes');
    const attributes = Object.entries(geometry.attributes).filter(([name]) => name !== 'normal'),
      output = Object.fromEntries(attributes.map(([name]) => [name, []]));
    if (attributes.some(([, a]) => a.isInterleavedBufferAttribute || a.count !== source.count))
      throw new Error('Unsupported canonical surface attribute layout');
    let emitted = 0,
      tests = 0,
      sourceArea = 0,
      outputArea = 0,
      emittedArea = 0,
      maximumXZQuantizationM = 0,
      mapAreaRoundingBoundM2 = 0,
      sourceMapAreaM2 = 0,
      clippedMapAreaM2 = 0,
      reorientedSourceTriangles = 0,
      includedSourceTriangles = 0,
      unknownArea = false,
      collapsedClippedTriangles = 0,
      collapsedAreaM2 = 0;
    const core = ground.manifest.meta?.worldBounds,
      regionCorners = region && [
        [region[0], region[1]],
        [region[2], region[1]],
        [region[2], region[3]],
        [region[0], region[3]],
      ],
      coreCorners = core && [
        [core[0], core[1]],
        [core[2], core[1]],
        [core[2], core[3]],
        [core[0], core[3]],
      ],
      areaOf = (p) => {
        let area = 0;
        for (let i = 1; i < p.length - 1; i++) area += Math.abs(cross(p[0], p[i], p[i + 1])) / 2;
        return area;
      },
      coreArea = (polygon) => {
        for (let k = 0; k < 4 && polygon.length; k++)
          polygon = clip(polygon, coreCorners[k], coreCorners[(k + 1) % 4], 1);
        return areaOf(polygon);
      };
    for (let i = 0; i < count; i += 3) {
      const ids = [0, 1, 2].map((k) => (sourceIndex ? sourceIndex.getX(i + k) : i + k)),
        original = ids.map((id, k) => [source.getX(id), source.getZ(id), +(k === 0), +(k === 1), +(k === 2)]),
        area = cross(...original);
      if (!Number.isFinite(area) || original.flat().some((v) => !Number.isFinite(v)))
        throw new Error('Non-finite source surface');
      if (ids.some((id) => !Number.isFinite(source.getY(id)))) throw new Error('Non-finite source height');
      const vertical = Math.abs(area) < 1e-10;
      if (vertical) {
        const [a, b, c] = ids.map(
          (id) => new THREE.Vector3(source.getX(id), source.getY(id), source.getZ(id)),
        );
        if (b.sub(a).cross(c.sub(a)).lengthSq() < 1e-18) continue;
        if (region) throw new Error('Regional paving clips cannot split vertical object faces');
      }
      let subject = original;
      if (region)
        for (let k = 0; k < 4 && subject.length; k++)
          subject = clip(subject, regionCorners[k], regionCorners[(k + 1) % 4], 1);
      if (subject.length < 3) continue;
      includedSourceTriangles++;
      const projected = subject.map(([x, z]) => native(x, z, [0, 0]));
      sourceArea += areaOf(subject);
      const intendedY = geometry.attributes.normal?.getY(ids[0]) || 0,
        intendedSign = Math.abs(intendedY) > 0.9 ? -Math.sign(intendedY) : Math.sign(area),
        coreClass = !core
          ? 0
          : subject.every(([x, z]) => x >= core[0] && x <= core[2] && z >= core[1] && z <= core[3])
            ? 1
            : [0, 1].some(
                  (axis) =>
                    subject.every((p) => p[axis] < core[axis]) ||
                    subject.every((p) => p[axis] > core[axis + 2]),
                )
              ? -1
              : 0;
      if (!vertical && intendedSign !== Math.sign(area)) reorientedSourceTriangles++;
      if (core)
        sourceMapAreaM2 += coreClass === 1 ? areaOf(subject) : coreClass === -1 ? 0 : coreArea(subject);
      const r0 = Math.max(0, Math.floor(Math.min(...projected.map((p) => p[1]))) - 1),
        r1 = Math.min(grid.height - 2, Math.floor(Math.max(...projected.map((p) => p[1]))) + 1);
      if (subject.some(([x, z]) => !ground.contains(x, z))) unknownArea = true;
      for (let row = r0; row <= r1; row++) {
        // Strip clipping prunes long skinny source triangles. One-cell padding
        // covers the small CRS curvature; the final world-space clipping and
        // complete retained-area check remain authoritative.
        let strip = clip(projected, [0, row - 1], [1, row - 1], 1);
        if (strip.length) strip = clip(strip, [0, row + 2], [1, row + 2], -1);
        if (!strip.length) continue;
        const c0 = Math.max(0, Math.floor(Math.min(...strip.map((p) => p[0]))) - 1),
          c1 = Math.min(grid.width - 2, Math.floor(Math.max(...strip.map((p) => p[0]))) + 1);
        for (let column = c0; column <= c1; column++) {
          const value = tile(column, row),
            local = (row - value.row) * value.width + column - value.column;
          if (value.counts[local] === value.counts[local + 1]) {
            const q = [
              [column, row],
              [column + 1, row],
              [column + 1, row + 1],
              [column, row + 1],
            ].map(([c, r]) =>
              ground.worldCoordinates(
                grid.eastingAtColumn0 + c * grid.stepM,
                grid.northingAtRow0 - r * grid.stepM,
              ),
            );
            let missing = subject;
            for (let k = 0; k < 4 && missing.length; k++)
              missing = clip(missing, q[k], q[(k + 1) % 4], Math.sign(cross(q[0], q[1], q[2])));
            if (missing.slice(2).some((p, i) => Math.abs(cross(missing[0], missing[i + 1], p)) > 1e-10))
              unknownArea = true;
          }
          for (let f = value.counts[local]; f < value.counts[local + 1]; f++) {
            if (++tests > maxFaceTests)
              throw new Error('Canonical draping exceeds its face-test budget; split the source surface');
            const triangle = face(value, value.order[f]),
              sign = Math.sign(cross(...triangle));
            let polygon = subject;
            for (let k = 0; k < 3 && polygon.length; k++)
              polygon = clip(polygon, triangle[k], triangle[(k + 1) % 3], sign);
            if (polygon.length < 3) continue;
            for (let j = 1; j < polygon.length - 1; j++) {
              const points =
                  !vertical && intendedSign !== Math.sign(area)
                    ? [polygon[0], polygon[j + 1], polygon[j]]
                    : [polygon[0], polygon[j], polygon[j + 1]],
                flatArea = Math.abs(cross(...points)) / 2;
              if (!vertical && flatArea < 1e-12) continue;
              const rounded = points.map(([x, z]) => [Math.fround(x), Math.fround(z)]),
                quantization = Math.max(
                  ...points.map((p, i) => Math.hypot(p[0] - rounded[i][0], p[1] - rounded[i][1])),
                ),
                roundedArea = Math.abs(cross(...rounded)) / 2;
              maximumXZQuantizationM = Math.max(maximumXZQuantizationM, quantization);
              if (core) {
                clippedMapAreaM2 += coreClass === 1 ? flatArea : coreClass === -1 ? 0 : coreArea(points);
                // Hausdorff displacement <= q bounds the area difference of
                // each convex triangle, including its intersection with the
                // fixed map rectangle. Interior triangles use their measured
                // rounding delta; boundary triangles use the perimeter bound.
                const perimeter = points.reduce(
                  (n, p, i) => n + Math.hypot(p[0] - points[(i + 1) % 3][0], p[1] - points[(i + 1) % 3][1]),
                  0,
                );
                mapAreaRoundingBoundM2 +=
                  coreClass === 1
                    ? Math.abs(flatArea - roundedArea)
                    : 2 * perimeter * quantization + 13 * quantization * quantization;
              }
              if (!vertical && Math.sign(cross(...rounded)) !== intendedSign) {
                collapsedClippedTriangles++;
                collapsedAreaM2 += flatArea;
                // A collapsed/reversed Float32 triangle is omitted. Bound the
                // missing original area independently from ordinary rounding.
                mapAreaRoundingBoundM2 += flatArea;
                outputArea += flatArea;
                continue;
              }
              if (vertical) {
                // A vertical face exactly on a native edge belongs to one
                // canonical side. Closed clipping on both sides would duplicate
                // its entire wall and introduce coplanar flashing.
                let direction = [0, 0],
                  longest = 0;
                for (let k = 0; k < 3; k++) {
                  const a = points[k],
                    b = points[(k + 1) % 3],
                    dx = b[0] - a[0],
                    dz = b[1] - a[1],
                    length = Math.hypot(dx, dz);
                  if (length > longest) {
                    longest = length;
                    direction = [-dz / length, dx / length];
                  }
                }
                if (!longest) continue;
                if (direction[0] < 0 || (direction[0] === 0 && direction[1] < 0))
                  direction = direction.map((v) => -v);
                const x = points.reduce((n, p) => n + p[0], 0) / 3,
                  z = points.reduce((n, p) => n + p[1], 0) / 3;
                let sign = ground.contains(x + direction[0] * 1e-6, z + direction[1] * 1e-6) ? 1 : -1;
                if (
                  heightAt(triangle, x + direction[0] * 1e-6 * sign, z + direction[1] * 1e-6 * sign) == null
                )
                  continue;
              }
              if (emitted + 3 > maxOutputVertices)
                throw new Error('Canonical draping exceeds its vertex budget; split the source surface');
              outputArea += flatArea;
              for (const point of points) {
                const a = point[2],
                  b = point[3],
                  c = point[4],
                  terrainY = heightAt(triangle, ...point);
                if (terrainY == null) throw new Error('Canonical clipped point left its terrain face');
                for (const [name, attribute] of attributes) {
                  if (name === 'position')
                    output.position.push(
                      point[0],
                      source.getY(ids[0]) * a + source.getY(ids[1]) * b + source.getY(ids[2]) * c + terrainY,
                      point[1],
                    );
                  else
                    for (let k = 0; k < attribute.itemSize; k++) {
                      const v =
                        raw(attribute, ids[0], k) * a +
                        raw(attribute, ids[1], k) * b +
                        raw(attribute, ids[2], k) * c;
                      if (!Number.isFinite(v)) throw new Error('Non-finite source surface attribute');
                      output[name].push(
                        attribute.array instanceof Float32Array || attribute.array instanceof Float64Array
                          ? v
                          : Math.round(v),
                      );
                    }
                }
                emitted++;
              }
              emittedArea += Math.abs(cross(...rounded)) / 2;
            }
          }
        }
      }
    }
    if (!unknownArea && Math.abs(sourceArea - outputArea) > Math.max(0.00001, sourceArea * 1e-8))
      throw new Error(`Canonical surface coverage mismatch: ${sourceArea} / ${outputArea}`);
    if (
      core &&
      ground.manifest.summary?.unknownCells === 0 &&
      Math.abs(sourceMapAreaM2 - clippedMapAreaM2) > Math.max(0.00001, sourceMapAreaM2 * 1e-8)
    )
      throw new Error('Canonical surface omitted source area inside the complete native map');
    const result = new THREE.BufferGeometry();
    for (const [name, attribute] of attributes)
      result.setAttribute(
        name,
        new THREE.BufferAttribute(
          new attribute.array.constructor(output[name]),
          attribute.itemSize,
          attribute.normalized,
        ),
      );
    if (sourceIndex) result.setIndex(Array.from({ length: emitted }, (_, i) => i));
    result.computeVertexNormals();
    result.computeBoundingBox();
    result.computeBoundingSphere();
    result.userData = {
      ...geometry.userData,
      citySurfaceTerrain: {
        sourceGridSha256: ground.manifest.sha256,
        sourceTriangles: count / 3,
        includedSourceTriangles,
        regionBounds: region ? region.slice() : null,
        outputTriangles: emitted / 3,
        sourceProjectedAreaM2: sourceArea,
        clippedProjectedAreaM2: outputArea,
        outputProjectedAreaM2: emittedArea,
        unknownArea,
        collapsedClippedTriangles,
        collapsedAreaM2,
        reorientedSourceTriangles,
        maximumXZQuantizationM,
        sourceMapAreaM2: core ? sourceMapAreaM2 : null,
        clippedMapAreaM2: core ? clippedMapAreaM2 : null,
        mapAreaRoundingBoundM2: core ? mapAreaRoundingBoundM2 : null,
        sourceInterpolationBoundM: ground.meshErrorM,
      },
    };
    stats.drapedGeometries++;
    stats.inputTriangles += count / 3;
    stats.outputTriangles += emitted / 3;
    stats.faceTests += tests;
    geometry.dispose();
    return result;
  }
  return {
    source: ground,
    manifest: ground.manifest,
    stats,
    contains: ground.contains,
    offsetAt,
    sourceOffsetAt: ground.offsetAt,
    drapeGeometry,
    createPatchGeometry: ground.createPatchGeometry,
    clearCaches() {
      tiles.clear();
      cells.clear();
      stats.cachedTileTriangles = stats.cachedCellTriangles = 0;
    },
  };
}
