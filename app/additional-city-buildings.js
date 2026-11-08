import { createPartialBuildingBatch, loadPartialBuildings } from './partial-city-buildings.js';

export const ADDITIONAL_BUILDING_MANIFEST_URL = new URL(
  '../data/ADDITIONAL_BUILDING_FRAGMENTS_MESHES.json',
  import.meta.url,
);
export const ADDITIONAL_BUILDING_BINARY_URL = new URL(
  '../data/ADDITIONAL_BUILDING_FRAGMENTS_MESHES.bin',
  import.meta.url,
);
export const ADDITIONAL_BUILDING_BINARY_SHA256 =
  '36bfebff0560cd39d8d2c0d0ad59a390b849b195c66e7e7d8cb994e12478e892';
export const ADDITIONAL_BUILDING_MANIFEST_SHA256 =
  '3a50e069334df0c942031d92c86a7adaf743fe2789a0531b209edd5a509a8b36';

export function createAdditionalBuildings(data, manifest, binary) {
  return createPartialBuildingBatch(data, manifest, binary, {
    binaryBytes: 26800,
    binaryFnv: 2284525192,
    binarySha256: ADDITIONAL_BUILDING_BINARY_SHA256,
    manifestFnv: 174159830,
    sourceCount: 78,
    // The complete manifest is pinned before any owner is constructed.
    ids: manifest?.meta?.partialCompounds?.map((c) => c.baselineId) || [],
  });
}

export async function loadAdditionalBuildings(data, { fetcher = globalThis.fetch, signal } = {}) {
  const [sourceMap, ...responses] = await Promise.all([
    data,
    fetcher(ADDITIONAL_BUILDING_MANIFEST_URL, { signal }),
    fetcher(ADDITIONAL_BUILDING_BINARY_URL, { signal }),
  ]);
  if (responses.some((r) => !r.ok))
    throw new Error('Additional building assets unavailable; retain complete baseline ownership');
  const [manifest, binary] = await Promise.all([responses[0].json(), responses[1].arrayBuffer()]);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', binary),
      hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (hash !== ADDITIONAL_BUILDING_BINARY_SHA256)
      throw new Error('Additional building source SHA256 mismatch');
  }
  return createAdditionalBuildings(sourceMap, manifest, binary);
}

/** Each batch retains its own all-or-nothing proof. One unavailable enhancement
 * cannot discard a valid older batch or grant ownership of its baseline bodies.
 */
export function combinePartialBuildingProviders(providers, batches = []) {
  const owners = new Map(),
    replacedBuildingIds = new Set(),
    sourceModelIds = new Set();
  for (const provider of providers) {
    if (provider?.ready !== true) throw new Error('Unvalidated partial building provider');
    for (const [ids, destination] of [
      [provider.replacedBuildingIds, replacedBuildingIds],
      [provider.sourceModelIds, sourceModelIds],
    ]) {
      for (const id of ids) {
        if (owners.has(id)) throw new Error('Partial building batches claim the same owner');
        owners.set(id, provider);
        destination.add(id);
      }
    }
  }
  const call = (method, id, ...args) => owners.get(id)?.[method](id, ...args) ?? null;
  const stats = { batches };
  for (const key of [
    'proposedPartialCompounds',
    'measuredFragments',
    'measuredTriangles',
    'retainedFallbackPieces',
    'originalRoofSupportedSeamPieces',
    'fullyMeasuredCompounds',
    'currentArchitectureVerified',
  ])
    stats[key] = providers.reduce((n, p) => n + (p.stats[key] || 0), 0);
  return {
    ready: true,
    active: false,
    providers,
    replacedBuildingIds,
    sourceModelIds,
    stats,
    has: (id) => owners.has(id),
    hasGeometry: (id) => owners.has(id),
    get: (id) => call('get', id),
    createGeometry: (id) => call('createGeometry', id),
    photoWallGeometry: (id) => call('photoWallGeometry', id),
    collisionParts: (id) => call('collisionParts', id),
    roofHeightAt: (id, x, z) => call('roofHeightAt', id, x, z),
    composition: (id) => call('composition', id),
  };
}

export async function loadAllPartialBuildings(data, options = {}) {
  const outcomes = await Promise.allSettled([
    loadPartialBuildings(data, options),
    loadAdditionalBuildings(data, options),
  ]);
  const names = ['original-five', 'additional-78'],
    providers = outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value),
    batches = outcomes.map((o, i) => ({
      id: names[i],
      accepted: o.status === 'fulfilled',
      ...(o.status === 'rejected' ? { reason: o.reason?.message || String(o.reason) } : {}),
    }));
  if (!providers.length)
    throw new Error('Partial building batches unavailable: ' + batches.map((b) => b.reason).join('; '));
  return combinePartialBuildingProviders(providers, batches);
}
