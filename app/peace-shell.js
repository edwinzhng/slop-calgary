import * as THREE from 'three/webgpu';
import { PEACE_SURFACE_LIMITS, PEACE_WALKWAY, peaceSidewalkRise } from './peace-surfaces.js';

// Photo-based sections, not surveyed steelwork. The architect describes an
// 8 m × 5.85 m oval shell. Keep its lower chord below the walkable deck.
const center = PEACE_SURFACE_LIMITS.level + 0.85;
const rx = 3.86,
  ry = 2.78,
  wall = 0.28;
const canopyArc = Math.PI * 0.39;

function shellPoint(side, angle, z, inset) {
  return [side * (rx - inset) * Math.sin(angle), center + (ry - inset) * Math.cos(angle), z];
}

function quad(target, a, b, c, d, reverse = false) {
  if (reverse) target.push(...a, ...c, ...b, ...a, ...d, ...c);
  else target.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function geometry(positions) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.computeVertexNormals();
  return result;
}

export function createPeaceShell(length) {
  const steel = [],
    glass = [],
    half = length / 2;
  function rib(side, start, drift, width, inset = 0) {
    const from = drift ? Math.max(0, Math.min((-half - start) / drift, (half - start) / drift)) : 0;
    const to = drift ? Math.min(1, Math.max((-half - start) / drift, (half - start) / drift)) : 1;
    if (to <= from) return;
    const sections = Math.ceil((to - from) * 32);
    const section = (u) => {
      const z = start + drift * u,
        a = Math.PI * u;
      const back = Math.max(-half, z - width / 2),
        front = Math.min(half, z + width / 2);
      return [
        shellPoint(side, a, back, inset),
        shellPoint(side, a, front, inset),
        shellPoint(side, a, front, inset + wall),
        shellPoint(side, a, back, inset + wall),
      ];
    };
    let a = section(from);
    for (let i = 1; i <= sections; i++) {
      const b = section(from + ((to - from) * i) / sections);
      for (let j = 0; j < 4; j++) {
        const k = (j + 1) % 4;
        quad(steel, a[j], a[k], b[k], b[j], side < 0);
      }
      a = b;
    }
  }
  const bays = 16,
    pitch = length / bays;
  for (const side of [-1, 1]) {
    // Stagger the counter-wound families: their joins alternate between the
    // shoulder of the roof and the lower side, as in the construction views.
    for (let i = -1; i <= bays + 1; i++) {
      rib(side, -half + i * pitch, pitch, 0.35);
      rib(side, -half + (i + 0.5) * pitch, -pitch, 0.35, 0.012);
    }
    rib(side, -half + 0.17, 0, 0.34);
    rib(side, half - 0.17, 0, 0.34);
    // Both glazed halves sit between the inner and outer faces of the truss.
    // The low side apertures remain open to the river.
    for (let j = 0; j < 16; j++) {
      const a = (j / 16) * canopyArc,
        b = ((j + 1) / 16) * canopyArc;
      for (let i = 0; i < bays; i++) {
        const z = -half + i * pitch,
          end = z + pitch - 0.018;
        quad(
          glass,
          shellPoint(side, a, z, 0.105),
          shellPoint(side, a, end, 0.105),
          shellPoint(side, b, end, 0.105),
          shellPoint(side, b, z, 0.105),
          side < 0,
        );
      }
    }
  }
  // Mount the longitudinal mullions against the inside of the upper X-joints.
  const shoulder = shellPoint(1, Math.PI / 4, 0, wall);
  return { steel: geometry(steel), glass: geometry(glass), shoulder };
}

export function createPeaceSidewalk(length) {
  const positions = [],
    half = length / 2,
    inner = PEACE_WALKWAY.cycleWidth / 2;
  for (const side of [-1, 1]) {
    const edge = PEACE_WALKWAY.width / 2;
    const stations = [0, PEACE_WALKWAY.taper, length - PEACE_WALKWAY.taper, length];
    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1],
        b = stations[i],
        z0 = a - half,
        z1 = b - half;
      const low = PEACE_SURFACE_LIMITS.level,
        y0 = low + peaceSidewalkRise(a, length),
        y1 = low + peaceSidewalkRise(b, length);
      quad(
        positions,
        [side * inner, y0, z0],
        [side * inner, y1, z1],
        [side * edge, y1, z1],
        [side * edge, y0, z0],
        side < 0,
      );
      quad(
        positions,
        [side * inner, low, z0],
        [side * inner, low, z1],
        [side * inner, y1, z1],
        [side * inner, y0, z0],
        side < 0,
      );
      quad(
        positions,
        [side * edge, low - 0.01, z0],
        [side * edge, y0, z0],
        [side * edge, y1, z1],
        [side * edge, low - 0.01, z1],
        side < 0,
      );
    }
  }
  return geometry(positions);
}
