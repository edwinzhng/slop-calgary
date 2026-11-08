import * as THREE from 'three/webgpu';
import { bounds, SpatialIndex } from './geo.js';
import { surfaceMaterial } from './materials.js';
import { parkPavingFinish, exactParkPavingKey, PARK_AGGREGATE_FINISHES } from './park-finishes.js';
import { createStaticPolygonQueries, containsPreparedPolygon } from './polygon-queries.js';
import { createLinearPolygonGeometry } from './linear-polygon-geometry.js';
import { addStaticBatches, mergeStaticGeometries, setStaticBatchPartVisible } from './static-batches.js';

export function createParks(scene, data, { terrain, cutSurface } = {}) {
  const groups = new Map(),
    polygonQueries = createStaticPolygonQueries(),
    meshes = [],
    pavingKeys = new Set(),
    supportIndex = new SpatialIndex(100),
    siteIndex = new SpatialIndex(180);
  let duplicatePavingPolygons = 0,
    finishRefinements = 0;
  for (const p of data.mapParks || [])
    if (p.name) siteIndex.insert({ polygon: p, prepared: polygonQueries.preparePolygon(p) }, bounds(p.ring));
  for (const p of [...(data.ground || []), ...(data.paving || [])]) {
    const b = bounds(p.ring),
      x = (b.minX + b.maxX) / 2,
      z = (b.minZ + b.maxZ) / 2;
    const ground = ['turf', 'natural', 'park-ground'].includes(p.kind);
    supportIndex.insert(
      { polygon: p, box: b, y: ground ? 0.045 : 0.138, ground, prepared: polygonQueries.preparePolygon(p) },
      b,
    );
    const kind = ground ? p.kind : parkPavingFinish(p);
    if (kind !== p.kind) finishRefinements++;
    const sourceKey = ground ? null : exactParkPavingKey(p);
    if (sourceKey !== null) {
      if (pavingKeys.has(sourceKey)) {
        duplicatePavingPolygons++;
        continue;
      }
      pavingKeys.add(sourceKey);
    }
    // Artificial turf is still paving at its original height, separate from lawn.
    const aggregate = PARK_AGGREGATE_FINISHES[kind],
      batchKind = aggregate ? 'park-aggregate' : kind,
      key = `${ground ? 'ground' : 'paving'}/${batchKind}/${Math.floor(x / 800)},${Math.floor(z / 800)}`;
    if (!groups.has(key)) groups.set(key, { kind: batchKind, ground, x, z, geos: [] });
    const source = createLinearPolygonGeometry(p, ground ? 0.045 : 0.138);
    const flat = cutSurface?.(source) || source;
    const geometry = terrain?.drapeGeometry(flat) || flat;
    if (aggregate) {
      // Packed linear colour + roughness cost four bytes per vertex. Apply after
      // terrain subdivision so every emitted vertex has the same attribute schema.
      const count = geometry.attributes.position.count,
        rgba = [...new THREE.Color(aggregate[0]).toArray(), aggregate[1]].map((v) => Math.round(v * 255)),
        finish = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) finish.set(rgba, i * 4);
      // One unorm8x4 attribute is valid on both backends without upload padding.
      geometry.setAttribute('parkFinish', new THREE.BufferAttribute(finish, 4, true));
    }
    groups.get(key).geos.push(geometry);
  }
  let triangles = 0;
  const batches = new Map(),
    renderMeshes = [];
  for (const group of groups.values()) {
    const geometry = mergeStaticGeometries(group.geos);
    for (const g of group.geos) g.dispose();
    const key = `${group.ground}/${group.kind}`;
    if (!batches.has(key))
      batches.set(key, { kind: group.kind, ground: group.ground, pieces: [], items: [] });
    const batch = batches.get(key);
    batch.pieces.push(geometry);
    batch.items.push({ x: group.x, z: group.z });
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
  }
  for (const { kind, ground, pieces, items } of batches.values()) {
    const mesh = addStaticBatches(scene, pieces, surfaceMaterial(kind), `Surveyed Calgary park ${kind}`);
    mesh.userData.parkGround = ground;
    renderMeshes.push(mesh);
    for (let index = 0; index < items.length; index++) meshes.push({ mesh, index, ...items[index] });
  }
  return {
    nameAt(x, z) {
      for (const p of siteIndex.near(x, z))
        if (containsPreparedPolygon(x, z, p.polygon, p.prepared)) return p.polygon.name;
      return null;
    },
    groundHeight(x, z, pavingOnly = false) {
      let height = null;
      for (const p of supportIndex.near(x, z))
        if (
          (!pavingOnly || !p.ground) &&
          x >= p.box.minX &&
          x <= p.box.maxX &&
          z >= p.box.minZ &&
          z <= p.box.maxZ &&
          containsPreparedPolygon(x, z, p.polygon, p.prepared)
        )
          height = Math.max(height ?? -Infinity, p.y);
      return height == null ? null : height + (terrain?.offsetAt(x, z) || 0);
    },
    stats: {
      parkPolygonQueries: polygonQueries.stats,
      parkGroundPolygons: data.ground?.length || 0,
      parkPavingPolygons: data.paving?.length || 0,
      parkDuplicatePavingPolygons: duplicatePavingPolygons,
      parkPavingFinishRefinements: finishRefinements,
      parkMeshes: renderMeshes.length,
      parkTriangles: triangles,
    },
    update(camera, quality) {
      const radius = quality === 'high' ? 7000 : 5200;
      for (const item of meshes)
        setStaticBatchPartVisible(
          item.mesh,
          item.index,
          Math.hypot(camera.position.x - item.x, camera.position.z - item.z) < radius,
        );
    },
    dispose() {
      for (const mesh of renderMeshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
    },
  };
}
