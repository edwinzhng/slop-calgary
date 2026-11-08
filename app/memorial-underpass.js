import * as THREE from 'three/webgpu';
import { bounds, roadWidth } from './geo.js';
import { remeshTerrain, splitTerrainPolygon, terrainPolygonBounds } from './terrain-polygons.js';

const tunnelId = 'osm-way-298687480-0';
const eastId = 'osm-way-559260148-0';
const westId = 'osm-way-1568503122-0';

export function createMemorialUnderpass(data, terrain) {
  if (!terrain?.regionalOffsetAt) return null;
  const road = data.roads.find((item) => item.id === tunnelId && item.tunnel);
  const east = data.roads.find((item) => item.id === eastId);
  const west = data.roads.find((item) => item.id === westId);
  const a = road?.points[0],
    b = road?.points[1];
  if (
    !a ||
    !b ||
    road.points.length !== 2 ||
    !east?.points.some((p) => p[0] === a[0] && p[1] === a[1]) ||
    !west?.points.some((p) => p[0] === b[0] && p[1] === b[1])
  )
    return null;

  const length = Math.hypot(b[0] - a[0], b[1] - a[1]),
    dx = (b[0] - a[0]) / length,
    dz = (b[1] - a[1]) / length,
    half = roadWidth(road) / 2,
    wall = half + 0.24,
    floor = 0.16,
    ceiling = 4.45,
    from = -8,
    to = length + 5,
    coverStart = 10,
    coverEnd = length - 11;
  const along = (x, z) => (x - a[0]) * dx + (z - a[1]) * dz;
  const across = (x, z) => -(x - a[0]) * dz + (z - a[1]) * dx;
  const point = (t, s) => [a[0] + dx * t - dz * s, a[1] + dz * t + dx * s];
  const ring = (start, end, lo, hi) => [
    point(start, lo),
    point(end, lo),
    point(end, hi),
    point(start, hi),
    point(start, lo),
  ];
  const owners = new Set([tunnelId, eastId, westId]);
  const portalCuts = [
    [from, coverStart],
    [coverEnd, to],
  ].map(([start, end]) => ({
    start,
    end,
    box: bounds(ring(start, end, -wall, wall)),
  }));
  const intersects = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
  function cutSurface(geometry) {
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    const cuts = portalCuts.filter(({ box }) =>
      intersects({ minX: min.x, minZ: min.z, maxX: max.x, maxZ: max.z }, box),
    );
    if (!cuts.length) return geometry;
    return remeshTerrain(geometry, (triangle, emit) => {
      let pieces = [triangle];
      for (const { start, end, box } of cuts) {
        pieces = pieces.flatMap((piece) => {
          if (!intersects(terrainPolygonBounds(piece), box)) return [piece];
          const outside = [];
          let inside = piece;
          for (const signed of [
            ([x, , z]) => along(x, z) - start,
            ([x, , z]) => end - along(x, z),
            ([x, , z]) => across(x, z) + wall,
            ([x, , z]) => wall - across(x, z),
          ]) {
            const [out, rest] = splitTerrainPolygon(inside, signed);
            if (out.length >= 3) outside.push(out);
            inside = rest;
            if (inside.length < 3) break;
          }
          return outside;
        });
      }
      for (const piece of pieces) emit(piece);
    });
  }
  const heightAt = (x, z, route) => {
    if (!owners.has(route?.id)) return null;
    const t = along(x, z);
    if (t >= from && t <= to) return floor;
    const d = Math.max(from - t, t - to);
    if (d >= 10) return null;
    const u = d / 10;
    return floor + terrain.offsetAt(x, z) * u * u * (3 - 2 * u);
  };
  function groundHeight(x, z, hint) {
    const t = along(x, z);
    if (t < from || t > to || Math.abs(across(x, z)) > wall) return null;
    const covered = t >= coverStart && t <= coverEnd;
    return covered && (!Number.isFinite(hint) || hint >= ceiling - 0.35) ? null : floor;
  }

  function addStructure(scene) {
    const positions = [],
      colours = [],
      shade = new THREE.Color();
    const quad = (a, b, c, d, color) => {
      shade.setHex(color);
      for (const v of [a, b, c, a, c, d]) {
        positions.push(...v);
        colours.push(shade.r, shade.g, shade.b);
      }
    };
    const at = (t, s, y) => {
      const [x, z] = point(t, s);
      return [x, y, z];
    };
    const retainingHeight = (t, s) => {
      const ground = terrain.offsetAt(...point(t, s));
      return t >= coverStart && t <= coverEnd ? Math.max(ceiling + 0.4, ground) : ground + 0.07;
    };
    const colliders = [];
    const stations = [from, 0, coverStart, (coverStart + coverEnd) / 2, coverEnd, length, to];
    for (let i = 1; i < stations.length; i++) {
      const t0 = stations[i - 1],
        t1 = stations[i];
      for (const side of [-1, 1]) {
        const s = side * wall,
          lo = Math.min(s, s + side * 0.29),
          hi = Math.max(s, s + side * 0.29),
          h0 = Math.max(floor, retainingHeight(t0, s)),
          h1 = Math.max(floor, retainingHeight(t1, s));
        quad(at(t0, s, floor - 0.06), at(t1, s, floor - 0.06), at(t1, s, h1), at(t0, s, h0), 0x868582);
        quad(at(t0, lo, h0), at(t1, lo, h1), at(t1, hi, h1), at(t0, hi, h0), 0xaaa79d);
        colliders.push({
          id: `memorial-retaining-wall-${i}-${side}`,
          ring: ring(t0, t1, lo, hi),
          minHeight: floor - 0.06,
          height: Math.max(h0, h1),
          heightAt: (x, z) => h0 + (h1 - h0) * THREE.MathUtils.clamp((along(x, z) - t0) / (t1 - t0), 0, 1),
          storefrontAnchor: false,
        });
      }
    }
    quad(
      at(coverStart, -wall, ceiling),
      at(coverEnd, -wall, ceiling),
      at(coverEnd, wall, ceiling),
      at(coverStart, wall, ceiling),
      0x555552,
    );
    for (const t of [coverStart, coverEnd])
      quad(
        at(t, -wall - 0.29, ceiling),
        at(t, wall + 0.29, ceiling),
        at(t, wall + 0.29, ceiling + 0.72),
        at(t, -wall - 0.29, ceiling + 0.72),
        0xa39f94,
      );
    colliders.push({
      id: 'memorial-underpass-ceiling',
      ring: ring(coverStart, coverEnd, -wall, wall),
      minHeight: ceiling,
      height: ceiling + 0.55,
      storefrontAnchor: false,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardNodeMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.92,
      }),
    );
    mesh.name = 'Memorial Drive underpass beneath Centre Street';
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    return colliders;
  }
  return { road, allows: (r) => r.id === tunnelId, owners, heightAt, groundHeight, cutSurface, addStructure };
}
