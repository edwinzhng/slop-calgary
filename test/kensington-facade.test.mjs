import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCityMeshes } from '../app/city-meshes.js';
import { measuredFacadeSamples } from '../app/imagery-geometry.js';

test('the dated Kensington office crop uses only its exact measured east wall and existing licensed image', async () => {
  const imagery = JSON.parse(await fs.readFile(new URL('../data/imagery.json', import.meta.url))),
    facade = imagery.facades.find((record) => record.id === 'kensington-central-east-upper'),
    image = imagery.images.find((record) => record.id === facade.imageId),
    manifest = JSON.parse(await fs.readFile(new URL('../data/calgary-meshes.json', import.meta.url))),
    binary = await fs.readFile(new URL('../data/calgary-meshes.bin', import.meta.url)),
    provider = createCityMeshes(manifest, binary),
    record = provider.get(facade.buildingId),
    source = provider.createGeometry(facade.buildingId),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    const positions = source.attributes.position.array.slice(),
      normals = source.attributes.normal.array.slice(),
      result = measuredFacadeSamples(facade, source);
    assert.equal(record.structureIds[0], 1005226);
    assert.equal(
      hash(
        binary.subarray(
          record.offset,
          record.offset + record.vertexCount * 6 + record.indexCount * record.indexBytes,
        ),
      ),
      facade.registration.modelPayloadSha256,
    );
    assert.deepEqual(facade.registration.sourceTriangles, [40, 41]);
    assert.equal(result.stats.selectedTriangles, 2);
    assert.ok(result.stats.outputTriangles > 0 && result.stats.outputTriangles <= 800);
    assert.deepEqual(source.attributes.position.array, positions);
    assert.deepEqual(source.attributes.normal.array, normals);
    assert.equal(
      hash(new Uint8Array(positions.buffer)),
      '49392bc1c918cf7adf9c054cc8652a4342a3670bc538cb4a732d93f510660c11',
    );
    for (let i = 0; i < result.positions.length; i += 3) {
      const x = result.positions[i],
        y = result.positions[i + 1],
        z = result.positions[i + 2],
        depth = (x - facade.a[0]) * facade.normal[0] + (z - facade.a[1]) * facade.normal[1];
      assert.ok(Math.abs(depth - facade.projection.offset) < 0.0002);
      assert.ok(y >= 5 - 1e-7 && y <= 11.9 + 1e-7);
      assert.ok(z >= -788.971 && z <= -766.469);
    }
    assert.ok(result.uvs.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.equal(image.asset, 'kensington-hexagon-blanco-2022.jpg');
    assert.equal(image.license, 'CC BY-SA 4.0');
    assert.equal(image.capturedAt, '2022-05-29T23:23:53.889000Z');
    assert.equal(
      hash(await fs.readFile(new URL('../public/imagery/' + image.asset, import.meta.url))),
      image.sha256,
    );
    assert.deepEqual(
      facade.placeIds,
      [],
      'upper office walls must not suppress ground-floor storefront POIs',
    );
    assert.equal(new Set(imagery.images.map((entry) => entry.asset)).size, imagery.images.length);
    assert.equal(imagery.meta.counts.facades, imagery.facades.length);
  } finally {
    source.dispose();
  }
});
