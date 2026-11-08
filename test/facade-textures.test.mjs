import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createFacadeTexturePool } from '../app/facade-textures.js';

function loaderFixture() {
  const loads = [];
  return {
    loads,
    load(url, ready, progress, error) {
      const texture = new THREE.Texture(),
        load = { url, texture, complete: () => ready(texture), fail: error, disposed: 0 };
      texture.addEventListener('dispose', () => load.disposed++);
      loads.push(load);
      return texture;
    },
  };
}

test('separate facade crops share one request, configuration and texture until their last release', () => {
  const loader = loaderFixture(),
    configured = [],
    received = [],
    pool = createFacadeTexturePool(loader, (texture) => configured.push(texture)),
    a = pool.acquire('/photo.jpg', (texture) => received.push(texture)),
    b = pool.acquire('/photo.jpg', (texture) => received.push(texture));
  assert.equal(loader.loads.length, 1);
  loader.loads[0].complete();
  assert.deepEqual(received, [loader.loads[0].texture, loader.loads[0].texture]);
  assert.equal(configured.length, 1);
  const c = pool.acquire('/photo.jpg', (texture) => received.push(texture));
  assert.equal(received[2], received[0]);
  a.release();
  a.release();
  b.release();
  assert.equal(loader.loads[0].disposed, 0);
  assert.equal(pool.stats.references, 1);
  c.release();
  assert.equal(loader.loads[0].disposed, 1);
  assert.equal(pool.stats.imageEntries, 0);
});

test('leaving and returning during a pending image joins the same request without stale callbacks', () => {
  const loader = loaderFixture(),
    pool = createFacadeTexturePool(loader),
    received = [],
    first = pool.acquire('/photo.jpg', () => received.push('stale'));
  first.release();
  assert.equal(pool.stats.pendingImages, 1);
  const current = pool.acquire('/photo.jpg', () => received.push('current'));
  assert.equal(loader.loads.length, 1);
  loader.loads[0].complete();
  assert.deepEqual(received, ['current']);
  current.release();
  assert.equal(loader.loads[0].disposed, 1);
});

test('failed loads notify only current users and retry only after all old users leave', () => {
  const loader = loaderFixture(),
    pool = createFacadeTexturePool(loader),
    failures = [],
    a = pool.acquire('/missing.jpg', assert.fail, () => failures.push('a')),
    b = pool.acquire('/missing.jpg', assert.fail, () => failures.push('b'));
  a.release();
  loader.loads[0].fail();
  const c = pool.acquire('/missing.jpg', assert.fail, () => failures.push('c'));
  assert.deepEqual(failures, ['b', 'c']);
  assert.equal(loader.loads.length, 1);
  b.release();
  c.release();
  assert.equal(loader.loads[0].disposed, 1);
  const retry = pool.acquire('/missing.jpg', () => {});
  assert.equal(loader.loads.length, 2);
  loader.loads[1].complete();
  retry.release();
  assert.equal(loader.loads[1].disposed, 1);
});

test('pool disposal releases ready textures and safely retires uncancellable pending images', () => {
  const loader = loaderFixture(),
    pool = createFacadeTexturePool(loader),
    calls = [];
  const a = pool.acquire('/ready.jpg', () => calls.push('ready')),
    b = pool.acquire('/pending.jpg', () => calls.push('stale'));
  loader.loads[0].complete();
  pool.dispose();
  pool.dispose();
  a.release();
  b.release();
  assert.equal(loader.loads[0].disposed, 1);
  assert.equal(pool.stats.references, 0);
  assert.equal(pool.stats.pendingImages, 1);
  loader.loads[1].complete();
  assert.deepEqual(calls, ['ready']);
  assert.equal(loader.loads[1].disposed, 1);
  assert.equal(pool.stats.imageEntries, 0);
  assert.throws(() => pool.acquire('/another.jpg', () => {}), /disposed/);
});

test('a reentrant replacement cannot be deleted by the previous image completion', () => {
  const loader = loaderFixture(),
    pool = createFacadeTexturePool(loader);
  let replacement;
  const old = pool.acquire('/photo.jpg', () => {
    old.release();
    replacement = pool.acquire('/photo.jpg', () => {});
  });
  loader.loads[0].complete();
  assert.equal(loader.loads[0].disposed, 1);
  assert.equal(pool.stats.imageEntries, 1);
  assert.equal(pool.stats.pendingImages, 1);
  loader.loads[1].complete();
  replacement.release();
  assert.equal(loader.loads[1].disposed, 1);
  assert.equal(pool.stats.imageEntries, 0);
});

test('synchronous cache success and failure retain correct ownership', () => {
  for (const success of [true, false]) {
    const texture = new THREE.Texture();
    let calls = 0,
      disposed = 0;
    texture.addEventListener('dispose', () => disposed++);
    const pool = createFacadeTexturePool({
      load(url, ready, progress, error) {
        if (success) ready(texture);
        else error();
        return texture;
      },
    });
    const owner = pool.acquire(
      '/photo.jpg',
      () => calls++,
      () => calls++,
    );
    assert.equal(calls, 1);
    assert.equal(disposed, 0);
    owner.release();
    assert.equal(disposed, 1);
    assert.equal(pool.stats.imageEntries, 0);
  }
});
