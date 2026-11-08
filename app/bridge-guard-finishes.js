// Dated observations of the two Blackfoot carriageways. These select the
// barrier form; the display dimensions below are inferred, not measurements.
export const BLACKFOOT_GUARD_REFERENCES = Object.freeze([
  Object.freeze({ url: 'https://kartaview.org/details/467309/4930', capturedAt: '2017-06-12' }),
  Object.freeze({ url: 'https://kartaview.org/details/162955/4742', capturedAt: '2017-04-25' }),
]);

const sources = new Map([
  ['osm-way-52460453-0', { points: '[[3050.4,1514.7],[2952.5,1627.6]]', lanes: 0 }],
  ['osm-way-52460663-0', { points: '[[2957.9,1634.2],[3055.2,1521.1]]', lanes: 2 }],
]);
const concrete = Object.freeze({ width: 0.32, lower: 0.1, concreteTop: 0.9 });
const outer = Object.freeze({
  ...concrete,
  upper: 1.1,
  capHeight: 1.055,
  capRadius: 0.045,
  postRadius: 0.03,
  postSpacing: 3.2,
});
const inner = Object.freeze({ ...concrete, upper: concrete.concreteTop, capHeight: null });

export function observedBridgeGuardProfile(plan, side) {
  if (!plan.drive || plan.rail || plan.type !== 'girder' || plan.roads?.length !== 1) return null;
  const road = plan.roads[0],
    source = sources.get(road.id);
  if (
    !source ||
    road.kind !== 'secondary' ||
    road.oneway !== 'yes' ||
    road.bridge !== true ||
    road.tunnel !== false ||
    road.layer !== 1 ||
    road.lanes !== source.lanes ||
    JSON.stringify(road.points) !== source.points
  )
    return null;
  const forward = JSON.stringify(plan.points) === source.points;
  if (!forward && JSON.stringify(plan.points?.slice().reverse()) !== source.points) return null;
  // Both source ways follow traffic. Their right edges face away from the
  // parallel carriageway; reversing a joined plan also reverses that side.
  return side === (forward ? 1 : -1) ? outer : inner;
}

export function bridgeGuardCapStations(plan, from, to, spacing) {
  const result = [];
  for (
    let i = Math.max(0, Math.ceil((from * plan.length) / spacing - 1e-9));
    i * spacing < to * plan.length - 1e-8;
    i++
  )
    result.push((i * spacing) / plan.length);
  if (to === 1) result.push(1);
  return result;
}
