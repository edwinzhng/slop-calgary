import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadHaydenBlock, HAYDEN_BLOCK_BASELINE_ID } from '../app/hayden-block.js';
import { loadAllPartialBuildings } from '../app/additional-city-buildings.js';

const map = JSON.parse(await fs.readFile(new URL('../data/calgary.json', import.meta.url)));
const fileFetch = async (url) => new Response(await fs.readFile(url));

test('all three building batches download while the source map is pending, then validate ownership', async () => {
  let resolveMap;
  const pendingMap = new Promise((resolve) => (resolveMap = resolve)),
    requests = [],
    fetcher = (url) => {
      requests.push(url.href);
      return fileFetch(url);
    };
  let completed = false;
  const results = Promise.all([
    loadHaydenBlock(pendingMap, { fetcher }),
    loadAllPartialBuildings(pendingMap, { fetcher }),
  ]).then((providers) => {
    completed = true;
    return providers;
  });
  assert.equal(requests.length, 6, 'each manifest and binary starts before the map resolves');
  assert.equal(new Set(requests).size, 6, 'no duplicate asset downloads');
  await new Promise(setImmediate);
  assert.equal(completed, false, 'source ownership cannot validate without the matching map');
  resolveMap(map);
  const [hayden, partial] = await results;
  assert.equal(hayden.ready, true);
  assert.equal(hayden.has(HAYDEN_BLOCK_BASELINE_ID), true);
  assert.equal(partial.ready, true);
  assert.equal(partial.providers.length, 2);
  assert.ok(partial.stats.batches.every((batch) => batch.accepted));
});

test('a changed baseline is rejected after its files download without altering the source map', async () => {
  const changed = structuredClone(map),
    baseline = changed.buildings.find((building) => building.id === HAYDEN_BLOCK_BASELINE_ID);
  baseline.height += 1;
  const original = JSON.stringify(changed),
    requests = [];
  await assert.rejects(
    loadHaydenBlock(Promise.resolve(changed), {
      fetcher: (url) => {
        requests.push(url.href);
        return fileFetch(url);
      },
    }),
    /baseline compound changed/,
  );
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(changed), original, 'failed validation retains the complete baseline');
});

test('one unavailable enhancement batch preserves the other validated batch', async () => {
  const requests = [],
    partial = await loadAllPartialBuildings(Promise.resolve(map), {
      fetcher: (url) => {
        requests.push(url.href);
        return url.pathname.includes('ADDITIONAL_BUILDING_FRAGMENTS_MESHES')
          ? Promise.resolve(new Response('', { status: 503 }))
          : fileFetch(url);
      },
    });
  assert.equal(requests.length, 4);
  assert.equal(partial.ready, true);
  assert.equal(partial.providers.length, 1);
  assert.deepEqual(
    partial.stats.batches.map((batch) => batch.accepted),
    [true, false],
  );
});
