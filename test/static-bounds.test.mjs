import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { prepareFreshStaticBounds, prepareSceneBounds } from '../app/static-bounds.js';

const positions = [-3, 2, 1, 4, -5, 6, 1, 3, -2, 80, -90, 100];

function geometry(values = positions, Attribute = THREE.BufferAttribute) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new Attribute(new Float32Array(values), 3));
  return result;
}

function boundBits(geometry) {
  const numbers = [];
  if (geometry.boundingBox)
    numbers.push(...geometry.boundingBox.min.toArray(), ...geometry.boundingBox.max.toArray());
  if (geometry.boundingSphere)
    numbers.push(...geometry.boundingSphere.center.toArray(), geometry.boundingSphere.radius);
  return new Uint8Array(new Float64Array(numbers).buffer);
}

function preserveSource(g) {
  const names = Object.keys(g.attributes),
    attributes = g.attributes,
    index = g.index,
    morph = g.morphAttributes,
    morphNames = Object.keys(morph),
    morphArrays = morphNames.map((name) => morph[name]),
    groups = g.groups,
    groupValues = groups.map((group) => ({ ...group })),
    drawRange = g.drawRange,
    rangeValues = { ...drawRange },
    boxMethod = g.computeBoundingBox,
    sphereMethod = g.computeBoundingSphere,
    refs = [...Object.values(attributes), index, ...Object.values(morph).flat()].filter(Boolean),
    states = refs.map((attribute) => ({
      attribute,
      array: attribute.array,
      bytes: attribute.array ? new Uint8Array(attribute.array.buffer).slice() : null,
      count: attribute.count,
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
      usage: attribute.usage,
      version: attribute.version,
      gpuType: attribute.gpuType,
      ranges: attribute.updateRanges?.map((range) => ({ ...range })),
      data: attribute.data,
      dataVersion: attribute.data?.version,
    }));
  return () => {
    assert.equal(g.attributes, attributes);
    assert.deepEqual(Object.keys(g.attributes), names);
    for (const { attribute, ...state } of states) {
      for (const key of ['array', 'count', 'itemSize', 'normalized', 'usage', 'version', 'gpuType', 'data'])
        assert.equal(attribute[key], state[key]);
      if (state.bytes) assert.deepEqual(new Uint8Array(attribute.array.buffer), state.bytes);
      if (state.ranges) assert.deepEqual(attribute.updateRanges, state.ranges);
      assert.equal(attribute.data?.version, state.dataVersion);
    }
    names.forEach((name, i) => assert.equal(g.attributes[name], refs[i]));
    assert.equal(g.index, index);
    assert.equal(g.morphAttributes, morph);
    assert.deepEqual(Object.keys(g.morphAttributes), morphNames);
    morphNames.forEach((name, i) => assert.equal(g.morphAttributes[name], morphArrays[i]));
    assert.equal(g.groups, groups);
    assert.deepEqual(g.groups, groupValues);
    assert.equal(g.drawRange, drawRange);
    assert.deepEqual(g.drawRange, rangeValues);
    assert.equal(g.computeBoundingBox, boxMethod);
    assert.equal(g.computeBoundingSphere, sphereMethod);
  };
}

function compareWithThree(g) {
  const expected = new THREE.BufferGeometry(),
    unchanged = preserveSource(g);
  expected.setAttribute('position', g.attributes.position);
  expected.setIndex(g.index);
  try {
    expected.computeBoundingBox();
    expected.computeBoundingSphere();
    assert.equal(prepareFreshStaticBounds(g), true);
    assert.deepEqual(
      boundBits(g),
      boundBits(expected),
      'all ten Float64 values must match actual Three bit for bit',
    );
    unchanged();
    const box = g.boundingBox,
      sphere = g.boundingSphere,
      original = boundBits(g).slice();
    assert.equal(prepareFreshStaticBounds(g), false);
    assert.equal(g.boundingBox, box);
    assert.equal(g.boundingSphere, sphere);
    assert.deepEqual(boundBits(g), original);
  } finally {
    expected.dispose();
  }
}

test('fresh bounds match actual Three Float64 bits for signed zero, subnormals and Float32 extremes', () => {
  const tiny = 2 ** -149,
    large = 3.4028234663852886e38,
    cases = [
      [-0, -0, -0, -0, -0, -0],
      [-0, 0, -0, 0, -0, 0],
      [-tiny, tiny * 2, -tiny * 3, tiny * 4, -tiny * 5, tiny * 6],
      [-large, large, -large, large, -large, large, large / 2, large / 4, -large / 8],
      Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.37) * (i % 13 ? 300 : 1e15)),
    ];
  for (const Attribute of [THREE.BufferAttribute, THREE.Float32BufferAttribute])
    for (const values of cases) {
      const g = geometry(values, Attribute);
      try {
        compareWithThree(g);
      } finally {
        g.dispose();
      }
    }
});

test('offset views and unused indexed vertices retain all source attributes, groups and draw ranges', () => {
  const g = new THREE.BufferGeometry(),
    backing = new Float32Array([1e30, -1e30, 1e30, ...positions, -1e30, 1e30, -1e30]),
    position = new THREE.BufferAttribute(new Float32Array(backing.buffer, 12, positions.length), 3),
    indices = new Uint16Array([999, 0, 1, 2, 999]);
  position.name = 'source view';
  position.addUpdateRange(3, 3);
  g.setAttribute('position', position);
  g.setAttribute('color', new THREE.Uint8BufferAttribute([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3, true));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(indices.buffer, 2, 3), 1));
  g.addGroup(1, 1, 0);
  g.setDrawRange(1, 1);
  try {
    compareWithThree(g);
    assert.equal(g.boundingBox.max.x, 80, 'Three includes vertices outside index, groups and drawRange');
    assert.equal(g.boundingBox.max.z, 100);
    assert.equal(g.boundingBox.min.y, -90);
    assert.equal(position.array.byteOffset, 12);
    assert.equal(g.index.array.byteOffset, 2);
  } finally {
    g.dispose();
  }
});

test('unsupported position storage and custom bound semantics are declined without invoking hooks', () => {
  class CustomAttribute extends THREE.BufferAttribute {}
  const variants = [
    ['missing', (g) => g.deleteAttribute('position')],
    ['empty', (g) => g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3))],
    ['Float64', (g) => g.setAttribute('position', new THREE.BufferAttribute(new Float64Array(positions), 3))],
    [
      'normalized',
      (g) => {
        g.attributes.position.normalized = true;
      },
    ],
    ['DynamicDrawUsage', (g) => g.attributes.position.setUsage(THREE.DynamicDrawUsage)],
    ['StreamDrawUsage', (g) => g.attributes.position.setUsage(THREE.StreamDrawUsage)],
    [
      'item size',
      (g) => g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 2)),
    ],
    [
      'fractional count',
      (g) => {
        g.attributes.position.count = 1.5;
      },
    ],
    [
      'unpacked count',
      (g) => {
        g.attributes.position.count = 3;
      },
    ],
    [
      'NaN',
      (g) => {
        g.attributes.position.array[0] = NaN;
      },
    ],
    [
      'Infinity',
      (g) => {
        g.attributes.position.array[0] = Infinity;
      },
    ],
    [
      'instanced attribute',
      (g) => g.setAttribute('position', new THREE.InstancedBufferAttribute(new Float32Array(positions), 3)),
    ],
    [
      'interleaved',
      (g) =>
        g.setAttribute(
          'position',
          new THREE.InterleavedBufferAttribute(
            new THREE.InterleavedBuffer(new Float32Array(positions), 4),
            3,
            1,
          ),
        ),
    ],
    [
      'custom attribute',
      (g) => g.setAttribute('position', new CustomAttribute(new Float32Array(positions), 3)),
    ],
    [
      'custom getX',
      (g) => {
        g.attributes.position.getX = () => {
          throw Error('custom getter ran');
        };
      },
    ],
    [
      'custom box',
      (g) => {
        g.computeBoundingBox = () => {
          throw Error('custom box ran');
        };
      },
    ],
    [
      'custom sphere',
      (g) => {
        g.computeBoundingSphere = () => {
          throw Error('custom sphere ran');
        };
      },
    ],
    [
      'morphs',
      (g) => {
        g.morphAttributes.position = [g.attributes.position.clone()];
      },
    ],
    [
      'instanced geometry',
      (g) => {
        g.isInstancedBufferGeometry = true;
      },
    ],
  ];
  for (const [label, alter] of variants) {
    const g = geometry();
    try {
      alter(g);
      const unchanged = preserveSource(g);
      assert.equal(prepareFreshStaticBounds(g), false, label);
      assert.equal(g.boundingBox, null, label);
      assert.equal(g.boundingSphere, null, label);
      unchanged();
    } finally {
      g.dispose();
    }
  }
  for (const value of [null, undefined, {}, []]) assert.equal(prepareFreshStaticBounds(value), false);
});

test('authored full or partial bounds are retained by identity and Float64 bytes', () => {
  for (const mode of ['box', 'sphere', 'both']) {
    const g = geometry();
    if (mode !== 'sphere')
      g.boundingBox = new THREE.Box3(
        new THREE.Vector3(-1000, -0, -1000),
        new THREE.Vector3(1000, 2000, 1000),
      );
    if (mode !== 'box') g.boundingSphere = new THREE.Sphere(new THREE.Vector3(-0, 4, -3), 5000);
    const box = g.boundingBox,
      sphere = g.boundingSphere,
      original = boundBits(g).slice(),
      unchanged = preserveSource(g);
    try {
      assert.equal(prepareFreshStaticBounds(g), false);
      assert.equal(g.boundingBox, box);
      assert.equal(g.boundingSphere, sphere);
      assert.deepEqual(boundBits(g), original);
      unchanged();
    } finally {
      g.dispose();
    }
  }
});

test('ordinary scene owners can share prepared geometry without changing source data or authored bounds', () => {
  const scene = new THREE.Scene(),
    g = geometry(),
    material = new THREE.MeshBasicMaterial(),
    nodeMaterial = new THREE.MeshBasicNodeMaterial(),
    first = new THREE.Mesh(g, material),
    second = new THREE.Mesh(g, [material]),
    third = new THREE.Mesh(g, nodeMaterial),
    unchanged = preserveSource(g);
  scene.add(first, second, third);
  try {
    const prepare = prepareSceneBounds(scene);
    assert.equal(g.boundingBox, null, 'scene inspection must not eagerly prepare bounds');
    assert.equal(g.boundingSphere, null);
    assert.equal(prepare(second), true);
    const box = g.boundingBox,
      sphere = g.boundingSphere,
      original = boundBits(g).slice();
    assert.equal(prepare(first), false, 'shared geometry is prepared only once');
    assert.equal(prepare(third), false);
    assert.equal(g.boundingBox, box);
    assert.equal(g.boundingSphere, sphere);
    assert.deepEqual(boundBits(g), original);
    unchanged();
  } finally {
    g.dispose();
    material.dispose();
    nodeMaterial.dispose();
  }
});

test('any unsafe owner vetoes shared geometry even below a hidden group', () => {
  const factories = [
    ['line', (g, m) => new THREE.Line(g, m)],
    ['instanced', (g, m) => new THREE.InstancedMesh(g, m, 1)],
    ['skinned', (g, m) => new THREE.SkinnedMesh(g, m)],
    [
      'batched',
      (g, m) => {
        const object = new THREE.BatchedMesh(1, 3, 3, m);
        object.geometry.dispose();
        object.geometry = g;
        return object;
      },
    ],
    ...[
      'positionNode',
      'vertexNode',
      'geometryNode',
      'castShadowPositionNode',
      'displacementNode',
      'displacementMap',
    ].map((key) => [
      key,
      (g, m) => {
        m[key] = {};
        return new THREE.Mesh(g, [new THREE.MeshBasicMaterial(), m]);
      },
    ]),
    ...['onBeforeRender', 'onBeforeCompile'].map((key) => [
      `material ${key}`,
      (g, m) => {
        m[key] = () => {};
        return new THREE.Mesh(g, m);
      },
    ]),
    ...['onBeforeRender', 'onBeforeShadow', 'onAfterRender', 'onAfterShadow'].map((key) => [
      `object ${key}`,
      (g, m) => {
        const object = new THREE.Mesh(g, m);
        object[key] = () => {};
        return object;
      },
    ]),
    ...['setupPosition', 'setupVertex'].map((key) => [
      `node material ${key}`,
      (g) => {
        const material = new THREE.MeshBasicNodeMaterial();
        material[key] = () => {
          throw Error('custom vertex setup ran');
        };
        return new THREE.Mesh(g, material);
      },
    ]),
    ...['boundingBox', 'boundingSphere'].map((key) => [
      `object ${key}`,
      (g, m) => {
        const object = new THREE.Mesh(g, m);
        object[key] = null;
        return object;
      },
    ]),
    ['shader material', (g) => new THREE.Mesh(g, new THREE.ShaderMaterial())],
    [
      'missing material',
      (g, m) => {
        const object = new THREE.Mesh(g, m);
        object.material = null;
        return object;
      },
    ],
  ];
  for (const [label, create] of factories) {
    const scene = new THREE.Scene(),
      hidden = new THREE.Group(),
      g = geometry(),
      safeMaterial = new THREE.MeshBasicMaterial(),
      unsafeMaterial = new THREE.MeshBasicMaterial(),
      safe = new THREE.Mesh(g, safeMaterial),
      unsafe = create(g, unsafeMaterial),
      unchanged = preserveSource(g);
    hidden.visible = false;
    hidden.add(unsafe);
    scene.add(safe, hidden);
    try {
      const prepare = prepareSceneBounds(scene);
      assert.equal(prepare(safe), false, label);
      assert.equal(prepare(unsafe), false, label);
      assert.equal(g.boundingBox, null, label);
      assert.equal(g.boundingSphere, null, label);
      unchanged();
    } finally {
      if (unsafe.isInstancedMesh || unsafe.isBatchedMesh) unsafe.dispose();
      g.dispose();
      for (const m of new Set([
        safeMaterial,
        unsafeMaterial,
        ...(Array.isArray(unsafe.material) ? unsafe.material : [unsafe.material]),
      ]))
        m?.dispose();
    }
  }
});

test('the callback rechecks current owner eligibility before filling fresh bounds', () => {
  const scene = new THREE.Scene(),
    g = geometry(),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.Mesh(g, material);
  scene.add(mesh);
  try {
    const prepare = prepareSceneBounds(scene);
    material.positionNode = {};
    assert.equal(prepare(mesh), false);
    assert.equal(g.boundingBox, null);
    assert.equal(g.boundingSphere, null);
  } finally {
    g.dispose();
    material.dispose();
  }
});
