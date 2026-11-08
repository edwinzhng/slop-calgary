import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import { createCityMeshes } from '../app/city-meshes.js';
import { facadeSamples, measuredFacadeSamples } from '../app/imagery-geometry.js';
import { createFacadeView, facadeBounds } from '../app/facade-visibility.js';

test('request bounds contain every available measured crop and the final native-height placement', async () => {
  const imagery = JSON.parse(await fs.readFile(new URL('../data/imagery.json', import.meta.url))),
    manifest = JSON.parse(await fs.readFile(new URL('../data/calgary-meshes.json', import.meta.url))),
    binary = await fs.readFile(new URL('../data/calgary-meshes.bin', import.meta.url)),
    provider = createCityMeshes(manifest, binary),
    point = new THREE.Vector3(),
    lift = (geometry) => geometry.translate(0, 47, 0);
  let measured = 0;
  for (const record of imagery.facades) {
    const box = facadeBounds(record, lift);
    let samples;
    if (record.projection?.type === 'measured-walls') {
      const id = record.wallGeometryBuildingId || record.buildingId;
      if (!provider.get(id)) continue;
      const source = provider.createGeometry(id);
      try {
        samples = measuredFacadeSamples(record, source);
      } finally {
        source.dispose();
      }
      if (samples.positions.length) measured++;
    } else samples = facadeSamples(record);
    assert.ok(box, record.id);
    for (let i = 0; i < samples.positions.length; i += 3) {
      point.fromArray(samples.positions, i).y += 47;
      assert.ok(box.containsPoint(point), `${record.id}: ${point.toArray()}`);
    }
  }
  assert.ok(measured >= 15, 'exercise real clipped, setback and chamfered wall crops');
});

test('off-view requests wait for a camera turn on WebGL and reversed-depth WebGPU cameras', () => {
  const records = [
    { id: 'ahead', a: [-5, -100], b: [5, -100], normal: [0, 1], height: 10 },
    { id: 'behind', a: [5, 100], b: [-5, 100], normal: [0, -1], height: 10 },
    { id: 'at-edge', a: [65, -100], b: [70, -100], normal: [0, 1], height: 10 },
  ];
  for (const reversed of [false, true]) {
    const camera = new THREE.PerspectiveCamera(55, 1, 0.2, 2000);
    camera.position.set(0, 5, 0);
    camera.coordinateSystem = reversed ? THREE.WebGPUCoordinateSystem : THREE.WebGLCoordinateSystem;
    camera._reversedDepth = reversed;
    camera.updateProjectionMatrix();
    const view = createFacadeView(records);
    view.update(camera);
    assert.equal(view.intersects(records[0]), true);
    assert.equal(view.intersects(records[1]), false);
    assert.equal(view.intersects(records[2]), true, 'preload a conservative margin outside the viewport');
    camera.rotation.y = Math.PI;
    view.update(camera);
    assert.equal(view.intersects(records[0]), false);
    assert.equal(view.intersects(records[1]), true);
  }
});
