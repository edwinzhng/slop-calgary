/** Apply current construction boundaries without replacing the source map. */
export function applySiteOverlays(data, overlay) {
  for (const key of ['roads', 'waters']) {
    const patches = new Map((overlay[key] || []).map((p) => [p.id, p.parts]));
    data[key] = data[key].flatMap((record) => patches.get(record.id) ?? [record]);
  }
  return data;
}
