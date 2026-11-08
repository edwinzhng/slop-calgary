import * as THREE from 'three/webgpu';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, createLoftedCarMaterial } from '../js/cars.js';

// Keep the full body nearby and use the reference's matching distant silhouette.
// The simulation and collision bodies stay independent of these render meshes.
export function createCarInstances(
  scene,
  { name, capacity, castShadow = true, receiveShadow = true, frustumCulled = true },
) {
  const byModel = {};
  for (const model of ['sedan', 'pickup']) {
    const spec = BODY_SPECS[model],
      material = createLoftedCarMaterial(spec);
    byModel[model] = [buildCarGeometry(spec), buildCarProxyGeometry(spec)].map((geometry, index) => {
      geometry.setAttribute(
        'paintColor',
        new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
      );
      geometry.setAttribute(
        'carState',
        new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
      );
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = `${name} / ${model} / ${index ? 'distant' : 'nearby'}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.frustumCulled = frustumCulled;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    });
  }
  // Keep the original traffic collision body and parking footprint. The pickup
  // keeps its taller cab and bed, scaled to fit the existing lanes and stalls.
  const pickupScale = new THREE.Vector3(0.88, 0.82, 0.78),
    pickupMatrix = new THREE.Matrix4(),
    meshes = [...byModel.sedan, ...byModel.pickup],
    previous = new Map(),
    seen = new Set(),
    stats = { nearby: 0, distant: 0, pickups: 0, triangles: 0 };
  let threshold = 100,
    total = 0;
  return {
    meshes,
    stats,
    begin(quality = 'balanced', nearDistance) {
      threshold = nearDistance ?? (quality === 'high' ? 150 : quality === 'performance' ? 40 : 100);
      seen.clear();
      total = 0;
      for (const mesh of meshes) mesh.count = 0;
    },
    add(id, matrix, paint, distance, brake = 0, right = 0, left = 0, style = 0, model = 'sedan') {
      const old = previous.get(id),
        distant = distance > threshold + (old === undefined ? 0 : old ? -8 : 8),
        mesh = byModel[model][Number(distant)],
        slot = mesh.count;
      if (total >= capacity) return false;
      previous.set(id, distant);
      seen.add(id);
      mesh.setMatrixAt(slot, model === 'pickup' ? pickupMatrix.copy(matrix).scale(pickupScale) : matrix);
      mesh.geometry.attributes.paintColor.setXYZ(slot, paint.r, paint.g, paint.b);
      mesh.geometry.attributes.carState.setXYZW(slot, brake, right, left, style);
      mesh.count++;
      total++;
      return true;
    },
    end() {
      for (const id of previous.keys()) if (!seen.has(id)) previous.delete(id);
      stats.nearby = byModel.sedan[0].count + byModel.pickup[0].count;
      stats.distant = total - stats.nearby;
      stats.pickups = byModel.pickup[0].count + byModel.pickup[1].count;
      stats.triangles = 0;
      for (const mesh of meshes) {
        if (!mesh.count) continue;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.paintColor.needsUpdate = true;
        mesh.geometry.attributes.carState.needsUpdate = true;
        if (frustumCulled) mesh.computeBoundingSphere();
        stats.triangles +=
          ((mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3) * mesh.count;
      }
    },
  };
}
