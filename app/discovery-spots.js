import * as THREE from 'three/webgpu';
import { inPolygon, seeded } from './geo.js';

// OpenStreetMap way 927836670 and 1040063886. The small internal features
// follow CMLC/EVNA reference photos and are approximate.
export const DOG_PARK = {
  ring: [
    [1726.1, -59.6],
    [1734.1, -84.3],
    [1702.8, -111.9],
    [1695.9, -102.1],
    [1704.3, -86.2],
    [1706.4, -71.9],
    [1705.8, -53.8],
  ],
};
const garden = {
  ring: [
    [1665.3, -109.7],
    [1673.9, -104.4],
    [1678.3, -110.5],
    [1687.3, -105],
    [1680.7, -94.3],
    [1694.1, -92],
    [1694.3, -85.7],
    [1693.9, -79],
    [1690.4, -73],
    [1684.1, -77.2],
    [1680, -70.3],
    [1680.2, -63],
    [1671.2, -62.5],
    [1670.9, -44],
    [1660.2, -44],
    [1660, -62.3],
    [1658, -87.4],
    [1664.5, -95.3],
    [1661.4, -103.6],
  ],
};

export function buildDiscoverySpots({ add, box, beam, rectangle, sign, labels, groundHeight }) {
  const dog = 'East Village dog park',
    plots = 'Crossroads Community Garden';
  const fence = (name, ring, gap) => {
    for (const [i, a] of ring.entries()) {
      const b = ring[(i + 1) % ring.length],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz);
      const sections = Math.ceil(length / 2.15),
        yaw = Math.atan2(-dz, dx);
      for (let j = 0; j < sections; j++) {
        const t0 = j / sections,
          t1 = (j + 1) / sections,
          u = (t0 + t1) / 2;
        const x = a[0] + dx * u,
          z = a[1] + dz * u,
          y = groundHeight(x, z);
        box(name, a[0] + dx * t0, y + 0.61, a[1] + dz * t0, 0.055, 1.22, 0.055, 0x515b56);
        if (gap?.[0] === i && gap[1] === j) continue;
        for (const h of [0.13, 1.18]) box(name, x, y + h, z, length / sections, 0.038, 0.038, 0x59625e, yaw);
        for (let k = 1; k < 9; k++) {
          const t = t0 + ((t1 - t0) * k) / 9;
          box(name, a[0] + dx * t, y + 0.65, a[1] + dz * t, 0.014, 1.04, 0.014, 0x68716a);
        }
        rectangle(`${name}-fence-${i}-${j}`, x, z, length / sections, 0.07, y, y + 1.2, yaw);
      }
    }
  };
  fence(dog, DOG_PARK.ring, [3, 1]);
  labels.push({ name: dog, x: 1715, z: -82, height: 3 });

  const rng = seeded(56);
  for (let x = 1662; x <= 1688; x += 4.9) {
    for (let z = -104; z < -49; z += 4.5) {
      if (
        ![
          [x - 1.55, z - 0.84],
          [x + 1.55, z - 0.84],
          [x - 1.55, z + 0.84],
          [x + 1.55, z + 0.84],
        ].every(([a, b]) => inPolygon(a, b, garden))
      )
        continue;
      const y = groundHeight(x, z);
      box(plots, x, y + 0.25, z, 3.12, 0.5, 1.69, 0x927052);
      box(plots, x, y + 0.5, z, 2.96, 0.054, 1.54, 0x574337);
      rectangle(`garden-bed-${x}-${z}`, x, z, 3.12, 1.69, y, y + 0.53);
      for (let k = 0; k < 12; k++) {
        const px = x + ((k % 6) - 2.5) * 0.438,
          pz = z + (k < 6 ? -0.38 : 0.38),
          r = 0.17 + rng() * 0.13;
        add(
          plots,
          new THREE.IcosahedronGeometry(r, 0).scale(1, 1.28, 0.87).translate(px, y + 0.57, pz),
          [0x778e4d, 0x567846, 0x8b714c][Math.floor(rng() * 3)],
        );
        if (k % 5 === 0)
          add(plots, new THREE.IcosahedronGeometry(0.067, 0).translate(px, y + 0.73, pz), 0xc67742);
      }
    }
  }
  labels.push({ name: plots, x: 1672, z: -81, height: 4 });
}
