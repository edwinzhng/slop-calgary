import inventory from '../data/calgary-bridge-lighting.json' with { type: 'json' };
import { sampleBridge } from './bridge-connections.js';

// PCL's completed photograph shows luminaires recessed under transverse arch
// beams. Inventory provides XY/type/CCT, not Z or direction. Only that verified
// mounting family is represented; the SH canopy head remains unresolved.
export function collectSurveyedBridgeLighting(surfaces) {
  const plan =
    surfaces.plans.find((item) =>
      item.sourceRoads?.some((road) => road.id === inventory.meta.sourceBridge),
    ) || surfaces.plans.find((item) => item.name === '9 Avenue SE Bridge');
  const skipped = inventory.meta.skipped.map((item) => ({ ...item }));
  if (!plan) return { groups: [], fixtures: [], skipped, sourceHeads: 0 };
  const a = plan.points[0],
    b = plan.points.at(-1),
    length = Math.hypot(b[0] - a[0], b[1] - a[1]),
    dx = (b[0] - a[0]) / length,
    dz = (b[1] - a[1]) / length,
    fixtures = inventory.records
      .filter((row) => row.type === 'SJ')
      .map((row) => ({
        ...row,
        t: ((row.x - a[0]) * dx + (row.z - a[1]) * dz) / length,
        offset: (row.z - a[1]) * dx - (row.x - a[0]) * dz,
        watts: inventory.types[row.type].watts,
        kelvin: inventory.types[row.type].kelvin,
        heightInferred: true,
        directionInferred: true,
      }))
      .sort((left, right) => left.t - right.t),
    stations = [],
    middle = sampleBridge(plan, 0.5),
    group = { name: plan.name, x: middle.x, z: middle.z, beams: [] };
  // Group by actual measured longitudinal proximity, never by an invented
  // evenly spaced array. The furthest adjustment is a tiny unlit bracket;
  // each optical centre preserves its original XY exactly.
  for (const fixture of fixtures) {
    let station = stations.at(-1);
    if (!station || (fixture.t - station.fixtures[0].t) * length > 0.55) {
      station = { fixtures: [] };
      stations.push(station);
    }
    station.fixtures.push(fixture);
  }
  const beam = (a, b, radius, kind, options = {}) =>
    group.beams.push({ a, b, radius, kind, color: 0, emissive: false, ...options });
  // Match the existing 28-segment, 7.5m-rise schematic arch, including its
  // piecewise-linear vertices, so both crossbeam ends physically meet a rib.
  const archY = (t) => {
    const u = Math.max(0, Math.min(1, t)) * 28,
      i = Math.min(27, Math.floor(u)),
      f = u - i;
    return (
      plan.level + 7.5 * (Math.sin((Math.PI * i) / 28) * (1 - f) + Math.sin((Math.PI * (i + 1)) / 28) * f)
    );
  };
  for (const station of stations) {
    station.t = station.fixtures.reduce((sum, row) => sum + row.t, 0) / station.fixtures.length;
    station.y = archY(station.t);
    const p = sampleBridge(plan, station.t),
      half = plan.width / 2 - 1.6,
      at = (side) => [p.x - p.dz * side * half, station.y, p.z + p.dx * side * half];
    beam(at(-1), at(1), 0.21, 'surveyed-flood-crossbeam', { bodyColor: 0xcbd1cf });
    for (const fixture of station.fixtures) {
      const y = station.y - 0.25;
      fixture.height = y;
      fixture.direction = [0, -1, 0];
      fixture.station = station.t;
      beam(
        [fixture.x, y + 0.07, fixture.z],
        [fixture.x, y + 0.2, fixture.z],
        0.13,
        'surveyed-flood-housing',
        { sourceId: fixture.id, bodyColor: 0x52605e },
      );
      // The surveyed point may differ from the inferred beam station by up to
      // centimetres. A short bracket connects it without moving the head.
      const along = (station.t - fixture.t) * length;
      beam(
        [fixture.x, y + 0.16, fixture.z],
        [fixture.x + dx * along, station.y, fixture.z + dz * along],
        0.045,
        'surveyed-flood-bracket',
        { sourceId: fixture.id, bodyColor: 0x8d9995 },
      );
      beam([fixture.x, y, fixture.z], [fixture.x, y + 0.035, fixture.z], 0.105, 'surveyed-flood-lens', {
        sourceId: fixture.id,
        type: fixture.type,
        watts: fixture.watts,
        kelvin: fixture.kelvin,
        color: 0xffd2a0,
        emissive: true,
        bodyColor: 0x64716d,
        capped: true,
      });
    }
  }
  return { groups: [group], fixtures, skipped, sourceHeads: inventory.records.length, stations };
}
