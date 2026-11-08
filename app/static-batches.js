import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createStaticCellDraws } from './static-cell-draws.js';

const sceneConfigurations = new WeakMap(),
  visibilityWriters = new WeakMap(),
  shadowVisibilityWriters = new WeakMap();

export function setStaticBatchPartVisible(mesh, index, visible) {
  const writer = visibilityWriters.get(mesh);
  if (writer) writer(index, visible);
  else if (mesh.isBatchedMesh) mesh.setVisibleAt(index, visible);
  else if (index === 0) mesh.visible = Boolean(visible);
  else throw new RangeError('Static mesh has only one part');
}

export function setStaticBatchPartShadowVisible(mesh, index, visible) {
  const writer = shadowVisibilityWriters.get(mesh);
  if (writer) writer(index, visible);
  else if (index === 0 && !mesh.isBatchedMesh) mesh.castShadow = Boolean(visible);
  else throw new RangeError('Per-part shadow selection requires static indirect cells');
}

export function configureStaticBatches(scene, { indirectDraws = false } = {}) {
  let configuration = sceneConfigurations.get(scene);
  if (!configuration) {
    const controllers = new Set(),
      stats = { groups: 0, parts: 0, indirectDrawCalls: 0, indirectTriangles: 0 },
      beginFrame = () => {
        for (const controller of controllers) controller.beginFrame();
        stats.indirectDrawCalls = 0;
        stats.indirectTriangles = 0;
      };
    configuration = { controllers, stats, api: { stats, beginFrame } };
    sceneConfigurations.set(scene, configuration);
  }
  configuration.indirectDraws = indirectDraws === true;
  return configuration.api;
}

// A uniform index layout can merge directly. Expanding it first duplicates
// shared road/river vertices and their shader attributes for every triangle.
export function mergeStaticGeometries(geometries, { preserveIndices = true } = {}) {
  const indexed = Boolean(geometries[0]?.index);
  if ((!indexed || preserveIndices) && geometries.every((geometry) => Boolean(geometry.index) === indexed))
    return mergeGeometries(geometries, false);
  const sources = geometries.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  try {
    return mergeGeometries(sources, false);
  } finally {
    for (let i = 0; i < sources.length; i++) if (sources[i] !== geometries[i]) sources[i].dispose();
  }
}

function attachStaticMesh(scene, mesh, name, castShadow) {
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false;
  return mesh;
}

// Source primitives remain intact, including paint phase, side offsets and
// winding. A cell boundary only changes which complete primitives are culled.
export function splitGeometryByPrimitives(geometry, cellSize = 1000, verticesPerPrimitive = 4) {
  const position = geometry.attributes.position,
    index = geometry.index,
    attributes = Object.entries(geometry.attributes),
    count = position?.count;
  if (
    !(cellSize > 0 && Number.isFinite(cellSize)) ||
    !Number.isSafeInteger(verticesPerPrimitive) ||
    verticesPerPrimitive < 3 ||
    !Number.isSafeInteger(count) ||
    count % verticesPerPrimitive ||
    position.itemSize !== 3 ||
    geometry.groups.length ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity ||
    Object.keys(geometry.morphAttributes).length ||
    attributes.some(
      ([, attribute]) =>
        attribute.isInterleavedBufferAttribute ||
        attribute.isInstancedBufferAttribute ||
        attribute.count !== count,
    )
  )
    throw new Error('Static spatial batches require complete, contiguous source primitives');
  if (!count) return [];
  const primitiveCount = count / verticesPerPrimitive,
    indicesPerPrimitive = index ? index.count / primitiveCount : 0;
  if (
    index
      ? !Number.isSafeInteger(indicesPerPrimitive) || indicesPerPrimitive < 3 || indicesPerPrimitive % 3
      : verticesPerPrimitive % 3
  )
    throw new Error('Static spatial batch indices must contain complete source triangles');
  const cells = new Map();
  for (let primitive = 0; primitive < primitiveCount; primitive++) {
    const first = primitive * verticesPerPrimitive;
    let minX = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxZ = -Infinity;
    for (let vertex = first; vertex < first + verticesPerPrimitive; vertex++) {
      const x = position.getX(vertex),
        y = position.getY(vertex),
        z = position.getZ(vertex);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
        throw new Error('Static spatial batch positions must be finite');
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    for (let i = primitive * indicesPerPrimitive; i < (primitive + 1) * indicesPerPrimitive; i++) {
      const vertex = index.getX(i);
      if (!Number.isSafeInteger(vertex) || vertex < first || vertex >= first + verticesPerPrimitive)
        throw new Error('Static spatial batch indices must stay inside their source primitive');
    }
    const key = `${Math.floor((minX + maxX) / 2 / cellSize)},${Math.floor((minZ + maxZ) / 2 / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(primitive);
  }
  if (cells.size === 1) return [geometry];
  return [...cells.values()].map((primitives) => {
    const piece = new THREE.BufferGeometry();
    piece.name = geometry.name;
    piece.userData = { ...geometry.userData };
    for (const [name, source] of attributes) {
      const array = new source.array.constructor(primitives.length * verticesPerPrimitive * source.itemSize);
      primitives.forEach((primitive, slot) => {
        const start = primitive * verticesPerPrimitive * source.itemSize;
        array.set(
          source.array.subarray(start, start + verticesPerPrimitive * source.itemSize),
          slot * verticesPerPrimitive * source.itemSize,
        );
      });
      const attribute = new source.constructor(array, source.itemSize, source.normalized);
      attribute.name = source.name;
      attribute.setUsage(source.usage);
      attribute.gpuType = source.gpuType;
      attribute.onUpload(source.onUploadCallback);
      piece.setAttribute(name, attribute);
    }
    if (index) {
      const array = new index.array.constructor(primitives.length * indicesPerPrimitive);
      primitives.forEach((primitive, slot) => {
        for (let i = 0; i < indicesPerPrimitive; i++)
          array[slot * indicesPerPrimitive + i] =
            index.getX(primitive * indicesPerPrimitive + i) + (slot - primitive) * verticesPerPrimitive;
      });
      piece.setIndex(new THREE.BufferAttribute(array, 1));
    }
    return piece;
  });
}

export function addSpatialBatches(
  scene,
  geometry,
  material,
  name,
  { cellSize = 1000, verticesPerPrimitive = 4, expandBounds } = {},
) {
  const pieces = splitGeometryByPrimitives(geometry, cellSize, verticesPerPrimitive);
  if (!pieces.length) return attachStaticMesh(scene, new THREE.Mesh(geometry, material), name, false);
  for (const piece of pieces) expandBounds?.(piece);
  const mesh = addStaticBatches(scene, pieces, material, name);
  if (pieces[0] !== geometry) geometry.dispose();
  return mesh;
}

function staticCellParts(pieces) {
  const first = pieces[0],
    indexed = Boolean(first.index),
    names = Object.keys(first.attributes),
    parts = [],
    bounds = new THREE.Box3(),
    sphere = new THREE.Sphere(),
    point = new THREE.Vector3(),
    identity = new THREE.Matrix4();
  let start = 0;
  for (const geometry of pieces) {
    const position = geometry.attributes.position,
      index = geometry.index,
      count = index?.count ?? position.count;
    if (
      !geometry.isBufferGeometry ||
      geometry.isInstancedBufferGeometry ||
      Boolean(index) !== indexed ||
      geometry.indirect ||
      geometry.groups.length ||
      geometry.drawRange.start !== 0 ||
      geometry.drawRange.count !== Infinity ||
      Object.keys(geometry.morphAttributes).length ||
      geometry.morphTargetsRelative !== first.morphTargetsRelative ||
      !Number.isSafeInteger(position.count) ||
      position.itemSize !== 3 ||
      position.normalized ||
      !(position.array instanceof Float32Array) ||
      !Number.isSafeInteger(count) ||
      count < 3 ||
      count % 3 ||
      start + count > 0xffffffff ||
      Object.keys(geometry.attributes).length !== names.length ||
      names.some((name) => {
        const attribute = geometry.attributes[name],
          source = first.attributes[name];
        return (
          !attribute?.isBufferAttribute ||
          attribute.isInterleavedBufferAttribute ||
          attribute.isInstancedBufferAttribute ||
          attribute.isFloat16BufferAttribute ||
          attribute.count !== position.count ||
          attribute.usage !== THREE.StaticDrawUsage ||
          attribute.array.constructor !== source.array.constructor ||
          attribute.itemSize !== source.itemSize ||
          attribute.normalized !== source.normalized ||
          attribute.gpuType !== source.gpuType
        );
      }) ||
      (index &&
        (index.itemSize !== 1 ||
          index.normalized ||
          !(index.array instanceof Uint16Array || index.array instanceof Uint32Array) ||
          index.getX !== THREE.BufferAttribute.prototype.getX))
    )
      return null;
    const box = geometry.boundingBox?.clone() || new THREE.Box3(),
      partSphere = geometry.boundingSphere?.clone() || new THREE.Sphere();
    // BatchedMesh bounds visit referenced vertices, retaining authored boxes
    // and spheres. Unused allocation vertices must not enlarge these cells.
    if (!geometry.boundingBox || !geometry.boundingSphere)
      for (let i = 0; i < count; i++) {
        const vertex = index ? index.getX(i) : i;
        if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= position.count) return null;
        point.fromArray(position.array, vertex * 3);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null;
        if (!geometry.boundingBox) box.expandByPoint(point);
      }
    if (!geometry.boundingSphere) {
      box.getCenter(partSphere.center);
      let radiusSquared = 0;
      for (let i = 0; i < count; i++) {
        point.fromArray(position.array, (index ? index.getX(i) : i) * 3);
        radiusSquared = Math.max(radiusSquared, partSphere.center.distanceToSquared(point));
      }
      partSphere.radius = Math.sqrt(radiusSquared);
    }
    if (
      ![partSphere.center.x, partSphere.center.y, partSphere.center.z, partSphere.radius].every(
        Number.isFinite,
      ) ||
      partSphere.radius < 0
    )
      return null;
    parts.push({ start, count, sphere: partSphere });
    start += count;
    bounds.union(box.applyMatrix4(identity));
    sphere.union(partSphere.clone().applyMatrix4(identity));
  }
  return { parts, bounds, sphere };
}

function indirectStaticMesh(scene, pieces, material, configuration) {
  if (
    !material ||
    Array.isArray(material) ||
    material.wireframe ||
    (material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass)
  )
    return null;
  const layout = staticCellParts(pieces);
  if (!layout) return null;
  const geometry = mergeStaticGeometries(pieces);
  if (!geometry) return null;
  geometry.boundingBox = layout.bounds;
  geometry.boundingSphere = layout.sphere;
  const mesh = new THREE.Mesh(geometry, material),
    { parts } = layout,
    { stats } = configuration,
    draws = createStaticCellDraws(mesh, parts, {
      onPass: ({ draws, triangles }) => {
        // Three's WebGPU backend skips its counters for GPU indirect commands.
        stats.indirectDrawCalls += draws;
        stats.indirectTriangles += triangles;
      },
    });
  visibilityWriters.set(mesh, draws.setVisibleAt);
  shadowVisibilityWriters.set(mesh, draws.setShadowVisibleAt);
  // These prepared outer bounds contain every source cell, including expanded
  // shader bounds. Ordinary view/shadow culling can reject an entire region.
  mesh.frustumCulled = true;
  configuration.controllers.add(draws);
  stats.groups++;
  stats.parts += parts.length;
  mesh.userData.staticCellDraws = { parts, stats: draws.stats };
  const dispose = () => {
    geometry.removeEventListener('dispose', dispose);
    draws.dispose();
    visibilityWriters.delete(mesh);
    shadowVisibilityWriters.delete(mesh);
    configuration.controllers.delete(draws);
    stats.groups--;
    stats.parts -= parts.length;
  };
  geometry.addEventListener('dispose', dispose);
  for (const piece of pieces) piece.dispose();
  return mesh;
}

// Spatial pieces retain independent camera/shadow culling while sharing one
// render object, material binding and geometry buffer on each backend.
export function addStaticBatches(
  scene,
  geometries,
  material,
  name,
  castShadow = false,
  { requireIndirect = false } = {},
) {
  const pieces = geometries.filter((geometry) => geometry?.attributes.position?.count);
  if (!pieces.length) return null;
  let mesh;
  if (pieces.length === 1) mesh = new THREE.Mesh(pieces[0], material);
  else {
    const configuration = sceneConfigurations.get(scene);
    if (configuration?.indirectDraws) mesh = indirectStaticMesh(scene, pieces, material, configuration);
    if (mesh) return attachStaticMesh(scene, mesh, name, castShadow);
    if (requireIndirect) return null;
    mesh = new THREE.BatchedMesh(
      pieces.length,
      pieces.reduce((sum, geometry) => sum + geometry.attributes.position.count, 0),
      pieces.reduce((sum, geometry) => sum + (geometry.index?.count || 0), 0),
      material,
    );
    mesh.sortObjects = false;
    for (const geometry of pieces) {
      mesh.addInstance(mesh.addGeometry(geometry));
      geometry.dispose();
    }
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }
  return attachStaticMesh(scene, mesh, name, castShadow);
}
