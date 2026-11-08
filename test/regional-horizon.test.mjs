import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import source from '../data/calgary-horizon.json' with { type: 'json' };
import {
  createRegionalGround,
  createRegionalHorizon,
  decodeHorizonProfile,
} from '../app/regional-horizon.js';
import { atmosphereSettings } from '../app/atmosphere.js';
import { project } from '../app/geo.js';

test('the measured foothills join outside the map and keep city ground support level', () => {
  const scene = new THREE.Scene(),
    bbox = { west: -114.11, south: 51.02, east: -114.025, north: 51.067 },
    { cityGround, foothills } = createRegionalGround(scene, bbox, new THREE.MeshBasicMaterial()),
    [minX, minZ] = project(bbox.west, bbox.north),
    [maxX, maxZ] = project(bbox.east, bbox.south),
    positions = foothills.geometry.attributes.position;
  assert.equal(cityGround.position.y, -0.04);
  assert.equal(foothills.castShadow, false);
  assert.ok(foothills.geometry.index.count / 3 < 13000);
  let high = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      y = positions.getY(i),
      z = positions.getZ(i);
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) assert.ok(Math.abs(y + 0.1) < 0.001);
    high = Math.max(high, y);
  }
  assert.ok(high > 250 && high < 267);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0));
  scene.updateMatrixWorld();
  assert.equal(ray.intersectObject(foothills).length, 0, 'the apron does not overlap the city interior');
  assert.ok(ray.intersectObject(cityGround).length > 0);
});

const slope = (decoded, band, sample, height) => {
  const at = (band * decoded.samples + sample) * 16;
  let result = -Infinity;
  for (let i = 0; i < 8; i++)
    result = Math.max(
      result,
      decoded.coefficients[at + i * 2] - height * decoded.coefficients[at + i * 2 + 1],
    );
  return result;
};

test('regional skyline preserves measured compass directions and changes the active terrain with camera altitude', () => {
  const decoded = decodeHorizonProfile();
  assert.deepEqual(source.origin, { latitude: 51.0458, longitude: -114.0719, groundElevationM: 1044 });
  assert.equal(decoded.bearings[decoded.bearings.indexOf(270) + 1], 270.25);
  assert.equal(decoded.bearings[decoded.bearings.indexOf(90) + 1], 91);
  // The sampled WSW peak is 68,327.6m away at 2,849m elevation.
  const earth = 6371008.8,
    angle = 68327.61690033176 / earth,
    up = (earth + 2849) * Math.cos(angle) - (earth + 1044),
    distance = (earth + 2849) * Math.sin(angle),
    expected = Math.atan2(up - 1.7, distance),
    westernPeak = decoded.bearings.indexOf(242),
    actual = Math.atan(slope(decoded, 1, westernPeak, 1.7));
  assert.ok(Math.abs(actual - expected) < THREE.MathUtils.degToRad(0.03));
  for (let band = 0; band < 3; band++) {
    assert.ok(slope(decoded, band, 90, 1.7) < 0, 'eastern prairie does not become an invented mountain');
    for (let bearing = 0; bearing < decoded.samples; bearing++) {
      const ground = slope(decoded, band, bearing, 1.7),
        fly = slope(decoded, band, bearing, 1200),
        aerial = slope(decoded, band, bearing, 6500);
      assert.ok(Number.isFinite(ground) && ground > fly && fly > aerial);
      for (let i = 0; i < 8; i++) {
        const at = (band * decoded.samples + bearing) * 16 + i * 2;
        assert.ok(Number.isFinite(decoded.coefficients[at]));
        assert.ok(decoded.coefficients[at + 1] > 0);
      }
    }
  }
  const at = (decoded.samples + westernPeak) * 16,
    winningSlot = (height) => {
      let best = 0;
      for (let i = 1; i < 8; i++)
        if (
          decoded.coefficients[at + i * 2] - height * decoded.coefficients[at + i * 2 + 1] >
          decoded.coefficients[at + best * 2] - height * decoded.coefficients[at + best * 2 + 1]
        )
          best = i;
      return best;
    };
  assert.notEqual(
    winningSlot(1.7),
    winningSlot(6500),
    'a fixed ground winner would distort the aerial horizon',
  );
});

test('closed inward-facing ridges keep buffers and shader graphs fixed across weather and stay outside city shadows/reflections', () => {
  const scene = new THREE.Scene(),
    backdrop = createRegionalHorizon(scene, { useMRT: true }),
    { mesh } = backdrop,
    { geometry, material } = mesh,
    position = geometry.attributes.position,
    p = new THREE.Vector3(),
    q = new THREE.Vector3(),
    r = new THREE.Vector3(),
    center = new THREE.Vector3();
  assert.equal(scene.children.length, 1);
  assert.equal(material.transparent, false);
  assert.equal(material.alphaToCoverage, true);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.fog, false);
  assert.equal(material.lights, false);
  assert.equal(material.depthNode, null, 'Three retains its normal/reversed/logarithmic depth path');
  assert.equal(mesh.castShadow, false);
  assert.equal(mesh.receiveShadow, false);
  assert.equal(mesh.frustumCulled, false);
  assert.ok(mesh.renderOrder < 0, 'all city detail draws over the backdrop');
  assert.deepEqual(Object.keys(material.mrtNode.outputNodes).sort(), ['metalRough', 'normal']);
  const decoded = decodeHorizonProfile();
  assert.equal(geometry.index.count / 3, decoded.samples * 2);
  assert.equal(
    Object.keys(geometry.attributes).length,
    13,
    'fits the WebGPU/WebGL guaranteed attribute limit',
  );
  const vertexBuffers = new Set(Object.values(geometry.attributes).map((a) => a.data || a));
  assert.equal(vertexBuffers.size, 2, 'interleaving keeps vertex buffers below the WebGPU limit');
  for (const attribute of Object.values(geometry.attributes))
    for (let component = 0; component < attribute.itemSize; component++)
      assert.equal(
        attribute.getComponent(0, component),
        attribute.getComponent(decoded.samples * 2, component),
        'north seam closes exactly, including terrain coefficients',
      );
  for (let bearing = 0; bearing < decoded.samples; bearing++)
    for (let band = 0; band < 3; band++)
      for (let candidate = 0; candidate < 8; candidate++) {
        const at = (band * decoded.samples + bearing) * 16 + candidate * 2,
          attribute = geometry.attributes[`horizon${band * 4 + Math.floor(candidate / 2)}`],
          component = (candidate % 2) * 2;
        for (const row of [0, 1])
          for (let i = 0; i < 2; i++)
            assert.equal(
              attribute.getComponent(bearing * 2 + row, component + i),
              decoded.coefficients[at + i],
            );
      }
  for (let i = 0; i < geometry.index.count; i += 3) {
    p.fromBufferAttribute(position, geometry.index.getX(i));
    q.fromBufferAttribute(position, geometry.index.getX(i + 1));
    r.fromBufferAttribute(position, geometry.index.getX(i + 2));
    center.copy(p).add(q).add(r).setY(0);
    q.sub(p).cross(r.sub(p));
    assert.ok(q.dot(center) < 0, 'ridge front face looks toward the city');
  }
  const nodes = [material.positionNode, material.colorNode, material.maskNode, material.mrtNode],
    buffers = Object.values(geometry.attributes).map((a) => Buffer.from(a.array.buffer).toString('base64'));
  for (const time of ['day', 'golden', 'dusk', 'night'])
    for (const weather of ['clear', 'rain', 'snow', 'fog'])
      backdrop.setEnvironment(time, atmosphereSettings(weather), new THREE.Color(0xc2d4d5));
  assert.deepEqual([material.positionNode, material.colorNode, material.maskNode, material.mrtNode], nodes);
  assert.deepEqual(
    Object.values(geometry.attributes).map((a) => Buffer.from(a.array.buffer).toString('base64')),
    buffers,
  );
  backdrop.dispose();
  assert.equal(scene.children.length, 0);
  const fallback = createRegionalHorizon(scene);
  assert.equal(fallback.mesh.material.depthNode, null);
  assert.equal(fallback.mesh.material.mrtNode, null, 'direct WebGL output retains its beauty attachment');
  fallback.dispose();
});

test('invalid terrain counts, truncated streams and coefficient scales fail before rendering', () => {
  const changed = (edit) => {
    const profile = structuredClone(source);
    edit(profile);
    return profile;
  };
  for (const profile of [
    changed((p) => (p.version = 3)),
    changed((p) => (p.refinedSector = [314, 218])),
    changed((p) => (p.cameraHeightM = [6656, -128])),
    changed((p) => (p.encoding.inverseDistanceUnit[0] = NaN)),
    changed((p) => (p.encoding.inverseDistanceBase = [1])),
    changed((p) => (p.encoding.data = Buffer.from([0]).toString('base64'))),
    changed(
      (p) => (p.encoding.data = Buffer.from(p.encoding.data, 'base64').subarray(0, -1).toString('base64')),
    ),
    changed(
      (p) =>
        (p.encoding.data = Buffer.concat([Buffer.from(p.encoding.data, 'base64'), Buffer.from([0])]).toString(
          'base64',
        )),
    ),
  ])
    assert.throws(() => decodeHorizonProfile(profile), /regional horizon/);
});
