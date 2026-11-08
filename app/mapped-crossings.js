import * as THREE from 'three/webgpu';
import { SpatialIndex, bounds, nearestOnSegment, DRIVABLE } from './geo.js';
import { crossingMarking, isMappedCrossing } from './road-attributes.js';
import { createRoadPaintMaterial, expandRoadPaintBounds } from './reference-streets.js';
import { addSpatialBatches } from './static-batches.js';

export function collectMappedCrossings(roads) {
  const records = [],
    index = new SpatialIndex(40),
    seen = new Set();
  let duplicates = 0;
  for (const road of roads) {
    if (!isMappedCrossing(road) || road.tunnel || road.bridge || Number(road.layer || 0) !== 0) continue;
    const points = road.points;
    if (points.length < 2) continue;
    const key = points.map(([x, z]) => `${Math.round(x * 10)},${Math.round(z * 10)}`).join('/');
    const reverse = points
      .slice()
      .reverse()
      .map(([x, z]) => `${Math.round(x * 10)},${Math.round(z * 10)}`)
      .join('/');
    if (seen.has(key) || seen.has(reverse)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    let length = 0;
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < 0.02) continue;
      const segment = { a, b, start: length, length: d, ux: (b[0] - a[0]) / d, uz: (b[1] - a[1]) / d };
      length += d;
      segments.push(segment);
    }
    if (!segments.length) continue;
    const width = Number.isFinite(road.width) ? road.width : 3;
    const record = {
      roadId: road.id,
      road,
      segments,
      length,
      width,
      marking: crossingMarking(road),
      inferredWidth: !Number.isFinite(road.width),
    };
    records.push(record);
    for (const segment of segments) index.insert({ ...segment, record }, bounds([segment.a, segment.b]));
  }
  return {
    records,
    duplicates,
    // Match an inferred crossing's vehicle axis to an actual transverse path.
    // Unmarked and unspecified crossings count as source coverage too.
    covers(x, z, dx, dz, radius = 8) {
      for (const segment of index.near(x, z, radius)) {
        if (Math.abs(segment.ux * dx + segment.uz * dz) > 0.55) continue;
        if (nearestOnSegment(x, z, segment.a, segment.b).distance <= radius) return true;
      }
      return false;
    },
  };
}

export function crossingStrokes(crossing) {
  const result = [],
    marking = crossing.marking,
    width = crossing.width;
  if (!marking || marking === 'surface') return result;
  const add = (a, b, paintWidth) => result.push({ a, b, width: paintWidth });
  const along = (at, offset = 0) => {
    const segment = crossing.segments.find((s) => at <= s.start + s.length) || crossing.segments.at(-1);
    const t = Math.max(0, Math.min(1, (at - segment.start) / segment.length));
    return [
      segment.a[0] + (segment.b[0] - segment.a[0]) * t - segment.uz * offset,
      segment.a[1] + (segment.b[1] - segment.a[1]) * t + segment.ux * offset,
    ];
  };
  const boundingLines = ['lines', 'lines;dots', 'ladder', 'ladder:skewed', 'marked-unspecified'].includes(
    marking,
  );
  if (boundingLines)
    for (const s of crossing.segments)
      for (const offset of [-width / 2, width / 2])
        add(
          [s.a[0] - s.uz * offset, s.a[1] + s.ux * offset],
          [s.b[0] - s.uz * offset, s.b[1] + s.ux * offset],
          0.14,
        );
  if (['ladder', 'ladder:skewed', 'zebra'].includes(marking))
    for (let at = 0.6; at < crossing.length - 0.3; at += 1.05) {
      // The tag defines diagonal connecting bars but supplies no angle. The
      // small skew and all stroke dimensions remain explicitly inferred.
      const skew = marking === 'ladder:skewed' ? Math.min(0.45, width * 0.15) : 0;
      add(
        along(Math.max(0, at - skew), -width / 2),
        along(Math.min(crossing.length, at + skew), width / 2),
        0.4,
      );
    }
  if (['dots', 'lines;dots'].includes(marking))
    for (let at = 0.4; at < crossing.length - 0.2; at += 0.65)
      for (const offset of [-width / 2, width / 2]) {
        const p = along(at, offset),
          q = along(Math.min(at + 0.13, crossing.length), offset);
        add(p, q, 0.13);
      }
  return result;
}

export function buildMappedCrossingMarkings(scene, roads, context) {
  const coverage = collectMappedCrossings(roads);
  // Resolve the tiny set of local carriageway segments once per crossing. The
  // full road index includes thousands of footways; querying it for every paint
  // endpoint/midpoint was several seconds of redundant startup work.
  const driveIndex = new SpatialIndex(40);
  for (const segment of context.roadIndex.segments || []) {
    if (!DRIVABLE.has(segment.road.kind) || segment.road.transitOnly) continue;
    const dx = segment.b[0] - segment.a[0],
      dz = segment.b[1] - segment.a[1];
    driveIndex.insert(
      { ...segment, dx, dz, inverseLength2: 1 / (dx * dx + dz * dz) },
      bounds([segment.a, segment.b]),
    );
  }
  let localRoads = null;
  let sampleCache = new Map();
  const position = [],
    side = [],
    paint = [],
    colours = [],
    indices = [];
  const stats = {
    sourceCrossings: coverage.records.length,
    duplicates: coverage.duplicates,
    unmarked: 0,
    unspecified: 0,
    surfaceOnly: 0,
    paintedCrossings: 0,
    inferredWidths: 0,
    paintQuads: 0,
    conflictingMarkingTags: 0,
    markings: {},
  };
  const white = new THREE.Color(0xe4e0d5);
  const sample = (x, z) => {
    // Test the coordinates the GPU actually receives, including Float32
    // rounding at polygon edges; an accepted double can round inside a curb.
    x = Math.fround(x);
    z = Math.fround(z);
    const key = `${Math.round(x * 1e5)},${Math.round(z * 1e5)}`;
    if (sampleCache.has(key)) return sampleCache.get(key);
    const finish = (result) => {
      sampleCache.set(key, result);
      return result;
    };
    let road;
    if (localRoads) {
      let best = Infinity;
      for (const segment of localRoads) {
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - segment.a[0]) * segment.dx + (z - segment.a[1]) * segment.dz) * segment.inverseLength2,
          ),
        );
        const dx = x - segment.a[0] - t * segment.dx,
          dz = z - segment.a[1] - t * segment.dz,
          distance2 = dx * dx + dz * dz;
        if (distance2 < best) {
          best = distance2;
          road = segment;
        }
      }
      if (road) road = { road: road.road, width: road.width, distance: Math.sqrt(best) };
    } else road = context.roadIndex.nearest(x, z, true, 24);
    if (!road || road.distance > road.width / 2 + 0.15 || road.road.tunnel || road.road.bridge)
      return finish(null);
    // Curbs and traffic islands remain unpainted. Their geometry is municipal.
    const pavement = context.groundSurfaces?.groundHeight(x, z);
    const offset = context.terrain?.offsetAt(x, z) || 0;
    if (pavement != null && pavement - offset > 0.25) return finish(null);
    return finish({ y: context.surfaces.surfaceHeight(x, z, road.road) + 0.018 });
  };
  for (const record of coverage.records) {
    if (!record.marking) {
      if (
        ['unmarked', 'informal'].includes(record.road.sourceTags?.crossing) &&
        record.road.sourceTags?.['crossing:markings'] &&
        record.road.sourceTags['crossing:markings'] !== 'no'
      )
        stats.conflictingMarkingTags++;
      stats.unmarked++;
      continue;
    }
    if (record.marking === 'surface') {
      stats.surfaceOnly++;
      continue;
    }
    if (record.marking === 'marked-unspecified') stats.unspecified++;
    stats.markings[record.marking] = (stats.markings[record.marking] || 0) + 1;
    if (record.inferredWidth) stats.inferredWidths++;
    const box = bounds(record.road.points),
      cx = (box.minX + box.maxX) / 2,
      cz = (box.minZ + box.maxZ) / 2;
    localRoads = context.roadIndex.segments
      ? [
          ...driveIndex.near(
            cx,
            cz,
            Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2 + record.width / 2 + 24,
          ),
        ]
      : null;
    sampleCache = new Map();
    const first = indices.length;
    for (const stroke of crossingStrokes(record)) {
      const dx = stroke.b[0] - stroke.a[0],
        dz = stroke.b[1] - stroke.a[1],
        length = Math.hypot(dx, dz);
      if (length < 0.02) continue;
      const ux = dx / length,
        uz = dz / length,
        segments = Math.ceil(length / 0.6);
      for (let i = 0; i < segments; i++) {
        const t0 = i / segments,
          t1 = (i + 1) / segments;
        const ax = stroke.a[0] + dx * t0,
          az = stroke.a[1] + dz * t0,
          bx = stroke.a[0] + dx * t1,
          bz = stroke.a[1] + dz * t1;
        const sx = (-uz * stroke.width) / 2,
          sz = (ux * stroke.width) / 2,
          n = position.length / 3;
        const corners = [
          [ax - sx, az - sz, -1],
          [ax + sx, az + sz, 1],
          [bx + sx, bz + sz, 1],
          [bx - sx, bz - sz, -1],
        ];
        const samples = corners.map(([x, z]) => sample(x, z));
        // A centreline can clear an island while the expanded stripe touches
        // its curb. Keep every corner and edge midpoint on the carriageway.
        if (samples.some((s) => !s) || !sample((ax + bx) / 2, (az + bz) / 2)) continue;
        if (
          corners.some((a, j) => {
            const b = corners[(j + 1) % 4];
            return !sample((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          })
        )
          continue;
        for (let j = 0; j < 4; j++) {
          const [x, z, s] = corners[j];
          position.push(x, samples[j].y, z);
          side.push(sx * s, sz * s);
          paint.push(0, 1, 1);
          colours.push(white.r, white.g, white.b);
        }
        indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
      }
    }
    if (indices.length > first) stats.paintedCrossings++;
  }
  stats.paintQuads = position.length / 12;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      position.map((_, i) => (i % 3 === 1 ? 1 : 0)),
      3,
    ),
  );
  geometry.setAttribute('side', new THREE.Float32BufferAttribute(side, 2));
  geometry.setAttribute('paint', new THREE.Float32BufferAttribute(paint, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  const material = createRoadPaintMaterial(),
    name = 'Mapped Calgary crossing markings; finish dimensions inferred',
    mesh =
      context.spatialBatches === false
        ? new THREE.Mesh(geometry, material)
        : addSpatialBatches(scene, geometry, material, name, { expandBounds: expandRoadPaintBounds });
  if (context.spatialBatches === false) {
    mesh.name = name;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  return {
    ...coverage,
    mesh,
    stats,
    dispose() {
      scene.remove(mesh);
      if (mesh.isBatchedMesh) mesh.dispose();
      else mesh.geometry.dispose();
      material.dispose();
    },
  };
}
