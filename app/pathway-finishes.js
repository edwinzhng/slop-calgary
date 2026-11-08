import refinements from '../data/calgary-pathway-finishes.json' with { type: 'json' };

const byId = new Map(refinements.ways.map((record) => [record.id, record]));
const groundKinds = new Set(['footway', 'cycleway', 'path', 'pedestrian']);

/** A City inventory finish refines only its unchanged original ground path. */
export function municipalPathwayFinish(road, record = byId.get(road.id)) {
  if (
    !record ||
    road.id !== record.id ||
    record.material !== 'asphalt' ||
    !groundKinds.has(record.kind) ||
    ![null, 'paved'].includes(record.sourceSurface) ||
    road.kind !== record.kind ||
    road.bridge ||
    road.tunnel ||
    road.layer ||
    (road.sourceTags?.bridge && road.sourceTags.bridge !== 'no') ||
    (road.sourceTags?.tunnel && road.sourceTags.tunnel !== 'no') ||
    Number(road.sourceTags?.layer || 0) !== 0 ||
    road.footway === 'crossing' ||
    road.sourceTags?.footway === 'crossing' ||
    road.sourceTags?.cycleway === 'crossing' ||
    road.sourceTags?.indoor === 'yes' ||
    (road.sourceTags?.surface != null && road.sourceTags.surface !== record.sourceSurface) ||
    (road.surface || road.sourceTags?.surface || null) !== record.sourceSurface ||
    !Array.isArray(road.points) ||
    !Array.isArray(record.points) ||
    record.points.length < 2 ||
    road.points.length !== record.points.length ||
    !road.points.every(
      (point, i) =>
        Array.isArray(point) && point[0] === record.points[i][0] && point[1] === record.points[i][1],
    )
  )
    return null;
  return record;
}
