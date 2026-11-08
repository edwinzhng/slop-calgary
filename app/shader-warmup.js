// Grouped shader compilation follows mrdoob/slop-newyork (MIT).
// Three's compileAsync yields between objects, so independent material jobs
// can overlap without rebuilding the same shared material concurrently.
import { DoubleSide, Frustum, Matrix4 } from 'three/webgpu';
import { prepareSceneBounds } from './static-bounds.js';

export async function compileSceneShaders(renderer, scene, camera, { concurrency = 16, onProgress } = {}) {
  // Three otherwise walks and updates the entire city's matrices again for
  // every individual job. Match its camera culling before queuing those jobs.
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    camera.coordinateSystem,
    camera.reversedDepth,
  );
  const prepareBounds = prepareSceneBounds(scene),
    jobs = [],
    byMaterial = new Map(),
    deferredMaterials = new Set();
  scene.traverseVisible((object) => {
    if (!(object.isMesh || object.isLine || object.isPoints || object.isSprite)) return;
    if (!object.layers.test(camera.layers)) return;
    // Three's async queue retains material references after its double pass
    // restores their side. Let the first live draw build those side variants
    // synchronously so their normals match the actual front/back pass.
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const deferred = materials.filter(
      (material) => material.transparent && material.side === DoubleSide && !material.forceSinglePass,
    );
    if (deferred.length) {
      for (const material of deferred) if (material.visible) deferredMaterials.add(material);
      return;
    }
    if (object.isInstancedMesh && object.count === 0) return;
    if (object.frustumCulled) prepareBounds(object);
    if (
      object.frustumCulled &&
      !(object.isSprite ? frustum.intersectsSprite(object) : frustum.intersectsObject(object))
    )
      return;
    if (object.isInstancedMesh || Array.isArray(object.material)) jobs.push([object]);
    else {
      let job = byMaterial.get(object.material);
      if (!job) {
        job = [];
        byMaterial.set(object.material, job);
        jobs.push(job);
      }
      job.push(object);
    }
  });
  const nextTask = () =>
    globalThis.scheduler?.yield
      ? globalThis.scheduler.yield()
      : new Promise((resolve) => setTimeout(resolve, 0));
  let next = 0,
    completed = 0,
    failure;
  const worker = async () => {
    while (next < jobs.length && !failure) {
      const job = jobs[next++];
      try {
        for (const object of job) {
          await nextTask();
          await renderer.compileAsync(object, camera, scene);
        }
        completed++;
        onProgress?.({ completed, total: jobs.length });
      } catch (error) {
        failure ||= error;
      }
    }
  };
  // Startup holds this fixed scene snapshot until every in-flight job settles.
  const automaticMatrices = scene.matrixWorldAutoUpdate;
  scene.matrixWorldAutoUpdate = false;
  // Compiling a safe mesh also traverses its descendants. Suppress only the
  // deferred materials so child lights still belong to the warmup light set.
  for (const material of deferredMaterials) material.visible = false;
  // Every started job settles before the caller restores renderer targets/MRT.
  try {
    await Promise.all(
      Array.from({ length: Math.min(jobs.length, Math.max(1, Math.floor(concurrency) || 1)) }, worker),
    );
  } finally {
    scene.matrixWorldAutoUpdate = automaticMatrices;
    for (const material of deferredMaterials) material.visible = true;
  }
  if (failure) throw failure;
  return { jobs: jobs.length, objects: jobs.reduce((sum, job) => sum + job.length, 0) };
}
