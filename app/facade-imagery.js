import * as THREE from 'three/webgpu';
import { acceptsFacadeSource, facadeReferences, facadeSourceImages } from './facade-finishes.js';
import { unproject } from './geo.js';

const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function mountFacadeLettering(record, source) {
  const { sign } = record;
  if (
    !sign ||
    !acceptsFacadeSource(
      source,
      record.wallGeometryBuildingId || record.buildingId,
      record.registration.sourceStructureIds,
    )
  )
    return null;
  const { a, b, normal } = sign.wall || record,
    [x, z] = midpoint(a, b),
    outward = new THREE.Vector3(normal[0], 0, normal[1]).normalize(),
    along = new THREE.Vector3(outward.z, 0, -outward.x),
    min = sign.wall ? -0.06 : (record.projection?.minDepth ?? -0.1),
    max = sign.wall ? 0.06 : (record.projection?.maxDepth ?? 0.1),
    ray = new THREE.Raycaster(),
    material = new THREE.MeshBasicMaterial(),
    wall = new THREE.Mesh(source, material);
  function depth(u, y) {
    const point = new THREE.Vector3(x, y, z).addScaledVector(along, u);
    ray.set(point.clone().addScaledVector(outward, max + 0.12), outward.clone().negate());
    ray.far = max - min + 0.24;
    const hit = ray.intersectObject(wall).find((hit) => hit.face.normal.dot(outward) >= 0.95);
    return hit ? hit.point.sub(point).dot(outward) : null;
  }
  try {
    const center = depth(0, sign.y);
    if (center == null) return null;
    for (const scale of [1, 0.8, 0.65]) {
      const width = sign.width * scale;
      const depths = [-width / 2, 0, width / 2].flatMap((u) =>
        [-sign.height / 2, sign.height / 2].map((v) => depth(u, sign.y + v)),
      );
      if (!depths.every((sample) => sample != null && Math.abs(sample - center) < 0.09)) continue;
      const offset = Math.max(center, ...depths) + (record.offset ?? 0.024);
      return { x: x + outward.x * offset, z: z + outward.z * offset, yaw: Math.atan2(...normal), width };
    }
    return null;
  } finally {
    material.dispose();
  }
}

function makeLettering(record, world) {
  const source = world.photoWallGeometry?.(record.wallGeometryBuildingId || record.buildingId);
  let mount;
  try {
    mount = mountFacadeLettering(record, source);
  } finally {
    source?.dispose();
  }
  if (!mount) return null;
  const { sign } = record,
    canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = sign.text.includes('\n') ? 256 : 64;
  const ctx = canvas.getContext('2d');
  if (sign.paint) {
    ctx.fillStyle = sign.paint;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const lines = sign.text.split('\n');
  ctx.fillStyle = sign.paint ? '#f4e6c9' : '#514a3f';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [i, line] of lines.entries()) {
    ctx.font = `bold ${lines.length > 1 ? (i ? 50 : 76) : 50}px Georgia, serif`;
    ctx.fillText(line, 256, canvas.height * ((i + 0.5) / lines.length), 478);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 2;
  const material = new THREE.MeshStandardNodeMaterial({
    map,
    roughness: 0.89,
    alphaTest: sign.paint ? 0 : 0.5,
  });
  const geometry = new THREE.PlaneGeometry(mount.width, sign.height)
    .rotateY(mount.yaw)
    .translate(mount.x, sign.y, mount.z);
  world.placePhotographicGeometry?.(geometry, record);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `Façade lettering: ${record.name}`;
  mesh.receiveShadow = true;
  return mesh;
}

export function createFacadeLettering(scene, world) {
  const records = facadeReferences.map((record) => {
    const [x, z] = midpoint(record.a, record.b);
    return { ...record, x, z };
  });
  const signs = records.filter((record) => record.sign),
    active = new Map(),
    rejected = new Set();
  const destinations = records.map((record) => {
    const [nx, nz] = record.normal;
    const [lon, lat] = unproject(record.x + nx * 11, record.z + nz * 11);
    return {
      name: record.name,
      sub: 'Façade reference',
      lon,
      lat,
      bearing: Math.atan2(-nx, -nz),
      business: true,
    };
  });
  let enabled = true;
  function remove(id, mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.map.dispose();
    mesh.material.dispose();
    active.delete(id);
  }
  return {
    count: records.length,
    destinations,
    get enabled() {
      return enabled;
    },
    get activeCount() {
      return active.size;
    },
    setEnabled(next) {
      enabled = next;
      if (!enabled) for (const [id, mesh] of active) remove(id, mesh);
    },
    update(camera, quality) {
      if (!enabled) return;
      for (const record of signs) {
        const mesh = active.get(record.id);
        const radius = (quality === 'high' ? 270 : 210) + (mesh ? 35 : 0);
        const near =
          camera.position.y < 145 &&
          Math.hypot(record.x - camera.position.x, record.z - camera.position.z) < radius;
        if (!near) {
          if (mesh) remove(record.id, mesh);
        } else if (!mesh && !rejected.has(record.id)) {
          const lettering = makeLettering(record, world);
          if (!lettering) rejected.add(record.id);
          else {
            scene.add(lettering);
            active.set(record.id, lettering);
          }
        }
      }
    },
  };
}

export function createFacadeCredits(host = document.querySelector('.credits')) {
  const dialog = document.createElement('dialog');
  dialog.className = 'photo-credits';
  dialog.setAttribute('aria-labelledby', 'photo-credits-title');
  const heading = document.createElement('h2');
  heading.id = 'photo-credits-title';
  heading.textContent = 'Façade references';
  const close = document.createElement('button');
  close.className = 'close';
  close.setAttribute('aria-label', 'Close façade references');
  close.textContent = '×';
  close.addEventListener('click', () => dialog.close());
  const note = document.createElement('p');
  note.textContent = `${facadeSourceImages.length} licensed reference photographs informed ${facadeReferences.length} wall finishes and signs. Capture dates describe the source views. Materials, lettering and architectural details are drawn for the game.`;
  dialog.append(close, heading, note);
  const list = document.createElement('ol');
  const link = (text, url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return document.createTextNode(text);
    const a = document.createElement('a');
    a.textContent = text;
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    return a;
  };
  for (const photo of facadeSourceImages) {
    const li = document.createElement('li');
    li.append(link(photo.title, photo.sourceUrl), document.createTextNode(' — '));
    li.append(
      photo.creatorUrl ? link(photo.creator, photo.creatorUrl) : document.createTextNode(photo.creator),
    );
    li.append(document.createTextNode(` · ${photo.capturedAt} · `), link(photo.license, photo.licenseUrl));
    list.append(li);
  }
  dialog.append(list);
  document.body.append(dialog);
  const button = document.createElement('button');
  button.textContent = 'Façade references';
  button.addEventListener('click', () => dialog.showModal());
  const separator = document.createElement('span');
  separator.textContent = ' · ';
  host?.append(separator, button);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
  return {
    dialog,
    button,
    dispose() {
      dialog.remove();
      button.remove();
      separator.remove();
    },
  };
}
