import * as THREE from 'three/webgpu';
const up = new THREE.Vector3(0, 1, 0),
  right = new THREE.Vector3(),
  vertical = new THREE.Vector3(),
  forward = new THREE.Vector3();
export function renderPixelRatio(width, height, dpr, quality) {
  const pixels = quality === 'high' ? 3000000 : quality === 'performance' ? 1200000 : 2400000;
  // Slop New York uses one render pixel per CSS pixel. Supersampling the
  // three MSAA attachments on Retina displays almost doubled their workload.
  return Math.min(
    dpr,
    quality === 'high' ? 1.25 : quality === 'performance' ? 0.75 : 1,
    Math.sqrt(pixels / Math.max(1, width * height)),
  );
}

export function createMobileResolutionBudget() {
  const scales = [1, 0.86, 0.74];
  let level = 0,
    slow = 0,
    healthy = 0;
  return {
    get scale() {
      return scales[level];
    },
    update(ms) {
      if (!(ms > 0 && ms < 120)) {
        slow = healthy = 0;
        return false;
      }
      slow = ms > 23 ? slow + ms : Math.max(0, slow - ms * 0.5);
      healthy = ms < 19 ? healthy + ms : 0;
      if (slow > 1000 && level < scales.length - 1) level++;
      else if (healthy > 6500 && level > 0) level--;
      else return false;
      slow = healthy = 0;
      return true;
    },
  };
}
// Keep the shadow projection on a world-space texel grid. Following a moving
// player continuously otherwise makes the shadow map crawl over fixed walls.
export function snapShadowTarget(point, lightOffset, texelSize, out = new THREE.Vector3()) {
  forward.copy(lightOffset).normalize();
  right.crossVectors(up, forward).normalize();
  vertical.crossVectors(forward, right).normalize();
  const u = Math.round(point.dot(right) / texelSize) * texelSize,
    v = Math.round(point.dot(vertical) / texelSize) * texelSize,
    w = point.dot(forward);
  return out.copy(right).multiplyScalar(u).addScaledVector(vertical, v).addScaledVector(forward, w);
}
