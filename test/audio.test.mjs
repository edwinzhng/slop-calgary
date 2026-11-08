import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSynthResources, createMotorVoice } from '../app/audio-synthesis.js';
import { createEventResources } from '../app/audio-events.js';
import { createCityAudio } from '../app/audio-system.js';
import { NearestSources, createAudioControllers, CityAudioSources } from '../app/audio-sources.js';
import { CityAcoustics } from '../app/audio-acoustics.js';
import { createCivilianPlayer } from '../app/civilian-player.js';

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.automationRate = 'a-rate';
  }
  setValueAtTime(value) {
    assert.ok(Number.isFinite(value));
    this.value = value;
    return this;
  }
  setTargetAtTime(value) {
    return this.setValueAtTime(value);
  }
  linearRampToValueAtTime(value) {
    return this.setValueAtTime(value);
  }
  exponentialRampToValueAtTime(value) {
    return this.setValueAtTime(value);
  }
  cancelScheduledValues() {
    return this;
  }
}
class FakeNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.connections = new Set();
    this.disconnected = false;
    for (const name of [
      'gain',
      'frequency',
      'detune',
      'Q',
      'playbackRate',
      'pan',
      'threshold',
      'knee',
      'ratio',
      'attack',
      'release',
      'positionX',
      'positionY',
      'positionZ',
      'orientationX',
      'orientationY',
      'orientationZ',
    ])
      this[name] = new FakeParam(name === 'playbackRate' ? 1 : 0);
    this.coneOuterAngle = 360;
    context.nodes.push(this);
  }
  connect(node) {
    this.connections.add(node);
    this.disconnected = false;
    return node;
  }
  disconnect() {
    this.connections.clear();
    this.disconnected = true;
  }
  setPeriodicWave(wave) {
    this.wave = wave;
  }
  start(when = 0) {
    this.started = true;
    this.startTime = when;
    this.context.started.push(this);
  }
  stop(when = this.context.currentTime) {
    this.endTime = when;
    if (when <= this.context.currentTime) this.finish();
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    this.onended?.();
  }
}
class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = Math.ceil(length);
    this.sampleRate = sampleRate;
    this.duration = this.length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(this.length));
  }
  getChannelData(channel) {
    return this.channels[channel];
  }
}
class FakeContext {
  static created = [];
  constructor() {
    this.sampleRate = 16000;
    this.currentTime = 0;
    this.state = 'suspended';
    this.nodes = [];
    this.buffers = [];
    this.started = [];
    this.destination = new FakeNode(this, 'destination');
    this.listener = {};
    for (const name of [
      'positionX',
      'positionY',
      'positionZ',
      'forwardX',
      'forwardY',
      'forwardZ',
      'upX',
      'upY',
      'upZ',
    ])
      this.listener[name] = new FakeParam();
    FakeContext.created.push(this);
  }
  createBuffer(channels, length, sampleRate) {
    const buffer = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }
  createPeriodicWave(real, imaginary) {
    return { real, imaginary };
  }
  createGain() {
    return new FakeNode(this, 'gain');
  }
  createBiquadFilter() {
    return new FakeNode(this, 'filter');
  }
  createBufferSource() {
    return new FakeNode(this, 'buffer-source');
  }
  createOscillator() {
    return new FakeNode(this, 'oscillator');
  }
  createPanner() {
    return new FakeNode(this, 'panner');
  }
  createStereoPanner() {
    return new FakeNode(this, 'stereo-panner');
  }
  createConvolver() {
    return new FakeNode(this, 'convolver');
  }
  createDynamicsCompressor() {
    return new FakeNode(this, 'compressor');
  }
  resume() {
    this.state = 'running';
    this.onstatechange?.();
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    this.onstatechange?.();
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    for (const node of this.started) node.finish();
    this.onstatechange?.();
    return Promise.resolve();
  }
  advance(dt) {
    this.currentTime += dt;
    for (const node of this.started) if (node.endTime <= this.currentTime) node.finish();
  }
}

function environment() {
  const old = new Map(
    ['document', 'localStorage', 'AudioContext', 'matchMedia', 'navigator'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const listeners = new Map(),
    storage = new Map();
  const document = {
    hidden: false,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document },
    localStorage: {
      configurable: true,
      value: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    },
    AudioContext: { configurable: true, value: FakeContext },
    matchMedia: { configurable: true, value: () => ({ matches: false }) },
    navigator: { configurable: true, value: { hardwareConcurrency: 8, userActivation: { isActive: false } } },
  });
  return {
    document,
    listeners,
    storage,
    dispatch(type, extra = {}) {
      for (const handler of listeners.get(type) || [])
        handler({ type, isTrusted: true, target: { tagName: 'CANVAS' }, ...extra });
    },
    restore() {
      for (const [key, descriptor] of old)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    },
  };
}
function simulation(mode = 'drive') {
  const nav = {
    state: { mode, x: 0, y: 0.2, z: 0, speed: mode === 'walk' ? 4.2 : 8, heading: 0, cameraDistance: 5 },
  };
  const fleet = Array.from({ length: 120 }, (_, i) => ({
    edge: { a: [i - 60, -20], b: [i - 60, 40], heading: 0, road: { oneway: 'yes' } },
    t: 0.3,
    speed: 7,
  }));
  const player = createCivilianPlayer();
  player.updateWalk(1 / 60, nav.state, () => 0.2);
  const actors = {
    player,
    playerCar: new THREE.Group(),
    bike: new THREE.Group(),
    heli: new THREE.Group(),
    fleet,
    crowd: [],
  };
  const world = {
    buildingIndex: { near: () => [] },
    groundHeight: () => 0.2,
    surfaceHeight: () => 0.2,
    infrastructure: { signals: [] },
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 2.5, -5);
  camera.lookAt(0, 1.3, 0);
  camera.updateMatrixWorld(true);
  return { world, nav, actors, camera };
}

test('the original synthesis produces finite, nonclipped engine/rotor/chain/footstep/horn buffers', () => {
  const context = new FakeContext(),
    resources = createEventResources(context, createSynthResources(context));
  assert.ok(resources.combustion.suv.exhaust && resources.rotor && resources.chain && resources.ratchet);
  assert.equal(resources.footsteps.length, 8);
  assert.equal(resources.horns.length, 3);
  assert.equal(resources.impulse.numberOfChannels, 2);
  let total = 0;
  for (const buffer of context.buffers)
    for (const samples of buffer.channels) {
      let energy = 0,
        peak = 0;
      for (const value of samples) {
        assert.ok(Number.isFinite(value));
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      assert.ok(peak <= 1.000001, `peak ${peak}`);
      assert.ok(energy > 0, 'each generated resource contains sound');
      total += samples.length;
    }
  assert.ok(total > 1_000_000);
  assert.notDeepEqual(resources.footsteps[0].getChannelData(0), resources.footsteps[1].getChannelData(0));
});

test('upstream motor voices update without growing the graph and disconnect on disposal', () => {
  const context = new FakeContext(),
    resources = createSynthResources(context),
    output = context.createGain();
  for (const kind of ['sedan', 'suv', 'sports', 'bus', 'train', 'cyclist', 'helicopter', 'siren']) {
    const voice = createMotorVoice(context, resources, kind, output),
      nodeCount = context.nodes.length;
    for (let i = 0; i < 120; i++)
      voice.update({ speed: i % 30, load: (i % 10) / 10, verticalSpeed: 3, doppler: 1.05, seed: 4 }, i / 10);
    assert.equal(context.nodes.length, nodeCount);
    const ownSources = context.started.filter((node) => !node.ended);
    voice.dispose();
    assert.ok(ownSources.every((node) => node.ended && node.disconnected));
  }
});

test('nearest source pooling stays bounded and follows stable simulation identities', () => {
  const pool = new NearestSources(3);
  for (const score of [10, 8, 6, 4, 2, 20]) {
    const item = pool.take(score);
    if (item) item.score = score;
  }
  assert.deepEqual(
    pool.items.map((item) => item.score),
    [2, 4, 6],
  );
  assert.equal(new Set(pool.items).size, 3);
  const sim = simulation();
  const controllerManager = createAudioControllers(sim);
  const sources = new CityAudioSources({ ...sim, controllerManager });
  const first = sources.collect({ x: 0, y: 2, z: 0 }, 0);
  assert.equal(first.motors.length, 10);
  assert.equal(first.motors[0].player, true);
  const identity = first.motors[0].id;
  sources.collect({ x: 10, y: 2, z: 0 }, 0.1);
  assert.equal(sources.snapshot.motors[0].id, identity);
  assert.equal(first.sirens.length, 0, 'normal Calgary traffic does not invent police sirens');
  sim.actors.player.dispose();
});

test('acoustic obstruction uses real Calgary polygon height and courtyard holes', () => {
  const ring = [
    [-2, -5],
    [2, -5],
    [2, 5],
    [-2, 5],
    [-2, -5],
  ];
  const world = { buildingIndex: { near: () => [{ ring, height: 12 }] } };
  const controllers = createAudioControllers({ world, nav: { state: {} }, actors: {} });
  const acoustics = new CityAcoustics(controllers),
    listener = { x: -10, y: 1.7, z: 0 };
  acoustics.update(listener, 0);
  assert.ok(acoustics.obstruction({ x: 10, y: 1.7, z: 0 }, listener) > 0.7);
  assert.equal(acoustics.obstruction({ x: -8, y: 1.7, z: 0 }, listener), 0);
  assert.equal(acoustics.obstruction({ x: 10, y: 30, z: 0 }, { x: -10, y: 30, z: 0 }), 0);
  const outer = [
    [-3, -5],
    [3, -5],
    [3, 5],
    [-3, 5],
    [-3, -5],
  ];
  const hole = [
    [-2.6, -4],
    [2.6, -4],
    [2.6, 4],
    [-2.6, 4],
    [-2.6, -4],
  ];
  const courtyardControllers = createAudioControllers({
    world: { buildingIndex: { near: () => [{ ring: outer, holes: [hole], height: 12 }] } },
    nav: { state: {} },
    actors: {},
  });
  const courtyard = new CityAcoustics(courtyardControllers);
  courtyard.update(listener, 0);
  const throughCourtyard = courtyard.obstruction({ x: 10, y: 1.7, z: 0 }, listener);
  assert.ok(throughCourtyard > 0.2 && throughCourtyard < 0.5, `thin courtyard walls: ${throughCourtyard}`);
});

test('first-person footsteps remain present even when the rendered character is hidden', () => {
  const sim = simulation('walk');
  sim.nav.state.cameraView = 'first';
  sim.actors.player.updateWalk(1 / 60, sim.nav.state, sim.world.groundHeight);
  assert.equal(sim.actors.player.group.visible, false);
  const controllerManager = createAudioControllers(sim);
  const sources = new CityAudioSources({ ...sim, controllerManager });
  const snapshot = sources.collect({ x: 0, y: 1.7, z: 0 }, 0);
  assert.equal(snapshot.people.length, 1);
  assert.equal(snapshot.people[0].player, true);
  assert.ok(
    [snapshot.people[0].leftX, snapshot.people[0].leftY, snapshot.people[0].leftZ].every(Number.isFinite),
  );
  sources.collect({ x: 0, y: 850, z: 0 }, 1);
  assert.equal(
    sources.snapshot.motors.length,
    0,
    'ground engines fall out of range from a high skyline camera',
  );
  sim.actors.player.dispose();
});

test('illustrative pedestrian signal ticks require a surveyed accessible-signal flag', () => {
  const sim = simulation(),
    controllerManager = createAudioControllers(sim);
  sim.world.infrastructure = {
    signalTime: 4,
    signalPhase: () => 'green',
    signals: [
      { x: 2, z: 0, axis: 0, seed: 1, citySite: { accessible: false } },
      { x: 4, z: 0, axis: 1, seed: 2, citySite: { accessible: true } },
      {
        x: 6,
        z: 0,
        axis: 0,
        seed: 3,
        citySite: { accessible: false },
        citySites: [{ accessible: false }, { accessible: true }],
      },
    ],
  };
  const sources = new CityAudioSources({ ...sim, controllerManager }),
    snapshot = sources.collect({ x: 0, y: 1.7, z: 0 }, 4);
  assert.deepEqual(
    snapshot.signals.map((source) => source.seed),
    [2, 3],
  );
  assert.ok(snapshot.signals.every((source) => source.walk));
  sim.actors.player.dispose();
});

test('unsupported Web Audio remains a harmless disabled capability', () => {
  const env = environment(),
    sim = simulation();
  try {
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: undefined });
    const audio = createCityAudio(sim);
    assert.equal(audio.supported, false);
    env.dispatch('pointerdown');
    audio.setEnabled(true);
    audio.update(1, 1, sim.camera);
    assert.equal(audio.context, null);
    assert.equal(audio.honk(), false);
    audio.dispose();
  } finally {
    sim.actors.player.dispose();
    env.restore();
  }
});

test('audio remains dormant without a trusted gesture, then pools voices, mutes and disposes cleanly', async () => {
  const env = environment(),
    sim = simulation();
  try {
    const audio = createCityAudio(sim);
    assert.equal(audio.context, null);
    audio.setEnabled(true);
    env.dispatch('pointerdown', { isTrusted: false });
    assert.equal(audio.context, null);
    env.dispatch('pointerdown');
    await Promise.resolve();
    assert.equal(audio.context.state, 'running');
    for (let i = 0; i < 200; i++) {
      audio.context.advance(0.1);
      audio.update(0.1, i / 10, sim.camera);
    }
    assert.ok(audio.stats.motors > 0 && audio.stats.motors <= audio.stats.limits.motors);
    assert.equal(audio.stats.sharedReverbs, 1);
    assert.equal(audio.context.nodes.filter((node) => node.kind === 'convolver').length, 1);
    audio.setVolume(0.27);
    audio.context.advance(0.1);
    audio.update(0.1, 20.1, sim.camera);
    assert.equal(audio.volume, 0.27);
    assert.equal(audio.stats.volume, 0.27);
    assert.equal(env.storage.get('calgary-volume'), '0.27');
    assert.equal(audio.master.gain.value, 0.27);
    assert.equal(audio.honk(), true);
    assert.equal(audio.honk(), false, 'held horn is rate-limited');
    audio.setWeather('rain');
    audio.context.advance(0.1);
    audio.update(0.1, 21, sim.camera, true);
    assert.equal(audio.stats.weather, 'rain');
    audio.setEnabled(false);
    await Promise.resolve();
    assert.equal(audio.context.state, 'suspended');
    assert.equal(audio.stats.motors, 0);
    assert.equal(audio.stats.events, 0);
    assert.equal(env.storage.get('calgary-sound'), 'off');
    audio.dispose();
    audio.dispose();
    assert.equal(audio.context.state, 'closed');
    assert.equal(audio.resources, null);
    assert.equal(
      [...env.listeners.values()].reduce((n, list) => n + list.size, 0),
      0,
    );
    assert.ok(
      audio.context.nodes
        .filter((node) => node.kind !== 'destination')
        .every((node) => node.connections.size === 0),
    );
  } finally {
    sim.actors.player.dispose();
    env.restore();
  }
});

test('footsteps follow the civilian gait and hidden pages suspend without queued events', async () => {
  const env = environment(),
    sim = simulation('walk');
  sim.actors.fleet.length = 0;
  try {
    const audio = createCityAudio(sim);
    env.dispatch('keydown');
    await Promise.resolve();
    for (let frame = 0; frame < 240; frame++) {
      sim.nav.state.z += sim.nav.state.speed / 60;
      sim.actors.player.updateWalk(1 / 60, sim.nav.state, sim.world.groundHeight);
      sim.camera.position.z = sim.nav.state.z - 5;
      audio.context.advance(1 / 60);
      audio.update(1 / 60, frame / 60, sim.camera);
    }
    const footBuffers = new Set(audio.resources.footsteps);
    assert.ok(audio.context.started.filter((node) => footBuffers.has(node.buffer)).length >= 8);
    env.document.hidden = true;
    env.dispatch('visibilitychange');
    await Promise.resolve();
    assert.equal(audio.context.state, 'suspended');
    assert.equal(audio.events.length, 0);
    audio.update(1, 10, sim.camera);
    assert.equal(audio.events.length, 0);
    audio.dispose();
  } finally {
    sim.actors.player.dispose();
    env.restore();
  }
});
