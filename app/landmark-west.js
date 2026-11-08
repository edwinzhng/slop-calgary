import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { windowGlow } from './city-uniforms.js';
import { inPolygon } from './geo.js';

const key3 = (p) => p.map((n) => Math.round(n * 20)).join(',');
const separation = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const crossArea = (a, b, c) => Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;

/** Source roof components and their real 3D boundary edges, not a roof rectangle. */
export function extractWesternRoofComponents(geometry, { minHeight = 50, minArea = 8 } = {}) {
  const position = geometry?.attributes.position,
    normal = geometry?.attributes.normal,
    indices = geometry?.index;
  if (!position) return [];
  const triangles = [],
    count = indices?.count ?? position.count;
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map((j) => (indices ? indices.getX(i + j) : i + j)),
      p = ids.map((j) => [position.getX(j), position.getY(j), position.getZ(j)]);
    if (!p.every((q) => q.every(Number.isFinite)) || Math.min(...p.map((q) => q[1])) < minHeight) continue;
    const a = new THREE.Vector3(...p[1]).sub(new THREE.Vector3(...p[0])),
      b = new THREE.Vector3(...p[2]).sub(new THREE.Vector3(...p[0])),
      n = a.cross(b).normalize();
    if ((normal ? normal.getY(ids[0]) : n.y) < 0.12) continue;
    const area = crossArea(...p);
    if (area < 0.01) continue;
    triangles.push({ p, area });
  }
  const parents = triangles.map((_, i) => i),
    vertices = new Map();
  const root = (i) => (parents[i] === i ? i : (parents[i] = root(parents[i])));
  for (let i = 0; i < triangles.length; i++)
    for (const p of triangles[i].p) {
      const key = key3(p);
      if (vertices.has(key)) parents[root(i)] = root(vertices.get(key));
      else vertices.set(key, i);
    }
  const groups = new Map();
  for (let i = 0; i < triangles.length; i++) {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(triangles[i]);
  }
  return [...groups.values()]
    .map((group) => {
      const edges = new Map(),
        points = [],
        area = group.reduce((sum, t) => sum + t.area, 0);
      let x = 0,
        z = 0;
      for (const triangle of group) {
        points.push(...triangle.p);
        x += (triangle.p.reduce((sum, p) => sum + p[0], 0) * triangle.area) / 3;
        z += (triangle.p.reduce((sum, p) => sum + p[2], 0) * triangle.area) / 3;
        for (let i = 0; i < 3; i++) {
          const a = triangle.p[i],
            b = triangle.p[(i + 1) % 3],
            ka = key3(a),
            kb = key3(b),
            key = ka < kb ? `${ka};${kb}` : `${kb};${ka}`;
          if (edges.has(key)) edges.get(key).count++;
          else edges.set(key, { a, b, count: 1 });
        }
      }
      return {
        area,
        x: x / area,
        z: z / area,
        minY: Math.min(...points.map((p) => p[1])),
        maxY: Math.max(...points.map((p) => p[1])),
        points,
        triangles: group.map((t) => t.p),
        edges: [...edges.values()]
          .filter(
            (e) => e.count === 1 && new THREE.Vector3(...e.a).distanceTo(new THREE.Vector3(...e.b)) > 0.3,
          )
          .map(({ a, b }) => [a, b]),
      };
    })
    .filter((c) => c.area >= minArea)
    .sort((a, b) => b.area - a.area);
}

function hull(points) {
  const unique = new Map(points.map((p) => [`${p[0].toFixed(2)},${p[2].toFixed(2)}`, [p[0], p[2]]])),
    p = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (p.length < 3) return [];
  const lower = [],
    upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.slice().reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

class LightBatch {
  constructor() {
    this.positions = [];
    this.colors = [];
  }
  triangle(a, b, c, color) {
    for (const p of [a, b, c]) {
      if (this.verticalOffset) this.positions.push(p[0], Math.fround(p[1]) + this.verticalOffset, p[2]);
      else this.positions.push(...p);
      this.colors.push(color.r, color.g, color.b);
    }
  }
  quad(a, b, c, d, color) {
    this.triangle(a, b, c, color);
    this.triangle(a, c, d, color);
  }
  beam(a, b, radius, color) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      direction = end.clone().sub(start).normalize();
    if (start.distanceTo(end) < 0.05) return;
    const basis = Math.abs(direction.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0),
      side = direction.clone().cross(basis).normalize().multiplyScalar(radius),
      up = direction.clone().cross(side).normalize().multiplyScalar(radius);
    const ring = (origin, i) =>
      origin
        .clone()
        .addScaledVector(side, Math.cos((i * Math.PI) / 3))
        .addScaledVector(up, Math.sin((i * Math.PI) / 3))
        .toArray();
    for (let i = 0; i < 6; i++)
      this.quad(ring(start, i), ring(start, i + 1), ring(end, i + 1), ring(end, i), color);
  }
  geometry() {
    if (!this.positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function sourceVerticalSpines(geometry, components) {
  const position = geometry.attributes.position,
    count = position.count,
    candidates = [],
    seen = new Set();
  for (let i = 0; i < count; i += 3)
    for (let j = 0; j < 3; j++) {
      const ia = i + j,
        ib = i + ((j + 1) % 3),
        a = [position.getX(ia), position.getY(ia), position.getZ(ia)],
        b = [position.getX(ib), position.getY(ib), position.getZ(ib)];
      if (separation(a, b) > 0.15 || Math.abs(a[1] - b[1]) < 45) continue;
      const top = a[1] > b[1] ? a : b,
        bottom = a[1] > b[1] ? b : a;
      if (
        top[1] < Math.min(...components.map((c) => c.minY)) - 18 ||
        !components.some((c) => Math.hypot(top[0] - c.x, top[2] - c.z) < 32)
      )
        continue;
      const key = `${key3(top)};${key3(bottom)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push([bottom, top]);
    }
  candidates.sort((a, b) => b[1][1] - b[0][1] - (a[1][1] - a[0][1]));
  const selected = [];
  for (const edge of candidates) {
    if (selected.some((s) => separation(s[1], edge[1]) < 15)) continue;
    selected.push(edge);
    if (selected.length >= 2) break;
  }
  return selected;
}

/** Optional night treatment only: no building replacement or collision override. */
export function buildWesternTowerLights(scene, data, cityMeshes, buildingMetadata = [], { buildingGround } = {}) {
  const group = new THREE.Group();
  group.name = 'Western Calgary architectural crown lighting';
  scene.add(group);
  const metadata =
      buildingMetadata instanceof Map ? buildingMetadata : new Map(buildingMetadata.map((b) => [b.id, b])),
    nameFor = (b) => b.name || metadata.get(b.osmId)?.name || metadata.get(b.id)?.name || '',
    westVillage = data.buildings.find((b) => /west village towers/i.test(nameFor(b))),
    eighth = data.buildings.find((b) => /^eighth avenue place$/i.test(nameFor(b))),
    eighthLeaves = data.buildings.filter((b) => /^eighth avenue place (east|west)$/i.test(nameFor(b))),
    core = new LightBatch(),
    halo = new LightBatch(),
    wash = new LightBatch(),
    glass = new LightBatch(),
    towers = [],
    missing = [],
    stats = {
      towers: 0,
      ledSegments: 0,
      verticalSpines: 0,
      sourceRoofComponents: 0,
      inferredCrowns: 0,
      drawCalls: 0,
      triangles: 0,
      pointLights: 0,
    };
  function addTower(name, components, geometry, record, { inferSlant = false, spines = false } = {}) {
    if (!components.length) {
      missing.push(`${name}: no usable mapped upper roof`);
      return;
    }
    const color = new THREE.Color(/eighth/i.test(name) ? 0xc1dfff : 0x78c6ff),
      tower = {
        name,
        sourceDates: record?.sourceDates || [],
        sourceBuildingId: record?.id,
        measuredRoofTop: Math.max(...components.map((c) => c.maxY)),
        ...(buildingGround ? { sceneGroundOffsetM: core.verticalOffset || 0 } : {}),
        inferredCrown: false,
        ledSegments: 0,
      };
    const addEdge = (edge, offset = 0.1) => {
      const a = [edge[0][0], edge[0][1] + offset, edge[0][2]],
        b = [edge[1][0], edge[1][1] + offset, edge[1][2]];
      core.beam(a, b, 0.12, color);
      halo.beam(a, b, 0.38, color);
      tower.ledSegments++;
      stats.ledSegments++;
    };
    if (inferSlant && components[0].maxY - components[0].minY < 1) {
      // The 2020 east-tower roof is flat in this source. The completed project's
      // architect documents a translucent slanted crown; this 5.4m treatment is
      // an explicit visual inference anchored to the actual surveyed roof.
      const roof = components[0],
        outline = hull(roof.points),
        baseY = roof.maxY + 0.12;
      if (outline.length >= 3 && outline.length <= 16) {
        const minX = Math.min(...outline.map((p) => p[0])),
          maxX = Math.max(...outline.map((p) => p[0])),
          upper = outline.map(([x, z]) => [
            x,
            baseY + 1.2 + ((x - minX) / Math.max(1, maxX - minX)) * 4.2,
            z,
          ]);
        for (let i = 0; i < outline.length; i++) {
          const j = (i + 1) % outline.length,
            a = [outline[i][0], baseY, outline[i][1]],
            b = [outline[j][0], baseY, outline[j][1]];
          glass.quad(a, b, upper[j], upper[i], new THREE.Color(0x607f91));
          addEdge([upper[i], upper[j]], 0.04);
          core.beam(a, upper[i], 0.035, new THREE.Color(0xa3b7be));
        }
        tower.inferredCrown = true;
        tower.inferredRoofRise = 5.4;
        stats.inferredCrowns++;
      }
    }
    for (const component of components) {
      stats.sourceRoofComponents++;
      if (!tower.inferredCrown) for (const edge of component.edges.slice(0, 128)) addEdge(edge);
      for (const triangle of component.triangles)
        wash.triangle(...triangle.map((p) => [p[0], p[1] + 0.05, p[2]]), color);
    }
    if (spines)
      for (const edge of sourceVerticalSpines(geometry, components)) {
        const center = components[0],
          dx = edge[1][0] - center.x,
          dz = edge[1][2] - center.z,
          len = Math.hypot(dx, dz) || 1,
          shifted = edge.map((p) => [p[0] + (dx / len) * 0.1, p[1], p[2] + (dz / len) * 0.1]);
        addEdge(shifted, 0);
        stats.verticalSpines++;
      }
    towers.push(tower);
    stats.towers++;
  }
  function withGeometry(building, callback) {
    if (!building || !cityMeshes?.has(building.id)) {
      missing.push(`${building ? nameFor(building) : 'Tower complex'}: City roof geometry unavailable`);
      return;
    }
    const geometry = cityMeshes.createGeometry(building.id);
    try {
      // Keep roof/component selection thresholds in their original relative
      // frame, then move every emitted crown, halo, wash and glass vertex.
      for (const batch of [core, halo, wash, glass])
        batch.verticalOffset = buildingGround?.offsetFor(building.id) ?? 0;
      callback(geometry, cityMeshes.get(building.id));
    } finally {
      geometry.dispose();
    }
  }
  withGeometry(westVillage, (geometry, record) => {
    const components = extractWesternRoofComponents(geometry, { minHeight: 80, minArea: 25 }).sort(
        (a, b) => a.x - b.x,
      ),
      clusters = [];
    for (const component of components) {
      const previous = clusters.at(-1);
      if (!previous || component.x - previous.at(-1).x > 24) clusters.push([component]);
      else previous.push(component);
    }
    const selected = clusters
      .sort((a, b) => b.reduce((n, c) => n + c.area, 0) - a.reduce((n, c) => n + c.area, 0))
      .slice(0, 2)
      .sort((a, b) => a[0].x - b[0].x);
    selected.forEach((cluster, i) => {
      const top = Math.max(...cluster.map((c) => c.maxY)),
        roofs = cluster
          .filter((c) => c.maxY >= top - 24)
          .sort((a, b) => b.area - a.area)
          .slice(0, i === 1 ? 1 : 3);
      addTower(`West Village Towers ${i === 0 ? 'west' : 'east'}`, roofs, geometry, record, {
        inferSlant: i === 1,
      });
    });
    if (selected.length < 2)
      missing.push('West Village: source did not provide two distinct upper tower locations');
  });
  withGeometry(eighth, (geometry, record) => {
    const components = extractWesternRoofComponents(geometry, { minHeight: 140, minArea: 50 });
    for (const leaf of eighthLeaves) {
      const roofs = components
        .filter(
          (c) =>
            inPolygon(c.x, c.z, leaf) ||
            c.points.filter((p) => inPolygon(p[0], p[2], leaf)).length > c.points.length * 0.5,
        )
        .slice(0, 2);
      addTower(nameFor(leaf), roofs, geometry, record, { spines: true });
    }
  });
  function addMesh(batch, material, name) {
    const geometry = batch.geometry();
    if (!geometry) {
      material.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    stats.drawCalls++;
    stats.triangles += geometry.attributes.position.count / 3;
  }
  const coreMaterial = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  coreMaterial.colorNode = vec3(1).mul(windowGlow.mul(3.4).add(0.02));
  coreMaterial.opacityNode = windowGlow.mul(0.99).add(0.01);
  addMesh(core, coreMaterial, 'Mapped architectural roof LEDs and facade spines');
  const glowMaterial = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  glowMaterial.opacityNode = windowGlow.mul(0.075);
  addMesh(halo, glowMaterial, 'Soft architectural LED halos');
  const washMaterial = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  washMaterial.opacityNode = windowGlow.mul(0.16);
  addMesh(wash, washMaterial, 'Blue-white upper-roof light wash');
  addMesh(
    glass,
    new THREE.MeshBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.19,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    'Inferred translucent West Village east crown',
  );
  return {
    group,
    towers,
    missing,
    stats,
    dispose() {
      group.removeFromParent();
      for (const child of group.children) {
        child.geometry.dispose();
        child.material.dispose();
      }
      group.clear();
    },
  };
}
