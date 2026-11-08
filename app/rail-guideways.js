// RJC's Sunalta guideway description specifies direct fixation to concrete
// plinths. These display dimensions fit the existing gauge and rail profile;
// they are inferred, not surveyed construction dimensions.
export const RAIL_PROFILE = Object.freeze({
  halfGauge: 0.7175,
  bedTop: 0.025,
  railCenter: 0.17,
  railRadius: 0.048,
  plinthTop: 0.12,
  plinthHalfWidth: 0.21,
});

const sourceTracks = new Map([
  [
    'osm-way-53529046-0',
    '[[-2663.5,202.3],[-2579.6,139],[-2553.5,121.7],[-2526.2,108.9],[-2500,100.3],[-2472.8,94.7],[-2446.2,91.7],[-2428.6,92],[-2388.3,94.4],[-2264,100.3],[-2036.6,109.4]]',
  ],
  [
    'osm-way-133892825-0',
    '[[-1375.1,-104.1],[-1384.5,-101],[-1392.5,-97.5],[-1414,-86.4],[-1422.3,-81.2],[-1435.3,-71.8],[-1454.1,-54.6],[-1535.7,33.8],[-1559.7,57.2],[-1573.6,68.4],[-1587.8,78.8],[-1610.4,91.6],[-1637.8,103.7],[-1665.6,112.3],[-1689.6,116.9],[-1709.3,118.3],[-1740.8,118.5],[-1840.4,113.6]]',
  ],
  ['osm-way-787281246-0', '[[-1793.1,120.4],[-1840.4,113.6]]'],
  ['osm-way-787281247-0', '[[-1840.8,118.2],[-1792.9,116]]'],
  ['osm-way-1225419499-0', '[[-1840.4,113.6],[-2036.4,105.3]]'],
  [
    'osm-way-1225419507-0',
    '[[-1840.8,118.2],[-1739.6,122.9],[-1708,123.1],[-1688.8,121.2],[-1663.9,116.5],[-1635.2,107.2],[-1622.6,102.2],[-1608.7,95.6],[-1583.4,81.2],[-1556.6,60.3],[-1534.1,38.4],[-1451.1,-51.4],[-1433.2,-67.9],[-1422.7,-75.6],[-1412.6,-82.2],[-1390.4,-93.9],[-1381.8,-97.5],[-1373.7,-100.1]]',
  ],
  [
    'osm-way-1225419515-0',
    '[[-2036.4,105.3],[-2263.3,96.3],[-2428.7,87.6],[-2446.8,87.9],[-2473.3,90.5],[-2501.3,96.1],[-2528.9,105.3],[-2556.4,118.5],[-2581.5,135.2],[-2606.5,153.5],[-2643.2,182.1],[-2663.5,197.1]]',
  ],
  ['osm-way-1225419521-0', '[[-2036.6,109.4],[-1840.8,118.2]]'],
]);

export function railGuidewayFinish(roads) {
  if (!Array.isArray(roads) || !roads.length || new Set(roads.map((r) => r.id)).size !== roads.length)
    return null;
  return roads.every(
    (road) =>
      road.kind === 'light_rail' &&
      road.bridge === true &&
      road.tunnel === false &&
      sourceTracks.has(road.id) &&
      JSON.stringify(road.points) === sourceTracks.get(road.id),
  )
    ? 'direct-fixation'
    : null;
}
