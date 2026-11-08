import {
  Box3,
  Sphere,
  Vector3,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Material,
  NodeMaterial,
  Object3D,
  StaticDrawUsage,
} from 'three/webgpu';

// Only fill fresh bounds on an immutable position snapshot. Authored bounds may
// include shader displacement or a different indexed subset used by batching.
export function prepareFreshStaticBounds(geometry) {
  if (
    !geometry?.isBufferGeometry ||
    geometry.isInstancedBufferGeometry ||
    geometry.boundingBox !== null ||
    geometry.boundingSphere !== null ||
    geometry.computeBoundingBox !== BufferGeometry.prototype.computeBoundingBox ||
    geometry.computeBoundingSphere !== BufferGeometry.prototype.computeBoundingSphere ||
    Object.keys(geometry.morphAttributes).length
  )
    return false;
  const position = geometry.attributes.position;
  if (
    !position ||
    !(position.array instanceof Float32Array) ||
    position.itemSize !== 3 ||
    !Number.isSafeInteger(position.count) ||
    position.count < 1 ||
    position.count * 3 !== position.array.length ||
    position.normalized ||
    position.usage !== StaticDrawUsage ||
    position.isInterleavedBufferAttribute ||
    position.isInstancedBufferAttribute ||
    ![BufferAttribute, Float32BufferAttribute].includes(position.constructor) ||
    position.getX !== BufferAttribute.prototype.getX ||
    position.getY !== BufferAttribute.prototype.getY ||
    position.getZ !== BufferAttribute.prototype.getZ
  )
    return false;
  const array = position.array;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let at = 0; at < array.length; at += 3) {
    const x = array[at],
      y = array[at + 1],
      z = array[at + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  // Leave malformed data to Three's original diagnostics without changing it.
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return false;
  // Keep Box3.getCenter and Vector3.distanceToSquared's exact arithmetic order.
  const cx = (minX + maxX) * 0.5,
    cy = (minY + maxY) * 0.5,
    cz = (minZ + maxZ) * 0.5;
  let maxRadiusSq = 0;
  for (let at = 0; at < array.length; at += 3) {
    const dx = cx - array[at],
      dy = cy - array[at + 1],
      dz = cz - array[at + 2];
    maxRadiusSq = Math.max(maxRadiusSq, dx * dx + dy * dy + dz * dz);
  }
  geometry.boundingBox = new Box3(new Vector3(minX, minY, minZ), new Vector3(maxX, maxY, maxZ));
  geometry.boundingSphere = new Sphere(new Vector3(cx, cy, cz), Math.sqrt(maxRadiusSq));
  return true;
}

function ordinaryStaticOwner(object) {
  if (
    !object.isMesh ||
    object.isInstancedMesh ||
    object.isBatchedMesh ||
    object.isSkinnedMesh ||
    'boundingSphere' in object ||
    'boundingBox' in object ||
    object.onBeforeRender !== Object3D.prototype.onBeforeRender ||
    object.onAfterRender !== Object3D.prototype.onAfterRender ||
    object.onBeforeShadow !== Object3D.prototype.onBeforeShadow ||
    object.onAfterShadow !== Object3D.prototype.onAfterShadow
  )
    return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.every(
    (material) =>
      material &&
      !material.isShaderMaterial &&
      !material.positionNode &&
      !material.vertexNode &&
      !material.geometryNode &&
      !material.castShadowPositionNode &&
      !material.displacementMap &&
      !material.displacementNode &&
      (!material.isNodeMaterial ||
        (material.setupPosition === NodeMaterial.prototype.setupPosition &&
          material.setupVertex === NodeMaterial.prototype.setupVertex)) &&
      material.onBeforeRender === Material.prototype.onBeforeRender &&
      material.onBeforeCompile === Material.prototype.onBeforeCompile,
  );
}

export function prepareSceneBounds(scene) {
  const unsafe = new WeakSet(),
    attempted = new WeakSet();
  // A hidden or instanced owner can share geometry with a visible ordinary one.
  // Check every owner before preparing any geometry from the visible snapshot.
  scene.traverse((object) => {
    if (object.geometry && !ordinaryStaticOwner(object)) unsafe.add(object.geometry);
  });
  return (object) => {
    const geometry = object.geometry;
    if (!geometry || unsafe.has(geometry) || attempted.has(geometry) || !ordinaryStaticOwner(object))
      return false;
    attempted.add(geometry);
    return prepareFreshStaticBounds(geometry);
  };
}
