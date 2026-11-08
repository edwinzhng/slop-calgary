import { project, unproject, nearestOnSegment } from './geo.js';
import { PLACES, VIEW_CAMERAS } from './navigation.js';
import { createRouter, projectOnRoute } from './routing.js';
import { angleDelta } from './motion.js';
import * as THREE from 'three/webgpu';

export function createUI(nav, world, renderer, setTime, setQuality, camera, options = {}) {
  const $ = (id) => document.getElementById(id),
    atlas = $('atlas'),
    help = $('help'),
    speedValue = $('speed-value');
  const router = createRouter(world.data.roads);
  let selectedDestination = null,
    routeTarget = null,
    route = null,
    routeProgress = null,
    routeJob = 0,
    routing = false,
    lastRouted = 0,
    lastRoutePosition = [nav.state.x, nav.state.z];
  const formatDistance = (metres) =>
    metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  const landmarkLayer = document.createElement('div');
  landmarkLayer.className = 'landmark-labels';
  landmarkLayer.setAttribute('aria-label', 'Calgary landmarks');
  document.body.append(landmarkLayer);
  const landmarkButtons = world.landmark.labels.map((l) => {
    const b = document.createElement('button');
    b.textContent = l.name;
    b.addEventListener('click', () => nav.focusLandmark(l));
    landmarkLayer.append(b);
    return { l, b };
  });
  const projected = new THREE.Vector3(),
    look = new THREE.Vector3(),
    toLabel = new THREE.Vector3();
  function updateLandmarks() {
    if (!document.body.classList.contains('landmarks-visible')) return;
    const placed = [];
    camera.getWorldDirection(look);
    for (const { l, b } of landmarkButtons) {
      b.hidden = true;
      if (!['orbit', 'fly'].includes(nav.state.mode)) continue;
      toLabel.set(l.x, l.height, l.z).sub(camera.position);
      if (toLabel.dot(look) <= 0) continue;
      projected.set(l.x, l.height, l.z).project(camera);
      const x = (projected.x * 0.5 + 0.5) * innerWidth,
        y = (-projected.y * 0.5 + 0.5) * innerHeight;
      if (
        x < 235 ||
        x > innerWidth - 120 ||
        y < 135 ||
        y > innerHeight - 200 ||
        placed.some((p) => Math.abs(p.x - x) < 140 && Math.abs(p.y - y) < 38) ||
        placed.length >= 5
      )
        continue;
      b.hidden = false;
      b.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
      placed.push({ x, y });
    }
  }
  let toastTimer,
    mapDirty = true;
  const touchInput = matchMedia('(any-pointer: coarse)');
  const touchLayout = () => touchInput.matches || options.forceTouch;
  function notice(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
  }
  let lastModeKey = '';
  function change(state) {
    const key = `${state.mode}/${state.tour}/${state.cameraPreset}/${touchLayout()}`;
    if (key === lastModeKey) return;
    lastModeKey = key;
    document.body.dataset.mode = state.mode;
    document.body.classList.remove('active');
    document.body.classList.toggle('touch-enabled', touchLayout());
    document.querySelectorAll('.mode-switch button[data-mode]').forEach((b) => {
      const active = b.dataset.mode === state.mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active);
    });
    $('tour-btn').setAttribute('aria-pressed', state.cameraPreset === 'aerial' && state.tour);
    $('touch-controls').hidden = state.mode === 'orbit' || !touchLayout();
    $('ascend').hidden = !['walk', 'fly'].includes(state.mode);
    $('descend').hidden = state.mode === 'walk';
    $('up-label').textContent = state.mode === 'fly' ? 'Ascend' : 'Jump';
    $('ascend').setAttribute('aria-label', state.mode === 'fly' ? 'Ascend' : 'Jump');
    $('down-label').textContent = state.mode === 'fly' ? 'Descend' : 'Brake';
    $('descend').setAttribute('aria-label', state.mode === 'fly' ? 'Descend' : 'Brake');
    document.querySelectorAll('[data-camera]').forEach((b) => {
      const active = b.dataset.camera === state.cameraPreset;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active);
    });
    const current = VIEW_CAMERAS.find(({ id }) => id === state.cameraPreset);
    $('camera-menu').setAttribute('aria-label', current ? `Camera, ${current.label}` : 'Camera');
  }
  for (const { id, label, shortcut } of VIEW_CAMERAS) {
    const b = document.createElement('button');
    b.className = 'pop-item';
    b.dataset.camera = id;
    b.textContent = label;
    if (shortcut) {
      const key = document.createElement('kbd');
      key.textContent = shortcut;
      b.append(key);
    }
    b.addEventListener('click', () => {
      nav.setCamera(id);
      $('camera-popover').hidePopover();
      change(nav.state);
    });
    $('camera-choices').append(b);
  }
  $('zoom-in').addEventListener('click', () => nav.zoomBy(-0.18));
  $('zoom-out').addEventListener('click', () => nav.zoomBy(0.18));
  $('weather').addEventListener('change', (e) => options.setWeather?.(e.target.value));
  $('theme').addEventListener('change', (e) => options.setTheme?.(e.target.value));
  $('landmark-toggle').addEventListener('change', (e) =>
    document.body.classList.toggle('landmarks-visible', e.target.checked),
  );
  let audioEnabled = options.audio?.enabled ?? options.audio?.state?.enabled ?? false;
  let audioVolume = options.audio?.volume ?? options.audio?.state?.volume ?? 0.65;
  function setAudioState(state = {}) {
    if (state.enabled !== undefined) audioEnabled = state.enabled;
    if (state.volume !== undefined) audioVolume = state.volume;
    $('volume').value = audioVolume;
    $('sound-btn').setAttribute('aria-pressed', audioEnabled);
    $('sound-btn').setAttribute('aria-label', audioEnabled ? 'Mute sound' : 'Enable sound');
    $('sound-btn')
      .querySelector('use')
      .setAttribute('href', audioEnabled ? '#i-sound' : '#i-sound-off');
  }
  setAudioState({ enabled: audioEnabled, volume: audioVolume });
  async function audioChange(patch) {
    if (!options.setAudio) return;
    try {
      await options.setAudio(patch);
      setAudioState(patch);
    } catch {
      notice('Sound could not start. Try the sound button again.');
    }
  }
  $('sound-btn').addEventListener('click', () =>
    audioChange({ enabled: !audioEnabled, volume: audioVolume }),
  );
  $('volume').addEventListener('input', (e) => audioChange({ volume: Number(e.target.value) }));
  function toggleHud() {
    const hidden = document.body.classList.toggle('hud-minimized');
    if (hidden) {
      document.querySelector('[popover]:popover-open')?.hidePopover();
      nav.clear();
    }
    $('btn-toggle-hud').setAttribute('aria-pressed', hidden);
    $('btn-toggle-hud').setAttribute('aria-label', hidden ? 'Show HUD' : 'Hide HUD');
  }
  $('btn-toggle-hud').addEventListener('click', toggleHud);
  for (const [id, anchorId] of [
    ['time-popover', 'time-menu'],
    ['teleport-popover', 'explore-map'],
    ['camera-popover', 'camera-menu'],
    ['settings-panel', 'settings-btn'],
  ]) {
    const popover = $(id);
    const anchor = $(anchorId);
    const placePopover = () => {
      const r = anchor.getBoundingClientRect();
      const above = r.top > innerHeight / 2;
      popover.dataset.side = above ? 'above' : 'below';
      popover.style.right = `clamp(var(--hud-right), ${innerWidth - r.right}px, calc(100% - var(--hud-left) - var(--popover-width)))`;
      popover.style.top = above ? 'auto' : `${r.bottom + 8}px`;
      popover.style.bottom = above ? `${innerHeight - r.top + 8}px` : 'auto';
      popover.style.maxHeight = above
        ? `calc(${r.top - 8}px - var(--hud-top))`
        : `calc(100dvh - ${r.bottom + 8}px - var(--hud-bottom))`;
    };
    popover.addEventListener('beforetoggle', ({ newState }) => {
      anchor.setAttribute('aria-expanded', newState === 'open');
      if (newState !== 'open') return;
      nav.clear();
      placePopover();
    });
    addEventListener('resize', () => {
      if (popover.matches(':popover-open')) placePopover();
    });
  }
  document
    .querySelectorAll('.mode-switch button[data-mode]')
    .forEach((b) => b.addEventListener('click', () => nav.mode(b.dataset.mode)));
  function setTimeState(id) {
    if (!['golden', 'day', 'dusk', 'night'].includes(id)) return;
    document.querySelectorAll('[data-time]').forEach((el) => {
      const active = el.dataset.time === id;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', active);
      if (active) {
        const label = el.getAttribute('aria-label');
        $('time-name').textContent = label;
        $('time-menu').setAttribute('aria-label', `Time of day, ${label}`);
        $('time-menu')
          .querySelector('use')
          .setAttribute('href', el.querySelector('use').getAttribute('href'));
      }
    });
    document.body.classList.toggle('night', id === 'night' || id === 'dusk');
  }
  document.querySelectorAll('[data-time]').forEach((b) =>
    b.addEventListener('click', () => {
      setTime(b.dataset.time);
      setTimeState(b.dataset.time);
      $('time-popover').hidePopover();
    }),
  );
  $('quality').addEventListener('change', (e) => setQuality(e.target.value));
  $('tour-btn').addEventListener('click', () => {
    nav.tour();
    $('camera-popover').hidePopover();
    change(nav.state);
  });
  const go = (place) => {
    clearRoute();
    selectedDestination = null;
    $('map-destination').hidden = true;
    if (place.bearing !== undefined) nav.state.heading = place.bearing;
    nav.teleport(place.lon, place.lat, place.name, place.business ? 'walk' : nav.state.mode);
    if (place.business) nav.mode('walk');
    if ($('teleport-popover').matches(':popover-open')) $('teleport-popover').hidePopover();
    trail.length = 0;
    atlas.close();
  };
  for (const place of PLACES) {
    const b = document.createElement('button');
    b.textContent = place.name;
    b.className = 'pop-item tp-btn';
    b.addEventListener('click', () => go(place));
    $('place-buttons').append(b);
  }
  for (const d of document.querySelectorAll('dialog')) {
    d.querySelector('.close').addEventListener('click', () => d.close());
    d.addEventListener('click', (e) => {
      if (e.target === d) {
        const b = d.getBoundingClientRect();
        if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) d.close();
      }
    });
    d.addEventListener('close', () => {
      nav.clear();
      mapDirty = true;
    });
  }
  const openAtlas = () => {
    nav.clear();
    atlas.showModal();
    void router.prepare();
    requestAnimationFrame(() => {
      mapDirty = true;
      drawAtlas();
    });
  };
  addEventListener('resize', () => {
    change(nav.state);
    mapDirty = true;
  });
  $('open-map').addEventListener('click', openAtlas);
  touchInput.addEventListener('change', () => change(nav.state));
  $('minimap-open').addEventListener('click', openAtlas);
  $('route-open-map').addEventListener('click', openAtlas);
  const openHelp = () => {
    nav.clear();
    if ($('settings-panel').matches(':popover-open')) $('settings-panel').hidePopover();
    help.showModal();
  };
  $('help-btn').addEventListener('click', openHelp);
  $('about-btn').addEventListener('click', openHelp);
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select') || help.open) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const modes = { 1: 'walk', 2: 'drive', 3: 'cycle', 4: 'fly' };
    if (modes[e.key] && !atlas.open) nav.mode(modes[e.key]);
    if (e.key.toLowerCase() === 'm') {
      e.preventDefault();
      if (atlas.open) atlas.close();
      else openAtlas();
    }
    if (e.key === '?' && !atlas.open) openHelp();
    if (e.key.toLowerCase() === 'h' && !atlas.open) toggleHud();
    if (e.key.toLowerCase() === 'n' && !atlas.open)
      audioChange({ enabled: !audioEnabled, volume: audioVolume });
    if (e.key.toLowerCase() === 'r' && !atlas.open) {
      const [x, z] = nav.safePosition(nav.state.x, nav.state.z, true);
      nav.clear();
      nav.state.x = x;
      nav.state.z = z;
      notice('Back on a clear street');
    }
  });
  $('data-stats').textContent =
    `${world.stats.buildings.toLocaleString()} buildings · ${(world.stats.cityMeshes || 0).toLocaleString()} surveyed 3D meshes · ${(world.stats.surveyedSidewalks || 0).toLocaleString()} surveyed sidewalk polygons · ${world.stats.trees.toLocaleString()} public trees · ${(world.stats.bridges || 0).toLocaleString()} bridge models · ${(world.stats.skywalks || 0).toLocaleString()} elevated skywalks · ${(world.stats.storefronts || 0).toLocaleString()} mapped business frontages`;
  // A locally drawn vector atlas. The same data drives the map and the 3D city.
  const [west, north] = project(world.data.meta.bbox.west, world.data.meta.bbox.north),
    [east, south] = project(world.data.meta.bbox.east, world.data.meta.bbox.south);
  const base = document.createElement('canvas');
  base.width = 1600;
  base.height = 1400;
  const ctx = base.getContext('2d');
  const W = east - west,
    H = south - north,
    sx = base.width / W,
    sz = base.height / H;
  ctx.fillStyle = '#151a20';
  ctx.fillRect(0, 0, base.width, base.height);
  const path = (points) => {
    ctx.moveTo((points[0][0] - west) * sx, (points[0][1] - north) * sz);
    for (const p of points.slice(1)) ctx.lineTo((p[0] - west) * sx, (p[1] - north) * sz);
  };
  for (const [polys, fill] of [
    [world.data.parks, '#19301f'],
    [world.data.buildings, '#252d37'],
    [world.data.waters, '#0a1118'],
  ]) {
    ctx.fillStyle = fill;
    for (const p of polys) {
      ctx.beginPath();
      path(p.ring);
      ctx.closePath();
      for (const h of p.holes || []) {
        path(h);
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
  }
  ctx.strokeStyle = '#3a434f';
  ctx.lineCap = 'round';
  for (const r of world.data.roads) {
    if (r.tunnel || ['steps', 'corridor', 'service', 'footway'].includes(r.kind)) continue;
    ctx.beginPath();
    path(r.points);
    ctx.lineWidth = ['primary', 'secondary', 'trunk'].includes(r.kind) ? 2.3 : 1;
    ctx.stroke();
  }
  const atlasAreas = PLACES.slice(0, 5).map(({ name, lon, lat }) => ({
    name: name.toUpperCase(),
    point: project(lon, lat),
  }));
  const mini = $('minimap'),
    mc = mini.getContext('2d'),
    ac = $('atlas-canvas'),
    acx = ac.getContext('2d');
  const trail = [];
  const radarCompass = document.querySelector('.radar-north'),
    radarSize = { width: mini.clientWidth, height: mini.clientHeight };
  radarCompass.style.left = radarCompass.style.top = '0px';
  new ResizeObserver(([{ contentRect }]) => {
    radarSize.width = contentRect.width;
    radarSize.height = contentRect.height;
  }).observe(mini);
  function clearRoute() {
    routeJob++;
    route = routeTarget = routeProgress = null;
    routing = false;
    $('destination-route').disabled = false;
    $('destination-route').textContent = 'Route here';
    $('route-guidance').hidden = true;
    $('map-clear-route').hidden = true;
    $('map-status').textContent = 'Search or tap a destination';
    mapDirty = true;
  }
  $('route-clear').addEventListener('click', clearRoute);
  $('map-clear-route').addEventListener('click', clearRoute);
  function chooseDestination(place, center = false) {
    const [x, z] = place.x === undefined ? project(place.lon, place.lat) : [place.x, place.z];
    const [lon, lat] = unproject(x, z);
    selectedDestination = { ...place, lon, lat, x, z };
    $('destination-name').textContent = place.name || 'Destination';
    $('map-destination').hidden = false;
    $('map-results').hidden = true;
    if (center) {
      view.zoom = Math.max(3, view.zoom);
      view.x = view.y = 0;
      const { w, h, scale, ox, oy } = transform();
      view.x = w / 2 - (ox + x * scale);
      view.y = h / 2 - (oy + z * scale);
    }
    scheduleAtlas();
  }
  async function routeToDestination(target, closeMap = true, silent = false) {
    if (!target) return;
    const job = ++routeJob;
    routing = true;
    $('destination-route').disabled = true;
    $('destination-route').textContent = 'Finding route…';
    try {
      if (nav.state.mode !== 'fly') await router.prepare();
      if (job !== routeJob) return;
      const found = router.route([nav.state.x, nav.state.z], [target.x, target.z], nav.state.mode);
      lastRouted = performance.now();
      lastRoutePosition = [nav.state.x, nav.state.z];
      if (found.status !== 'ok') {
        if (!silent) {
          clearRoute();
          notice(
            found.status === 'off-network'
              ? 'Choose a destination closer to a mapped street or path.'
              : 'No connected route for this travel mode.',
          );
        }
        return;
      }
      route = found;
      routeTarget = target;
      selectedDestination = null;
      routeProgress = projectOnRoute(route, nav.state.x, nav.state.z);
      $('route-guidance').hidden = false;
      $('map-clear-route').hidden = false;
      $('map-destination').hidden = true;
      mapDirty = true;
      updateRoute(performance.now());
      if (closeMap) atlas.close();
    } finally {
      if (job === routeJob) {
        routing = false;
        $('destination-route').disabled = false;
        $('destination-route').textContent = 'Route here';
      }
    }
  }
  function updateRoute(now) {
    if (!route || !routeTarget) return;
    const s = nav.state;
    routeProgress = projectOnRoute(route, s.x, s.z);
    const targetDistance = Math.hypot(s.x - routeTarget.x, s.z - routeTarget.z),
      networkEndDistance = Math.hypot(s.x - route.end[0], s.z - route.end[1]);
    if (targetDistance < 18 || (routeProgress.remaining < 14 && networkEndDistance < 20)) {
      const name = routeTarget.name || 'Destination';
      clearRoute();
      notice(`Arrived · ${name}`);
      return;
    }
    const remaining =
      routeProgress.remaining + Math.hypot(route.end[0] - routeTarget.x, route.end[1] - routeTarget.z);
    $('route-distance').textContent = `${formatDistance(remaining)} · ${routeTarget.name || 'Destination'}`;
    $('map-status').textContent = `${formatDistance(remaining)} · ${routeTarget.name || 'Destination'}`;
    const moved = Math.hypot(s.x - lastRoutePosition[0], s.z - lastRoutePosition[1]);
    if (
      !routing &&
      (route.mode !== s.mode || (routeProgress.distance > 40 && moved > 25 && now - lastRouted > 4500))
    ) {
      void routeToDestination(routeTarget, false, false);
    }
  }
  $('destination-close').addEventListener('click', () => {
    selectedDestination = null;
    $('map-destination').hidden = true;
    scheduleAtlas();
  });
  $('destination-route').addEventListener('click', () => void routeToDestination(selectedDestination));
  $('destination-teleport').addEventListener('click', () => {
    if (selectedDestination) go(selectedDestination);
    selectedDestination = null;
    $('map-destination').hidden = true;
  });
  const roadLabels = new Map();
  for (const segment of world.roadIndex.segments) {
    const { road, a, b } = segment;
    if (road.tunnel || !road.name || ['service', 'corridor', 'footway', 'path', 'steps'].includes(road.kind))
      continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > (roadLabels.get(road.name)?.length ?? 28))
      roadLabels.set(road.name, {
        ...segment,
        length,
        major: ['trunk', 'primary', 'secondary', 'tertiary'].includes(road.kind),
      });
  }
  const atlasLabels = [...roadLabels.values()].sort(
    (a, b) =>
      Number(b.major) - Number(a.major) || b.length - a.length || a.road.name.localeCompare(b.road.name),
  );
  function drawTrail(c, toScreen, width = 2.5) {
    if (trail.length < 2) return;
    c.save();
    c.strokeStyle = '#e4e8ed50';
    c.lineWidth = width;
    c.lineJoin = c.lineCap = 'round';
    c.beginPath();
    trail.forEach(([x, z], i) => {
      const p = toScreen(x, z);
      if (i) c.lineTo(...p);
      else c.moveTo(...p);
    });
    c.stroke();
    c.restore();
  }
  function drawRoute(c, toScreen, width = 3) {
    const target = selectedDestination || routeTarget;
    if (route && routeProgress) {
      const points = [routeProgress.point, ...route.points.slice(routeProgress.index + 1)];
      c.save();
      c.lineJoin = c.lineCap = 'round';
      c.beginPath();
      points.forEach(([x, z], i) => {
        const p = toScreen(x, z);
        if (i) c.lineTo(...p);
        else c.moveTo(...p);
      });
      c.lineWidth = width + 3;
      c.strokeStyle = '#2b2209cc';
      c.stroke();
      c.lineWidth = width;
      c.strokeStyle = '#ffc21a';
      c.stroke();
      c.restore();
    }
    if (target) {
      const [x, y] = toScreen(target.x, target.z);
      c.save();
      c.fillStyle = '#ffc21a';
      c.strokeStyle = '#161b22';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, y, width * 2.2, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.fillStyle = '#151a20';
      c.beginPath();
      c.arc(x, y, width * 0.8, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }
  function drawRoadLabels(
    c,
    toScreen,
    width,
    height,
    { scale, ratio = 1, overview = false, labels = atlasLabels },
  ) {
    const placed = [];
    if (overview) {
      const controls = atlas.querySelector('.map-controls').getBoundingClientRect();
      placed.push({
        left: (controls.left - 5) * ratio,
        right: (controls.right + 5) * ratio,
        top: (controls.top - 5) * ratio,
        bottom: (controls.bottom + 5) * ratio,
      });
    }
    const firstLabel = placed.length;
    const insetX = (overview ? 14 : 8) * ratio;
    const insetTop = (overview ? 67 : 8) * ratio;
    const insetBottom = (overview ? 26 : 8) * ratio;
    const draw = (name, x, y, angle, labelHeight) => {
      const textWidth = c.measureText(name).width;
      const halfW =
        (Math.abs(Math.cos(angle)) * textWidth + Math.abs(Math.sin(angle)) * labelHeight) / 2 + 5 * ratio;
      const halfH =
        (Math.abs(Math.sin(angle)) * textWidth + Math.abs(Math.cos(angle)) * labelHeight) / 2 + 4 * ratio;
      const left = x - halfW,
        right = x + halfW,
        top = y - halfH,
        bottom = y + halfH;
      if (
        left < insetX ||
        right > width - insetX ||
        top < insetTop ||
        bottom > height - insetBottom ||
        placed.some((p) => left < p.right && right > p.left && top < p.bottom && bottom > p.top)
      )
        return;
      placed.push({ left, right, top, bottom });
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      c.strokeText(name, 0, 0);
      c.fillText(name, 0, 0);
      c.restore();
    };
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.strokeStyle = '#10151cf0';
    c.lineWidth = 3 * ratio;
    if (overview) {
      c.font = `700 ${10 * ratio}px system-ui`;
      c.fillStyle = '#b5c4c8';
      for (const area of atlasAreas) {
        const [x, y] = toScreen(...area.point);
        draw(area.name, x, y, 0, 10 * ratio);
      }
    }
    c.font = `500 ${(overview ? 11 : 9.5) * ratio}px system-ui`;
    c.fillStyle = '#e4e8ed';
    for (const { road, a, b, length, major } of labels) {
      if (!major && scale / ratio < (overview ? 0.21 : 0.28)) continue;
      const [x, y] = toScreen((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (x < insetX || x > width - insetX || y < insetTop || y > height - insetBottom) continue;
      if (!major && length * scale < 40 * ratio) continue;
      const start = toScreen(...a);
      const end = toScreen(...b);
      let angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      draw(road.name, x, y, angle, 11 * ratio);
      if (placed.length - firstLabel >= (overview ? 24 : 6)) break;
    }
    c.restore();
  }
  const radarPose = { x: NaN, y: 0, z: 0, heading: 0 };
  const drawnRadar = { x: NaN, y: 0, z: 0, heading: 0, look: new THREE.Vector3() };
  let radarTime = 0,
    radarMode,
    radarRoute,
    radarTarget,
    radarTrail,
    nearbyLabels = [],
    labelX = Infinity,
    labelZ = Infinity,
    labelRadius = 0;
  function drawRadar(state, now) {
    const { width: w, height: h } = radarSize;
    if (!w || !h || atlas.open || document.body.classList.contains('hud-minimized')) return;
    const elapsed = now - radarTime;
    radarTime = now;
    const s = radarPose;
    const reset = radarMode !== state.mode || elapsed > 300 || Math.hypot(state.x - s.x, state.z - s.z) > 65;
    radarMode = state.mode;
    const follow = reset ? 1 : 1 - Math.exp(-Math.max(0, elapsed) / 52);
    if (reset || !Number.isFinite(s.x))
      Object.assign(s, { x: state.x, y: state.y, z: state.z, heading: state.heading });
    else {
      s.x += (state.x - s.x) * follow;
      s.y += (state.y - s.y) * follow;
      s.z += (state.z - s.z) * follow;
      s.heading += angleDelta(s.heading, state.heading) * follow;
    }
    const dpr = Math.min(devicePixelRatio, 2),
      scale = 0.32 / (1 + Math.max(0, s.y - 70) / 700),
      angle = s.heading + Math.PI,
      co = Math.cos(angle),
      si = Math.sin(angle);
    const resize = mini.width !== Math.round(w * dpr) || mini.height !== Math.round(h * dpr);
    camera.getWorldDirection(look);
    if (
      !reset &&
      !resize &&
      radarRoute === routeProgress &&
      radarTarget === selectedDestination &&
      radarTrail === trail.at(-1) &&
      Math.hypot(s.x - drawnRadar.x, s.z - drawnRadar.z) * scale < 0.025 &&
      Math.abs(s.y - drawnRadar.y) < 0.4 &&
      Math.abs(angleDelta(s.heading, drawnRadar.heading)) < 0.002 &&
      drawnRadar.look.distanceToSquared(look) < 0.000009
    )
      return;
    if (resize) {
      mini.width = Math.round(w * dpr);
      mini.height = Math.round(h * dpr);
    }
    Object.assign(drawnRadar, s);
    drawnRadar.look.copy(look);
    radarRoute = routeProgress;
    radarTarget = selectedDestination;
    radarTrail = trail.at(-1);
    const radius = Math.hypot(w, h) / (2 * scale);
    if (reset || Math.abs(radius - labelRadius) > 28 || Math.hypot(s.x - labelX, s.z - labelZ) > 28) {
      labelX = s.x;
      labelZ = s.z;
      labelRadius = radius;
      nearbyLabels = atlasLabels.filter(
        ({ a, b }) => Math.hypot((a[0] + b[0]) / 2 - s.x, (a[1] + b[1]) / 2 - s.z) < radius + 60,
      );
    }
    const screen = (x, z) => [
      w / 2 + ((x - s.x) * co - (z - s.z) * si) * scale,
      h / 2 + ((x - s.x) * si + (z - s.z) * co) * scale,
    ];
    mc.setTransform(dpr, 0, 0, dpr, 0, 0);
    mc.fillStyle = '#0a1118';
    mc.fillRect(0, 0, w, h);
    mc.save();
    mc.translate(w / 2, h / 2);
    mc.rotate(angle);
    mc.scale(scale, scale);
    mc.translate(-s.x, -s.z);
    const left = Math.max(0, Math.floor((s.x - radius - west) * sx)),
      top = Math.max(0, Math.floor((s.z - radius - north) * sz)),
      right = Math.min(base.width, Math.ceil((s.x + radius - west) * sx)),
      bottom = Math.min(base.height, Math.ceil((s.z + radius - north) * sz));
    if (right > left && bottom > top)
      mc.drawImage(
        base,
        left,
        top,
        right - left,
        bottom - top,
        west + left / sx,
        north + top / sz,
        (right - left) / sx,
        (bottom - top) / sz,
      );
    mc.restore();
    drawTrail(mc, screen);
    drawRoute(mc, screen);
    drawRoadLabels(mc, screen, w, h, { scale, labels: nearbyLabels });
    for (const l of world.landmark.labels) {
      const [x, y] = screen(l.x, l.z);
      if (x < 4 || x > w - 4 || y < 4 || y > h - 4) continue;
      mc.fillStyle = '#fff';
      mc.beginPath();
      mc.arc(x, y, 2.4, 0, Math.PI * 2);
      mc.fill();
    }
    const facing = screen(s.x + look.x * 100, s.z + look.z * 100),
      a = Math.atan2(facing[1] - h / 2, facing[0] - w / 2),
      cone = mc.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, 58);
    cone.addColorStop(0, '#ffffff50');
    cone.addColorStop(1, '#ffffff00');
    mc.fillStyle = cone;
    mc.beginPath();
    mc.moveTo(w / 2, h / 2);
    mc.arc(w / 2, h / 2, 58, a - 0.5, a + 0.5);
    mc.closePath();
    mc.fill();
    mc.save();
    mc.translate(w / 2, h / 2);
    mc.fillStyle = '#fff';
    mc.strokeStyle = '#0a1118';
    mc.lineWidth = 2.5;
    mc.beginPath();
    mc.moveTo(0, -9);
    mc.lineTo(6, 7);
    mc.lineTo(0, 4);
    mc.lineTo(-6, 7);
    mc.closePath();
    mc.stroke();
    mc.fill();
    mc.restore();
    const r = h / 2 - 14;
    radarCompass.style.transform = `translate(${w / 2 + si * r - 8.5}px, ${h / 2 - co * r - 8.5}px)`;
  }
  const view = { zoom: 1, x: 0, y: 0 };
  let atlasPositioned = false;
  let mapPointer = null;
  function transform() {
    const w = ac.width,
      h = ac.height,
      scale = Math.min(w / W, h / H) * 0.94 * view.zoom;
    return {
      w,
      h,
      scale,
      ox: w / 2 - (west + W / 2) * scale + view.x,
      oy: h / 2 - (north + H / 2) * scale + view.y,
    };
  }
  function centerAtlas(zoom) {
    view.zoom = zoom;
    view.x = view.y = 0;
    const { w, h, scale, ox, oy } = transform();
    view.x = w / 2 - (ox + nav.state.x * scale);
    view.y = h / 2 - (oy + nav.state.z * scale);
  }
  function drawMarker(c, x, z, scale, ox, oy, scaleZ = scale) {
    const px = ox + x * scale,
      py = oy + z * scaleZ;
    c.save();
    c.translate(px, py);
    c.rotate(-nav.state.heading + Math.PI);
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#0a1118';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6, 7);
    c.lineTo(0, 4);
    c.lineTo(-6, 7);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }
  function drawAtlas() {
    if (!atlas.open) return;
    const rect = ac.getBoundingClientRect(),
      ratio = Math.min(devicePixelRatio, 2);
    if (ac.width !== Math.round(rect.width * ratio) || ac.height !== Math.round(rect.height * ratio)) {
      ac.width = Math.round(rect.width * ratio);
      ac.height = Math.round(rect.height * ratio);
    }
    if (!atlasPositioned) {
      centerAtlas(2.6);
      atlasPositioned = true;
    }
    const { w, h, scale, ox, oy } = transform();
    acx.fillStyle = '#0a1118';
    acx.fillRect(0, 0, w, h);
    acx.drawImage(base, ox + west * scale, oy + north * scale, W * scale, H * scale);
    drawTrail(acx, (x, z) => [ox + x * scale, oy + z * scale], 3);
    drawRoute(acx, (x, z) => [ox + x * scale, oy + z * scale], 3 * ratio);
    drawRoadLabels(acx, (x, z) => [ox + x * scale, oy + z * scale], w, h, { scale, ratio, overview: true });
    drawMarker(acx, nav.state.x, nav.state.z, scale, ox, oy);
    mapDirty = false;
  }
  let atlasFrame = 0;
  function scheduleAtlas() {
    mapDirty = true;
    if (atlasFrame) return;
    atlasFrame = requestAnimationFrame(() => {
      atlasFrame = 0;
      drawAtlas();
    });
  }
  ac.addEventListener('pointerdown', (e) => {
    ac.setPointerCapture(e.pointerId);
    mapPointer = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, moved: false };
  });
  ac.addEventListener('pointermove', (e) => {
    if (!mapPointer) return;
    const ratio = ac.width / ac.clientWidth;
    view.x += (e.clientX - mapPointer.x) * ratio;
    view.y += (e.clientY - mapPointer.y) * ratio;
    mapPointer.x = e.clientX;
    mapPointer.y = e.clientY;
    if (Math.hypot(e.clientX - mapPointer.ox, e.clientY - mapPointer.oy) > 6) mapPointer.moved = true;
    scheduleAtlas();
  });
  ac.addEventListener('pointerup', (e) => {
    if (!mapPointer) return;
    if (!mapPointer.moved) {
      const rect = ac.getBoundingClientRect(),
        { scale, ox, oy } = transform(),
        px = ((e.clientX - rect.left) * ac.width) / rect.width,
        pz = ((e.clientY - rect.top) * ac.height) / rect.height,
        x = (px - ox) / scale,
        z = (pz - oy) / scale;
      if (x >= west && x <= east && z >= north && z <= south) {
        const nearby = world.roadIndex.nearest(x, z, false, 70, true);
        chooseDestination({ x, z, name: nearby?.distance < 50 ? nearby.road.name : 'Destination' });
      }
    }
    mapPointer = null;
  });
  ac.addEventListener('pointercancel', () => (mapPointer = null));
  $('map-zoom-in').addEventListener('click', () => {
    view.zoom = Math.min(8, view.zoom * 1.4);
    scheduleAtlas();
  });
  $('map-zoom-out').addEventListener('click', () => {
    view.zoom = Math.max(0.8, view.zoom / 1.4);
    scheduleAtlas();
  });
  $('map-view-all').addEventListener('click', () => {
    view.zoom = 1;
    view.x = view.y = 0;
    scheduleAtlas();
  });
  $('map-center-player').addEventListener('click', () => {
    centerAtlas(5);
    scheduleAtlas();
  });
  ac.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      view.zoom = Math.max(0.8, Math.min(8, view.zoom * Math.exp(-e.deltaY * 0.001)));
      scheduleAtlas();
    },
    { passive: false },
  );
  const roadNames = new Map();
  for (const r of world.data.roads) if (r.name && !roadNames.has(r.name)) roadNames.set(r.name, r);
  function search() {
    const q = $('map-search').value.trim().toLowerCase(),
      results = $('map-results');
    results.replaceChildren();
    results.hidden = !q;
    if (!q) return;
    const choices = PLACES.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => ({ ...p }));
    for (const landmark of world.landmark.labels) {
      if (!landmark.name.toLowerCase().includes(q) || choices.some((p) => p.name === landmark.name)) continue;
      const [lon, lat] = unproject(landmark.x, landmark.z);
      choices.push({ ...landmark, lon, lat, sub: 'Landmark' });
    }
    if (q)
      for (const p of world.businessPlaces || [])
        if (p.name.toLowerCase().includes(q) && choices.length < 20) choices.push(p);
    if (q)
      for (const r of roadNames.values())
        if (r.name.toLowerCase().includes(q) && choices.length < 20) {
          const p = r.points[Math.floor(r.points.length / 2)],
            lon =
              world.data.meta.origin.lon +
              p[0] / (((6371008.8 * Math.PI) / 180) * Math.cos((world.data.meta.origin.lat * Math.PI) / 180)),
            lat = world.data.meta.origin.lat - p[1] / ((6371008.8 * Math.PI) / 180);
          choices.push({ name: r.name, sub: 'Mapped street', lon, lat });
        }
    for (const p of choices) {
      const b = document.createElement('button');
      b.textContent = p.name;
      const s = document.createElement('small');
      if (p.sub) {
        s.textContent = p.sub;
        b.append(s);
      }
      b.addEventListener('click', () => chooseDestination(p, true));
      results.append(b);
    }
    if (!choices.length) {
      const p = document.createElement('p');
      p.textContent = 'No matching places or streets. Try another name or choose a point on the map.';
      results.append(p);
    }
  }
  search();
  $('map-search').addEventListener('input', search);
  const joystick = $('joystick'),
    knob = $('joystick-knob');
  let stickId = null;
  function stick(e) {
    const b = joystick.getBoundingClientRect(),
      dx = e.clientX - b.left - b.width / 2,
      dy = e.clientY - b.top - b.height / 2,
      length = Math.hypot(dx, dy),
      max = b.width * 0.32,
      scale = Math.min(1, max / (length || 1));
    nav.touch.x = (dx * scale) / max;
    nav.touch.y = (dy * scale) / max;
    knob.style.transform = `translate(${dx * scale}px,${dy * scale}px)`;
  }
  joystick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    joystick.setPointerCapture(e.pointerId);
    stick(e);
  });
  joystick.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) stick(e);
  });
  const release = () => {
    stickId = null;
    nav.touch.x = nav.touch.y = 0;
    knob.style.transform = '';
  };
  joystick.addEventListener('pointerup', release);
  joystick.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  for (const [id, key] of [
    ['ascend', 'up'],
    ['descend', 'down'],
  ]) {
    $(id).addEventListener('pointerdown', (e) => {
      e.target.setPointerCapture(e.pointerId);
      nav.touch[key] = true;
    });
    for (const ev of ['pointerup', 'pointercancel'])
      $(id).addEventListener(ev, () => (nav.touch[key] = false));
  }
  let last = 0,
    lastHudPose = '',
    lastHudRoute,
    lastHudDestination;
  return {
    notice,
    change,
    setAudioState,
    setTimeState,
    update(now) {
      const s = nav.state;
      if (s.mode !== 'walk' && s.mode !== 'orbit') {
        const speed = String(Math.round(s.groundSpeed * 3.6));
        if (speedValue.textContent !== speed) speedValue.textContent = speed;
      }
      drawRadar(s, now);
      if (now - last < 180) return;
      last = now;
      change(s);
      if (s.mode === 'fly') {
        const altitude = `${Math.round(Math.max(0, s.y - world.groundHeight(s.x, s.z, s.y)))} m up`;
        if ($('altitude').textContent !== altitude) $('altitude').textContent = altitude;
      }
      updateRoute(now);
      const pose =
        [
          s.x,
          s.y,
          s.z,
          s.heading * 100,
          camera.position.x,
          camera.position.y,
          camera.position.z,
          camera.quaternion.x * 100,
          camera.quaternion.y * 100,
          camera.quaternion.z * 100,
          camera.quaternion.w * 100,
        ]
          .map((v) => Math.round(v * 10))
          .join(',') + `/${s.mode}/${innerWidth}/${innerHeight}/${document.body.className}`;
      if (pose !== lastHudPose || route !== lastHudRoute || selectedDestination !== lastHudDestination) {
        lastHudPose = pose;
        lastHudRoute = route;
        lastHudDestination = selectedDestination;
        updateLandmarks();
        const r = world.roadIndex.nearest(s.x, s.z, true, 150, true);
        const parkName = world.parks
          ?.nameAt(s.x, s.z)
          ?.toLowerCase()
          .replace(/(^|\s)[a-z]/g, (v) => v.toUpperCase());
        const placeName = parkName || r?.road.name;
        $('location-name').textContent = placeName || 'Calgary';
        $('atlas-location').textContent = placeName || 'Downtown & both rivers';
        const crossing = [...world.roadIndex.index.near(s.x, s.z, 35)].find(
          (p) =>
            p.road.name &&
            p.road.name !== r?.road.name &&
            !['service', 'corridor', 'footway', 'path'].includes(p.road.kind) &&
            nearestOnSegment(s.x, s.z, p.a, p.b).distance < 18,
        );
        $('cross-street').hidden = !crossing;
        if (crossing) $('cross-street').textContent = crossing.road.name;
        const previous = trail.at(-1);
        if (!previous || Math.hypot(s.x - previous[0], s.z - previous[1]) > 12) {
          if (previous && Math.hypot(s.x - previous[0], s.z - previous[1]) > 250) trail.length = 0;
          trail.push([s.x, s.z]);
          if (trail.length > 180) trail.shift();
          mapDirty = true;
        }
      }
      if (atlas.open && (mapDirty || s.mode === 'orbit')) drawAtlas();
    },
    isModalOpen: () => !!document.querySelector('dialog[open], [popover]:popover-open'),
    isMapOpen: () => atlas.open,
    isCameraOpen: () => $('camera-popover').matches(':popover-open'),
  };
}
