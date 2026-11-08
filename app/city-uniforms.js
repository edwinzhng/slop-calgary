import * as THREE from 'three/webgpu';
import { max, smoothstep, uniform } from 'three/tsl';

// Shared by the Calgary facade, street, weather and lighting systems.
export const windowGlow = uniform(0);
export const headlightWeather = uniform(0);
export const headlightPower = max(headlightWeather, smoothstep(0.26, 1.35, windowGlow));
export const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xffca92)),
  uSkyTopColor: uniform(new THREE.Color(0x547b9e)),
  uSkyHorizonColor: uniform(new THREE.Color(0xd6d1c0)),
  uSkySunDir: uniform(new THREE.Vector3(-0.66, 0.34, -0.67).normalize()),
  uInteriorGlow: uniform(0.48),
  uRoadWetness: uniform(0),
  uCanyonBounce: uniform(0.52),
  uSnow: uniform(0),
  uTheme: uniform(0),
  uFacadeDetailDistance: uniform(360),
};
