import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { project, inside, nearestOnSegment } from './geo.js';
import { windowGlow } from './city-uniforms.js';
import artData from '../data/calgary-park-art.json' with { type: 'json' };

export const PARK_ART_DATA = artData;
export const BLOOM_LIMITS = Object.freeze({ draws: 2, triangles: 15000, pointLights: 0 });
const UP = new THREE.Vector3(0, 1, 0);
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

function colorGeometry(geometry, color) {
  if (geometry.index) {
    const flat = geometry.toNonIndexed();
    geometry.dispose();
    geometry = flat;
  }
  geometry.deleteAttribute('uv');
  const count = geometry.attributes.position.count,
    colors = new Float32Array(count * 3),
    c = new THREE.Color(color);
  for (let i = 0; i < count; i++) c.toArray(colors, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function combined(parts) {
  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A suspended, narrow inclined cylinder envelope; never a ground-filled column. */
export function bloomBeamCollider(a, b, radius, id, type = 'park-art-beam') {
  const dx = b[0] - a[0],
    dz = b[2] - a[2],
    length = Math.hypot(dx, dz);
  const nx = length > 0.001 ? -dz / length : 1,
    nz = length > 0.001 ? dx / length : 0,
    ring =
      length > 0.001
        ? [
            [a[0] + nx * radius, a[2] + nz * radius],
            [b[0] + nx * radius, b[2] + nz * radius],
            [b[0] - nx * radius, b[2] - nz * radius],
            [a[0] - nx * radius, a[2] - nz * radius],
          ]
        : [
            [a[0] - radius, a[2] - radius],
            [a[0] + radius, a[2] - radius],
            [a[0] + radius, a[2] + radius],
            [a[0] - radius, a[2] + radius],
          ];
  const at = (x, z) =>
    a[1] + (b[1] - a[1]) * (length > 0.001 ? nearestOnSegment(x, z, [a[0], a[2]], [b[0], b[2]]).t : 0);
  return {
    id,
    type,
    sourceId: 'bloom',
    storefrontAnchor: false,
    inferredShape: true,
    ring,
    minHeight: Math.min(a[1], b[1]) - radius,
    height: Math.max(a[1], b[1]) + radius,
    minHeightAt: (x, z) => at(x, z) - radius,
    heightAt: (x, z) => at(x, z) + radius,
  };
}

/** Original photo-informed geometry, retaining source facts and their limits. */
export function createBloomGeometry(options = {}) {
  const record = options.record || artData.bloom,
    [x, z] = project(record.longitude, record.latitude),
    groundHeight = options.groundHeight || (() => 0.2),
    baseY = finite(groundHeight(x, z, 0.2), 0.2),
    rotation = options.orientation ?? 0.22,
    cos = Math.cos(rotation),
    sin = Math.sin(rotation),
    local = (u, y, v) => new THREE.Vector3(x + u * cos + v * sin, baseY + y, z - u * sin + v * cos),
    hub = local(0, 10.4, 0),
    opaque = [],
    lenses = [],
    colliders = [],
    supports = [],
    feet = [],
    assemblies = [],
    quaternion = new THREE.Quaternion(),
    matrix = new THREE.Matrix4(),
    gray = 0x9ca79e,
    dark = 0x374341,
    pale = 0xe9eadf;
  let bolts = 0,
    metalMembers = 0,
    lensCount = 0;
  const put = (geometry, center, axis = UP, color = gray, glow = false) => {
    quaternion.setFromUnitVectors(UP, axis.clone().normalize());
    matrix.compose(center, quaternion, new THREE.Vector3(1, 1, 1));
    geometry.applyMatrix4(matrix);
    (glow ? lenses : opaque).push(colorGeometry(geometry, color));
  };
  const beam = (a, b, ra, rb = ra, color = gray, segments = 10) => {
    const direction = b.clone().sub(a),
      length = direction.length();
    if (length < 0.001) return;
    put(new THREE.CylinderGeometry(rb, ra, length, segments), a.clone().lerp(b, 0.5), direction, color);
    metalMembers++;
  };
  const basis = (axis) => {
    const direction = axis.clone().normalize(),
      u = direction
        .clone()
        .cross(Math.abs(direction.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP)
        .normalize(),
      v = direction.clone().cross(u).normalize();
    return { u, v, direction };
  };
  const flange = (at, axis, radius = 0.28) => {
    put(new THREE.CylinderGeometry(radius, radius, 0.065, 12), at, axis, 0x78867e);
    const { u, v, direction } = basis(axis);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3,
        p = at
          .clone()
          .addScaledVector(u, Math.cos(a) * radius * 0.77)
          .addScaledVector(v, Math.sin(a) * radius * 0.77)
          .addScaledVector(direction, 0.047);
      put(new THREE.CylinderGeometry(0.027, 0.027, 0.035, 6), p, direction, pale);
      bolts++;
    }
  };
  const discLamp = (at, normal, radius = 0.34) => {
    put(new THREE.CylinderGeometry(radius * 0.88, radius, 0.16, 12), at, normal, dark);
    put(
      new THREE.CylinderGeometry(radius * 0.82, radius * 0.82, 0.022, 12),
      at.clone().addScaledVector(normal, 0.09),
      normal,
      0xffecd2,
      true,
    );
    lensCount++;
  };
  const panelLamp = (at, normal, width = 0.9, depth = 0.48) => {
    put(new THREE.BoxGeometry(width, 0.2, depth), at, normal, dark);
    put(
      new THREE.BoxGeometry(width * 0.85, 0.022, depth * 0.8),
      at.clone().addScaledVector(normal, 0.115),
      normal,
      0xffeedb,
      true,
    );
    lensCount++;
  };
  // Three splayed supports keep the ground beneath the faceted hub open. Every
  // inferred foot samples its own actual terrain, rather than using anchorY.
  const footLayout = [
    [-5.2, -3.6],
    [5.9, -2.9],
    [-0.4, 6.8],
  ];
  for (const [i, [u, v]] of footLayout.entries()) {
    const foot = local(u, 0, v);
    foot.y = finite(groundHeight(foot.x, foot.z, 0.2), baseY);
    feet.push(foot.toArray());
    const footExcluded = (options.siteExclusions || []).some((p) =>
      inside(foot.x, foot.z, p.ring || p.footprint || p),
    );
    if (options.inWater?.(foot.x, foot.z) || footExcluded) {
      for (const g of [...opaque, ...lenses]) g.dispose();
      return {
        skipped: footExcluded ? 'inferred-foot-in-construction' : 'inferred-foot-in-water',
        record,
        anchor: [x, baseY, z],
        feet,
        colliders: [],
        supports: [],
      };
    }
    const start = foot.clone().add(new THREE.Vector3(0, 0.07, 0)),
      end = hub.clone().addScaledVector(start.clone().sub(hub).normalize(), 0.5);
    beam(start, end, 0.12, 0.205);
    flange(start.clone().lerp(end, 0.035), end.clone().sub(start), 0.29);
    put(
      new THREE.CylinderGeometry(0.37, 0.4, 0.12, 12),
      foot.clone().add(new THREE.Vector3(0, 0.055, 0)),
      UP,
      0x818a80,
    );
    supports.push({
      id: `bloom-foot-${i}`,
      x: foot.x,
      z: foot.z,
      baseY: foot.y,
      profile: { height: 0.25, radius: 0.4 },
      storefrontAnchor: false,
      inferred: true,
    });
    colliders.push({
      id: `bloom-foot-pad-${i}`,
      sourceId: 'bloom',
      type: 'park-art-foot',
      storefrontAnchor: false,
      inferredShape: true,
      ring: Array.from({ length: 8 }, (_, k) => [
        foot.x + Math.sin((k * Math.PI) / 4) * 0.4,
        foot.z + Math.cos((k * Math.PI) / 4) * 0.4,
      ]),
      minHeight: foot.y - 0.005,
      height: foot.y + 0.12,
    });
    // Short bands preserve the tapered leg's clearance on steep inclines and
    // give camera/vertical sweeps the same suspended shape as the visible metal.
    for (let k = 0; k < 6; k++)
      colliders.push(
        bloomBeamCollider(
          start
            .clone()
            .lerp(end, k / 6)
            .toArray(),
          start
            .clone()
            .lerp(end, (k + 1) / 6)
            .toArray(),
          0.21,
          `bloom-leg-${i}-${k}`,
          'park-art-leg',
        ),
      );
  }
  put(new THREE.IcosahedronGeometry(0.82, 0), hub, UP, 0x7c8c81);
  colliders.push({
    id: 'bloom-hub',
    sourceId: 'bloom',
    type: 'park-art-hub',
    storefrontAnchor: false,
    inferredShape: true,
    ring: [
      [x - 0.83, z - 0.83],
      [x + 0.83, z - 0.83],
      [x + 0.83, z + 0.83],
      [x - 0.83, z + 0.83],
    ],
    minHeight: hub.y - 0.83,
    height: hub.y + 0.83,
  });
  // Six distinct recovered-light assemblies. Counts of individual lenses and
  // orientations are photo-informed approximations, not an electrical schedule.
  const tips = [
    { kind: 'six-disc-rosette', p: [0.7, 22.75, 0.5], count: 6, radius: 1.0 },
    { kind: 'eight-disc-rosette', p: [8.8, 19.6, 4.8], count: 8, radius: 1.04 },
    { kind: 'twin-hood', p: [-10.4, 21.0, -2.4] },
    { kind: 'four-globe-bar', p: [11.5, 12.2, -4.6] },
    { kind: 'eight-arm-flower', p: [-7.0, 10.4, 8.9] },
    { kind: 'three-panel-branch', p: [2.8, 14.3, -10.4] },
  ];
  for (const [i, tip] of tips.entries()) {
    const end = local(...tip.p),
      axis = end.clone().sub(hub).normalize(),
      start = hub.clone().addScaledVector(axis, 0.55),
      { u, v } = basis(axis),
      normal = axis.clone().negate();
    beam(start, end, 0.18, 0.075);
    flange(hub.clone().addScaledVector(axis, 0.87), axis, 0.27);
    colliders.push(bloomBeamCollider(start.toArray(), end.toArray(), 0.18, `bloom-arm-${i}`));
    assemblies.push({ kind: tip.kind, tip: end.toArray(), source: 'photo-informed-six-source-assemblies' });
    if (tip.count) {
      for (let j = 0; j < tip.count; j++) {
        const a = (j * Math.PI * 2) / tip.count,
          p = end
            .clone()
            .addScaledVector(u, Math.cos(a) * tip.radius)
            .addScaledVector(v, Math.sin(a) * tip.radius);
        beam(end, p, 0.035, 0.028, dark, 6);
        discLamp(p, normal, 0.32);
      }
    } else if (tip.kind === 'twin-hood') {
      const left = end.clone().addScaledVector(u, -0.58),
        right = end.clone().addScaledVector(u, 0.58);
      beam(left, right, 0.05, 0.05);
      panelLamp(left, normal, 0.99, 0.62);
      panelLamp(right, normal, 0.99, 0.62);
    } else if (tip.kind === 'four-globe-bar') {
      const a = end.clone().addScaledVector(u, -1.15),
        b = end.clone().addScaledVector(u, 1.15);
      beam(a, b, 0.055, 0.055);
      for (let j = 0; j < 4; j++) {
        const p = a
          .clone()
          .lerp(b, j / 3)
          .addScaledVector(v, 0.3);
        beam(a.clone().lerp(b, j / 3), p, 0.025, 0.025);
        put(new THREE.SphereGeometry(0.22, 10, 6), p, UP, 0xffefd9, true);
        lensCount++;
      }
    } else if (tip.kind === 'eight-arm-flower') {
      for (let j = 0; j < 8; j++) {
        const a = (j * Math.PI) / 4,
          outward = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)),
          curve = new THREE.QuadraticBezierCurve3(
            end,
            end.clone().addScaledVector(outward, 0.55).addScaledVector(axis, 0.25),
            end.clone().addScaledVector(outward, 1.65).addScaledVector(axis, -0.24),
          );
        put(new THREE.TubeGeometry(curve, 6, 0.025, 5, false), new THREE.Vector3());
        metalMembers++;
        discLamp(curve.getPoint(1), normal, 0.22);
      }
    } else {
      for (let j = 0; j < 3; j++) {
        const a = (j * Math.PI * 2) / 3,
          p = end
            .clone()
            .addScaledVector(u, Math.cos(a) * 1.25)
            .addScaledVector(v, Math.sin(a) * 1.25);
        beam(end, p, 0.04, 0.035);
        panelLamp(p, normal, 0.85, 0.44);
      }
    }
  }
  const metal = combined(opaque),
    glass = combined(lenses);
  const triangles = (g) => (g.index?.count || g.attributes.position.count) / 3;
  return {
    record,
    anchor: [x, baseY, z],
    hub: hub.toArray(),
    feet,
    assemblies,
    colliders,
    supports,
    geometry: { metal, glass },
    stats: {
      legCount: 3,
      luminaireAssemblies: 6,
      individualLenses: lensCount,
      centralPolyhedra: 1,
      bolts,
      metalMembers,
      triangles: triangles(metal) + triangles(glass),
      heightAboveAnchor: Math.max(metal.boundingBox.max.y, glass.boundingBox.max.y) - baseY,
    },
  };
}

/** Two shared meshes; steady warm lenses follow the city's existing night fade. */
export function createParkArt(scene, options = {}) {
  const record = options.data?.bloom || artData.bloom,
    [x, z] = project(record.longitude, record.latitude);
  const excluded = (options.siteExclusions || []).some((p) => inside(x, z, p.ring || p.footprint || p));
  const model = excluded
    ? { skipped: 'current-construction-site', colliders: [], supports: [], record }
    : createBloomGeometry({ ...options, record });
  const meshes = [],
    materials = {};
  if (!model.skipped) {
    materials.metal = new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.47,
      metalness: 0.65,
    });
    materials.glass = new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 0.1,
    });
    materials.glass.emissiveNode = attribute('color').mul(windowGlow).mul(4.2);
    for (const [kind, geometry] of Object.entries(model.geometry)) {
      const mesh = new THREE.Mesh(geometry, materials[kind]);
      mesh.name = `Bloom / ${kind}`;
      mesh.castShadow = false;
      mesh.receiveShadow = kind === 'metal';
      scene.add(mesh);
      meshes.push(mesh);
    }
  }
  const stats = {
    ...model.stats,
    artworks: model.skipped ? 0 : 1,
    draws: meshes.length,
    materials: Object.keys(materials).length,
    pointLights: 0,
    runtimeTextures: 0,
    sourceThirdPartyMeshes: 0,
    visible: !model.skipped,
    skipped: model.skipped || null,
  };
  const labels = model.skipped
    ? []
    : [{ name: 'Bloom · Michel de Broin', x, z, height: model.anchor[1] + 24 }];
  let disposed = false;
  return {
    model,
    record,
    meshes,
    materials,
    colliders: model.colliders,
    supports: model.supports,
    labels,
    stats,
    update(camera, quality = 'balanced') {
      if (disposed || model.skipped) return;
      const p = camera?.position || camera || { x, y: 2, z },
        distance = Math.hypot(p.x - x, p.z - z, (p.y || 0) - (model.anchor[1] + 10));
      stats.visible = distance < (quality === 'high' ? 1800 : quality === 'low' ? 500 : 1100);
      for (const mesh of meshes) mesh.visible = stats.visible;
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
export const buildParkArt = createParkArt;
