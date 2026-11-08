import { createBuildingGroundPlacement, translateBuildingY } from './building-ground.js';

// Each row identifies an existing builder's source frame, not new architecture.
// Procedural models have no surveyed local floor origin. Their anchor remains
// explicitly inferred even when a similarly named City record is available.
const definitions = new Map([
  ['Calgary Tower', ['city-outline-27693-0', 'terrain']],
  ['The Bow', ['city-outline-28596-0', 'source']],
  ['Brookfield Place', ['city-outline-28386-0', 'terrain']],
  ['TELUS Sky', ['city-outline-28341-0', 'source']],
  ['Saddledome', ['city-outline-27014-0', 'terrain']],
  ['Central Library', ['city-outline-27865-0', 'terrain']],
  ['Studio Bell', ['city-outline-27710-0', 'source', ['city-outline-27710-0', 'city-outline-27712-0']]],
  ['Historic City Hall', ['city-outline-27880-0', 'terrain']],
  ['Bankers Hall', ['city-outline-24994-0', 'source']],
]);

export function createLandmarkGroundPlacement(ground, { data = {}, cityMeshes } = {}) {
  // Reuse the ordinary registry's strict CGVD28/GSD95 and world-origin contract.
  // Its source attachment retains the actual per-building ground and datum.
  const measured = createBuildingGroundPlacement(ground),
    buildings = new Map((data.buildings || []).map((b) => [b.id, b])),
    placements = new Map(),
    sourcePlacements = new Map(),
    connections = [],
    stats = { geometries: 0, vertices: 0, colliders: 0, photographicSurfaces: 0, deferredGeometries: 0 };

  function source(id) {
    if (sourcePlacements.has(id)) {
      const existing = sourcePlacements.get(id);
      if (!existing.frameFromMeasuredSource)
        throw new Error(`Landmark source ${id} already belongs to an inferred procedural frame`);
      return existing;
    }
    const building = buildings.get(id),
      record = cityMeshes?.get(id);
    if (!building || !record) throw new Error(`Native landmark lacks original source owner ${id}`);
    const attached = measured.attach(building, record, cityMeshes),
      placement = Object.freeze({
        ...attached,
        ownerId: id,
        sourceBuildingId: id,
        frameFromMeasuredSource: true,
        sourceGridSha256: ground.manifest.sha256,
        sourceDates: Object.freeze([...(record.sourceDates || [])]),
        deferred: false,
        architectureVerified: false,
      });
    placements.set(id, placement);
    sourcePlacements.set(id, placement);
    return placement;
  }

  function begin(name, x, z) {
    const definition = definitions.get(name);
    if (!definition || ![x, z].every(Number.isFinite))
      throw new Error(`Unknown native landmark frame ${name}`);
    const [id, policy, required = [id]] = definition;
    if (policy === 'source' && required.every((key) => cityMeshes?.has(key))) return source(id);
    const ownerId = `landmark:${name}`;
    if (placements.has(ownerId)) return placements.get(ownerId);
    const offset = ground.offsetAt(x, z);
    if (!Number.isFinite(offset)) throw new Error(`No native ground for landmark ${name}`);
    const placement = Object.freeze({
      ownerId,
      name,
      sourceBuildingId: id,
      offsetM: offset,
      method: 'inferred-rigid-landmark-native-ground-anchor',
      anchor: [x, z],
      referenceElevationM: ground.manifest.grid.referenceElevationM,
      sourceGridSha256: ground.manifest.sha256,
      originalGroundM: null,
      originalGroundDatum: null,
      frameFromMeasuredSource: false,
      verticalDatumConversion: false,
      deferred: false,
      architectureVerified: false,
    });
    placements.set(ownerId, placement);
    sourcePlacements.set(id, placement);
    return placement;
  }

  function defer(name, x, z, reason) {
    if (!name || !reason || ![x, z].every(Number.isFinite)) throw new Error('Invalid deferred landmark');
    const ownerId = `landmark:${name}`;
    if (placements.has(ownerId)) throw new Error(`Duplicate deferred landmark ${name}`);
    const placement = Object.freeze({
      ownerId,
      name,
      offsetM: 0,
      method: 'unchanged-crossing-frame-pending-native-bridge-profile',
      anchor: [x, z],
      reason,
      frameFromMeasuredSource: false,
      deferred: true,
      architectureVerified: false,
    });
    placements.set(ownerId, placement);
    return placement;
  }

  function placeGeometry(geometry, placement) {
    if (
      placements.get(placement?.ownerId) !== placement ||
      !Number.isFinite(placement?.offsetM) ||
      geometry.userData.landmarkGround ||
      geometry.userData.buildingGround
    )
      throw new Error('Landmark geometry requires exactly one declared placement');
    translateBuildingY(geometry, placement.offsetM);
    // BufferGeometry.clone shares userData with its prototype. Detach before
    // tagging a placed instance, or the next cloned beam appears placed too.
    geometry.userData = { ...geometry.userData, landmarkGround: placement };
    stats.geometries++;
    stats.vertices += geometry.attributes.position.count;
    if (placement.deferred) stats.deferredGeometries++;
    return geometry;
  }

  function placeCollider(collider, placement) {
    if (
      placements.get(placement?.ownerId) !== placement ||
      !Number.isFinite(placement?.offsetM) ||
      collider.landmarkGround ||
      collider.buildingGround
    )
      throw new Error('Landmark collider requires exactly one declared placement');
    const offset = placement.offsetM,
      out = {
        ...collider,
        height: collider.height + offset,
        minHeight: (collider.minHeight ?? 0) + offset,
        landmarkGround: placement,
      };
    for (const name of ['heightAt', 'minHeightAt'])
      if (typeof collider[name] === 'function')
        out[name] = (x, z, body) => {
          const y = collider[name](x, z, body);
          return y == null ? y : y + offset;
        };
    stats.colliders++;
    return out;
  }

  function placePhotographicGeometry(geometry, record) {
    const placement = sourcePlacements.get(record.wallGeometryBuildingId || record.buildingId);
    if (!placement) return geometry;
    placeGeometry(geometry, placement);
    stats.photographicSurfaces++;
    return geometry;
  }

  function connection(id, sourceIds, appliedOwnerId, reason) {
    if (!Array.isArray(sourceIds) || sourceIds.length < 2 || new Set(sourceIds).size !== sourceIds.length)
      throw new Error('Landmark connection requires distinct source owners');
    const owners = sourceIds.map((sourceId) => {
      const placement = sourcePlacements.get(sourceId);
      if (!placement) throw new Error(`Unknown landmark connection owner ${sourceId}`);
      return { sourceId, ownerId: placement.ownerId, offsetM: placement.offsetM, method: placement.method };
    });
    if (!id || !reason || !placements.has(appliedOwnerId) || connections.some((c) => c.id === id))
      throw new Error('Invalid or repeated landmark connection');
    connections.push(
      Object.freeze({
        id,
        owners,
        appliedOwnerId,
        reason,
        placementOffsetSpreadM:
          Math.max(...owners.map((o) => o.offsetM)) - Math.min(...owners.map((o) => o.offsetM)),
        status: 'joint-level-source-game-review-required',
        inferred: true,
        reviewed: false,
      }),
    );
  }

  return {
    begin,
    source,
    defer,
    placements,
    sourcePlacements,
    connections,
    connection,
    stats,
    offsetFor: (id) => sourcePlacements.get(id)?.offsetM ?? null,
    placementFor: (id) => sourcePlacements.get(id) ?? null,
    placeGeometry,
    placeCollider,
    placePhotographicGeometry,
  };
}
