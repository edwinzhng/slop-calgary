import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color, mix } from 'three/tsl';
import { headlightPower } from './city-uniforms.js';

const UP = new THREE.Vector3(0, 1, 0);
let travelLampMaterial;

export function travelLamp(geometry) {
  if (!travelLampMaterial) {
    travelLampMaterial = new THREE.MeshBasicNodeMaterial();
    travelLampMaterial.colorNode = mix(color(0xb4c6c3), color(0xfff5d9).mul(4), headlightPower);
  }
  return new THREE.Mesh(geometry, travelLampMaterial);
}

export function painted(geometry, value) {
  const color = new THREE.Color(value),
    values = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < values.length; i += 3) {
    values[i] = color.r;
    values[i + 1] = color.g;
    values[i + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
  geometry.deleteAttribute('uv');
  return geometry;
}
export function combine(parts) {
  const result = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  result.computeBoundingSphere();
  return result;
}
export function ellipsoid(x, y, z, rx, ry, rz, value, detail = 14) {
  const geometry = new THREE.SphereGeometry(1, detail, Math.max(8, Math.round(detail * 0.7)));
  geometry.scale(rx, ry, rz);
  geometry.translate(x, y, z);
  return painted(geometry, value);
}
export function box(x, y, z, w, h, d, value) {
  return painted(new THREE.BoxGeometry(w, h, d).translate(x, y, z), value);
}
export function tube(a, b, radius, value, radialSegments = 10, endRadius = radius) {
  const start = new THREE.Vector3(...a),
    end = new THREE.Vector3(...b),
    delta = end.clone().sub(start);
  const geometry = new THREE.CylinderGeometry(endRadius, radius, delta.length(), radialSegments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, delta.normalize()));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return painted(geometry, value);
}
