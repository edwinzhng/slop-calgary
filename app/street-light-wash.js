import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  dot,
  float,
  normalWorldGeometry,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uniformArray,
  vec2,
  vec3,
} from 'three/tsl';
import { SpatialIndex } from './geo.js';
import { cityUniforms, headlightPower, windowGlow } from './city-uniforms.js';

const SIZE = 192;
const METRES_PER_TEXEL = 4;
const REACH = SIZE * METRES_PER_TEXEL;
const SHIFT = 64;
const HEIGHT_STEPS = 2;
const HEIGHT_ORIGIN = 32;
const origin = uniform(new THREE.Vector3());
const pixels = new Uint8Array(SIZE * SIZE * 4);
const field = new THREE.DataTexture(pixels, SIZE, SIZE, THREE.RGBAFormat);
field.minFilter = field.magFilter = THREE.LinearFilter;
field.needsUpdate = true;

const TRAFFIC_LIGHTS = 3;
const poses = Array.from({ length: TRAFFIC_LIGHTS + 1 }, () => new THREE.Vector4());
const axes = poses.map(() => new THREE.Vector4());
const vehiclePoses = uniformArray(poses, 'vec4');
const vehicleAxes = uniformArray(axes, 'vec4');
const vehicleCount = uniform(0, 'int');
const previousTraffic = [];
const selectedTraffic = [];
const selectedDistance = [];

export function vehicleHeadlightLevel(glow, weather) {
  return Math.max(weather, THREE.MathUtils.smoothstep(glow, 0.26, 1.35));
}

export function updateVehicleHeadlightWash(player, traffic, level, camera, steering = 0) {
  let count = 0;
  function aim(vehicle, reach, nose, power, heading = vehicle.heading) {
    poses[count].set(vehicle.x, vehicle.y, vehicle.z, power);
    axes[count].set(Math.sin(heading), Math.cos(heading), reach, nose);
    count++;
  }
  if (level > 0.01) {
    if (player?.mode === 'cycle') aim(player, 19, 0.59, 1.15, player.heading + steering);
    else if (player) aim(player, 42, 2.24, 1.95);
    for (const car of traffic) {
      if (car.cameraDistance > 75) break;
      if (Math.abs(car.y - camera.position.y) >= 24) continue;
      const distance = car.cameraDistance - (previousTraffic.includes(car) ? 9 : 0);
      const at = selectedDistance.findIndex((other) => other > distance);
      if (at < 0 && selectedTraffic.length === TRAFFIC_LIGHTS) continue;
      const slot = at < 0 ? selectedTraffic.length : at;
      selectedTraffic.splice(slot, 0, car);
      selectedDistance.splice(slot, 0, distance);
      if (selectedTraffic.length > TRAFFIC_LIGHTS) {
        selectedTraffic.pop();
        selectedDistance.pop();
      }
    }
    for (const car of selectedTraffic)
      aim(car, 29, 2.1, 1.6 * (1 - THREE.MathUtils.smoothstep(car.cameraDistance, 52, 75)));
  }
  previousTraffic.length = 0;
  previousTraffic.push(...selectedTraffic);
  selectedTraffic.length = selectedDistance.length = 0;
  vehicleCount.value = count;
  return count;
}

export function streetLightWash(albedo, reflectivity = 0.55) {
  return shadePavement(albedo, float(reflectivity));
}

const shadePavement = Fn(([albedo, reflectivity]) => {
  const light = vec3(0).toVar();
  const night = smoothstep(0.56, 1.66, windowGlow);
  const up = smoothstep(0.12, 0.85, normalWorldGeometry.y);
  If(windowGlow.greaterThan(0.56).and(normalWorldGeometry.y.greaterThan(0.12)), () => {
    const uv = positionWorld.xz.sub(origin.xz).div(REACH);
    const edge = uv.min(uv.oneMinus());
    If(edge.x.greaterThan(0).and(edge.y.greaterThan(0)), () => {
      const sample = texture(field, uv).level(0);
      const elevation = sample.a.mul(255).sub(128).div(HEIGHT_STEPS).add(origin.y);
      const heightFade = smoothstep(0.65, 3.4, abs(positionWorld.y.sub(elevation))).oneMinus();
      const edgeFade = smoothstep(0, 0.05, edge.x.min(edge.y));
      const distanceFade = smoothstep(220, 315, positionWorld.xz.sub(cameraPosition.xz).length()).oneMinus();
      light.assign(
        sample.rgb.mul(night).mul(heightFade).mul(edgeFade).mul(distanceFade).mul(albedo).mul(1.8),
      );
      If(cityUniforms.uRoadWetness.greaterThan(0.3), () => {
        // Intersect the view reflected by a flat road with the lamp height.
        // The packed ground footprints approximate the sources without a screen-space pass.
        const ray = positionWorld.sub(cameraPosition);
        const reflectedUV = uv.add(ray.xz.mul(5.6 / REACH).div(ray.y.abs().max(0.8)));
        const rim = reflectedUV.min(reflectedUV.oneMinus());
        If(rim.x.greaterThan(0).and(rim.y.greaterThan(0)), () => {
          const reflected = texture(field, reflectedUV).level(0);
          const deck = reflected.a.mul(255).sub(128).div(HEIGHT_STEPS).add(origin.y);
          const sameDeck = smoothstep(0.8, 4.4, abs(positionWorld.y.sub(deck))).oneMinus();
          const glancing = smoothstep(0.025, 0.16, ray.y.abs().div(ray.length().max(0.8))).oneMinus();
          const strength = smoothstep(0.3, 0.94, cityUniforms.uRoadWetness)
            .mul(smoothstep(0, 0.07, rim.x.min(rim.y)))
            .mul(sameDeck)
            .mul(distanceFade)
            .mul(glancing)
            .mul(night)
            .mul(reflectivity);
          light.addAssign(reflected.rgb.pow(3.5).mul(strength).mul(0.64));
        });
      });
    });
  });
  If(vehicleCount.greaterThan(0).and(normalWorldGeometry.y.greaterThan(0.12)), () => {
    const beams = float(0).toVar();
    const tails = float(0).toVar();
    const wet = cityUniforms.uRoadWetness.mul(reflectivity);
    Loop(vehicleCount, ({ i }) => {
      const pose = vehiclePoses.element(i);
      const axis = vehicleAxes.element(i);
      const delta = positionWorld.sub(pose.xyz);
      const along = dot(delta.xz, axis.xy);
      const forward = along.sub(axis.w);
      const side = dot(delta.xz, vec2(axis.y, axis.x.negate())).abs();
      const bicycle = axis.w.lessThan(1);
      If(forward.greaterThan(0).and(forward.lessThan(axis.z)).and(delta.y.abs().lessThan(3.2)), () => {
        const width = forward.mul(bicycle.select(0.13, 0.18)).add(0.46);
        const lobe = smoothstep(width.mul(0.15), width, side.sub(bicycle.select(0, 0.63)).abs()).oneMinus();
        const throwFade = smoothstep(0, 3.8, forward).mul(
          smoothstep(axis.z.mul(0.35), axis.z, forward).oneMinus(),
        );
        const grade = smoothstep(0.6, 3.2, delta.y.abs()).oneMinus();
        beams.addAssign(lobe.mul(throwFade).mul(grade).mul(pose.w));
      });
      If(
        wet.greaterThan(0.3).and(bicycle.not()).and(along.lessThan(-1.9)).and(along.greaterThan(-6.5)),
        () => {
          const trail = smoothstep(1.9, 2.55, along.negate()).mul(
            smoothstep(2.65, 6.5, along.negate()).oneMinus(),
          );
          const lamps = smoothstep(0.07, 0.42, side.sub(0.69).abs()).oneMinus();
          const deck = smoothstep(0.32, 1.2, delta.y.abs()).oneMinus();
          tails.addAssign(trail.mul(lamps).mul(deck).mul(pose.w));
        },
      );
    });
    const tint = vec3(1, 0.89, 0.72);
    light.addAssign(
      albedo.mul(1.75).add(vec3(0.065).mul(wet)).mul(tint).mul(beams.min(4)).mul(headlightPower),
    );
    light.addAssign(vec3(0.072, 0.009, 0.005).mul(tails.min(1)).mul(wet).mul(headlightPower));
  });
  return light.mul(up);
});

// Soft downlight only on the receiving pavement. The existing lamp heads
// supply the surveyed location, inferred mount and colour temperature.
export function streetLightFootprint(record) {
  const { category, x, z, y, baseY, tint, heading } = record;
  if (category === 'ground' || y - baseY < 0.6) return null;
  const road = category === 'cobrahead' || category === 'high-mast';
  const radius = Math.min(20, Math.max(4.5, (y - baseY) * (road ? 1.65 : 1.85)));
  const nx = Math.sin(heading),
    nz = Math.cos(heading);
  const offset = road ? 2.4 : category === 'wall' ? 1.8 : 0;
  return {
    x: x + nx * offset,
    z: z + nz * offset,
    y: baseY,
    nx,
    nz,
    radius,
    stretch: road ? 1.3 : 1,
    tint,
    strength: road ? 0.9 : category === 'bollard' ? 0.35 : 0.68,
  };
}

export function createStreetLightWash(records) {
  const lamps = new SpatialIndex(48);
  for (const record of records) {
    const lamp = streetLightFootprint(record);
    if (!lamp) continue;
    const r = lamp.radius * lamp.stretch;
    lamps.insert(lamp, { minX: lamp.x - r, maxX: lamp.x + r, minZ: lamp.z - r, maxZ: lamp.z + r });
  }
  const stats = { active: 0, updates: 0, bytes: pixels.byteLength };
  let previousX = Infinity,
    previousZ = Infinity;
  return {
    stats,
    update(camera, glow = windowGlow.value) {
      const { x, z } = camera.position;
      if (glow <= 0.56) return;
      const ox = Math.round(x / SHIFT) * SHIFT - REACH / 2;
      const oz = Math.round(z / SHIFT) * SHIFT - REACH / 2;
      if (ox === previousX && oz === previousZ) return;
      previousX = ox;
      previousZ = oz;
      pixels.fill(0);
      stats.active = 0;
      for (const lamp of lamps.near(ox + REACH / 2, oz + REACH / 2, REACH / 2)) {
        const h = Math.round((lamp.y - HEIGHT_ORIGIN) * HEIGHT_STEPS + 128);
        if (h < 0 || h > 255) continue;
        const reach = lamp.radius * lamp.stretch;
        const minX = Math.max(0, Math.floor((lamp.x - ox - reach) / METRES_PER_TEXEL));
        const maxX = Math.min(SIZE - 1, Math.ceil((lamp.x - ox + reach) / METRES_PER_TEXEL));
        const minZ = Math.max(0, Math.floor((lamp.z - oz - reach) / METRES_PER_TEXEL));
        const maxZ = Math.min(SIZE - 1, Math.ceil((lamp.z - oz + reach) / METRES_PER_TEXEL));
        if (minX > maxX || minZ > maxZ) continue;
        stats.active++;
        for (let j = minZ; j <= maxZ; j++) {
          const dz = oz + (j + 0.5) * METRES_PER_TEXEL - lamp.z;
          for (let i = minX; i <= maxX; i++) {
            const dx = ox + (i + 0.5) * METRES_PER_TEXEL - lamp.x;
            const lateral = (dx * lamp.nz - dz * lamp.nx) / lamp.stretch;
            const forward = dx * lamp.nx + dz * lamp.nz;
            const t = 1 - (lateral * lateral + forward * forward) / (lamp.radius * lamp.radius);
            if (t <= 0) continue;
            const energy = Math.round(t * t * lamp.strength * 255);
            if (!energy) continue;
            const p = (j * SIZE + i) * 4;
            const previous = pixels[p];
            // A road beneath an overpass must not inherit the deck's lamp.
            const sameLevel = previous > 0 && Math.abs(h - pixels[p + 3]) < HEIGHT_STEPS * 2.5;
            if (!sameLevel && previous >= energy * lamp.tint.r) continue;
            pixels[p] = Math.min(255, (sameLevel ? previous : 0) + energy * lamp.tint.r);
            pixels[p + 1] = Math.min(255, (sameLevel ? pixels[p + 1] : 0) + energy * lamp.tint.g);
            pixels[p + 2] = Math.min(255, (sameLevel ? pixels[p + 2] : 0) + energy * lamp.tint.b);
            if (!sameLevel || previous < energy * lamp.tint.r) pixels[p + 3] = h;
          }
        }
      }
      origin.value.set(ox, HEIGHT_ORIGIN, oz);
      field.needsUpdate = true;
      stats.updates++;
    },
  };
}
