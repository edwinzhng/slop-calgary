const OBSERVED_SITE = {
  id: 'city-signal-1109001112',
  x: -159.88,
  z: 886.47,
  kind: 'Traffic signal',
  firstRoad: '17 AVENUE',
  secondRoad: '5 STREET',
  quadrant: 'SW',
  pedestrianButtons: false,
  pedestrianTimer: true,
  accessible: true,
};
const SOURCE_ROAD = {
  id: 'osm-way-233756425-0',
  name: '17 Avenue SW',
  kind: 'secondary',
  oneway: 'no',
  bridge: false,
  tunnel: false,
  lanes: 4,
  layer: 0,
  surface: 'asphalt',
};
const SOURCE_POINTS = [
  [-163.6, 886.1],
  [-153.5, 886.2],
];
const near = (value, expected, tolerance = 1e-9) =>
  Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
const fieldsMatch = (value, expected) =>
  value && Object.entries(expected).every(([key, field]) => value[key] === field);

function observedHorizontalHead(signal) {
  const sites = signal.citySites || [signal.citySite],
    source = signal.sourceRoad;
  return (
    sites.some((site) => fieldsMatch(site, OBSERVED_SITE)) &&
    signal.inventoryDerived === true &&
    signal.roadId === SOURCE_ROAD.id &&
    signal.road === SOURCE_ROAD.name &&
    signal.roadKind === SOURCE_ROAD.kind &&
    fieldsMatch(source, SOURCE_ROAD) &&
    source.points?.length === SOURCE_POINTS.length &&
    SOURCE_POINTS.every(
      (point, i) =>
        source.points[i]?.length === 2 && point.every((value, axis) => source.points[i][axis] === value),
    ) &&
    signal.sign === 1 &&
    signal.axis === 0 &&
    signal.travelX < -0.99 &&
    Math.abs(signal.travelZ) < 0.05 &&
    near(signal.x, -154.45774839842898) &&
    near(signal.z, 886.1905173425898) &&
    near(signal.travelX, -0.9999509888009116, 1e-12) &&
    near(signal.travelZ, -0.009900504839615243, 1e-12) &&
    near(signal.width, 12.8, 1e-12) &&
    near(signal.junction?.[0], -162.55735140771637) &&
    near(signal.junction?.[1], 886.110323253389)
  );
}

/** Orientation: lvl5, Mapillary 911282776106415, 2018-07-16, CC BY-SA 4.0.
 * https://www.mapillary.com/app/?pKey=911282776106415&focus=photo
 * Dimensions remain inferred. The source camera is about 6 m from the review
 * pose with uncalibrated optics; other approaches/current conditions remain unverified.
 */
export function signalHeadLayout(signal) {
  const horizontal = !!observedHorizontalHead(signal);
  return {
    horizontal,
    housingWidth: horizontal ? 1.1 : 0.4,
    housingHeight: horizontal ? 0.4 : 1.1,
    backingWidth: horizontal ? 1.02 : 0.32,
    backingHeight: horizontal ? 0.32 : 1.02,
    // Keep the previous housing top and mast attachment when swapping dimensions.
    centerOffsetY: horizontal ? 0.35 : 0,
    lensOffsets: [0, 1, 2].map((i) =>
      horizontal
        ? [-signal.travelZ * (i - 1) * 0.31, 0, signal.travelX * (i - 1) * 0.31]
        : [0, (1 - i) * 0.31, 0],
    ),
  };
}

export function signalLensIndex(phase) {
  return phase === 'red' ? 0 : phase === 'amber' ? 1 : 2;
}
