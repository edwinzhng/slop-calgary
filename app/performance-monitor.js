// Bounded diagnostics: CPU submission time and frame intervals are separate.
// Enabled with ?profile=1; the normal animation path does not time each stage.
export function createPerformanceMonitor({
  enabled = false,
  capacity = 600,
  clock = () => performance.now(),
} = {}) {
  const stages = new Map();
  const start = clock();
  let phaseStart = start;
  const startup = {};
  function add(name, milliseconds) {
    if (!enabled || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    let stage = stages.get(name);
    if (!stage) {
      stage = { values: new Float32Array(capacity), cursor: 0, count: 0, total: 0 };
      stages.set(name, stage);
    }
    stage.values[stage.cursor] = milliseconds;
    stage.cursor = (stage.cursor + 1) % capacity;
    stage.count++;
    stage.total += milliseconds;
  }
  const round = (v) => Math.round(v * 100) / 100;
  return {
    enabled,
    startup,
    stamp: () => (enabled ? clock() : 0),
    end(name, stamp) {
      if (enabled) add(name, clock() - stamp);
    },
    add,
    phase(name) {
      const now = clock();
      startup[name] = round(now - phaseStart);
      phaseStart = now;
    },
    snapshot() {
      if (!enabled) return undefined;
      const result = {};
      for (const [name, stage] of stages) {
        const values = Array.from(stage.values.subarray(0, Math.min(stage.count, capacity))).sort(
          (a, b) => a - b,
        );
        const count = values.length;
        result[name] = {
          samples: count,
          calls: stage.count,
          median: round(values[Math.floor(count * 0.5)] || 0),
          p95: round(values[Math.min(count - 1, Math.floor(count * 0.95))] || 0),
          max: round(values.at(-1) || 0),
          mean: round(values.reduce((sum, value) => sum + value, 0) / (count || 1)),
          over16ms: values.filter((value) => value > 16.7).length,
          over33ms: values.filter((value) => value > 33.4).length,
        };
      }
      return result;
    },
  };
}
