import * as THREE from 'three/webgpu';
import { color, float, length, smoothstep, uv } from 'three/tsl';
import { createTravelHelicopter } from './travel-helicopter.js';
import { PersonRig, PersonCrowd } from '../js/pedestrians.js';
import { DRIVABLE, makeRoadGraph, roadWidth, seeded } from './geo.js';
import { headlightWeather, windowGlow } from './city-uniforms.js';
import { updateVehicleHeadlightWash, vehicleHeadlightLevel } from './street-light-wash.js';
import { createPlayerBicycle } from './player-bicycle.js';
import { createCivilianPlayer } from './civilian-player.js';
import { createTrafficSimulation, TRAFFIC_LIMITS, TRAFFIC_PAINTS } from './traffic.js';
import { createPlayerCar } from './player-car.js';
import { fitVehicleGround } from './movement-collision.js';
import { createActorFootFloor } from './actor-foot-floor.js';
import { createCarInstances } from './car-instances.js';
import { createCityBuses } from './transit-bus.js';
import { createVehicleSparks } from './vehicle-sparks.js';

export function createActors(scene, world, { player = createCivilianPlayer(), touchGraphics = false } = {}) {
  const rng = seeded(53),
    graph = makeRoadGraph(world.data.roads, world.allowsTunnel);
  const sportsCar = createPlayerCar(),
    playerCar = sportsCar.group,
    carPose = { y: 0, pitch: 0, roll: 0 };
  playerCar.castShadow = true;
  scene.add(playerCar);
  const helicopter = createTravelHelicopter(),
    heli = helicopter.group;
  scene.add(heli);
  const people = new PersonCrowd(touchGraphics ? 54 : 72, { castShadow: false });
  scene.add(...people.meshes);
  const bicycle = createPlayerBicycle(),
    bike = bicycle.group;
  scene.add(player.group, bike);
  // Keep the light set stable when the car body is hidden. Removing its
  // spotlights makes the renderer rebuild city shaders on each mode change.
  const headlights = new THREE.Group(),
    headlamps = [];
  scene.add(headlights);
  for (const side of touchGraphics ? [] : [-1, 1]) {
    const light = new THREE.SpotLight(0xffe6c1, 0, 65, Math.PI / 5, 0.65, 1.5);
    light.position.set(side * 0.64, 0.635, 2.28);
    light.target.position.set(side * 0.7, 0.15, 24);
    headlights.add(light, light.target);
    headlamps.push(light);
  }
  const traffic = createCarInstances(scene, {
    name: 'Calgary traffic',
    capacity: touchGraphics ? 44 : TRAFFIC_LIMITS.highVisible,
    castShadow: false,
    receiveShadow: false,
  });
  const buses = createCityBuses(scene);
  const sparks = createVehicleSparks(scene);
  world.vehicleImpact = sparks.emit;
  const trafficSimulation = createTrafficSimulation(
      world,
      graph,
      rng,
      touchGraphics ? 132 : TRAFFIC_LIMITS.fleet,
    ),
    fleet = trafficSimulation.fleet;
  for (const car of fleet) car.color = new THREE.Color(TRAFFIC_PAINTS[car.paintIndex]);
  // Navigation queries and resolves the same bodies that the fleet simulation
  // moves. The hooks are installed after collision-checked initial placement.
  world.trafficBlocked = trafficSimulation.blocked;
  world.resolveTrafficMovement = trafficSimulation.resolvePlayer;
  function inCarriageway(x, z) {
    for (const { a, b, road, width } of world.roadIndex.index.near(x, z, 21)) {
      if (
        !DRIVABLE.has(road.kind) ||
        road.transitOnly ||
        road.bridge ||
        road.sourceTags?.service === 'driveway'
      )
        continue;
      const dx = b[0] - a[0],
        dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
      if ((x - a[0] - dx * t) ** 2 + (z - a[1] - dz * t) ** 2 < (width / 2 + 0.21) ** 2) return true;
    }
    return false;
  }
  function pedestrianSpace(x, z) {
    const paving = world.groundSurfaces;
    return (
      !inCarriageway(x, z) &&
      !world.inWater?.(x, z) &&
      (paving.groundHeight(x, z, 'Curb Gutter Sidewalk') != null ||
        paving.groundHeight(x, z, 'Pathways') != null ||
        world.parks?.groundHeight(x, z, true) != null)
    );
  }
  const walkers = Array.from({ length: touchGraphics ? 21 : 30 }, () => {
    const rig = new PersonRig({ seed: rng(), female: rng() > 0.5, scale: 0.95 + rng() * 0.1 });
    return { rig, speed: 0.85 + rng() * 0.6, direction: rng() > 0.5 ? 1 : -1, active: false };
  });
  const crowd = [...walkers];
  // Fictional neighbors and visitors, placed clear of entrances and paths.
  // A mix of ordinary layers is used across all neighborhoods.
  const gathering = [
    [1318.3, -345.6, 0.6],
    [1319.6, -344.6, -2.35],
    [1300, -325.8, 1.7],
    [1301.4, -325.9, -1.55],
    [1520.6, -278.3, -0.7],
    [1519.3, -277.1, 2.4],
    [1554.2, -256.5, 1.7],
    [1555.9, -256.8, -1.4],
    [-1138, -732.1, 1.1],
    [-1136.6, -731.5, -1.95],
    [211, 3.1, 1.4],
    [212.3, 3.6, -1.55],
    [-614, 872.2, 2.4],
    [-612.9, 871.2, -0.7],
    [-673.4, 876.4, 1.57, 4.2],
    [-661.5, 894.1, -1.57, 3.0],
    [-643.9, 895.2, -1.4],
    // Short sidewalk walks and conversations around existing storefronts.
    [-1190.9, -739.4, 0.3, 4.6],
    [-1193.1, -738.8, 2.2],
    [-1165.1, -752.2, 0.4, 3.5],
    [-1163.4, -752.6, -1.7],
    [-256.1, 878.1, 1.5, 7.5],
    [-250.2, 878.6, -1.55],
    [-247.9, 878.4, 1.55],
    [-272.7, 879.1, 1.1, 5.2],
    [-324.7, 895.2, -1.55, 6.5],
    [-341.3, 894.8, 1.55],
    [2499, 425.7, -2.2, 5.0],
    [2496.5, 424.4, 1.1],
    [2581.5, 488.4, -1.0, 4.2],
    [2579.7, 487.6, 1.2],
  ]
    .map(([x, z, heading, walkSpan], i) => {
      const y = world.groundHeight(x, z, 0.2);
      return {
        x,
        z,
        y,
        heading,
        walkSpan,
        walkClock: i * 0.9,
        idle: true,
        avoid: 0,
        active: false,
        rig: new PersonRig({
          seed: rng(),
          female: rng() > 0.5,
          hoodie: i % 3 !== 2,
          scale: 0.89 + rng() * 0.18,
          girth: 0.91 + rng() * 0.21,
          hair: i % 3 === 2 ? 0.6 : 0.3,
        }),
      };
    })
    .filter((p) => !inCarriageway(p.x, p.z) && !world.collision(p.x, p.z, 0.28, p.y));
  crowd.push(...gathering);
  const look = new THREE.Vector3();
  const population = { walkers: 0 };
  let populationTimer = Infinity,
    populationX = NaN,
    populationZ = NaN;
  function populate(state, camera, radius) {
    const { x, z } = state;
    const initial = !Number.isFinite(populationX) || Math.hypot(x - populationX, z - populationZ) > 140;
    if (!initial && populationTimer < 1.5) return;
    populationX = x;
    populationZ = z;
    populationTimer = 0;
    camera.getWorldDirection(look);
    trafficSimulation.populate({ x, z, lookX: look.x, lookZ: look.z, initial }, touchGraphics ? 7 : 10);
    const edges = [...trafficSimulation.spawnIndex.near(x, z, radius)].filter(
      (edge) => edge.length > 11 && !edge.road.bridge && !/motorway|trunk/.test(edge.road.kind),
    );
    if (!edges.length) return;
    for (const walker of walkers) {
      if (walker.edge && Math.hypot(walker.px - x, walker.pz - z) < radius + 25) continue;
      for (let attempt = 0; attempt < 26; attempt++) {
        const edge = edges[Math.floor(rng() * edges.length)];
        const t = 0.24 + rng() * 0.52;
        const offset = (roadWidth(edge.road) / 2 + 0.55 + rng() * 2.8) * (rng() < 0.5 ? -1 : 1);
        const ox = -Math.cos(edge.heading) * offset,
          oz = Math.sin(edge.heading) * offset;
        const px = edge.a[0] + (edge.b[0] - edge.a[0]) * t + ox;
        const pz = edge.a[1] + (edge.b[1] - edge.a[1]) * t + oz;
        const dx = px - x,
          dz = pz - z,
          distance = Math.hypot(dx, dz);
        if (
          distance < (initial ? 12 : 37) ||
          distance > radius - 6 ||
          (!initial && distance < radius - 20 && dx * look.x + dz * look.z > distance * 0.42) ||
          walkers.some(
            (other) => other !== walker && other.edge && Math.hypot(other.px - px, other.pz - pz) < 7,
          )
        )
          continue;
        const span = Math.min(0.22, 8 / edge.length);
        const low = t - span,
          high = t + span;
        const clear = [low, (low + t) / 2, t, (high + t) / 2, high].every((u) => {
          const sx = edge.a[0] + (edge.b[0] - edge.a[0]) * u + ox;
          const sz = edge.a[1] + (edge.b[1] - edge.a[1]) * u + oz;
          return pedestrianSpace(sx, sz) && !world.collision(sx, sz, 0.35, world.groundHeight(sx, sz));
        });
        if (!clear) continue;
        walker.rig.placed = false;
        Object.assign(walker, { edge, offset, t, low, high, px, pz, avoid: 0 });
        break;
      }
    }
  }
  world.pedestrianBlocked = (position, body) => {
    if (body.mode !== 'drive' && body.mode !== 'cycle') return false;
    for (const p of crowd) {
      if (!p.active || position.y >= p.y + 1.75 || position.y + body.top <= p.y) continue;
      const dx = p.px - position.x,
        dz = p.pz - position.z;
      if (Math.abs(dx) > body.extX + 0.27 || Math.abs(dz) > body.extZ + 0.27) continue;
      if (body.car) {
        const u = Math.max(0, Math.abs(dx * body.cos - dz * body.sin) - body.hx);
        const v = Math.max(0, Math.abs(dx * body.sin + dz * body.cos) - body.hz);
        if (u * u + v * v < 0.27 ** 2) return true;
      } else if (dx * dx + dz * dz < (body.radius + 0.27) ** 2) return true;
    }
    return false;
  };
  const dummy = new THREE.Object3D();
  const contactShadow = (() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.colorNode = color(0x24313c);
    material.opacityNode = float(1)
      .sub(smoothstep(0.08, 0.5, length(uv().sub(0.5))))
      .mul(0.41);
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), material);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  })();
  return {
    playerCar,
    sportsCar,
    heli,
    bike,
    player,
    bicycle,
    fleet,
    trafficSimulation,
    crowd,
    population,
    audioSources: { player, bicycle, fleet, crowd },
    graph,
    update(dt, state, camera, quality) {
      sparks.update(dt);
      const { x, z, y, heading, mode } = state;
      playerCar.visible = mode === 'drive';
      bike.visible = mode === 'cycle';
      if (playerCar.visible) {
        fitVehicleGround(world.groundHeight, state, sportsCar.spec, carPose);
        playerCar.position.set(x, carPose.y, z);
        playerCar.rotation.set(carPose.pitch, heading, carPose.roll, 'YXZ');
        sportsCar.update(dt, state);
      }
      if (headlamps.length) {
        if (playerCar.visible) {
          headlights.position.copy(playerCar.position);
          headlights.rotation.copy(playerCar.rotation);
        }
      }
      const lightLevel = vehicleHeadlightLevel(windowGlow.value, headlightWeather.value);
      for (const light of headlamps) light.intensity = playerCar.visible ? lightLevel * 150 : 0;
      helicopter.update(dt, state);
      people.begin();
      if (mode === 'walk') {
        player.updateWalk(dt, state, createActorFootFloor(world, state));
      } else if (mode === 'cycle') {
        bicycle.update(dt, state, (px, pz) => world.groundHeight(px, pz, state.y));
        player.updateRide(dt, bicycle, state);
      } else player.hide();
      const mobile = touchGraphics && quality === 'performance';
      contactShadow.visible =
        (mobile && (mode === 'drive' || mode === 'cycle')) ||
        (mode === 'walk' && state.grounded && state.cameraView !== 'first');
      if (contactShadow.visible) {
        contactShadow.position.set(x, (bike.visible ? bike.position.y : y) + 0.034, z);
        contactShadow.rotation.y = heading;
        if (playerCar.visible) contactShadow.scale.set(1.15, 1, 2.65);
        else if (bike.visible) contactShadow.scale.set(0.36, 1, 1.05);
        else contactShadow.scale.set(0.42, 1, 0.49);
      }
      const crowdRadius = mobile ? 105 : 140;
      populationTimer += dt;
      populate(state, camera, crowdRadius);
      population.walkers = 0;
      for (const p of crowd) {
        p.active = false;
        let px = p.x,
          pz = p.z,
          face = p.heading;
        if (!p.idle) {
          const e = p.edge;
          if (!e) continue;
          p.t += ((dt * p.speed) / e.length) * p.direction;
          if (p.t > p.high || p.t < p.low) {
            p.direction *= -1;
            p.t = Math.max(p.low, Math.min(p.high, p.t));
          }
          px = e.a[0] + (e.b[0] - e.a[0]) * p.t - Math.cos(e.heading) * p.offset;
          pz = e.a[1] + (e.b[1] - e.a[1]) * p.t + Math.sin(e.heading) * p.offset;
          face = e.heading + (p.direction < 0 ? Math.PI : 0);
        } else if (p.walkSpan) {
          p.walkClock += dt;
          const phase = p.walkClock / p.walkSpan;
          const nextX = px + Math.sin(phase) * p.walkSpan;
          if (pedestrianSpace(nextX, pz)) {
            px = nextX;
            face = Math.cos(phase) > 0 ? Math.PI / 2 : -Math.PI / 2;
          }
        }
        if (Math.hypot(px - camera.position.x, pz - camera.position.z) >= crowdRadius) continue;
        const surface = p.idle ? p.y : world.groundHeight(px, pz);
        if (!world.collision(px, pz, 0.3, surface)) {
          const threatening = Math.abs(surface - y) < 1.25 && (mode === 'drive' || mode === 'cycle');
          const ahead = Math.min(4, Math.max(0, Math.abs(state.speed) * 0.42)) * Math.sign(state.speed);
          const dx = px - (x + Math.sin(heading) * ahead),
            dz = pz - (z + Math.cos(heading) * ahead);
          const distance = Math.hypot(dx, dz);
          const target =
            threatening && distance > 0.01 && distance < 4.3 ? Math.min(1.65, 4.3 - distance) : 0;
          if (target > 0 && !(p.avoid > 0.1)) {
            p.avoidX = dx / distance;
            p.avoidZ = dz / distance;
          }
          p.avoid = (p.avoid || 0) + (target - (p.avoid || 0)) * Math.min(1, dt * (target ? 5 : 2));
          if (p.avoid > 0.01) {
            const a = px + p.avoidX * p.avoid,
              b = pz + p.avoidZ * p.avoid;
            const floor = world.groundHeight(a, b, surface);
            if (
              Math.abs(floor - surface) < 0.35 &&
              pedestrianSpace(a, b) &&
              !world.collision(a, b, 0.31, floor)
            ) {
              px = a;
              pz = b;
              if (target > 0) face = Math.atan2(p.avoidX, p.avoidZ);
            }
          }
          p.px = px;
          p.pz = pz;
          p.rig.update(dt, px, pz, face, (_owner, ax, az) => world.groundHeight(ax, az, surface));
          p.y = world.groundHeight(px, pz, surface);
          p.active = true;
          if (!p.idle) population.walkers++;
          people.add(p.rig, Math.hypot(px - camera.position.x, pz - camera.position.z));
        }
      }
      people.end();
      trafficSimulation.step(dt, state, camera);
      traffic.begin(quality);
      buses.count = 0;
      let count = 0;
      const visibleCap = touchGraphics
          ? mobile
            ? 32
            : 44
          : quality === 'high'
            ? TRAFFIC_LIMITS.highVisible
            : TRAFFIC_LIMITS.balancedVisible,
        radius = state.mode === 'orbit' ? 2200 : mobile ? 370 : 550,
        nearby = fleet
          .filter((car) => {
            car.cameraDistance = Math.hypot(car.x - camera.position.x, car.z - camera.position.z);
            return car.edge && car.cameraDistance < radius;
          })
          .sort((a, b) => a.cameraDistance - b.cameraDistance || a.id - b.id);
      trafficSimulation.stats.headlights = updateVehicleHeadlightWash(
        playerCar.visible || bike.visible ? state : null,
        nearby,
        lightLevel,
        camera,
        bicycle.steering.rotation.y,
      );
      for (const car of nearby) {
        if (count >= visibleCap) break;
        const e = car.edge,
          px = car.x,
          pz = car.z;
        const ahead = world.surfaceHeight(px + Math.sin(e.heading) * 2, pz + Math.cos(e.heading) * 2, e.road);
        const behind = world.surfaceHeight(
          px - Math.sin(e.heading) * 2,
          pz - Math.cos(e.heading) * 2,
          e.road,
        );
        dummy.position.set(px, car.y + 0.025, pz);
        dummy.scale.setScalar(1);
        dummy.rotation.set(-Math.atan2(ahead - behind, 4), car.heading, 0, 'YXZ');
        dummy.updateMatrix();
        if (car.model === 'bus') {
          if (buses.count < buses.instanceMatrix.count) buses.setMatrixAt(buses.count++, dummy.matrix);
          count++;
          continue;
        }
        const turn =
            car.nextEdge && (1 - car.t) * e.length < 18
              ? Math.atan2(
                  Math.sin(car.nextEdge.heading - e.heading),
                  Math.cos(car.nextEdge.heading - e.heading),
                )
              : 0,
          blink = Math.floor((world.infrastructure?.signalTime ?? 0) * 2) % 2 === 0 ? 1 : 0;
        traffic.add(
          car.id,
          dummy.matrix,
          car.color,
          car.cameraDistance,
          car.acceleration < -0.6 || car.blocked ? 1 : 0,
          turn > 0.25 ? blink : 0,
          turn < -0.25 ? blink : 0,
          0,
          car.model,
        );
        count++;
      }
      if (buses.count) buses.instanceMatrix.needsUpdate = true;
      trafficSimulation.stats.buses = buses.count;
      trafficSimulation.stats.visible = count;
      traffic.end();
      trafficSimulation.stats.renderedTriangles = traffic.stats.triangles;
      trafficSimulation.stats.visiblePickups = traffic.stats.pickups;
    },
  };
}
