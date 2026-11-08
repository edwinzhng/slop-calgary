import * as THREE from 'three/webgpu';
import { treeWindBoundsPadding } from './reference-tree-material.js';

const geometryOwners = new WeakMap();

export function createIndirectCellDraws(
  mesh,
  { enabled = true, cellSize = 300, maxCells = 512, windPadding = 0, expandInstanceBounds } = {},
) {
  if (!enabled) return null;
  if (
    !mesh.isInstancedMesh ||
    !Number.isFinite(cellSize) ||
    cellSize <= 0 ||
    !Number.isFinite(windPadding) ||
    windPadding < 0 ||
    !Number.isSafeInteger(maxCells) ||
    maxCells < 1 ||
    Array.isArray(mesh.material) ||
    mesh.geometry.indirect ||
    mesh.geometry.drawRange.start !== 0 ||
    mesh.geometry.drawRange.count !== Infinity
  )
    throw new Error('Invalid vegetation cell draw configuration');
  if (geometryOwners.has(mesh.geometry)) throw new Error('Indirect draws require one geometry owner');
  geometryOwners.set(mesh.geometry, mesh);
  const geometry = mesh.geometry,
    stride = geometry.index ? 5 : 4,
    trianglesPerTree = (geometry.index?.count ?? geometry.attributes.position.count) / 3,
    indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array(maxCells * stride), 1),
    offsets = [],
    matrix = new THREE.Matrix4(),
    box = new THREE.Box3(),
    worldSphere = new THREE.Sphere(),
    frustum = new THREE.Frustum(),
    projection = new THREE.Matrix4();
  geometry.computeBoundingBox();
  geometry.setIndirect(indirect, offsets);
  const cells = [];
  const shadowCameras = [];
  let selectedCount = mesh.count,
    currentCamera = null;
  const stats = {
    enabled: true,
    cells: 0,
    selected: 0,
    visible: 0,
    draws: 0,
    commandBytes: indirect.array.byteLength,
    passes: 0,
  };

  function attributes() {
    return [
      ...new Set(
        [
          mesh.instanceMatrix,
          mesh.instanceColor,
          ...Object.values(geometry.attributes).filter((attribute) => attribute.isInstancedBufferAttribute),
        ].filter(Boolean),
      ),
    ];
  }

  function instanceBounds(slot, targetBox) {
    mesh.getMatrixAt(slot, matrix);
    targetBox.copy(geometry.boundingBox).applyMatrix4(matrix);
    expandInstanceBounds?.(mesh, slot, targetBox, matrix);
    return targetBox;
  }

  function repack({ instanceBounds: cachedBounds } = {}) {
    // The population writer resets count to the complete selected pool first.
    selectedCount = mesh.count;
    if (!enabled) return;
    const groups = new Map(),
      matrices = mesh.instanceMatrix.array;
    for (let i = 0; i < selectedCount; i++) {
      const x = matrices[i * 16 + 12],
        z = matrices[i * 16 + 14],
        key = `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    if (groups.size > maxCells) {
      disable();
      return;
    }
    const useCachedBounds = cachedBounds instanceof Float64Array && cachedBounds.length >= selectedCount * 6,
      order = new Uint32Array(selectedCount),
      seen = new Uint8Array(selectedCount),
      gpuSources = attributes(),
      sources = useCachedBounds ? [...gpuSources, { array: cachedBounds, itemSize: 6 }] : gpuSources,
      scratch = sources.map((attribute) => new attribute.array.constructor(attribute.itemSize));
    cells.length = 0;
    let at = 0;
    for (const [key, instances] of groups) {
      cells.push({
        key,
        first: at,
        count: instances.length,
        box: new THREE.Box3(),
        sphere: new THREE.Sphere(),
      });
      order.set(instances, at);
      at += instances.length;
    }
    for (let first = 0; first < selectedCount; first++) {
      if (seen[first]) continue;
      for (let a = 0; a < sources.length; a++) {
        const { array, itemSize } = sources[a];
        scratch[a].set(array.subarray(first * itemSize, (first + 1) * itemSize));
      }
      let target = first;
      for (;;) {
        seen[target] = 1;
        const source = order[target];
        for (let a = 0; a < sources.length; a++) {
          const { array, itemSize } = sources[a];
          if (source === first) array.set(scratch[a], target * itemSize);
          else array.copyWithin(target * itemSize, source * itemSize, (source + 1) * itemSize);
        }
        if (source === first) break;
        target = source;
      }
    }
    for (const source of gpuSources) {
      source.clearUpdateRanges();
      if (selectedCount) source.addUpdateRange(0, selectedCount * source.itemSize);
      source.needsUpdate = selectedCount > 0;
    }
    cells.forEach((cell, ci) => {
      for (let i = cell.first; i < cell.first + cell.count; i++) {
        if (useCachedBounds) {
          box.min.fromArray(cachedBounds, i * 6);
          box.max.fromArray(cachedBounds, i * 6 + 3);
        } else instanceBounds(i, box);
        cell.box.union(box);
      }
      cell.box.expandByScalar(windPadding);
      cell.box.getBoundingSphere(cell.sphere);
      const command = ci * stride;
      indirect.array[command] = geometry.index?.count ?? geometry.attributes.position.count;
      indirect.array[command + 1] = cell.count;
      indirect.array[command + 2] = 0;
      if (geometry.index) indirect.array[command + 3] = 0;
      indirect.array[command + stride - 1] = cell.first;
    });
    indirect.clearUpdateRanges();
    if (cells.length) indirect.addUpdateRange(0, cells.length * stride);
    indirect.needsUpdate = cells.length > 0;
    Object.assign(stats, { cells: cells.length, selected: selectedCount });
    select(null);
  }

  // Fixed GPU commands retain every cell. Each pass only selects CPU offsets,
  // so a head turn never rewrites matrices, colors, tree attributes or commands.
  function select(camera) {
    if (!enabled) {
      mesh.count = selectedCount;
      return selectedCount;
    }
    currentCamera = camera;
    if (camera) {
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth);
    }
    offsets.length = 0;
    let visible = 0;
    for (let i = 0; i < cells.length; i++) {
      worldSphere.copy(cells[i].sphere).applyMatrix4(mesh.matrixWorld);
      if (camera && !frustum.intersectsSphere(worldSphere)) continue;
      offsets.push(i * stride * Uint32Array.BYTES_PER_ELEMENT);
      visible += cells[i].count;
    }
    // Keep visible based on selected records, so a zero-count view does not
    // prevent a different view or the shadow pass from reaching this callback.
    mesh.count = visible;
    Object.assign(stats, {
      visible,
      draws: offsets.length,
      passes: stats.passes + 1,
    });
    return visible;
  }

  const beforeRender = mesh.onBeforeRender,
    beforeShadow = mesh.onBeforeShadow,
    afterShadow = mesh.onAfterShadow,
    frustumCulled = mesh.frustumCulled;
  mesh.onBeforeRender = function (renderer, scene, camera, ...rest) {
    beforeRender.call(this, renderer, scene, camera, ...rest);
    if (!shadowCameras.length) select(camera);
    const render = renderer?.info?.render;
    if (render) {
      render.drawCalls += offsets.length;
      render.triangles += trianglesPerTree * mesh.count;
    }
  };
  mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera, ...rest) {
    beforeShadow.call(this, renderer, object, camera, shadowCamera, ...rest);
    shadowCameras.push(currentCamera);
    select(shadowCamera);
  };
  mesh.onAfterShadow = function (...args) {
    try {
      afterShadow.apply(this, args);
    } finally {
      // A light render can interrupt the pending view or another light pass.
      // Restore its ranges before the interrupted draw resumes.
      if (shadowCameras.length) select(shadowCameras.pop());
    }
  };
  // Keep callbacks reachable after a previous view selected zero instances.
  mesh.frustumCulled = false;
  function disable() {
    enabled = false;
    stats.enabled = false;
    geometry.setIndirect(null);
    mesh.count = selectedCount;
    offsets.length = 0;
    shadowCameras.length = 0;
    currentCamera = null;
    mesh.onBeforeRender = beforeRender;
    mesh.onBeforeShadow = beforeShadow;
    mesh.onAfterShadow = afterShadow;
    mesh.frustumCulled = frustumCulled;
    geometryOwners.delete(geometry);
  }
  return { repack, instanceBounds, select, cells, stats, indirect, offsets, disable };
}

export function treeBoundsExpansion(mesh) {
  const position = mesh.geometry.attributes.position,
    tree = mesh.geometry.attributes.aTree,
    point = new THREE.Vector3(),
    bark = [];
  if (tree) {
    for (let i = 0; i < position.count; i++) {
      const weight = 1 - tree.getX(i);
      if (weight) bark.push({ x: position.getX(i), y: position.getY(i), z: position.getZ(i), weight });
    }
    bark.sort((a, b) => a.y - b.y);
  }
  const windPadding = treeWindBoundsPadding(mesh.geometry);
  const expandInstanceBounds = mesh.geometry.attributes.aTreeShape
    ? (owner, slot, bounds, matrix) => {
        const shape = owner.geometry.attributes.aTreeShape,
          correction = shape.getX(slot),
          vertical = shape.getY(slot);
        if (correction === 1) return;
        for (const { x, y, z, weight } of bark) {
          const t = Math.max(0, (y * vertical - 1.8) / 1.4);
          // The shader only corrects low bark. Higher branches already fit
          // inside the transformed model bounds.
          if (t >= 1) break;
          const scale = 1 + (correction - 1) * (weight * (1 - t * t * (3 - 2 * t)));
          point.set(x * scale, y, z * scale).applyMatrix4(matrix);
          bounds.expandByPoint(point);
        }
      }
    : undefined;
  return { windPadding, expandInstanceBounds };
}
