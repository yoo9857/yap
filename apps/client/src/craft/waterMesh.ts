import * as THREE from "three";
import { waterPipelineUniforms } from "../render/waterPipeline.js";
export { buildWaterGeometry, prepareWaterTransition } from "./waterMesher.js";

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
  /** `?waterdebug=1`: the water's SHAPE in flat colours, for finding what is wrong with it —
   *  level faces blue, upright faces green, tilted panels red (the steeper the darker), each
   *  triangle lit by its own flat normal so a bulge or a step shows as a facet. */
  uWaterDebug: { value: typeof location !== "undefined" && new URLSearchParams(location.search).has("waterdebug") ? 1 : 0 },
};
const VERTEX_HEAD = /* glsl */ `
attribute float aWave;
attribute float aWet;
attribute float aFoam;
attribute float aDepth;
attribute vec3 aFlow;
attribute vec4 aTransition;
attribute vec3 aImpact;
uniform int uPass;
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
uniform int uPass;
uniform float uWaterDebug;
uniform sampler2D tSceneDepth;
uniform sampler2D tWaterFront;
uniform sampler2D tWaterBack;
uniform vec2 uScreen;
uniform vec2 uNearFar;
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

/** Which part of the water a material draws (VoxelView.installWater draws all three, in this order). */
export type WaterPass = "all" | "level" | "depth" | "steep" | "front" | "back" | "surface" | "count";
const PASS: Record<WaterPass, number> = { all: 0, level: 1, depth: 2, steep: 3, front: 4, back: 5, surface: 6, count: 7 };

/**
 * Lit, shadowed, fogged water with no reflection camera or extra scene pass.
 *
 * One shader, three passes per chunk, so every pixel blends a known set of layers:
 *   level — the surfaces you look down on (pools, streams, the top of a fall), without depth;
 *   depth — ALL of the water, writing depth and no colour;
 *   steep — the colour of the steep faces (sheets, falls, a stream's sides), which only passes
 *           where it IS that nearest depth.
 * So a sheet or a fall shows exactly one layer, over the level water behind it, and nothing steep
 * shows through a level surface in front of it. Blended in one
 * double-sided pass without depth, a sheet's front, its back and every sheet behind it all stacked
 * (dark overlaps, inner edges showing through) in whatever order the triangles happened to be
 * listed — which changed with every flow step, so the surface shimmered. (Nearest layer for ALL of
 * it was tried: the stream behind a sheet vanished, leaving a bright dry patch.)
 *
 * With the water pipeline (`?water2=1`, render/waterPipeline.ts) the same shader serves its three
 * passes instead: `front` / `back` write the depth of the nearest front and back faces not hidden
 * by the scene, and `surface` draws only what the surface adds — reflection, glints, foam — on the
 * nearest layer, fading out where the water is thin. The water's body (tint, murk) is the
 * pipeline's composite, which knows how much water each pixel looks through.
 */
export function makeWaterMaterial(pass: WaterPass = "all"): THREE.MeshStandardMaterial {
  uniforms.uWaterDetail.value = waterDetail();
  const material = new THREE.MeshStandardMaterial({
    color: 0x389fbe, roughness: 0.19, metalness: 0,
    transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
    // Avoid stacking separate back/front transparent passes in every chunk.
    forceSinglePass: true,
  });
  if (pass === "count") {
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = material.blendSrcAlpha = THREE.OneFactor;
    material.blendDst = material.blendDstAlpha = THREE.OneFactor;
    material.depthTest = false;
    material.fog = false;
  }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, waterPipelineUniforms);
    shader.uniforms.uPass = { value: PASS[pass] };
    // A pass must not sample a texture it is being drawn into (a feedback loop: the draw is
    // dropped). Only `surface` reads all three, on the canvas; `front`/`back` read the scene's
    // depth while writing their own; every other pass reads none (the warm-up quad is in the scene).
    const none = { value: null };
    if (pass !== "surface") shader.uniforms.tWaterFront = shader.uniforms.tWaterBack = none;
    if (pass !== "surface" && pass !== "front" && pass !== "back") shader.uniforms.tSceneDepth = none;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_HEAD}`)
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        // (the count pass takes the water where it IS: mid-transition, corners shared by two faces
        // move apart for a moment, and the volume it counts through must stay closed)
        float age = uPass == 7 ? 1.0 : clamp((uTime - aTransition.w) / 0.18, 0.0, 1.0);
        transformed = mix(aTransition.xyz, transformed, age * age * (3.0 - 2.0 * age));
        vec3 wp0 = (modelMatrix * vec4(transformed, 1.0)).xyz;
        // No face-normal displacement: it would split a waterfall's edges.
        transformed.y += aWave * swell(wp0.xz + uOrigin, uTime);
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
        vFlow = aFlow; vWater = vec3(aWet, aFoam, aDepth); vImpact = aImpact;`)
      .replace("#include <project_vertex>", /* glsl */ `#include <project_vertex>
        // the closing faces against blocks (aWet -1, water_mesh.rs) exist for the count pass only
        if (aWet < -0.5 && uPass != 7) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_HEAD}`)
      .replace("void main() {", /* glsl */ `void main() {
        // count pass (added up, no depth): one step of red for a face the ray LEAVES the water by,
        // one of green for a face it enters by
        if (uPass == 7) { gl_FragColor = gl_FrontFacing ? vec4(0.0, 1.0 / 255.0, 0.0, 0.0) : vec4(1.0 / 255.0, 0.0, 0.0, 0.0); return; }
        // How level this face is, 0‒1. Pass 1 draws it by that much and pass 3 by the rest, so a
        // surface curving from level to steep changes hands gradually: split at a hard threshold,
        // the two halves carried different numbers of layers and a rounded top looked patched.
        float levelness = smoothstep(0.4, 0.85, abs(normalize(vWNormal).y));
        float share = uPass == 1 ? levelness : uPass == 3 ? 1.0 - levelness : 1.0;
        if (share < 0.004) discard;
        // pipeline passes: nothing behind the scene, and (surface) only the nearest layer of water
        // (waterThick: how much WATER the ray passes through here, front face to the nearest back
        // face or the scene — a film is a few centimetres however far the scene behind it is)
        float thin = 1.0, behindWater = 1.0e6, waterThick = 1.0e6;
        if (uPass >= 4) {
          vec2 screen = gl_FragCoord.xy / uScreen;
          float sceneDepth = texture2D(tSceneDepth, screen).x;
          if (gl_FragCoord.z > sceneDepth) discard;
          if (uPass < 6) { gl_FragColor = vec4(0.0); return; }
          float nearest = min(texture2D(tWaterFront, screen).x, texture2D(tWaterBack, screen).x);
          if (gl_FragCoord.z > nearest + 0.00004) discard;
          // how much water is behind this point of the surface: thin water has no visible surface
          float behind = sceneDepth >= 1.0 ? 1.0e6 : -perspectiveDepthToViewZ(sceneDepth, uNearFar.x, uNearFar.y);
          behindWater = behind + perspectiveDepthToViewZ(gl_FragCoord.z, uNearFar.x, uNearFar.y);
          // (5 cm, not 14: water a hand deep on a block was half faded everywhere, in patches with
          // straight edges where its sloping surface crossed that depth)
          thin = smoothstep(0.0, 0.05, behindWater);
          float backDepth = texture2D(tWaterBack, screen).x;
          float backZ = backDepth >= 1.0 ? 1.0e6 : -perspectiveDepthToViewZ(backDepth, uNearFar.x, uNearFar.y);
          waterThick = max(0.0, min(backZ, behind) + perspectiveDepthToViewZ(gl_FragCoord.z, uNearFar.x, uNearFar.y));
        }
        // the depth pass writes no colour: skip the lighting, the texture reads and the foam
        if (uPass == 2) { gl_FragColor = vec4(0.0); return; }`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        gl_FragColor.a *= share * thin;
        // A side seen from INSIDE the water (the eye stands in a fall): no veil. It was a pale
        // pane on every side of the eye, and the ground underfoot — no face there — a clear hole
        // in it. The pipeline's composite already tints the whole view of an eye in water.
        if (uPass == 6 && !gl_FrontFacing) gl_FragColor.a *= smoothstep(0.5, 0.8, abs(normalize(vWNormal).y));`)
      .replace("#include <normal_fragment_maps>", /* glsl */ `#include <normal_fragment_maps>
        vec2 p = vWPos.xz + uOrigin;
        // Running water — a fall, a sheet, and the wedge where one lands on a block — is a film,
        // whichever way its face points. (Only its upright faces were: the slanted and level ones
        // beside them got a pond's surface, an opaque grey slab against the wall in a block's shadow.)
        bool curtain = vFlow.y > 0.5 && abs(vWNormal.y) < 0.5 || vFlow.y > 0.3;
        vec2 drift = vec2(0.09, 0.035) + vFlow.xz * 0.55;
        vec4 detail;
        vec3 wn = normalize(vWNormal);
        if (curtain) {
          // The place ALONG the face, the same on every face and across every edge. (Taken from
          // the vertex normal it bent inside each triangle — the normals are smoothed, so they
          // differ corner to corner — and the rivulets came out as white zigzags, like feathers.)
          // ... and not x + z either: on a face that LEANS (a sheet widening at its foot) that sum
          // changes with height, and two such faces side by side made a chevron again. The face's
          // own flat normal picks the horizontal axis it runs along.
          vec3 faceNormal = cross(dFdx(vWPos), dFdy(vWPos));
          float along = abs(faceNormal.x) > abs(faceNormal.z) ? p.y : p.x;
          // (a level face of running water has no "down": laid along height, its streaks were
          // level bands across it — there the pattern is taken from the ground plan)
          bool lying = abs(vWNormal.y) > 0.6;
          // (the simple water's falls run calmer: half the speed, mostly the broad streaks)
          float calmFall = 0.5;
          detail = waterNoise(lying ? p * 0.3 : vec2(along * 0.5, vWPos.y * 0.0625), lying ? drift * 4.0 : vec2(0.025, -1.2 * calmFall));
          // finer rivulets running faster than the broad ones
          float fineShare = 0.2;
          detail.a = detail.a * (1.0 - fineShare) + waterNoise(lying ? p * 0.8 : vec2(along * 1.9, vWPos.y * 0.12), lying ? drift * 6.0 : vec2(0.01, -2.2 * calmFall)).a * fineShare;
          wn = normalize(wn + vec3(detail.r - 0.5, 0.0, detail.g - 0.5) * 0.2);
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
        float threads = 0.0, curtainBody = 0.0;
        if (curtain) {
          // Water running down a face is a film ON it: the wall shows through, wet, and the water
          // is seen as the rivulets running in it — not as a clear skin standing off the wall.
          threads = smoothstep(0.42, 0.7, detail.a);
          // (lit only a little: in a block's shadow the film went dark teal, a band under the block)
          // ... and once it has left the wall (nothing close behind it) it is a sheet of WATER:
          // blue, see-through, its streaks only a little lighter. Drawn like the film on a wall —
          // nearly clear with white threads — a sheet in the air was a gauze curtain, wind not water.
          float free = uPass == 6 ? smoothstep(0.15, 0.6, behindWater) : 0.0;
          outgoingLight = mix(max(outgoingLight, vec3(0.34, 0.62, 0.72)), mix(vec3(0.52, 0.8, 0.9), vec3(0.24, 0.56, 0.84), free), 0.6 + free * 0.3);
          bubbles = threads * mix(0.35, 0.2, free);
          diffuseColor.a = mix(0.14, 0.46, free) + threads * mix(0.36, 0.16, free) + fresnel * 0.12;
          curtainBody = diffuseColor.a;
        } else {
          // A narrow trickle/isolated source must remain visible, too.
          diffuseColor.a *= mix(0.68, 1.0, smoothstep(0.1, 0.95, vWater.x));
        }
        outgoingLight = mix(outgoingLight, vec3(0.86, 0.94, 0.95), bubbles);
        diffuseColor.a = max(diffuseColor.a, bubbles * 0.85);
        if (uPass == 6) {
          // The surface: its own light colour as a thin veil (so a stream a hand deep, or a sheet on
          // a wall, still reads as water), the sky it mirrors at a glancing angle, the sun's glint,
          // foam. The DEPTH of the water — tint and murk — is the composite's, which knows how much
          // water lies behind each pixel; real clear water this shallow would be invisible.
          float glint = dot(totalSpecular, vec3(0.3333));
          // The light lines and the froth's pattern run WITH the flow (p − drift·t, like every other
          // pattern here; they were p + drift·t: the one thing on the water that visibly moved ran
          // back toward the spring). Two phases blended, so a flow that differs from cell to cell
          // does not shear the pattern more and more as time goes on.
          vec4 laced = waterNoise(p * 0.21, drift * 7.0);
          float lace = laced.b * 0.6 + laced.a * 0.4;
          {
            // The water: plainly WATER, like a toy's. Blue by how much of it there is —
            // light and clear where it is shallow, deep blue where it is deep — the sky on it at a
            // glancing angle, light lines running with it, froth where it meets something; a fall
            // is white water streaking down over blue. Two texture reads, no branches per layer.
            // One water everywhere: nearly the same blue and the same see-through whether a hand
            // deep on a block or a metre deep beside it. (Coloured strongly by depth, the water on
            // a block's top was clear next to opaque blue all round it — the block looked like a
            // hole in the water.)
            float deepK = smoothstep(0.4, 3.5, waterThick);
            vec3 body = mix(vec3(0.27, 0.66, 0.92), vec3(0.1, 0.42, 0.8), deepK * 0.75);
            // (a little of the scene's light, so a block's shadow still lies on the water)
            float lit = clamp(dot(outgoingLight, vec3(0.3333)) * 1.7, 0.65, 1.08);
            if (vFlow.y > 0.5) {
              // falling: the same water, with faint lighter streaks drifting down it. (Strong white
              // streaks racing down every wall were too much of a show — the owner, 2026-11-12.)
              float streak = smoothstep(0.42, 0.82, detail.a);
              outgoingLight = mix(body * lit, vec3(0.88, 0.95, 1.0), streak * 0.2);
              diffuseColor.a = 0.6 + streak * 0.08;
            } else {
              // (the sky on it only faintly: at 0.6, seen from up high at a slant, the water went to a
              // white glare that broke off wherever its slope changed — it read as water cut in pieces)
              outgoingLight = mix(body * lit, reflected, fresnel * 0.28);
              float reach = behindWater * max(facing, 0.3);
              float band = clamp(vWater.z * 0.3, 0.025, 0.13);
              float contact = 1.0 - smoothstep(band * 0.15, band, reach);
              float froth = contact * smoothstep(0.42, 0.6, lace + contact * 0.4);
              float lines = smoothstep(0.62, 0.76, lace) * 0.24;
              float white = max(froth * 0.92, lines);
              outgoingLight = mix(outgoingLight, vec3(0.95, 0.98, 1.0), white);
              diffuseColor.a = max(clamp(mix(0.58, 0.72, deepK) + fresnel * 0.12 + glint * 0.4, 0.0, 0.96), white);
              thin = max(thin, froth);
            }
          }
        }
        if (uWaterDebug > 0.5) {
          vec3 fn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
          float up = abs(fn.y);
          vec3 tint = up > 0.93 ? vec3(0.1, 0.45, 1.0) : up < 0.25 ? vec3(0.1, 0.8, 0.3) : mix(vec3(0.75, 0.0, 0.1), vec3(1.0, 0.55, 0.0), up);
          float lit = 0.55 + 0.45 * abs(dot(fn, normalize(vec3(0.45, 0.7, 0.55))));
          // triangle edges darker: the mesh itself can be read
          vec3 bary = fwidth(vWPos);
          outgoingLight = tint * lit;
          diffuseColor.a = 0.92 + 0.0 * bary.x;
        }
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => "craft-water-continuous-9";
  if (pass === "depth") { material.colorWrite = false; material.depthWrite = true; }
  if (pass === "front" || pass === "back") {
    material.side = pass === "front" ? THREE.FrontSide : THREE.BackSide;
    material.transparent = false;
    material.forceSinglePass = false;
    material.colorWrite = false;
    material.depthWrite = true;
  }
  if (pass === "surface") { material.depthTest = false; material.fog = true; }
  return material;
}

export function animateWater(time: number, originX = 0, originZ = 0): void {
  uniforms.uTime.value = time;
  // Spatial frequencies repeat over 1024 m, preserving float precision after
  // long walks while keeping every field-window scroll visually continuous.
  uniforms.uOrigin.value.set(originX % 1024, originZ % 1024);
}
