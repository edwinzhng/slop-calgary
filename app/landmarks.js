import { buildCalgaryTower } from './landmark-tower.js';
import {
  studioBellCeramic,
  kingEddyBrick,
  brookfieldCrownMaterial,
  architecturalLED,
} from './landmark-materials.js';
import { isKingEddyObservedWall, kingEddyFacadeDetails } from './king-eddy-detail.js';
import { buildTelusSky, telusSection as horizontalSection } from './landmark-telus.js';
import * as THREE from 'three/webgpu';
import { abs, color, mix, normalWorldGeometry, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { project, inside } from './geo.js';
import { facadeMaterial, windowGlow } from './materials.js';
import { createLandmarkGroundPlacement } from './landmark-ground.js';
import { PEACE_ANCHORS, PEACE_SURFACE_LIMITS, PEACE_WALKWAY } from './peace-surfaces.js';
import { createPeaceShell, createPeaceSidewalk } from './peace-shell.js';

// Surveyed City shells are retained where available. The remaining landmark
// details use mapped anchors and architectural references; they are estimates,
// not BIM or a photographic reconstruction. References:
// calgarytower.com/architecture; zeidler.com/projects/the-bow;
// big.dk/projects/telus-sky-4861; afkstudios.com/projects/brookfield-place-calgary;
// snohetta.com/projects/calgary-central-library; studiobell.ca/the-building;
// calgary.ca/arts-culture/heritage-sites/city-hall-character.html;
// calatrava.com/projects/peace-bridge-calgary.html; cana.ca/project-details/Olympic-Saddledome.
export function buildLandmarks(scene, context = {}) {
  const exclusions = [],
    colliders = [],
    walkSlabs = [],
    labels = [],
    buckets = new Map();
  const identity = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const anchor = new THREE.Matrix4();
  const boxPrototype = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const beamPrototypes = new Map();
  const measuredLandmarks = [];
  const groundPlacement = context.ground ? createLandmarkGroundPlacement(context.ground, context) : null;
  let activeExclusion, activePlacement;
  let activeGeometryRole = 'authored-companion';
  const materials = {
    concrete: new THREE.MeshStandardNodeMaterial({ color: 0xb5b4aa, roughness: 0.88 }),
    white: new THREE.MeshStandardNodeMaterial({ color: 0xe3e5df, roughness: 0.65 }),
    red: new THREE.MeshStandardNodeMaterial({ color: 0xb62827, roughness: 0.4, metalness: 0.35 }),
    steel: new THREE.MeshStandardNodeMaterial({ color: 0x9bb1b9, roughness: 0.38, metalness: 0.7 }),
    dark: new THREE.MeshStandardNodeMaterial({ color: 0x29343d, roughness: 0.55, metalness: 0.45 }),
    blue: facadeMaterial(1),
    glass: facadeMaterial(2),
    bronze: new THREE.MeshStandardNodeMaterial({ color: 0xa87242, roughness: 0.44, metalness: 0.38 }),
    cedar: new THREE.MeshStandardNodeMaterial({ color: 0x815639, roughness: 0.85 }),
    libraryStone: new THREE.MeshStandardNodeMaterial({ roughness: 0.91 }),
    roof: new THREE.MeshStandardNodeMaterial({ color: 0xc7c4b8, roughness: 0.83, side: THREE.DoubleSide }),
    warm: new THREE.MeshStandardNodeMaterial({ color: 0xcdb991, roughness: 0.6 }),
    curtain: facadeMaterial(0),
    sandstone: new THREE.MeshStandardNodeMaterial({ color: 0xc7b38c, roughness: 0.92 }),
    terracotta: new THREE.MeshStandardNodeMaterial({ color: 0x9f8479, roughness: 0.75 }),
    gold: new THREE.MeshStandardNodeMaterial({ color: 0xc2aa68, roughness: 0.34, metalness: 0.68 }),
    ceramic: studioBellCeramic(),
    ceramicBronze: studioBellCeramic({ bronze: true }),
    kingEddyBrick: kingEddyBrick(),
    brookfieldCrown: brookfieldCrownMaterial(),
    crownLED: architecturalLED(),
    canopyGlass: new THREE.MeshStandardNodeMaterial({
      color: 0xb3ccd6,
      roughness: 0.23,
      transparent: true,
      opacity: 0.22,
      forceSinglePass: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  };
  materials.warm.emissiveNode = color(0xffca85).mul(windowGlow).mul(0.22);
  materials.libraryStone.colorNode = mix(
    color(0x92938e),
    color(0xb7b6ae),
    smoothstep(0.1, 0.9, abs(normalWorldGeometry.y)),
  );
  materials.canopyGlass.userData.noShadow = true;

  function add(
    geometry,
    material,
    position = [0, 0, 0],
    quaternion = identity,
    placement = activePlacement,
    role = activeGeometryRole,
  ) {
    const transform = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    );
    transform.premultiply(anchor);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.applyMatrix4(transform);
    if (!flat.attributes.uv) {
      flat.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(new Float32Array(flat.attributes.position.count * 2), 2),
      );
    }
    // Keep only the common attributes so arbitrary primitive types batch cleanly.
    for (const key of Object.keys(flat.attributes)) {
      if (!['position', 'normal', 'uv'].includes(key)) flat.deleteAttribute(key);
    }
    if (!flat.attributes.normal) flat.computeVertexNormals();
    if (material === materials.ceramic || material === materials.ceramicBronze) {
      const { position, normal, uv } = flat.attributes;
      for (let i = 0; i < position.count; i++) {
        const across =
          (position.getX(i) - 1321.4) * normal.getZ(i) - (position.getZ(i) - 135) * normal.getX(i);
        uv.setXY(i, across, position.getY(i));
      }
    }
    if (groundPlacement) {
      groundPlacement.placeGeometry(flat, placement);
      flat.userData.landmarkGroundRole = role;
    }
    if (!buckets.has(material)) buckets.set(material, []);
    buckets.get(material).push(flat);
  }

  function addMeasured(ids, material, finish) {
    if (!ids.every((id) => context.cityMeshes?.has(id))) return false;
    const inverse = anchor.clone().invert();
    for (const id of ids) {
      const placement = groundPlacement?.source(id);
      const geometry = context.cityMeshes.createGeometry(id);
      const p = geometry.attributes.position,
        n = geometry.attributes.normal,
        uv = geometry.attributes.uv;
      if (typeof material === 'function') {
        const parts = new Map();
        for (let i = 0; i < p.count; i += 3) {
          const selected = material(p, n, i, id);
          if (!selected) continue;
          if (!parts.has(selected)) parts.set(selected, { position: [], normal: [], uv: [] });
          const part = parts.get(selected);
          for (let j = i; j < i + 3; j++) {
            part.position.push(p.getX(j), p.getY(j), p.getZ(j));
            part.normal.push(n.getX(j), n.getY(j), n.getZ(j));
            if (selected === materials.kingEddyBrick) {
              const across = (p.getX(j) - 1321.4) * n.getZ(j) - (p.getZ(j) - 135) * n.getX(j);
              part.uv.push(across / 72, p.getY(j));
            } else part.uv.push(uv.getX(j), uv.getY(j));
          }
        }
        for (const [selected, part] of parts) {
          const piece = new THREE.BufferGeometry();
          for (const [name, values] of Object.entries(part))
            piece.setAttribute(name, new THREE.Float32BufferAttribute(values, name === 'uv' ? 2 : 3));
          finish?.(piece);
          piece.applyMatrix4(inverse);
          add(piece, selected, [0, 0, 0], identity, placement, 'source-shell');
        }
        geometry.dispose();
      } else {
        geometry.applyMatrix4(inverse);
        add(geometry, material, [0, 0, 0], identity, placement, 'source-shell');
      }
      measuredLandmarks.push(id);
    }
    return true;
  }

  function measuredCollisions(id, bands) {
    const placement = groundPlacement?.source(id);
    const geometry = context.cityMeshes.createGeometry(id);
    geometry.applyMatrix4(anchor.clone().invert());
    const p = geometry.attributes.position,
      n = geometry.attributes.normal,
      roofs = [];
    for (let i = 0; i < p.count; i += 3) {
      if (n.getY(i) <= 0.02) continue;
      const a = [p.getX(i), p.getY(i), p.getZ(i)],
        b = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)],
        c = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
      const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(denominator) > 1e-6)
        roofs.push({
          a,
          b,
          c,
          denominator,
          minX: Math.min(a[0], b[0], c[0]),
          maxX: Math.max(a[0], b[0], c[0]),
          minZ: Math.min(a[2], b[2], c[2]),
          maxZ: Math.max(a[2], b[2], c[2]),
        });
    }
    const roofHeightAt = (x, z) => {
      let top = -Infinity;
      for (const { a, b, c, denominator, minX, maxX, minZ, maxZ } of roofs) {
        if (x < minX - 1e-4 || x > maxX + 1e-4 || z < minZ - 1e-4 || z > maxZ + 1e-4) continue;
        const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
        const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
        if (u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001)
          top = Math.max(top, u * a[1] + v * b[1] + (1 - u - v) * c[1]);
      }
      return Number.isFinite(top) ? top + 0.025 : 0;
    };
    let lastRings = [];
    for (let i = 1; i < bands.length; i++) {
      let rings = horizontalSection(geometry, bands[i - 1] + 0.033);
      const openSourceSection = !rings.length;
      if (openSourceSection) rings = lastRings;
      else lastRings = rings;
      for (const ring of rings) {
        const parents = rings.filter((other) => other !== ring && inside(...ring[0], other));
        if (parents.length % 2) continue;
        const holes = rings.filter(
          (other) =>
            other !== ring &&
            inside(...other[0], ring) &&
            rings.filter((parent) => parent !== other && inside(...other[0], parent)).length ===
              parents.length + 1,
        );
        // Some source mansards contain an open triangle seam. Keep their last
        // valid section while clipping the solid to the actual roof planes.
        const bandTop = bands[i];
        collision(
          ring,
          bandTop,
          bands[i - 1],
          (x, z) => Math.min(bandTop, roofHeightAt(x, z)),
          holes,
          placement,
        );
      }
    }
    geometry.dispose();
  }

  function box(w, h, d, x, y, z, material, rotation = 0) {
    add(
      boxPrototype.clone().scale(w, h, d),
      material,
      [x, y, z],
      new THREE.Quaternion().setFromAxisAngle(up, rotation),
    );
  }

  function cylinder(top, bottom, height, x, y, z, material, segments = 32) {
    add(new THREE.CylinderGeometry(top, bottom, height, segments), material, [x, y, z]);
  }

  function beam(a, b, radius, material, sides = 5) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start);
    if (direction.lengthSq() < 0.00001) return;
    if (!beamPrototypes.has(sides))
      beamPrototypes.set(sides, new THREE.CylinderGeometry(1, 1, 1, sides, 1, true).toNonIndexed());
    add(
      beamPrototypes.get(sides).clone().scale(radius, direction.length(), radius),
      material,
      start.add(end).multiplyScalar(0.5).toArray(),
      new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()),
    );
  }

  function footprint(ring, height, material, y = 0) {
    const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, steps: 1, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    add(geometry, material, [0, y, 0]);
  }

  function beginAt(name, x, z, height, radius, rotation = 0) {
    activePlacement = groundPlacement?.begin(name, x, z);
    anchor.compose(
      new THREE.Vector3(x, 0, z),
      new THREE.Quaternion().setFromAxisAngle(up, rotation),
      new THREE.Vector3(1, 1, 1),
    );
    activeExclusion = { name, x, z, radius };
    exclusions.push(activeExclusion);
    labels.push({ name, x, z, height: height + 12 + (activePlacement?.offsetM || 0) });
  }

  function worldRing(ring) {
    return ring.map(([x, z]) => {
      const p = new THREE.Vector3(x, 0, z).applyMatrix4(anchor);
      return [p.x, p.z];
    });
  }

  // A footprint ring removes the corresponding raw extrusion without deleting
  // neighbouring buildings. A radius alone could leave overlapping tall meshes.
  function replace(ring) {
    activeExclusion.ring = worldRing(ring);
    activeExclusion.radius = Math.max(
      ...activeExclusion.ring.map(([x, z]) => Math.hypot(x - activeExclusion.x, z - activeExclusion.z)),
    );
  }

  function collision(ring, height, minHeight = 0, heightAt, holes = [], placement = activePlacement) {
    const minHeightAt = typeof minHeight === 'function' ? minHeight : null;
    const inverse = heightAt || minHeightAt ? anchor.clone().invert() : null;
    const samplePoint = new THREE.Vector3();
    const localSample = (fn) => (x, z) => {
      samplePoint.set(x, 0, z).applyMatrix4(inverse);
      return fn(samplePoint.x, samplePoint.z);
    };
    const collider = {
      ring: worldRing(ring),
      height,
      minHeight: minHeightAt ? 0 : minHeight,
      ...(minHeightAt ? { minHeightAt: localSample(minHeightAt) } : {}),
      ...(holes.length ? { holes: holes.map(worldRing) } : {}),
      ...(heightAt
        ? {
            heightAt: localSample(heightAt),
          }
        : {}),
    };
    const placed = groundPlacement ? groundPlacement.placeCollider(collider, placement) : collider;
    colliders.push(placed);
    return placed;
  }

  function ellipse(rx, rz, count = 24) {
    return Array.from({ length: count }, (_, i) => {
      const a = (i * Math.PI * 2) / count;
      return [Math.cos(a) * rx, Math.sin(a) * rz];
    });
  }

  function roundedRect(w, d, r) {
    const points = [];
    for (const [cx, cz, start] of [
      [w / 2 - r, d / 2 - r, 0],
      [-w / 2 + r, d / 2 - r, Math.PI / 2],
      [-w / 2 + r, -d / 2 + r, Math.PI],
      [w / 2 - r, -d / 2 + r, Math.PI * 1.5],
    ]) {
      for (let i = 0; i <= 5; i++) {
        const a = start + (i * Math.PI) / 10;
        points.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
      }
    }
    return points;
  }

  function outline(ring, y, radius, material) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      beam([a[0], y, a[1]], [b[0], y, b[1]], radius, material, 4);
    }
  }

  function linePath(points, radius, material) {
    for (let i = 1; i < points.length; i++) beam(points[i - 1], points[i], radius, material, 4);
  }

  function ringLoft(rings, material, cap = true) {
    const signedArea = rings[0].reduce((area, [x, , z], i, ring) => {
      const next = ring[(i + 1) % ring.length];
      return area + x * next[2] - next[0] * z;
    }, 0);
    if (signedArea < 0) rings = rings.map((ring) => [...ring].reverse());
    const positions = [],
      uvs = [];
    function tri(a, b, c) {
      positions.push(...a, ...b, ...c);
      for (const p of [a, b, c]) uvs.push(p[0], p[1]);
    }
    for (let j = 1; j < rings.length; j++) {
      const low = rings[j - 1],
        high = rings[j];
      for (let i = 0; i < low.length; i++) {
        const next = (i + 1) % low.length;
        tri(low[i], high[i], low[next]);
        tri(low[next], high[i], high[next]);
      }
    }
    if (cap) {
      const top = rings[rings.length - 1];
      const shape = top.map(([x, , z]) => new THREE.Vector2(x, z));
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(shape, [])) tri(top[a], top[c], top[b]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    add(geometry, material);
  }

  function arch(width, height, depth, x, y, z, material, rotation = 0) {
    const radius = width / 2,
      shape = new THREE.Shape();
    shape.moveTo(-radius, 0);
    shape.lineTo(radius, 0);
    shape.lineTo(radius, height - radius);
    shape.absarc(0, height - radius, radius, 0, Math.PI, false);
    shape.lineTo(-radius, 0);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      steps: 1,
      bevelEnabled: false,
      curveSegments: 10,
    });
    add(geometry, material, [x, y, z], new THREE.Quaternion().setFromAxisAngle(up, rotation));
  }

  buildCalgaryTower({ beginAt, add, cylinder, beam, box, replace, collision, ellipse, materials });

  // The Bow's real NW-to-SE crescent replaces the old straight east-west
  // banana. Its concave and convex faces both carry six-storey steel triangles.
  beginAt('The Bow', 694.2, -229.1, 236, 57);
  const bowMapped = context.data?.buildings.find((b) => b.id === 'city-outline-28596-0');
  const bowLocal = bowMapped?.ring.map(([x, z]) => [x - 694.2, z + 229.1]);
  const polylineCurve = (points) => {
    const curve = new THREE.CurvePath();
    for (let i = 1; i < points.length; i++)
      curve.add(new THREE.LineCurve(new THREE.Vector2(...points[i - 1]), new THREE.Vector2(...points[i])));
    return curve;
  };
  const bowOuter = bowLocal
    ? polylineCurve(bowLocal.slice(27, 52).reverse())
    : new THREE.SplineCurve(
        [
          [-45, -8],
          [-36, -22],
          [-15, -35],
          [5, -38],
          [24, -30],
          [39, -13],
          [45, 11],
          [42, 32],
        ].map(([x, z]) => new THREE.Vector2(x, z)),
      );
  const bowInner = bowLocal
    ? polylineCurve(bowLocal.slice(7, 16))
    : new THREE.SplineCurve(
        [
          [-35, 3],
          [-23, 2],
          [-11, 2],
          [2, 7],
          [13, 17],
          [21, 32],
        ].map(([x, z]) => new THREE.Vector2(x, z)),
      );
  const bowRing = bowLocal || [
    ...bowOuter.getPoints(40).map((p) => [p.x, p.y]),
    ...bowInner
      .getPoints(30)
      .reverse()
      .map((p) => [p.x, p.y]),
  ];
  const measuredBow = addMeasured(['city-outline-28596-0'], materials.blue);
  if (!measuredBow) footprint(bowRing, 236, materials.blue);
  footprint(bowRing, 2.8, materials.dark, 0);
  for (const [curve, side] of [
    [bowOuter, 1],
    [bowInner, -1],
  ]) {
    const point = (t, y) => {
      const p = curve.getPoint(Math.max(0, Math.min(1, t)));
      const tangent = curve.getTangent(Math.max(0, Math.min(1, t)));
      return [p.x + tangent.y * 0.4 * side, y, p.y - tangent.x * 0.4 * side];
    };
    for (let tier = 0; tier < 9; tier++) {
      const y0 = 4 + tier * 25.6,
        y1 = Math.min(235, y0 + 25.6);
      for (let col = 0; col < 5; col++) {
        const t0 = col / 5,
          t1 = (col + 1) / 5;
        for (const direction of [1, -1]) {
          const points = [];
          for (let step = 0; step <= 8; step++) {
            const t = step / 8;
            points.push(point(t0 + (t1 - t0) * (direction > 0 ? t : 1 - t), y0 + t * (y1 - y0)));
          }
          linePath(points, 0.38, materials.steel);
        }
      }
    }
    for (let y = 4; y < 235; y += 4.1)
      linePath(
        Array.from({ length: 41 }, (_, i) => point(i / 40, y)),
        0.065,
        materials.dark,
      );
    for (const y of [4, 79, 157, 235])
      linePath(
        Array.from({ length: 41 }, (_, i) => point(i / 40, y)),
        0.4,
        materials.steel,
      );
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) beam(point(t, 3), point(t, 235), 0.18, materials.steel);
  }
  for (const t of [0, 1]) {
    const a = bowOuter.getPoint(t),
      b = bowInner.getPoint(t);
    for (let y = 3; y < 235; y += 25.6) {
      beam([a.x, y, a.y], [b.x, Math.min(235, y + 25.6), b.y], 0.36, materials.steel);
      beam([b.x, y, b.y], [a.x, Math.min(235, y + 25.6), a.y], 0.36, materials.steel);
    }
  }
  // Keep the glazing in the south-facing concavity and the public plaza open.
  box(14.6, 7.8, 0.13, 3, 3.9, 6.2, materials.glass, -0.15);
  box(14.8, 0.38, 8, 5, 7.9, 11.7, materials.steel, -0.15);
  for (const x of [-0.8, 10.8]) beam([x, 0.2, 14.4], [x, 7.73, 14.4], 0.13, materials.steel);
  replace(bowRing);
  collision(bowRing, context.cityMeshes?.get('city-outline-28596-0')?.height ?? 236);

  // Jaume Plensa's 12 m Wonderland, at the south plaza of The Bow.
  // The portrait is a hollow steel lattice with openings on both sides of the neck.
  const [wonderlandX, wonderlandZ] = project(-114.0621333, 51.04781667);
  beginAt('Wonderland', wonderlandX, wonderlandZ + 1.9, 12, 4, -0.38);
  const portrait = new THREE.CatmullRomCurve3(
    [
      [0, 1.37, 1.25],
      [2.2, 1.3, 1.2],
      [3.4, 1.22, 1.24],
      [4.35, 1.45, 1.52],
      [5.2, 1.79, 1.71],
      [6.15, 2.08, 1.76],
      [7.1, 2.26, 1.74],
      [8.15, 2.29, 1.68],
      [9.35, 2.15, 1.65],
      [10.4, 1.74, 1.43],
      [11.45, 0.97, 0.94],
      [12, 0.08, 0.08],
    ].map((p) => new THREE.Vector3(...p)),
  );
  const levels = Array.from({ length: 25 }, (_, i) => portrait.getPoint(i / 24));
  const portraitPoint = (level, angle) => {
    const { x: y, y: width, z: depth } = level,
      u = Math.sin(angle),
      v = Math.cos(angle),
      front = Math.max(0, v) ** 9,
      form = (center, spread) => Math.exp(-(((y - center) / spread) ** 2)),
      nose = 0.76 * form(7.02, 0.68) + 0.27 * form(7.7, 0.77),
      eyes = 0.23 * Math.exp(-(((Math.abs(u) - 0.36) / 0.16) ** 2)) * form(7.9, 0.45),
      mouth = 0.23 * form(5.85, 0.31) - 0.12 * form(6.07, 0.16),
      face = v * depth + front * (nose + mouth - eyes) + 0.12 * form(4.7, 0.65);
    return [width * u, y + 0.14, face];
  };
  const wires = 36,
    open = (angle) => Math.abs(Math.cos(angle)) < 0.41;
  for (let i = 0; i < wires; i++) {
    const angle = (i / wires) * Math.PI * 2;
    linePath(
      levels.filter((level) => level.x > 2.65 || !open(angle)).map((level) => portraitPoint(level, angle)),
      0.028,
      materials.steel,
    );
  }
  for (const level of levels)
    for (let i = 0; i < wires; i++) {
      const a = (i / wires) * Math.PI * 2,
        b = ((i + 1) / wires) * Math.PI * 2;
      if (level.x < 2.65 && open((a + b) / 2)) continue;
      beam(portraitPoint(level, a), portraitPoint(level, b), 0.027, materials.steel, 4);
    }
  for (const side of [-1, 1])
    collision(
      [
        [-0.98, side * 0.98],
        [0.98, side * 0.98],
        [0.86, side * 1.3],
        [-0.86, side * 1.3],
      ],
      2.7,
    );

  // Brookfield Place: increasing corner radii, a continuous pale curtain
  // wall and an open, bowl-edged glass crown, as documented by AFK and Front.
  beginAt('Brookfield Place', 411.55, -153.6, 247, 40, -0.045);
  const brookfieldRing = roundedRect(63, 41, 3.1);
  const brookfieldTop = roundedRect(63, 41, 8.5);
  ringLoft(
    [
      brookfieldRing.map(([x, z]) => [x, 0.4, z]),
      roundedRect(63, 41, 5.5).map(([x, z]) => [x, 125, z]),
      brookfieldTop.map(([x, z]) => [x, 233, z]),
    ],
    materials.curtain,
  );
  const crown = brookfieldTop.map(([x, z]) => [x, 243.6 + 3.4 * (Math.abs(x) / 31.5) ** 2, z]);
  ringLoft([brookfieldTop.map(([x, z]) => [x, 232.9, z]), crown], materials.brookfieldCrown, false);
  footprint(roundedRect(40, 23, 4), 8, materials.dark, 232);
  for (let i = 0; i < crown.length; i++) {
    const [x, , z] = crown[i];
    beam([x, 232.8, z], crown[i], 0.095, materials.steel);
    beam(crown[i], crown[(i + 1) % crown.length], 0.16, materials.steel);
    beam(
      [crown[i][0], crown[i][1] + 0.03, crown[i][2]],
      [
        crown[(i + 1) % crown.length][0],
        crown[(i + 1) % crown.length][1] + 0.03,
        crown[(i + 1) % crown.length][2],
      ],
      0.065,
      materials.crownLED,
      4,
    );
  }
  for (let floor = 3; floor <= 52; floor++) {
    const y = floor * 4.4;
    const ring = roundedRect(63.2, 41.2, 3.1 + (y / 233) * 5.4);
    outline(ring, y, 0.065, materials.steel);
  }
  for (let x = -25; x <= 25; x += 2.95) {
    for (const z of [-20.58, 20.58]) box(0.07, 222, 0.12, x, 122, z, materials.steel);
  }
  for (let z = -12; z <= 12; z += 2.95) {
    for (const x of [-31.58, 31.58]) box(0.12, 222, 0.07, x, 122, z, materials.steel);
  }
  // Tall, transparent lobby bays and the rounded winter-garden pavilion west
  // of the tower give the base architecture at pedestrian height.
  for (const x of [-25, -13, 0, 13, 25])
    for (const z of [-20.7, 20.7]) box(0.18, 12.5, 0.3, x, 6.5, z, materials.steel);
  const pavilion = roundedRect(36, 45, 4).map(([x, z]) => [x - 49, z + 5]);
  const measuredPavilion = addMeasured(['city-outline-28354-0'], materials.curtain);
  if (!measuredPavilion) {
    footprint(pavilion, 17, materials.curtain);
    outline(pavilion, 17.15, 0.16, materials.steel);
    for (let z = -14; z <= 23; z += 5) beam([-67, 17.15, z], [-31, 17.15, z], 0.13, materials.steel);
    for (let z = -14; z <= 23; z += 5)
      for (const x of [-67.12, -31.12]) box(0.14, 17, 0.14, x, 8.5, z, materials.steel);
  }
  const brookfieldSite = [
    [-69, -23],
    [34, -23],
    [34, 25],
    [-69, 29],
  ];
  replace(brookfieldSite);
  collision(brookfieldRing, 247);
  if (measuredPavilion) measuredCollisions('city-outline-28354-0', [0, 9, 16, 19.62]);
  else collision(pavilion, 17);
  if (groundPlacement && measuredPavilion)
    groundPlacement.connection(
      'brookfield-tower-pavilion',
      ['city-outline-28386-0', 'city-outline-28354-0'],
      activePlacement.ownerId,
      'The authored tower has an inferred native anchor; the measured pavilion restores its own source ground. Their joint levels and entrances still require matching source/game review.',
    );

  const telus = buildTelusSky({
    beginAt,
    box,
    beam,
    ringLoft,
    replace,
    collision,
    materials,
    ellipse,
    footprint,
    outline,
    linePath,
    add,
    scene,
    addSource: (geometry, material) =>
      add(geometry, material, [0, 0, 0], identity, activePlacement, 'source-shell'),
    cityMeshes: context.cityMeshes,
    data: context.data,
  });
  if (telus.surveyed) measuredLandmarks.push('city-outline-28341-0');

  // The circular concrete ring and the cable-supported saddle are documented
  // by CPCI and the City's roof assessment. This surface fits the City's LiDAR
  // roof samples; the original surveyed walls and entrance volumes remain.
  beginAt('Saddledome', 1393.6, 932.8, 44, 77, -0.72);
  activeExclusion.names = ['Scotiabank Saddledome'];
  const domeId = 'city-outline-27014-0',
    roofRadius = 67.65,
    fasciaRadius = 69.3,
    rotation = -0.72,
    cs = Math.cos(rotation),
    sn = Math.sin(rotation),
    saddleSurveyY = (x, z) => {
      const u = x / roofRadius,
        v = z / roofRadius;
      return 22.923 - 0.165 * u + 0.357 * v + 9.124 * u * u - 18.077 * u * v - 1.394 * v * v;
    },
    saddleY = (x, z) => saddleSurveyY(x * cs + z * sn, z * cs - x * sn);
  const domeRoof = new THREE.MeshStandardNodeMaterial({ color: 0x89929a, roughness: 0.8 });
  const domeBody = new THREE.MeshStandardNodeMaterial({ color: 0xa39c90, roughness: 0.9 });
  const domeEdge = new THREE.MeshStandardNodeMaterial({ color: 0x8d9190, roughness: 0.86 });
  const domeTrim = new THREE.MeshStandardNodeMaterial({ color: 0x962c27, roughness: 0.62 });
  domeTrim.emissiveNode = color(0xff3524).mul(windowGlow).mul(1.5);
  const measuredDome = addMeasured(
    [domeId],
    (p, n, i) => {
      if (n.getY(i) >= 0.55) {
        let closeToRoof = true;
        for (let j = i; j < i + 3; j++) {
          const x = p.getX(j) - 1393.6,
            z = p.getZ(j) - 932.8;
          closeToRoof &&= Math.hypot(x, z) <= fasciaRadius + 1.8 && p.getY(j) >= saddleSurveyY(x, z) - 2;
        }
        if (closeToRoof) return null;
      }
      return Math.min(p.getY(i), p.getY(i + 1), p.getY(i + 2)) >= 16 ? domeEdge : domeBody;
    },
    (geometry) => {
      // Lap the survey's irregular upper wall edge under the new fascia.
      // Leave the entrances, lower walls and their original footprint alone.
      const p = geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) - 1393.6,
          z = p.getZ(i) - 932.8,
          y = p.getY(i);
        const radius = Math.hypot(x, z);
        if (radius < fasciaRadius - 4 || radius > fasciaRadius + 3.2 || y < saddleSurveyY(x, z) - 2) continue;
        const scale = Math.min(1, (fasciaRadius - 0.22) / radius);
        p.setXYZ(
          i,
          1393.6 + x * scale,
          Math.min(y, saddleSurveyY(x * scale, z * scale) - 0.25),
          932.8 + z * scale,
        );
      }
      geometry.computeVertexNormals();
    },
  );
  const domeSegments = 128;
  const saddleRing = (radius, offset = 0) =>
    ellipse(radius, radius, domeSegments).map(([x, z]) => [x, saddleY(x, z) + offset, z]);
  // One indexed surface gives the shell continuous normals. The two trim
  // faces meet the ring directly, so the lights cannot detach from the roof.
  const roofPositions = [0, saddleY(0, 0) + 0.18, 0],
    roofIndices = [];
  const roofRings = 14;
  for (let band = 1; band <= roofRings; band++) {
    for (const v of saddleRing((fasciaRadius * band) / roofRings, 0.18)) roofPositions.push(...v);
    const base = 1 + (band - 1) * domeSegments,
      inner = base - domeSegments;
    for (let i = 0; i < domeSegments; i++) {
      const j = (i + 1) % domeSegments;
      if (band === 1) roofIndices.push(0, base + j, base + i);
      else roofIndices.push(inner + i, inner + j, base + i, base + i, inner + j, base + j);
    }
  }
  const roofGeometry = new THREE.BufferGeometry();
  roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
  roofGeometry.setIndex(roofIndices);
  roofGeometry.computeVertexNormals();
  const domePlacement = activePlacement;
  if (measuredDome) activePlacement = groundPlacement?.source(domeId) || domePlacement;
  add(roofGeometry, domeRoof);
  ringLoft([saddleRing(fasciaRadius - 1.0, -2.2), saddleRing(fasciaRadius + 0.16, 0.02)], domeEdge, false);
  ringLoft(
    [
      saddleRing(fasciaRadius + 0.16, 0.02),
      saddleRing(fasciaRadius + 0.16, 0.25),
      saddleRing(fasciaRadius - 0.15, 0.24),
    ],
    domeTrim,
    false,
  );
  activePlacement = domePlacement;
  if (measuredDome) {
    const inverse = anchor.clone().invert();
    const arena = context.data?.buildings.find((b) => b.id === domeId);
    if (arena)
      replace(
        arena.ring.map(([x, z]) => {
          const v = new THREE.Vector3(x, 0, z).applyMatrix4(inverse);
          return [v.x, v.z];
        }),
      );
    measuredCollisions(domeId, [0, 6, 13, 20, 28, 35, context.cityMeshes.get(domeId).height]);
  } else {
    const arenaGeometry = new THREE.CylinderGeometry(66, 63, 13, 64);
    add(arenaGeometry, domeBody, [0, 6.5, 0]);
    ringLoft(
      [saddleRing(66).map(([x, , z]) => [x, 12.9, z]), saddleRing(fasciaRadius - 1, -2.2)],
      domeBody,
      false,
    );
    for (const [x, y, z] of ellipse(65, 65, 32).map(([x, z]) => [x, saddleY(x, z) - 2, z]))
      beam([x, 2, z], [x, y, z], 0.36, materials.concrete, 4);
    for (const z of [-48, 48]) {
      box(54, 7, 19, 0, 3.5, z, materials.concrete);
      box(48, 3.3, 0.4, 0, 3.3, z + Math.sign(z) * 9.6, materials.curtain);
      box(58, 0.7, 22, 0, 7.1, z, materials.red);
      for (let x = -20; x <= 20; x += 5) box(0.25, 4.6, 0.5, x, 2.5, z + Math.sign(z) * 9.9, materials.steel);
    }
    replace(ellipse(70, 70, 48));
    collision(ellipse(70, 70, 64), 39, 0, (x, z) => saddleY(x, z) + 0.25);
  }

  // Central Library's City footprint is 145 m north-to-south, not the
  // 98 m east-to-west box used before. The warm Chinook arch is an actual void
  // below the glass volume, with a hexagonal white lattice on every elevation.
  const libraryOrigin = [1181.4, 35.05];
  beginAt('Central Library', ...libraryOrigin, 26.5, 78);
  activeExclusion.names = ['Calgary Central Library'];
  const libraryRing = [
    [1208.4, 107.3],
    [1210.2, 79.4],
    [1207.8, 53.8],
    [1201.5, 28.3],
    [1195.6, 8.8],
    [1187.5, -15.4],
    [1172.9, -37.2],
    [1161.6, -15.4],
    [1154.6, 8.6],
    [1152.6, 30.5],
    [1156.9, 64.6],
    [1168.8, 94],
    [1175.7, 104.9],
  ].map(([x, z]) => [x - libraryOrigin[0], z - libraryOrigin[1]]);
  // The mapped through-plaza meets the west shell near z=66, south of its midpoint.
  const libraryPortal = 65.9 - libraryOrigin[1];
  const libraryBase = (z) => {
    const arch = (z - libraryPortal) / 30;
    return 1.7 + 8.6 * Math.sqrt(Math.max(0, 1 - arch * arch));
  };
  const libraryShell = libraryRing.flatMap((a, i) => {
    const b = libraryRing[(i + 1) % libraryRing.length],
      steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.5);
    return Array.from({ length: steps }, (_, j) => [
      a[0] + ((b[0] - a[0]) * j) / steps,
      a[1] + ((b[1] - a[1]) * j) / steps,
    ]);
  });
  ringLoft(
    [libraryShell.map(([x, z]) => [x, libraryBase(z), z]), libraryShell.map(([x, z]) => [x, 26, z])],
    materials.glass,
  );
  footprint(libraryRing, 0.6, materials.white, 26);
  ringLoft(
    [
      libraryShell.map(([x, z]) => [x * 0.999, libraryBase(z) - 0.45, z]),
      libraryShell.map(([x, z]) => [x * 0.999, libraryBase(z), z]),
    ],
    materials.cedar,
    false,
  );
  const vaultSpan = (z) => {
    const crossings = [];
    for (let i = 0; i < libraryRing.length; i++) {
      const a = libraryRing[i],
        b = libraryRing[(i + 1) % libraryRing.length];
      if ((a[1] <= z && b[1] > z) || (b[1] <= z && a[1] > z))
        crossings.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    return [Math.min(...crossings), Math.max(...crossings)];
  };
  // The battens sit under a closed timber lining, with the carved void
  // open at the ends and no gaps between boards opening through the shell.
  const lining = [];
  let previousSpan;
  for (let i = 0; i <= 60; i++) {
    const z = libraryPortal - 30 + i;
    const span = vaultSpan(z).map((x) => [x, libraryBase(z) - 0.09, z]);
    if (previousSpan)
      lining.push(
        ...previousSpan[0],
        ...previousSpan[1],
        ...span[0],
        ...previousSpan[1],
        ...span[1],
        ...span[0],
      );
    previousSpan = span;
  }
  const soffit = new THREE.BufferGeometry();
  soffit.setAttribute('position', new THREE.Float32BufferAttribute(lining, 3));
  soffit.computeVertexNormals();
  add(soffit, materials.cedar);
  for (let z = libraryPortal - 29.5; z <= libraryPortal + 29.5; z += 1.25) {
    const [min, max] = vaultSpan(z);
    box(max - min, 0.26, 1.05, (min + max) / 2, libraryBase(z) - 0.21, z, materials.cedar);
  }
  for (let side = 0; side < libraryRing.length; side++) {
    const a = libraryRing[side],
      b = libraryRing[(side + 1) % libraryRing.length];
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz);
    const ux = dx / length,
      uz = dz / length;
    for (let row = 0; row < 5; row++) {
      const cy = 5.9 + row * 4.45;
      for (let along = 2.65 + (row % 2) * 2.55; along < length - 1.5; along += 5.1) {
        const px = a[0] + ux * along,
          pz = a[1] + uz * along;
        if (cy - 2.7 < libraryBase(pz)) continue;
        const vertices = Array.from({ length: 6 }, (_, j) => {
          const angle = Math.PI / 6 + (j * Math.PI) / 3,
            horizontal = Math.cos(angle) * 2.95;
          return [px + ux * horizontal, cy + Math.sin(angle) * 2.95, pz + uz * horizontal];
        });
        for (let j = 0; j < 6; j++) beam(vertices[j], vertices[(j + 1) % 6], 0.19, materials.white, 4);
        // White fritted diamonds interrupt the lattice, as in Snøhetta's
        // alternating glass/aluminium panels, rather than identical honeycomb.
        if ((row * 5 + Math.floor(along / 5.1) + side) % 4 === 0) {
          beam(vertices[0], vertices[2], 0.3, materials.white, 4);
          beam(vertices[3], vertices[5], 0.3, materials.white, 4);
        }
      }
    }
  }
  // OSM 1024393782–86 locates the stair runs and landing. Rise, tread
  // count and side ramp levels are inferred from the entrance photographs.
  const libraryLocal = ([x, z]) => [x - libraryOrigin[0], z - libraryOrigin[1]];
  const deckHeight = 2.91;
  const entrySections = (points, width) =>
    points.map(([x, z], i) => {
      const before = points[Math.max(0, i - 1)],
        after = points[Math.min(points.length - 1, i + 1)],
        dx = after[0] - before[0],
        dz = after[1] - before[1],
        distance = Math.hypot(dx, dz);
      return [-1, 1].map((s) => [
        x - (s * dz * width) / (2 * distance),
        z + (s * dx * width) / (2 * distance),
      ]);
    });
  const entrySlab = (ring, top, bottom, heightAt) => {
    if (heightAt) {
      const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
      const slab = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }).rotateX(-Math.PI / 2);
      const p = slab.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) > 0.5 ? heightAt(p.getX(i), p.getZ(i)) : bottom);
      slab.computeVertexNormals();
      add(slab, materials.libraryStone);
    } else footprint(ring, top - bottom, materials.libraryStone, bottom);
    const slab = collision(ring, top, bottom, heightAt);
    slab.type = 'landmark-step';
    slab.storefrontAnchor = false;
    walkSlabs.push(slab);
  };
  const entryRun = (a, b, width, startY, endY, count, bottom) => {
    a = libraryLocal(a);
    b = libraryLocal(b);
    const levels = Array.from({ length: count + 1 }, (_, i) => startY + ((endY - startY) * i) / count);
    const sections = levels.map((_, i) => {
      const x = a[0] + ((b[0] - a[0]) * i) / count;
      const z = a[1] + ((b[1] - a[1]) * i) / count;
      return [
        [x, z - width / 2],
        [x, z + width / 2],
      ];
    });
    for (let i = 0; i < count; i++)
      entrySlab(
        [...sections[i], ...sections[i + 1].slice().reverse()],
        Math.max(levels[i], levels[i + 1]),
        bottom,
      );
    if (count > 1)
      for (const side of [0, 1]) {
        const rail = ([x, z], y) => [x, y + 0.96, z];
        beam(
          rail(sections[0][side], levels[0]),
          rail(sections[count][side], levels[count]),
          0.038,
          materials.dark,
          6,
        );
        for (let i = 0; i <= count; i += 3) {
          const [x, z] = sections[i][side];
          beam([x, levels[i], z], rail([x, z], levels[i]), 0.027, materials.dark, 6);
        }
      }
  };
  entryRun([1143.7, 65.4], [1151.1, 65.6], 10.8, 0.25, 0.25, 1, 0.1);
  entryRun([1151.1, 65.6], [1156.5, 65.7], 10.8, 0.25, 1.04, 5, 0.1);
  entryRun([1156.5, 65.7], [1169.6, 66.1], 10.8, 1.04, deckHeight, 12, 0.1);
  entryRun([1169.6, 66.1], [1189.7, 66.4], 13, deckHeight, deckHeight, 1, deckHeight - 0.34);
  entryRun([1189.7, 66.4], [1209.1, 67], 9.8, deckHeight, 0.23, 17, 0.1);
  entryRun([1209.1, 67], [1213.2, 67.1], 9.8, 0.23, 0.23, 1, 0.1);
  const ramp = [
    [1157.8, 122.5],
    [1159.8, 115.8],
    [1160.4, 107],
    [1159.8, 101.9],
    [1157.2, 94],
    [1155.7, 85.4],
    [1155, 78.2],
    [1158.6, 73.15],
    [1169.8, 72.25],
  ].map(libraryLocal);
  const rampEdges = entrySections(ramp, 3.3);
  const run = ramp.map((point, i) =>
    i ? Math.hypot(point[0] - ramp[i - 1][0], point[1] - ramp[i - 1][1]) : 0,
  );
  const grade = (deckHeight - 0.23) / run.reduce((sum, length) => sum + length, 0);
  let rampY = 0.23;
  const rampTriangle = (a, b, c, y0, y1, y2) => {
    const dx1 = b[0] - a[0],
      dz1 = b[1] - a[1],
      dx2 = c[0] - a[0],
      dz2 = c[1] - a[1],
      det = dx1 * dz2 - dx2 * dz1;
    const slopeX = ((y1 - y0) * dz2 - (y2 - y0) * dz1) / det;
    const slopeZ = (dx1 * (y2 - y0) - dx2 * (y1 - y0)) / det;
    entrySlab([a, b, c], Math.max(y0, y1, y2), 0.1, (x, z) => y0 + slopeX * (x - a[0]) + slopeZ * (z - a[1]));
  };
  for (let i = 1; i < ramp.length; i++) {
    const [a, b] = rampEdges[i - 1];
    const [c, d] = rampEdges[i];
    const nextY = rampY + run[i] * grade;
    rampTriangle(a, b, c, rampY, rampY, nextY);
    rampTriangle(b, d, c, rampY, nextY, nextY);
    rampY = nextY;
  }
  // A glazed threshold opens off the landing beneath the cedar vault.
  const doorwayZ = libraryPortal - 6.3;
  box(13, 4.6, 0.26, -1, deckHeight + 2.3, doorwayZ, materials.dark);
  box(12.7, 4.25, 0.22, -1, deckHeight + 2.19, doorwayZ + 0.15, materials.curtain);
  for (const x of [-7.3, -4.1, -1, 2.1, 5.3])
    box(0.13, 4.6, 0.27, x, deckHeight + 2.3, doorwayZ + 0.22, materials.steel);
  collision(
    [
      [-7.5, doorwayZ - 0.14],
      [5.5, doorwayZ - 0.14],
      [5.5, doorwayZ + 0.3],
      [-7.5, doorwayZ + 0.3],
    ],
    deckHeight + 4.6,
    deckHeight,
  );
  replace(libraryRing);
  collision(libraryRing, 26.6, (_x, z) => libraryBase(z) - 0.45);

  // Studio Bell: nine ceramic vessels on two sides of 4 Street SE. A fifth-
  // floor bridge leaves the street open below; the King Eddy survives at its
  // western foot. Tile courses are geometry, not downloaded imagery.
  beginAt('Studio Bell', 1321.4, 135, 35, 58);
  const bellTowers = [
    [-42, -9, 9, 10, 34],
    [-40, 10, 10, 10, 24],
    [2, -10, 10, 9, 32],
    [18, -10, 10, 9, 34],
    [35, -10, 9, 9, 29],
    [3, 9, 11, 10, 30],
    [20, 10, 11, 10, 33],
    [35, 10, 10, 10, 26],
    [18, 0, 10, 12, 35],
  ];
  const measuredBell = addMeasured(['city-outline-27710-0', 'city-outline-27712-0'], (_p, _n, i, id) =>
    isKingEddyObservedWall(id, i / 3) ? materials.kingEddyBrick : materials.ceramic,
  );
  function bellPoint(cx, cz, rx, rz, height, t, a) {
    const swelling = 0.88 + 0.16 * Math.sin(t * Math.PI);
    // Superelliptic corners produce the building's rounded rectangular towers.
    const ca = Math.cos(a),
      sa = Math.sin(a);
    return [
      cx + Math.sign(ca) * Math.abs(ca) ** 0.5 * rx * swelling + Math.sin(t * Math.PI) * 1.1,
      t * height,
      cz + Math.sign(sa) * Math.abs(sa) ** 0.5 * rz * swelling,
    ];
  }
  for (const [cx, cz, rx, rz, height] of measuredBell ? [] : bellTowers) {
    const positions = [],
      uvs = [];
    for (let level = 0; level < 9; level++)
      for (let i = 0; i < 24; i++) {
        const a0 = (i * Math.PI) / 12,
          a1 = ((i + 1) * Math.PI) / 12;
        const p00 = bellPoint(cx, cz, rx, rz, height, level / 9, a0);
        const p01 = bellPoint(cx, cz, rx, rz, height, level / 9, a1);
        const p10 = bellPoint(cx, cz, rx, rz, height, (level + 1) / 9, a0);
        const p11 = bellPoint(cx, cz, rx, rz, height, (level + 1) / 9, a1);
        for (const [p, u, v] of [
          [p00, i / 24, level / 9],
          [p10, i / 24, (level + 1) / 9],
          [p01, (i + 1) / 24, level / 9],
          [p01, (i + 1) / 24, level / 9],
          [p10, i / 24, (level + 1) / 9],
          [p11, (i + 1) / 24, (level + 1) / 9],
        ]) {
          positions.push(...p);
          uvs.push(u, v);
        }
        if (level === 8) {
          positions.push(cx, height, cz, ...p11, ...p10);
          uvs.push(0.5, 0.5, 0, 0, 1, 1);
        }
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    add(geometry, materials.ceramic);
    for (let y = 2; y < height - 0.5; y += 1.55) {
      const t = y / height;
      for (let i = 0; i < 24; i++) {
        const p = bellPoint(cx, cz, rx + 0.07, rz + 0.07, height, t, (i * Math.PI) / 12);
        const q = bellPoint(cx, cz, rx + 0.07, rz + 0.07, height, t, ((i + 1) * Math.PI) / 12);
        beam(p, q, 0.012, materials.steel, 4);
      }
    }
  }
  activeGeometryRole = 'authored-multi-host-connector';
  box(41, 9.5, 18, -20, 27, -1, materials.ceramicBronze);
  box(41.2, 2.5, 17.8, -20, 26.5, -1, materials.dark);
  box(41, 0.35, 17.5, -20, 22.1, -1, materials.dark);
  activeGeometryRole = 'authored-companion';
  if (!measuredBell) for (const x of [10, 28]) box(2.4, 27, 38, x, 13.5, 0, materials.dark);
  if (measuredBell) {
    // Details sit just outside the actual south/east source planes. Keep the
    // measured low shell rather than placing a second box inside its walls.
    const detail = kingEddyFacadeDetails();
    const studioPlacement = activePlacement;
    if (groundPlacement) activePlacement = groundPlacement.source('city-outline-27712-0');
    for (const part of [...detail.windows, ...detail.cornices])
      box(
        part.width,
        part.height,
        part.depth,
        part.position[0] - 1321.4,
        part.y,
        part.position[1] - 135,
        materials.dark,
        part.rotation,
      );
    for (const [a, b] of detail.beams)
      beam([a[0] - 1321.4, a[1], a[2] - 135], [b[0] - 1321.4, b[1], b[2] - 135], 0.085, materials.dark, 4);
    activePlacement = studioPlacement;
  } else {
    box(14, 11.4, 20, -37, 5.7, 9, materials.sandstone);
    box(14.6, 0.5, 20.6, -37, 11.6, 9, materials.white);
    box(14.4, 0.35, 20.4, -37, 4.1, 9, materials.terracotta);
    for (const y of [2.5, 6.2, 9.1]) {
      for (const x of [-42, -38.5, -35, -31.5]) box(1.35, 2.1, 0.18, x, y, 19.12, materials.dark);
      for (const z of [2, 6.5, 11, 15.5]) box(0.18, 2.1, 1.3, -29.88, y, z, materials.dark);
    }
    box(17, 0.3, 4.5, -37, 3.8, 20.8, materials.dark);
  }
  for (const x of [-5, 0, 5]) box(0.22, 5.5, 0.24, x, 2.8, -19.2, materials.steel);
  replace([
    [-53, -22],
    [47, -22],
    [47, 22],
    [-53, 22],
  ]);
  if (measuredBell) {
    for (const id of ['city-outline-27710-0', 'city-outline-27712-0']) {
      measuredCollisions(id, [0, 5, 10, 15, 20, 25, 30, context.cityMeshes.get(id).height]);
    }
    // The separately modelled fifth-floor span must remain open to traffic.
    collision(
      [
        [-40.5, -10],
        [0.5, -10],
        [0.5, 8],
        [-40.5, 8],
      ],
      31.75,
      22.1,
    );
    if (groundPlacement)
      groundPlacement.connection(
        'studio-bell-fifth-floor-span',
        ['city-outline-27710-0', 'city-outline-27712-0'],
        activePlacement.ownerId,
        'The existing authored span follows the east shell. Different source ground references do not determine its physical joint levels; source/game and structural-clearance review remain required.',
      );
  } else {
    collision(
      [
        [-52, -21],
        [-28, -21],
        [-28, 21],
        [-52, 21],
      ],
      35,
    );
    collision(
      [
        [-9, -21],
        [47, -21],
        [47, 21],
        [-9, 21],
      ],
      34,
    );
  }

  // Historic City Hall: Paskapoo sandstone, Romanesque arched openings,
  // red tiled hipped roofs and the four-faced Seth Thomas clock tower.
  beginAt('Historic City Hall', 1017.75, -29.7, 33, 26, -0.045);
  activeExclusion.names = ['Calgary City Hall'];
  const hallRing = [
    [-21, -16],
    [21, -16],
    [21, 16],
    [-21, 16],
  ];
  box(37, 16.5, 28, 1.5, 8.25, 0, materials.sandstone);
  box(38.2, 0.6, 29.2, 1.5, 16.75, 0, materials.warm);
  ringLoft(
    [
      [
        [-18, 17.1, -14.5],
        [21, 17.1, -14.5],
        [21, 17.1, 14.5],
        [-18, 17.1, 14.5],
      ],
      [
        [-10, 22, -5],
        [13, 22, -5],
        [13, 22, 5],
        [-10, 22, 5],
      ],
    ],
    materials.red,
  );
  box(9.2, 27, 9.2, -15.5, 13.5, 0, materials.sandstone);
  for (const y of [5.8, 12, 20.5, 26.9]) box(9.8, 0.45, 9.8, -15.5, y, 0, materials.warm);
  ringLoft(
    [
      [
        [-20.5, 27.25, -5],
        [-10.5, 27.25, -5],
        [-10.5, 27.25, 5],
        [-20.5, 27.25, 5],
      ],
      [
        [-15.8, 33, -0.3],
        [-15.2, 33, -0.3],
        [-15.2, 33, 0.3],
        [-15.8, 33, 0.3],
      ],
    ],
    materials.red,
  );
  for (const x of [-19.9, -11.1])
    for (const z of [-4.4, 4.4]) {
      cylinder(0.5, 0.5, 7, x, 24.3, z, materials.sandstone, 10);
      cylinder(0.72, 0.72, 0.3, x, 27.85, z, materials.warm, 12);
      cylinder(0.3, 0.7, 1, x, 28.5, z, materials.dark, 8);
    }
  for (const y of [2.7, 8.2, 13.1]) {
    for (const z of [-10, 10]) {
      arch(2.7, 4.6, 0.18, -17.25, y - 2.2, z, materials.warm, -Math.PI / 2);
      arch(2, 4, 0.22, -17.45, y - 1.95, z, materials.dark, -Math.PI / 2);
    }
    for (const z of [-2.6, 0, 2.6]) arch(1.8, 4.6, 0.15, -20.22, y - 2.1, z, materials.dark, -Math.PI / 2);
    for (const side of [-1, 1])
      for (const x of [-10, -3.5, 3, 9.5, 16]) {
        arch(2.65, 4.5, 0.18, x, y - 2.1, side * 14.2, materials.warm, side > 0 ? 0 : Math.PI);
        arch(1.95, 3.9, 0.2, x, y - 1.85, side * 14.38, materials.dark, side > 0 ? 0 : Math.PI);
      }
  }
  for (const side of [-1, 1])
    for (const x of [-10, -3, 4, 11]) {
      box(3, 3.2, 1.1, x, 18.3, side * 11, materials.sandstone);
      arch(1.5, 2.6, 0.15, x, 17.05, side * 11.65, materials.dark, side > 0 ? 0 : Math.PI);
      cylinder(0, 2.1, 1.4, x, 20.6, side * 11, materials.red, 4);
    }
  // Rusticated corner quoins and broad masonry courses remain legible on foot.
  for (let y = 0.6; y < 16.5; y += 1.05) {
    for (const x of [-16.8, 19.8])
      for (const z of [-13.5, 13.5]) box(1.25, 0.87, 1.3, x, y, z, materials.warm);
  }
  function clockFace(cx, cy, cz, angle) {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(up, angle);
    add(new THREE.CircleGeometry(1.45, 40), materials.warm, [cx, cy, cz], quaternion);
    add(new THREE.TorusGeometry(1.5, 0.09, 5, 40), materials.dark, [cx, cy, cz], quaternion);
    const point = (x, y) => [
      cx + x * Math.cos(angle) + 0.055 * Math.sin(angle),
      cy + y,
      cz - x * Math.sin(angle) + 0.055 * Math.cos(angle),
    ];
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      beam(
        point(Math.sin(a) * 1.17, Math.cos(a) * 1.17),
        point(Math.sin(a) * 1.36, Math.cos(a) * 1.36),
        0.035,
        materials.dark,
        4,
      );
    }
    beam(point(0, 0), point(-0.61, 0.37), 0.06, materials.dark, 4);
    beam(point(0, 0), point(0.88, 0.58), 0.045, materials.dark, 4);
  }
  clockFace(-15.5, 24.1, 4.65, 0);
  clockFace(-15.5, 24.1, -4.65, Math.PI);
  clockFace(-10.85, 24.1, 0, Math.PI / 2);
  clockFace(-20.15, 24.1, 0, -Math.PI / 2);
  for (let step = 0; step < 6; step++)
    box(1.15, 0.24 * (step + 1), 7, -24.8 + step, 0.12 * (step + 1), 0, materials.concrete);
  replace(hallRing);
  const mappedHall = context.data?.buildings.find((b) =>
    /^(Calgary|Historic) City Hall$/i.test(b.name || ''),
  );
  if (mappedHall) {
    const inverse = anchor.clone().invert();
    collision(
      mappedHall.ring.map(([x, z]) => {
        const p = new THREE.Vector3(x, 0, z).applyMatrix4(inverse);
        return [p.x, p.z];
      }),
      33,
    );
  } else collision(hallRing, 33);
  collision(
    [
      [-20.15, -4.65],
      [-10.85, -4.65],
      [-10.85, 4.65],
      [-20.15, 4.65],
    ],
    33,
  );

  // Bankers Hall's paired rose-grey towers and different metal crowns are
  // important Calgary skyline anchors. Tower positions come from the separate
  // outlines inside the City's single named Bankers Hall footprint.
  beginAt('Bankers Hall', 195.95, 59.8, 197, 85, -0.045);
  const bankersSite = [
    [-70, -44],
    [70, -44],
    [70, 44],
    [-70, 44],
  ];
  const bankersFacade = facadeMaterial(7);
  const bankersGold = new THREE.MeshStandardNodeMaterial({
    color: 0xc1a578,
    roughness: 0.38,
    metalness: 0.53,
  });
  const bankersSilver = new THREE.MeshStandardNodeMaterial({
    color: 0xb8bdbe,
    roughness: 0.4,
    metalness: 0.58,
  });
  bankersGold.name = 'Bankers Hall west champagne metal';
  bankersSilver.name = 'Bankers Hall east silver metal';
  bankersGold.emissiveNode = color(0xb79465).mul(windowGlow).mul(0.12);
  bankersSilver.emissiveNode = color(0x9eacbc).mul(windowGlow).mul(0.11);
  const measuredBankers = addMeasured(['city-outline-24994-0'], (p, n, i) => {
    const height = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    if (height > 174) return x < 195 ? bankersGold : bankersSilver;
    return Math.abs(n.getY(i)) > 0.5 ? materials.roof : bankersFacade;
  });
  if (!measuredBankers) {
    box(137, 12.5, 83, 0, 6.25, 0, materials.terracotta);
    box(138.2, 0.7, 84.2, 0, 12.7, 0, materials.sandstone);
    for (const side of [-1, 1]) {
      for (let x = -61; x <= 61; x += 8.2) {
        arch(6, 9.2, 0.18, x, 1.2, side * 41.65, materials.dark, side > 0 ? 0 : Math.PI);
        box(0.26, 7.6, 0.28, x, 4.9, side * 41.9, materials.steel);
      }
    }
    for (const [cx, cz, crownMaterial] of [
      [-27.35, -1.75, bankersGold],
      [37.8, 10.45, bankersSilver],
    ]) {
      box(36, 173, 50, cx, 86.5, cz, bankersFacade);
      for (const y of [13, 49, 86, 124, 165, 172.5]) box(36.8, 0.6, 50.8, cx, y, cz, materials.sandstone);
      for (const x of [-17.7, 0, 17.7])
        for (const z of [-25.15, 25.15]) box(0.5, 160, 0.32, cx + x, 93, cz + z, materials.sandstone);
      for (const x of [-18.15, 18.15])
        for (const z of [-24.5, 0, 24.5]) box(0.32, 160, 0.5, cx + x, 93, cz + z, materials.sandstone);
      box(34, 5, 48, cx, 175.5, cz, crownMaterial);
      const roofRing = (w, d, y) => [
        [cx - w / 2, y, cz - d / 2],
        [cx + w / 2, y, cz - d / 2],
        [cx + w / 2, y, cz + d / 2],
        [cx - w / 2, y, cz + d / 2],
      ];
      ringLoft([roofRing(34, 48, 178), roofRing(23, 36, 188), roofRing(13.5, 23, 197)], crownMaterial);
      for (const y of [178, 183.5, 188, 192.5]) {
        const t = (y - 178) / 19;
        outline(
          [
            [cx - (34 - t * 20.5) / 2, cz - (48 - t * 25) / 2],
            [cx + (34 - t * 20.5) / 2, cz - (48 - t * 25) / 2],
            [cx + (34 - t * 20.5) / 2, cz + (48 - t * 25) / 2],
            [cx - (34 - t * 20.5) / 2, cz + (48 - t * 25) / 2],
          ],
          y,
          0.1,
          materials.dark,
        );
      }
      for (const side of [-1, 1]) {
        arch(15, 18.5, 0.25, cx, 171.5, cz + side * 25.05, crownMaterial, side > 0 ? 0 : Math.PI);
        arch(12.2, 16.8, 0.3, cx, 171.8, cz + side * 25.36, materials.dark, side > 0 ? 0 : Math.PI);
        for (const x of [-4.3, 0, 4.3])
          box(0.2, 12.5, 0.42, cx + x, 178.3, cz + side * 25.65, materials.steel);
      }
      collision(
        [
          [cx - 18, cz - 25],
          [cx + 18, cz - 25],
          [cx + 18, cz + 25],
          [cx - 18, cz + 25],
        ],
        197,
      );
    }
    replace(bankersSite);
    collision(bankersSite, 13);
  } else {
    const mapped = context.data.buildings.find((b) => b.id === 'city-outline-24994-0');
    const inverse = anchor.clone().invert();
    replace(
      mapped.ring.map(([x, z]) => {
        const p = new THREE.Vector3(x, 0, z).applyMatrix4(inverse);
        return [p.x, p.z];
      }),
    );
    measuredCollisions('city-outline-24994-0', [0, 7, 13, 23, 35, 70, 120, 170, 178, 188, 198.68]);
  }

  // OSM way 1313657677, nodes 1708971964/1708971966. These are the actual
  // NW/SE endpoints, not an assumed north-south span. Source: api.openstreetmap.org
  // /api/0.6/way/1313657677/full.json (OpenStreetMap contributors, ODbL).
  const [north, south] = PEACE_ANCHORS;
  const bridgeLength = Math.hypot(south[0] - north[0], south[1] - north[1]);
  const bridgeRotation = Math.atan2(south[0] - north[0], south[1] - north[1]);
  const bridgeCenter = [(north[0] + south[0]) / 2, (north[1] + south[1]) / 2];
  activePlacement = groundPlacement?.defer(
    'Peace Bridge',
    bridgeCenter[0],
    bridgeCenter[1],
    'The river crossing requires its own land anchors, deck/access profile and water clearance; riverbed height is not a deck datum.',
  );
  anchor.compose(
    new THREE.Vector3(bridgeCenter[0], 0, bridgeCenter[1]),
    new THREE.Quaternion().setFromAxisAngle(up, bridgeRotation),
    new THREE.Vector3(1, 1, 1),
  );
  labels.push({
    name: 'Peace Bridge',
    x: bridgeCenter[0],
    z: bridgeCenter[1],
    height: PEACE_WALKWAY.crownLight + 3,
  });
  exclusions.push({
    name: 'Peace Bridge',
    x: bridgeCenter[0],
    z: bridgeCenter[1],
    radius: bridgeLength / 2 + 2,
    ring: worldRing([
      [-4, -bridgeLength / 2 - 2],
      [4, -bridgeLength / 2 - 2],
      [4, bridgeLength / 2 + 2],
      [-4, bridgeLength / 2 + 2],
    ]),
  });
  const half = bridgeLength / 2,
    deckY = PEACE_SURFACE_LIMITS.level;
  const shell = createPeaceShell(bridgeLength);
  add(shell.steel, materials.red);
  add(shell.glass, materials.canopyGlass);
  // The center lane remains at the approach datum; both flanking walks
  // rise from that datum on short ramps, as in the shared ground query.
  const cycleway = new THREE.MeshStandardNodeMaterial({ color: 0x777773, roughness: 0.95 }),
    sidewalkWidth = (PEACE_WALKWAY.width - PEACE_WALKWAY.cycleWidth) / 2;
  materials.peaceCycleway = cycleway;
  box(PEACE_WALKWAY.cycleWidth, 0.45, bridgeLength, 0, deckY - 0.225, 0, cycleway);
  add(createPeaceSidewalk(bridgeLength), materials.concrete);
  box(0.38, 0.27, bridgeLength, 0, deckY - 1.76, 0, materials.red);
  for (const side of [-1, 1]) {
    box(
      sidewalkWidth,
      0.44,
      bridgeLength,
      (side * (PEACE_WALKWAY.width - sidewalkWidth)) / 2,
      deckY - 0.23,
      0,
      materials.concrete,
    );
    box(0.31, 0.24, bridgeLength, side * 0.205, PEACE_WALKWAY.crownLight + 0.13, 0, materials.red);
    box(0.095, 0.085, bridgeLength, side * shell.shoulder[0], shell.shoulder[1], 0, materials.steel);
    box(
      0.085,
      0.055,
      bridgeLength,
      side * PEACE_WALKWAY.guardOffset,
      PEACE_WALKWAY.railTop,
      0,
      materials.steel,
    );
    box(
      0.16,
      0.15,
      bridgeLength,
      side * PEACE_WALKWAY.guardOffset,
      PEACE_WALKWAY.railBase - 0.07,
      0,
      materials.white,
    );
  }
  const abutmentHeight = deckY - 0.46;
  for (const z of [-half, half]) box(7.8, abutmentHeight, 3.5, 0, abutmentHeight / 2, z, materials.concrete);

  // Each material becomes one draw call for all landmarks combined. This also
  // avoids hundreds of independent meshes for diagrids, floors and bridge ribs.
  let drawCalls = 0;
  for (const [material, geometries] of buckets) {
    let start = 0;
    const ranges =
      groundPlacement &&
      geometries.map((g) => {
        const count = g.attributes.position.count,
          range = { start, count, placement: g.userData.landmarkGround, role: g.userData.landmarkGroundRole };
        start += count;
        return range;
      });
    const geometry = mergeGeometries(geometries, false);
    for (const source of geometries) source.dispose();
    if (!geometry) throw new Error('Could not merge Calgary landmark geometry');
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Calgary landmarks / ${Object.entries(materials).find(([, m]) => m === material)?.[0] ?? 'facade'}`;
    mesh.castShadow = !material.userData.noShadow;
    mesh.receiveShadow = true;
    if (ranges) mesh.userData.landmarkGroundRanges = ranges;
    scene.add(mesh);
    drawCalls++;
  }
  boxPrototype.dispose();
  for (const geometry of beamPrototypes.values()) geometry.dispose();
  return {
    exclusions,
    colliders,
    walkSlabs,
    labels,
    measuredLandmarks,
    animated: [],
    drawCalls,
    ...(groundPlacement ? { groundPlacement } : {}),
  };
}
