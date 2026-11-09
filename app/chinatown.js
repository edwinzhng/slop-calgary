import * as THREE from 'three/webgpu';

const CULTURAL_CENTRE = 'city-outline-25345-0';
const DRAGON_CITY = 'city-outline-28853-0';
const sites = {
  [CULTURAL_CENTRE]: {
    owner: 1379604,
    vertices: 936,
    name: 'Chinese Cultural Centre',
    x: 466.68,
    z: -608,
    y: 4.95,
    yaw: 1.529,
  },
  [DRAGON_CITY]: {
    owner: 1005440,
    vertices: 2139,
    name: 'Dragon City Mall',
    x: 657.3,
    z: -425,
    y: 5,
    yaw: -1.617,
  },
};

function matches(record, site, count) {
  return (
    record?.structureIds?.length === 1 && record.structureIds[0] === site.owner && count === site.vertices
  );
}

export function applyChinatownFinish(building, geometry) {
  const site = sites[building.id];
  if (!site) return;
  const { position, normal, color, buildingProfile } = geometry.attributes;
  if (!matches(geometry.userData.cityMesh, site, position.count)) return;
  const tint = new THREE.Color();
  const hall = building.id === CULTURAL_CENTRE;
  for (let i = 0; i < position.count; i += 3) {
    const ys = [position.getY(i), position.getY(i + 1), position.getY(i + 2)];
    const centre = (ys[0] + ys[1] + ys[2]) / 3;
    const slope = Math.abs(normal.getY(i));
    const roof = centre > (hall ? 10.7 : 13.17) && slope > 0.13;
    const upper = centre > (hall ? 10.7 : 13.17);
    tint.setHex(
      hall
        ? centre > 24.1
          ? 0xc79b4b
          : roof
            ? centre > 19.2
              ? 0x315e91
              : 0x365482
            : upper
              ? 0x8b352c
              : 0xd5a58d
        : roof
          ? 0x476a61
          : upper
            ? 0xb36847
            : 0xbd8a77,
    );
    for (let j = i; j < i + 3; j++) {
      color.setXYZ(j, tint.r, tint.g, tint.b);
      if (upper) buildingProfile.setX(j, 5 / 7);
    }
  }
}

export function buildChinatownDetails({ cityMeshes, sign, box, add, labels }) {
  for (const [id, site] of Object.entries(sites)) {
    const record = cityMeshes?.get(id);
    if (!matches(record, site, record?.indexCount)) continue;
    const hall = id === CULTURAL_CENTRE;
    const sin = Math.sin(site.yaw),
      cos = Math.cos(site.yaw);
    const plaque = (u, y, d) => [site.x + u * cos + d * sin, y, site.z - u * sin + d * cos];
    const put = (u, y, d, w, h, depth, paint) =>
      box('Chinatown', ...plaque(u, y, d), w, h, depth, paint, site.yaw);
    const width = hall ? 10.4 : 5.1;
    put(0, site.y, 0.055, width, 1.58, 0.17, hall ? 0x5e292c : 0x24483f);
    put(0, site.y + 0.8, 0.115, width, 0.08, 0.12, 0xc8a161);
    put(0, site.y - 0.8, 0.115, width, 0.08, 0.12, 0xc8a161);
    sign(
      site.name,
      hall ? '卡城中華文化中心\nCHINESE CULTURAL CENTRE' : '龍城商場\nDRAGON CITY MALL',
      ...plaque(0, site.y, 0.16),
      width - 0.28,
      1.49,
      site.yaw,
      '#ffe5b1',
      hall ? '#693237' : '#285245',
    );
    for (const side of [-1, 1]) {
      const u = side * (width / 2 + 0.49);
      put(u, site.y + 0.25, 0.27, 0.09, 0.09, 0.55, 0x63543e);
      const [x, y, z] = plaque(u, site.y - 0.15, 0.45);
      add('Chinatown', new THREE.SphereGeometry(0.28, 10, 6).scale(1, 1.23, 1).translate(x, y, z), 0xbe4734);
      for (const offset of [-0.28, 0.28]) put(u, y + offset, 0.45, 0.32, 0.06, 0.32, 0xd2a354);
      put(u, y - 0.44, 0.45, 0.045, 0.22, 0.045, 0xc88740);
    }
    if (hall) {
      // The Centre's entrance has a deep red mullion grid over the pink masonry.
      put(0, 2.02, 0.09, 7.75, 3.86, 0.15, 0x7b3b35);
      for (let i = 0; i < 6; i++) {
        const u = (i - 2.5) * 1.24;
        put(u, 1.22, 0.178, 1.16, 2.02, 0.036, 0x334e55);
        put(u, 3.17, 0.178, 1.16, 1.38, 0.036, 0x547078);
        put(u, 1.05, 0.215, 0.57, 0.035, 0.034, 0xa39b78);
      }
      for (const u of [-4.22, 4.22]) put(u, 2.07, 0.17, 0.26, 4.08, 0.25, 0x8f4135);
    }
    labels.push({ name: site.name, x: site.x, z: site.z, height: record.height + 2 });
  }
}
