export const SUPPLEMENTAL_CONTACT_REGIONS_URL = new URL(
  '../data/SUPPLEMENTAL_CONTACT_REGIONS.json',
  import.meta.url,
);
const EXPECTED_FNV1A = 584862182;
const bytesOf = (b) =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const hash = (bytes) => {
  let n = 2166136261;
  for (const b of bytes) n = Math.imul(n ^ b, 16777619) >>> 0;
  return n;
};
const jsonHash = (value) => hash(new TextEncoder().encode(JSON.stringify(value)));

/** Exact-source optional enhancement. A stale/changed input keeps the original
 * complete source body and reports a rejected enhancement, never new ownership.
 */
export function supplementalContactRegions(manifest, sources) {
  if (!manifest) return { accepted: false, reason: 'Contact region asset not supplied', models: null };
  try {
    if (manifest.version !== 1 || jsonHash(manifest) !== EXPECTED_FNV1A)
      throw new Error('Contact region asset differs from the source-validated export');
    const expected = manifest.meta.sourceSignatures,
      pairs = [
        ['data/calgary-recovered-meshes.json', jsonHash(sources.recoveredManifest)],
        ['data/calgary-recovered-meshes.bin', hash(bytesOf(sources.recoveredBinary))],
        ['data/calgary-fallback-parts.json', jsonHash(sources.partManifest)],
        ['data/calgary-fallback-parts.bin', hash(bytesOf(sources.partBinary))],
      ];
    if (pairs.some(([name, value]) => expected[name] !== value))
      throw new Error('Source geometry or mapped-part provenance changed');
    const models = new Map(manifest.models.map((m) => [m.id, m])),
      ids = [...sources.recoveredManifest.buildings, ...sources.partManifest.buildings].map((r) => r.id);
    if (models.size !== ids.length || ids.some((id) => !models.has(id)))
      throw new Error('Contact regions do not cover exactly the supplied source owners');
    return { accepted: true, reason: null, models };
  } catch (error) {
    return { accepted: false, reason: error.message, models: null };
  }
}
