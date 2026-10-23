import * as THREE from "three";
export { buildWaterGeometry, prepareWaterTransition } from "./waterGeometry.js";

/** One periodic, mipmapped normal/foam texture, reused across mode switches. */
let detailTexture: THREE.DataTexture | null = null;
function waterDetail(): THREE.DataTexture {
  if (detailTexture) return detailTexture;
  const size = 128, heights = new Float32Array(size * size), noise = new Float32Array(size * size);
  const hash = (x: number, y: number) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const value = (x: number, y: number, period: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix % period, iy % period), b = hash((ix + 1) % period, iy % period);
    const c = hash(ix % period, (iy + 1) % period), d = hash((ix + 1) % period, (iy + 1) % period);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    heights[i] = value(x / 8, y / 8, 16) * 0.65 + value(x / 4, y / 4, 32) * 0.35;
    noise[i] = value(x / 16, y / 16, 8) * 0.7 + value(x / 4, y / 4, 32) * 0.3;
  }
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const dx = heights[y * size + (x + 1) % size]! - heights[y * size + (x + size - 1) % size]!;
    const dy = heights[((y + 1) % size) * size + x]! - heights[((y + size - 1) % size) * size + x]!;
    bytes[i * 4] = Math.round(THREE.MathUtils.clamp(0.5 + dx * 2.5, 0, 1) * 255);
    bytes[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(0.5 + dy * 2.5, 0, 1) * 255);
    bytes[i * 4 + 2] = Math.round(noise[i]! * 255); bytes[i * 4 + 3] = Math.round(heights[i]! * 255);
  }
  detailTexture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  detailTexture.wrapS = detailTexture.wrapT = THREE.RepeatWrapping;
  detailTexture.magFilter = THREE.LinearFilter; detailTexture.minFilter = THREE.LinearMipmapLinearFilter;
  detailTexture.generateMipmaps = true; detailTexture.needsUpdate = true;
  return detailTexture;
}
const uniforms = {
  uTime: { value: 0 }, uOrigin: { value: new THREE.Vector2() },
  uWaterDetail: { value: null as THREE.DataTexture | null },
  uSky: { value: new THREE.Color(0xb9e4f2) }, uDeep: { value: new THREE.Color(0x126c83) },
};
const VERTEX_HEAD = /* glsl */ `
attribute float aWave;
attribute float aWet;
attribute float aFoam;
attribute float aDepth;
attribute vec3 aFlow;
attribute vec4 aTransition;
attribute vec3 aImpact;
uniform float uTime;
uniform vec2 uOrigin;
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec3 vFlow;
varying vec3 vWater;
varying vec3 vImpact;
float swell(vec2 p, float t) {
  return 0.018 * sin(dot(p, vec2(0.58904862, 0.39269908)) + t * 0.9)
       + 0.011 * sin(dot(p, vec2(-0.39269908, 0.98174770)) + t * 1.3);
}
`;
const FRAGMENT_HEAD = /* glsl */ `
uniform float uTime;
uniform vec2 uOrigin;
uniform vec3 uSky;
uniform vec3 uDeep;
uniform sampler2D uWaterDetail;
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec3 vFlow;
varying vec3 vWater;
varying vec3 vImpact;
// Overlapping phases advect the pattern without a periodic reset/pop.
vec4 waterNoise(vec2 p, vec2 drift) {
  float phase = fract(uTime * 0.05);
  float other = fract(uTime * 0.05 + 0.5);
  float weight = 1.0 - abs(2.0 * phase - 1.0);
  return mix(texture2D(uWaterDetail, p - drift * other), texture2D(uWaterDetail, p - drift * phase), weight);
}
`;

/** Lit, shadowed, fogged water with no reflection camera or extra scene pass. */
export function makeWaterMaterial(): THREE.MeshStandardMaterial {
  uniforms.uWaterDetail.value = waterDetail();
  const material = new THREE.MeshStandardMaterial({
    color: 0x389fbe, roughness: 0.19, metalness: 0,
    transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
    // Avoid stacking separate back/front transparent passes in every chunk.
    forceSinglePass: true,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_HEAD}`)
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        float age = clamp((uTime - aTransition.w) / 0.18, 0.0, 1.0);
        transformed = mix(aTransition.xyz, transformed, age * age * (3.0 - 2.0 * age));
        vec3 wp0 = (modelMatrix * vec4(transformed, 1.0)).xyz;
        // No face-normal displacement: it would split a waterfall's edges.
        transformed.y += aWave * swell(wp0.xz + uOrigin, uTime);
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
        vFlow = aFlow; vWater = vec3(aWet, aFoam, aDepth); vImpact = aImpact;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_HEAD}`)
      .replace("#include <normal_fragment_maps>", /* glsl */ `#include <normal_fragment_maps>
        vec2 p = vWPos.xz + uOrigin;
        bool curtain = vFlow.y > 0.5 && abs(vWNormal.y) < 0.5;
        vec2 drift = vec2(0.09, 0.035) + vFlow.xz * 0.55;
        vec4 detail;
        vec3 wn = normalize(vWNormal);
        if (curtain) {
          float along = dot(p, vec2(-vWNormal.z, vWNormal.x));
          detail = waterNoise(vec2(along * 0.5, vWPos.y * 0.0625), vec2(0.025, -1.2));
          wn = normalize(wn + vec3(detail.r - 0.5, 0.0, detail.g - 0.5) * 0.14);
        } else {
          detail = waterNoise(p * 0.0625, drift);
          vec2 fine = texture2D(uWaterDetail, p * 0.125 + vec2(-uTime * 0.004, uTime * 0.003)).rg;
          vec2 slope = (detail.rg - 0.5) * 0.3 + (fine - 0.5) * 0.13;
          if (vImpact.z > 0.001) {
            vec2 delta = p - (vImpact.xy / vImpact.z + uOrigin);
            float distance = length(delta);
            slope += delta / max(0.05, distance) * cos(distance * 10.0 - uTime * 5.0)
                   * exp(-distance * 0.9) * vImpact.z * 0.16;
          }
          float calm = mix(0.4, 1.0, smoothstep(0.08, 0.8, vWater.z));
          wn = normalize(wn + vec3(-slope.x, 0.0, -slope.y) * calm);
        }
        if (!gl_FrontFacing) wn = -wn;
        normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);`)
      .replace("#include <opaque_fragment>", /* glsl */ `
        vec3 toEye = normalize(cameraPosition - vWPos);
        float facing = clamp(abs(dot(wn, toEye)), 0.0, 1.0);
        float f = 1.0 - facing;
        float fresnel = 0.0204 + 0.9796 * f * f * f * f * f;
        float opticalDepth = min(18.0, vWater.z / max(0.28, facing));
        float absorb = 1.0 - exp(-opticalDepth * 0.22);
        outgoingLight = mix(outgoingLight, uDeep, absorb * 0.68);
        vec3 reflected = mix(uSky, vec3(0.27, 0.54, 0.68), clamp(reflect(-toEye, wn).y, 0.0, 1.0) * 0.38);
        outgoingLight = mix(outgoingLight, reflected, fresnel * 0.85);
        diffuseColor.a = clamp(0.32 + absorb * 0.48 + fresnel * 0.42, 0.32, 0.94);
        float impact = vWater.y * smoothstep(0.4, 0.68, detail.b) * 0.76;
        float shore = (1.0 - vWater.x) * smoothstep(0.48, 0.72, detail.a) * 0.26;
        float bubbles = max(impact, shore);
        if (curtain) {
          float threads = smoothstep(0.37, 0.7, detail.a);
          outgoingLight = mix(outgoingLight, vec3(0.3, 0.64, 0.72), 0.42);
          bubbles = threads * 0.26;
          diffuseColor.a = 0.3 + threads * 0.16 + fresnel * 0.12;
        } else {
          // A narrow trickle/isolated source must remain visible, too.
          diffuseColor.a *= mix(0.68, 1.0, smoothstep(0.1, 0.95, vWater.x));
        }
        outgoingLight = mix(outgoingLight, vec3(0.86, 0.94, 0.95), bubbles);
        diffuseColor.a = max(diffuseColor.a, bubbles * 0.85);
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => "craft-water-continuous-3";
  return material;
}

export function animateWater(time: number, originX = 0, originZ = 0): void {
  uniforms.uTime.value = time;
  // Spatial frequencies repeat over 1024 m, preserving float precision after
  // long walks while keeping every field-window scroll visually continuous.
  uniforms.uOrigin.value.set(originX % 1024, originZ % 1024);
}
