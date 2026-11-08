import { buildRoofDetailGeometry } from './building-models.js';
import { buildInfrastructureDetailGeometry } from './infrastructure.js';

self.onmessage = ({ data: { kind, recipe } }) => {
  try {
    const { geometry, connectionTriangles } =
      kind === 'roof'
        ? { geometry: buildRoofDetailGeometry(recipe) }
        : buildInfrastructureDetailGeometry(recipe);
    if (geometry && !geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry && !geometry.boundingSphere) geometry.computeBoundingSphere();
    const attributes = Object.entries(geometry?.attributes ?? {}).map(
      ([name, { array, itemSize, normalized }]) => ({
        name,
        array,
        itemSize,
        normalized,
      }),
    );
    const index = geometry?.index?.array ?? null;
    const box = geometry?.boundingBox;
    const sphere = geometry?.boundingSphere;
    const transfer = attributes.map(({ array }) => array.buffer);
    if (index) transfer.push(index.buffer);
    self.postMessage(
      {
        attributes,
        index,
        connectionTriangles,
        bounds: box && [box.min.toArray(), box.max.toArray()],
        sphere: sphere && [sphere.center.toArray(), sphere.radius],
      },
      transfer,
    );
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
