import * as THREE from 'three/webgpu';
import { polygonContact } from './building-collision.js';
import { bounds, SpatialIndex } from './geo.js';
import { createBridgeCollisionParts } from './bridge-collision.js';
import { springScalar, springVector } from './motion.js';

const polygonCache = new WeakMap();
export function colliderPolygon(building) {
  if (!polygonCache.has(building))
    polygonCache.set(building, {
      outer: building.ring.map(([x, z]) => ({ x, z })),
      holes: (building.holes || []).map((ring) => ring.map(([x, z]) => ({ x, z }))),
    });
  return polygonCache.get(building);
}

export function movementBody(mode, heading = 0, radius) {
  const car = mode === 'drive';
  const sin = Math.sin(heading),
    cos = Math.cos(heading);
  const hx = 1.02,
    hz = 2.33;
  const r = radius ?? (car ? 2.5 : mode === 'fly' ? 3.8 : mode === 'cycle' ? 0.6 : 0.42);
  return {
    mode,
    car,
    sin,
    cos,
    hx,
    hz,
    radius: r,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : r,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : r,
    top: mode === 'fly' ? 3.4 : mode === 'drive' ? 1.3 : 1.9,
  };
}

export function footprintContact(building, x, y, z, body, contact) {
  if (y >= building.height || y + (body.top ?? 1.8) <= (building.minHeight ?? -1)) return false;
  if (
    y >= (building.heightAt?.(x, z, body) ?? building.height) ||
    y + (body.top ?? 1.8) <= (building.minHeightAt?.(x, z, body) ?? building.minHeight ?? -1)
  )
    return false;
  return polygonContact(colliderPolygon(building), x, z, body, contact);
}

function segmentPrism(a, b, width, minHeight, height, id) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    len = Math.hypot(dx, dz) || 1;
  const nx = ((-dz / len) * width) / 2,
    nz = ((dx / len) * width) / 2;
  const ring = [
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
    [a[0] + nx, a[1] + nz],
  ];
  return { id, ring, minHeight, height };
}

// Camera blockers are conservative solid volumes, using the same true building
// outlines as movement (including courtyard holes), plus bridge slabs and +15s.
// The narrow camera sphere and swept boom prevent corner and near-plane clips.
export function createCameraCollision(world) {
  const extra = new SpatialIndex(80);
  const insert = (b) => extra.insert(b, bounds(b.ring));
  const bridgeParts = world.bridgeColliders || createBridgeCollisionParts(world.infrastructure);
  for (const slab of bridgeParts.slabs) insert(slab);
  for (const road of world.infrastructure?.skywalks || []) {
    const level = world.infrastructure.surfaceHeight(...road.points[0], road);
    for (let i = 1; i < road.points.length; i++)
      insert(
        segmentPrism(
          road.points[i - 1],
          road.points[i],
          3.1,
          level - 0.35,
          level + 2.85,
          `skywalk-${road.id}-${i}`,
        ),
      );
  }
  const circle = { car: false, radius: 0.35 },
    contact = { nx: 0, nz: 0, depth: 0 };
  const move = new THREE.Vector3(),
    best = new THREE.Vector3();
  const at = new THREE.Vector3();
  const trunkPose = { x: 0, y: 0, z: 0 },
    trunkBody = { car: false, radius: 0.35, top: 0.7 },
    trunkContact = {};
  function floorHeight(x, z, y) {
    let floor = Math.max(
      0.16 + (world.terrain?.offsetAt(x, z) || 0),
      world.groundSurfaces?.groundHeight(x, z) ?? 0.16,
    );
    const deck = world.infrastructure?.groundHeight(x, z);
    if (deck != null && y > deck + 0.16) floor = Math.max(floor, deck);
    const peace = world.groundHeight(x, z);
    if (peace > floor && y > peace + 0.16) floor = peace;
    return floor;
  }
  function penetration(position, radius = 0.35, out = move) {
    circle.radius = radius;
    let magnitude = 0;
    out.set(0, 0, 0);
    for (const collection of [
      world.buildingIndex?.near(position.x, position.z, radius),
      extra.near(position.x, position.z, radius),
    ]) {
      for (const building of collection || []) {
        if (position.y - radius >= building.height || position.y + radius <= (building.minHeight ?? -1))
          continue;
        const low = building.minHeightAt?.(position.x, position.z, circle) ?? building.minHeight ?? -1,
          high = building.heightAt?.(position.x, position.z, circle) ?? building.height;
        if (position.y + radius <= low || position.y - radius >= high) continue;
        if (!polygonContact(colliderPolygon(building), position.x, position.z, circle, contact)) continue;
        best.set(contact.nx * (contact.depth + 0.012), 0, contact.nz * (contact.depth + 0.012));
        const up = high + radius + 0.015 - position.y,
          down = position.y - low + radius + 0.015;
        if (up >= 0 && up < best.length()) best.set(0, up, 0);
        if (
          low > 0.7 &&
          down >= 0 &&
          down < best.length() &&
          position.y - down > floorHeight(position.x, position.z, position.y) + radius
        )
          best.set(0, -down, 0);
        if (best.lengthSq() > magnitude) {
          magnitude = best.lengthSq();
          out.copy(best);
        }
      }
    }
    if (world.trunks) {
      trunkPose.x = position.x;
      trunkPose.y = position.y - radius;
      trunkPose.z = position.z;
      trunkBody.radius = radius;
      trunkBody.top = radius * 2;
      if (world.trunks.contact(trunkPose, trunkBody, trunkContact)) {
        best.set(
          trunkContact.nx * (trunkContact.depth + 0.012),
          0,
          trunkContact.nz * (trunkContact.depth + 0.012),
        );
        if (best.lengthSq() > magnitude) {
          magnitude = best.lengthSq();
          out.copy(best);
        }
      }
    }
    const floor = floorHeight(position.x, position.z, position.y) + radius;
    if (position.y < floor && floor - position.y > out.length()) out.set(0, floor - position.y + 0.008, 0);
    return out;
  }
  function blocked(position, radius = 0.35) {
    return penetration(position, radius, move).lengthSq() > 1e-10;
  }
  function resolve(position, radius = 0.35, out = new THREE.Vector3()) {
    out.copy(position);
    for (let i = 0; i < 16; i++) {
      penetration(out, radius, move);
      if (move.lengthSq() < 1e-10) break;
      out.add(move);
    }
    return out;
  }
  function sweep(anchor, desired, radius = 0.35, out = new THREE.Vector3()) {
    const len = anchor.distanceTo(desired);
    if (len < 1e-5) return resolve(desired, radius, out);
    // An orbit focus may be inside a landmark. Its centre is a valid look-at
    // target; it must never force the camera into the same building.
    if (blocked(anchor, radius)) return resolve(desired, radius, out);
    const steps = Math.min(800, Math.max(1, Math.ceil(len / Math.max(0.18, radius * 0.7))));
    let safe = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      at.lerpVectors(anchor, desired, t);
      if (blocked(at, radius)) {
        let lo = safe,
          hi = t;
        for (let j = 0; j < 10; j++) {
          const middle = (lo + hi) / 2;
          at.lerpVectors(anchor, desired, middle);
          if (blocked(at, radius)) hi = middle;
          else lo = middle;
        }
        out.lerpVectors(anchor, desired, Math.max(0, lo - 0.015 / len));
        return resolve(out, radius, out);
      }
      safe = t;
    }
    return resolve(desired, radius, out);
  }
  return { blocked, resolve, sweep, floorHeight, extra };
}

// Smooth the arm in the player's frame. Sweeping from the old camera can
// strand it across a pier or corner even after the player has cleared it.
export function createChaseBoom(collision, radius = 0.4) {
  const offset = new THREE.Vector3(),
    wanted = new THREE.Vector3(),
    velocity = new THREE.Vector3(),
    endpoint = new THREE.Vector3(),
    safe = new THREE.Vector3();
  let length = Infinity,
    lengthSpeed = 0;
  return (anchor, desired, dt, out, snap = false) => {
    wanted.subVectors(desired, anchor);
    if (snap || !Number.isFinite(length)) {
      offset.copy(wanted);
      velocity.set(0, 0, 0);
    } else springVector(offset, velocity, wanted, 0.14, dt);
    endpoint.addVectors(anchor, offset);
    collision.sweep(anchor, endpoint, radius, safe);
    const clearance = safe.distanceTo(anchor);
    if (snap || clearance <= length) {
      length = clearance;
      lengthSpeed = 0;
    } else {
      [length, lengthSpeed] = springScalar(length, lengthSpeed, clearance, 0.16, dt);
      length = Math.min(length, clearance);
    }
    out.lerpVectors(anchor, safe, clearance > 0.0001 ? length / clearance : 1);
    // A pivot can briefly overlap a radius-sized obstacle at a deck seam.
    return collision.resolve(out, radius, out);
  };
}
