import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';

export function createDetailWorker() {
  let worker;
  let pending;
  let unavailable = typeof Worker !== 'function';
  const stats = { enabled: false, roofs: 0, streetTiles: 0, fallback: 0 };
  const fail = (error) => {
    worker?.terminate();
    worker = null;
    unavailable = true;
    stats.enabled = false;
    pending?.reject(error);
    pending = null;
  };
  function start() {
    try {
      worker = new Worker(new URL('./detail-geometry-worker.js', import.meta.url), { type: 'module' });
      stats.enabled = true;
    } catch (error) {
      fail(error);
      return;
    }
    worker.onmessage = ({ data }) => {
      if (data.error) return fail(new Error(data.error));
      let geometry = null;
      if (data.attributes.length) {
        geometry = new BufferGeometry();
        for (const { name, array, itemSize, normalized } of data.attributes)
          geometry.setAttribute(name, new BufferAttribute(array, itemSize, normalized));
        if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
        if (data.bounds) geometry.boundingBox = new Box3(...data.bounds.map((v) => new Vector3(...v)));
        if (data.sphere) geometry.boundingSphere = new Sphere(new Vector3(...data.sphere[0]), data.sphere[1]);
      }
      stats[pending.kind === 'roof' ? 'roofs' : 'streetTiles']++;
      pending.resolve({ geometry, connectionTriangles: data.connectionTriangles });
      pending = null;
    };
    worker.onerror = (event) => fail(new Error(event.message));
    worker.onmessageerror = () => fail(new Error('Could not read city detail geometry'));
  }
  return {
    stats,
    get available() {
      return !unavailable;
    },
    build(kind, recipe) {
      if (pending || unavailable) return null;
      if (!worker) start();
      if (!worker) return null;
      return new Promise((resolve, reject) => {
        pending = { kind, resolve, reject };
        try {
          worker.postMessage({ kind, recipe });
        } catch (error) {
          fail(error);
        }
      });
    },
  };
}
