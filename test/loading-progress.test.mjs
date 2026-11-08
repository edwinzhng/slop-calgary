import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadingProgress, yieldLoadingFrame } from '../app/loading-progress.js';

test('loading advances in a background tab without an animation frame', async (t) => {
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => delete globalThis.requestAnimationFrame);
  await yieldLoadingFrame();
});

test('stage labels paint before work and only measurable work fills the bar', async (t) => {
  let frame;
  globalThis.requestAnimationFrame = (callback) => {
    frame = callback;
  };
  t.after(() => delete globalThis.requestAnimationFrame);
  const classes = new Set();
  const fill = {
    style: {},
    parentElement: {
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };
  const status = {};
  const progress = createLoadingProgress({
    getElementById: (id) => (id === 'load-progress' ? fill : status),
  });
  const paint = progress(0.7, 'Building streets');
  assert.equal(status.textContent, 'Building streets');
  assert.equal(classes.has('is-indeterminate'), true);
  assert.equal(fill.style.transform, '');
  let finished = false;
  paint.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  frame();
  await paint;
  assert.equal(progress(0.4, 'Warming movement', true), undefined);
  assert.equal(classes.has('is-indeterminate'), false);
  assert.equal(fill.style.transform, 'scaleX(0.4)');
  progress(2, 'Ready', true);
  assert.equal(fill.style.transform, 'scaleX(1)');
});
