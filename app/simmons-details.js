import * as THREE from 'three/webgpu';
import evidence from '../data/SIMMONS_FACADE_DETAILS.json' with { type: 'json' };
import { matchesSimmonsSource, SIMMONS_SOURCE_EVIDENCE } from './simmons-evidence.js';
import { makeBatch, mergeOpaque, verifyPlane, simmonsWindowGeometry } from './simmons-frame-geometry.js';

export { simmonsBackingEvidence, SIMMONS_SOURCE_EVIDENCE } from './simmons-evidence.js';

function bufferGeometry(batch, vertexColors = false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
  if (vertexColors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 3));
  geometry.setIndex(batch.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// Seven source-observed openings only. No ground-height query, source-shell
// mutation, material replacement, facade wrapping, lights or new colliders.
export function createSimmonsDetails(scene, world, options = {}) {
  const includeGlass = options.includeGlass === true;
  const group = new THREE.Group();
  group.name = 'Simmons: source-observed upper window relief';
  group.visible = false;
  group.userData.sourceImages = evidence.meta.images.slice();
  group.userData.sourceGeometry = SIMMONS_SOURCE_EVIDENCE.buildingId;
  group.userData.metricPrecision = evidence.meta.boundsPrecision;
  let enabled = true,
    disposed = false;
  const ownedMaterials = [],
    geometries = [],
    meshes = [];
  const stats = {
    sourceAccepted: false,
    windows: 0,
    openingPanes: 0,
    renderedGlassPanes: 0,
    triangles: 0,
    drawBudget: 0,
    activeDraws: 0,
    pointLights: 0,
    collisionChanges: 0,
    sourceGeometryChanged: false,
    disposed: false,
  };
  const source = options.sourceGeometry ?? world?.photoWallGeometry?.(SIMMONS_SOURCE_EVIDENCE.buildingId);
  try {
    if (matchesSimmonsSource(source) && matchesSimmonsSource(source, evidence.sourceGeometry)) {
      for (const plane of evidence.planes) verifyPlane(plane, source);
      const batches = { frame: makeBatch(), lintel: makeBatch(), sill: makeBatch(), glass: makeBatch() };
      const planes = new Map(evidence.planes.map((p) => [p.id, p]));
      const windows = evidence.windows.map((window) => {
        const plane = planes.get(window.planeId);
        if (!plane) throw new RangeError('Missing measured Simmons detail plane');
        return simmonsWindowGeometry(window, plane, batches, evidence.style);
      });
      const opaque = bufferGeometry(mergeOpaque(batches, evidence.style), true);
      const opaqueMaterial =
        options.opaqueMaterial ??
        new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.79, metalness: 0.025 });
      if (!options.opaqueMaterial) ownedMaterials.push(opaqueMaterial);
      const frame = new THREE.Mesh(opaque, opaqueMaterial);
      frame.name = 'Simmons: seven observed frames, concrete lintels and brick sills';
      frame.receiveShadow = true;
      frame.castShadow = false;
      frame.userData.sourceImages = evidence.meta.images.slice();
      group.add(frame);
      geometries.push(opaque);
      meshes.push(frame);
      if (includeGlass) {
        const glass = bufferGeometry(batches.glass);
        const material =
          options.glassMaterial ??
          new THREE.MeshStandardNodeMaterial({
            color: evidence.style.glassColor,
            roughness: 0.13,
            metalness: 0.42,
          });
        if (!options.glassMaterial) ownedMaterials.push(material);
        const pane = new THREE.Mesh(glass, material);
        pane.name = 'Simmons: optional source-observed pane surfaces';
        pane.receiveShadow = true;
        pane.castShadow = false;
        group.add(pane);
        geometries.push(glass);
        meshes.push(pane);
      }
      stats.sourceAccepted = true;
      stats.windows = windows.length;
      stats.openingPanes = windows.reduce((sum, w) => sum + w.panes, 0);
      stats.renderedGlassPanes = includeGlass ? stats.openingPanes : 0;
      stats.triangles = geometries.reduce(
        (sum, g) => sum + (g.index?.count ?? g.attributes.position.count) / 3,
        0,
      );
      stats.drawBudget = meshes.length;
      scene.add(group);
    }
  } finally {
    // A caller-supplied geometry remains caller-owned. The world's geometry
    // accessor returns a disposable copy, just as the photo-decal renderer does.
    if (!options.sourceGeometry) source?.dispose();
  }
  const centre = { x: 1547.3, y: 6.2, z: -237.7 };
  const setVisible = (visible) => {
    group.visible = visible;
    stats.activeDraws = visible ? stats.drawBudget : 0;
  };
  return {
    group,
    meshes,
    stats,
    colliders: [],
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) setVisible(false);
    },
    update(camera, quality = 'balanced') {
      const p = camera?.position ?? camera;
      if (
        disposed ||
        !enabled ||
        !stats.sourceAccepted ||
        !Number.isFinite(p?.x) ||
        !Number.isFinite(p?.y) ||
        !Number.isFinite(p?.z)
      ) {
        setVisible(false);
        return;
      }
      const radius = quality === 'high' ? 160 : quality === 'low' ? 75 : 110;
      const dx = p.x - centre.x,
        dz = p.z - centre.z;
      setVisible(p.y < 90 && dx * dx + dz * dz < radius * radius);
    },
    prewarm() {
      if (disposed || !stats.sourceAccepted) return () => {};
      const visible = group.visible,
        culling = meshes.map((mesh) => mesh.frustumCulled);
      let restored = false;
      setVisible(true);
      for (const mesh of meshes) mesh.frustumCulled = false;
      return () => {
        if (restored) return;
        restored = true;
        for (let i = 0; i < meshes.length; i++) meshes[i].frustumCulled = culling[i];
        setVisible(!disposed && visible);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stats.disposed = true;
      setVisible(false);
      group.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of ownedMaterials) m.dispose();
      group.clear();
    },
  };
}
