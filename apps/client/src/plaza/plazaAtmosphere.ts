import * as THREE from "three";
import type { GameRenderer } from "../render/renderer.js";
import { createSkyEnvironment } from "../render/skyEnvironment.js";
import { WATER_LAYER } from "../render/waterPipeline.js";
import { animateWater, makeWaterMaterial } from "../craft/waterMesh.js";
import { isTouchPlay } from "../input/touchPlay.js";

/**
 * The plaza's air: what the craft world already has, laid over the modelled plaza.
 *
 *  - the craft SKY's rule (a dome whose horizon is the fog's colour, so far land fades into it)
 *    with a sun and drifting clouds painted in it, and craft's reflection map on whatever is
 *    glossy in the model (glass, metal, ice);
 *  - a SEA round the whole world (craft's water again): the land is an island, not plates in fog;
 *  - dust where feet land;
 *  - the craft WATER: every mesh the model paints with a "water" material is drawn by craft's own
 *    water shader, and — where the frame can be built round the water — by the water pipeline
 *    (tint by how much water each pixel looks through, froth where it meets something);
 *  - light that glows: the model's emissive parts breathe, with a soft halo over each lamp;
 *  - each country's own air: motes, fireflies, snow, sand, sparks — ONE draw call that follows the
 *    camera, its look blended toward the country the player stands in, with the fog and the sky;
 *  - leaves that sway, clouds that drift.
 *
 * Everything is found in the model by MATERIAL NAME (the export joins meshes by material), so a
 * new export needs no numbers here. Nothing is added per frame beyond a handful of uniforms.
 * A touch device gets fewer motes and no water pipeline (as in craft, until it is measured there).
 */
export interface PlazaRegion { id: string; at: readonly number[] }

/** A country's air. `over`: 1 = drawn over the scene (snow, sand), 0 = added to it (light). */
interface Air {
  fog: number; top: number;
  /** what feet throw up from this country's ground */
  dust: number;
  mote: number; size: number; over: number; blink: number;
  /** metres a second: x drift, y rise (negative falls), sway */
  drift: [number, number, number];
  density: number;
}
const AIR: Record<string, Air> = {
  centre: { dust: 0xe9dcb4, fog: 0xcfe8f4, top: 0x3d8fe6, mote: 0xfff3c4, size: 0.055, over: 0, blink: 0.25, drift: [0.12, 0.1, 0.35], density: 0.45 },
  castle: { dust: 0xd9d6c6, fog: 0xd6e6ee, top: 0x4a90de, mote: 0xffd9e6, size: 0.085, over: 1, blink: 0, drift: [0.35, -0.45, 0.6], density: 0.5 },
  jungle: { dust: 0xa9c48a, fog: 0xbfe3c9, top: 0x3c9bd4, mote: 0xd8ff7a, size: 0.075, over: 0, blink: 1, drift: [0.05, 0.05, 0.5], density: 0.8 },
  sky: { dust: 0xffffff, fog: 0xdaf0fb, top: 0x4f9df0, mote: 0xffffff, size: 0.06, over: 0, blink: 0.8, drift: [0.5, 0.15, 0.3], density: 0.6 },
  harbor: { dust: 0xdff4ff, fog: 0xc4e6f6, top: 0x2f86df, mote: 0xe2f6ff, size: 0.05, over: 0, blink: 0.4, drift: [0.7, 0.05, 0.25], density: 0.5 },
  snow: { dust: 0xffffff, fog: 0xe6f0f6, top: 0x7fb2e6, mote: 0xffffff, size: 0.09, over: 1, blink: 0, drift: [0.4, -1.1, 0.5], density: 1 },
  desert: { dust: 0xe8cf94, fog: 0xf1e2c0, top: 0x4c97e2, mote: 0xf2d59a, size: 0.05, over: 1, blink: 0, drift: [1.6, 0.02, 0.2], density: 0.75 },
  gears: { dust: 0xc4c7c2, fog: 0xd9dcd6, top: 0x5b95cf, mote: 0xffb057, size: 0.06, over: 0, blink: 0.6, drift: [0.1, 0.55, 0.3], density: 0.6 },
};
const BOX = new THREE.Vector3(30, 14, 30);
/** The sea round the world: under the land's plates everywhere, seen only past their edge. */
const OCEAN_Y = -0.5, OCEAN_BED = 2.4, OCEAN_RADIUS = 640;
/** Dust at the feet: this many puffs alive at most (a ring: the oldest is taken over). */
const PUFFS = 64, PUFF_LIFE = 0.75;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 top, horizon, sunDir, sunColor;
uniform float uTime;
varying vec3 vDir;
// An INTEGER hash of the lattice point. A float one (fract of a big product, or of sin) gave the same
// point a slightly different value from each of the cells round it — the driver adds in another
// order, and the hash magnifies the last bit — so every cell had edges: clouds in shards.
float hash(vec2 p) { uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u); uint n = (q.x ^ q.y) * 1597334673u; return float(n >> 8) * (1.0 / 16777215.0); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  // the fog's colour at and below the horizon (far land fades into exactly this), blue above
  vec3 sky = mix(horizon, top, smoothstep(0.0, 0.45, d.y));
  float toSun = max(dot(d, sunDir), 0.0);
  sky += sunColor * (pow(toSun, 24.0) * 0.16 + pow(toSun, 5.0) * 0.07);
  if (d.y > 0.015) {
    // clouds on a sheet overhead: soft toy puffs, lit on the sun's side, drifting
    vec2 at = d.xz / (d.y + 0.22) * 1.35 + uTime * vec2(0.0055, 0.0018);
    float body = fbm(at);
    float cover = smoothstep(0.5, 0.8, body);
    float lit = smoothstep(0.42, 0.8, fbm(at + sunDir.xz * 0.11));
    vec3 cloud = mix(mix(horizon, vec3(0.74, 0.81, 0.9), 0.55), vec3(1.0), 0.35 + 0.65 * (1.0 - lit) * cover);
    sky = mix(sky, cloud, cover * smoothstep(0.015, 0.2, d.y) * 0.92);
  }
  // the sun itself: a disc with a soft rim, over the clouds' thin parts
  sky += sunColor * smoothstep(0.9991, 0.99955, toSun) * 1.6;
  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const PUFF_VERTEX = /* glsl */ `
attribute vec3 aVelocity;
attribute vec3 color;
attribute float aBorn;
uniform float uTime, uScale, uLife;
varying vec4 vColor;
void main() {
  float age = (uTime - aBorn) / uLife;
  float live = step(0.0, age) * step(age, 1.0);
  float t = age * uLife;
  // thrown out, slowed by the air, settling
  vec3 at = position + aVelocity * (1.0 - exp(-3.0 * t)) / 3.0 + vec3(0.0, -0.5 * t * t, 0.0);
  vec4 mv = viewMatrix * vec4(at, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = live * (0.16 + 0.34 * age) * uScale / max(0.5, -mv.z);
  vColor = vec4(color, live * (1.0 - age) * (1.0 - age) * 0.55);
}`;
const PUFF_FRAGMENT = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
/** The land's plates: studs and the crayon's grain (never walls, roofs or props). */
const GROUND = /country-(?!harbor)|grass|Village \/ (sand|soil)|Countries \/ snow/i;
/** The plate that is the sea, and how far under the water its bed lies. */
const SEA = /country-harbor/i;
const SEA_DEPTH = 1.4;

const MOTE_VERTEX = /* glsl */ `
attribute float aSeed;
uniform float uTime, uSize, uScale, uBlink, uDensity;
uniform vec3 uCentre, uBox, uDrift;
varying float vAlpha;
void main() {
  float s = aSeed;
  vec3 p = position * uBox;
  float pace = 0.55 + s * 0.9;
  p.x += uDrift.x * uTime * pace + sin(uTime * 0.6 + s * 41.0) * uDrift.z;
  p.y += uDrift.y * uTime * pace;
  p.z += uDrift.x * 0.35 * uTime * pace + cos(uTime * 0.5 + s * 67.0) * uDrift.z;
  // the box follows the camera: a mote that leaves one side comes in at the other
  vec3 w = uCentre + mod(p - uCentre + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 edge = abs(w - uCentre) / (uBox * 0.5);
  float inside = 1.0 - smoothstep(0.75, 1.0, max(edge.x, max(edge.y, edge.z)));
  float blink = mix(1.0, 0.5 + 0.5 * sin(uTime * (1.2 + s * 2.4) + s * 90.0), uBlink);
  // fewer motes where the air is thin: the rest are not drawn at all
  vAlpha = inside * blink * step(fract(s * 7.31), uDensity);
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = uSize * (0.6 + fract(s * 13.7) * 0.9) * uScale / max(0.5, -mv.z);
  // a mote smaller than a couple of pixels is not drawn: far ones stood in the daytime sky like stars
  vAlpha *= smoothstep(1.6, 3.2, px);
  gl_PointSize = vAlpha <= 0.0 ? 0.0 : px;
}`;
const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOver;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(mix(0.15, 0.55, uOver), 1.0, d)) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a * uOver); // premultiplied: uOver 0 adds light, 1 lies over the scene
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const HALO_VERTEX = /* glsl */ `
attribute vec3 color;
attribute float aSeed;
uniform float uTime, uScale;
varying vec3 vColor;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float flicker = 0.86 + 0.14 * sin(uTime * (1.7 + aSeed * 2.0) + aSeed * 60.0);
  vColor = color * flicker;
  gl_PointSize = min(220.0, 1.5 * uScale / max(1.0, -mv.z));
}`;
const HALO_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 2.4);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a * 0.5, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const namesOf = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => m.name).join(" ");

export class PlazaAtmosphere {
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5) }, sunColor: { value: new THREE.Color(0xfff1cf) }, uTime: { value: 0 } };
  private readonly puffs: THREE.Points;
  private readonly puffUniforms = { uTime: { value: 0 }, uScale: { value: 600 }, uLife: { value: PUFF_LIFE } };
  private puffNext = 0;
  private readonly hemi0 = new THREE.Color();
  private readonly white = new THREE.Color(0xffffff);
  private readonly env: THREE.WebGLRenderTarget;
  private readonly motes: THREE.Points;
  private readonly moteUniforms = {
    uTime: { value: 0 }, uSize: { value: 0.06 }, uScale: { value: 600 }, uBlink: { value: 0 }, uDensity: { value: 0.5 }, uOver: { value: 0 },
    uCentre: { value: new THREE.Vector3() }, uBox: { value: BOX }, uDrift: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color() },
  };
  private halos: THREE.Points | null = null;
  private readonly haloUniforms = { uTime: { value: 0 }, uScale: { value: 600 } };
  private readonly sway = { uSwayTime: { value: 0 } };
  private readonly glowing: { material: THREE.MeshStandardMaterial; base: number; seed: number }[] = [];
  private readonly drifting: { object: THREE.Object3D; at: THREE.Vector3; reach: number; rise: number; seed: number }[] = [];
  private readonly waters: THREE.Mesh[] = [];
  private readonly owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  private bed!: THREE.Mesh;
  private readonly dust = new THREE.Color(AIR.centre!.dust);
  private readonly fog = new THREE.Color(AIR.centre!.fog);
  private readonly top = new THREE.Color(AIR.centre!.top);
  private readonly target = new THREE.Color();
  private air: Air = AIR.centre!;
  private time = 0;
  /** Which country's air it is now (for the game's footsteps and the debug hook). */
  region = "centre";

  constructor(private readonly renderer: GameRenderer, map: THREE.Object3D, private readonly regions: readonly PlazaRegion[]) {
    const scene = renderer.scene, touch = isTouchPlay();
    const skyMaterial = new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: THREE.BackSide, depthWrite: false, fog: false });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(560, 32, 16), skyMaterial); // (inside the plaza's 650 m far plane)
    this.sky.renderOrder = -1; this.sky.frustumCulled = false;
    scene.add(this.sky);
    scene.background = this.fog.clone();
    this.owned.push(this.sky.geometry, skyMaterial);
    this.hemi0.copy(renderer.hemi.color);
    if (scene.fog instanceof THREE.Fog) scene.fog.color.copy(this.fog);
    // what the glossy parts of the model mirror: the same sky, over a neutral ground
    this.env = createSkyEnvironment(renderer.renderer, this.top, this.fog, 0x9a9c94);

    map.updateMatrixWorld(true);
    const waters: THREE.Mesh[] = [], lamps: THREE.Mesh[] = [], seas: THREE.Mesh[] = [];
    map.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      const names = `${namesOf(mesh)} ${mesh.name}`;
      if (/water/i.test(namesOf(mesh))) { waters.push(mesh); return; }
      // the harbour country's ground IS the sea: craft's water over it, the painted plate its bed
      if (SEA.test(namesOf(mesh))) seas.push(mesh);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.dress(material as THREE.MeshStandardMaterial);
      if ((Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((m) => this.glows(m as THREE.MeshStandardMaterial))) lamps.push(mesh);
      if (/cloud/i.test(names)) this.drifting.push({ object: mesh, at: mesh.position.clone(), reach: 5, rise: 0.35, seed: this.drifting.length * 1.7 });
      else if (/balloon/i.test(mesh.name) || /balloon/i.test(mesh.parent?.name ?? "")) {
        const whole = /balloon/i.test(mesh.parent?.name ?? "") ? mesh.parent! : mesh;
        if (!this.drifting.some((d) => d.object === whole)) this.drifting.push({ object: whole, at: whole.position.clone(), reach: 0.5, rise: 0.6, seed: 3.1 });
      }
    });
    for (const mesh of waters) this.adoptWater(mesh, !touch);
    for (const mesh of seas) { this.adoptWater(mesh, !touch, true); mesh.position.y -= SEA_DEPTH; mesh.updateMatrixWorld(true); }
    // the sea round the world, and its bed (the water is tinted by what lies behind it)
    const ocean = new THREE.Mesh(new THREE.CircleGeometry(OCEAN_RADIUS, 72).rotateX(-Math.PI / 2));
    ocean.position.y = OCEAN_Y; ocean.updateMatrixWorld(true);
    this.adoptWater(ocean, !touch);
    ocean.geometry.dispose();
    const bedMaterial = new THREE.MeshLambertMaterial({ color: 0x2f9db3 });
    this.bed = new THREE.Mesh(new THREE.CircleGeometry(OCEAN_RADIUS, 48).rotateX(-Math.PI / 2), bedMaterial);
    this.bed.position.y = OCEAN_Y - OCEAN_BED; this.bed.receiveShadow = false;
    scene.add(this.bed);
    this.owned.push(this.bed.geometry, bedMaterial);

    // dust at the feet: a ring of puffs, written only when one is thrown
    const puffGeometry = new THREE.BufferGeometry();
    puffGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PUFFS * 3), 3));
    puffGeometry.setAttribute("aVelocity", new THREE.BufferAttribute(new Float32Array(PUFFS * 3), 3));
    puffGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(PUFFS * 3), 3));
    puffGeometry.setAttribute("aBorn", new THREE.BufferAttribute(new Float32Array(PUFFS).fill(-100), 1));
    const puffMaterial = new THREE.ShaderMaterial({
      uniforms: this.puffUniforms, vertexShader: PUFF_VERTEX, fragmentShader: PUFF_FRAGMENT,
      transparent: true, depthWrite: false, fog: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.puffs = new THREE.Points(puffGeometry, puffMaterial);
    this.puffs.frustumCulled = false; this.puffs.renderOrder = 4;
    scene.add(this.puffs);
    this.owned.push(puffGeometry, puffMaterial);
    if (lamps.length > 0) this.halos = this.makeHalos(lamps);
    if (this.halos) scene.add(this.halos);

    // the air: one cloud of points round the camera
    const count = touch ? 380 : 1100, positions = new Float32Array(count * 3), seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = Math.random(); positions[i * 3 + 1] = Math.random(); positions[i * 3 + 2] = Math.random();
      seeds[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: this.moteUniforms, vertexShader: MOTE_VERTEX, fragmentShader: MOTE_FRAGMENT,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.motes = new THREE.Points(geometry, material);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 5;
    scene.add(this.motes);
    this.owned.push(geometry, material);
    this.applyAir(this.air, 1);
  }

  private glows(material: THREE.MeshStandardMaterial): boolean {
    return !!material.emissive && material.emissive.getHex() !== 0 && !/cloud/i.test(material.name);
  }

  /** One material of the model: the sky on what is glossy, breath in what glows, wind in the leaves. */
  private dress(material: THREE.MeshStandardMaterial): void {
    if (material.userData.plazaDressed) return;
    material.userData.plazaDressed = true;
    const name = material.name;
    if (!material.isMeshStandardMaterial) return;
    // (by what the thing IS, not by its gloss number: the export gives painted walls a clear coat too,
    // and the sky on every wall washed the village's colours out)
    if (material.metalness > 0.5 || /glaz|alloy|gold|silver|copper|ice|optic|crystal/i.test(name)) {
      material.envMap = this.env.texture;
      material.envMapIntensity = 0.8;
    }
    if (this.glows(material)) this.glowing.push({ material, base: material.emissiveIntensity, seed: this.glowing.length * 2.3 });
    // The model's own clouds hang far off: fogged, they were shards of the horizon's colour against
    // the blue (against the old flat background they simply could not be seen). They are clouds:
    // white, lit by the sky, never fogged.
    if (/cloud/i.test(name)) { material.fog = false; material.emissive = new THREE.Color(0xffffff); material.emissiveIntensity = 0.25; }
    if (GROUND.test(name)) this.brick(material);
    else if (/leaf|canopy|fern|jungle|flower|berry/i.test(name)) {
      const sway = this.sway;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uSwayTime = sway.uSwayTime;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform float uSwayTime;")
          .replace("#include <project_vertex>", /* glsl */ `#include <project_vertex>
            // the wind: in WORLD space (the model's meshes are quantised, each with its own scale),
            // more the higher a leaf is, never the trunk's foot
            vec4 swayAt = modelMatrix * vec4(transformed, 1.0);
            float swayBy = clamp((swayAt.y - 0.6) * 0.3, 0.0, 1.0) * 0.07;
            swayAt.x += (sin(uSwayTime * 1.3 + swayAt.x * 0.35 + swayAt.z * 0.27) + 0.5 * sin(uSwayTime * 2.3 + swayAt.z * 0.9)) * swayBy;
            swayAt.z += cos(uSwayTime * 1.1 + swayAt.x * 0.31 - swayAt.z * 0.22) * swayBy;
            mvPosition = viewMatrix * swayAt;
            gl_Position = projectionMatrix * mvPosition;`);
      };
      material.customProgramCacheKey = () => "plaza-sway-1";
    }
  }

  /**
   * The land is a toy's base plate, as craft's blocks are bricks: studs half a metre apart on every
   * level face, and the crayon's uneven hand in the colour — drawn in the pixel shader from the
   * WORLD position, so the model's huge flat plates need no more triangles and no texture. Far
   * away the studs fade out before they are smaller than a pixel (no shimmer).
   */
  private brick(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vPlazaAt;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvPlazaAt = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", /* glsl */ `#include <common>
          varying vec3 vPlazaAt;
          float plazaHash(vec2 p) { uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u); uint n = (q.x ^ q.y) * 1597334673u; return float(n >> 8) * (1.0 / 16777215.0); } // (an integer hash: see the sky's)
          float plazaNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(plazaHash(i), plazaHash(i + vec2(1.0, 0.0)), f.x), mix(plazaHash(i + vec2(0.0, 1.0)), plazaHash(i + vec2(1.0, 1.0)), f.x), f.y);
          }`)
        .replace("#include <color_fragment>", /* glsl */ `#include <color_fragment>
          {
            vec3 flatNormal = normalize(cross(dFdx(vPlazaAt), dFdy(vPlazaAt)));
            // the crayon's hand: broad patches and a finer grain
            float hand = plazaNoise(vPlazaAt.xz * 0.16) * 0.6 + plazaNoise(vPlazaAt.xz * 1.9 + 17.0) * 0.4;
            diffuseColor.rgb *= 0.94 + 0.12 * hand;
            if (flatNormal.y > 0.85) {
              vec2 grid = vPlazaAt.xz * 2.0, cell = fract(grid) - 0.5;
              float soft = max(fwidth(grid.x), fwidth(grid.y)), near = 1.0 - smoothstep(0.1, 0.32, soft);
              float r = length(cell), edge = max(soft, 0.02);
              float top = 1.0 - smoothstep(0.3 - edge, 0.3 + edge, r);
              // lit from the sun's side: a light lip toward it, the stud's shadow on the plate away from it
              float shade = (1.0 - smoothstep(0.3 - edge, 0.3 + edge, length(cell - vec2(0.055, 0.055)))) * (1.0 - top);
              float lip = top * smoothstep(0.17, 0.3, r) * max(0.0, dot(cell / max(r, 1.0e-4), vec2(-0.7071, -0.7071)));
              diffuseColor.rgb *= 1.0 + near * (0.05 * top + 0.14 * lip - 0.2 * shade);
            }
          }`);
    };
    material.customProgramCacheKey = () => "plaza-brick-2";
  }

  /**
   * A water mesh of the model becomes craft's water: its triangles in world space (the shader's
   * swell and patterns are in metres), with the attributes craft's mesher gives its own water —
   * a level top that swells, standing water a metre deep, no flow.
   */
  private adoptWater(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>, pipeline: boolean, keep = false): void {
    const source = mesh.geometry, from = source.getAttribute("position"), normals = source.getAttribute("normal");
    const count = from.count, v = new THREE.Vector3(), n = new THREE.Vector3(), turn = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const position = new Float32Array(count * 3), normal = new Float32Array(count * 3);
    const wave = new Float32Array(count), wet = new Float32Array(count).fill(1), foam = new Float32Array(count), depth = new Float32Array(count).fill(keep ? SEA_DEPTH : 1.1);
    const flow = new Float32Array(count * 3), transition = new Float32Array(count * 4), impact = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(from, i).applyMatrix4(mesh.matrixWorld);
      if (normals) n.fromBufferAttribute(normals, i).applyMatrix3(turn).normalize(); else n.set(0, 1, 0);
      position.set([v.x, v.y, v.z], i * 3); normal.set([n.x, n.y, n.z], i * 3);
      wave[i] = n.y > 0.5 ? 1 : 0;
      // (already where it is: no transition to play)
      transition.set([v.x, v.y, v.z, -1e4], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute("aWave", new THREE.BufferAttribute(wave, 1));
    geometry.setAttribute("aWet", new THREE.BufferAttribute(wet, 1));
    geometry.setAttribute("aFoam", new THREE.BufferAttribute(foam, 1));
    geometry.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
    geometry.setAttribute("aFlow", new THREE.BufferAttribute(flow, 3));
    geometry.setAttribute("aTransition", new THREE.BufferAttribute(transition, 4));
    geometry.setAttribute("aImpact", new THREE.BufferAttribute(impact, 3));
    // Only the faces that look UP are water. The model's water is slabs and tiles with sides and
    // undersides: drawn, every tile was a little tank of its own (a grid of lines across the sea).
    const index = source.index, corners = index ? index.count : count, up: number[] = [];
    for (let i = 0; i + 2 < corners; i += 3) {
      const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
      if (normal[a * 3 + 1]! + normal[b * 3 + 1]! + normal[c * 3 + 1]! > 1.5) up.push(a, b, c);
    }
    geometry.setIndex(up);
    geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    const live = this.renderer.waterPipeline ?? (pipeline ? this.renderer.enableWaterPipeline() : null);
    if (live && !live.materials) {
      live.materials = { front: makeWaterMaterial("front"), back: makeWaterMaterial("back"), surface: makeWaterMaterial("surface"), count: makeWaterMaterial("count") };
      this.owned.push(...Object.values(live.materials));
    }
    const material = makeWaterMaterial();
    const water = new THREE.Mesh(geometry, material);
    water.name = "Plaza water";
    water.castShadow = false; water.receiveShadow = true;
    water.renderOrder = 3;
    if (live) water.layers.set(WATER_LAYER);
    this.renderer.scene.add(water);
    if (!keep) mesh.visible = false; // the model's own flat water (freed with the model)
    this.waters.push(water);
    this.owned.push(geometry, material);
  }

  /** A soft light over each lamp: the glowing meshes' vertices gathered into lamps a metre apart. */
  private makeHalos(lamps: THREE.Mesh[]): THREE.Points | null {
    const cells = new Map<string, { x: number; y: number; z: number; n: number; color: THREE.Color }>(), v = new THREE.Vector3();
    for (const mesh of lamps) {
      const material = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).find((m) => this.glows(m as THREE.MeshStandardMaterial)) as THREE.MeshStandardMaterial;
      const position = mesh.geometry.getAttribute("position"), stride = Math.max(1, Math.floor(position.count / 20000));
      for (let i = 0; i < position.count; i += stride) {
        v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        const key = `${Math.round(v.x / 1.4)},${Math.round(v.y / 1.4)},${Math.round(v.z / 1.4)}`;
        const cell = cells.get(key) ?? { x: 0, y: 0, z: 0, n: 0, color: material.emissive };
        cell.x += v.x; cell.y += v.y; cell.z += v.z; cell.n++;
        cells.set(key, cell);
      }
    }
    const list = [...cells.values()].slice(0, 600);
    if (list.length === 0) return null;
    const position = new Float32Array(list.length * 3), color = new Float32Array(list.length * 3), seeds = new Float32Array(list.length);
    list.forEach((c, i) => {
      position.set([c.x / c.n, c.y / c.n, c.z / c.n], i * 3);
      color.set([c.color.r, c.color.g, c.color.b], i * 3);
      seeds[i] = Math.random();
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.computeBoundingSphere();
    const material = new THREE.ShaderMaterial({
      uniforms: this.haloUniforms, vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT,
      transparent: true, depthWrite: false, fog: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = 4;
    this.owned.push(geometry, material);
    return points;
  }

  private applyAir(air: Air, k: number): void {
    const u = this.moteUniforms, mix = (a: number, b: number) => a + (b - a) * k;
    u.uColor.value.lerp(this.target.set(air.mote), k);
    u.uSize.value = mix(u.uSize.value, air.size);
    u.uOver.value = mix(u.uOver.value, air.over);
    u.uBlink.value = mix(u.uBlink.value, air.blink);
    u.uDensity.value = mix(u.uDensity.value, air.density);
    u.uDrift.value.lerp(new THREE.Vector3(...air.drift), k);
    this.fog.lerp(this.target.set(air.fog), k);
    this.top.lerp(this.target.set(air.top), k);
    this.skyUniforms.top.value.copy(this.top); this.skyUniforms.horizon.value.copy(this.fog);
    const scene = this.renderer.scene;
    if (scene.fog instanceof THREE.Fog) scene.fog.color.copy(this.fog);
    if (scene.background instanceof THREE.Color) scene.background.copy(this.fog);
    // the light from the sky takes a little of the country's air (a snowfield is lit colder than a desert)
    this.renderer.hemi.color.copy(this.fog).lerp(this.white, 0.45);
    this.dust.copy(this.target.set(air.dust));
  }

  /** Dust thrown up where a foot lands (`strength` 1: a running step; a landing asks for more). */
  puff(at: THREE.Vector3, strength = 1): void {
    const geometry = this.puffs.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute, velocity = geometry.getAttribute("aVelocity") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute, born = geometry.getAttribute("aBorn") as THREE.BufferAttribute;
    const count = Math.round(3 + strength * 3);
    for (let i = 0; i < count; i++) {
      const slot = this.puffNext; this.puffNext = (this.puffNext + 1) % PUFFS;
      const turn = Math.random() * Math.PI * 2, out = (0.5 + Math.random() * 0.9) * strength, shade = 0.9 + Math.random() * 0.2;
      position.setXYZ(slot, at.x + Math.cos(turn) * 0.12, at.y + 0.06, at.z + Math.sin(turn) * 0.12);
      velocity.setXYZ(slot, Math.cos(turn) * out, 0.5 + Math.random() * 0.7 * strength, Math.sin(turn) * out);
      color.setXYZ(slot, this.dust.r * shade, this.dust.g * shade, this.dust.b * shade);
      born.setX(slot, this.time);
    }
    position.needsUpdate = velocity.needsUpdate = color.needsUpdate = born.needsUpdate = true;
  }

  /** Every frame, after the camera has moved. */
  update(dt: number, feet: THREE.Vector3): void {
    this.time += dt;
    const camera = this.renderer.camera, t = this.time;
    // the country the player is in: its air comes in over a few seconds
    let region = "centre", best = 95 * 95;
    for (const r of this.regions) {
      const d = (feet.x - r.at[0]!) ** 2 + (feet.z - r.at[2]!) ** 2;
      if (d < best) { best = d; region = r.id; }
    }
    this.region = region;
    this.air = AIR[region] ?? AIR.centre!;
    this.applyAir(this.air, 1 - Math.exp(-0.9 * dt));

    const height = this.renderer.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    const scale = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.moteUniforms.uTime.value = t; this.moteUniforms.uScale.value = scale;
    this.moteUniforms.uCentre.value.set(camera.position.x, camera.position.y + 2, camera.position.z);
    this.haloUniforms.uTime.value = t; this.haloUniforms.uScale.value = scale;
    this.sway.uSwayTime.value = t;
    this.sky.position.copy(camera.position);
    this.skyUniforms.uTime.value = t;
    this.skyUniforms.sunDir.value.copy(this.renderer.sun.position).sub(this.renderer.sun.target.position).normalize();
    this.puffUniforms.uTime.value = t; this.puffUniforms.uScale.value = scale;
    animateWater(t);
    for (const g of this.glowing) g.material.emissiveIntensity = g.base * (0.9 + 0.16 * Math.sin(t * 1.6 + g.seed) + 0.05 * Math.sin(t * 7.3 + g.seed * 3));
    for (const d of this.drifting) {
      d.object.position.set(d.at.x + Math.sin(t * 0.045 + d.seed) * d.reach, d.at.y + Math.sin(t * 0.3 + d.seed * 2) * d.rise, d.at.z + Math.cos(t * 0.037 + d.seed) * d.reach * 0.6);
    }
  }

  debug(): { region: string; waters: { triangles: number; min: number[]; max: number[] }[]; halos: number; glowing: string[]; drifting: string[]; pipeline: boolean } {
    return {
      region: this.region,
      waters: this.waters.map((w) => ({ triangles: (w.geometry.index?.count ?? w.geometry.getAttribute("position").count) / 3, min: w.geometry.boundingBox!.min.toArray().map((n) => Math.round(n * 10) / 10), max: w.geometry.boundingBox!.max.toArray().map((n) => Math.round(n * 10) / 10) })),
      halos: this.halos?.geometry.getAttribute("position").count ?? 0,
      glowing: this.glowing.map((g) => g.material.name),
      drifting: this.drifting.map((d) => d.object.name),
      pipeline: this.renderer.waterPipeline !== null,
    };
  }

  dispose(): void {
    this.sky.removeFromParent(); this.bed.removeFromParent(); this.puffs.removeFromParent();
    this.renderer.hemi.color.copy(this.hemi0);
    this.env.dispose();
    for (const water of this.waters) water.removeFromParent();
    this.motes.removeFromParent();
    this.halos?.removeFromParent();
    for (const item of this.owned) item.dispose();
    if (this.renderer.waterPipeline) this.renderer.waterPipeline.materials = null;
  }
}
