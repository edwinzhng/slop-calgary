import * as THREE from 'three/webgpu';
import manifest from '../data/calgary-park-life.json' with { type: 'json' };
import { SpatialIndex, bounds, inPolygon, inside } from './geo.js';
import { createParkLifePrototypes } from './park-life-models.js';
import { DOG_PARK } from './discovery-spots.js';
import { createCelActorMaterial } from './materials.js';

export const PARK_LIFE_MANIFEST = manifest;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (t) => {
  t = clamp(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const species = ['rabbit', 'squirrel', 'goose', 'beaver', 'dog'];
// Tomkins inventory includes event seating throughout the central plaza.
// Render a sparse everyday arrangement using existing asset positions.
const tomkinsSeats = new Set([
  'city-seat-64568',
  'city-seat-65128',
  'city-seat-66078',
  'city-seat-66187',
  'city-seat-67842',
  'city-seat-68099',
  'city-seat-68621',
  'city-seat-97625',
  'city-seat-97631',
  'city-seat-97942',
]);
const LIMITS = {
  low: {
    animals: 16,
    seats: 24,
    radius: 90,
    seatingRadius: 100,
    rabbit: 6,
    squirrel: 5,
    goose: 8,
    beaver: 1,
    dog: 3,
  },
  balanced: {
    animals: 32,
    seats: 64,
    radius: 140,
    seatingRadius: 170,
    rabbit: 12,
    squirrel: 10,
    goose: 14,
    beaver: 2,
    dog: 3,
  },
  high: {
    animals: 48,
    seats: 120,
    radius: 200,
    seatingRadius: 230,
    rabbit: 18,
    squirrel: 14,
    goose: 20,
    beaver: 3,
    dog: 3,
  },
};

/** Deterministic eased locomotion; paths are source-masked game routes, not sightings. */
export function sampleParkAnimal(candidate, elapsed, out = {}) {
  const route = candidate.path,
    n = route.length;
  const clock = Math.max(0, elapsed + candidate.phase) / candidate.period;
  const section = Math.floor(clock),
    t = clock - section,
    i = section % n;
  const a = route[i],
    b = route[(i + 1) % n],
    previous = route[(i + n - 1) % n];
  const idle = candidate.swimming
    ? 0.055
    : candidate.species === 'rabbit'
      ? 0.5
      : candidate.species === 'squirrel'
        ? 0.61
        : 0.37;
  const moveU = clamp((t - idle) / (1 - idle));
  const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let progress = smooth(moveU),
    hop = 0,
    hopPhase = 0;
  if (candidate.species === 'rabbit' && !candidate.swimming && moveU > 0 && moveU < 1) {
    const hops = Math.max(1, Math.ceil(distance / 1.25)),
      q = moveU * hops;
    hopPhase = q - Math.floor(q);
    progress = (Math.floor(q) + smooth(hopPhase)) / hops;
    hop =
      Math.pow(Math.max(0, Math.sin(hopPhase * Math.PI)), 1.5) * (0.14 + Math.min(0.07, distance * 0.012));
  }
  const moving = Math.sin(moveU * Math.PI) ** 2;
  const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
  const previousHeading = Math.atan2(a[0] - previous[0], a[1] - previous[1]);
  out.x = a[0] + (b[0] - a[0]) * progress;
  out.z = a[1] + (b[1] - a[1]) * progress;
  out.heading = previousHeading + angleDelta(previousHeading, heading) * smooth(t / Math.max(0.02, idle));
  out.gait =
    ((section * distance + distance * progress) / (candidate.species === 'goose' ? 0.35 : 0.2)) * Math.PI * 2;
  out.moving = moving;
  out.progress = progress;
  out.section = i;
  out.hop = hop;
  out.hopPhase = hopPhase;
  out.yOffset = hop;
  out.pitch = 0;
  out.roll = 0;
  if (candidate.species === 'rabbit') out.pitch = -0.12 * Math.sin(hopPhase * Math.PI) * moving;
  else if (candidate.species === 'squirrel') {
    out.yOffset = 0.025 * Math.abs(Math.sin(out.gait)) * moving;
    out.pitch =
      -0.12 * moving +
      0.12 * Math.sin((t / idle) * Math.PI) ** 2 * Math.max(0, 1 - moving) * Number(t < idle);
  } else if (candidate.species === 'goose' && !candidate.swimming) {
    out.yOffset = 0.014 * Math.abs(Math.sin(out.gait)) * moving;
    out.roll = 0.035 * Math.sin(out.gait) * moving;
  } else if (candidate.species === 'beaver' && !candidate.swimming)
    out.roll = 0.025 * Math.sin(out.gait) * moving;
  else if (candidate.species === 'dog') {
    if (candidate.id === 'pixel') out.gait = (distance * progress * Math.PI * 2) / 0.92;
    out.yOffset = (candidate.id === 'pixel' ? 0.018 : 0.044) * Math.abs(Math.sin(out.gait)) * moving;
    out.roll = (candidate.id === 'pixel' ? 0.024 : 0.047) * Math.sin(out.gait) * moving;
  }
  if (candidate.swimming) {
    out.yOffset =
      (candidate.species === 'beaver' ? -0.19 : -0.18) + 0.012 * Math.sin(elapsed * 1.7 + candidate.phase);
    out.roll = 0.012 * Math.sin(elapsed * 1.2 + candidate.phase);
  }
  out.earPitch =
    -0.12 - 0.25 * Math.sin(hopPhase * Math.PI) * moving + 0.035 * Math.sin(elapsed * 2.3 + candidate.phase);
  out.tailYaw =
    (candidate.swimming ? 0.1 : 0.045 + 0.12 * moving) * Math.sin(elapsed * 2.4 + candidate.phase);
  out.neckPitch = !candidate.swimming && t < idle ? Math.sin((t / idle) * Math.PI) ** 4 * 0.66 : 0;
  return out;
}

export function createParkLife(scene, world, options = {}) {
  const source = options.manifest || manifest,
    parkData = options.parkData || {};
  const bowFlock =
    source === manifest
      ? [
          [-611, -841.5],
          [-608, -844.1],
          [-604.8, -843.0],
          [-602.2, -847.8],
          [-598.4, -849.0],
        ].map(([x, z], i) => ({
          id: `west-eau-claire-bow-goose-${i}`,
          species: 'goose',
          swimming: true,
          phase: i * 0.82,
          period: 7.3,
          size: 0.89 + i * 0.048,
          path: [
            [x - 2.4, z + 1.1],
            [x + 0.2, z - 1.15],
            [x + 3.1, z - 0.8],
            [x + 2.7, z + 1.2],
          ],
        }))
      : [];
  const dogs =
    source === manifest
      ? [
          [
            [1711, -86],
            [1715.6, -84.5],
            [1717, -80.5],
            [1711.5, -80.4],
          ],
          [
            [1703, -99],
            [1709, -102],
            [1717, -95],
            [1711, -88],
          ],
          [
            [1711, -64],
            [1723, -68],
            [1720, -80],
            [1711, -77],
          ],
        ].map((path, i) => ({
          id: i === 0 ? 'pixel' : `east-village-dog-${i}`,
          species: 'dog',
          swimming: false,
          path,
          phase: i * 2.2,
          period: i === 0 ? 5.5 : 4.6 + i * 0.58,
          size: i === 0 ? 1 : 0.83 + i * 0.13,
        }))
      : [];
  const stats = {
    parkSeatRecords: source.meta.sourceRecords,
    parkSeatsAvailable: 0,
    wildlifeCandidates: source.animals.length + bowFlock.length + dogs.length,
    validWildlifeCandidates: 0,
    activeAnimals: 0,
    activeFurniture: 0,
    activeSpecies: { rabbit: 0, squirrel: 0, goose: 0, beaver: 0, dog: 0 },
    drawCalls: 0,
    activeDrawCalls: 0,
    prototypeTriangles: 0,
    activeTriangles: 0,
    updateMs: 0,
    sourceDate: source.meta.asOf,
  };
  const groundIndex = new SpatialIndex(60),
    pavingIndex = new SpatialIndex(40),
    habitatIndex = new SpatialIndex(120),
    seatIndex = new SpatialIndex(12),
    furnitureIndex = new SpatialIndex(80),
    candidateIndex = new SpatialIndex(80);
  const waterIndex = world.waterIndex || new SpatialIndex(100);
  if (!world.waterIndex) for (const p of world.data?.waters || []) waterIndex.insert(p, bounds(p.ring));
  for (const p of parkData.ground || []) if (p.ring?.length >= 3) groundIndex.insert(p, bounds(p.ring));
  for (const p of parkData.paving || []) if (p.ring?.length >= 3) pavingIndex.insert(p, bounds(p.ring));
  for (const habitat of source.habitats)
    for (const polygon of habitat.rings)
      habitatIndex.insert({ ...polygon, habitat: habitat.id }, bounds(polygon.ring));
  const excluded = world.developments?.surfaceExclusions || [];
  const isExcluded = (x, z) => excluded.some((p) => inside(x, z, p.ring));
  const inWater = (x, z) =>
    world.inWater ? world.inWater(x, z) : [...waterIndex.near(x, z)].some((p) => inPolygon(x, z, p));
  const groundY = (x, z) => {
    const value = world.groundHeight?.(x, z, 0.2);
    return Number.isFinite(value) ? value : 0.2;
  };
  const terrainOffset = world.terrain?.offsetAt
    ? (x, z) => {
        const value = world.terrain.offsetAt(x, z);
        return Number.isFinite(value) ? value : 0;
      }
    : null;
  const solid = (x, z, y, height = 0.8, ignoreFurniture = false) => {
    for (const b of world.buildingIndex?.near(x, z, 0.5) || []) {
      if (ignoreFurniture && b.type === 'park-furniture') continue;
      const low = b.minHeightAt?.(x, z) ?? b.minHeight ?? 0,
        high = b.heightAt?.(x, z) ?? b.height ?? 0;
      if (y + height > low + 0.015 && y < high - 0.015 && inPolygon(x, z, b)) return true;
    }
    return false;
  };
  const seats = source.seats.filter(
    (s) =>
      (s.parkAsset !== 'BLN001' || s.memorial || tomkinsSeats.has(s.id)) &&
      !isExcluded(s.x, s.z) &&
      !inWater(s.x, s.z) &&
      !solid(s.x, s.z, groundY(s.x, s.z), 0.8, true),
  );
  for (const seat of seats) {
    seatIndex.insert(seat, {
      minX: seat.x - 1.3,
      minZ: seat.z - 1.3,
      maxX: seat.x + 1.3,
      maxZ: seat.z + 1.3,
    });
    furnitureIndex.insert(seat, { minX: seat.x, minZ: seat.z, maxX: seat.x, maxZ: seat.z });
  }
  stats.parkSeatsAvailable = seats.length;
  const landAllowed = (x, z, habitat) => {
    if (isExcluded(x, z) || inWater(x, z)) return false;
    if (![...habitatIndex.near(x, z)].some((p) => p.habitat === habitat && inPolygon(x, z, p))) return false;
    if ((parkData.ground?.length || 0) > 0 && ![...groundIndex.near(x, z)].some((p) => inPolygon(x, z, p)))
      return false;
    if ([...pavingIndex.near(x, z)].some((p) => inPolygon(x, z, p))) return false;
    if (
      [...seatIndex.near(x, z, 1.5)].some(
        (s) => Math.hypot(s.x - x, s.z - z) < (s.kind === 'table' ? 1.7 : 1.3),
      )
    )
      return false;
    const road = world.roadIndex?.nearest(x, z, true, 28);
    if (road && !road.road.bridge && road.distance < road.width / 2 + 0.55) return false;
    const y = groundY(x, z);
    // The measured Rise can be nine metres above river grade. Height relative
    // to terrain excludes bridge decks while allowing real raised park ground.
    return y - (terrainOffset?.(x, z) || 0) < 3 && !solid(x, z, y, 0.8);
  };
  const routeAllowed = (candidate) => {
    for (let i = 0; i < candidate.path.length; i++) {
      const a = candidate.path[i],
        b = candidate.path[(i + 1) % candidate.path.length];
      for (const t of [0, 0.5]) {
        const x = a[0] + (b[0] - a[0]) * t,
          z = a[1] + (b[1] - a[1]) * t;
        if (candidate.swimming) {
          if (!inWater(x, z) || isExcluded(x, z)) return false;
        } else if (candidate.species === 'dog') {
          if (!inPolygon(x, z, DOG_PARK) || solid(x, z, groundY(x, z), 0.75)) return false;
        } else if (!landAllowed(x, z, candidate.habitat)) return false;
      }
    }
    return true;
  };
  const candidates = [...source.animals, ...bowFlock, ...dogs].filter(routeAllowed).map((candidate) => ({
    ...candidate,
    pose: {},
    firstVisible: -Infinity,
    groundHeights: candidate.swimming ? null : candidate.path.map(([x, z]) => groundY(x, z)),
    terrainOffsets:
      candidate.swimming || !terrainOffset ? null : candidate.path.map(([x, z]) => terrainOffset(x, z)),
  }));
  for (const candidate of candidates) candidateIndex.insert(candidate, bounds(candidate.path));
  stats.validWildlifeCandidates = candidates.length;
  const prototypes = createParkLifePrototypes();
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.84,
    side: THREE.DoubleSide,
  });
  const pixelMaterial = createCelActorMaterial();
  pixelMaterial.side = THREE.DoubleSide;
  const wakeMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const meshes = {},
    capacities = {
      rabbit: 18,
      rabbitEars: 36,
      squirrel: 14,
      squirrelTail: 14,
      goose: 20,
      gooseNeck: 20,
      gooseLeg: 40,
      beaver: 3,
      beaverTail: 3,
      dog: 3,
      dogTail: 3,
      pixel: 1,
      pixelHead: 1,
      pixelTail: 1,
      pixelForeleg: 2,
      pixelHindleg: 2,
      bench: 120,
      concreteBench: 120,
      table: 120,
      canoe: 1,
      wake: 24,
    };
  for (const [name, geometry] of Object.entries(prototypes)) {
    const mesh = new THREE.InstancedMesh(
      geometry,
      name === 'wake' ? wakeMaterial : name.startsWith('pixel') ? pixelMaterial : material,
      capacities[name],
    );
    mesh.name = `Calgary park life / ${name}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = name !== 'wake';
    mesh.receiveShadow = name !== 'wake';
    scene.add(mesh);
    meshes[name] = mesh;
    stats.prototypeTriangles += geometry.attributes.position.count / 3;
  }
  stats.drawCalls = Object.keys(meshes).length;
  const matrix = new THREE.Matrix4(),
    root = new THREE.Matrix4(),
    local = new THREE.Matrix4(),
    base = new THREE.Matrix4();
  const position = new THREE.Vector3(),
    rotation = new THREE.Quaternion(),
    scale = new THREE.Vector3(1, 1, 1),
    euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const counts = Object.fromEntries(Object.keys(meshes).map((name) => [name, 0]));
  let active = [],
    selectedSeats = [],
    lastSelection = -Infinity,
    lastQuality = '',
    disposed = false,
    lastTime = 0,
    lastCameraX = Infinity,
    lastCameraZ = Infinity,
    lastCameraY = Infinity;
  const write = (name, m) => {
    const mesh = meshes[name],
      i = counts[name]++;
    if (i < capacities[name]) mesh.setMatrixAt(i, m);
  };
  const child = (name, parent, x, y, z, rx = 0, ry = 0, rz = 0, size = 1) => {
    euler.set(rx, ry, rz, 'YXZ');
    rotation.setFromEuler(euler);
    position.set(x, y, z);
    scale.setScalar(size);
    local.compose(position, rotation, scale);
    matrix.copy(parent).multiply(local);
    write(name, matrix);
  };
  const poseRoot = (x, y, z, heading, pitch = 0, roll = 0, size = 1) => {
    position.set(x, y, z);
    euler.set(pitch, heading, roll, 'YXZ');
    rotation.setFromEuler(euler);
    scale.setScalar(size);
    root.compose(position, rotation, scale);
  };
  const seatHeights = new Map();
  const seatHeight = (seat) => {
    if (!seatHeights.has(seat.id)) seatHeights.set(seat.id, groundY(seat.x, seat.z) + 0.004);
    return seatHeights.get(seat.id);
  };
  const select = (elapsed, camera, quality) => {
    const p = camera?.position || camera || { x: 0, z: 0 },
      limits = LIMITS[quality === 'performance' ? 'low' : quality] || LIMITS.balanced;
    const previous = new Set(active),
      altitude = Math.max(0, (p.y || 0) - 2);
    const choices = (altitude < limits.radius ? [...candidateIndex.near(p.x, p.z, limits.radius)] : [])
      .map((candidate) => {
        const pose = sampleParkAnimal(candidate, elapsed, candidate.pose);
        const distance = Math.hypot(pose.x - p.x, pose.z - p.z, altitude);
        const score =
          candidate.id === 'pixel' && distance < 28 ? -1 : distance * (previous.has(candidate) ? 0.88 : 1);
        return { candidate, distance, score };
      })
      .filter((c) => c.distance < limits.radius)
      .sort((a, b) => a.score - b.score);
    const accepted = [],
      seen = { rabbit: 0, squirrel: 0, goose: 0, beaver: 0, dog: 0 };
    for (const entry of choices) {
      const c = entry.candidate;
      if (seen[c.species] >= limits[c.species]) continue;
      if (!active.includes(c)) c.firstVisible = elapsed;
      seen[c.species]++;
      accepted.push(c);
      if (accepted.length >= limits.animals) break;
    }
    active = accepted;
    selectedSeats = (
      altitude < limits.seatingRadius ? [...furnitureIndex.near(p.x, p.z, limits.seatingRadius)] : []
    )
      .map((seat) => ({ seat, distance: Math.hypot(seat.x - p.x, seat.z - p.z, altitude) }))
      .filter((s) => s.distance < limits.seatingRadius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limits.seats)
      .map((s) => s.seat);
    lastSelection = elapsed;
    lastQuality = quality;
    lastCameraX = p.x;
    lastCameraZ = p.z;
    lastCameraY = p.y || 0;
  };
  function update(dt, elapsed, camera, quality = 'balanced') {
    if (disposed) return;
    const begin = performance.now();
    if (!Number.isFinite(elapsed)) elapsed = lastTime + Math.min(0.1, Math.max(0, dt || 0));
    const viewpoint = camera?.position || camera || { x: 0, z: 0 };
    if (
      elapsed - lastSelection > 0.65 ||
      elapsed < lastSelection ||
      quality !== lastQuality ||
      Math.hypot(viewpoint.x - lastCameraX, viewpoint.z - lastCameraZ, (viewpoint.y || 0) - lastCameraY) > 25
    )
      select(elapsed, camera, quality);
    lastTime = elapsed;
    for (const name of Object.keys(counts)) counts[name] = 0;
    const p = camera?.position || camera || { x: 0, z: 0 };
    stats.activeSpecies = { rabbit: 0, squirrel: 0, goose: 0, beaver: 0, dog: 0 };
    for (const candidate of active) {
      const pose = sampleParkAnimal(candidate, elapsed, candidate.pose),
        kind = candidate.species,
        pixel = candidate.id === 'pixel';
      const fade = clamp((elapsed - candidate.firstVisible + 0.06) / 0.35),
        size = Math.max(0.001, candidate.size * smooth(fade));
      let baseLevel = candidate.swimming
        ? 0.075
        : candidate.groundHeights[pose.section] +
          (candidate.groundHeights[(pose.section + 1) % candidate.groundHeights.length] -
            candidate.groundHeights[pose.section]) *
            pose.progress;
      if (candidate.terrainOffsets) {
        const a = candidate.terrainOffsets[pose.section],
          b = candidate.terrainOffsets[(pose.section + 1) % candidate.terrainOffsets.length];
        // Preserve cached paving/ground-layer offsets, adding only the cheap
        // bilinear terrain deviation at the current point on this route leg.
        baseLevel += terrainOffset(pose.x, pose.z) - (a + (b - a) * pose.progress);
      }
      pose.baseY = baseLevel;
      const y = baseLevel + pose.yOffset;
      poseRoot(pose.x, y, pose.z, pose.heading, pose.pitch, pose.roll, size);
      base.copy(root);
      write(pixel ? 'pixel' : kind, base);
      stats.activeSpecies[kind]++;
      if (kind === 'rabbit')
        for (const s of [-1, 1])
          child(
            'rabbitEars',
            base,
            s * 0.052,
            0.534,
            0.206,
            pose.earPitch,
            0,
            s * 0.09 + Math.sin(elapsed * 1.1 + candidate.phase) * 0.025,
          );
      if (kind === 'squirrel')
        child(
          'squirrelTail',
          base,
          0,
          0.13,
          -0.13,
          0.035 * Math.sin(elapsed * 2 + candidate.phase),
          pose.tailYaw,
          0,
        );
      if (kind === 'goose') {
        child(
          'gooseNeck',
          base,
          0,
          0.47,
          0.24,
          pose.neckPitch,
          Math.sin(elapsed * 0.6 + candidate.phase) * 0.045,
          0,
        );
        if (!candidate.swimming) {
          poseRoot(pose.x, baseLevel, pose.z, pose.heading, 0, 0, size);
          base.copy(root);
          for (const s of [-1, 1]) {
            const gait = pose.gait + (s > 0 ? Math.PI : 0),
              swing = Math.sin(gait) * 0.48 * pose.moving,
              lift = Math.max(0, Math.sin(gait)) * 0.04 * pose.moving;
            child('gooseLeg', base, s * 0.095, 0.24 + lift, -0.045, swing);
          }
        }
      }
      if (kind === 'beaver')
        child('beaverTail', base, 0, 0.075, -0.33, candidate.swimming ? 0.03 : 0.06, pose.tailYaw, 0);
      if (pixel) {
        const sniff = pose.neckPitch * 0.52;
        child('pixelHead', base, 0, 0.679, 0.308, sniff, Math.sin(elapsed * 1.4) * 0.2, -0.045);
        child('pixelTail', base, 0, 0.55, -0.39, 0, Math.sin(elapsed * 8) * 0.39, 0);
        for (const side of [-1, 1]) {
          const swing = Math.sin(pose.gait) * pose.moving * side;
          child('pixelForeleg', base, side * 0.101, 0.425 + Math.max(0, swing) * 0.035, 0.232, -swing * 0.47);
          child(
            'pixelHindleg',
            base,
            side * 0.105,
            0.415 + Math.max(0, -swing) * 0.043,
            -0.326,
            swing * 0.46,
          );
        }
      } else if (kind === 'dog') {
        child('dogTail', base, 0, 0.51, -0.36, 0, Math.sin(elapsed * 8 + candidate.phase) * 0.52, 0);
      }
      if (candidate.swimming && counts.wake < capacities.wake) {
        poseRoot(
          pose.x,
          0.085,
          pose.z,
          pose.heading,
          0,
          0,
          size * (0.75 + 0.12 * Math.sin(elapsed * 1.3 + candidate.phase)),
        );
        write('wake', root);
      }
    }
    for (const seat of selectedSeats) {
      poseRoot(seat.x, seatHeight(seat), seat.z, seat.heading);
      write(seat.style === 'concrete-block' ? 'concreteBench' : seat.kind, root);
    }
    // Optional playful canoe: the caller must provide an actual mapped-water
    // coordinate. It is an authored activity prop, never a claimed fixed landmark.
    const canoe = options.canoe;
    if (
      canoe &&
      Math.hypot(canoe.x - p.x, canoe.z - p.z) < 220 &&
      inWater(canoe.x, canoe.z) &&
      !isExcluded(canoe.x, canoe.z)
    ) {
      poseRoot(
        canoe.x,
        0.075 + 0.012 * Math.sin(elapsed * 0.8),
        canoe.z,
        canoe.heading || 0,
        0.012 * Math.sin(elapsed),
        0.018 * Math.sin(elapsed * 0.7),
      );
      write('canoe', root);
    }
    stats.activeTriangles = 0;
    stats.activeDrawCalls = 0;
    for (const [name, mesh] of Object.entries(meshes)) {
      mesh.count = Math.min(capacities[name], counts[name]);
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.needsUpdate = mesh.count > 0;
      mesh.castShadow = quality !== 'low' && quality !== 'performance' && name !== 'wake' && name !== 'canoe';
      if (mesh.count) {
        stats.activeDrawCalls++;
        stats.activeTriangles += (mesh.count * prototypes[name].attributes.position.count) / 3;
      }
    }
    stats.activeAnimals = active.length;
    stats.activeFurniture = selectedSeats.length;
    stats.updateMs = performance.now() - begin;
  }
  const colliders = seats.map((seat) => {
    const w = seat.kind === 'table' ? 1.91 : seat.style === 'concrete-block' ? 2.1 : 1.86,
      d = seat.kind === 'table' ? 1.62 : 0.64,
      c = Math.cos(seat.heading),
      s = Math.sin(seat.heading),
      y = seatHeight(seat);
    const ring = [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ].map(([x, z]) => [seat.x + x * c + z * s, seat.z - x * s + z * c]);
    return {
      id: seat.id,
      name: seat.kind === 'table' ? 'Park picnic table' : 'Park bench',
      type: 'park-furniture',
      ring,
      height: y + (seat.kind === 'table' ? 0.8 : seat.style === 'concrete-block' ? 0.46 : 0.95),
      minHeight: Math.max(0, y - 0.02),
      source: 'city-seating',
      inferredShape: true,
    };
  });
  return {
    stats,
    meshes,
    prototypes,
    material,
    colliders,
    candidates,
    seats,
    ready: Promise.resolve(),
    update,
    // Under the initial loading cover, parent can prewarm(camera), pipeline.render,
    // then update with current state: one shared animal/furniture shader plus wake.
    prewarm(camera) {
      const p = camera?.position || camera || { x: 0, y: 2, z: 0 };
      const direction = camera?.getWorldDirection?.(new THREE.Vector3()) || new THREE.Vector3(0, 0, -1);
      poseRoot(
        p.x + direction.x * 5,
        (Number.isFinite(p.y) ? p.y : 2) + direction.y * 5 - 0.5,
        p.z + direction.z * 5,
        0,
      );
      for (const mesh of Object.values(meshes)) {
        mesh.setMatrixAt(0, root);
        mesh.count = 1;
        mesh.visible = true;
        mesh.instanceMatrix.needsUpdate = true;
      }
      lastSelection = -Infinity;
    },
    isHabitatPoint: landAllowed,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of Object.values(meshes)) {
        scene.remove(mesh);
        mesh.dispose();
      }
      for (const geometry of Object.values(prototypes)) geometry.dispose();
      material.dispose();
      pixelMaterial.dispose();
      wakeMaterial.dispose();
    },
  };
}
