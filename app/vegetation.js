import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  color,
  positionWorld,
  normalWorld,
  sin,
  float,
  mix,
  smoothstep,
  floor,
  step,
  uniform,
} from 'three/tsl';
import { SpatialIndex, inPolygon } from './geo.js';
import { buildTreeGeometries, createLeafAtlas, TREE_SPECIES } from './reference-trees.js';
import { createTreeMaterial } from './reference-tree-material.js';
import { cityUniforms } from './city-uniforms.js';
import { hash2D } from './render-nodes.js';
import { createIndirectCellDraws, treeBoundsExpansion } from './vegetation-cells.js';

function hash(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

export function treeProfile(tree) {
  const seed = hash(tree.id);
  const evergreen = /Evergreen/i.test(tree.type) || /PICEA|PINUS|ABIES|THUJA/i.test(tree.genus);
  const columnar = !evergreen && /COLUMNAR|SWEDISH|LOMBARDY|TOWER|ERECTA/i.test(tree.name);
  const paleBark = /BETULA/i.test(tree.genus) || /TREMULOIDES|TREMULA/i.test(tree.species);
  const poplar = /POPULUS|BETULA/i.test(tree.genus);
  const size = /SMALL/i.test(tree.matureSize) ? 0.78 : /MEDIUM/i.test(tree.matureSize) ? 0.91 : 1;
  const dbh = tree.dbh > 0 ? Math.min(180, tree.dbh) : 24;
  // The inventory measures trunk diameter, not height or crown spread. Keep
  // those estimated dimensions explicit and reproducible rather than random.
  const h = Math.max(3.5, Math.min(26, (2.4 + 1.65 * Math.sqrt(dbh)) * size));
  const radius = Math.max(0.05, Math.min(0.9, dbh / 200));
  return {
    form: evergreen ? 2 : columnar ? 1 : 0,
    height: h,
    width:
      h *
      (evergreen
        ? 0.23
        : columnar
          ? 0.13
          : /ULMUS|SALIX/i.test(tree.genus)
            ? 0.4
            : /POPULUS/i.test(tree.genus)
              ? 0.28
              : 0.35),
    radius,
    seed,
    species: /ULMUS|SALIX/i.test(tree.genus) ? 2 : /POPULUS|BETULA/i.test(tree.genus) ? 1 : 0,
    needleTint: /PUNGENS|COLORADO|BLUE/i.test(`${tree.species} ${tree.name}`) ? 0x75918c : 0x436656,
    // The lower half of the poplar phase range selects pale aspen/birch bark.
    foliageSeed: poplar ? (paleBark ? seed * 0.49 : 0.5 + seed * 0.49) : seed * 0.999,
    variant: seed < 0.5 ? 0 : 1,
  };
}

// The branch/leaf builder is adapted from Slop NY. Surveyed Calgary
// positions, species groups and DBH remain authoritative; crown/height are still
// explicit estimates. No document or canvas is needed to build/test geometry.
export function buildSurveyedTreePrototypes(tileMeters = [1.3, 1.15, 1.4, 2.4]) {
  return TREE_SPECIES.flatMap((species, speciesIndex) =>
    [0, 1].map((variant) => {
      const levels = buildTreeGeometries(speciesIndex, variant, tileMeters, {
        levels: [0, 2],
        solidCanopy: true,
      });
      const near = levels[0],
        far = levels[2],
        box = new THREE.Box3();
      for (const geometry of [near, far]) {
        geometry.computeBoundingBox();
        box.union(geometry.boundingBox);
      }
      return {
        species: speciesIndex,
        variant,
        near,
        far,
        height: box.max.y,
        radius: Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)),
        trunk: species.trunk,
      };
    }),
  );
}

function leafAtlas() {
  if (typeof document !== 'undefined') return createLeafAtlas();
  // CPU geometry tests deliberately avoid a browser canvas. Production always
  // uses the original detailed 1024px twig/leaf atlas and coverage mip chain.
  const texture = new THREE.DataTexture(new Uint8Array([170, 128, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  return { texture, tileMeters: [1.3, 1.15, 1.4, 2.4] };
}

// A spruce keeps its tapered, scalloped whorls without alpha-textured needles.
export function buildSpruceCrown(detailed) {
  const positions = [],
    colours = [];
  const tiers = detailed ? 8 : 6,
    spokes = detailed ? 10 : 8;
  const triangle = (a, b, c, shade) => {
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 9; i++) colours.push(shade);
  };
  for (let tier = 0; tier < tiers; tier++) {
    const y = 0.14 + (tier * 0.78) / tiers;
    const tip = [0, Math.min(1, y + 0.23), 0];
    const ring = Array.from({ length: spokes }, (_, i) => {
      const angle = (i / spokes) * Math.PI * 2 + tier * 2.39996;
      const r = Math.pow(1 - y, 0.95) * (i % 2 === 0 ? 1.05 : 0.81);
      return [Math.cos(angle) * r, y + (i % 2 === 0 ? -0.02 : 0.028), Math.sin(angle) * r];
    });
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j],
        b = ring[(j + 1) % ring.length];
      triangle(a, tip, b, 0.76 + (j % 3) * 0.08);
      triangle(b, [0, y + 0.043, 0], a, 0.62);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function branchGeometry() {
  const geos = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    const start = new THREE.Vector3(0, 0.18 + i * 0.12, 0);
    const reach = (1 - start.y) ** 0.9;
    const end = new THREE.Vector3(Math.cos(a) * reach, start.y - 0.035, Math.sin(a) * reach);
    const d = end.clone().sub(start);
    const g = new THREE.CylinderGeometry(0.004, 0.012, d.length(), 5);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.normalize()));
    g.translate(...start.add(end).multiplyScalar(0.5).toArray());
    geos.push(g.toNonIndexed());
    g.dispose();
  }
  const geometry = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return geometry;
}

export function createVegetation(
  scene,
  treeData,
  { buildingIndex, inWater = () => false, groundHeight = () => 0.12, indirectCells = false } = {},
) {
  const records = [],
    index = new SpatialIndex(160);
  for (const tree of treeData.trees || []) {
    if (!Number.isFinite(tree.x) || !Number.isFinite(tree.z) || inWater(tree.x, tree.z)) continue;
    if (buildingIndex && [...buildingIndex.near(tree.x, tree.z)].some((b) => inPolygon(tree.x, tree.z, b)))
      continue;
    const record = { ...tree, profile: treeProfile(tree), baseY: groundHeight(tree.x, tree.z) };
    records.push(record);
    index.insert(record, { minX: tree.x, maxX: tree.x, minZ: tree.z, maxZ: tree.z });
  }
  const viewCenter = uniform(new THREE.Vector3()),
    fadeEnd = uniform(600),
    fadeWidth = uniform(110),
    dither = hash2D(floor(positionWorld.xz.mul(15)).add(floor(positionWorld.y.mul(19)))),
    visibility = step(
      dither,
      float(1).sub(smoothstep(fadeEnd.sub(fadeWidth), fadeEnd, positionWorld.xz.sub(viewCenter.xz).length())),
    );
  const leaf = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.94, vertexColors: true });
  const tier = smoothstep(0.05, 0.17, normalWorld.y)
    .mul(0.22)
    .add(smoothstep(0.49, 0.6, normalWorld.y).mul(0.12));
  const evergreenColor = color(0xd3e4d7).mul(tier.add(0.74));
  leaf.colorNode = mix(
    evergreenColor,
    color(0xe7edf0),
    cityUniforms.uSnow.mul(smoothstep(0.15, 0.8, normalWorld.y)).mul(0.92),
  );
  const bark = new THREE.MeshStandardNodeMaterial({ color: 0x6c6250, roughness: 0.98 });
  bark.colorNode = color(0x6c6250).mul(sin(positionWorld.x.mul(22)).mul(0.035).add(float(0.96)));
  for (const material of [leaf, bark]) {
    material.alphaTest = 0.5;
    material.opacityNode = visibility;
  }
  const nearCapacity = 500,
    farCapacity = 9000;
  const make = (geometry, mat, count, name) => {
    const mesh = new THREE.InstancedMesh(geometry, mat, count);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    // Static attributes upload only when a repack is necessary, rather than in
    // every scene and shadow pass of every frame.
    scene.add(mesh);
    return mesh;
  };
  const atlas = leafAtlas(),
    prototypes = buildSurveyedTreePrototypes(atlas.tileMeters),
    detailedLeaf = createTreeMaterial(atlas.texture, { measuredTrunks: true });
  detailedLeaf.opacityNode = visibility;
  const makeDetailed = (geometry, count, name) => {
    geometry.setAttribute('aTreeData', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
    geometry.setAttribute('aTreeShape', new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2));
    return make(geometry, detailedLeaf, count, name);
  };
  const broadleaf = prototypes.map((p) => ({
    ...p,
    nearMesh: makeDetailed(
      p.near,
      nearCapacity,
      `Surveyed ${TREE_SPECIES[p.species].name} branches and solid crowns — near v${p.variant}`,
    ),
    farMesh: makeDetailed(
      p.far,
      farCapacity,
      `Surveyed ${TREE_SPECIES[p.species].name} solid crowns — distant v${p.variant}`,
    ),
  }));
  const near = [make(buildSpruceCrown(true), leaf, nearCapacity, 'Surveyed evergreen layered crowns — near')];
  const far = [
    make(buildSpruceCrown(false), leaf, farCapacity, 'Surveyed evergreen layered crowns — distant'),
  ];
  const trunks = make(new THREE.CylinderGeometry(0.7, 1, 1, 7), bark, farCapacity, 'Surveyed tree trunks');
  const branches = make(branchGeometry(), bark, nearCapacity, 'Surveyed tree branches');
  const cellSize = 300,
    cellPools = new Map(),
    cellCapacity = indirectCells
      ? Math.max(
          1,
          new Set(
            records.map(
              ({ x, z }) =>
                `${Math.floor(Math.fround(x) / cellSize)},${Math.floor(Math.fround(z) / cellSize)}`,
            ),
          ).size,
        )
      : 0,
    cellDraws = indirectCells
      ? [
          ...broadleaf.flatMap(({ nearMesh, farMesh }) => [nearMesh, farMesh]),
          ...near,
          ...far,
          trunks,
          branches,
        ].map((mesh) => {
          const draw = createIndirectCellDraws(mesh, {
            cellSize,
            maxCells: cellCapacity,
            ...treeBoundsExpansion(mesh),
          });
          cellPools.set(mesh, {
            draw,
            instanceBounds: new Float64Array(mesh.instanceMatrix.count * 6),
          });
          return draw;
        })
      : [];
  const object = new THREE.Object3D(),
    tint = new THREE.Color(),
    boundsBox = new THREE.Box3(),
    instanceRecords = new WeakMap();
  function instanceData(tree) {
    let data = instanceRecords.get(tree);
    if (data) return data;
    // Inventory records, ground placement and prototypes stay immutable. Keep
    // the first Float32 conversion so later populations only copy GPU bytes.
    const p = tree.profile;
    object.position.set(tree.x, tree.baseY, tree.z);
    object.rotation.set(0, p.seed * Math.PI * 2, 0);
    if (p.form !== 2) {
      const prototype = broadleaf[p.species * 2 + p.variant],
        horizontal = p.width / prototype.radius,
        vertical = p.height / prototype.height;
      object.scale.set(horizontal, vertical, horizontal * (0.94 + p.seed * 0.12));
      object.updateMatrix();
      tint
        .setHex(TREE_SPECIES[p.species].tints[Math.floor(p.seed * 2.999)])
        .multiplyScalar(0.86 + p.seed * 0.2);
      const localDBH = 1.37 / vertical,
        t = Math.min(0.99, localDBH / prototype.trunk.top),
        trunkRadius = prototype.trunk.r * (1 - 0.7 * t ** 0.8) * (1 + 0.75 * Math.exp(-localDBH / 0.28)),
        correction = p.radius / Math.max(0.001, trunkRadius * horizontal);
      data = {
        matrix: new Float32Array(16),
        treeData: new Float32Array([tint.r, tint.g, tint.b, p.species + p.foliageSeed]),
        treeShape: new Float32Array([correction, vertical]),
      };
      object.matrix.toArray(data.matrix);
    } else {
      object.scale.set(p.width, p.height, p.width * (0.88 + p.seed * 0.14));
      object.updateMatrix();
      tint.setHex(p.needleTint).multiplyScalar(0.88 + p.seed * 0.2);
      data = {
        matrix: new Float32Array(16),
        color: new Float32Array(3),
        trunkMatrix: new Float32Array(16),
      };
      object.matrix.toArray(data.matrix);
      tint.toArray(data.color);
      object.scale.set(p.radius, p.height * 0.55, p.radius);
      object.position.y = tree.baseY + p.height * 0.275;
      object.updateMatrix();
      object.matrix.toArray(data.trunkMatrix);
    }
    instanceRecords.set(tree, data);
    return data;
  }
  function writeInstanceBounds(mesh, slot, data) {
    const pool = cellPools.get(mesh);
    if (!pool?.draw.stats.enabled) return;
    let bounds = data.bounds?.get(mesh);
    if (!bounds) {
      pool.draw.instanceBounds(slot, boundsBox);
      bounds = new Float64Array(6);
      boundsBox.min.toArray(bounds);
      boundsBox.max.toArray(bounds, 3);
      (data.bounds ??= new WeakMap()).set(mesh, bounds);
    }
    pool.instanceBounds.set(bounds, slot * 6);
  }
  const updatePopulation = (mesh, count, attributes = [mesh.instanceMatrix, mesh.instanceColor]) => {
    mesh.count = count;
    // A culled view may select zero from a populated pool. Only an empty
    // population can hide the mesh without losing its view/shadow callbacks.
    mesh.visible = count > 0;
    for (const attribute of attributes) {
      if (!attribute) continue;
      attribute.clearUpdateRanges();
      if (count) {
        attribute.addUpdateRange(0, count * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  };
  let lastX = Infinity,
    lastZ = Infinity,
    lastAerial,
    lastQuality;
  let retainedDetail = new Set();
  const inferredTrees = records.filter((record) => record.source === 'inferred-island-planting').length;
  const stats = {
    surveyedTrees: records.length - inferredTrees,
    inferredTrees,
    sourceTrees: (treeData.trees || []).length,
    visibleTrees: 0,
    detailedTrees: 0,
    detailedBroadleafTrees: 0,
    populationRebuilds: 0,
    fadeDistance: 0,
    cellDraws: cellDraws.map((draw) => draw.stats),
    prototypeTriangles: prototypes.map((p) => ({
      species: TREE_SPECIES[p.species].name,
      variant: p.variant,
      near: p.near.index.count / 3,
      far: p.far.index.count / 3,
    })),
  };
  function update(camera, quality = 'balanced') {
    const aerial = camera.position.y > 160;
    viewCenter.value.copy(camera.position);
    const stride = aerial ? 65 : 26;
    if (
      Math.hypot(camera.position.x - lastX, camera.position.z - lastZ) < stride &&
      aerial === lastAerial &&
      quality === lastQuality
    )
      return;
    lastX = camera.position.x;
    lastZ = camera.position.z;
    lastAerial = aerial;
    lastQuality = quality;
    const radius = aerial
      ? quality === 'high'
        ? 2850
        : quality === 'performance'
          ? 1600
          : 2150
      : quality === 'performance'
        ? 580
        : quality === 'high'
          ? 940
          : 790;
    const cap = aerial
      ? quality === 'high'
        ? 8500
        : quality === 'performance'
          ? 3300
          : 6000
      : quality === 'high'
        ? 4600
        : quality === 'performance'
          ? 1950
          : 3100;
    const prefetch = stride + (aerial ? 135 : 75);
    const selected = [...index.near(camera.position.x, camera.position.z, radius + prefetch)]
      .map((tree) => ({ tree, d: Math.hypot(tree.x - camera.position.x, tree.z - camera.position.z) }))
      .filter((t) => t.d < radius + prefetch)
      .sort((a, b) => a.d - b.d)
      .slice(0, cap);
    // All trees at the population boundary are already fully faded before a
    // new selection can evict them, including when a dense grove hits the cap.
    fadeEnd.value =
      selected.length < cap ? radius : Math.min(radius, Math.max(20, selected.at(-1).d - stride - 18));
    fadeWidth.value = aerial ? 280 : 110;
    stats.fadeDistance = fadeEnd.value;
    stats.populationRebuilds++;
    const nextDetail = new Set();
    const nearCounts = [0],
      farCounts = [0],
      broadNearCounts = new Array(broadleaf.length).fill(0),
      broadFarCounts = new Array(broadleaf.length).fill(0);
    let branchCount = 0,
      trunkCount = 0,
      detailedCount = 0,
      detailedBroadleaf = 0;
    for (const { tree, d } of selected) {
      const p = tree.profile,
        data = instanceData(tree);
      const detailed =
        !aerial &&
        d <
          (quality === 'high' ? 140 : quality === 'performance' ? 40 : 90) +
            (retainedDetail.has(tree) ? 14 : 0) &&
        detailedCount < (quality === 'high' ? 400 : quality === 'performance' ? 64 : 220);
      if (detailed) {
        detailedCount++;
        nextDetail.add(tree);
      }
      if (p.form !== 2) {
        const prototype = broadleaf[p.species * 2 + p.variant],
          counts = detailed ? broadNearCounts : broadFarCounts,
          mesh = detailed ? prototype.nearMesh : prototype.farMesh,
          n = counts[p.species * 2 + p.variant]++;
        mesh.instanceMatrix.array.set(data.matrix, n * 16);
        mesh.geometry.attributes.aTreeData.array.set(data.treeData, n * 4);
        mesh.geometry.attributes.aTreeShape.array.set(data.treeShape, n * 2);
        writeInstanceBounds(mesh, n, data);
        if (detailed) detailedBroadleaf++;
        continue;
      }
      const counts = detailed ? nearCounts : farCounts;
      const mesh = (detailed ? near : far)[0];
      const n = counts[0]++;
      mesh.instanceMatrix.array.set(data.matrix, n * 16);
      if (mesh.instanceColor === null)
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(mesh.instanceMatrix.count * 3).fill(1),
          3,
        );
      mesh.instanceColor.array.set(data.color, n * 3);
      writeInstanceBounds(mesh, n, data);
      if (detailed) {
        branches.instanceMatrix.array.set(data.matrix, branchCount * 16);
        writeInstanceBounds(branches, branchCount++, data);
      }
      trunks.instanceMatrix.array.set(data.trunkMatrix, trunkCount * 16);
      writeInstanceBounds(trunks, trunkCount++, data);
    }
    for (let i = 0; i < 1; i++)
      for (const [meshes, counts] of [
        [near, nearCounts],
        [far, farCounts],
      ]) {
        const mesh = meshes[i];
        updatePopulation(mesh, counts[i]);
        mesh.castShadow = meshes === near;
      }
    for (let i = 0; i < broadleaf.length; i++)
      for (const [mesh, count, detailed] of [
        [broadleaf[i].nearMesh, broadNearCounts[i], true],
        [broadleaf[i].farMesh, broadFarCounts[i], false],
      ]) {
        updatePopulation(mesh, count, [
          mesh.instanceMatrix,
          mesh.geometry.attributes.aTreeData,
          mesh.geometry.attributes.aTreeShape,
        ]);
        mesh.castShadow = detailed;
      }
    updatePopulation(trunks, trunkCount);
    updatePopulation(branches, branchCount);
    branches.castShadow = !aerial;
    retainedDetail = nextDetail;
    stats.visibleTrees = selected.length;
    stats.detailedTrees = detailedCount;
    stats.detailedBroadleafTrees = detailedBroadleaf;
    for (const pool of cellPools.values()) pool.draw.repack(pool);
  }
  return { update, stats, records, atlas, prototypes };
}
