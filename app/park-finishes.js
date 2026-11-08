// The original inventory kind remains authoritative for layer height/support.
// These are material-class interpretations, not photographed colours, measured
// joint layouts, current-condition claims or new polygon geometry.
const finishes = Object.freeze({
  'ARTIFICIAL TURF': 'turf',
  'WOOD CHIPS': 'dirt',
  PLASTIC: 'polymer',
  RUBBER: 'polymer',
  'RED SHALE': 'red-shale',
  FLAGSTONE: 'stone',
  GRANITE: 'stone',
  'TURF BLOCK PAVERS': 'turf-pavers',
  'PRECAST CONCRETE PAVERS': 'pavers',
});

// Compatible with the existing aggregate shader. These authored palette values
// are interpretations of the material class; they are not measured site colours.
export const PARK_AGGREGATE_FINISHES = Object.freeze({
  gravel: Object.freeze([0xa6a394, 1]),
  dirt: Object.freeze([0x8c806a, 1]),
  'red-shale': Object.freeze([0xa47760, 1]),
  polymer: Object.freeze([0x555c58, 0.97]),
  stone: Object.freeze([0x96998f, 0.91]),
});

export function parkPavingFinish(polygon) {
  return finishes[polygon.sourceMaterial] || polygon.kind;
}

// Remove only byte-identical source-asset surfaces. Plan containment or a higher
// overlapping polygon is insufficient: a lower face can remain visible obliquely.
// Keep both source records in the support index; omit only repeated render work.
export function exactParkPavingKey(polygon) {
  if (typeof polygon.sourceAsset !== 'string' || !polygon.sourceAsset.trim()) return null;
  return JSON.stringify([
    polygon.sourceAsset,
    polygon.sourceMaterial ?? null,
    polygon.assetType ?? null,
    polygon.kind,
    polygon.ring,
    polygon.holes || [],
  ]);
}
