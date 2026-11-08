import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import { createCityMeshes } from '../app/city-meshes.js';
import { addDevenishFrontage } from '../app/devenish.js';
import { observedBuildingMaterialZones } from '../app/observed-building-materials.js';

const [manifest, binary] = await Promise.all([
  readFile(new URL('../data/calgary-meshes.json', import.meta.url), 'utf8'),
  readFile(new URL('../data/calgary-meshes.bin', import.meta.url)),
]);
const provider = createCityMeshes(JSON.parse(manifest), binary);

test('Devenish detail retains the complete measured body and expires with a changed owner', () => {
  const id = 'city-outline-27541-0';
  const shell = provider.createGeometry(id);
  const source = provider.get(id);
  const scene = new THREE.Scene();
  assert.equal(
    addDevenishFrontage(scene, shell, { ...source, structureIds: [source.structureIds[0]] }),
    null,
  );
  assert.equal(shell.index, null);
  assert.equal(scene.children.length, 0);

  const detail = addDevenishFrontage(scene, shell, source);
  const [masonry, ornaments] = scene.children;
  const sourceVertices = shell.attributes.position.count;
  assert.equal(shell.index.count + masonry.geometry.attributes.position.count, sourceVertices);
  assert.equal(shell.index.count % 3, 0);
  for (const mesh of [masonry, ornaments]) {
    const position = mesh.geometry.attributes.position;
    assert.ok(position.array.every(Number.isFinite));
  }
  assert.ok(detail.triangles > 15000 && detail.triangles < 18500);
  assert.ok(detail.colliders.some((part) => part.minHeight > 4));
  assert.ok(detail.colliders.some((part) => part.minHeight < 0.5 && part.height > 4));
  assert.ok(detail.colliders.every((part) => part.storefrontAnchor === false));
});

test('Mount Royal Block colour is registered only to the observed street wall and chamfers', () => {
  const id = 'city-outline-27323-0';
  const geometry = provider.createGeometry(id);
  const material = observedBuildingMaterialZones(geometry, { id });
  assert.ok(material.triangleZones.size > 10);
  assert.ok(material.triangleZones.size < geometry.attributes.position.count / 3);
  const normal = geometry.attributes.normal;
  for (const triangle of material.triangleZones.keys()) {
    assert.ok(normal.getZ(triangle * 3) < -0.62);
    assert.ok(Math.abs(normal.getY(triangle * 3)) < 0.2);
  }
  geometry.attributes.position.setY(0, geometry.attributes.position.getY(0) + 0.01);
  assert.equal(observedBuildingMaterialZones(geometry, { id }), null);
});
