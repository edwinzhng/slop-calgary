// Resample the verified, locally retained City 2 m DEM into the game datum.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { bounds, inPolygon, nearestOnSegment, project, SpatialIndex } from '../app/geo.js';

const root = new URL('../data/', import.meta.url),
  read = async (name) => JSON.parse(await readFile(new URL(name, root))),
  native = await read('calgary-city-ground.json'),
  bytes = await readFile(new URL('calgary-city-ground.bin', root)),
  data = await read('calgary.json'),
  hash = (body) => createHash('sha256').update(body).digest('hex');
if (hash(bytes) !== native.sha256) throw new Error('City source DEM checksum mismatch');
// The raw source atlas is kept locally; the game and production build only
// need this tool's compact output. Read its CGND grid directly for rebakes.
const { grid, worldToSource: transform } = native;
if (
  native.version !== 1 ||
  bytes.subarray(0, 4).toString() !== 'CGND' ||
  bytes.length !== grid.byteOffset + grid.width * grid.height * 2 ||
  bytes.readUInt32LE(8) !== grid.width ||
  bytes.readUInt32LE(12) !== grid.height ||
  bytes.readDoubleLE(16) !== grid.referenceElevationM ||
  bytes.readDoubleLE(24) !== grid.heightScaleM
)
  throw new Error('Unexpected source DEM format');
function elevationAt(x, z) {
  const u = (x - transform.inputOrigin[0]) / transform.normalizationM,
    v = (z - transform.inputOrigin[1]) / transform.normalizationM;
  const coordinate = (i) => {
    const c = transform.coefficients[i];
    return (
      transform.outputOrigin[i] +
      c[0] +
      c[1] * u +
      c[2] * v +
      c[3] * u * u +
      c[4] * u * v +
      c[5] * v * v +
      c[6] * u * u * u +
      c[7] * u * u * v +
      c[8] * u * v * v +
      c[9] * v * v * v
    );
  };
  const col = (coordinate(0) - grid.eastingAtColumn0) / grid.stepM,
    row = (grid.northingAtRow0 - coordinate(1)) / grid.stepM;
  if (col < 0 || row < 0 || col > grid.width - 1 || row > grid.height - 1) return null;
  const c = Math.min(grid.width - 2, Math.floor(col)),
    r = Math.min(grid.height - 2, Math.floor(row)),
    tx = col - c,
    tz = row - r,
    index = grid.byteOffset + (r * grid.width + c) * 2;
  const a = bytes.readInt16LE(index),
    b = bytes.readInt16LE(index + 2),
    d = bytes.readInt16LE(index + grid.width * 2),
    e = bytes.readInt16LE(index + grid.width * 2 + 2);
  if ([a, b, d, e].includes(grid.noDataValue)) return null;
  return (
    grid.referenceElevationM +
    ((a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz) * grid.heightScaleM
  );
}
const step = 10,
  unit = 0.04,
  apron = 300,
  { west, north, east, south } = data.meta.bbox,
  [westX, northZ] = project(west, north),
  [eastX, southZ] = project(east, south),
  origin = [Math.floor((westX - apron) / step) * step, Math.floor((northZ - apron) / step) * step],
  width = Math.ceil((eastX + apron - origin[0]) / step) + 1,
  height = Math.ceil((southZ + apron - origin[1]) / step) + 1,
  water = new SpatialIndex(80),
  shore = new SpatialIndex(80);
for (const polygon of data.waters) {
  water.insert(polygon, bounds(polygon.ring));
  for (const ring of [polygon.ring, ...(polygon.holes || [])])
    for (let i = 0; i < ring.length; i++) {
      const edge = [ring[i], ring[(i + 1) % ring.length]];
      shore.insert(edge, bounds(edge));
    }
}
const smooth = (t) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};
function bankWeight(x, z) {
  if ([...water.near(x, z)].some((p) => inPolygon(x, z, p))) return 0;
  let distance = 34;
  for (const [a, b] of shore.near(x, z, distance))
    distance = Math.min(distance, nearestOnSegment(x, z, a, b).distance);
  return smooth((distance - 12) / 22);
}
const binary = Buffer.alloc(width * height * 2);
let activeSamples = 0,
  maximumOffset = 0;
for (let row = 0; row < height; row++)
  for (let column = 0; column < width; column++) {
    const x = origin[0] + step * column,
      z = origin[1] + step * row,
      px = Math.max(westX, Math.min(eastX, x)),
      pz = Math.max(northZ, Math.min(southZ, z)),
      extent = 1 - smooth(Math.hypot(x - px, z - pz) / apron);
    if (!extent) continue;
    let sum = 0;
    for (const [dx, dz, weight] of [
      [0, 0, 4],
      [-4, 0, 1],
      [4, 0, 1],
      [0, -4, 1],
      [0, 4, 1],
    ]) {
      const elevation = elevationAt(px + dx, pz + dz);
      if (elevation == null) throw new Error(`No native DEM coverage at ${px + dx},${pz + dz}`);
      sum += elevation * weight;
    }
    // The game retains its level rivers and low floodplain. The reference
    // slopes downstream west-to-east and the 8.5 m band protects the flats.
    const datum = 1052 - (px + 2500) * 0.0024 + 8.5,
      residual = sum / 8 - datum;
    if (residual <= 0) continue;
    const offset = residual * smooth(residual / 3) * bankWeight(px, pz) * extent;
    const sample = Math.round(offset / unit);
    if (!sample) continue;
    activeSamples++;
    maximumOffset = Math.max(maximumOffset, sample * unit);
    binary.writeInt16LE(sample, (row * width + column) * 2);
  }
const manifest = {
  version: 1,
  source: 'https://data.calgary.ca/d/eink-tu9p',
  sourceSha256: native.sha256,
  sourceDatum: 'CGVD28 / GSD95',
  license: 'https://data.calgary.ca/d/u45n-7awa',
  method:
    'Resampled 2 m bare-earth LiDAR. Positive relief above the west-to-east floodplain datum, with a lowland band and shoreline/edge transitions. Game heights are relative.',
  origin,
  step,
  unit,
  width,
  height,
  activeSamples,
  maximumOffset,
  byteLength: binary.length,
  sha256: hash(binary),
};
async function writeChanged(name, content) {
  const url = new URL(name, root),
    previous = await readFile(url).catch(() => null);
  if (!previous?.equals(content)) await writeFile(url, content);
}
await Promise.all([
  writeChanged('calgary-neighbourhood-terrain.bin', binary),
  writeChanged('calgary-neighbourhood-terrain.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')),
]);
console.log({ width, height, activeSamples, maximumOffset, bytes: binary.length });
