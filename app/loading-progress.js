// Yield past a paint, with a timer fallback so background tabs keep loading.
export function yieldLoadingFrame() {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(timeout);
      setTimeout(resolve, 0);
    });
  });
}

export function createLoadingProgress(document) {
  let lastLabel;
  return (fraction, label, measured = false) => {
    const fill = document.getElementById('load-progress');
    fill.parentElement.classList.toggle('is-indeterminate', !measured);
    fill.style.transform = measured ? `scaleX(${Math.max(0, Math.min(1, fraction))})` : '';
    const changed = label !== lastLabel;
    if (changed) document.getElementById('load-status').textContent = label;
    lastLabel = label;
    if (!measured) return yieldLoadingFrame();
  };
}
