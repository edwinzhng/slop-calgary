import * as THREE from 'three/webgpu';
import { attribute, color, float, mix, positionWorld, sin, step } from 'three/tsl';
import { windowGlow } from './city-uniforms.js';
import { lightingUniforms } from './landmark-lighting.js';
import { PEACE_ANCHORS, PEACE_WALKWAY } from './peace-surfaces.js';
import { concreteArchRibOffset, kingBalustradeFixtures, trussHalfWidth } from './bridge-connections.js';
import { collectSurveyedBridgeLighting } from './bridge-surveyed-lighting.js';

// These are geographic representations of documented lighting treatments.
// Fixture spacing, photometry and the original illustrative shows are inferred;
// no live civic/ceremonial lighting calendar is claimed or reproduced.
export const BRIDGE_DETAIL_LIMITS = Object.freeze({
  balancedRadius: 2500,
  highRadius: 4300,
  cableRadius: 0.009,
  peaceCableSpacing: 0.075,
  maxEmissiveDraws: 7,
  maxPointLights: 0,
});

const [north, south] = PEACE_ANCHORS,
  clamp = (value, a, b) => Math.max(a, Math.min(b, value));

function sample(plan, t) {
  const wanted = clamp(t, 0, 1) * plan.length;
  let travelled = 0;
  for (let i = 1; i < plan.points.length; i++) {
    const a = plan.points[i - 1],
      b = plan.points[i],
      length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (travelled + length >= wanted || i === plan.points.length - 1) {
      const u = clamp((wanted - travelled) / Math.max(length, 0.001), 0, 1);
      return {
        x: a[0] + (b[0] - a[0]) * u,
        z: a[1] + (b[1] - a[1]) * u,
        dx: (b[0] - a[0]) / length,
        dz: (b[1] - a[1]) / length,
      };
    }
    travelled += length;
  }
}

export function collectBridgeDetailBeams(surfaces, context = {}) {
  const groups = [],
    cables = [],
    heightAt = context.heightAt || ((plan) => plan.level),
    add = (group, a, b, radius, color, kind) => group.beams.push({ a, b, radius, color, kind }),
    frame = (plan, t, side, above) => {
      const p = sample(plan, t);
      return [p.x - p.dz * side, heightAt(plan, t) + above, p.z + p.dx * side];
    };
  for (const plan of surfaces.plans) {
    if (
      ![
        'Reconciliation Bridge',
        'George C. King Bridge',
        'Jaipur Bridge',
        'Centre Street Bridge',
        'Elbow River Traverse',
      ].includes(plan.name)
    )
      continue;
    const middle = sample(plan, 0.5),
      group = { name: plan.name, x: middle.x, z: middle.z, beams: [] };
    groups.push(group);
    if (plan.name === 'Reconciliation Bridge') {
      for (let span = 0; span < plan.spans; span++)
        for (const side of [-1, 1])
          for (let panel = 0; panel < 8; panel++) {
            const u = panel / 8,
              v = (panel + 1) / 8,
              t = (span + u) / plan.spans,
              next = (span + v) / plan.spans,
              offset = side * (trussHalfWidth(plan) + 0.21),
              crown = (q) => 8 * (0.6 + 0.4 * Math.sin(Math.PI * q)),
              tint = panel % 2 ? 0xffc995 : 0xf0ae73;
            add(
              group,
              frame(plan, t, offset, crown(u)),
              frame(plan, next, offset, crown(v)),
              0.046,
              tint,
              'truss-feature-light',
            );
            add(
              group,
              frame(plan, t, offset, 0.28),
              frame(plan, t, offset, crown(u) - 0.2),
              0.033,
              tint,
              'truss-feature-light',
            );
          }
      for (const side of [-1, 1])
        for (let i = 0, n = Math.ceil(plan.length / 4); i < n; i++)
          add(
            group,
            frame(plan, i / n, side * (plan.width / 2 - 0.14), 0.62),
            frame(plan, (i + 1) / n, side * (plan.width / 2 - 0.14), 0.62),
            0.024,
            0xe9f0ee,
            'pedestrian-light',
          );
    } else if (plan.name === 'George C. King Bridge') {
      // The designer's close reference shows inclined dark fixture fins, a
      // flush luminous face and horizontal cable infill. Match those same fin
      // endpoints; the physical bodies are part of the nearby shared batch.
      for (const fixture of kingBalustradeFixtures(plan, heightAt)) {
        const at = (fraction) => fixture.bottom.map((v, i) => v + (fixture.top[i] - v) * fraction),
          a = at(0.12),
          b = at(0.92),
          q = sample(plan, fixture.t);
        // Place the luminous insert on the inward face of its steel fin.
        for (const p of [a, b]) {
          p[0] += q.dz * fixture.side * 0.076;
          p[2] -= q.dx * fixture.side * 0.076;
        }
        add(group, a, b, 0.021, fixture.index % 5 < 2 ? 0x9fcaff : 0xe5f1ff, 'balustrade-light');
      }
    } else if (plan.name === 'Elbow River Traverse') {
      // RJC explicitly describes an LED integrated in the handrail underside.
      // It remains a restrained mesh proxy, without invented floodlights.
      const n = Math.ceil(plan.length / 4);
      for (let i = 0; i < n; i++)
        for (const side of [-1, 1])
          add(
            group,
            frame(plan, i / n, side * (plan.width / 2 + 0.035), 1.083),
            frame(plan, (i + 0.97) / n, side * (plan.width / 2 + 0.035), 1.083),
            0.011,
            0xf2eedb,
            'underside-handrail-light',
          );
    } else if (plan.name === 'Jaipur Bridge') {
      const n = Math.ceil(plan.length / 3.5);
      for (let i = 0; i < n; i++)
        for (const side of [-1, 1])
          add(
            group,
            frame(plan, i / n, side * (plan.width / 2 - 0.2), 0.55),
            frame(plan, (i + 0.82) / n, side * (plan.width / 2 - 0.2), 0.55),
            0.026,
            0xffe0a7,
            'screen-light',
          );
    } else {
      // The City records the completed2013 feature-lighting installation. This
      // uses restrained arch/lion accents, not the unbuilt2011 concept scheme.
      for (let span = 0; span < plan.spans; span++)
        for (const side of [-1, 1])
          for (let i = 0; i < 16; i++) {
            const u = i / 16,
              v = (i + 1) / 16,
              spring = -Math.min(5.5, (plan.length / plan.spans) * 0.13),
              arch = (q) => spring + (-0.65 - spring) * Math.sin(Math.PI * q),
              // The warm accent follows the exposed arch rib. The previous
              // outer-wall offset would float once the solid infill is gone.
              offset = side * (concreteArchRibOffset(plan) + 0.41);
            add(
              group,
              frame(plan, (span + u) / plan.spans, offset, arch(u)),
              frame(plan, (span + v) / plan.spans, offset, arch(v)),
              0.04,
              0xffd29b,
              'arch-feature-light',
            );
          }
      for (const t of [0.06, 0.94])
        for (const side of [-1, 1]) {
          const a = frame(plan, t - 0.004, side * (plan.width / 2 + 0.1), 1.62),
            b = frame(plan, t + 0.004, side * (plan.width / 2 + 0.1), 1.62);
          add(group, a, b, 0.065, 0xffe8bf, 'lion-plinth-light');
        }
    }
  }
  if (context.includePeace !== false) {
    const length = Math.hypot(south[0] - north[0], south[1] - north[1]),
      dx = (south[0] - north[0]) / length,
      dz = (south[1] - north[1]) / length,
      at = (t, offset, y) => [
        north[0] + dx * length * t - dz * offset,
        y,
        north[1] + dz * length * t + dx * offset,
      ],
      group = { name: 'Peace Bridge', x: (north[0] + south[0]) / 2, z: (north[1] + south[1]) / 2, beams: [] };
    groups.push(group);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 32; i++) {
        add(
          group,
          at(i / 32, side * (PEACE_WALKWAY.guardOffset - 0.045), PEACE_WALKWAY.railTop - 0.05),
          at((i + 1) / 32, side * (PEACE_WALKWAY.guardOffset - 0.045), PEACE_WALKWAY.railTop - 0.05),
          0.028,
          0xf2eee2,
          'handrail-light',
        );
      }
      // Only the infill is added. The landmark owns its existing top and base
      // rails, roof glazing and red helices. Exact cable/post spacing is an
      // explicitly inferred approximation of the completed2023 repair.
      const n = Math.ceil(length / 3.2);
      for (let i = 0; i < n; i++)
        for (
          let y = PEACE_WALKWAY.railBase + 0.03;
          y < PEACE_WALKWAY.railTop - 0.03;
          y += BRIDGE_DETAIL_LIMITS.peaceCableSpacing
        )
          cables.push({
            a: at(i / n, side * PEACE_WALKWAY.guardOffset, y),
            b: at((i + 1) / n, side * PEACE_WALKWAY.guardOffset, y),
            radius: BRIDGE_DETAIL_LIMITS.cableRadius,
            color: 0xadb9b5,
            kind: 'tension-cable-infill',
          });
      for (let i = 1; i < n; i++)
        cables.push({
          a: at(i / n, side * PEACE_WALKWAY.guardOffset, PEACE_WALKWAY.railBase),
          b: at(i / n, side * PEACE_WALKWAY.guardOffset, PEACE_WALKWAY.railTop),
          radius: 0.025,
          color: 0xabb8b5,
          kind: 'infill-post',
        });
    }
    for (let i = 0; i < 32; i++)
      add(
        group,
        at(i / 32, 0, PEACE_WALKWAY.crownLight),
        at((i + 0.85) / 32, 0, PEACE_WALKWAY.crownLight),
        0.028,
        0xf4eee1,
        'canopy-light',
      );
  }
  const surveyed = collectSurveyedBridgeLighting(surfaces);
  groups.push(...surveyed.groups);
  return { groups, cables, surveyed };
}

function geometryFor(beams) {
  const indexed = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true),
    prototype = indexed.toNonIndexed(),
    cappedIndexed = new THREE.CylinderGeometry(1, 1, 1, 5, 1, false),
    cappedPrototype = cappedIndexed.toNonIndexed(),
    positions = [],
    normals = [],
    colors = [],
    bodyColors = [],
    shows = [],
    transform = new THREE.Matrix4(),
    normalTransform = new THREE.Matrix3(),
    a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    direction = new THREE.Vector3(),
    quaternion = new THREE.Quaternion(),
    up = new THREE.Vector3(0, 1, 0),
    scale = new THREE.Vector3(),
    vertex = new THREE.Vector3(),
    normal = new THREE.Vector3(),
    tint = new THREE.Color(),
    bodyTint = new THREE.Color();
  indexed.dispose();
  cappedIndexed.dispose();
  for (const beam of beams) {
    a.fromArray(beam.a);
    b.fromArray(beam.b);
    direction.subVectors(b, a);
    const length = direction.length();
    if (length < 0.001) continue;
    quaternion.setFromUnitVectors(up, direction.normalize());
    transform.compose(a.add(b).multiplyScalar(0.5), quaternion, scale.set(beam.radius, length, beam.radius));
    normalTransform.getNormalMatrix(transform);
    tint.setHex(beam.color);
    bodyTint.setHex(beam.bodyColor ?? 0x343c3d);
    const show = beam.kind === 'truss-feature-light' ? 1 : beam.kind === 'balustrade-light' ? 2 : 0;
    const source = beam.capped ? cappedPrototype : prototype,
      p = source.attributes.position,
      n = source.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      vertex.fromBufferAttribute(p, i).applyMatrix4(transform);
      normal.fromBufferAttribute(n, i).applyMatrix3(normalTransform).normalize();
      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(tint.r, tint.g, tint.b);
      bodyColors.push(bodyTint.r, bodyTint.g, bodyTint.b);
      shows.push(show);
    }
  }
  prototype.dispose();
  cappedPrototype.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('bodyColor', new THREE.Float32BufferAttribute(bodyColors, 3));
  geometry.setAttribute('bridgeShow', new THREE.Float32BufferAttribute(shows, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildBridgeDetails(scene, surfaces, context = {}) {
  const definitions = collectBridgeDetailBeams(surfaces, context),
    lightMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x343c3d, roughness: 0.55 }),
    cableMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xb1bcb9, roughness: 0.42, metalness: 0.7 }),
    meshes = [];
  const show = attribute('bridgeShow', 'float'),
    reconciliation = step(float(0.5), show).mul(float(1).sub(step(float(1.5), show))),
    king = step(float(1.5), show),
    flow = sin(
      positionWorld.x.mul(0.045).add(positionWorld.z.mul(0.045)).sub(lightingUniforms.time.mul(0.12)),
    )
      .mul(0.5)
      .add(0.5),
    kingColor = mix(color(0x90c9ef), color(0xe5f1ff), flow).mul(float(0.8).add(flow.mul(0.2))),
    trussColor = mix(attribute('color', 'vec3'), lightingUniforms.reconciliation, reconciliation);
  // Both original shows run in the shared material. The clock freezes under
  // reduced motion; pedestrian/handrail lighting remains steady and legible.
  // Keep animated colours below the white clipping range on the direct WebGL
  // path; steady safety lighting retains its brighter neutral treatment.
  const intensity = mix(float(2.4), float(0.95), step(float(0.5), show));
  lightMaterial.emissiveNode = mix(trussColor, kingColor, king).mul(windowGlow).mul(intensity);
  lightMaterial.colorNode = attribute('bodyColor', 'vec3');
  for (const group of definitions.groups) {
    const mesh = new THREE.Mesh(geometryFor(group.beams), lightMaterial);
    mesh.name = `${group.name} / documented night-light treatment`;
    mesh.castShadow = false;
    scene.add(mesh);
    meshes.push({ mesh, x: group.x, z: group.z, name: group.name });
  }
  if (definitions.cables.length) {
    const mesh = new THREE.Mesh(geometryFor(definitions.cables), cableMaterial),
      peace = definitions.groups.find((group) => group.name === 'Peace Bridge');
    mesh.name = 'Peace Bridge /2023 steel tension-cable railing infill';
    mesh.castShadow = false;
    scene.add(mesh);
    meshes.push({ mesh, x: peace.x, z: peace.z, name: 'Peace Bridge infill' });
  }
  const stats = {
    lightBridges: definitions.groups.length,
    animatedBridges: definitions.groups.filter((group) =>
      group.beams.some((beam) => beam.kind === 'truss-feature-light' || beam.kind === 'balustrade-light'),
    ).length,
    emissiveBeams: definitions.groups.reduce(
      (sum, group) => sum + group.beams.filter((beam) => beam.emissive !== false).length,
      0,
    ),
    unlitSupportBeams: definitions.groups.reduce(
      (sum, group) => sum + group.beams.filter((beam) => beam.emissive === false).length,
      0,
    ),
    surveyedSourceHeads: definitions.surveyed.sourceHeads,
    surveyedMountedHeads: definitions.surveyed.fixtures.length,
    surveyedSkippedHeads: definitions.surveyed.skipped.length,
    cableBeams: definitions.cables.length,
    drawCalls: meshes.length,
    pointLights: 0,
    triangles: meshes.reduce((sum, { mesh }) => sum + mesh.geometry.attributes.position.count / 3, 0),
  };
  return {
    definitions,
    meshes,
    stats,
    update(camera, quality = 'balanced') {
      const radius =
        quality === 'high' ? BRIDGE_DETAIL_LIMITS.highRadius : BRIDGE_DETAIL_LIMITS.balancedRadius;
      for (const item of meshes)
        item.mesh.visible = Math.hypot(item.x - camera.position.x, item.z - camera.position.z) < radius;
    },
    dispose() {
      for (const { mesh } of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      lightMaterial.dispose();
      cableMaterial.dispose();
    },
  };
}
