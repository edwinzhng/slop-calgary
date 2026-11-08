import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CROSSING_GENERATOR_FILES = Object.freeze([
  'app/baked-crossings.js',
  'app/mapped-crossings.js',
  'app/road-attributes.js',
  'app/pathway-finishes.js',
  'data/calgary-pathway-finishes.json',
  'app/geo.js',
  'app/infrastructure.js',
  'app/signal-heads.js',
  'app/static-batches.js',
  'app/static-cell-draws.js',
  'app/bridge-path.js',
  'app/bridge-deck.js',
  'app/rail-guideways.js',
  'app/bridge-forks.js',
  'app/movement-collision.js',
  'app/bridge-connections.js',
  'app/bridge-guard-finishes.js',
  'app/north-bow-overpass.js',
  'app/north-bow-access.js',
  'data/north-bow-overpass-evidence.json',
  'app/bridge-access.js',
  'app/peace-surfaces.js',
  'app/ground-surfaces.js',
  'app/linear-polygon-geometry.js',
  'app/polygon-queries.js',
  'app/car-instances.js',
  'app/island-terrain.js',
  'app/neighbourhood-terrain.js',
  'app/terrain-polygons.js',
  'app/memorial-underpass.js',
  'app/prince-arch-ground.js',
  'app/prince-arch.js',
  'app/site-overlays.js',
  'app/crossing-surface-context.js',
  'app/reference-streets.js',
  'tools/bake-mapped-crossings.mjs',
]);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function crossingGeneratorHashes(root) {
  return Object.fromEntries(
    await Promise.all(
      CROSSING_GENERATOR_FILES.map(async (file) => [file, hash(await readFile(join(root, file)))]),
    ),
  );
}

export async function verifyCrossingCache(root) {
  const manifest = JSON.parse(await readFile(join(root, 'data/calgary-mapped-crossings.json')));
  const generators = await crossingGeneratorHashes(root);
  if (
    JSON.stringify(Object.keys(generators).sort()) !== JSON.stringify(Object.keys(manifest.generators).sort())
  )
    throw new Error('Crossing generators changed. Run npm run crossings:bake.');
  for (const [file, expected] of Object.entries({ ...manifest.sources, ...manifest.generators })) {
    if (hash(await readFile(join(root, file))) !== expected)
      throw new Error(`Crossing cache is stale: ${file}. Run npm run crossings:bake.`);
  }
  if (hash(await readFile(join(root, 'data/calgary-mapped-crossings.bin'))) !== manifest.binarySha256)
    throw new Error('Crossing binary is corrupt. Run npm run crossings:bake.');
}
