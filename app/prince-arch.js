import * as THREE from 'three/webgpu';
import { bounds, nearestOnSegment, SpatialIndex } from './geo.js';
import evidence from '../data/prince-arch-evidence.json' with { type: 'json' };

export const PRINCE_ARCH_ID = 'osm-way-127950680-0';
export const PRINCE_ARCH_LOWER_PATH_ID = 'osm-way-728793636-0';
export const PRINCE_ARCH_LIMITS = Object.freeze({
  // Only span and width come from the owner. All other dimensions are explicitly
  // bounded modelling choices, not measured dimensions or an accessibility claim.
  span: 12.3,
  width: 2.85,
  rise: 0.45,
  deckThickness: 0.16,
  girderDepth: 0.42,
  girderWidth: 0.2,
  guardHeight: 1.08,
  guardWidth: 0.065,
  pieceLength: 0.65,
  stepUp: 0.48,
});
const EPS = 1e-8,
  mix = (a, b, t) => a + (b - a) * t,
  clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n)),
  length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),
  pointAt = (a, b, t) => a.map((n, i) => mix(n, b[i], t));

function baryHeight(x, z, a, b, c) {
  const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(det) < EPS) return null;
  const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det,
    v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det,
    w = 1 - u - v;
  return u >= -EPS && v >= -EPS && w >= -EPS ? u * a[1] + v * b[1] + w * c[1] : null;
}
function quadHeight(top, x, z) {
  return baryHeight(x, z, top[0], top[1], top[2]) ?? baryHeight(x, z, top[0], top[2], top[3]);
}
function topQuad(a, b, h0, h1, width) {
  const l = length(a, b),
    nx = ((-(b[1] - a[1]) / l) * width) / 2,
    nz = (((b[0] - a[0]) / l) * width) / 2;
  return [
    [a[0] - nx, h0, a[1] - nz],
    [a[0] + nx, h0, a[1] + nz],
    [b[0] + nx, h1, b[1] + nz],
    [b[0] - nx, h1, b[1] - nz],
  ];
}
function prismCollider(id, top, bottomAt, type, sourceRoadId, outsideHeightAt) {
  const ring = top.map((p) => [p[0], p[2]]);
  ring.push([...ring[0]]);
  const a = [(top[0][0] + top[1][0]) / 2, (top[0][2] + top[1][2]) / 2],
    b = [(top[2][0] + top[3][0]) / 2, (top[2][2] + top[3][2]) / 2];
  const heightAt = (x, z) =>
    quadHeight(top, x, z) ??
    outsideHeightAt?.(x, z) ??
    mix(top[0][1], top[2][1], nearestOnSegment(x, z, a, b).t);
  return {
    id,
    type,
    ring,
    sourceRoadId,
    inferredDimensions: true,
    storefrontAnchor: false,
    minHeight: Math.min(...top.map((p) => bottomAt(p[0], p[2], p[1]))),
    height: Math.max(...top.map((p) => p[1])),
    minHeightAt: (x, z) => bottomAt(x, z, heightAt(x, z)),
    heightAt,
  };
}

/** Isolated source-path owner. This never mutates data, an existing bridge, or
 * the island terrain. The low mapped line remains a separate support layer.
 * The unified City bare-earth terrain constrains attachment levels; deck rise,
 * thickness, rails and current adult headroom remain explicitly inferred.
 */
export function createPrinceArchModel(data, context = {}) {
  const source = evidence.paths[PRINCE_ARCH_ID],
    road = data.roads.find((r) => r.id === PRINCE_ARCH_ID);
  if (!road || JSON.stringify(road.points) !== JSON.stringify(source.points))
    return { ready: false, reason: 'Prince arch source path changed; retain baseline ownership' };
  if (!context.terrain?.princeArchGround)
    return {
      ready: false,
      reason: 'Prince arch requires its unified source-ground adapter before surface construction',
    };
  const groundHeightAt = context.groundHeightAt || ((x, z) => 0.14 + context.terrain.offsetAt(x, z)),
    a = road.points[0],
    b = road.points[1],
    totalLength = length(a, b),
    lowerAt = evidence.lowerPathCrossing.point,
    datum = groundHeightAt(...lowerAt),
    endHeights = road.points.map((p) => groundHeightAt(...p));
  if (!Number.isFinite(datum) || totalLength < PRINCE_ARCH_LIMITS.span)
    return { ready: false, reason: 'Prince arch ground or span context is invalid' };
  const heightAtArc = (s) => {
    const t = clamp(s / totalLength);
    return mix(endHeights[0], endHeights[1], t) + PRINCE_ARCH_LIMITS.rise * Math.sin(Math.PI * t);
  };
  const main = [],
    slabs = [],
    guards = [],
    abutments = [],
    index = new SpatialIndex(16),
    physicalFrom = (totalLength - PRINCE_ARCH_LIMITS.span) / 2,
    physicalTo = physicalFrom + PRINCE_ARCH_LIMITS.span,
    pieceCount = Math.ceil(totalLength / PRINCE_ARCH_LIMITS.pieceLength);
  const stations = [
    ...new Set([
      0,
      physicalFrom,
      physicalTo,
      totalLength,
      ...Array.from({ length: pieceCount + 1 }, (_, i) => (totalLength * i) / pieceCount),
    ]),
  ].sort((x, y) => x - y);
  // A footprint can touch a neighbouring piece while its centre lies outside
  // that piece. Continue the shared rendered profile there, rather than a
  // clamped endcap that can falsely block a walker at the shallow arch crest.
  const renderedHeightAt = (x, z) => {
    let supported = -Infinity;
    for (const segment of index.near(x, z)) {
      const y = quadHeight(segment.top, x, z);
      if (y !== null) supported = Math.max(supported, y);
    }
    if (Number.isFinite(supported)) return supported;
    const s = nearestOnSegment(x, z, a, b).t * totalLength;
    for (let i = 1; i < stations.length; i++)
      if (s <= stations[i] + EPS)
        return mix(
          heightAtArc(stations[i - 1]),
          heightAtArc(stations[i]),
          clamp((s - stations[i - 1]) / (stations[i] - stations[i - 1])),
        );
    return endHeights[1];
  };
  for (let i = 1; i < stations.length; i++) {
    const s0 = stations[i - 1],
      s1 = stations[i],
      p0 = pointAt(a, b, s0 / totalLength),
      p1 = pointAt(a, b, s1 / totalLength),
      h0 = heightAtArc(s0),
      h1 = heightAtArc(s1),
      top = topQuad(p0, p1, h0, h1, PRINCE_ARCH_LIMITS.width),
      slab = prismCollider(
        `prince-arch-deck-${i}`,
        top,
        (_x, _z, y) => y - PRINCE_ARCH_LIMITS.deckThickness,
        'bridge-deck',
        road.id,
        renderedHeightAt,
      ),
      segment = {
        a: p0,
        b: p1,
        h0,
        h1,
        top,
        slab,
        road,
        s0,
        s1,
        wood: s0 >= physicalFrom - EPS && s1 <= physicalTo + EPS,
      };
    main.push(segment);
    slabs.push(slab);
    index.insert(segment, bounds(top.map((p) => [p[0], p[2]])));
  }
  const direction = [(b[0] - a[0]) / totalLength, (b[1] - a[1]) / totalLength],
    normal = [-direction[1], direction[0]],
    at = (s, offset = 0, above = 0) => {
      const p = pointAt(a, b, clamp(s / totalLength));
      return [p[0] + normal[0] * offset, heightAtArc(s) + above, p[1] + normal[1] * offset];
    };
  for (const side of [-1, 1]) {
    const offset = side * (PRINCE_ARCH_LIMITS.width / 2 - 0.055);
    // One flat chord would cut into the curved guard/deck. Match each actual
    // rendered segment instead, retaining the unguarded end openings.
    for (const s of main) {
      if (!s.wood) continue;
      const p0 = at(s.s0, offset),
        p1 = at(s.s1, offset),
        q = topQuad(
          [p0[0], p0[2]],
          [p1[0], p1[2]],
          s.h0 + PRINCE_ARCH_LIMITS.guardHeight,
          s.h1 + PRINCE_ARCH_LIMITS.guardHeight,
          PRINCE_ARCH_LIMITS.guardWidth,
        );
      guards.push(
        prismCollider(
          `prince-arch-guard-${side}-${s.s0}`,
          q,
          (_x, _z, y) => y - PRINCE_ARCH_LIMITS.guardHeight + 0.08,
          'bridge-guard',
          road.id,
          (x, z) => renderedHeightAt(x, z) + PRINCE_ARCH_LIMITS.guardHeight,
        ),
      );
      const beamTop = topQuad(
        [p0[0], p0[2]],
        [p1[0], p1[2]],
        s.h0 - 0.02,
        s.h1 - 0.02,
        PRINCE_ARCH_LIMITS.girderWidth,
      );
      guards.push(
        prismCollider(
          `prince-arch-girder-${side}-${s.s0}`,
          beamTop,
          (_x, _z, y) => y - PRINCE_ARCH_LIMITS.girderDepth,
          'bridge-edge-girder',
          road.id,
          (x, z) => renderedHeightAt(x, z) - 0.02,
        ),
      );
    }
  }
  for (const [end, station] of [
    [0, physicalFrom],
    [1, physicalTo],
  ]) {
    const p = at(station, 0, -PRINCE_ARCH_LIMITS.deckThickness / 2),
      start = [p[0] - direction[0] * 0.175, p[2] - direction[1] * 0.175],
      finish = [p[0] + direction[0] * 0.175, p[2] + direction[1] * 0.175],
      top = topQuad(start, finish, p[1], p[1], PRINCE_ARCH_LIMITS.width + 0.45),
      bottom = (x, z, y) => Math.min(y - 0.1, groundHeightAt(x, z) - 0.04),
      collider = prismCollider(`prince-arch-endwall-${end}`, top, bottom, 'bridge-abutment', road.id);
    abutments.push({ top, bottom, collider });
    guards.push(collider);
    const delta = end ? 1 : -1;
    for (const side of [-1, 1]) {
      const q0 = at(station, side * (PRINCE_ARCH_LIMITS.width / 2 + 0.15), -0.04),
        q1 = at(station + delta * 1.7, side * (PRINCE_ARCH_LIMITS.width / 2 + 0.4), -0.12),
        q = topQuad([q0[0], q0[2]], [q1[0], q1[2]], q0[1] + 0.175, q1[1] + 0.175, 0.23),
        under = (_x, _z, y) => y - 0.35,
        wing = prismCollider(`prince-arch-wing-${end}-${side}`, q, under, 'bridge-wingwall', road.id);
      abutments.push({ top: q, bottom: under, collider: wing });
      guards.push(wing);
    }
  }
  const inBounds = (x, z) =>
      x >= footprint.minX && x <= footprint.maxX && z >= footprint.minZ && z <= footprint.maxZ,
    footprint = bounds(main.flatMap((s) => s.top.map((p) => [p[0], p[2]])));
  const supportCandidates = (x, z, owner) => {
    if (!inBounds(x, z)) return [];
    const result = [];
    for (const s of index.near(x, z)) {
      if (owner && s.road.id !== owner.id) continue;
      const y = quadHeight(s.top, x, z);
      if (y !== null) result.push(y);
    }
    return result;
  };
  const fullyOwned = new Set([road.id]),
    sourceIds = new Set([road.id]);
  return {
    ready: true,
    source: evidence,
    road,
    points: road.points.map((p) => [...p]),
    totalLength,
    physicalFrom,
    physicalTo,
    endHeights,
    lowerAt: [...lowerAt],
    main,
    abutments,
    slabs,
    guards,
    groundHeightAt,
    bounds: footprint,
    direction,
    normal,
    at,
    heightAtArc,
    sourceSupportedIds: sourceIds,
    ownedIds: fullyOwned,
    ownsRoad: (r) => fullyOwned.has(r.id),
    unownedRuns: (r) => (r.id === road.id ? [] : [r.points]),
    surfaceHeight(x, z, r) {
      if (!r || !sourceIds.has(r.id)) return null;
      const candidates = supportCandidates(x, z, r);
      return candidates.length ? Math.max(...candidates) : null;
    },
    groundHeight(x, z, hint) {
      const candidates = supportCandidates(x, z).filter(
        (y) => !Number.isFinite(hint) || y <= hint + PRINCE_ARCH_LIMITS.stepUp + EPS,
      );
      return candidates.length ? Math.max(...candidates) : null;
    },
    stats: {
      physicalBridges: 1,
      ownerRecords: 1,
      sourceRoads: sourceIds.size,
      fullyOwnedSourceRoads: fullyOwned.size,
      partiallyOwnedSourceRoads: sourceIds.size - fullyOwned.size,
      sourceVertices: road.points.length,
      mappedWayLengthM: totalLength,
      ownerSpanM: PRINCE_ARCH_LIMITS.span,
      ownerWidthM: PRINCE_ARCH_LIMITS.width,
      separateRaisedBankRibbons: 0,
      unifiedGroundSamples: context.terrain.princeArchGround.changedSamples,
      deckProfileMeasured: false,
      adultUnderpassClearanceMeasured: false,
      gameVisuallyReviewed: false,
    },
  };
}

/** Shared world/bake attachment. The model already includes its ground datum,
 * so attach after ordinary terrain wrapping. Neither source plans nor their
 * indices are removed; this isolated owner currently replaces no generic plan.
 */
export function attachPrinceArchSurfaces(surfaces, model) {
  if (!model?.ready) return surfaces;
  const owns = surfaces.ownsRoad.bind(surfaces),
    surface = surfaces.surfaceHeight.bind(surfaces),
    ground = surfaces.groundHeight.bind(surfaces);
  surfaces.ownsRoad = (road) => model.ownsRoad(road) || owns(road);
  surfaces.surfaceHeight = (x, z, road) => model.surfaceHeight(x, z, road) ?? surface(x, z, road);
  surfaces.groundHeight = (x, z, hint) => {
    const arch = model.groundHeight(x, z, hint),
      previous = ground(x, z, hint);
    if (arch == null) return previous;
    if (previous == null) return arch;
    return Number.isFinite(hint)
      ? Math.abs(arch - hint) < Math.abs(previous - hint)
        ? arch
        : previous
      : Math.max(arch, previous);
  };
  return surfaces;
}

const COLORS = {
  wood: 0x92734f,
  timberEnd: 0xa08964,
  joint: 0x4d4938,
  metal: 0xa9ada0,
  concrete: 0xc9c8b8,
  stone: 0x9c9e91,
  bolt: 0x7b837c,
};
class Batch {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.normals = [];
    this.primitives = 0;
  }
  triangle(a, b, c, hex) {
    const u = b.map((v, i) => v - a[i]),
      v = c.map((n, i) => n - a[i]),
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      l = Math.hypot(...n);
    if (l < EPS) return;
    const color = new THREE.Color(hex);
    for (const p of [a, b, c]) {
      this.positions.push(...p);
      this.normals.push(...n.map((x) => x / l));
      this.colors.push(color.r, color.g, color.b);
    }
  }
  quad(a, b, c, d, hex) {
    this.triangle(a, b, c, hex);
    this.triangle(a, c, d, hex);
  }
  prism(top, lower, hex, sideHex = hex) {
    this.primitives++;
    const q = top.map((p) => [...p]);
    const y = (q[1][2] - q[0][2]) * (q[2][0] - q[0][0]) - (q[1][0] - q[0][0]) * (q[2][2] - q[0][2]);
    if (y < 0) q.reverse();
    const bottom = q.map((p) => [p[0], typeof lower === 'function' ? lower(p) : p[1] - lower, p[2]]);
    this.quad(...q, hex);
    this.quad(...bottom.slice().reverse(), sideHex);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(q[i], bottom[i], bottom[j], q[j], sideHex);
    }
  }
  bar(a, b, width, depth, hex) {
    const top = topQuad([a[0], a[2]], [b[0], b[2]], a[1] + depth / 2, b[1] + depth / 2, width);
    this.prism(top, depth, hex);
  }
  box(point, along, across, height, direction, hex) {
    const a = [point[0] - (direction[0] * along) / 2, point[2] - (direction[1] * along) / 2],
      b = [point[0] + (direction[0] * along) / 2, point[2] + (direction[1] * along) / 2];
    this.prism(topQuad(a, b, point[1] + height / 2, point[1] + height / 2, across), height, hex);
  }
  stone(p, r, hex) {
    this.primitives++;
    const q = [
        [p[0] + r, p[1], p[2]],
        [p[0], p[1], p[2] + r * 0.85],
        [p[0] - r, p[1], p[2]],
        [p[0], p[1], p[2] - r * 0.85],
      ],
      top = [p[0], p[1] + r * 0.65, p[2]],
      bottom = [p[0], p[1] - r * 0.25, p[2]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.triangle(q[j], q[i], top, hex);
      this.triangle(q[i], q[j], bottom, hex);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Two static shared-material batches. No PointLights, textures, frame-time
 * geometry rebuilds, generic source suppression, or tree/furniture changes.
 */
export function buildPrinceArch(scene, model, context = {}) {
  if (!model?.ready) return { ready: false, reason: model?.reason || 'No Prince arch model' };
  const base = new Batch(),
    detail = new Batch(),
    L = PRINCE_ARCH_LIMITS;
  for (const s of model.main) base.prism(s.top, L.deckThickness, s.wood ? COLORS.wood : COLORS.concrete);
  for (const part of model.abutments)
    base.prism(part.top, (p) => part.bottom(p[0], p[2], p[1]), COLORS.concrete);
  const girderOffset = L.width / 2 - 0.055;
  for (const side of [-1, 1]) {
    for (const s of model.main) {
      if (!s.wood) continue;
      base.bar(
        model.at(s.s0, side * girderOffset, -0.02 - L.girderDepth / 2),
        model.at(s.s1, side * girderOffset, -0.02 - L.girderDepth / 2),
        L.girderWidth,
        L.girderDepth,
        COLORS.wood,
      );
      base.bar(
        model.at(s.s0, side * girderOffset, L.guardHeight),
        model.at(s.s1, side * girderOffset, L.guardHeight),
        0.09,
        0.055,
        COLORS.timberEnd,
      );
      for (const above of [0.22, 0.48, 0.74, 0.99])
        detail.bar(
          model.at(s.s0, side * girderOffset, above),
          model.at(s.s1, side * girderOffset, above),
          0.035,
          0.055,
          COLORS.metal,
        );
    }
    for (let i = 0; i <= 8; i++) {
      const s = mix(model.physicalFrom, model.physicalTo, i / 8),
        p = model.at(s, side * girderOffset, L.guardHeight / 2);
      base.box(p, 0.06, L.guardWidth, L.guardHeight, model.direction, COLORS.metal);
      for (const above of [0.12, 0.88])
        detail.box(
          model.at(s, side * (girderOffset + 0.04), above),
          0.028,
          0.018,
          0.028,
          model.direction,
          COLORS.bolt,
        );
    }
  }
  for (let i = 1; i < 82; i++) {
    const s = mix(model.physicalFrom, model.physicalTo, i / 82),
      a = model.at(s, -L.width / 2 + 0.08, 0.003),
      b = model.at(s, L.width / 2 - 0.08, 0.003);
    detail.bar(a, b, 0.008, 0.004, COLORS.joint);
  }
  for (const [end, s] of [
    [0, model.physicalFrom],
    [1, model.physicalTo],
  ]) {
    const delta = end ? 1 : -1;
    for (const side of [-1, 1]) {
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 8; col++) {
          const arc = s + delta * (0.25 + col * 0.22),
            offset = side * (L.width / 2 + 0.24 + row * 0.25),
            q = model.at(arc, offset, 0),
            radius = 0.1 + ((col * 3 + row) % 5) * 0.014;
          q[1] = model.groundHeightAt(q[0], q[2]) + radius * 0.1;
          detail.stone(q, radius, COLORS.stone);
        }
    }
  }
  const ownsMaterial = !context.material,
    material =
      context.material || new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88 }),
    batches = [base, detail],
    meshes = batches.map((batch, i) => {
      const mesh = new THREE.Mesh(batch.geometry(), material);
      mesh.name = i
        ? 'Prince Island arch nearby rail and deck hardware (inferred dimensions)'
        : 'Prince Island arch attached to unified City ground';
      mesh.receiveShadow = true;
      mesh.castShadow = i === 0;
      scene.add(mesh);
      return mesh;
    });
  const stats = {
    ...model.stats,
    drawCalls: meshes.length,
    materials: 1,
    baseTriangles: base.positions.length / 9,
    detailTriangles: detail.positions.length / 9,
    primitives: base.primitives + detail.primitives,
    pointLights: 0,
    textures: 0,
  };
  return {
    ready: true,
    meshes,
    stats,
    update(camera, quality = 'balanced') {
      const distance = Math.hypot(camera.position.x - model.lowerAt[0], camera.position.z - model.lowerAt[1]);
      meshes[0].visible = distance < (context.cullDistance || 1800);
      meshes[1].visible =
        distance < (quality === 'high' ? 240 : quality === 'low' ? 90 : 150) &&
        camera.position.y < model.endHeights[0] + 180;
    },
    dispose() {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      if (ownsMaterial) material.dispose();
    },
  };
}
