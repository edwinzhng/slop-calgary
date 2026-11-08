import * as THREE from 'three/webgpu';

const geometryOwners = new WeakMap();

export function createStaticCellDraws(mesh, parts, { onPass } = {}) {
  const geometry = mesh?.geometry,
    sourceCount = geometry?.index?.count ?? geometry?.attributes.position?.count;
  if (
    !mesh?.isMesh ||
    mesh.isInstancedMesh ||
    mesh.isBatchedMesh ||
    mesh.isSkinnedMesh ||
    !geometry?.isBufferGeometry ||
    Array.isArray(mesh.material) ||
    !Array.isArray(parts) ||
    !Number.isSafeInteger(sourceCount) ||
    sourceCount <= 0 ||
    sourceCount > 0xffffffff ||
    sourceCount % 3 !== 0 ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity ||
    (onPass !== undefined && typeof onPass !== 'function')
  )
    throw new Error('Invalid static cell draw configuration');
  if (geometryOwners.has(geometry)) throw new Error('Static cell draws require one geometry owner');
  let end = 0;
  for (const part of parts) {
    if (
      !part ||
      part.start !== end ||
      !Number.isSafeInteger(part.count) ||
      part.count <= 0 ||
      part.count % 3 !== 0 ||
      part.start + part.count > sourceCount ||
      !part.sphere?.isSphere ||
      !Number.isFinite(part.sphere.center.x) ||
      !Number.isFinite(part.sphere.center.y) ||
      !Number.isFinite(part.sphere.center.z) ||
      !Number.isFinite(part.sphere.radius) ||
      part.sphere.radius < 0
    )
      throw new Error('Invalid static cell triangle range or sphere');
    end += part.count;
  }
  if (end !== sourceCount) throw new Error('Static cells must cover every source triangle');

  const stride = geometry.index ? 5 : 4,
    commands = new Uint32Array(parts.length * stride),
    cells = parts.map(({ count, sphere }) => ({
      count,
      sphere: sphere.clone(),
      visible: true,
      shadowVisible: true,
    })),
    offsets = [],
    worldSphere = new THREE.Sphere(),
    projection = new THREE.Matrix4(),
    frustum = new THREE.Frustum(),
    shadowSelections = [],
    beforeRender = mesh.onBeforeRender,
    beforeShadow = mesh.onBeforeShadow,
    afterShadow = mesh.onAfterShadow,
    frustumCulled = mesh.frustumCulled,
    oldIndirect = geometry.indirect,
    oldIndirectOffset = geometry.indirectOffset;
  for (let i = 0; i < parts.length; i++) {
    const command = i * stride;
    commands[command] = parts[i].count;
    commands[command + 1] = 1;
    commands[command + 2] = parts[i].start;
    // Typed-array zeroes retain baseVertex and firstInstance for indexed draws,
    // or just firstInstance for nonindexed draws. No instance feature is needed.
  }
  const indirect = new THREE.IndirectStorageBufferAttribute(commands, 1),
    stats = {
      sourceTriangles: sourceCount / 3,
      currentDraws: 0,
      currentTriangles: 0,
    };
  let shadowDepth = 0,
    disposed = false;

  function select(camera, shadow = false) {
    if (camera) {
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth);
    }
    offsets.length = 0;
    let triangles = 0;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i].visible || (shadow && !cells[i].shadowVisible)) continue;
      worldSphere.copy(cells[i].sphere).applyMatrix4(mesh.matrixWorld);
      if (camera && !frustum.intersectsSphere(worldSphere)) continue;
      offsets.push(i * stride * Uint32Array.BYTES_PER_ELEMENT);
      triangles += cells[i].count / 3;
    }
    stats.currentDraws = offsets.length;
    stats.currentTriangles = triangles;
  }

  geometryOwners.set(geometry, mesh);
  geometry.setIndirect(indirect, offsets);
  select(null);
  // A view selecting no ranges must still reach later view and shadow hooks.
  mesh.frustumCulled = false;
  mesh.onBeforeRender = function (renderer, scene, camera, ...rest) {
    beforeRender.call(this, renderer, scene, camera, ...rest);
    if (disposed) return;
    select(camera, shadowDepth > 0);
    onPass?.({
      renderer,
      draws: stats.currentDraws,
      triangles: stats.currentTriangles,
      sourceTriangles: stats.sourceTriangles,
    });
  };
  mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera, ...rest) {
    beforeShadow.call(this, renderer, object, camera, shadowCamera, ...rest);
    if (disposed) return;
    const previous = (shadowSelections[shadowDepth] ??= { offsets: [], triangles: 0 });
    previous.offsets.length = offsets.length;
    for (let i = 0; i < offsets.length; i++) previous.offsets[i] = offsets[i];
    previous.triangles = stats.currentTriangles;
    shadowDepth++;
    select(shadowCamera, true);
  };
  mesh.onAfterShadow = function (...args) {
    try {
      afterShadow.apply(this, args);
    } finally {
      if (!disposed && shadowDepth) {
        restore(shadowSelections[--shadowDepth]);
      }
    }
  };

  function restore(previous) {
    offsets.length = previous.offsets.length;
    for (let i = 0; i < offsets.length; i++) offsets[i] = previous.offsets[i];
    stats.currentDraws = offsets.length;
    stats.currentTriangles = previous.triangles;
  }

  function beginFrame() {
    if (disposed || !shadowDepth) return;
    // Three skips onAfterShadow if a shadow render throws. Release abandoned
    // nesting before the next frame so pooled snapshots cannot accumulate.
    restore(shadowSelections[0]);
    shadowDepth = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    mesh.onBeforeRender = beforeRender;
    mesh.onBeforeShadow = beforeShadow;
    mesh.onAfterShadow = afterShadow;
    mesh.frustumCulled = frustumCulled;
    geometry.setIndirect(oldIndirect, oldIndirectOffset);
    geometryOwners.delete(geometry);
    offsets.length = 0;
    shadowSelections.length = 0;
    shadowDepth = 0;
  }
  return {
    stats,
    beginFrame,
    dispose,
    setShadowVisibleAt(index, visible) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= cells.length)
        throw new RangeError('Static shadow cell index is out of range');
      cells[index].shadowVisible = Boolean(visible);
    },
    setVisibleAt(index, visible) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= cells.length)
        throw new RangeError('Static cell index is out of range');
      cells[index].visible = Boolean(visible);
    },
  };
}
