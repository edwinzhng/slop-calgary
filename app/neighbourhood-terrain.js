import * as THREE from 'three/webgpu';
import { readAssetBytes } from './asset-bytes.js';
import { createTerrainDraper } from './island-terrain.js';
import { addStaticBatches } from './static-batches.js';
import { remeshTerrain, splitTerrainPolygon, terrainPolygonBounds } from './terrain-polygons.js';
import manifest from '../data/calgary-neighbourhood-terrain.json' with { type: 'json' };

export async function loadNeighbourhoodTerrain() {
  const url = new URL('../data/calgary-neighbourhood-terrain.bin', import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error('Neighbourhood elevations could not be loaded');
  return readAssetBytes(response, url);
}

export function withNeighbourhoodTerrain(local, binary) {
  const { width, height, step, unit, origin, byteLength } = manifest;
  if (binary.byteLength !== byteLength || binary.byteLength !== width * height * 2)
    throw new Error('Invalid neighbourhood terrain sample count');
  const values = new Int16Array(binary);
  const tileCells = 32,
    columns = Math.ceil((width - 1) / tileCells),
    rows = Math.ceil((height - 1) / tileCells),
    active = new Uint8Array(columns * rows);
  const [x0, z0] = origin;
  const heightAt = (x, z) => values[z * width + x] * unit;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const x = i * tileCells,
        z = j * tileCells,
        endX = Math.min(width - 1, x + tileCells),
        endZ = Math.min(height - 1, z + tileCells);
      for (let r = z; r <= endZ && !active[j * columns + i]; r++)
        for (let c = x; c <= endX; c++)
          if (values[r * width + c]) {
            active[j * columns + i] = 1;
            break;
          }
    }
  // A summed area table rejects flat portions of mixed tiles before polygon
  // subdivision, including triangles that only touch a wide bounding box.
  const coverage = new Uint32Array(width * height);
  for (let r = 1; r < height; r++) {
    let sum = 0;
    for (let c = 1; c < width; c++) {
      const i = r * width + c;
      sum += values[i] || values[i - 1] || values[i - width] || values[i - width - 1] ? 1 : 0;
      coverage[i] = coverage[i - width] + sum;
    }
  }
  function intersectsRegional({ minX, maxX, minZ, maxZ }) {
    const left = Math.max(0, Math.floor((minX - x0) / step)),
      right = Math.min(width - 1, 1 + Math.floor((maxX - x0) / step)),
      top = Math.max(0, Math.floor((minZ - z0) / step)),
      bottom = Math.min(height - 1, 1 + Math.floor((maxZ - z0) / step));
    return (
      left < right &&
      top < bottom &&
      coverage[bottom * width + right] -
        coverage[top * width + right] -
        coverage[bottom * width + left] +
        coverage[top * width + left] >
        0
    );
  }
  function regionalOffsetAt(x, z) {
    const u = (x - x0) / step,
      v = (z - z0) / step;
    if (!(u >= 0 && v >= 0 && u < width - 1 && v < height - 1)) return 0;
    const c = Math.floor(u),
      r = Math.floor(v),
      tx = u - c,
      tz = v - r,
      b = heightAt(c + 1, r),
      s = heightAt(c, r + 1);
    // Match the two rendered ground triangles, including their diagonal.
    return tx + tz <= 1
      ? heightAt(c, r) * (1 - tx - tz) + b * tx + s * tz
      : heightAt(c + 1, r + 1) * (tx + tz - 1) + b * (1 - tz) + s * (1 - tx);
  }
  function lineCuts(ax, az, bx, bz) {
    const box = {
      minX: Math.min(ax, bx),
      maxX: Math.max(ax, bx),
      minZ: Math.min(az, bz),
      maxZ: Math.max(az, bz),
    };
    if (!intersectsRegional(box)) return [0, 1];
    const cuts = [0, 1];
    for (const [a, b, base] of [
      [ax, bx, x0],
      [az, bz, z0],
      [ax + az, bx + bz, x0 + z0],
    ]) {
      if (Math.abs(b - a) < 1e-8) continue;
      for (let k = Math.floor((Math.min(a, b) - base) / step) + 1; base + k * step < Math.max(a, b); k++)
        cuts.push((base + k * step - a) / (b - a));
    }
    return cuts.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-7);
  }
  const localOffsetAt = local.offsetAt;
  const offsetAt = (x, z) => localOffsetAt(x, z) + regionalOffsetAt(x, z);
  const stats = {
    ...local.stats,
    neighbourhoodBytes: byteLength,
    neighbourhoodSamples: values.length,
    neighbourhoodActiveSamples: manifest.activeSamples,
    neighbourhoodMaximumOffset: manifest.maximumOffset,
    groundTiles: 0,
    groundTriangles: 0,
  };
  function addGround(scene, material, cutSurface) {
    const pieces = [];
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        if (!active[j * columns + i]) continue;
        const x = i * tileCells,
          z = j * tileCells,
          w = Math.min(tileCells + 1, width - x),
          h = Math.min(tileCells + 1, height - z),
          positions = new Float32Array(w * h * 3),
          normals = new Float32Array(positions.length),
          indices = [];
        for (let r = 0; r < h; r++)
          for (let c = 0; c < w; c++) {
            const index = r * w + c,
              cx = x + c,
              rz = z + r,
              y = heightAt(cx, rz),
              dx = heightAt(Math.max(0, cx - 1), rz) - heightAt(Math.min(width - 1, cx + 1), rz),
              dz = heightAt(cx, Math.max(0, rz - 1)) - heightAt(cx, Math.min(height - 1, rz + 1)),
              length = Math.hypot(dx, 2 * step, dz);
            positions.set([x0 + cx * step, y - 0.04, z0 + rz * step], index * 3);
            normals.set([dx / length, (2 * step) / length, dz / length], index * 3);
            if (
              c + 1 < w &&
              r + 1 < h &&
              (y || heightAt(cx + 1, rz) || heightAt(cx, rz + 1) || heightAt(cx + 1, rz + 1))
            )
              indices.push(index, index + w, index + 1, index + 1, index + w, index + w + 1);
          }
        if (!indices.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geometry.setIndex(indices);
        pieces.push(cutSurface?.(geometry) || geometry);
        stats.groundTriangles += indices.length / 3;
      }
    stats.groundTiles = pieces.length;
    return addStaticBatches(scene, pieces, material, 'Calgary neighbourhood relief');
  }
  const intersectsLocal = (box) =>
    local.grids.some(
      ({ bounds: [x0, z0, x1, z1] }) => box.maxX >= x0 && box.minX <= x1 && box.maxZ >= z0 && box.minZ <= z1,
    );
  const intersectsBounds = (box) => intersectsLocal(box) || intersectsRegional(box);
  const drapeLocal = createTerrainDraper(localOffsetAt, intersectsLocal, stats);
  function splitOnGrid(polygon, emit) {
    const box = terrainPolygonBounds(polygon);
    if (!intersectsRegional(box)) {
      emit(polygon);
      return;
    }
    const left = Math.floor((box.minX - x0 + 1e-8) / step),
      right = Math.floor((box.maxX - x0 - 1e-8) / step),
      top = Math.floor((box.minZ - z0 + 1e-8) / step),
      bottom = Math.floor((box.maxZ - z0 - 1e-8) / step);
    if (right <= left && bottom <= top) {
      const line = x0 + z0 + step * (left + top + 1);
      for (const piece of splitTerrainPolygon(polygon, (p) => p[0] + p[2] - line))
        if (piece.length >= 3) emit(piece);
      return;
    }
    const horizontal = right - left >= bottom - top;
    const boundary = horizontal
      ? x0 + Math.ceil((left + right) / 2) * step
      : z0 + Math.ceil((top + bottom) / 2) * step;
    const axis = horizontal ? 0 : 2;
    for (const piece of splitTerrainPolygon(polygon, (p) => p[axis] - boundary))
      if (piece.length >= 3) splitOnGrid(piece, emit);
  }
  function drapeRegional(geometry) {
    const triangles = (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    const result = remeshTerrain(geometry, splitOnGrid, regionalOffsetAt);
    stats.drapedGeometries++;
    stats.addedTriangles += result.index.count / 3 - triangles;
    return result;
  }
  const drapeGeometry = (geometry, maxEdge) => {
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    const box = { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z };
    const regional = intersectsRegional(box) ? drapeRegional(geometry) : geometry;
    return intersectsLocal(box) ? drapeLocal(regional, maxEdge) : regional;
  };
  return {
    ...local,
    manifest: { ...local.manifest, neighbourhoods: manifest },
    grids: [...local.grids, { id: 'neighbourhoods', values }],
    stats,
    offsetAt,
    localOffsetAt,
    regionalOffsetAt,
    contains: (x, z) => regionalOffsetAt(x, z) > 0 || local.contains(x, z),
    intersectsBounds,
    lineCuts,
    drapeGeometry,
    addGround,
  };
}
