import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { project } from './geo.js';
import { createCameraCollision, createChaseBoom, movementBody } from './camera-collision.js';
import {
  DRIVE,
  CYCLE,
  driveSpeed,
  turnRate,
  steeringApproach,
  corneringSpeed,
  stepCarDrive,
} from './navigation-physics.js';
import {
  PLAYER_PACE_MULTIPLIER,
  springVector,
  springScalar,
  angleDelta,
  walkInput,
  velocityApproach,
} from './motion.js';
import { rightLaneOffset } from './traffic.js';
import {
  resolveBoundedMovement,
  rotationWithClearance,
  traversableHeight,
  modePlacement,
  sweepVerticalMovement,
  stepWalkingVertical,
  savedPlacement,
} from './movement-collision.js';

const travelModes = ['orbit', 'walk', 'drive', 'cycle', 'fly'];

export const PLACES = [
  { name: 'Downtown', sub: 'Glass towers & Stephen Avenue', lon: -114.0657, lat: 51.045, bearing: 1.57 },
  { name: 'East Village', sub: 'RiverWalk & Central Library', lon: -114.0524, lat: 51.0463, bearing: 0 },
  { name: 'Kensington', sub: 'Kensington Road & 10 Street NW', lon: -114.0864, lat: 51.0525, bearing: 0 },
  {
    name: '17th Avenue',
    sub: 'The Devenish & Tomkins Park',
    lon: -114.0817987,
    lat: 51.0377844,
    bearing: -2.03,
  },
  { name: 'Sunnyside', sub: 'Across the Bow, under the bluff', lon: -114.079, lat: 51.058, bearing: 1.57 },
  { name: 'Mission', sub: '4 Street & the Elbow River', lon: -114.0712, lat: 51.0328, bearing: 0 },
  { name: 'Peace Bridge', sub: 'The red crossing over the Bow', lon: -114.0781, lat: 51.0533, bearing: -0.7 },
  {
    name: 'Prince’s Island',
    sub: 'A quiet turn along the river',
    lon: -114.0706,
    lat: 51.0556,
    bearing: 1.57,
  },
  {
    name: 'Stampede Park',
    sub: 'The Saddledome & Victoria Park',
    lon: -114.0547,
    lat: 51.0386,
    bearing: 1.57,
  },
];
export const VIEW_CAMERAS = [
  { id: 'chase', label: 'Third person', shortcut: '5' },
  { id: 'pov', label: 'First person', shortcut: '7' },
  { id: 'aerial', label: 'Aerial' },
];
const CHASE_FOV = 68;
export const CAMERA_PRESETS = [
  { id: 'chase', name: 'Third person', category: 'follow', fov: CHASE_FOV },
  { id: 'action', name: 'Low-Angle Action', category: 'follow', fov: 60 },
  { id: 'pov', name: 'First-Person / Cockpit', category: 'follow', fov: 68 },
  {
    id: 'downtown',
    name: 'Downtown & The Bow',
    category: 'scenic',
    fov: 50,
    eye: [-114.06975, 51.0503, 170],
    target: [-114.06296, 51.04778, 105],
  },
  {
    id: 'kensington',
    name: 'Kensington Crossroads',
    category: 'scenic',
    fov: 58,
    eye: [-114.0867, 51.0527, 6],
    target: [-114.0859, 51.0524, 8],
  },
  {
    id: 'eastVillage',
    name: 'East Village & Library',
    category: 'scenic',
    fov: 52,
    eye: [-114.0534, 51.0448, 12],
    target: [-114.0571, 51.0454, 20],
  },
  {
    id: 'river',
    name: 'Bow River & Skyline',
    category: 'scenic',
    fov: 48,
    eye: [-114.0684, 51.0556, 28],
    target: [-114.0642, 51.0478, 100],
  },
  {
    id: 'tower',
    name: 'Calgary Tower',
    category: 'scenic',
    fov: 52,
    eye: [-114.0631, 51.0448, 159.4],
    target: [-114.0641, 51.0501, 110],
  },
  {
    id: 'peace',
    name: 'Peace Bridge',
    category: 'scenic',
    fov: 52,
    eye: [-114.0805, 51.0548, 13],
    target: [-114.0789, 51.0538, 6],
  },
  { id: 'aerial', name: 'Auto-Director Aerial', category: 'scenic', fov: 52 },
];

export function createNavigation(
  camera,
  canvas,
  world,
  onChange = () => {},
  onNotice = () => {},
  { persist = true } = {},
) {
  const orbit = new OrbitControls(camera, canvas);
  orbit.target.set(220, 45, -100);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.05;
  orbit.rotateSpeed = 1.15;
  orbit.minDistance = 1.5;
  orbit.maxDistance = 6500;
  orbit.maxPolarAngle = Math.PI / 2 - 0.01;
  orbit.autoRotate = true;
  orbit.autoRotateSpeed = 0.25;
  camera.position.set(-1000, 850, -1450);
  orbit.update();
  const state = {
    mode: 'orbit',
    x: 220,
    z: -100,
    y: 0,
    heading: Math.PI / 2,
    speed: 0,
    groundSpeed: 0,
    tour: true,
    cameraPreset: 'aerial',
    cameraView: 'aerial',
    cameraDistance: 10,
    running: false,
    steering: 0,
    steerAngle: 0,
    verticalSpeed: 0,
    grounded: true,
    throttle: 0,
    braking: false,
    velocityX: 0,
    velocityZ: 0,
    yawRate: 0,
    lateralSpeed: 0,
  };
  const keys = new Set(),
    touch = { x: 0, y: 0, up: false, down: false, boost: false },
    pointers = new Map();
  const collisions = createCameraCollision(world);
  const follow = createChaseBoom(collisions);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const [minX, minZ] = project(world.data.meta.bbox.west, world.data.meta.bbox.north),
    [maxX, maxZ] = project(world.data.meta.bbox.east, world.data.meta.bbox.south);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const desired = new THREE.Vector3(),
    target = new THREE.Vector3(),
    safe = new THREE.Vector3(),
    nextPosition = new THREE.Vector3(),
    stepOrigin = new THREE.Vector3(),
    lookVelocity = new THREE.Vector3(),
    smoothTarget = new THREE.Vector3();
  let walkingCameraYaw = state.heading,
    walkVelocityX = 0,
    walkVelocityZ = 0,
    bodyYawVelocity = 0,
    yawOffset = 0,
    pitch = 0.09,
    zoom = 1,
    zoomTarget = 1,
    userOrbitTimer = 0,
    hidden = document.hidden,
    elapsed = 0,
    smoothedSpeed = 0,
    walkCameraY = NaN,
    walkCameraVelocity = 0,
    spaceWasDown = false,
    lastNotice = 0,
    impactListener = null,
    lastSave = 0,
    snap = true,
    gamepadButtons = [];
  const supportHeight = (x, z, hint) =>
    state.mode === 'walk' && world.walkSupportHeight
      ? world.walkSupportHeight(x, z, hint)
      : world.groundHeight(x, z, hint);
  function clear() {
    keys.clear();
    touch.x = touch.y = 0;
    touch.up = touch.down = touch.boost = false;
    state.speed = state.groundSpeed = state.throttle = state.steering = state.steerAngle = 0;
    state.braking = false;
    walkVelocityX = walkVelocityZ = 0;
    state.velocityX = state.velocityZ = state.yawRate = state.lateralSpeed = 0;
    pointers.clear();
  }
  const movementKeys = new Set([
    'w',
    'a',
    's',
    'd',
    'arrowup',
    'arrowleft',
    'arrowdown',
    'arrowright',
    'shift',
    ' ',
    'e',
    'q',
  ]);
  const editable = (e) =>
    e.target?.closest?.('input,select,textarea,dialog,[popover],[contenteditable="true"]');
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    if (hidden) {
      clear();
      save();
    }
  });
  window.addEventListener('pagehide', save);
  window.addEventListener('keydown', (e) => {
    if (editable(e) || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === ' ' && e.target?.matches?.('button:focus-visible')) return;
    if (movementKeys.has(key)) {
      if (key !== 'shift') e.preventDefault();
      keys.add(key);
    }
    if (e.repeat) return;
    const shortcuts = { 5: 'chase', 6: 'action', 7: 'pov', 8: 'downtown', 9: 'kensington', 0: 'eastVillage' };
    if (shortcuts[e.key]) setCamera(shortcuts[e.key]);
    if (e.key.toLowerCase() === 'v') cycleCamera(e.shiftKey ? -1 : 1);
    if (e.key === '+' || e.key === '=') zoomBy(-0.18);
    if (e.key === '-' || e.key === '_') zoomBy(0.18);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    if (orbit.enabled || e.button !== 0 || pointers.size >= 2) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    userOrbitTimer = 4;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x,
      dy = e.clientY - p.y,
      pair = pointers.size === 2 ? [...pointers.values()] : null;
    const old = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pair) {
      const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      if (old > 1 && d > 1) zoomBy(Math.log(old / d));
    } else {
      if (state.mode === 'walk') walkingCameraYaw -= dx * 0.0065;
      else yawOffset -= dx * 0.0065;
      pitch = clamp(pitch + dy * 0.005, -0.32, 0.9);
    }
    userOrbitTimer = 4;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    canvas.addEventListener(type, (e) => {
      pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!orbit.enabled) {
        e.preventDefault();
        zoomBy(clamp(e.deltaY * 0.001, -0.45, 0.45));
      }
    },
    { passive: false },
  );
  function zoomBy(delta) {
    if (orbit.enabled) {
      desired.subVectors(camera.position, orbit.target);
      desired.multiplyScalar(Math.exp(delta));
      desired.clampLength(orbit.minDistance, orbit.maxDistance);
      camera.position.copy(orbit.target).add(desired);
    } else if (state.cameraPreset === 'pov') {
      camera.fov = clamp(camera.fov + delta * 30, 48, 86);
      camera.updateProjectionMatrix();
    } else zoomTarget = clamp(zoomTarget * Math.exp(delta), 0.28, 3);
  }
  function safePosition(x, z, driveOnly = false, placementMode = state.mode) {
    const clearAt = (px, pz, heading = state.heading) => {
      const y = world.groundHeight(px, pz),
        body = movementBody(placementMode, heading);
      return !(world.bodyBlocked
        ? world.bodyBlocked({ x: px, y, z: pz }, body)
        : world.collision(px, pz, body.radius, y));
    };
    if (!driveOnly && clearAt(x, z)) return [x, z];
    const road = world.roadIndex.nearest(x, z, driveOnly, 300, driveOnly);
    if (road) {
      let heading = Math.atan2(road.b[0] - road.a[0], road.b[1] - road.a[1]);
      if (
        road.road.oneway === '-1' ||
        ((!road.road.oneway || road.road.oneway === 'no') && Math.cos(heading - state.heading) < 0)
      )
        heading += Math.PI;
      const offset = driveOnly ? rightLaneOffset(road.road) : 0;
      const px = road.x - Math.cos(heading) * offset,
        pz = road.z + Math.sin(heading) * offset;
      if (clearAt(px, pz, heading)) return [px, pz];
      if (clearAt(road.x, road.z, heading)) return [road.x, road.z];
    }
    if (clearAt(x, z)) return [x, z];
    for (let r = 3; r < 180; r += 4)
      for (let angle = 0; angle < Math.PI * 2; angle += 0.35) {
        const px = x + Math.cos(angle) * r,
          pz = z + Math.sin(angle) * r;
        if (clearAt(px, pz)) return [px, pz];
      }
    return [0, 0];
  }
  function alignToStreet() {
    if (state.mode !== 'drive' && state.mode !== 'cycle') return;
    const r = world.roadIndex.nearest(state.x, state.z, true, 150, true);
    if (!r) return;
    let h = Math.atan2(r.b[0] - r.a[0], r.b[1] - r.a[1]);
    if (r.road.oneway === '-1') h += Math.PI;
    else if ((!r.road.oneway || r.road.oneway === 'no') && Math.cos(h - state.heading) < 0) h += Math.PI;
    state.heading = h;
  }
  function resetCamera() {
    walkingCameraYaw = state.heading;
    bodyYawVelocity = 0;
    lookVelocity.set(0, 0, 0);
    yawOffset = 0;
    pitch = 0.09;
    zoom = zoomTarget = 1;
    userOrbitTimer = 0;
    smoothedSpeed = 0;
    snap = true;
    pointers.clear();
  }
  function setHeading(heading) {
    if (!Number.isFinite(heading)) return false;
    state.heading = Math.atan2(Math.sin(heading), Math.cos(heading));
    state.yawRate = state.lateralSpeed = state.steerAngle = 0;
    resetCamera();
    return true;
  }
  function mode(next) {
    if (!travelModes.includes(next)) return;
    const previous = state.mode;
    if (next === previous) return;
    if (previous === 'orbit') {
      [state.x, state.z] = safePosition(
        orbit.target.x,
        orbit.target.z,
        next === 'drive' || next === 'cycle',
        next,
      );
      state.y = world.groundHeight(state.x, state.z);
    } else if (next !== 'orbit') {
      const placement = modePlacement(world, state, next);
      if (!placement) {
        clear();
        const aboveSupport = state.y - world.groundHeight(state.x, state.z, state.y) > 0.65;
        onNotice(
          (next === 'drive' || next === 'cycle') && aboveSupport
            ? 'Land before changing vehicle'
            : next === 'drive'
              ? 'No room for the car here'
              : 'Move to an open space first',
        );
        return;
      }
      state.y = placement.y;
    }
    state.mode = next;
    walkVelocityX = walkVelocityZ = 0;
    state.speed = state.groundSpeed = 0;
    state.yawRate = state.lateralSpeed = state.steerAngle = 0;
    state.verticalSpeed = 0;
    state.tour = false;
    state.running = false;
    const support = supportHeight(state.x, state.z, state.y);
    state.y = next === 'fly' ? state.y : next === 'walk' ? Math.max(state.y, support) : support;
    state.grounded = next !== 'fly' && state.y <= support + 0.02;
    if (previous === 'orbit') alignToStreet();
    resetCamera();
    if (next === 'orbit') setCamera('aerial');
    else {
      state.cameraPreset = 'chase';
      state.cameraView = 'chase';
      orbit.enabled = false;
      orbit.autoRotate = false;
      camera.fov = CHASE_FOV;
      camera.updateProjectionMatrix();
    }
    onChange(state);
  }
  function setCamera(id) {
    if (id === 'first') id = 'pov';
    if (id === 'drone') id = 'aerial';
    const preset = CAMERA_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    if (preset.category === 'follow' && state.mode === 'orbit') mode('drive');
    state.cameraPreset = id;
    state.cameraView = id === 'pov' ? 'first' : id;
    orbit.enabled = id === 'aerial';
    orbit.autoRotate = id === 'aerial' && state.tour;
    camera.fov = preset.fov;
    camera.updateProjectionMatrix();
    resetCamera();
    if (id === 'aerial') {
      orbit.target.set(state.x, 35, state.z);
      camera.position.set(state.x - 700, 620, state.z - 900);
    }
    onChange(state);
  }
  function cycleCamera(step = 1) {
    const i = VIEW_CAMERAS.findIndex((p) => p.id === state.cameraPreset);
    setCamera(VIEW_CAMERAS[i < 0 ? 0 : (i + step + VIEW_CAMERAS.length) % VIEW_CAMERAS.length].id);
  }
  function teleport(lon, lat, name, placementMode = state.mode) {
    if (!travelModes.includes(placementMode)) placementMode = state.mode;
    walkVelocityX = walkVelocityZ = 0;
    const [x, z] = project(lon, lat);
    [state.x, state.z] = safePosition(
      x,
      z,
      placementMode === 'drive' || placementMode === 'cycle',
      placementMode,
    );
    state.speed = state.groundSpeed = state.verticalSpeed = 0;
    state.yawRate = state.lateralSpeed = state.steerAngle = 0;
    state.y =
      placementMode === 'fly'
        ? Math.max(70, state.y, world.groundHeight(state.x, state.z) + 35)
        : placementMode === 'walk' && world.walkSupportHeight
          ? world.walkSupportHeight(state.x, state.z)
          : world.groundHeight(state.x, state.z);
    state.grounded = placementMode !== 'fly';
    alignToStreet();
    resetCamera();
    if (state.mode === 'orbit') {
      orbit.target.set(x, 30, z);
      camera.position.set(x - 500, 550, z - 650);
    } else setCamera('chase');
    onNotice(name ? `Arrived at ${name}` : 'Moved to map pin');
    onChange(state);
    save();
  }
  function save() {
    if (!persist) return;
    try {
      if (state.mode === 'orbit') return;
      localStorage.setItem(
        'calgary-player',
        JSON.stringify({
          mode: state.mode,
          x: state.x,
          z: state.z,
          y: state.y,
          heading: state.heading,
          cameraPreset: state.cameraPreset,
        }),
      );
    } catch {}
  }
  function gamepad(dt) {
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!pad) return { throttle: 0, steer: 0, jump: false, boost: false, brake: false };
    const dead = (v) => (Math.abs(v) > 0.12 ? Math.sign(v) * ((Math.abs(v) - 0.12) / 0.88) : 0);
    const buttons = pad.buttons.map((b) => b.pressed);
    if (buttons[3] && !gamepadButtons[3]) cycleCamera(1);
    if (buttons[2] && !gamepadButtons[2]) {
      const modes = ['walk', 'drive', 'cycle', 'fly'];
      mode(modes[(modes.indexOf(state.mode) + 1) % modes.length]);
    }
    if (buttons[9] && !gamepadButtons[9]) document.getElementById('open-map')?.click();
    const lookX = dead(pad.axes[2] || 0),
      lookY = dead(pad.axes[3] || 0);
    if (lookX || lookY) {
      if (state.mode === 'walk') walkingCameraYaw -= lookX * 2.7 * dt;
      else yawOffset -= lookX * 2.7 * dt;
      pitch = clamp(pitch + lookY * 1.25 * dt, -0.32, 0.9);
      userOrbitTimer = 4;
    }
    if (buttons[12] || buttons[13]) zoomBy((buttons[12] ? -0.65 : 0.65) * dt);
    gamepadButtons = buttons;
    return {
      throttle: (pad.buttons[7]?.value || 0) - (pad.buttons[6]?.value || 0) || -dead(pad.axes[1] || 0),
      steer: dead(pad.axes[0] || 0),
      jump: !!buttons[0],
      boost: !!buttons[10],
      brake: !!buttons[1],
    };
  }
  function updateCamera(dt) {
    const preset = CAMERA_PRESETS.find((p) => p.id === state.cameraPreset) || CAMERA_PRESETS[0];
    if (orbit.enabled) {
      orbit.target.y = Math.max(1.2, orbit.target.y);
      orbit.update(dt);
      collisions.resolve(camera.position, 0.4, safe);
      camera.position.copy(safe);
      camera.lookAt(orbit.target);
      state.cameraDistance = camera.position.distanceTo(orbit.target);
      snap = false;
      return;
    }
    if (preset.category === 'scenic') {
      const [ex, ez] = project(preset.eye[0], preset.eye[1]),
        [tx, tz] = project(preset.target[0], preset.target[1]);
      zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 9));
      desired.set(ex + Math.sin(elapsed * 0.2) * 1.4, preset.eye[2], ez);
      target.set(tx, preset.target[2], tz);
      desired.sub(target).multiplyScalar(zoom).add(target);
      collisions.resolve(desired, 0.4, safe);
      if (snap) camera.position.copy(safe);
      else camera.position.lerp(safe, 1 - Math.exp(-dt * 5));
      collisions.resolve(camera.position, 0.4, camera.position);
      camera.lookAt(target);
      snap = false;
      return;
    }
    if (!pointers.size) {
      userOrbitTimer = Math.max(0, userOrbitTimer - dt);
      if (state.mode !== 'walk' && userOrbitTimer === 0 && Math.abs(state.speed) > 0.5) {
        yawOffset -= Math.round(yawOffset / (Math.PI * 2)) * Math.PI * 2;
        yawOffset *= Math.exp(-dt * 2.2);
      }
    }
    smoothedSpeed += (Math.abs(state.speed) - smoothedSpeed) * (1 - Math.exp(-dt * 3));
    zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 9));
    const fly = state.mode === 'fly',
      walk = state.mode === 'walk',
      cycle = state.mode === 'cycle',
      yaw = walk ? walkingCameraYaw : state.heading + yawOffset;
    let cameraBaseY = state.y;
    if (walk) {
      if (snap || !Number.isFinite(walkCameraY)) {
        walkCameraY = state.y;
        walkCameraVelocity = 0;
      } else {
        [walkCameraY, walkCameraVelocity] = springScalar(
          walkCameraY,
          walkCameraVelocity,
          state.y,
          state.grounded ? 0.17 : 0.11,
          dt,
        );
      }
      cameraBaseY = walkCameraY;
    } else walkCameraY = NaN;
    const eye = fly ? 2.1 : walk ? 1.48 : cycle ? 1.25 : 0.95;
    target.set(state.x, cameraBaseY + eye, state.z);
    if (state.cameraPreset === 'pov') {
      const eyeY = fly ? 1.7 : cycle ? 1.55 : walk ? 1.68 : 1.04;
      desired.set(
        state.x + Math.sin(state.heading) * 0.35,
        cameraBaseY + eyeY,
        state.z + Math.cos(state.heading) * 0.35,
      );
      collisions.resolve(desired, 0.24, safe);
      camera.position.copy(safe);
      target.set(
        safe.x + Math.sin(yaw) * 40,
        safe.y - Math.sin(pitch) * 18 + 1.5,
        safe.z + Math.cos(yaw) * 40,
      );
      state.cameraDistance = 0;
    } else {
      const action = state.cameraPreset === 'action';
      const base = fly ? 11.4 : walk ? 4.3 : cycle ? 4.8 : 6.9;
      const cameraSpeed = reducedMotion.matches ? 0 : smoothedSpeed;
      const dist =
        (action ? base * 0.65 : base) * zoom * (1 + Math.min(0.25, cameraSpeed * 0.01)) + cameraSpeed * 0.1;
      const height =
        (action ? 0.92 : (fly ? 3.3 : walk ? 1.95 : 2.12) * zoom) + Math.sin(pitch) * dist * 0.85;
      const side = action ? (fly ? 4.2 : walk ? 0.95 : 2.65) * zoom : 0;
      desired.set(
        state.x - Math.sin(yaw) * dist * Math.cos(pitch) + Math.cos(yaw) * side,
        cameraBaseY + height,
        state.z - Math.cos(yaw) * dist * Math.cos(pitch) - Math.sin(yaw) * side,
      );
      follow(target, desired, dt, camera.position, snap);
      state.cameraDistance = camera.position.distanceTo(target);
      const forward = walk ? 0.7 : 2.4;
      const lookHeading = walk ? yaw : state.heading;
      target.x += Math.sin(lookHeading) * forward;
      target.z += Math.cos(lookHeading) * forward;
      target.y += walk ? -0.32 : 0.25;
    }
    if (snap) {
      smoothTarget.copy(target);
      lookVelocity.set(0, 0, 0);
    } else springVector(smoothTarget, lookVelocity, target, state.cameraPreset === 'pov' ? 0.045 : 0.085, dt);
    camera.lookAt(smoothTarget);
    snap = false;
  }
  function updateMovement(dt) {
    if (hidden) return;
    elapsed += dt;
    const pad = gamepad(dt);
    if (state.mode !== 'orbit') {
      const throttle = clamp(
        (keys.has('w') || keys.has('arrowup') ? 1 : 0) -
          (keys.has('s') || keys.has('arrowdown') ? 1 : 0) -
          touch.y +
          pad.throttle,
        -1,
        1,
      );
      const steer = clamp(
        (keys.has('d') || keys.has('arrowright') ? 1 : 0) -
          (keys.has('a') || keys.has('arrowleft') ? 1 : 0) +
          touch.x +
          pad.steer,
        -1,
        1,
      );
      const boost = keys.has('shift') || touch.boost || pad.boost,
        walk = state.mode === 'walk',
        fly = state.mode === 'fly';
      const jump = (keys.has(' ') || touch.up || pad.jump) && walk;
      state.throttle = throttle;
      state.braking = keys.has(' ') || touch.down || pad.brake || state.speed * throttle < 0;
      state.steering = steeringApproach(state.steering, steer, dt, state.mode === 'cycle' ? CYCLE : DRIVE);
      const oldHeading = state.heading;
      if (walk) {
        const walkSpeed = 2.7 * PLAYER_PACE_MULTIPLIER;
        const limit = boost ? 5.25 * PLAYER_PACE_MULTIPLIER : walkSpeed;
        const wanted = walkInput(throttle, steer, walkingCameraYaw, limit);
        const input = Math.hypot(wanted.x, wanted.z) > 0.01;
        const acceleration = (input ? (boost ? 16 : 12) : 28) * PLAYER_PACE_MULTIPLIER;
        walkVelocityX = velocityApproach(walkVelocityX, wanted.x, dt, input ? 12 : 24, acceleration);
        walkVelocityZ = velocityApproach(walkVelocityZ, wanted.z, dt, input ? 12 : 24, acceleration);
        if (Math.hypot(walkVelocityX, walkVelocityZ) < 0.015 && !input) walkVelocityX = walkVelocityZ = 0;
        const moving = Math.hypot(walkVelocityX, walkVelocityZ);
        const facing =
          state.cameraPreset === 'pov'
            ? walkingCameraYaw
            : moving > 0.08
              ? Math.atan2(walkVelocityX, walkVelocityZ)
              : state.heading;
        const goal = state.heading + angleDelta(state.heading, facing);
        [state.heading, bodyYawVelocity] = springScalar(state.heading, bodyYawVelocity, goal, 0.11, dt);
        state.speed =
          state.cameraPreset === 'pov'
            ? walkVelocityX * Math.sin(state.heading) + walkVelocityZ * Math.cos(state.heading)
            : moving;
        state.lateralSpeed =
          -walkVelocityX * Math.cos(state.heading) + walkVelocityZ * Math.sin(state.heading);
        state.running = boost && moving > walkSpeed;
      } else if (fly) {
        const limit = boost ? 95 : 52;
        state.speed += (throttle * limit - state.speed) * (1 - Math.exp(-dt * 1.8));
        state.heading -= state.steering * dt * 1.55;
      } else if (state.mode === 'drive') {
        stepCarDrive(state, throttle, steer, keys.has(' ') || touch.down || pad.brake, dt);
      } else {
        const config = CYCLE;
        const drive = boost ? { ...config, speed: 23, acceleration: config.acceleration * 1.2 } : config;
        const previousSpeed = state.speed;
        state.speed = driveSpeed(previousSpeed, throttle, dt, drive);
        state.speed = corneringSpeed(state.speed, state.steering, dt, drive);
        if (keys.has(' ') || touch.down || pad.brake) state.speed *= Math.exp(-dt * 8);
        state.heading -= turnRate(state.speed, state.steering, drive) * dt;
      }
      state.yawRate = angleDelta(oldHeading, state.heading) / dt;
      if (state.mode === 'drive' && world.bodyBlocked && Math.abs(state.yawRate) > 0.001) {
        state.heading = rotationWithClearance(oldHeading, state.heading, (heading) =>
          world.bodyBlocked(state, movementBody('drive', heading)),
        );
        state.yawRate = angleDelta(oldHeading, state.heading) / dt;
      }
      if (walk) state.steering = Math.max(-1, Math.min(1, -state.yawRate / 4));
      state.velocityX = walk ? walkVelocityX : Math.sin(state.heading) * state.speed;
      state.velocityZ = walk ? walkVelocityZ : Math.cos(state.heading) * state.speed;
      if (state.mode === 'drive') {
        state.velocityX += Math.cos(state.heading) * state.lateralSpeed;
        state.velocityZ -= Math.sin(state.heading) * state.lateralSpeed;
      }
      const movementStartX = state.x,
        movementStartZ = state.z,
        wasGrounded = state.grounded;
      const displacementX = state.velocityX * dt,
        displacementZ = state.velocityZ * dt,
        distance = Math.hypot(displacementX, displacementZ),
        steps = Math.max(1, Math.ceil(distance / 0.35)),
        body = movementBody(state.mode, state.heading);
      for (let i = 0; i < steps; i++) {
        stepOrigin.set(state.x, state.y, state.z);
        nextPosition.set(state.x + displacementX / steps, state.y, state.z + displacementZ / steps);
        const nextGround = fly ? state.y : supportHeight(nextPosition.x, nextPosition.z, state.y);
        if (!traversableHeight(state.y, nextGround, distance / steps, state.mode)) {
          state.speed *= 0.35;
          break;
        }
        const followGround = !fly && state.grounded && (state.mode !== 'walk' || state.y - nextGround <= 0.3);
        if (followGround) nextPosition.y = nextGround;
        if (
          nextPosition.x < minX + 3 ||
          nextPosition.x > maxX - 3 ||
          nextPosition.z < minZ + 3 ||
          nextPosition.z > maxZ - 3
        ) {
          state.speed = 0;
          break;
        }
        const beforeX = nextPosition.x,
          beforeZ = nextPosition.z;
        const hit = resolveBoundedMovement(world, nextPosition, body, stepOrigin);
        if (hit) {
          const impact = Math.hypot(state.speed, state.mode === 'drive' ? state.lateralSpeed : 0);
          const traffic = world.lastTrafficContact;
          if (impact > 2 && (lastNotice === 0 || elapsed - lastNotice > 0.28)) {
            const event = {
              kind: traffic ? 'vehicle' : 'building',
              speed: impact,
              x: nextPosition.x,
              y: nextPosition.y,
              z: nextPosition.z,
              a: state,
              b: traffic?.car,
            };
            if (state.mode === 'drive')
              world.vehicleImpact?.(event, displacementX / distance, displacementZ / distance);
            impactListener?.(event);
            lastNotice = elapsed;
          }
          if (
            !world.resolveMovement ||
            (world.bodyBlocked
              ? world.bodyBlocked(nextPosition, body)
              : world.collision(nextPosition.x, nextPosition.z, body.radius, state.y))
          ) {
            state.speed *= 0.25;
            if (state.mode === 'drive') state.lateralSpeed *= 0.2;
            break;
          }
          const requestedStep = distance / steps;
          const push = Math.hypot(nextPosition.x - beforeX, nextPosition.z - beforeZ);
          if (requestedStep > 0.001 && push > 0.025) {
            const forward =
              ((nextPosition.x - stepOrigin.x) * displacementX +
                (nextPosition.z - stepOrigin.z) * displacementZ) /
              (requestedStep * distance);
            const lost = 1 - clamp(forward, 0, 1);
            state.speed *= Math.exp((-(walk ? 6 : 25) * lost * dt) / steps);
          }
          if (state.mode === 'drive') state.lateralSpeed *= 0.54;
        }
        state.x = nextPosition.x;
        state.z = nextPosition.z;
        if (followGround) state.y = hit ? supportHeight(state.x, state.z, nextPosition.y) : nextGround;
        else if (!fly && state.mode === 'walk' && state.y - nextGround > 0.3) state.grounded = false;
      }
      if (walk) {
        // Animate the distance actually travelled after wall sliding, rather
        // than running in place at full input speed against a building.
        state.velocityX = (state.x - movementStartX) / dt;
        state.velocityZ = (state.z - movementStartZ) / dt;
        walkVelocityX = state.velocityX;
        walkVelocityZ = state.velocityZ;
        const forwardSpeed =
          state.velocityX * Math.sin(state.heading) + state.velocityZ * Math.cos(state.heading);
        state.speed =
          state.cameraPreset === 'pov' ? forwardSpeed : Math.hypot(state.velocityX, state.velocityZ);
      }
      const ground = supportHeight(state.x, state.z, state.y);
      if (fly) {
        const v =
          ((keys.has('e') || keys.has(' ') || touch.up || pad.jump ? 1 : 0) -
            (keys.has('q') || touch.down || pad.brake ? 1 : 0)) *
          46;
        state.verticalSpeed += (v - state.verticalSpeed) * (1 - Math.exp(-dt * 5));
        const vertical = sweepVerticalMovement(
          world,
          state,
          body,
          clamp(state.y + state.verticalSpeed * dt, ground + 0.25, 1200),
        );
        state.y = vertical.y;
        if (vertical.hit) state.verticalSpeed = 0;
      } else if (walk) {
        Object.assign(
          state,
          stepWalkingVertical(
            world,
            state,
            body,
            ground,
            dt,
            jump && !spaceWasDown && (wasGrounded || state.y <= ground + 0.05),
          ),
        );
      } else {
        state.y = ground;
        state.grounded = true;
        state.verticalSpeed = 0;
      }
      spaceWasDown = jump;
    }
  }
  function update(dt, frameSeconds = dt) {
    if (hidden || !(dt > 0) || !(frameSeconds > 0)) return;
    const { x, z } = state;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps; i++) updateMovement(dt / steps);
    // Measure motion after collisions and against elapsed time, including frames
    // when simulation time is capped to keep the physics stable.
    state.groundSpeed = Math.hypot(state.x - x, state.z - z) / frameSeconds;
    updateCamera(dt);
    if (elapsed - lastSave > 5) {
      save();
      lastSave = elapsed;
    }
  }
  const api = {
    state,
    orbit,
    touch,
    refreshCamera: (dt = 0.016) => updateCamera(dt),
    setHeading,
    mode,
    teleport,
    clear,
    save,
    safePosition,
    zoomBy,
    setCamera,
    selectCamera: setCamera,
    cycleCamera,
    cameraPresets: CAMERA_PRESETS,
    cameraCollision: collisions,
    update,
    setCollisionListener(listener) {
      impactListener = listener;
    },
    focusLandmark(landmark) {
      state.tour = false;
      setCamera('aerial');
      orbit.autoRotate = false;
      orbit.target.set(landmark.x, landmark.height * 0.45, landmark.z);
      camera.position.set(landmark.x - 210, landmark.height + 130, landmark.z - 300);
      collisions.resolve(camera.position, 0.4, camera.position);
      onChange(state);
    },
    tour() {
      state.tour = state.cameraPreset !== 'aerial' || !state.tour;
      if (state.cameraPreset !== 'aerial') setCamera('aerial');
      orbit.autoRotate = state.tour;
      onChange(state);
    },
  };
  mode('drive');
  try {
    const saved = persist ? JSON.parse(localStorage.getItem('calgary-player') || 'null') : null;
    if (
      saved &&
      ['walk', 'drive', 'cycle', 'fly'].includes(saved.mode) &&
      [saved.x, saved.z, saved.heading].every(Number.isFinite) &&
      saved.x > minX &&
      saved.x < maxX &&
      saved.z > minZ &&
      saved.z < maxZ
    ) {
      state.mode = saved.mode;
      const restored = savedPlacement(world, saved);
      if (restored) {
        state.x = restored.x;
        state.y = restored.y;
        state.z = restored.z;
      } else {
        [state.x, state.z] = safePosition(saved.x, saved.z, saved.mode === 'drive' || saved.mode === 'cycle');
        state.y =
          saved.mode === 'fly'
            ? clamp(Number(saved.y) || 70, 8, 1200)
            : world.groundHeight(state.x, state.z, Number.isFinite(saved.y) ? saved.y : undefined);
      }
      state.heading = saved.heading;
      state.grounded = saved.mode !== 'fly' && state.y <= supportHeight(state.x, state.z, state.y) + 0.02;
      resetCamera();
      setCamera(CAMERA_PRESETS.some((p) => p.id === saved.cameraPreset) ? saved.cameraPreset : 'chase');
    }
  } catch {}
  updateCamera(0.016);
  return api;
}
