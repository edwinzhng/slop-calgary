import * as THREE from 'three/webgpu';
import { float, length, smoothstep, uv } from 'three/tsl';
import { seeded } from './geo.js';
import { createThemeDetails } from './theme-details.js';

export const WEATHER_KINDS = Object.freeze(['clear', 'overcast', 'fog', 'rain', 'snow']);
export const CITY_THEMES = Object.freeze(['calgary', 'tokyo']);
export const ATMOSPHERE_LIMITS = Object.freeze({
  rain: { balanced: 1600, high: 2800 },
  snow: { balanced: 1000, high: 1800 },
  ripples: { balanced: 48, high: 80 },
});
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function atmosphereSettings(weather = 'clear', theme = 'calgary') {
  const settings =
    weather === 'rain'
      ? {
          wetness: 1,
          snow: 0,
          cloudCover: 0.8,
          fogMultiplier: 1.8,
          lightMultiplier: 0.5,
          ambientMultiplier: 0.84,
          temperatureTint: 0.15,
        }
      : weather === 'snow'
        ? {
            wetness: 0.24,
            snow: 1,
            cloudCover: 0.65,
            fogMultiplier: 1.55,
            lightMultiplier: 0.63,
            ambientMultiplier: 0.94,
            temperatureTint: 0.7,
          }
        : weather === 'overcast' || weather === 'fog'
          ? {
              wetness: weather === 'fog' ? 0.16 : 0,
              snow: 0,
              cloudCover: weather === 'fog' ? 0.82 : 0.95,
              fogMultiplier: weather === 'fog' ? 6.5 : 1.4,
              lightMultiplier: weather === 'fog' ? 0.34 : 0.24,
              ambientMultiplier: weather === 'fog' ? 0.82 : 1.04,
              temperatureTint: 0.2,
            }
          : {
              wetness: 0,
              snow: 0,
              cloudCover: 0,
              fogMultiplier: 1,
              lightMultiplier: 1,
              ambientMultiplier: 1,
              temperatureTint: 0,
            };
  return { ...settings, kind: weather, themeMix: theme === 'tokyo' ? 1 : 0 };
}

export function precipitationBudget(weather, quality = 'balanced') {
  return ATMOSPHERE_LIMITS[weather]?.[quality === 'high' ? 'high' : 'balanced'] || 0;
}

export function createAtmosphere(scene, camera, world) {
  const rng = seeded(194903),
    state = { weather: 'clear', theme: 'calgary', quality: 'balanced' },
    environment = atmosphereSettings();
  const rainMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xb5cbd5,
    transparent: true,
    opacity: 0.39,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const snowMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xeaf2f5,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  snowMaterial.opacityNode = float(1)
    .sub(smoothstep(0.16, 0.49, length(uv().sub(0.5))))
    .mul(0.87);
  const rippleMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xa7cad5,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const rain = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.025, 1),
    rainMaterial,
    ATMOSPHERE_LIMITS.rain.high,
  );
  const snow = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    snowMaterial,
    ATMOSPHERE_LIMITS.snow.high,
  );
  const rippleGeometry = new THREE.RingGeometry(0.1, 0.128, 12);
  rippleGeometry.rotateX(-Math.PI / 2);
  const ripples = new THREE.InstancedMesh(rippleGeometry, rippleMaterial, ATMOSPHERE_LIMITS.ripples.high);
  rain.name = 'Camera-local rain streaks';
  snow.name = 'Camera-local drifting snow';
  ripples.name = 'Nearby rain contact ripples';
  for (const mesh of [rain, snow, ripples]) {
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
  }
  const max = ATMOSPHERE_LIMITS.rain.high,
    particles = new Float32Array(max * 5),
    rippleLocations = [],
    o = new THREE.Object3D(),
    tint = new THREE.Color();
  const theme = createThemeDetails(scene, world);
  const stats = {
    weather: 'clear',
    theme: 'calgary',
    rainParticles: 0,
    snowParticles: 0,
    rippleCount: 0,
    drawCalls: 0,
    themeSigns: 0,
    themeLanterns: 0,
  };
  let elapsed = 0,
    lastCameraX = Infinity,
    lastCameraZ = Infinity,
    resetNeeded = true,
    lastBudget = -1,
    lastRippleUpdate = -Infinity,
    lastRippleX = Infinity,
    lastRippleZ = Infinity;

  function volume() {
    const ground = world.groundHeight?.(camera.position.x, camera.position.z) ?? 0.2,
      aerial = camera.position.y > 150;
    return {
      radius: aerial ? 80 : 35,
      bottom: Math.max(ground + 0.08, camera.position.y - (aerial ? 25 : 12)),
      top: Math.max(ground + 30, camera.position.y + (aerial ? 40 : 25)),
    };
  }
  function resetParticles(bounds) {
    const height = bounds.top - bounds.bottom;
    for (let i = 0; i < max; i++) {
      const j = i * 5;
      particles[j] = camera.position.x + (rng() * 2 - 1) * bounds.radius;
      particles[j + 1] = bounds.bottom + rng() * height;
      particles[j + 2] = camera.position.z + (rng() * 2 - 1) * bounds.radius;
      particles[j + 3] = rng();
      particles[j + 4] = rng() * Math.PI * 2;
    }
    resetNeeded = false;
  }
  function updateRipples(quality) {
    if (camera.position.y > 45) {
      ripples.count = 0;
      stats.rippleCount = 0;
      return;
    }
    const cap = ATMOSPHERE_LIMITS.ripples[quality === 'high' ? 'high' : 'balanced'];
    if (
      (elapsed - lastRippleUpdate > 2 &&
        Math.hypot(camera.position.x - lastRippleX, camera.position.z - lastRippleZ) > 6) ||
      !rippleLocations.length
    ) {
      lastRippleUpdate = elapsed;
      lastRippleX = camera.position.x;
      lastRippleZ = camera.position.z;
      rippleLocations.length = 0;
      for (let i = 0; i < cap * 5 && rippleLocations.length < cap; i++) {
        const x = camera.position.x + (rng() * 2 - 1) * 25,
          z = camera.position.z + (rng() * 2 - 1) * 25;
        if (world.inWater?.(x, z)) continue;
        const y = world.groundHeight?.(x, z) ?? 0.2;
        if (!Number.isFinite(y) || world.collision?.(x, z, 0.15, y)) continue;
        const road = world.roadIndex?.nearest(x, z, true, 28);
        if (!road || road.distance > road.width / 2 + 2.5) continue;
        rippleLocations.push({ x, y: y + 0.018, z, phase: rng() });
      }
    }
    const count = Math.min(cap, rippleLocations.length);
    ripples.count = count;
    o.rotation.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
      const p = rippleLocations[i],
        t = (elapsed * 1.2 + p.phase) % 1,
        scale = 0.3 + t * 3.5;
      o.position.set(p.x, p.y, p.z);
      o.scale.set(scale, 1, scale);
      o.updateMatrix();
      ripples.setMatrixAt(i, o.matrix);
      tint.setScalar((1 - t) * 0.65);
      ripples.setColorAt(i, tint);
    }
    ripples.instanceMatrix.needsUpdate = true;
    if (ripples.instanceColor) ripples.instanceColor.needsUpdate = true;
    stats.rippleCount = count;
  }

  return {
    state,
    environment,
    stats,
    setWeather(next) {
      if (!WEATHER_KINDS.includes(next)) throw new RangeError(`Unknown weather: ${next}`);
      if (state.weather === next) return;
      state.weather = next;
      stats.weather = next;
      resetNeeded = true;
      lastBudget = -1;
      Object.assign(environment, atmosphereSettings(next, state.theme));
      rain.visible = next === 'rain';
      snow.visible = next === 'snow';
      ripples.visible = next === 'rain';
      if (next !== 'rain') {
        rain.count = 0;
        ripples.count = 0;
        stats.rainParticles = stats.rippleCount = 0;
      }
      if (next !== 'snow') {
        snow.count = 0;
        stats.snowParticles = 0;
      }
      stats.drawCalls =
        (precipitationBudget(next) ? 1 : 0) +
        (ripples.visible && ripples.count ? 1 : 0) +
        theme.stats.drawCalls;
    },
    setTheme(next) {
      if (!CITY_THEMES.includes(next)) throw new RangeError(`Unknown city theme: ${next}`);
      if (state.theme === next) return;
      state.theme = next;
      stats.theme = next;
      environment.themeMix = next === 'tokyo' ? 1 : 0;
      theme.setActive(next === 'tokyo');
      stats.themeSigns = theme.stats.activeSigns;
      stats.themeLanterns = theme.stats.activeLanterns;
    },
    update(dt, quality = 'balanced', night = 0) {
      const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      elapsed += step;
      state.quality = quality === 'high' ? 'high' : 'balanced';
      theme.update(camera, state.quality, night);
      stats.themeSigns = theme.stats.activeSigns;
      stats.themeLanterns = theme.stats.activeLanterns;
      if (!precipitationBudget(state.weather)) {
        stats.drawCalls = theme.stats.drawCalls;
        return;
      }
      const bounds = volume(),
        count = precipitationBudget(state.weather, state.quality);
      if (
        Math.hypot(camera.position.x - lastCameraX, camera.position.z - lastCameraZ) > bounds.radius * 1.5 ||
        lastBudget !== count
      )
        resetNeeded = true;
      if (resetNeeded) resetParticles(bounds);
      lastCameraX = camera.position.x;
      lastCameraZ = camera.position.z;
      lastBudget = count;
      const isRain = state.weather === 'rain',
        mesh = isRain ? rain : snow;
      mesh.visible = true;
      mesh.count = count;
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      const yaw = Math.atan2(direction.x, direction.z);
      if (isRain) o.rotation.set(0, yaw, 0.08);
      else o.quaternion.copy(camera.quaternion);
      const span = bounds.radius * 2,
        height = bounds.top - bounds.bottom;
      for (let i = 0; i < count; i++) {
        const j = i * 5,
          seed = particles[j + 3],
          phase = particles[j + 4];
        particles[j] += step * (isRain ? 2.1 : 0.5 + Math.sin(elapsed * 0.6 + phase) * 0.65);
        particles[j + 1] -= step * (isRain ? 19 + seed * 8 : 0.75 + seed * 0.85);
        particles[j + 2] += step * (isRain ? -0.7 : Math.cos(elapsed * 0.4 + phase) * 0.45);
        if (particles[j] < camera.position.x - bounds.radius) particles[j] += span;
        if (particles[j] > camera.position.x + bounds.radius) particles[j] -= span;
        if (particles[j + 2] < camera.position.z - bounds.radius) particles[j + 2] += span;
        if (particles[j + 2] > camera.position.z + bounds.radius) particles[j + 2] -= span;
        if (particles[j + 1] < bounds.bottom || particles[j + 1] > bounds.top)
          particles[j + 1] =
            bounds.bottom + ((((particles[j + 1] - bounds.bottom) % height) + height) % height);
        o.position.set(particles[j], particles[j + 1], particles[j + 2]);
        if (isRain) o.scale.set(0.7 + seed * 0.8, 0.7 + seed * 0.7, 1);
        else o.scale.setScalar(0.45 + seed * 0.9);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      stats.rainParticles = isRain ? count : 0;
      stats.snowParticles = isRain ? 0 : count;
      if (isRain) updateRipples(state.quality);
      else {
        ripples.count = 0;
        stats.rippleCount = 0;
      }
      stats.drawCalls = 1 + (ripples.visible && ripples.count ? 1 : 0) + theme.stats.drawCalls;
    },
    dispose() {
      theme.dispose();
      for (const mesh of [rain, snow, ripples]) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      rainMaterial.dispose();
      snowMaterial.dispose();
      rippleMaterial.dispose();
    },
  };
}
