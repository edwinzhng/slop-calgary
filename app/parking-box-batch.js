import * as THREE from 'three/webgpu';

const template = new THREE.BoxGeometry(),
  basePosition = template.attributes.position.array.slice(),
  baseNormal = template.attributes.normal.array.slice(),
  baseUV = template.attributes.uv.array.slice(),
  baseIndex = template.index.array.slice();
template.dispose();

// Reuse the box construction buffers, but retain Three's separate Float32
// rotation/translation and each primitive's terrain subdivision boundary.
export function createParkingBoxBatch(terrain) {
  let scratch,
    vertices = 0,
    indices = 0,
    boxes = 0,
    indexed,
    maximumIndex = 0,
    positions = new Float32Array(0),
    normals = new Float32Array(0),
    uvs = new Float32Array(0),
    index = new Uint32Array(0);
  function grow(array, required) {
    if (array.length >= required) return array;
    const result = new array.constructor(Math.max(required, array.length * 2, 256));
    result.set(array);
    return result;
  }
  function append(geometry) {
    const p = geometry.attributes.position,
      n = geometry.attributes.normal,
      uv = geometry.attributes.uv,
      sourceIndex = geometry.index;
    if (
      Object.keys(geometry.attributes).length !== 3 ||
      !p ||
      !n ||
      !uv ||
      p.itemSize !== 3 ||
      n.itemSize !== 3 ||
      uv.itemSize !== 2 ||
      n.count !== p.count ||
      uv.count !== p.count ||
      [p, n, uv].some((a) => a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array)) ||
      (indexed !== undefined && indexed !== !!sourceIndex)
    )
      throw new Error('Unsupported draped parking box attributes');
    indexed = !!sourceIndex;
    positions = grow(positions, (vertices + p.count) * 3);
    normals = grow(normals, (vertices + p.count) * 3);
    uvs = grow(uvs, (vertices + p.count) * 2);
    positions.set(p.array, vertices * 3);
    normals.set(n.array, vertices * 3);
    uvs.set(uv.array, vertices * 2);
    if (sourceIndex) {
      index = grow(index, indices + sourceIndex.count);
      for (let i = 0; i < sourceIndex.count; i++) {
        const value = sourceIndex.getX(i) + vertices;
        index[indices++] = value;
        maximumIndex = Math.max(maximumIndex, value);
      }
    }
    vertices += p.count;
    boxes++;
  }
  return {
    get length() {
      return boxes;
    },
    add(width, height, depth, angle, x, y, z) {
      scratch ||= new THREE.BoxGeometry();
      const p = scratch.attributes.position.array;
      scratch.boundingBox = scratch.boundingSphere = null;
      for (let i = 0; i < basePosition.length; i += 3) {
        p[i] = basePosition[i] * width;
        p[i + 1] = basePosition[i + 1] * height;
        p[i + 2] = basePosition[i + 2] * depth;
      }
      scratch.attributes.normal.array.set(baseNormal);
      scratch.attributes.uv.array.set(baseUV);
      scratch.index.array.set(baseIndex);
      Object.assign(scratch.parameters, { width, height, depth });
      scratch.rotateY(angle);
      scratch.translate(x, y, z);
      const draped = terrain?.drapeGeometry(scratch, 2) || scratch;
      try {
        append(draped);
      } finally {
        if (draped !== scratch) {
          // The terrain adapter disposes its input when replacing it.
          draped.dispose();
          scratch = undefined;
        }
      }
    },
    finish() {
      scratch?.dispose();
      scratch = undefined;
      if (!boxes) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, vertices * 3), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals.slice(0, vertices * 3), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.slice(0, vertices * 2), 2));
      if (indexed) {
        const Index = maximumIndex >= 65535 ? Uint32Array : Uint16Array;
        geometry.setIndex(new THREE.BufferAttribute(Index.from(index.subarray(0, indices)), 1));
      }
      return geometry;
    },
  };
}
