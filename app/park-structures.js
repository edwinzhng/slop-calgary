import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bounds } from './geo.js';
import parkLifeManifest from '../data/calgary-park-life.json' with { type: 'json' };
import { createStructureGroundPlacement } from './structure-ground.js';

export const LOOKOUT_ROOF_IDS = Object.freeze([
  'city-outline-26062-0',
  'city-outline-26134-0',
  'city-outline-26145-0',
  'city-outline-26150-0',
]);
export const LOOKOUT_SOURCES = Object.freeze({
  city: 'https://data.calgary.ca/Base-Maps/3D-Buildings-Citywide/cchr-krqg',
  architect: 'https://w-architecture.com/projects/st-patricks-island-amenity-structures/',
  engineer: 'https://www.nordenson.com/archive/st-patrick-s-island-pavilion',
  owner: 'https://www.calgarymlc.ca/projects/st-patricks-island',
});

const cross = (ax, az, bx, bz) => ax * bz - az * bx;
const FORWARD = new THREE.Vector3(0, 0, 1);

/** Preserve source roof vertices exactly; omit the City's projected ground walls. */
export function extractPavilionRoof(geometry) {
  const p = geometry.attributes.position,
    vertices = [],
    normals = [],
    triangles = [];
  let projectedWalls = 0;
  const count = geometry.index?.count ?? p.count;
  for (let i = 0; i < count; i += 3) {
    const points = [0, 1, 2].map((j) => {
      const k = geometry.index ? geometry.index.getX(i + j) : i + j;
      return [p.getX(k), p.getY(k), p.getZ(k)];
    });
    const [a, b, c] = points;
    const ab = new THREE.Vector3(...b).sub(new THREE.Vector3(...a)),
      ac = new THREE.Vector3(...c).sub(new THREE.Vector3(...a)),
      normal = ab.cross(ac),
      length = normal.length();
    if (!Number.isFinite(length) || length < 1e-7) continue;
    normal.divideScalar(length);
    if (normal.y <= 0.15) {
      projectedWalls++;
      continue;
    }
    const d = -(normal.x * a[0] + normal.y * a[1] + normal.z * a[2]);
    const planeHeight = (x, z) => -(normal.x * x + normal.z * z + d) / normal.y;
    const ring = points.map(([x, _y, z]) => [x, z]);
    triangles.push({ points, ring, heightAt: planeHeight, box: bounds(ring) });
    for (const point of points) {
      vertices.push(...point);
      normals.push(...normal.toArray());
    }
  }
  const roof = new THREE.BufferGeometry();
  roof.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  roof.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  roof.computeBoundingBox();
  roof.computeBoundingSphere();
  return { geometry: roof, triangles, projectedWalls };
}

function heightOnRoof(roof, x, z) {
  let fallback = null,
    nearest = Infinity;
  for (const triangle of roof.triangles) {
    const [a, b, c] = triangle.ring,
      denominator = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]),
      u = cross(x - a[0], z - a[1], c[0] - a[0], c[1] - a[1]) / denominator,
      v = cross(b[0] - a[0], b[1] - a[1], x - a[0], z - a[1]) / denominator;
    if (u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001) return triangle.heightAt(x, z);
    const distance = (x - (a[0] + b[0] + c[0]) / 3) ** 2 + (z - (a[1] + b[1] + c[1]) / 3) ** 2;
    if (distance < nearest) {
      nearest = distance;
      fallback = triangle;
    }
  }
  return fallback?.heightAt(x, z) ?? 0;
}

// Clip an authored beam centreline to the measured roof's triangle union.
function roofIntervals(roof, origin, direction) {
  const intervals = [];
  for (const { ring } of roof.triangles) {
    const area = cross(
        ring[1][0] - ring[0][0],
        ring[1][1] - ring[0][1],
        ring[2][0] - ring[0][0],
        ring[2][1] - ring[0][1],
      ),
      sign = area > 0 ? 1 : -1;
    let low = -Infinity,
      high = Infinity,
      valid = true;
    for (let i = 0; i < 3; i++) {
      const a = ring[i],
        b = ring[(i + 1) % 3],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        intercept = sign * cross(dx, dz, origin[0] - a[0], origin[1] - a[1]),
        slope = sign * cross(dx, dz, direction[0], direction[1]);
      if (Math.abs(slope) < 1e-8) {
        if (intercept < -1e-6) valid = false;
      } else if (slope > 0) low = Math.max(low, -intercept / slope);
      else high = Math.min(high, -intercept / slope);
    }
    if (valid && high - low > 0.08 && Number.isFinite(low + high)) intervals.push([low, high]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 0.025) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval.slice());
  }
  return merged;
}

function principalAxis(triangles) {
  const points = triangles.flatMap((t) => t.ring),
    x = points.reduce((s, p) => s + p[0], 0) / points.length,
    z = points.reduce((s, p) => s + p[1], 0) / points.length;
  let xx = 0,
    zz = 0,
    xz = 0;
  for (const p of points) {
    xx += (p[0] - x) ** 2;
    zz += (p[1] - z) ** 2;
    xz += (p[0] - x) * (p[1] - z);
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  return { center: [x, z], angle, direction: [Math.cos(angle), Math.sin(angle)] };
}

function rectangle(x, z, width) {
  return [
    [x - width / 2, z - width / 2],
    [x + width / 2, z - width / 2],
    [x + width / 2, z + width / 2],
    [x - width / 2, z + width / 2],
  ];
}

/** Open Lookout Pavilion; no replacement is claimed when source roof data is missing. */
export function buildParkStructures(
  scene,
  {
    cityMeshes,
    data = {},
    groundHeight = () => 0.2,
    seating = parkLifeManifest.seats,
    ground: nativeGround,
    surfaceData,
    parkData,
    captureOwnership = false,
  } = {},
) {
  const groundPlacement = nativeGround
    ? createStructureGroundPlacement(nativeGround, { data, cityMeshes, surfaceData, parkData })
    : null;
  let activePlacement,
    activeSourceId,
    activeRole = 'inferred-timber';
  const columnContacts = [];
  const buckets = { zinc: [], timber: [], steel: [] },
    meshes = [],
    colliders = [],
    roofs = [],
    replacedBuildingIds = new Set(),
    missingBuildingIds = [],
    sourceBuildings = new Map((data.buildings || []).map((b) => [b.id, b])),
    mappedFixtures = seating.filter((s) => s.parkAsset === 'BRD100');
  const stats = {
    roofParts: 0,
    measuredRoofTriangles: 0,
    removedProjectedWallTriangles: 0,
    inferredColumns: 0,
    inferredTimberMembers: 0,
    standingSeams: 0,
    triangles: 0,
    drawCalls: 0,
    colliders: 0,
    sourceDates: [],
    runtimeTextures: 0,
    pointLights: 0,
    visible: true,
    ...(groundPlacement ? { unsupportedInferredSupports: 0, lowClearanceInferredSupports: 0 } : {}),
  };
  const colors = { zinc: 0x646d69, timber: 0x96744b, steel: 0x5d6864 };
  const add = (geometry, bucket, tint = colors[bucket], role = activeRole) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes))
      if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
    const color = new THREE.Color(tint),
      array = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < array.length; i += 3) {
      array[i] = color.r;
      array[i + 1] = color.g;
      array[i + 2] = color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(array, 3));
    if (groundPlacement) groundPlacement.placeGeometry(g, activePlacement, role);
    else if (captureOwnership)
      g.userData = { ...g.userData, structureSourceId: activeSourceId, structureGroundRole: role };
    buckets[bucket].push(g);
  };
  const addCollider = (c) =>
    colliders.push(groundPlacement ? groundPlacement.placeCollider(c, activePlacement) : c);
  const box = (x, y, z, w, h, d, bucket, tint) => {
    const geometry = new THREE.BoxGeometry(w, h, d);
    geometry.translate(x, y, z);
    add(geometry, bucket, tint);
  };
  const beam = (a, b, width, depth, bucket, tint) => {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      vector = end.clone().sub(start),
      length = vector.length();
    if (length < 0.08) return;
    const geometry = new THREE.BoxGeometry(width, depth, length);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(FORWARD, vector.normalize()));
    geometry.translate(...start.add(end).multiplyScalar(0.5).toArray());
    add(geometry, bucket, tint);
  };
  for (const id of LOOKOUT_ROOF_IDS) {
    const record = cityMeshes?.get(id),
      sourceGeometry = record && cityMeshes.createGeometry(id);
    if (!sourceGeometry) {
      missingBuildingIds.push(id);
      continue;
    }
    const extracted = extractPavilionRoof(sourceGeometry);
    sourceGeometry.dispose();
    if (!extracted.triangles.length) {
      extracted.geometry.dispose();
      missingBuildingIds.push(id);
      continue;
    }
    activeSourceId = id;
    activePlacement = groundPlacement?.source(id);
    const roof = {
      id,
      record,
      triangles: extracted.triangles,
      outline: sourceBuildings.get(id)?.ring,
      axis: principalAxis(extracted.triangles),
      box: extracted.geometry.boundingBox.clone(),
    };
    roofs.push(roof);
    replacedBuildingIds.add(id);
    stats.roofParts++;
    stats.measuredRoofTriangles += roof.triangles.length;
    stats.removedProjectedWallTriangles += extracted.projectedWalls;
    stats.sourceDates.push(...(record.sourceDates || []));
    const underside = extracted.geometry.clone();
    underside.translate(0, -0.14, 0);
    const undersidePoints = underside.attributes.position;
    for (let i = 0; i < undersidePoints.count; i += 3) {
      const x = undersidePoints.getX(i + 1),
        y = undersidePoints.getY(i + 1),
        z = undersidePoints.getZ(i + 1);
      undersidePoints.setXYZ(
        i + 1,
        undersidePoints.getX(i + 2),
        undersidePoints.getY(i + 2),
        undersidePoints.getZ(i + 2),
      );
      undersidePoints.setXYZ(i + 2, x, y, z);
    }
    underside.computeVertexNormals();
    add(underside, 'timber', 0x9c7c50, 'inferred-roof-thickness');
    add(extracted.geometry, 'zinc', colors.zinc, 'source-roof');
    for (const [i, triangle] of roof.triangles.entries()) {
      const ys = triangle.points.map((p) => p[1]);
      addCollider({
        id: `lookout-${id}-roof-${i}`,
        type: 'park-structure-roof',
        storefrontAnchor: false,
        ring: triangle.ring,
        height: Math.max(...ys) + 0.015,
        minHeight: Math.min(...ys) - 0.14,
        heightAt: (x, z) => triangle.heightAt(x, z) + 0.015,
        minHeightAt: (x, z) => triangle.heightAt(x, z) - 0.14,
        source: 'city-multipatch-roof',
        sourceId: id,
        measuredGeometry: true,
        inferredThickness: 0.14,
      });
    }
    const center = roof.axis.center;
    // Two lapped timber families follow the roof footprint. Member sizes and
    // joint positions are restrained photo-informed interpretation, not BIM.
    for (const [family, spacing, width, depth, below] of [
      [0, 2.5, 0.18, 0.4, 0.35],
      [1, 2.7, 0.17, 0.35, 0.55],
    ]) {
      const angle = roof.axis.angle + (family ? -0.61 : 0.61),
        direction = [Math.cos(angle), Math.sin(angle)],
        normal = [-direction[1], direction[0]],
        distances = roof.triangles.flatMap((t) =>
          t.ring.map((p) => (p[0] - center[0]) * normal[0] + (p[1] - center[1]) * normal[1]),
        ),
        min = Math.min(...distances),
        max = Math.max(...distances),
        count = Math.ceil((max - min) / spacing);
      for (let i = 0; i <= count; i++) {
        const offset = min + 0.3 + i * Math.max(0.1, (max - min - 0.6) / Math.max(1, count)),
          origin = [center[0] + normal[0] * offset, center[1] + normal[1] * offset];
        for (const [lo, hi] of roofIntervals(roof, origin, direction)) {
          const a = [origin[0] + direction[0] * lo, origin[1] + direction[1] * lo],
            b = [origin[0] + direction[0] * hi, origin[1] + direction[1] * hi];
          beam(
            [a[0], heightOnRoof(roof, ...a) - below, a[1]],
            [b[0], heightOnRoof(roof, ...b) - below, b[1]],
            width,
            depth,
            'timber',
            i % 3 ? 0x96744b : 0x896840,
          );
          stats.inferredTimberMembers++;
        }
      }
    }
    const along = roof.axis.direction,
      across = [-along[1], along[0]],
      extents = roof.triangles.flatMap((t) =>
        t.ring.map((p) => (p[0] - center[0]) * along[0] + (p[1] - center[1]) * along[1]),
      ),
      low = Math.min(...extents),
      high = Math.max(...extents),
      postCount = Math.max(2, Math.ceil((high - low - 2) / 5));
    for (let i = 0; i <= postCount; i++) {
      const offset = low + 1 + ((high - low - 2) * i) / postCount,
        origin = [center[0] + along[0] * offset, center[1] + along[1] * offset];
      for (const [lo, hi] of roofIntervals(roof, origin, across)) {
        if (hi - lo < 2.3) continue;
        for (const side of [lo + 0.7, hi - 0.7]) {
          const x = origin[0] + across[0] * side,
            z = origin[1] + across[1] * side,
            support = groundPlacement?.sampleGround(x, z),
            ground = groundPlacement
              ? support && support.height - activePlacement.offsetM
              : groundHeight(x, z),
            y = Number.isFinite(ground) ? ground : 0.2,
            top = heightOnRoof(roof, x, z) - 0.48;
          if (groundPlacement && !support) {
            stats.unsupportedInferredSupports++;
            continue;
          }
          if (top < y + 2) {
            if (groundPlacement) stats.lowClearanceInferredSupports++;
            continue;
          }
          // Inferred supports yield to exact City furniture positions. A column
          // must not pierce a surveyed table just because its grid is illustrative.
          if (mappedFixtures.some((s) => Math.hypot(s.x - x, s.z - z) < (s.kind === 'table' ? 1.45 : 1.25)))
            continue;
          activeRole = 'inferred-support';
          box(x, (y + top) / 2, z, 0.15, top - y, 0.15, 'steel');
          box(x, y + 0.035, z, 0.27, 0.07, 0.27, 'steel', 0x7c8076);
          box(x, top, z, 0.3, 0.07, 0.25, 'steel', 0x79817b);
          for (const dx of [-0.09, 0.09])
            for (const dz of [-0.09, 0.09])
              box(x + dx, y + 0.078, z + dz, 0.018, 0.016, 0.018, 'steel', 0xa9aa9b);
          const columnId = `lookout-${id}-column-${stats.inferredColumns++}`;
          addCollider({
            id: columnId,
            type: 'park-structure-column',
            storefrontAnchor: false,
            ring: rectangle(x, z, 0.19),
            minHeight: y - 0.02,
            height: top + 0.04,
            source: 'photo-informed-column',
            sourceId: id,
            inferredShape: true,
          });
          if (groundPlacement)
            columnContacts.push({
              id: columnId,
              sourceId: id,
              x,
              z,
              support,
              top: top + activePlacement.offsetM,
              offsetM: activePlacement.offsetM,
              inferredShape: true,
              actualColumnSurvey: false,
            });
          activeRole = 'inferred-timber';
        }
      }
    }
    // Standing seams remain subordinate to the exact measured roof planes.
    const distances = roof.triangles.flatMap((t) =>
      t.ring.map((p) => (p[0] - center[0]) * across[0] + (p[1] - center[1]) * across[1]),
    );
    for (let offset = Math.min(...distances) + 0.4; offset < Math.max(...distances); offset += 0.85) {
      const origin = [center[0] + across[0] * offset, center[1] + across[1] * offset];
      for (const [lo, hi] of roofIntervals(roof, origin, along)) {
        const a = [origin[0] + along[0] * lo, origin[1] + along[1] * lo],
          b = [origin[0] + along[0] * hi, origin[1] + along[1] * hi];
        activeRole = 'standing-seam';
        beam(
          [a[0], heightOnRoof(roof, ...a) + 0.014, a[1]],
          [b[0], heightOnRoof(roof, ...b) + 0.014, b[1]],
          0.018,
          0.024,
          'zinc',
          0x737c76,
        );
        activeRole = 'inferred-timber';
        stats.standingSeams++;
      }
    }
  }
  const materials = {
    zinc: new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.58,
      metalness: 0.48,
      side: THREE.DoubleSide,
    }),
    timber: new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.86,
      side: THREE.DoubleSide,
    }),
    steel: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.64, metalness: 0.45 }),
  };
  for (const [kind, parts] of Object.entries(buckets)) {
    if (!parts.length) continue;
    let start = 0;
    const ranges =
      (groundPlacement || captureOwnership) &&
      parts.map((g) => {
        const count = g.attributes.position.count,
          range = {
            start,
            count,
            placement: g.userData.structureGround,
            ownerId: g.userData.structureGround?.ownerId || g.userData.structureSourceId,
            role: g.userData.structureGroundRole,
          };
        start += count;
        return range;
      });
    const geometry = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, materials[kind]);
    mesh.name = `St Patrick Lookout Pavilion / ${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (ranges) mesh.userData.structureGroundRanges = ranges;
    scene.add(mesh);
    meshes.push(mesh);
    stats.triangles += geometry.attributes.position.count / 3;
  }
  stats.drawCalls = meshes.length;
  stats.colliders = colliders.length;
  stats.sourceDates = [...new Set(stats.sourceDates)].sort();
  if (groundPlacement) groundPlacement.disposeSampling();
  const worldRoofs = groundPlacement
    ? roofs.map((roof) => {
        const placement = groundPlacement.placementFor(roof.id),
          triangles = roof.triangles.map((t) => ({
            ...t,
            points: t.points.map(([x, y, z]) => [x, Math.fround(y + placement.offsetM), z]),
            heightAt: (x, z) => t.heightAt(x, z) + placement.offsetM,
          })),
          box = new THREE.Box3().setFromPoints(
            triangles.flatMap((t) => t.points.map((p) => new THREE.Vector3(...p))),
          );
        return { ...roof, triangles, box, structureGround: placement };
      })
    : roofs;
  const overall = new THREE.Box3();
  for (const roof of worldRoofs) overall.union(roof.box);
  const midpoint = overall.isEmpty() ? new THREE.Vector3() : overall.getCenter(new THREE.Vector3());
  const labels = roofs.length
    ? [{ name: 'St. Patrick’s Lookout Pavilion', x: midpoint.x, z: midpoint.z, height: overall.max.y + 1.5 }]
    : [];
  let disposed = false;
  return {
    replacedBuildingIds,
    missingBuildingIds,
    roofs: worldRoofs,
    colliders,
    labels,
    meshes,
    materials,
    stats,
    ...(groundPlacement ? { groundPlacement, columnContacts } : {}),
    update(camera, quality = 'balanced') {
      if (disposed) return;
      const p = camera?.position || camera,
        x = p?.x ?? midpoint.x,
        z = p?.z ?? midpoint.z,
        y = p?.y ?? 2,
        distance = Math.hypot(
          x - midpoint.x,
          z - midpoint.z,
          Math.max(0, y - (groundPlacement && !overall.isEmpty() ? overall.max.y + 1 : 6)),
        ),
        visible = distance < (quality === 'high' ? 2600 : 1800);
      stats.visible = visible;
      for (const mesh of meshes) {
        mesh.visible = visible;
        mesh.castShadow = visible && distance < 220 && quality !== 'low';
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
export const createParkStructures = buildParkStructures;
