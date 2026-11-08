import * as THREE from 'three/webgpu';
import { createCitySky } from './city-sky.js';
import { buildWorld } from './world.js';
import { createActors } from './actors.js';
import { createNavigation } from './navigation.js';
import { createUI } from './ui.js';
import { createStorefronts } from './storefronts.js';
import { createFacadeLettering, createFacadeCredits } from './facade-imagery.js';
import './facade-imagery.css';
import { createAtmosphere, atmosphereSettings } from './atmosphere.js';
import { createCityAudio } from './audio-system.js';
import { createCityPipeline } from './render-pipeline.js';
import { loadCityMeshes } from './city-meshes.js';
import { loadFallbackBuildings } from './fallback-buildings.js';
import { loadCanElevationRoofs } from './copc-roofs.js';
import { loadIslandTerrain } from './island-terrain.js';
import { loadNeighbourhoodTerrain, withNeighbourhoodTerrain } from './neighbourhood-terrain.js';
import { loadSurveyedLightingData } from './surveyed-lighting.js';
import { applySiteOverlays } from './site-overlays.js';
import siteOverlay from '../data/calgary-site-overlay.json' with { type: 'json' };
import { snapShadowTarget, renderPixelRatio, createMobileResolutionBudget } from './render-stability.js';
import { windowGlow, headlightWeather, cityUniforms } from './city-uniforms.js';
import { createPerformanceMonitor } from './performance-monitor.js';
import { updateLandmarkLighting, lightingUniforms } from './landmark-lighting.js';
import { createTransit } from './transit.js';
import { createParkLife } from './park-life.js';
import { bounds } from './geo.js';
import { loadRoadAttributes, applyRoadAttributes } from './road-attributes.js';
import { loadStreetDetailsData } from './street-details.js';
import { loadBakedCrossings } from './baked-crossings.js';
import { loadHaydenBlock } from './hayden-block.js';
import { loadAllPartialBuildings as loadPartialBuildings } from './additional-city-buildings.js';
import { createSimmonsDetails } from './simmons-details.js';
import { createPointeDetails } from './pointe-details.js';
import { createNinthAvenueDetails } from './ninth-avenue-details.js';
import { prepareInstanceMatrices } from './render-instances.js';
import { createPrinceArchTerrain, loadPrinceArchGround } from './prince-arch-ground.js';
import { loadLandBridgeMeshes } from './land-bridge-meshes.js';
import { readMapData } from './map-data-transport.js';
import { configureStaticBatches } from './static-batches.js';
import { createRegionalHorizon } from './regional-horizon.js';
import { createLoadingProgress } from './loading-progress.js';

const progress = createLoadingProgress(document);
const qualityLevels = ['performance', 'balanced', 'high'];
let renderer,
  quality = 'performance';
try {
  const savedQuality = localStorage.getItem('calgary-quality');
  if (qualityLevels.includes(savedQuality)) quality = savedQuality;
} catch {}
document.body.dataset.quality = quality;
async function init() {
  const start = performance.now();
  const query = new URLSearchParams(location.search);
  const profiler = createPerformanceMonitor({ enabled: query.get('profile') === '1' });
  const frameLabel = document.getElementById('fps');
  frameLabel.hidden = !profiler.enabled;
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const compactCity = import.meta.env.PROD && quality !== 'high';
  const touchDevice =
    matchMedia('(pointer: coarse) and (hover: none)').matches ||
    (profiler.enabled && query.get('touch') === '1');
  const touchGraphics = quality !== 'high' && touchDevice;
  const directRendering = touchGraphics || quality === 'performance';
  const resolution = createMobileResolutionBudget();
  const mobilePerformance = touchGraphics && quality === 'performance';
  const resizeBuffer = () =>
    renderer.setPixelRatio(
      renderPixelRatio(innerWidth, innerHeight, devicePixelRatio, quality) *
        (quality === 'high' ? 1 : resolution.scale),
    );
  await progress(0.05, 'Opening the city atlas');
  const readJSON = async (url, label) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label} could not be loaded (${response.status})`);
    return readMapData(response, url);
  };
  const mapData = readJSON(new URL('../data/calgary.json', import.meta.url), 'Map data');
  const optional = (promise) =>
    promise.then(
      (provider) => ({ provider, error: null }),
      (error) => ({ provider: null, error: error.message }),
    );
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.2, 22000);
  renderer = new THREE.WebGPURenderer({
    antialias: quality !== 'performance',
    powerPreference: 'high-performance',
    forceWebGL: query.get('renderer') === 'webgl',
    reversedDepthBuffer: true,
    trackTimestamp: profiler.enabled && query.get('gpu') === '1',
  });
  const requestedMode = query.get('mode');
  const [
    data,
    placesData,
    treeData,
    surfaceData,
    signalData,
    parkData,
    transitData,
    cityMeshes,
    fallbackBuildings,
    measuredRoofs,
    terrain,
    lightingData,
    roadAttributes,
    streetDetailData,
    bakedCrossings,
    landBridgeSource,
    haydenSource,
    partialSource,
  ] = await Promise.all([
    mapData,
    readJSON(new URL('../data/calgary-places.json', import.meta.url), 'Calgary place data'),
    readJSON(new URL('../data/calgary-trees.json', import.meta.url), 'Calgary public tree data'),
    readJSON(
      new URL('../data/calgary-surfaces.json', import.meta.url),
      'Calgary surveyed sidewalk and paving data',
    ),
    readJSON(new URL('../data/calgary-signals.json', import.meta.url), 'Calgary traffic signal data'),
    readJSON(new URL('../data/calgary-parks.json', import.meta.url), 'Calgary park geometry'),
    readJSON(new URL('../data/calgary-transit.json', import.meta.url), 'Calgary transit data'),
    loadCityMeshes({ core: compactCity }),
    loadFallbackBuildings(),
    loadCanElevationRoofs(),
    Promise.all([
      loadIslandTerrain(),
      loadPrinceArchGround().then(
        (binary) => ({ binary, error: null }),
        (error) => ({ binary: null, error: error.message }),
      ),
      optional(loadNeighbourhoodTerrain()),
    ]).then(([base, local, neighbourhoods]) => {
      if (local.binary) {
        try {
          base = createPrinceArchTerrain(base, local.binary);
        } catch (error) {
          base.stats.princeArchGroundError = error.message;
        }
      } else base.stats.princeArchGroundError = local.error;
      if (neighbourhoods.provider) {
        try {
          return withNeighbourhoodTerrain(base, neighbourhoods.provider);
        } catch (error) {
          base.stats.neighbourhoodError = error.message;
        }
      } else base.stats.neighbourhoodError = neighbourhoods.error;
      return base;
    }),
    loadSurveyedLightingData(),
    loadRoadAttributes(),
    compactCity ? null : loadStreetDetailsData(),
    loadBakedCrossings(),
    optional(loadLandBridgeMeshes()),
    optional(loadHaydenBlock(mapData)),
    optional(loadPartialBuildings(mapData)),
    // Driver initialization can overlap required downloads and JSON decoding.
    renderer.init(),
  ]);
  const haydenBlock = haydenSource.provider,
    haydenBlockError = haydenSource.error,
    partialBuildings = partialSource.provider,
    partialBuildingsError = partialSource.error;
  const roadAttributeStats = applyRoadAttributes(data, roadAttributes);
  const transitOnly = new Set(transitData.transitOnlyRoadIds);
  for (const road of data.roads) if (transitOnly.has(road.id)) road.transitOnly = true;
  data.parks = parkData.mapParks;
  applySiteOverlays(data, siteOverlay);
  profiler.phase('data');
  // Old WebGL devices may not expose EXT_clip_control. Keep their distant
  // streets stable with logarithmic depth instead of the low-precision default.
  if (!renderer.reversedDepthBuffer) renderer.logarithmicDepthBuffer = true;
  renderer.setSize(innerWidth, innerHeight);
  resizeBuffer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = !mobilePerformance;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.getElementById('viewport').append(renderer.domElement);
  const pipeline = createCityPipeline(renderer, scene, camera, quality, { direct: directRendering });
  cityUniforms.uFacadeDetailDistance.value = quality === 'high' ? 600 : 360;
  const sun = new THREE.DirectionalLight(0xffd0a0, 3.1);
  sun.castShadow = !mobilePerformance;
  sun.shadow.mapSize.setScalar(directRendering ? 512 : quality === 'high' ? 2048 : 1024);
  sun.shadow.camera.left = -230;
  sun.shadow.camera.right = 230;
  sun.shadow.camera.top = 230;
  sun.shadow.camera.bottom = -230;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1800;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.7;
  scene.add(sun, sun.target);
  const ambient = new THREE.HemisphereLight(0xc5dae3, 0xb4a387, 2.2);
  scene.add(ambient);
  const citySky = createCitySky(scene, renderer);
  const { sky } = citySky;
  const regionalHorizon = createRegionalHorizon(scene, {
    useMRT: renderer.backend.isWebGPUBackend && !directRendering,
  });
  const envScene = new THREE.Scene(),
    pmrem = new THREE.PMREMGenerator(renderer);
  let environment;
  const sunVector = new THREE.Vector3();
  const sunOffset = new THREE.Vector3(),
    shadowPoint = new THREE.Vector3();
  const updateSun = (x, z) => {
    if (!sun.castShadow) {
      sun.target.position.set(0, 0, 0);
      sun.position.copy(sunVector).multiplyScalar(900);
      return;
    }
    sunOffset.copy(sunVector).multiplyScalar(900);
    sunOffset.y = Math.max(300, sunOffset.y);
    shadowPoint.set(x, 0, z);
    snapShadowTarget(shadowPoint, sunOffset, 460 / sun.shadow.mapSize.x, sun.target.position);
    sun.position.copy(sun.target.position).add(sunOffset);
  };
  const presets = {
    golden: {
      sky: 0xc0d3d4,
      fog: 0xc5ccc0,
      sun: 0xffd1a4,
      intensity: 3.1,
      hemi: 2.1,
      elevation: 24,
      azimuth: 240,
      exposure: 0.85,
      glow: 0.06,
    },
    day: {
      sky: 0xa4cadc,
      fog: 0xc2d4d5,
      sun: 0xfff1dc,
      intensity: 3.8,
      hemi: 2.6,
      elevation: 58,
      azimuth: 210,
      exposure: 0.9,
      glow: 0,
    },
    dusk: {
      sky: 0x566d94,
      fog: 0x877993,
      sun: 0xffb086,
      intensity: 1.4,
      hemi: 1.7,
      elevation: -3,
      azimuth: 258,
      exposure: 0.72,
      glow: 0.8,
    },
    night: {
      sky: 0x223958,
      fog: 0x273957,
      sun: 0xb7d7ff,
      intensity: 1.18,
      hemi: 1.38,
      elevation: -12,
      azimuth: 280,
      exposure: 0.8,
      glow: 1.8,
    },
  };
  let preset = presets.golden,
    timeId = 'golden',
    atmosphere,
    facadeLettering,
    audio;
  const skyTop = new THREE.Color(),
    horizon = new THREE.Color(),
    snowTint = new THREE.Color(0xc6d6e1);
  scene.fog = new THREE.FogExp2();
  const applyEnvironment = () => {
    const weather = atmosphere?.environment || atmosphereSettings();
    citySky.setEnvironment(timeId, weather, sunVector, preset, skyTop, horizon);
    scene.background = skyTop.clone();
    scene.fog.color.copy(horizon);
    scene.fog.density = (timeId === 'night' ? 0.00016 : 0.00011) * weather.fogMultiplier;
    regionalHorizon.setEnvironment(timeId, weather, horizon);
    sun.color.set(preset.sun).lerp(snowTint, weather.temperatureTint * 0.22);
    sun.intensity = preset.intensity * weather.lightMultiplier;
    ambient.color.copy(skyTop).lerp(snowTint, 0.35);
    ambient.groundColor.set(0xb4a387).lerp(snowTint, weather.snow * 0.5);
    ambient.intensity = preset.hemi * weather.ambientMultiplier;
    renderer.toneMappingExposure = preset.exposure;
    windowGlow.value = preset.glow;
    headlightWeather.value =
      weather.kind === 'fog' ? 0.78 : weather.kind === 'rain' ? 0.58 : weather.kind === 'snow' ? 0.36 : 0;
    cityUniforms.uInteriorGlow.value = 0.48 + preset.glow;
    cityUniforms.uSunColor.value.copy(sun.color);
    cityUniforms.uSkyTopColor.value.copy(skyTop);
    cityUniforms.uSkyHorizonColor.value.copy(horizon);
    cityUniforms.uSkySunDir.value.copy(sunVector);
    cityUniforms.uRoadWetness.value = weather.wetness;
    cityUniforms.uSnow.value = weather.snow;
    cityUniforms.uTheme.value = weather.themeMix;
    cityUniforms.uCanyonBounce.value = (timeId === 'night' ? 0.26 : 0.52) * weather.ambientMultiplier;
    citySky.setProbe(true);
    envScene.background = skyTop.clone();
    envScene.add(sky);
    environment = pmrem.fromScene(envScene, 0, 0.1, 100, { renderTarget: environment });
    scene.environment = environment.texture;
    scene.environmentIntensity = (timeId === 'night' ? 0.3 : 0.65) * weather.ambientMultiplier;
    scene.add(sky);
    citySky.setProbe(false);
  };
  const setTime = (id) => {
    if (!Object.hasOwn(presets, id)) return;
    timeId = id;
    preset = presets[id];
    sunVector.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - preset.elevation),
      THREE.MathUtils.degToRad(preset.azimuth),
    );
    applyEnvironment();
    pipeline.setTime(id);
  };
  setTime('golden');
  profiler.phase('rendererAndEnvironment');
  await progress(0.2, 'Tracing the Bow and Elbow');
  const staticBatches = configureStaticBatches(scene, { indirectDraws: renderer.backend.isWebGPUBackend });
  const world = await buildWorld(scene, data, progress, {
    ...placesData,
    touchGraphics,
    trees: treeData.trees,
    buildingCellDraws: renderer.backend.isWebGPUBackend,
    vegetationCellDraws: renderer.backend.isWebGPUBackend && renderer.hasFeature('indirect-first-instance'),
    cityMeshes,
    fallbackBuildings,
    measuredRoofs,
    surfaceData,
    terrain,
    lightingData,
    streetDetailData,
    bakedCrossings,
    haydenBlock,
    haydenBlockError,
    partialBuildings,
    partialBuildingsError,
    landBridgeMeshes: landBridgeSource.provider,
    landBridgeMeshError: landBridgeSource.error,
    signalSites: signalData.sites,
    parkData,
  });
  world.stats.staticBatches = staticBatches.stats;
  profiler.phase('world');
  let actors;
  const transit = createTransit(scene, world, transitData, { traffic: () => actors?.fleet || [] });
  world.transit = transit;
  world.transitOnlyRoadIds = transitOnly;
  world.stats.transit = transit.stats;
  const parkLife = createParkLife(scene, world, { parkData });
  world.parkLife = parkLife;
  world.stats.parkLife = parkLife.stats;
  for (const collider of parkLife.colliders) world.buildingIndex.insert(collider, bounds(collider.ring));
  let ui;
  const nav = createNavigation(
    camera,
    renderer.domElement,
    world,
    (s) => ui?.change(s),
    (s) => ui?.notice(s),
    { persist: query.get('audit') !== '1' },
  );
  transit.update(0, nav.state, camera, quality);
  actors = createActors(scene, world, { touchGraphics });
  world.stats.streetLife = { pedestrians: actors.population, traffic: actors.trafficSimulation.stats };
  await progress(0.79, 'Preparing movement');
  profiler.phase('actorsAndAvatar');
  atmosphere = createAtmosphere(scene, camera, world);
  profiler.phase('atmosphere');
  facadeLettering = createFacadeLettering(scene, world);
  const simmonsDetails = createSimmonsDetails(scene, world, { includeGlass: true });
  const pointeDetails = createPointeDetails(scene, world);
  const ninthAvenueDetails = createNinthAvenueDetails(scene, world);
  const facadeDetails = [simmonsDetails, pointeDetails, ninthAvenueDetails];
  world.stats.simmonsDetails = simmonsDetails.stats;
  world.stats.pointeDetails = pointeDetails.stats;
  world.stats.ninthAvenueDetails = ninthAvenueDetails.stats;
  const facadeCredits = createFacadeCredits();
  facadeCredits.button.addEventListener('click', () => nav.clear());
  const storefronts = createStorefronts(scene, world, placesData.places);
  profiler.phase('storefrontsAndLettering');
  world.businessPlaces = [...facadeLettering.destinations, ...(world.businessPlaces || [])];
  world.stats.storefronts = storefronts.count;
  world.stats.storefrontBinding = storefronts.stats;
  world.stats.storefrontRendering = storefronts.rendering;
  world.stats.referencedFacades = facadeLettering.count;
  world.stats.roadAttributes = roadAttributeStats;
  world.stats.signalSites = world.infrastructure.stats.surveyedSignalSites;
  audio = createCityAudio(
    { world, nav, actors },
    {
      onStateChange: () => ui?.setAudioState(audio),
    },
  );
  profiler.phase('audio');
  const setWeather = (id) => {
    atmosphere.setWeather(id);
    audio.setWeather(id);
    applyEnvironment();
  };
  const setTheme = (id) => {
    atmosphere.setTheme(id);
    audio.setTheme(id);
    facadeLettering.setEnabled(id !== 'tokyo');
    for (const details of facadeDetails) details.setEnabled(id !== 'tokyo');
    facadeLettering.update(camera, quality);
    for (const details of facadeDetails) details.update(camera, quality);
    applyEnvironment();
  };
  const setAudio = async (patch) => {
    if (patch.volume !== undefined) audio.setVolume(Number(patch.volume));
    if (patch.enabled !== undefined) audio.setEnabled(patch.enabled);
    if (audio.enabled) audio.unlock();
    ui?.setAudioState(audio);
  };
  const qualityNeedsReload = (value) =>
    touchDevice ||
    (value === 'high' && compactCity) ||
    (value === 'performance') !== (quality === 'performance');
  const labelQualityOptions = () => {
    for (const option of document.getElementById('quality').options) {
      const label = option.textContent.replace(' (reloads)', '');
      option.textContent =
        option.value !== quality && qualityNeedsReload(option.value) ? `${label} (reloads)` : label;
    }
  };
  const setQuality = (value) => {
    if (!qualityLevels.includes(value) || value === quality) return;
    let saved = false;
    try {
      localStorage.setItem('calgary-quality', value);
      saved = true;
    } catch {}
    if (qualityNeedsReload(value)) {
      if (!saved) {
        document.getElementById('quality').value = quality;
        ui.notice('Allow site storage to change graphics detail');
        return;
      }
      nav.save();
      location.reload();
      return;
    }
    quality = value;
    document.body.dataset.quality = value;
    labelQualityOptions();
    resizeBuffer();
    pipeline.setQuality(value);
    cityUniforms.uFacadeDetailDistance.value = value === 'high' ? 600 : 360;
    // ShadowNode owns this target and resizes it from mapSize each frame.
    // Disposing it here leaves the compiled lighting graph with a dead texture.
    sun.shadow.mapSize.setScalar(directRendering ? 512 : value === 'high' ? 2048 : 1024);
  };
  ui = createUI(nav, world, renderer, setTime, setQuality, camera, {
    forceTouch: profiler.enabled && query.get('touch') === '1',
    setWeather,
    setTheme,
    setAudio,
    audio,
  });
  profiler.phase('hudAndAtlas');
  ui.setAudioState(audio);
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'b' || event.repeat || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (event.target?.closest('input,textarea,select') || ui.isModalOpen() || facadeCredits.dialog.open)
      return;
    audio.honk();
  });
  ui.change(nav.state);
  document.getElementById('quality').value = quality;
  labelQualityOptions();
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) {
    nav.state.tour = false;
    nav.orbit.autoRotate = false;
    ui.change(nav.state);
  }
  if (query.has('lat') && query.has('lon')) {
    const lon = Number(query.get('lon')),
      lat = Number(query.get('lat'));
    if (
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lon >= data.meta.bbox.west &&
      lon <= data.meta.bbox.east &&
      lat >= data.meta.bbox.south &&
      lat <= data.meta.bbox.north
    )
      nav.teleport(lon, lat, undefined, requestedMode || nav.state.mode);
  }
  if (requestedMode) nav.mode(requestedMode);
  const heading = Number(query.get('heading')),
    altitude = Number(query.get('alt'));
  if (query.has('heading') && Number.isFinite(heading) && Math.abs(heading) <= Math.PI * 8)
    nav.setHeading(heading);
  if (
    query.has('alt') &&
    nav.state.mode === 'fly' &&
    Number.isFinite(altitude) &&
    altitude >= 1 &&
    altitude <= 1200
  )
    nav.state.y = altitude;
  if (query.has('view')) nav.setCamera(query.get('view'));
  if (query.has('time')) {
    setTime(query.get('time'));
    ui.setTimeState(query.get('time'));
  }
  // Warm the requested view, including its culling/lighting, before uncovering
  // the scene. A scenic camera previously settled only on the first live frame.
  nav.refreshCamera();
  // The local comparison tools are optional and never enter a production build.
  const auditTools =
    import.meta.env.DEV && query.get('audit') === '1'
      ? await import(/* @vite-ignore */ './audit-camera.js')
      : null;
  const auditCamera = auditTools?.createAuditCamera(camera, nav, world, document.getElementById('viewport'));
  let auditSuspended = false;
  const sendAudit = (type, value) => {
    if (window.parent !== window)
      window.parent.postMessage({ type: auditTools.AUDIT_MESSAGE + type, ...value }, location.origin);
  };
  if (auditCamera) {
    document.documentElement.classList.add('audit-view');
    const { AUDIT_MESSAGE, auditQueryPose } = auditTools;
    const initialPose = auditQueryPose(query, data.meta.bbox);
    if (initialPose) auditCamera.apply(initialPose);
    addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.source !== window.parent || window.parent === window)
        return;
      try {
        if (event.data?.type === AUDIT_MESSAGE + 'pose') {
          const pose = auditCamera.apply(event.data.pose);
          world.update(camera, quality);
          storefronts.update(camera, quality);
          facadeLettering.update(camera, quality);
          for (const details of facadeDetails) details.update(camera, quality);
          updateSun(nav.state.x, nav.state.z);
          sendAudit('pose-applied', { pose, requestId: event.data.requestId });
        } else if (event.data?.type === AUDIT_MESSAGE + 'interact') {
          if (event.data.enabled) auditCamera.release();
          else if (auditCamera.evidence) auditCamera.apply(auditCamera.evidence.requestedPose);
          sendAudit('interaction', { enabled: !auditCamera.active });
        } else if (event.data?.type === AUDIT_MESSAGE + 'visibility') {
          auditSuspended = event.data.visible === false;
        } else if (event.data?.type === AUDIT_MESSAGE + 'capture') {
          staticBatches.beginFrame();
          pipeline.render();
          sendAudit('captured', { dataUrl: renderer.domElement.toDataURL('image/png') });
        }
      } catch (error) {
        sendAudit('error', { message: error.message, requestId: event.data?.requestId });
      }
    });
  }
  transit.update(0, nav.state, camera, quality);
  profiler.phase('uiAndEnrichment');
  const metrics = {
    ready: false,
    startupMs: 0,
    frames: [],
    fps: 0,
    drawCalls: 0,
    triangles: 0,
    renderer: renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2',
    stats: world.stats,
    avatar: actors.player.avatarStats,
    startup: profiler.startup,
    profiling: profiler.enabled,
    antialias: quality === 'performance' ? 'off' : pipeline.antialias || 'MSAA4',
    cityDetail: compactCity ? 'core' : 'full',
    renderPath: directRendering || !renderer.backend.isWebGPUBackend ? 'direct' : 'post',
  };
  // Read-only diagnostics for repeatable interactive performance checks.
  window.calgary = {
    metrics,
    get state() {
      return { ...nav.state };
    },
    get camera() {
      return camera.position.toArray();
    },
    get atmosphere() {
      return { ...atmosphere.state, ...atmosphere.stats };
    },
    get audio() {
      return audio.stats;
    },
    get imagery() {
      return {
        enabled: facadeLettering.enabled,
        matchedFacades: facadeLettering.count,
        active: facadeLettering.activeCount,
      };
    },
  };
  await progress(0.92, 'Preparing the first view');
  world.update(camera, quality);
  storefronts.update(camera, quality);
  facadeLettering.update(camera, quality);
  for (const details of facadeDetails) details.update(camera, quality);
  world.infrastructure.updateSignals(0);
  actors.update(0.016, nav.state, camera, quality);
  atmosphere.update(0, quality, preset.glow / presets.night.glow);
  updateSun(nav.state.x, nav.state.z);
  parkLife.prewarm(camera);
  world.streetDetails?.prewarm(camera, quality);
  world.stats.instanceBuffers = prepareInstanceMatrices(scene, renderer.backend.isWebGPUBackend);
  const fullWarmup = !compactCity && metrics.renderPath === 'post';
  if (fullWarmup) {
    // The light set stays stable, so all travel bodies can warm in one scene pass.
    const warmDirection = camera.getWorldDirection(new THREE.Vector3());
    const warmPosition = camera.position.clone().addScaledVector(warmDirection, 13);
    actors.update(
      0,
      {
        ...nav.state,
        mode: 'cycle',
        x: warmPosition.x,
        z: warmPosition.z,
        y: warmPosition.y - 1,
        heading: Math.atan2(-warmDirection.x, -warmDirection.z),
        grounded: false,
        cameraView: 'chase',
        cameraDistance: 13,
        speed: 0,
        velocityX: 0,
        velocityZ: 0,
        verticalSpeed: 0,
      },
      camera,
      quality,
    );
    const lift = warmPosition.y - 1 - actors.bike.position.y;
    actors.bike.position.y += lift;
    actors.player.updateRide(0, actors.bicycle, { cameraView: 'chase', cameraDistance: 13 });
    actors.heli.visible = actors.playerCar.visible = true;
  }
  // compileAsync uploads even zero-count instanced geometry. Unused tree
  // variants and empty batches must remain outside this warmup.
  const emptyInstances = [];
  scene.traverse((object) => {
    if (object.isInstancedMesh && object.count === 0 && object.visible) {
      emptyInstances.push(object);
      object.visible = false;
    }
  });
  const restoreFacades = fullWarmup ? facadeDetails.map((details) => details.prewarm()) : [];
  try {
    world.stats.shaderWarmup = await pipeline.compile(({ completed, total }) => {
      progress(completed / total, 'Warming movement', true);
    });
  } finally {
    for (const restore of restoreFacades) restore();
    for (const object of emptyInstances) object.visible = true;
  }
  actors.update(0, nav.state, camera, quality);
  parkLife.update(0, 0, camera, quality);
  staticBatches.beginFrame();
  pipeline.render();
  profiler.phase('shaderWarmup');
  progress(1, 'Welcome to Slop Calgary', true);
  metrics.startupMs = Math.round(performance.now() - start);
  metrics.ready = true;
  if (auditCamera) sendAudit('ready', { pose: auditCamera.evidence });
  const loading = document.getElementById('loading');
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 650);
  let last = performance.now(),
    accum = 0,
    frames = 0,
    fps = 60,
    worldTimer = 0,
    facadeUpdatePending = false,
    elapsed = 0,
    gpuTimer = 0,
    resolvingGpu = false;
  renderer.setAnimationLoop(() => {
    const now = performance.now(),
      raw = now - last;
    last = now;
    if (document.hidden || auditSuspended) return;
    staticBatches.beginFrame();
    const cpuStart = profiler.stamp();
    const dt = Math.min(0.05, raw / 1000),
      paused = ui.isModalOpen() || facadeCredits.dialog.open;
    if (!paused) {
      elapsed += dt;
      const stamp = profiler.stamp();
      if (!auditCamera?.active) nav.update(dt, raw / 1000);
      profiler.end('navigation', stamp);
    } else if (!auditCamera?.active && ui.isCameraOpen()) {
      nav.refreshCamera(dt);
    }
    let stamp = profiler.stamp();
    world.infrastructure.updateSignals(elapsed);
    updateLandmarkLighting(elapsed, motionPreference.matches);
    world.developments.update(elapsed, preset.glow / presets.night.glow, camera, quality);
    transit.update(paused ? 0 : dt, nav.state, camera, quality);
    parkLife.update(paused ? 0 : dt, elapsed, camera, quality);
    if (!paused) actors.update(dt, nav.state, camera, quality);
    profiler.end('actorsAndSignals', stamp);
    stamp = profiler.stamp();
    atmosphere.update(dt, quality, preset.glow / presets.night.glow);
    audio.update(dt, elapsed, camera, timeId === 'night');
    profiler.end('atmosphereAndAudio', stamp);
    worldTimer += dt;
    if (!ui.isMapOpen() && worldTimer > 0.3) {
      stamp = profiler.stamp();
      world.update(camera, quality, { deferDetails: true });
      worldTimer = 0;
      facadeUpdatePending = true;
      profiler.end('worldAndDetails', stamp);
    } else if (!ui.isMapOpen() && facadeUpdatePending) {
      stamp = profiler.stamp();
      storefronts.update(camera, quality);
      facadeLettering.update(camera, quality);
      for (const details of facadeDetails) details.update(camera, quality);
      facadeUpdatePending = false;
      profiler.end('facades', stamp);
    } else if (!ui.isMapOpen()) {
      stamp = profiler.stamp();
      world.updateLocalDetails();
      profiler.end('localGeometry', stamp);
    }
    stamp = profiler.stamp();
    updateSun(nav.state.x, nav.state.z);
    if (!ui.isMapOpen()) {
      if (resolution.update(paused || quality === 'high' ? 0 : raw)) resizeBuffer();
      pipeline.render();
    } else {
      resolution.update(0);
    }
    profiler.end('renderSubmission', stamp);
    if (profiler.enabled && renderer.backend.trackTimestamp && !ui.isMapOpen()) {
      gpuTimer += dt;
      if (gpuTimer > 0.25 && !resolvingGpu) {
        gpuTimer = 0;
        resolvingGpu = true;
        renderer
          .resolveTimestampsAsync()
          .then((value) => profiler.add('gpu', value))
          .catch(() => {})
          .finally(() => {
            resolvingGpu = false;
          });
      }
    }
    accum += raw;
    frames++;
    if (accum > 500) {
      fps = (frames * 1000) / accum;
      frames = 0;
      accum = 0;
      metrics.fps = Math.round(fps * 10) / 10;
      metrics.drawCalls = renderer.info.render.drawCalls + staticBatches.stats.indirectDrawCalls;
      metrics.triangles = renderer.info.render.triangles + staticBatches.stats.indirectTriangles;
      metrics.audio = audio.stats;
      metrics.atmosphere = { ...atmosphere.stats };
      metrics.avatar = actors.player.avatarStats;
      metrics.activeFacadeSigns = facadeLettering.activeCount;
      if (profiler.enabled)
        metrics.nightLighting = {
          seconds: Math.round(lightingUniforms.time.value * 10) / 10,
          reducedMotion: motionPreference.matches,
          reconciliation: lightingUniforms.reconciliation.value.getHexString(),
          tower: lightingUniforms.towerA.value.getHexString(),
          brookfield: lightingUniforms.brookfield.value.getHexString(),
        };
      metrics.profile = profiler.snapshot();
      metrics.memory = { ...renderer.info.memory };
      metrics.viewport = {
        width: innerWidth,
        height: innerHeight,
        pixelRatio: renderer.getPixelRatio(),
        bufferWidth: renderer.domElement.width,
        bufferHeight: renderer.domElement.height,
        quality,
      };
      const sorted = metrics.frames.slice(-600).sort((a, b) => a - b);
      const frameMs = {
        median: Math.round((sorted[Math.floor(sorted.length * 0.5)] || 0) * 100) / 100,
        p95: Math.round((sorted[Math.floor(sorted.length * 0.95)] || 0) * 100) / 100,
      };
      if (profiler.enabled) {
        const resources = [
          performance.getEntriesByType('navigation')[0],
          ...performance.getEntriesByType('resource'),
        ].filter((entry) => entry?.name.startsWith(location.origin + '/'));
        const transferred = resources.reduce((sum, entry) => sum + entry.transferSize, 0);
        metrics.network = {
          requests: resources.length,
          transferred,
          encoded: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
          images: resources
            .filter((entry) => entry.initiatorType === 'img')
            .reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        };
        frameLabel.textContent = `${Math.round(fps)} fps · ${frameMs.p95} ms p95`;
        frameLabel.title = `${(metrics.startupMs / 1000).toFixed(1)} s load · ${resources.length} requests · ${(transferred / 1e6).toFixed(1)} MB`;
      }
      if (profiler.enabled || auditCamera)
        document.getElementById('viewport').dataset.diagnostics = JSON.stringify({
          ...metrics,
          frames: undefined,
          frameMs,
          state: nav.state,
          camera: camera.position.toArray(),
        });
      if (auditCamera)
        sendAudit('diagnostics', {
          diagnostics: {
            ready: metrics.ready,
            startupMs: metrics.startupMs,
            renderer: metrics.renderer,
            drawCalls: metrics.drawCalls,
            triangles: metrics.triangles,
            memory: metrics.memory,
            viewport: metrics.viewport,
            frameMs,
            profile: metrics.profile,
            startup: metrics.startup,
            stats: metrics.stats,
            state: nav.state,
            camera: camera.position.toArray(),
          },
        });
    }
    metrics.frames.push(raw);
    if (metrics.frames.length > 1800) metrics.frames.shift();
    stamp = profiler.stamp();
    ui.update(now);
    profiler.end('hud', stamp);
    profiler.end('cpuFrame', cpuStart);
    if (raw < 250) profiler.add('frameInterval', raw);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    resizeBuffer();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    showError('Graphics context was interrupted. Reload to continue exploring.');
  });
}
function showError(message) {
  const loading =
    document.getElementById('loading') ||
    document.body.appendChild(Object.assign(document.createElement('div'), { id: 'loading' }));
  loading.style.opacity = '1';
  loading.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = 'Calgary is taking a detour.';
  const text = document.createElement('p');
  text.textContent = message;
  const retry = document.createElement('button');
  retry.textContent = 'Reload the city';
  retry.style.marginTop = '24px';
  retry.style.padding = '12px 20px';
  retry.style.border = '1px solid currentColor';
  retry.onclick = () => location.reload();
  loading.append(title, text, retry);
}
init().catch((error) => {
  console.error(error);
  showError(
    error.message || 'The city could not start. Try a current browser with hardware acceleration enabled.',
  );
});
