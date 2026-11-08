import * as THREE from 'three/webgpu';
import source from '../data/SUNNYSIDE_FLOOD_BARRIER_SEGMENT.json' with { type: 'json' };
import { bounds } from './geo.js';
import { surfaceMaterial } from './materials.js';

export const SUNNYSIDE_BARRIER_BUILDING_ID = 'city-outline-25651-0';

function sameJSON(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(b);
  return (
    Object.keys(a).length === keys.length && keys.every((k) => Object.hasOwn(a, k) && sameJSON(a[k], b[k]))
  );
}

/** One inspected construction corridor, never a generic no-roof suppression. */
export function prepareSunnysideBarrier(data, enrichment = {}) {
  const building = data.buildings?.find((b) => b.id === SUNNYSIDE_BARRIER_BUILDING_ID);
  const reject = (reason) => ({ accepted: false, reason });
  if (!building) return reject('Source construction outline is absent');
  if (!sameJSON(building, source.building)) return reject('Source construction outline changed');
  const ground = enrichment.surfaceData;
  if (
    !ground ||
    !sameJSON(
      Object.fromEntries(Object.keys(source.groundSource).map((k) => [k, ground.meta?.[k]])),
      source.groundSource,
    )
  )
    return reject('Municipal ground source changed or is unavailable');
  const records = ground.surfaces?.filter((p) => p.id === source.groundRecord.id) || [];
  if (records.length !== 1 || !sameJSON(records[0], source.groundRecord))
    return reject('Reviewed municipal pavement changed or is unavailable');
  const id = building.id;
  if (
    enrichment.cityMeshes?.has(id) ||
    enrichment.cityMeshes?.get(id) ||
    enrichment.fallbackBuildings?.hasGeometry(id) ||
    enrichment.haydenBlock?.hasGeometry(id) ||
    enrichment.partialBuildings?.hasGeometry(id) ||
    enrichment.measuredRoofs?.get(id)
  )
    return reject('A stronger building or roof provider takes precedence');
  return {
    accepted: true,
    building,
    wall: source.wall,
    evidence: source.evidence,
    evidenceSha256: source.evidenceSha256,
    vegetationExclusion: building,
  };
}

/** Authored height/section on the retained City plan and existing terrain datum. */
export function buildSunnysideBarrier(scene, plan, { terrain } = {}) {
  if (!plan.accepted)
    return { accepted: false, stats: { accepted: false, reason: plan.reason }, update() {} };
  const wall = plan.wall,
    shape = new THREE.Shape(wall.ring.map(([x, z]) => new THREE.Vector2(x, -z))),
    base = (x, z) => 0.14 + (terrain?.offsetAt(x, z) || 0);
  let geometry = new THREE.ExtrudeGeometry(shape, {
    depth: wall.heightM,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0.14, 0);
  if (terrain) geometry = terrain.drapeGeometry(geometry, wall.maximumDrapePieceM);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, surfaceMaterial('concrete'));
  mesh.name = 'Sunnyside flood barrier: authored concrete wall';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.sourceBuildingId = plan.building.id;
  mesh.userData.dimensionsMeasured = false;
  scene.add(mesh);
  const box = bounds(wall.ring),
    collider = {
      id: 'sunnyside-flood-wall-25651',
      type: 'flood-wall',
      ring: wall.ring,
      minHeight: geometry.boundingBox.min.y - 0.02,
      height: geometry.boundingBox.max.y,
      minHeightAt: (x, z) => base(x, z) - 0.02,
      heightAt: (x, z) => base(x, z) + wall.heightM,
      inferredDimensions: true,
      storefrontAnchor: false,
    },
    x = (box.minX + box.maxX) / 2,
    z = (box.minZ + box.maxZ) / 2;
  return {
    accepted: true,
    mesh,
    colliders: [collider],
    stats: {
      accepted: true,
      sourceBuildingId: plan.building.id,
      sourceRecordRetained: true,
      estimatedBuildingHeightRemovedM: plan.building.height,
      sourceFootprintAreaM2: wall.sourceFootprintAreaM2,
      wallFootprintAreaM2: wall.footprintAreaM2,
      authoredWallHeightM: wall.heightM,
      authoredWallWidthM: wall.widthM,
      dimensionsMeasured: false,
      triangles: (geometry.index?.count ?? geometry.attributes.position.count) / 3,
      drawCalls: 1,
      texturesAdded: 0,
      pointLightsAdded: 0,
      existingPavingAndRoadsRetained: true,
      previousVegetationExclusionRetained: true,
      currentAccessVerified: false,
      sourceGameCompared: false,
    },
    update(camera, quality = 'balanced') {
      mesh.visible =
        Math.hypot(camera.position.x - x, camera.position.z - z) < (quality === 'high' ? 6500 : 4800);
    },
  };
}
