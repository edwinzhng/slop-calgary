import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCityMeshes } from '../app/city-meshes.js';
import { loadHaydenBlock } from '../app/hayden-block.js';
import { facadeReferences, referenceWallZones } from '../app/facade-finishes.js';
import { mountFacadeLettering } from '../app/facade-imagery.js';

const readData = (name) => readFile(new URL(`../data/${name}`, import.meta.url));

test('every façade reference resolves to a measured finish or independent lettering', async () => {
  const [manifest, binary, map] = await Promise.all([
    readData('calgary-meshes.json'),
    readData('calgary-meshes.bin'),
    readData('calgary.json'),
  ]);
  const city = createCityMeshes(JSON.parse(manifest), binary);
  const hayden = await loadHaydenBlock(JSON.parse(map), {
    fetcher: async (url) => new Response(await readFile(url)),
  });
  for (const record of facadeReferences) {
    const building = { id: record.buildingId };
    const shell = city.createGeometry(building.id) || hayden.createGeometry(building.id);
    try {
      assert.ok(record.material || record.sign, record.id);
      if (record.material) {
        const result = referenceWallZones(shell, building);
        assert.ok(
          [...(result?.triangleZones.values() || [])].some(({ id }) => id === record.id),
          record.id,
        );
      }
      if (record.sign) {
        const mount = mountFacadeLettering(record, shell);
        assert.ok(mount && mount.width <= record.sign.width, record.id);
        if (record.id === 'irwin-block-west-upper') {
          assert.equal(mount.yaw, 0, 'the historical sign is on the south return');
          shell.attributes.position.setX(0, shell.attributes.position.getX(0) + 0.03);
          assert.equal(referenceWallZones(shell, building), null);
          assert.equal(mountFacadeLettering(record, shell), null);
        }
      }
    } finally {
      shell.dispose();
    }
  }
});
