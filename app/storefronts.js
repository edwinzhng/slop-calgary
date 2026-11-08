import { inside, nearestOnSegment, SpatialIndex, unproject } from './geo.js';
import { createStorefrontAppearance, STOREFRONT_LIMIT } from './storefront-appearance.js';

export function bindStorefront(place, world, stats) {
  let best = null;
  for (const b of world.buildingIndex.near(place.x, place.z, 45)) {
    if (
      !b.id ||
      b.storefrontAnchor === false ||
      b.type === 'bridge-guardrail' ||
      b.type === 'park-furniture' ||
      b.height < 4 ||
      /garage|shed|roof|carport/.test(b.kind)
    )
      continue;
    const contains = inside(place.x, place.z, b.ring);
    for (let i = 1; i < b.ring.length; i++) {
      const a = b.ring[i - 1],
        c = b.ring[i],
        dx = c[0] - a[0],
        dz = c[1] - a[1],
        length = Math.hypot(dx, dz);
      if (length < 4) continue;
      const p = nearestOnSegment(place.x, place.z, a, c);
      if (stats) stats.candidateEdges++;
      // Street distance is nonnegative: this lower bound cannot hide a winner.
      const lowerBound = (contains ? -35 : 0) + p.distance * 0.6;
      if (p.distance >= 45 || (best && lowerBound >= best.score)) {
        if (stats) stats.prunedEdges++;
        continue;
      }
      let nx = -dz / length,
        nz = dx / length;
      if (inside(p.x + nx * 0.3, p.z + nz * 0.3, b.ring)) {
        nx *= -1;
        nz *= -1;
      }
      const road = world.roadIndex.nearest(p.x + nx * 3, p.z + nz * 3, true, 80, true);
      if (stats) stats.roadQueries++;
      const score = lowerBound + Math.min(road?.distance ?? 80, 80) * 0.7;
      if (p.distance < 45 && (!best || score < best.score))
        best = { place, b, score, a, c, length, nx, nz, edge: i, t: p.t, x: p.x, z: p.z };
    }
  }
  return best;
}

export function layoutStorefrontEdge(stores) {
  if (!stores.length) return { records: [], facades: [] };
  const length = stores[0].length,
    margin = 0.3,
    gap = 0.6,
    minWidth = 3.4,
    tolerance = Number.EPSILON * length * 16,
    capacity = Math.min(4, Math.max(1, Math.floor(length / 5))),
    records = [...stores]
      .sort((a, b) => a.score - b.score || (a.place.id < b.place.id ? -1 : a.place.id > b.place.id ? 1 : 0))
      .slice(0, capacity),
    selected = [];
  // POIs estimate positions, not surveyed doors. Crowded and endpoint pins keep
  // their destinations without moving signs or inventing overlapping entrances.
  for (const s of records) {
    if (s.place.kind === 'marketplace') continue;
    const center = s.t * length;
    // Reversing the source edge must not change a borderline bay's eligibility.
    if (Math.min(center, length - center) < margin + minWidth / 2 - tolerance) continue;
    if (selected.some((other) => Math.abs(center - other.center) < minWidth + gap - tolerance)) continue;
    selected.push({ s, center });
  }
  selected.sort((a, b) => a.center - b.center);
  const facades = selected.map(({ s, center }, i) => {
    const halfWidth = Math.min(
      4,
      center - margin,
      length - margin - center,
      i ? (center - selected[i - 1].center - gap) / 2 : Infinity,
      i + 1 < selected.length ? (selected[i + 1].center - center - gap) / 2 : Infinity,
    );
    return { ...s, width: halfWidth * 2 };
  });
  return { records, facades };
}

export function createStorefronts(scene, world, places) {
  const groups = new Map(),
    stats = { candidateEdges: 0, prunedEdges: 0, roadQueries: 0 };
  for (const p of places) {
    if (Number(p.level) > 0) continue;
    const s = bindStorefront(p, world, stats);
    if (!s) continue;
    const key = `${s.b.id}/${s.edge}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const records = [],
    facadeRecords = [];
  for (const key of [...groups.keys()].sort()) {
    const layout = layoutStorefrontEdge(groups.get(key));
    records.push(...layout.records);
    if (!world.authoredStorefrontBuildingIds?.has(layout.records[0].b.id))
      facadeRecords.push(
        ...layout.facades.filter(({ place }) => !world.authoredStorefrontPlaceIds?.has(place.id)),
      );
  }
  const index = new SpatialIndex(90);
  for (const facade of facadeRecords) {
    const { x, z } = facade;
    index.insert(facade, { minX: x, maxX: x, minZ: z, maxZ: z });
  }
  const appearance = createStorefrontAppearance(scene);
  const active = new Map();
  const available = Array.from({ length: STOREFRONT_LIMIT }, (_, i) => STOREFRONT_LIMIT - i - 1);
  const rendering = { eligible: facadeRecords.length, active: 0, triangles: 0, atlasBytes: 0, rebuilds: 0 };
  const destinations = records.map((s) => {
    // A mapped market may be seasonal or outdoors. Keep its cached POI location
    // rather than presenting an inferred building entrance as its venue.
    const [lon, lat] =
      s.place.kind === 'marketplace'
        ? unproject(s.place.x, s.place.z)
        : unproject(s.x + s.nx * 7, s.z + s.nz * 7);
    return {
      name: s.place.name,
      sub: s.place.address || s.place.kind,
      lon,
      lat,
      bearing: Math.atan2(-s.nx, -s.nz),
      business: true,
    };
  });
  world.businessPlaces = destinations;
  return {
    count: records.length,
    facadeCount: facadeRecords.length,
    stats,
    destinations,
    rendering,
    update(camera, quality) {
      const { x, y, z } = camera.position;
      const near =
        y < 180
          ? [...index.near(x, z, 180)]
              .map((s) => ({ s, d: Math.hypot(s.x - x, s.z - z), retained: active.has(s.place.id) }))
              .filter(({ d, retained }) => d < (retained ? 180 : 168))
              .sort((a, b) => a.d - b.d + (Number(b.retained) - Number(a.retained)) * 8)
              .slice(0, quality === 'high' ? STOREFRONT_LIMIT : 24)
              .map(({ s }) => s)
          : [];
      const ids = new Set(near.map((s) => s.place.id));
      let changed = false;
      let painted = false;
      for (const [id, item] of active) {
        if (ids.has(id)) continue;
        item.geometry.dispose();
        available.push(item.slot);
        active.delete(id);
        changed = true;
      }
      for (const s of near) {
        if (active.has(s.place.id)) continue;
        const slot = available.pop();
        const y = world.groundHeight?.(s.x + s.nx * 0.34, s.z + s.nz * 0.34, 0.2) ?? 0.2;
        const geometry = appearance.create(s, slot, y);
        active.set(s.place.id, { geometry, slot });
        changed = painted = true;
      }
      if (!changed) return;
      rendering.active = active.size;
      rendering.triangles = appearance.update(
        [...active.values()].map((item) => item.geometry),
        painted,
      );
      rendering.atlasBytes = appearance.atlasBytes;
      rendering.rebuilds++;
    },
  };
}
