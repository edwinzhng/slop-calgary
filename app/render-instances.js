// WebGPU storage-matrix optimization adapted from mrdoob/slop-newyork (MIT).
// Small ordinary matrix attributes become uniform arrays in Three.js, uploading
// again for each draw/pass. Storage attributes retain versioned GPU buffers.
import { StorageInstancedBufferAttribute } from 'three/webgpu';

export function prepareInstanceMatrices(root, webgpu) {
  const stats = { meshes: 0, buffers: 0, bytes: 0 };
  if (!webgpu) return stats;
  const replacements = new Map();
  root.traverse((object) => {
    const source = object.instanceMatrix;
    if (!object.isInstancedMesh || source?.isStorageInstancedBufferAttribute) return;
    if (source?.itemSize !== 16 || !(source.array instanceof Float32Array)) return;
    let storage = replacements.get(source);
    if (!storage) {
      storage = new StorageInstancedBufferAttribute(source.array, 16);
      storage.setUsage(source.usage);
      storage.name = source.name;
      storage.normalized = source.normalized;
      storage.meshPerAttribute = source.meshPerAttribute;
      storage.gpuType = source.gpuType;
      storage.onUpload(source.onUploadCallback);
      for (const range of source.updateRanges) storage.addUpdateRange(range.start, range.count);
      replacements.set(source, storage);
      stats.buffers++;
      stats.bytes += source.array.byteLength;
    }
    object.instanceMatrix = storage;
    stats.meshes++;
  });
  return stats;
}
