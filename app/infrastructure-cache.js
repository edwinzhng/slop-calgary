import * as THREE from 'three/webgpu';

export class InfrastructureCache {
  #entries = new Map();
  constructor(maxBytes, maxEntries, dispose = () => {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.dispose = dispose;
    this.stats = { bytes: 0, entries: 0, hits: 0, misses: 0 };
  }
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }
  take(key) {
    const value = this.get(key);
    if (value !== undefined) this.#remove(key, false);
    return value;
  }
  set(key, value, bytes) {
    this.#remove(key, true);
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    while (this.#entries.size >= this.maxEntries || this.stats.bytes + bytes > this.maxBytes)
      this.#remove(this.#entries.keys().next().value, true);
    this.#entries.set(key, { value, bytes });
    this.stats.bytes += bytes;
    this.stats.entries = this.#entries.size;
    return true;
  }
  #remove(key, dispose) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.stats.bytes -= entry.bytes;
    this.stats.entries = this.#entries.size;
    if (dispose) this.dispose(entry.value);
  }
  clear() {
    for (const key of this.#entries.keys()) this.#remove(key, true);
  }
}

export function mergeInfrastructureStreams(streams) {
  const length = streams.reduce((sum, stream) => sum + stream.positions.length, 0);
  if (!length) return null;
  const geometry = new THREE.BufferGeometry();
  for (const [name, field] of [
    ['position', 'positions'],
    ['normal', 'normals'],
    ['color', 'colors'],
  ]) {
    const attribute = new THREE.Float32BufferAttribute(length, 3);
    let offset = 0;
    for (const stream of streams) {
      attribute.array.set(stream[field], offset);
      offset += stream[field].length;
    }
    geometry.setAttribute(name, attribute);
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
