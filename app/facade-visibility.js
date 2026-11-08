import { Box3, BufferGeometry, Float32BufferAttribute, Frustum, Matrix4 } from 'three/webgpu';

// Bound the accepted crop, including measured-wall depth and its host's rigid
// ground placement, without decoding the source mesh or requesting a photo.
export function facadeBounds(record, placeGeometry) {
  const { a, b, normal, base = 0.2, height, offset = 0.12, projection } = record,
    measured = projection?.type === 'measured-walls',
    points = [];
  if (measured) {
    const width = Math.hypot(b[0] - a[0], b[1] - a[1]),
      tx = (b[0] - a[0]) / width,
      tz = (b[1] - a[1]) / width,
      length = Math.hypot(...normal),
      nx = normal[0] / length,
      nz = normal[1] / length,
      determinant = tx * nz - tz * nx,
      lift = projection.offset ?? 0.025;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-6) return null;
    for (const along of [0, width])
      for (const depth of [projection.minDepth, projection.maxDepth])
        for (const y of [base, base + height])
          points.push(
            a[0] + (along * nz - tz * depth) / determinant + nx * lift,
            y,
            a[1] + (tx * depth - along * nx) / determinant + nz * lift,
          );
  } else {
    for (const p of [a, b])
      for (const y of [base, base + height])
        points.push(p[0] + normal[0] * offset, y, p[1] + normal[1] * offset);
  }
  if (!points.every(Number.isFinite)) return null;
  const geometry = new BufferGeometry();
  try {
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    placeGeometry?.(geometry, record);
    geometry.computeBoundingBox();
    // Preload just outside the view, including small camera turns and rounding.
    return new Box3().copy(geometry.boundingBox).expandByScalar(20);
  } finally {
    geometry.dispose();
  }
}

export function createFacadeView(records, placeGeometry) {
  const boxes = new Map(records.map((record) => [record.id, facadeBounds(record, placeGeometry)])),
    frustum = new Frustum(),
    matrix = new Matrix4();
  return {
    update(camera) {
      camera.updateMatrixWorld();
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix, camera.coordinateSystem, camera.reversedDepth);
    },
    intersects(record) {
      const box = boxes.get(record.id);
      return !box || frustum.intersectsBox(box);
    },
  };
}
