import { DRIVABLE } from './geo.js';
import { municipalPathwayFinish } from './pathway-finishes.js';
import { unpackMapDataTransport } from './map-data-transport.js';

export const ROAD_ATTRIBUTES_URL = new URL('../data/calgary-road-attributes.json', import.meta.url);

export async function loadRoadAttributes() {
  const response = await fetch(ROAD_ATTRIBUTES_URL);
  if (!response.ok) throw new Error(`Calgary road attributes could not be loaded (${response.status})`);
  return unpackMapDataTransport(await response.json());
}

export function applyRoadAttributes(data, attributes) {
  if (
    attributes.meta.osmBaseTimestamp !== data.meta.generatedAt ||
    attributes.meta.mappedRoadCount !== data.roads.length
  )
    throw new Error('Road attributes and source map snapshots differ; rebuild their matching audit');
  const ways = new Map(attributes.ways.map((way) => [String(way.sourceWayId), way]));
  const inferredModels = new Map((attributes.inferredRoadModels || []).map((model) => [model.id, model]));
  const stats = { matched: 0, surfaces: 0, widths: 0, crossingWays: 0, crossingMarkings: 0 };
  for (const road of data.roads) {
    delete road.inferredLanes;
    const sourceId = /^osm-way-(\d+)-\d+$/.exec(road.id)?.[1];
    const record = ways.get(sourceId);
    if (!record || record.kind !== road.kind) continue;
    road.sourceTags = record.tags;
    road.surface = record.tags.surface;
    road.footway = record.tags.footway;
    if (Number.isFinite(record.widthMetres) && record.widthMetres >= 0.3 && record.widthMetres <= 40) {
      road.width = record.widthMetres;
      stats.widths++;
    }
    const model = inferredModels.get(road.id),
      expected = model?.expected;
    if (
      expected &&
      !(Number(road.lanes) > 0) &&
      !Number.isFinite(road.width) &&
      Number.isInteger(model.lanes) &&
      model.lanes > 0 &&
      model.lanes <= 8 &&
      expected.kind === road.kind &&
      expected.oneway === road.oneway &&
      expected.bridge === road.bridge &&
      expected.layer === road.layer &&
      expected.lanes === road.lanes &&
      Array.isArray(expected.points) &&
      JSON.stringify(expected.points) === JSON.stringify(road.points)
    )
      road.inferredLanes = model.lanes;
    if (road.surface) stats.surfaces++;
    if (isMappedCrossing(road)) stats.crossingWays++;
    if (record.tags['crossing:markings']) stats.crossingMarkings++;
    stats.matched++;
  }
  return stats;
}

export function isMappedCrossing(road) {
  return (
    road.footway === 'crossing' ||
    road.sourceTags?.footway === 'crossing' ||
    road.sourceTags?.cycleway === 'crossing'
  );
}

export function crossingMarking(road) {
  if (!isMappedCrossing(road)) return null;
  const tags = road.sourceTags || {};
  const marking = tags['crossing:markings'];
  if (marking === 'no' || tags.crossing === 'unmarked' || tags.crossing === 'informal') return null;
  if (['lines', 'ladder', 'ladder:skewed', 'zebra', 'lines;dots', 'dots', 'surface'].includes(marking))
    return marking;
  // "Uncontrolled" describes the signal priority, not the existence of paint.
  if (marking === 'yes' || tags.crossing === 'marked') return 'marked-unspecified';
  return null;
}

export function roadSurfaceKind(road) {
  const municipal = municipalPathwayFinish(road);
  if (municipal) return municipal.material;
  const surface = road.surface || road.sourceTags?.surface;
  if (surface === 'asphalt') return 'asphalt';
  if (['concrete', 'concrete:plates', 'concrete:lanes'].includes(surface)) return 'concrete';
  if (['paving_stones', 'brick', 'tiles'].includes(surface)) return 'pavers';
  if (['gravel', 'fine_gravel', 'pebblestone', 'compacted'].includes(surface)) return 'gravel';
  if (['dirt', 'ground', 'unpaved', 'sand', 'woodchips'].includes(surface)) return 'dirt';
  if (['grass', 'grass_paver'].includes(surface)) return 'grass';
  if (surface === 'wood') return 'wood';
  if (surface === 'metal') return 'metal';
  return DRIVABLE.has(road.kind) || isMappedCrossing(road) ? 'asphalt' : 'concrete';
}
