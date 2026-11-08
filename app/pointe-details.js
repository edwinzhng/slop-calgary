import * as THREE from 'three/webgpu';
import {
  observedBuildingMaterialZones,
  POINTE_MATERIAL_EVIDENCE as evidence,
  POINTE_BAY_FINISH as finish,
} from './observed-building-materials.js';

function bandTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + finish.color.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '600 86px Georgia, serif';
  ctx.fillStyle = '#d3c5a5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('POINTE', 256, 66, 466);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// Only the photographed bay receives these shallow opaque bands. The measured
// shell stays intact; tenant names, hidden elevations and interior volumes are
// not inferred from the photograph. No new colliders or image downloads.
export function createPointeDetails(scene, world, options = {}) {
  const group = new THREE.Group();
  group.name = 'Pointe: observed curved spandrels and name crown';
  group.visible = false;
  group.userData.source = evidence;
  group.userData.dimensionsMeasured = false;
  const source = options.sourceGeometry ?? world.photoWallGeometry?.(evidence.buildingId);
  let mesh,
    texture,
    material,
    disposed = false,
    enabled = true;
  const stats = {
    sourceAccepted: false,
    bands: 0,
    facets: 0,
    triangles: 0,
    drawBudget: 0,
    activeDraws: 0,
    pointLights: 0,
    networkRequests: 0,
    collisionChanges: 0,
    sourceGeometryChanged: false,
  };
  try {
    const observations = source && observedBuildingMaterialZones(source, { id: evidence.buildingId });
    if (observations?.evidence === evidence) {
      const zones = observations.zones.filter((zone) => zone.name === 'observed-curved-dark-glazing'),
        position = source.attributes.position,
        normal = source.attributes.normal,
        positions = [],
        normals = [],
        uvs = [],
        indices = [];
      const facets = zones.map((zone) => {
        const i = zone.triangles[0] * 3,
          nx = normal.getX(i),
          nz = normal.getZ(i),
          length = Math.max(
            ...zone.triangles.flatMap((triangle) =>
              [0, 1, 2].map((corner) => {
                const v = triangle * 3 + corner;
                return (
                  (position.getX(v) - zone.origin[0]) * zone.uAxis[0] +
                  (position.getZ(v) - zone.origin[1]) * zone.uAxis[1]
                );
              }),
            ),
          ),
          a = [zone.origin[0] + nx * 0.018, zone.origin[1] + nz * 0.018],
          b = [a[0] + zone.uAxis[0] * length, a[1] + zone.uAxis[1] * length];
        return { a, b, nx, nz, offset: zone.uOffset, length };
      });
      const total = facets.reduce((sum, facet) => sum + facet.length, 0);
      for (const band of finish.bands)
        for (const facet of facets) {
          const { a, b, nx, nz, offset, length } = facet,
            start = positions.length / 3,
            crown = band.id === 'name-crown',
            u0 = 1 - offset / total,
            u1 = 1 - (offset + length) / total,
            v0 = crown ? 0.5 : 0,
            v1 = crown ? 1 : 0.49;
          positions.push(
            a[0],
            band.bottom,
            a[1],
            b[0],
            band.bottom,
            b[1],
            b[0],
            band.top,
            b[1],
            a[0],
            band.top,
            a[1],
          );
          for (let corner = 0; corner < 4; corner++) normals.push(nx, 0, nz);
          uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
          const forward = -(b[1] - a[1]) * nx + (b[0] - a[0]) * nz > 0;
          for (const local of forward ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) indices.push(start + local);
        }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      world.placePhotographicGeometry?.(geometry, { buildingId: evidence.buildingId });
      geometry.computeBoundingSphere();
      if (!options.material) texture = bandTexture();
      material =
        options.material ??
        new THREE.MeshStandardNodeMaterial({
          map: texture,
          roughness: 0.82,
          metalness: 0.04,
        });
      mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'Pointe: three bands following seventeen measured bay facets';
      mesh.receiveShadow = true;
      group.add(mesh);
      scene.add(group);
      Object.assign(stats, {
        sourceAccepted: true,
        bands: finish.bands.length,
        facets: facets.length,
        triangles: indices.length / 3,
        drawBudget: 1,
      });
    }
  } finally {
    if (!options.sourceGeometry) source?.dispose();
  }
  const show = (value) => {
    group.visible = value;
    stats.activeDraws = value ? stats.drawBudget : 0;
  };
  return {
    group,
    stats,
    colliders: [],
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) show(false);
    },
    update(camera, quality = 'balanced') {
      const p = camera?.position ?? camera,
        radius = quality === 'high' ? 160 : quality === 'low' ? 75 : 110;
      show(
        !disposed &&
          enabled &&
          stats.sourceAccepted &&
          Number.isFinite(p?.x + p?.y + p?.z) &&
          p.y < 90 &&
          Math.hypot(p.x + 1190.5, p.z + 733.7) < radius,
      );
    },
    prewarm() {
      if (disposed || !stats.sourceAccepted) return () => {};
      const visible = group.visible,
        culled = mesh.frustumCulled;
      let restored = false;
      show(true);
      mesh.frustumCulled = false;
      return () => {
        if (restored) return;
        restored = true;
        mesh.frustumCulled = culled;
        show(!disposed && enabled && visible);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      show(false);
      group.removeFromParent();
      mesh?.geometry.dispose();
      texture?.dispose();
      if (!options.material) material?.dispose();
      group.clear();
    },
  };
}
