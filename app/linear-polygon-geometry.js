import * as THREE from 'three/webgpu';

function originalGeometry(surface, y) {
  const shape = new THREE.Shape(surface.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const ring of surface.holes || [])
    shape.holes.push(new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}

function supportedRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return false;
  for (let i = 0; i < ring.length; i++) {
    if (!(i in ring)) return false;
    const point = ring[i];
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
      return false;
    // A LineCurve's t=0 subtraction can overflow even with finite endpoints.
    if (i && (!Number.isFinite(point[0] - ring[i - 1][0]) || !Number.isFinite(-point[1] - -ring[i - 1][1])))
      return false;
  }
  return true;
}

function linearContour(ring) {
  const points = [];
  let last;
  const append = (x, y) => {
    if (last && last.x === x && last.y === y) return;
    last = new THREE.Vector2(x, y);
    points.push(last);
  };
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1],
      b = ring[i],
      ay = -a[1],
      by = -b[1];
    // Match LineCurve's two samples and CurvePath's exact duplicate removal.
    // The t=0 arithmetic also preserves Three's signed-zero behavior.
    append((b[0] - a[0]) * 0 + a[0], (by - ay) * 0 + ay);
    append(b[0], by);
  }
  return points;
}

export function createLinearPolygonGeometry(surface, y) {
  const sourceHoles = surface.holes || [];
  if (!supportedRing(surface.ring) || !Array.isArray(sourceHoles) || !sourceHoles.every(supportedRing))
    return originalGeometry(surface, y);
  // Array#every skips sparse holes, unlike the original for-of Path factory.
  for (let i = 0; i < sourceHoles.length; i++) if (!(i in sourceHoles)) return originalGeometry(surface, y);

  const contour = linearContour(surface.ring),
    holes = sourceHoles.map(linearContour);
  if (!THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  for (let i = 0; i < holes.length; i++) if (THREE.ShapeUtils.isClockWise(holes[i])) holes[i].reverse();
  // This removes closing duplicates before triangulating, as ShapeGeometry does.
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  let count = contour.length;
  for (const hole of holes) count += hole.length;
  const position = new THREE.Float32BufferAttribute(count * 3, 3),
    normal = new THREE.Float32BufferAttribute(count * 3, 3),
    uv = new THREE.Float32BufferAttribute(count * 2, 2);
  let at = 0;
  for (const ring of [contour, ...holes])
    for (const vertex of ring) {
      const p = at * 3,
        t = at * 2;
      position.array[p] = vertex.x;
      position.array[p + 1] = vertex.y;
      normal.array[p + 2] = 1;
      uv.array[t] = vertex.x;
      uv.array[t + 1] = vertex.y;
      at++;
    }
  const indices = new Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const at = i * 3,
      face = faces[i];
    indices[at] = face[0];
    indices[at + 1] = face[1];
    indices[at + 2] = face[2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('uv', uv);
  // Retain both Float32 rounding steps and the rotation's small normal residual.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}
