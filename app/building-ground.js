import { bounds, ORIGIN } from './geo.js';

export function translateBuildingY(geometry, offset) {
  if (!offset) return;
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getY(i) + offset);
  positions.needsUpdate = true;
  // BufferGeometry.translate also renormalizes normals. A rigid shift needs no
  // normal/UV/material mutation, including no extra Float32 normalization round.
  if (geometry.boundingBox) geometry.computeBoundingBox();
  if (geometry.boundingSphere) geometry.computeBoundingSphere();
}

/** Rigid attachment for the existing ordinary-building pipeline. The caller
 * opts in explicitly; the game does not load this field yet. Source geometry,
 * material acceptance gates and relative model dimensions stay in their source
 * frame until the final placement. Mixed/different-datum bodies use an explicit
 * inferred terrain anchor, never an implicit vertical-datum conversion. */
export function createBuildingGroundPlacement(ground, { reliefAt } = {}) {
  const source = ground?.manifest?.meta?.source,
    reference = ground?.manifest?.grid?.referenceElevationM;
  if (
    !reliefAt &&
    (source?.verticalDatum !== 'CGVD28' ||
      source.geoid !== 'GSD95 (ITRF)' ||
      ground.manifest.meta.worldOrigin?.lon !== ORIGIN.lon ||
      ground.manifest.meta.worldOrigin?.lat !== ORIGIN.lat ||
      !Number.isFinite(reference) ||
      typeof ground.offsetAt !== 'function')
  )
    throw new Error('Building placement requires the declared City CGVD28/GSD95 ground field');

  const placements = new Map(),
    aliases = new Map(),
    stats = {
      measuredDatumRestorations: 0,
      inferredRigidPlacements: 0,
      geometries: 0,
      colliders: 0,
      coveredColliders: 0,
      photographicSurfaces: 0,
    };
  function attach(building, record, provider) {
    if (placements.has(building.id)) return placements.get(building.id);
    const box = bounds(building.ring),
      point = [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2],
      datum =
        record?.groundDatum ||
        (provider?.recovered?.has(building.id)
          ? provider.recoveredManifest?.meta?.verticalDatum
          : provider?.manifest?.meta?.verticalDatum),
      restoreMeasured =
        !reliefAt &&
        Number.isFinite(record?.ground) &&
        !record.partialCompound &&
        typeof datum === 'string' &&
        /^CGVD28(?:\s*\/\s*GSD95)?(?:\s|$)/.test(datum) &&
        (datum === 'CGVD28' || datum.includes('GSD95')),
      offset = restoreMeasured ? record.ground - reference : (reliefAt || ground.offsetAt)(...point);
    if (!Number.isFinite(offset)) throw new Error(`No declared building ground at ${building.id}`);
    const placement = Object.freeze({
      buildingId: building.id,
      offsetM: offset,
      method: restoreMeasured
        ? 'restore-original-CGVD28-ground'
        : reliefAt
          ? 'inferred-neighbourhood-anchor'
          : 'inferred-rigid-native-ground-anchor',
      originalGroundM: restoreMeasured ? record.ground : null,
      originalGroundDatum: datum || null,
      referenceElevationM: reference ?? null,
      anchor: restoreMeasured ? null : point,
      mixedCompound: !!record?.partialCompound,
      verticalDatumConversion: false,
    });
    placements.set(building.id, placement);
    stats[restoreMeasured ? 'measuredDatumRestorations' : 'inferredRigidPlacements']++;
    // A partial source photo uses the same retained compound's rigid shift.
    // It must still pass its original measured-wall registration first.
    const fragments =
      provider?.composition?.(building.id)?.compound?.sourceModelIds ||
      (provider?.partial?.baselineBuildingId === building.id ? [provider.partial.sourceModelId] : []);
    for (const id of fragments) {
      if (!id) continue;
      if (aliases.has(id) && aliases.get(id) !== building.id)
        throw new Error(`Ambiguous photographic building placement: ${id}`);
      aliases.set(id, building.id);
    }
    return placement;
  }
  function offsetFor(id) {
    return placements.get(aliases.get(id) || id)?.offsetM ?? null;
  }
  function placeGeometry(geometry, placement) {
    if (!geometry) return geometry;
    if (geometry.userData.buildingGround) throw new Error('Building geometry must be placed exactly once');
    translateBuildingY(geometry, placement.offsetM);
    geometry.userData.buildingGround = placement;
    stats.geometries++;
    return geometry;
  }
  function placeCollider(collider, placement) {
    if (collider.buildingGround) throw new Error('Building collider must be placed exactly once');
    const offset = placement.offsetM,
      shifted = {
        ...collider,
        height: collider.height + offset,
        minHeight: (collider.minHeight ?? -1) + offset,
        buildingGround: placement,
      };
    for (const name of ['heightAt', 'minHeightAt']) {
      if (typeof collider[name] !== 'function') continue;
      // Preserve null (fall back to numeric bounds) and +/-Infinity (empty
      // projection). A disjoint roof must not become a solid zero-height roof.
      shifted[name] = (x, z, body) => {
        const value = collider[name](x, z, body);
        return value == null ? value : value + offset;
      };
    }
    if (reliefAt && (collider.minHeight ?? -1) <= 0.35) {
      const floor = shifted.minHeightAt;
      shifted.minHeightAt = (x, z, body) =>
        Math.min(floor?.(x, z, body) ?? shifted.minHeight, reliefAt(x, z) - 0.08);
    }
    stats.colliders++;
    return shifted;
  }
  function coveredCollider(collider, proof, ownerFor) {
    if (!proof?.modelIds?.length) throw new Error('Covered building lacks its original ownership proof');
    const owners = proof.modelIds.map((id) => {
      const { building, record, provider, placement } = ownerFor(id) || {};
      if (!building || !record || typeof provider.collisionHeightAt !== 'function')
        throw new Error(`Covered building lacks a source roof envelope: ${id}`);
      return { id, provider, placement: placement || attach(building, record, provider) };
    });
    if (!owners.length) throw new Error('Covered building has no measured owners');
    const low = Math.min(...owners.map((o) => o.placement.offsetM)),
      high = Math.max(...owners.map((o) => o.placement.offsetM));
    stats.coveredColliders++;
    return {
      ...collider,
      minHeight: (collider.minHeight ?? -1) + low,
      height: collider.height + high,
      heightAt: (x, z, body) => {
        let top = -Infinity;
        for (const { id, provider, placement } of owners) {
          const height = provider.collisionHeightAt(id, x, z, body);
          if (height != null) top = Math.max(top, height + placement.offsetM);
        }
        return top;
      },
      buildingGround: Object.freeze({
        method: 'covered-original-owner-envelopes',
        sourceModelIds: proof.modelIds.slice(),
        minimumOffsetM: low,
        maximumOffsetM: high,
        inferredSolidInterior: true,
      }),
    };
  }
  function placePhotographicGeometry(geometry, record) {
    const offset = offsetFor(record.wallGeometryBuildingId || record.buildingId);
    if (offset == null) return geometry; // Landmarks/structures are a separate attachment scope.
    if (geometry.userData.buildingGround) throw new Error('Photographic surface already placed');
    translateBuildingY(geometry, offset);
    geometry.userData.buildingGround = { method: 'registered-source-photo-rigid-placement', offsetM: offset };
    stats.photographicSurfaces++;
    return geometry;
  }
  return {
    attach,
    offsetFor,
    placeGeometry,
    placeCollider,
    coveredCollider,
    placePhotographicGeometry,
    placements,
    stats,
  };
}
