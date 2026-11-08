import { createBuildingGroundPlacement, translateBuildingY } from './building-ground.js';
import { createCitySurfaceTerrain } from './city-surface-terrain.js';
import { surfaceStyle } from './ground-surfaces.js';
import { SpatialIndex, bounds, inPolygon } from './geo.js';

// Reuse the existing display offsets on the actual canonical native faces.
// These offsets identify render/support layers, not surveyed paving thickness.
export function createNativeStructureSupport(ground, { surfaceData = {}, parkData = {} } = {}) {
  const canonical = createCitySurfaceTerrain(ground),
    index = new SpatialIndex(160),
    stats = {
      polygons: 0,
      queries: 0,
      polygonTests: 0,
      fallbackQueries: 0,
      unsupportedQueries: 0,
      maximumCachedTileTriangles: 0,
      maximumCachedCellTriangles: 0,
      disposed: false,
    };
  for (const [items, category] of [
    [surfaceData.surfaces || [], 'city'],
    [[...(parkData.ground || []), ...(parkData.paving || [])], 'park'],
  ]) {
    for (const polygon of items) {
      if (++stats.polygons > 65536) throw new Error('Native structure support exceeds polygon budget');
      const y =
        category === 'city'
          ? surfaceStyle(polygon).y
          : ['turf', 'natural', 'park-ground'].includes(polygon.kind)
            ? 0.045
            : 0.138;
      index.insert({ polygon, y, category }, bounds(polygon.ring));
    }
  }
  function sample(x, z) {
    if (stats.disposed) throw new Error('Native structure support is disposed');
    if (![x, z].every(Number.isFinite)) throw new Error('Invalid native structure support point');
    stats.queries++;
    const groundY = canonical.offsetAt(x, z);
    stats.maximumCachedTileTriangles = Math.max(
      stats.maximumCachedTileTriangles,
      canonical.stats.cachedTileTriangles,
    );
    stats.maximumCachedCellTriangles = Math.max(
      stats.maximumCachedCellTriangles,
      canonical.stats.cachedCellTriangles,
    );
    if (groundY == null) {
      stats.unsupportedQueries++;
      return null;
    }
    let baseY = -Infinity,
      owners = [];
    for (const item of index.cells.get(`${Math.floor(x / index.size)},${Math.floor(z / index.size)}`) || []) {
      stats.polygonTests++;
      if (!inPolygon(x, z, item.polygon)) continue;
      if (item.y > baseY) {
        baseY = item.y;
        owners = [];
      }
      if (item.y === baseY) owners.push({ id: item.polygon.id, category: item.category });
    }
    const inferredFallback = baseY === -Infinity;
    if (inferredFallback) {
      // With no mapped finish, meet the native base-ground display surface.
      // The legacy actor fallback (+0.2) would leave support plates floating.
      baseY = -0.04;
      stats.fallbackQueries++;
    }
    return {
      x,
      z,
      groundY,
      baseY,
      height: groundY + baseY,
      owners,
      inferredFallback,
      method: 'canonical-native-faces-with-existing-source-display-offset',
      sourceGridSha256: ground.manifest.sha256,
    };
  }
  return {
    ground,
    stats,
    sample,
    dispose() {
      if (stats.disposed) return;
      stats.disposed = true;
      canonical.clearCaches();
      index.cells.clear();
    },
  };
}

export function createStructureGroundPlacement(
  ground,
  { data = {}, cityMeshes, surfaceData = {}, parkData = {} } = {},
) {
  const measured = createBuildingGroundPlacement(ground),
    support = createNativeStructureSupport(ground, { surfaceData, parkData }),
    buildings = new Map((data.buildings || []).map((b) => [b.id, b])),
    placements = new Map(),
    sourcePlacements = new Map(),
    stats = { geometries: 0, vertices: 0, colliders: 0, walkSurfaces: 0, photographicSurfaces: 0 };
  function source(id) {
    if (sourcePlacements.has(id)) return sourcePlacements.get(id);
    const building = buildings.get(id),
      record = cityMeshes?.get(id);
    if (!building || !record) throw new Error(`Native structure lacks original source owner ${id}`);
    const attached = measured.attach(building, record, cityMeshes);
    if (attached.method !== 'restore-original-CGVD28-ground')
      throw new Error(`Native structure source ${id} requires original CGVD28/GSD95 ground`);
    const placement = Object.freeze({
      ...attached,
      ownerId: id,
      sourceBuildingId: id,
      frameFromMeasuredSource: true,
      sourceGridSha256: ground.manifest.sha256,
      sourceDates: Object.freeze([...(record.sourceDates || [])]),
      architectureVerified: false,
    });
    placements.set(id, placement);
    sourcePlacements.set(id, placement);
    return placement;
  }
  function site(record) {
    if (placements.has(record.id)) return placements.get(record.id);
    const box = bounds(record.footprint);
    let anchor = record.anchor?.slice() || [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2],
      anchorMethod = record.anchor ? 'authored-plan-anchor' : 'footprint-bounds-centre';
    if (!inPolygon(...anchor, { ring: record.footprint })) {
      anchor = record.footprint[0].slice();
      anchorMethod = 'first-footprint-vertex';
    }
    const at = support.sample(...anchor);
    if (!at) throw new Error(`No native ground for development ${record.id}`);
    let minimum = Infinity,
      maximum = -Infinity,
      samples = 0,
      missing = 0;
    for (let i = 0; i < record.footprint.length; i++) {
      const a = record.footprint[i],
        b = record.footprint[(i + 1) % record.footprint.length],
        count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
      for (let k = 0; k < count; k++) {
        if (++samples > 16384) throw new Error('Development native contour exceeds sample budget');
        const p = support.sample(a[0] + ((b[0] - a[0]) * k) / count, a[1] + ((b[1] - a[1]) * k) / count);
        if (!p) {
          missing++;
          continue;
        }
        minimum = Math.min(minimum, p.groundY);
        maximum = Math.max(maximum, p.groundY);
      }
    }
    const placement = Object.freeze({
      ownerId: record.id,
      name: record.name,
      offsetM: at.groundY,
      anchor,
      anchorMethod,
      method: 'inferred-rigid-development-canonical-ground-anchor',
      referenceElevationM: ground.manifest.grid.referenceElevationM,
      sourceGridSha256: ground.manifest.sha256,
      sourceIds: Object.freeze([...(record.sourceIds || [])]),
      status: record.status,
      verticalDatumConversion: false,
      frameFromMeasuredSource: false,
      absoluteFloorDatumVerified: false,
      architectureVerified: false,
      entranceFoundationReviewRequired: true,
      contourGround: {
        samples,
        maximumSpacingM: 5,
        missing,
        minimumM: Number.isFinite(minimum) ? minimum : null,
        maximumM: Number.isFinite(maximum) ? maximum : null,
        anchorOutsideSampledRange: at.groundY < minimum || at.groundY > maximum,
        scope:
          'Canonical ground at original contour vertices and at most 5m intervals; not interior extrema or surveyed floor/entry levels.',
      },
    });
    placements.set(record.id, placement);
    return placement;
  }
  const valid = (p) => placements.get(p?.ownerId) === p && Number.isFinite(p?.offsetM),
    shifted = (fn, p) => (x, z, body) => {
      const y = fn(x, z, body);
      return y == null ? y : y + p.offsetM;
    };
  function placeGeometry(geometry, p, role) {
    if (
      !valid(p) ||
      geometry.userData.structureGround ||
      geometry.userData.buildingGround ||
      geometry.userData.landmarkGround
    )
      throw new Error('Structure geometry requires exactly one declared placement');
    translateBuildingY(geometry, p.offsetM);
    geometry.userData = { ...geometry.userData, structureGround: p, structureGroundRole: role };
    stats.geometries++;
    stats.vertices += geometry.attributes.position.count;
    return geometry;
  }
  function placeCollider(c, p) {
    if (!valid(p) || c.structureGround || c.buildingGround || c.landmarkGround)
      throw new Error('Structure collider requires exactly one declared placement');
    const out = {
      ...c,
      height: c.height + p.offsetM,
      minHeight: (c.minHeight ?? 0) + p.offsetM,
      structureGround: p,
    };
    for (const key of ['heightAt', 'minHeightAt'])
      if (typeof c[key] === 'function') out[key] = shifted(c[key], p);
    stats.colliders++;
    return out;
  }
  function placeWalkSurface(s, p) {
    if (!valid(p) || s.structureGround)
      throw new Error('Walk surface requires exactly one declared placement');
    stats.walkSurfaces++;
    return { ...s, heightAt: shifted(s.heightAt, p), structureGround: p };
  }
  function placePhotographicGeometry(geometry, record) {
    const p = sourcePlacements.get(record.wallGeometryBuildingId || record.buildingId);
    if (!p) return geometry;
    placeGeometry(geometry, p, 'registered-source-photo');
    stats.photographicSurfaces++;
    return geometry;
  }
  return {
    source,
    site,
    placements,
    sourcePlacements,
    stats,
    supportStats: support.stats,
    sampleGround: support.sample,
    placementFor: (id) => sourcePlacements.get(id) || placements.get(id) || null,
    offsetFor: (id) => (sourcePlacements.get(id) || placements.get(id))?.offsetM ?? null,
    placeGeometry,
    placeCollider,
    placeWalkSurface,
    placePhotographicGeometry,
    disposeSampling: () => support.dispose(),
  };
}
