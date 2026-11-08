// Calgary source adapter for the original MIT Slop New York audio graph.
// Spatial identity uses the simulation objects, independently of pooled ordering.
import { bounds } from './geo.js';

const unit = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const seedAt = (index) => (Math.imul(index + 1, 2654435761) >>> 0) / 4294967296;
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

export class NearestSources {
  constructor(limit) {
    this.pool = Array.from({ length: limit }, () => ({}));
    this.items = [];
    this.scores = new Float64Array(limit);
  }
  take(score) {
    if (!Number.isFinite(score)) return null;
    let i = this.items.length,
      item;
    if (i < this.pool.length) item = this.pool[i];
    else {
      if (score >= this.scores[i - 1]) return null;
      item = this.items[--i];
    }
    while (i > 0 && score < this.scores[i - 1]) {
      this.items[i] = this.items[i - 1];
      this.scores[i] = this.scores[i - 1];
      i--;
    }
    this.items[i] = item;
    this.scores[i] = score;
    return item;
  }
}

export function createAudioControllers({ world, nav, actors }) {
  const entities = {
    walk: { type: 'person', mesh: actors.player?.group },
    drive: { type: 'car', mesh: actors.playerCar },
    cycle: { type: 'cyclist', mesh: actors.bike },
    fly: { type: 'helicopter', mesh: actors.heli },
  };
  for (const entity of Object.values(entities)) {
    entity.position = {
      get x() {
        return nav.state.x;
      },
      get y() {
        return nav.state.y;
      },
      get z() {
        return nav.state.z;
      },
    };
    Object.defineProperties(entity, {
      heading: {
        get() {
          return nav.state.heading;
        },
      },
      speed: {
        get() {
          return nav.state.speed;
        },
      },
    });
  }
  const colliders = new WeakMap();
  return {
    entities,
    getActiveEntity() {
      return entities[nav.state.mode] || null;
    },
    setCollisionListener(listener) {
      nav.setCollisionListener?.(listener);
    },
    nearColliders(x, z, radius) {
      const results = [];
      for (const building of world.buildingIndex?.near(x, z, radius) || []) {
        let record = colliders.get(building);
        if (!record) {
          record = {
            ...bounds(building.ring),
            minY: building.minHeight ?? 0,
            maxY: building.height + 0.2,
            polygon: {
              outer: building.ring.map(([px, pz]) => ({ x: px, z: pz })),
              holes: (building.holes || []).map((ring) => ring.map(([px, pz]) => ({ x: px, z: pz }))),
            },
          };
          colliders.set(building, record);
        }
        results.push(record);
      }
      return results;
    },
  };
}

export class CityAudioSources {
  constructor({ world, nav, actors, controllerManager }) {
    this.world = world;
    this.nav = nav;
    this.actors = actors;
    this.controllers = controllerManager;
    this.motors = new NearestSources(10);
    this.sirens = new NearestSources(2);
    this.people = new NearestSources(6);
    this.signals = new NearestSources(2);
    this.snapshot = {
      motors: this.motors.items,
      sirens: this.sirens.items,
      people: this.people.items,
      signals: this.signals.items,
      traffic: 0,
      motion: 0,
    };
    this.lastSpeed = 0;
    this.lastY = 0;
    this.lastTime = null;
    this.lastMode = null;
  }
  activeEntity() {
    return this.controllers.getActiveEntity();
  }
  distanceSq(x, y, z) {
    return (x - this.listener.x) ** 2 + (y - this.listener.y) ** 2 + (z - this.listener.z) ** 2;
  }
  motor(id, kind, x, y, z, speed, load, heading, player, seed, blocked, gain = 1, verticalSpeed = 0) {
    const range = kind === 'helicopter' ? 500 : kind === 'train' ? 240 : 180,
      d2 = this.distanceSq(x, y, z);
    if (!Number.isFinite(d2) || d2 > range * range) return;
    const record = this.motors.take(player ? -1 : kind === 'train' ? d2 * 0.5 : d2);
    if (!record) return;
    Object.assign(record, {
      id,
      kind,
      x,
      y,
      z,
      speed: Math.abs(finite(speed)),
      load: unit(load),
      verticalSpeed: finite(verticalSpeed),
      heading: finite(heading),
      player,
      seed,
      blocked,
      gain,
      range,
    });
  }
  person(id, x, y, z, speed, phase, seed, left, right, player = false, grounded = true) {
    const d2 = this.distanceSq(x, y, z);
    if (!Number.isFinite(d2) || d2 > 45 ** 2 || !left || !right) return;
    const record = this.people.take(player ? -1 : d2);
    if (!record) return;
    Object.assign(record, {
      id,
      x,
      y,
      z,
      speed: Math.abs(finite(speed)),
      phase: finite(phase),
      seed,
      grounded,
      player,
      conversation: player ? null : id.conversation || null,
      leftX: left[0],
      leftY: left[1],
      leftZ: left[2],
      rightX: right[0],
      rightY: right[1],
      rightZ: right[2],
    });
  }
  collect(listener, elapsed) {
    this.listener = listener;
    this.motors.items.length =
      this.sirens.items.length =
      this.people.items.length =
      this.signals.items.length =
        0;
    this.snapshot.traffic = 0;
    const state = this.nav.state,
      mode = state.mode,
      active = this.activeEntity();
    const dt = this.lastTime === null ? 0.1 : Math.max(0.02, Math.min(0.5, elapsed - this.lastTime));
    const sameMode = mode === this.lastMode;
    const acceleration = sameMode ? (Math.abs(state.speed) - this.lastSpeed) / dt : 0;
    const verticalSpeed =
      sameMode && mode === 'fly' ? Math.max(-40, Math.min(40, (state.y - this.lastY) / dt)) : 0;
    this.lastSpeed = Math.abs(finite(state.speed));
    this.lastY = finite(state.y);
    this.lastTime = elapsed;
    this.lastMode = mode;
    this.snapshot.motion = mode === 'orbit' ? 0 : Math.hypot(finite(state.speed), verticalSpeed);
    const player = this.actors.player?.rig;
    if (mode === 'walk' && player?.placed && active) {
      const [left, right] = player.feet;
      this.person(
        active,
        state.x,
        state.y,
        state.z,
        player.speed,
        player.phase,
        player.seed,
        [left.px, left.py, left.pz],
        [right.px, right.py, right.pz],
        true,
        state.grounded !== false,
      );
    } else if (active && ['drive', 'cycle', 'fly'].includes(mode)) {
      const kind = mode === 'drive' ? 'sports' : mode === 'cycle' ? 'cyclist' : 'helicopter';
      const throttle = Number.isFinite(state.throttle)
        ? Math.max(0, state.throttle)
        : acceleration > -0.5
          ? 1
          : 0;
      const load =
        mode === 'fly'
          ? unit(0.45 + verticalSpeed * 0.015 + Math.abs(state.speed) / 180)
          : mode === 'cycle'
            ? unit(throttle * (0.3 + Math.abs(state.speed) / 22))
            : unit(
                acceleration / 6 +
                  unit(Math.abs(state.speed) / 3) * (0.15 + 0.25 * unit(Math.abs(state.speed) / 30) ** 2),
              );
      this.motor(
        active,
        kind,
        state.x,
        state.y + (mode === 'fly' ? 2.66 : 0.6),
        state.z,
        state.speed,
        load,
        state.heading,
        true,
        0.65,
        false,
        1,
        verticalSpeed,
      );
    }
    const fleet = this.actors.fleet || [];
    for (let index = 0; index < fleet.length; index++) {
      const car = fleet[index],
        edge = car.edge;
      if (!edge) continue;
      const offset = edge.road?.oneway && edge.road.oneway !== 'no' ? 0 : 1.8;
      const x = Number.isFinite(car.x)
        ? car.x
        : edge.a[0] + (edge.b[0] - edge.a[0]) * car.t + Math.cos(edge.heading) * offset;
      const z = Number.isFinite(car.z)
        ? car.z
        : edge.a[1] + (edge.b[1] - edge.a[1]) * car.t - Math.sin(edge.heading) * offset;
      if ((x - listener.x) ** 2 + (z - listener.z) ** 2 > 180 ** 2) continue;
      const ground = this.world.surfaceHeight?.(x, z, edge.road) ?? this.world.groundHeight(x, z);
      const y = finite(ground) + 0.7,
        d2 = this.distanceSq(x, y, z);
      if (!Number.isFinite(d2) || d2 > 180 ** 2) continue;
      this.snapshot.traffic += (1 - d2 / 180 ** 2) * (0.2 + 0.8 * unit(Math.abs(car.speed) / 12));
      const load = unit(finite(car.acceleration ?? car.acc) / 4 + unit(Math.abs(car.speed) / 3) * 0.3);
      const kind = ['sedan', 'suv', 'bus'].includes(car.engine)
        ? car.engine
        : index % 7 === 0
          ? 'suv'
          : 'sedan';
      this.motor(
        car,
        kind,
        x,
        y,
        z,
        car.speed,
        load,
        finite(car.heading, edge.heading),
        false,
        seedAt(index + 100),
        !!car.blocked,
        0.85,
      );
    }
    this.snapshot.traffic = unit(this.snapshot.traffic / 12);
    for (const [index, train] of (this.world.transit?.trains || []).entries()) {
      if (!train.sections?.length) continue;
      this.motor(
        train,
        'train',
        train.x,
        train.y + 1.3,
        train.z,
        train.speed,
        train.dwell > 0 ? 0 : 0.65,
        train.heading,
        false,
        seedAt(index + 1000),
        false,
        1.05,
      );
    }
    for (const pedestrian of this.actors.crowd || []) {
      const rig = pedestrian.rig;
      if (!rig?.placed || this.distanceSq(rig.x, 0, rig.z) > 45 ** 2) continue;
      const left = rig.feet[0],
        right = rig.feet[1];
      this.person(
        pedestrian,
        rig.x,
        this.world.groundHeight(rig.x, rig.z),
        rig.z,
        rig.speed,
        rig.phase,
        rig.seed,
        [left.px, left.py, left.pz],
        [right.px, right.py, right.pz],
      );
    }
    const infrastructure = this.world.infrastructure,
      signalTime = infrastructure?.signalTime ?? elapsed;
    for (const signal of infrastructure?.signals || []) {
      if (!signal.citySites?.some((site) => site.accessible) && !signal.citySite?.accessible) continue;
      const x = signal.poleX ?? signal.x,
        z = signal.poleZ ?? signal.z;
      const y = finite(signal.y) + 1.4,
        d2 = this.distanceSq(x, y, z);
      if (!Number.isFinite(d2) || d2 > 25 ** 2) continue;
      const record = this.signals.take(d2);
      if (!record) continue;
      Object.assign(record, {
        id: signal,
        x,
        y,
        z,
        seed: signal.seed,
        walk: infrastructure.signalPhase(signalTime, 1 - signal.axis, signal.seed) === 'green',
      });
    }
    return this.snapshot;
  }
}
