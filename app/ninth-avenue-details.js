import * as THREE from 'three/webgpu';
import { buildingMaterial } from './materials.js';
import {
  observedBuildingMaterialZones,
  NINTH_AVENUE_MATERIAL_EVIDENCE as evidence,
  WORN_STUDIO_MATERIAL_EVIDENCE as wornEvidence,
} from './observed-building-materials.js';

function frontage(source, triangles) {
  const p = source.attributes.position,
    n = source.attributes.normal,
    endpoints = new Map();
  let bottom = Infinity;
  for (const triangle of triangles)
    for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
      const x = p.getX(i),
        y = p.getY(i),
        z = p.getZ(i),
        key = `${x},${z}`;
      bottom = Math.min(bottom, y);
      if (!endpoints.has(key) || endpoints.get(key).y < y) endpoints.set(key, { x, y, z });
    }
  const [a, b] = [...endpoints.values()].sort((a, b) => a.x - b.x),
    length = Math.hypot(b.x - a.x, b.z - a.z),
    nx = n.getX(triangles[0] * 3),
    nz = n.getZ(triangles[0] * 3);
  return {
    length,
    bottom,
    normal: [nx, 0, nz],
    top: (u) => a.y + ((b.y - a.y) * u) / length,
    point: ([u, y], depth) => [
      a.x + ((b.x - a.x) * u) / length + nx * depth,
      y,
      a.z + ((b.z - a.z) * u) / length + nz * depth,
    ],
  };
}

function builder(windows = false) {
  const positions = [],
    colors = [],
    uvs = [],
    tint = new THREE.Color();
  const triangle = (
    a,
    b,
    c,
    color,
    uv = [
      [0.02, 0.98],
      [0.02, 0.98],
      [0.02, 0.98],
    ],
  ) => {
    tint.setHex(color);
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) colors.push(tint.r, tint.g, tint.b);
    uvs.push(...uv[0], ...uv[1], ...uv[2]);
  };
  const quad = (a, b, c, d, color) => {
    triangle(a, b, c, color);
    triangle(a, c, d, color);
  };
  const face = (wall, path, depth, color, atlas) => {
    const points = path.map((point) => wall.point(point, depth)),
      minU = Math.min(...path.map((p) => p[0])),
      minY = Math.min(...path.map((p) => p[1])),
      spanU = Math.max(...path.map((p) => p[0])) - minU,
      spanY = Math.max(...path.map((p) => p[1])) - minY,
      room = Math.floor(wall.point([minU, minY], 0)[0]) % 97,
      uv = windows
        ? path.map(([u, y]) => [
            (room + 0.06 + ((u - minU) / spanU) * 0.88) * 3,
            (Math.floor(minY / 3) + 0.06 + ((y - minY) / spanY) * 0.88) * 4,
          ])
        : atlas || path.map(() => [0.02, 0.98]);
    for (let i = 1; i < points.length - 1; i++)
      // A west->east horizontal edge crossed with up faces into this wall.
      triangle(points[0], points[i + 1], points[i], color, [uv[0], uv[i + 1], uv[i]]);
  };
  const sides = (wall, path, back, front, color) => {
    for (let i = 0; i < path.length; i++) {
      const a = path[i],
        b = path[(i + 1) % path.length];
      quad(wall.point(a, back), wall.point(a, front), wall.point(b, front), wall.point(b, back), color);
    }
  };
  return {
    quad,
    face,
    solid(wall, path, back, front, color, atlas) {
      face(wall, path, front, color, atlas);
      sides(wall, path, back, front, color);
    },
    ring(wall, outer, inner, back, front, color) {
      for (let i = 0; i < outer.length; i++) {
        const j = (i + 1) % outer.length;
        quad(
          wall.point(outer[i], front),
          wall.point(inner[i], front),
          wall.point(inner[j], front),
          wall.point(outer[j], front),
          color,
        );
      }
      sides(wall, outer, back, front, color);
      sides(wall, [...inner].reverse(), back, front, color);
    },
    geometry() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      if (windows) {
        geometry.setAttribute('wallUV', geometry.attributes.uv);
        const profile = new Uint16Array((positions.length / 3) * 4);
        for (let i = 0; i < profile.length; i += 4) {
          profile[i + 1] = Math.round((173 / 1023) * 65535);
          profile[i + 2] = Math.round(0.5 * 65535);
          profile[i + 3] = Math.round(0.375 * 65535);
        }
        geometry.setAttribute('buildingProfile', new THREE.Uint16BufferAttribute(profile, 4, true));
      }
      geometry.computeVertexNormals();
      return geometry;
    },
  };
}

const rect = (center, width, bottom, top) => [
  [center - width / 2, bottom],
  [center + width / 2, bottom],
  [center + width / 2, top],
  [center - width / 2, top],
];

// A shallow circular segment, rather than a semicircle. Widths, heights and
// relief depths are inferred from the dated views, not surveyed dimensions.
function arch(center, width, bottom, crown, rise) {
  const half = width / 2,
    k = (half * half - rise * rise) / (2 * rise),
    radius = k + rise,
    spring = crown - rise,
    points = [
      [center - half, bottom],
      [center + half, bottom],
      [center + half, spring],
    ];
  for (let i = 1; i <= 8; i++) {
    const x = half * (1 - i / 4);
    points.push([center + x, spring - k + Math.sqrt(Math.max(0, radius * radius - x * x))]);
  }
  return points;
}

function signAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#17221f';
  ctx.textAlign = 'center';
  ctx.font = '68px Georgia, serif';
  ctx.fillText('Untitled', 256, 91, 460);
  ctx.font = '17px Georgia, serif';
  ctx.fillText('ESTHETICS STUDIO', 256, 121, 440);
  ctx.fillStyle = '#234139';
  ctx.fillRect(16, 168, 192, 80);
  ctx.fillStyle = '#e6e3cc';
  ctx.font = '13px Georgia, serif';
  ctx.fillText('THE', 112, 194);
  ctx.font = '20px Georgia, serif';
  ctx.fillText('APOTHECARY', 112, 220, 180);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const atlasRect = (x0, y0, x1, y1) => [
  [x1 / 512, 1 - y1 / 256],
  [x0 / 512, 1 - y1 / 256],
  [x0 / 512, 1 - y0 / 256],
  [x1 / 512, 1 - y0 / 256],
];

export function createNinthAvenueDetails(scene, world, options = {}) {
  const group = new THREE.Group();
  group.name = '9 Avenue: source-checked north-frontage details';
  group.visible = false;
  group.userData.sources = [];
  group.userData.dimensionsMeasured = false;
  const meshes = [],
    ownedMaterials = [],
    acceptedBuildingIds = [],
    ownedStorefrontSuppressions = new Set(),
    stats = {
      sourceAccepted: false,
      compoundSourceAccepted: false,
      wornSourceAccepted: false,
      upperBlueWindows: 0,
      upperArchedWindows: 0,
      upperWornWindows: 0,
      lowerWornPanels: 0,
      inferredScreenRibs: 0,
      triangles: 0,
      drawBudget: 0,
      activeDraws: 0,
      networkRequests: 0,
      collisionChanges: 0,
      pointLights: 0,
    };
  let source,
    wornSource,
    texture,
    storefrontSuppression,
    disposed = false,
    enabled = true;
  const cleanup = () => {
    group.removeFromParent();
    for (const mesh of meshes) mesh.geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    texture?.dispose();
    for (const id of ownedStorefrontSuppressions) storefrontSuppression.delete(id);
    meshes.length = ownedMaterials.length = 0;
    ownedStorefrontSuppressions.clear();
    texture = null;
    group.clear();
  };
  const addOwnerDetails = (trim, glass, owner) => {
    if (!options.material && !ownedMaterials.length) {
      if (owner === evidence) texture = signAtlas();
      ownedMaterials.push(
        new THREE.MeshStandardNodeMaterial({
          vertexColors: true,
          ...(texture ? { map: texture } : {}),
          roughness: 0.82,
          metalness: 0.02,
        }),
      );
    }
    for (const [i, data] of [trim, glass].entries()) {
      const geometry = data.geometry();
      try {
        world.placePhotographicGeometry?.(geometry, { buildingId: owner.buildingId });
        geometry.computeBoundingSphere();
        geometry.userData.source = owner;
        const mesh = new THREE.Mesh(
          geometry,
          options.material || (i ? buildingMaterial() : ownedMaterials[0]),
        );
        mesh.name = i
          ? '9 Avenue: opaque recessed glazing'
          : '9 Avenue: shallow source-inspired facade relief';
        mesh.receiveShadow = true;
        group.add(mesh);
        meshes.push(mesh);
        stats.triangles += geometry.attributes.position.count / 3;
      } catch (error) {
        geometry.dispose();
        throw error;
      }
    }
    acceptedBuildingIds.push(owner.buildingId);
    group.userData.sources.push(owner);
    group.userData.source ??= owner;
  };
  try {
    source = options.sourceGeometry ?? world.photoWallGeometry?.(evidence.buildingId);
    wornSource = options.wornSourceGeometry ?? world.photoWallGeometry?.(wornEvidence.buildingId);
    if (source && observedBuildingMaterialZones(source, { id: evidence.buildingId })?.evidence === evidence) {
      const blue = frontage(source, [4, 5]),
        screen = frontage(source, [48, 49]),
        brick = frontage(source, [19, 20]),
        trim = builder(),
        glass = builder(true);
      const opening = (wall, path, surround, frameColor) => {
        trim.ring(wall, surround, path, 0.018, 0.085, frameColor);
        glass.face(wall, path, 0.025, 0x293e3c);
      };
      for (const fraction of [0.19, 0.5, 0.81]) {
        const u = blue.length * fraction;
        opening(blue, rect(u, 1.22, 4.72, 6.12), rect(u, 1.4, 4.63, 6.21), 0xd5d7ca);
        trim.solid(blue, rect(u, 0.04, 4.72, 6.12), 0.026, 0.06, 0xb8bfb2);
      }
      for (const fraction of [0.5, 0.81]) {
        // The mesh minimum includes buried wall. Lower openings instead use
        // an inferred visible threshold in the source display frame near y0.
        const u = blue.length * fraction;
        opening(blue, rect(u, 1.8, 1.05, 3.1), rect(u, 1.98, 0.96, 3.19), 0xc6cbbd);
      }
      opening(
        blue,
        rect(blue.length * 0.18, 1.75, 0.15, 2.9),
        rect(blue.length * 0.18, 1.9, 0.08, 2.98),
        0x3c4547,
      );
      trim.solid(
        blue,
        rect(blue.length * 0.2, 3.65, 3.4, 4.25),
        0.02,
        0.055,
        0xffffff,
        atlasRect(16, 24, 496, 144),
      );
      trim.solid(
        blue,
        [
          [0, blue.top(0) - 0.12],
          [blue.length, blue.top(blue.length) - 0.12],
          [blue.length, blue.top(blue.length) - 0.02],
          [0, blue.top(0) - 0.02],
        ],
        0.018,
        0.08,
        0x88908a,
      );

      // The source establishes a dense organic screen, but not a count or a
      // surveyed profile. Keep its deterministic approximation within the wall.
      const ribs = 80,
        segments = 4;
      for (let rib = 0; rib < ribs; rib++) {
        const center = ((rib + 0.5) * screen.length) / ribs,
          bottom = center < 1.85 ? 2.98 : screen.bottom + 0.12,
          top = screen.top(center) - 0.025,
          points = [];
        for (let j = 0; j <= segments; j++) {
          const y = bottom + ((top - bottom) * j) / segments,
            drift = 0.022 * Math.sin(rib * 1.79 + j * 1.23) + 0.009 * Math.sin(rib * 0.41 - j * 2.17),
            depth = 0.045 + 0.014 * Math.sin(rib * 0.83 + j * 1.51);
          points.push({ u: Math.max(0.026, Math.min(screen.length - 0.026, center + drift)), y, depth });
        }
        const ribColor = rib % 7 === 0 ? 0x7c7f70 : rib % 3 === 0 ? 0x626d61 : 0x74796b;
        for (let j = 0; j < segments; j++) {
          const a = points[j],
            b = points[j + 1],
            al = [a.u - 0.024, a.y],
            ar = [a.u + 0.024, a.y],
            bl = [b.u - 0.024, b.y],
            br = [b.u + 0.024, b.y];
          trim.quad(
            screen.point(al, a.depth),
            screen.point(bl, b.depth),
            screen.point(br, b.depth),
            screen.point(ar, a.depth),
            ribColor,
          );
          trim.quad(
            screen.point(al, 0.008),
            screen.point(bl, 0.008),
            screen.point(bl, b.depth),
            screen.point(al, a.depth),
            0x535d53,
          );
          trim.quad(
            screen.point(ar, a.depth),
            screen.point(br, b.depth),
            screen.point(br, 0.008),
            screen.point(ar, 0.008),
            0x535d53,
          );
        }
        for (const [p, reverse] of [
          [points[0], true],
          [points.at(-1), false],
        ]) {
          const corners = [
            screen.point([p.u - 0.024, p.y], 0.008),
            screen.point([p.u + 0.024, p.y], 0.008),
            screen.point([p.u + 0.024, p.y], p.depth),
            screen.point([p.u - 0.024, p.y], p.depth),
          ];
          if (reverse) corners.reverse();
          trim.quad(...corners, ribColor);
        }
      }
      for (const y of [2.05, 3.9, 5.75]) {
        const start = y < 2.98 ? 1.85 : 0.04;
        trim.solid(
          screen,
          rect((start + screen.length - 0.04) / 2, screen.length - 0.04 - start, y, y + 0.025),
          0.06,
          0.082,
          0x838777,
        );
      }
      opening(screen, rect(0.98, 1.18, 0.15, 2.8), rect(0.98, 1.3, 0.08, 2.9), 0x9b9e90);

      for (const fraction of [0.18, 0.5, 0.82]) {
        const u = brick.length * fraction,
          crown = brick.top(u) - 1.08,
          bottom = crown - 2.8,
          pane = arch(u, 1.42, bottom, crown, 0.22),
          frame = arch(u, 1.54, bottom - 0.06, crown + 0.06, 0.28),
          surround = arch(u, 1.75, bottom - 0.16, crown + 0.17, 0.39);
        trim.ring(brick, surround, frame, 0.016, 0.08, 0x985d49);
        opening(brick, pane, frame, 0x27362f);
        trim.solid(brick, rect(u, 1.83, bottom - 0.22, bottom - 0.1), 0.018, 0.14, 0x8a6252);
      }
      for (const [u, width, bottom, top] of [
        [brick.length * 0.17, 1.2, 0.15, 3.0],
        [brick.length * 0.51, 2.6, 1.0, 3.2],
        [brick.length * 0.82, 1.4, 1.0, 3.2],
      ])
        opening(
          brick,
          rect(u, width, bottom, top),
          rect(u, width + 0.14, bottom - 0.07, top + 0.07),
          0x353d32,
        );
      for (const [bottom, top, depth] of [
        [3.55, 3.69, 0.12],
        [7.77, 7.9, 0.1],
        [8.04, 8.18, 0.14],
      ])
        trim.solid(brick, rect(brick.length / 2, brick.length - 0.04, bottom, top), 0.018, depth, 0x8e5140);
      trim.solid(
        brick,
        rect(brick.length * 0.17, 0.7, 1.1, 2.1),
        0.08,
        0.105,
        0xffffff,
        atlasRect(16, 168, 208, 248),
      );

      addOwnerDetails(trim, glass, evidence);
      Object.assign(stats, {
        compoundSourceAccepted: true,
        upperBlueWindows: 3,
        upperArchedWindows: 3,
        inferredScreenRibs: ribs,
      });
    }
    if (
      wornSource &&
      observedBuildingMaterialZones(wornSource, { id: wornEvidence.buildingId })?.evidence === wornEvidence
    ) {
      const wall = frontage(wornSource, [6, 7]),
        trim = builder(),
        glass = builder(true),
        rose = 0xbf8195;
      const opening = (path, surround, frameColor) => {
        trim.ring(wall, surround, path, 0.018, 0.085, frameColor);
        glass.face(wall, path, 0.025, 0x293e3c);
      };
      // The western upper group is cropped in the dated view. Its full extent,
      // all dimensions and colours are inferred; no mural or sign art is copied.
      for (const fraction of [0.18, 0.5, 0.82]) {
        const u = wall.length * fraction;
        opening(rect(u, 1.9, 3.2, 4.6), rect(u, 2.08, 3.11, 4.69), rose);
        trim.solid(wall, rect(u, 0.045, 3.2, 4.6), 0.026, 0.06, rose);
      }
      const small = wall.length * 0.83,
        broad = wall.length * 0.38,
        broadWidth = wall.length * 0.6;
      opening(rect(small, 1.55, 1.15, 1.95), rect(small, 1.73, 1.06, 2.04), rose);
      // The source minimum contains buried wall. The visible threshold near y0
      // is inferred; this broad shopfront pane does not assert a doorway layout.
      opening(rect(broad, broadWidth, 0.15, 2.25), rect(broad, broadWidth + 0.18, 0.08, 2.32), 0x454b4b);
      trim.solid(
        wall,
        [
          [0.02, wall.top(0.02) - 0.11],
          [wall.length - 0.02, wall.top(wall.length - 0.02) - 0.11],
          [wall.length - 0.02, wall.top(wall.length - 0.02) - 0.02],
          [0.02, wall.top(0.02) - 0.02],
        ],
        0.018,
        0.06,
        0x303837,
      );
      addOwnerDetails(trim, glass, wornEvidence);
      Object.assign(stats, { wornSourceAccepted: true, upperWornWindows: 3, lowerWornPanels: 2 });
    }
    if (acceptedBuildingIds.length) {
      scene.add(group);
      Object.assign(stats, { sourceAccepted: true, drawBudget: meshes.length });
      world.authoredStorefrontBuildingIds ??= new Set();
      storefrontSuppression = world.authoredStorefrontBuildingIds;
      for (const id of acceptedBuildingIds) {
        if (!storefrontSuppression.has(id)) ownedStorefrontSuppressions.add(id);
        storefrontSuppression.add(id);
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (!options.sourceGeometry) source?.dispose();
    if (!options.wornSourceGeometry) wornSource?.dispose();
  }
  const show = (value) => {
    group.visible = value;
    stats.activeDraws = value ? stats.drawBudget : 0;
  };
  return {
    group,
    stats,
    acceptedBuildingIds: Object.freeze(acceptedBuildingIds),
    colliders: [],
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) show(false);
    },
    update(camera, quality = 'balanced') {
      const p = camera?.position ?? camera,
        radius = quality === 'high' ? 160 : quality === 'low' ? 75 : 110;
      show(
        !disposed &&
          enabled &&
          stats.sourceAccepted &&
          Number.isFinite(p?.x + p?.y + p?.z) &&
          p.y < 90 &&
          Math.hypot(p.x - 2222, p.z - 322) < radius,
      );
    },
    prewarm() {
      if (disposed || !stats.sourceAccepted) return () => {};
      const visible = group.visible,
        targets = meshes.slice(),
        culled = targets.map((mesh) => mesh.frustumCulled);
      let restored = false;
      show(true);
      for (const mesh of targets) mesh.frustumCulled = false;
      return () => {
        if (restored) return;
        restored = true;
        targets.forEach((mesh, i) => (mesh.frustumCulled = culled[i]));
        show(!disposed && enabled && visible);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      show(false);
      cleanup();
    },
  };
}
