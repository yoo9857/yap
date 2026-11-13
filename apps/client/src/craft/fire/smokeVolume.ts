import { BURN_POWER_GLSL } from "./fireGlsl.js";
import {FIRE_LIGHT_VISIBILITY_GLSL} from "./fireLightVisibility.js";
import * as THREE from "three";
import type { FireSchool } from "@robo/shared";
import { waterPipelineUniforms } from "../../render/waterPipeline.js";
import { CLIMB_DELAY_S, CLIMB_S_PER_M, fireFoot, type BurnField, type SmokeField } from "./drillRules.js";

/**
 * The smoke as a VOLUME (owner's call 2026-11-13: "not pieces stuck together — the level of a CS
 * smoke"). Nothing is a sprite here: for every pixel a ray is walked from the eye through the air
 * until it meets what the scene drew there (the scene's depth), and at each step the smoke's
 * density is read and its light added up. So the cloud has a real inside: you walk into it and it
 * closes round you, a doorway cuts it exactly, furniture stands in it, and its underside is a
 * surface you can get below.
 *
 * WHERE smoke is comes from the rules (drillRules `smokeField`: which cells smoke can reach
 * without passing anything solid, and when), as a 3D texture: r = when it arrives, g = 1 where
 * a cell is air smoke reaches. Read against the drill's clock, with the same layer rules the
 * breath rules use (what is seen is what is breathed). The texture never changes; the cloud
 * moves because the noise that gives it its lumps drifts through it.
 *
 * THE FIRE'S BODY IS IN THE SAME WALK (owner 2026-11-13: "the fire too — spreading as naturally
 * as the smoke"). Drawn as a volume ALONE the fire was continuous but soft — an orange fog, the
 * tongues gone — so it is two things together: this body, low and glowing, which joins the fire
 * up into one mass and fills the gaps; and over it the baked flames (fireFx.ts), which are the
 * sharp tongues. The body: at every step the rules' burn map
 * (when each spot of the floor caught, how much burns there) and a map of what stands there
 * (the floor, a bench's top) say how tall the fire is at that spot, and noise streaming upward
 * tears that body into tongues. Where the fire has joined up it IS one fire, with a skyline
 * that never repeats; it stands on the bench it burns on; near the room's walls it climbs them.
 * It gives light instead of taking it, and the smoke above it is lit by it.
 *
 * It runs AFTER the frame is composed (render/waterPipeline.ts `after`): it reads the scene's
 * depth, which a pass drawing into the scene's own target may not.
 *
 * What keeps it cheap: the walk is done at HALF the screen's resolution (a quarter of the
 * pixels; smoke has no fine detail to lose) into a target of its own and laid over the frame;
 * air the smoke has not reached is crossed in double steps and costs one texture read each;
 * the lumps' noise is only worked out where there is smoke; a pixel stops once nothing shows
 * through; and with no smoke at all the pass is not run.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp sampler3D;
  uniform sampler2D tSceneDepth;
  uniform sampler3D tSmoke;
  uniform mat4 uProjectionInverse, uViewInverse;
  uniform vec3 uOffset;            // the scene's coordinates = absolute - uOffset
  uniform vec3 uGridMin, uGridSize; // the smoke field's box (absolute)
  uniform vec4 uRoom;              // the burning room: min x, min z, max x, max z
  uniform float uCorridorZ, uCell;
  uniform int uSteps;
  uniform float uClock, uTime, uOn, uLayer, uRoomLayer, uThickFront;
  uniform vec3 uFire;              // the middle of the fire (absolute)
  uniform float uFireGlow;
  uniform sampler2D tBurn;         // r: when the spot catches, g: its fuel, b: the top of what stands there (absolute y)
  uniform vec4 uBurnField;         // x0, z0, 1 / width, 1 / depth
  uniform float uFireClock, uFireOn, uFireTop, uFrame;
  varying vec2 vUv;

  float hash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }

  bool inRoom(vec3 p) {
    return p.x > uRoom.x && p.x < uRoom.z && p.z > uRoom.y && p.z < uRoom.w;
  }
  ${FIRE_LIGHT_VISIBILITY_GLSL}
  /** How much smoke the rules put at p (0 → 1), before its lumps. rolling: with the underside's slow bellies (the shade's look upward does without). */
  float field(vec3 p, bool rolling) {
    bool room = inRoom(p);
    // never read ACROSS the wall between the burning room and the corridor: the texture is soft,
    // and half a cell of the room's early smoke would show on the corridor's side of that wall
    vec3 q = p;
    float h = uCell * 0.5;
    if (room) q.xz = clamp(p.xz, uRoom.xy + h, uRoom.zw - h);
    else if (p.z > uCorridorZ) q.z = max(p.z, uCorridorZ + h);
    vec2 s = texture(tSmoke, (q - uGridMin) / uGridSize).rg;
    float here = smoothstep(0.0, 9.0, uClock - s.r) * smoothstep(0.04, 0.4, s.g);
    if (here < 0.004) return 0.0; // not arrived, or solid: nothing more to work out
    float bottom = room ? uRoomLayer : p.x < uThickFront ? -1e4 : uLayer;
    if (p.y < bottom - 0.7) return 0.0; // well under the layer
    // the layer's underside is not a pane: it hangs in slow bellies that roll along
    // (they change where they hang; they do not slide: there is no wind indoors)
    if (rolling && p.y < bottom + 1.2) bottom += (noise3(vec3(p.x * 0.5, uTime * 0.05, p.z * 0.5)) - 0.5) * 0.85
      + (noise3(vec3(p.x * 1.4, uTime * 0.09 + 4.0, p.z * 1.4)) - 0.5) * 0.4;
    return here * smoothstep(bottom - 0.08, bottom + 0.26, p.y); // (a layer of smoke has an underside: a half-metre fade read as fog)
  }
  /** …and with them (density, and the lump's own value for its shading): torn and rolling at the edge, thick and thin inside. */
  float vFine; // 1 while the walk is within a few metres of the eye
  vec2 density(vec3 p, float base) {
    // Smoke has no wind to ride indoors. It rises over the fire and runs OUTWARD from it under the
    // ceiling, slowing as it goes: the big lumps are carried along that flow (two copies of the
    // noise, each carried for 8 s and faded out as the other fades in, so nothing stretches and
    // nothing slides off for ever); the small ones churn where they are, folded by the big.
    vec2 away = p.xz - uFire.xz;
    float spread = length(away);
    vec3 flow = vec3(away.x, 0.0, away.y) / max(spread, 0.6) * (0.2 / (1.0 + spread * 0.1)) + vec3(0.0, 0.12 * exp(-spread * 0.4), 0.0);
    float ph = uTime * 0.125;
    float f0 = fract(ph), f1 = fract(ph + 0.5);
    vec3 q = p * 0.8;
    float big = mix(noise3(q - flow * (f0 * 6.4)), noise3(q - flow * (f1 * 6.4) + 7.7), abs(1.0 - 2.0 * f0));
    big = clamp((big - 0.5) * 1.3 + 0.5, 0.0, 1.0); // (two noises laid together are flatter than one)
    float n = big * 0.6 + noise3(p * 2.3 + vec3(big * 0.9, uTime * 0.06, 0.0)) * 0.28;
    // (the finest lumps are smaller than a pixel of the cloud a few metres off: only worked out near the eye)
    n += vFine > 0.5 ? noise3(p * 5.5 + vec3(0.0, -uTime * 0.1, big * 1.6)) * 0.12 : 0.06;
    return vec2(base * smoothstep(0.16, 0.8, n * 1.2 + base * 0.24), n); // (thick and thin INSIDE the layer too: an even fog has no form)
  }

  ${BURN_POWER_GLSL}
  /**
   * The fire at p: (how much flame, how hot: 1 at the foot, 0 where a tongue ends, how much SOOT,
   * how lit that soot still is). Fire and smoke are one thing: over the tongues the fire turns
   * into soot that streams up, lit orange where it leaves the flames and black a metre and a half
   * on, thinning as it climbs into the layer under the ceiling. (Flames with clear air over them
   * and a grey layer far above read as two effects, not a fire: owner 2026-11-13.)
   */
  vec4 flame(vec3 p) {
    vec3 b = texture2D(tBurn, (p.xz - uBurnField.xy) * uBurnField.zw).rgb;
    float age = uFireClock - b.r;
    float power = b.g * burnPower(age, b.g);
    if (power < 0.03) return vec4(0.0);
    // (before any noise: how high the fire and its soot can reach at all here. Most of a ray through
    // the room is above that, and every step of it used to pay for three lookups of noise.)
    float wall = min(min(p.x - uRoom.x, uRoom.z - p.x), min(p.z - uRoom.y, uRoom.w - p.z));
    float above = p.y - b.b;
    if (above < 0.0 || above > (wall < 0.6 ? 4.2 : power * 1.05) + 1.9) return vec4(0.0);
    // how tall the fire is here: by how hard the spot burns, breathing slowly…
    float tall = power * (0.3 + 0.75 * noise3(vec3(p.x * 1.15, uTime * 0.4, p.z * 1.15)));
    // …and at the room's walls it climbs them: a metre every ${CLIMB_S_PER_M} s from when it got there
    float climbed = clamp((age - ${CLIMB_DELAY_S.toFixed(1)}) / ${CLIMB_S_PER_M.toFixed(1)}, 0.0, 3.3) * smoothstep(0.6, 0.08, wall);
    tall = max(tall, climbed * (0.75 + 0.5 * noise3(vec3(p.x * 0.9, uTime * 0.5, p.z * 0.9))));
    float t = (p.y - b.b) / max(tall, 0.05); // 0 at what it stands on, 1 at the top of the fire here
    if (t < 0.0) return vec4(0.0);
    float over = p.y - (b.b + tall); // metres above the fire's top here (negative: among the tongues)
    // (two and a half metres up the soot has joined the layer: nothing more is worked out there,
    // which is most of the room's height on every ray)
    if (over > 1.9) return vec4(0.0);
    float stream = noise3(vec3(p.x * 1.9, p.y * 1.0 - uTime * 1.6, p.z * 1.9)); // (one lookup: its finer half cost as much again and was lost in the half-size cloud)
    float soot = min(1.0, power * 1.4) * smoothstep(-0.4 * tall, 0.25, over) * clamp((stream - 0.26) * 2.2, 0.0, 1.0) / (1.0 + max(over, 0.0) * 0.5) * smoothstep(1.9, 1.2, over);
    float warm = exp(-max(over, 0.0) * 1.25);
    if (t > 1.0) return vec4(0.0, 0.0, soot, warm);
    // tongues: noise that streams upward eats the body, more and more toward the top
    float n = noise3(vec3(p.x * 2.5, p.y * 1.6 - uTime * 2.7, p.z * 2.5)) * 0.62 + noise3(vec3(p.x * 6.2, p.y * 3.4 - uTime * 4.8, p.z * 6.2)) * 0.38;
    float d = clamp((n + 0.32 - t * 0.95) * 3.2, 0.0, 1.0) * smoothstep(0.0, 0.07, t) * min(1.0, power * 2.0);
    return vec4(d, d * (1.0 - t * 0.75), soot, warm);
  }

  void main() {
    if (uOn < 0.004 && uFireOn < 0.004) discard;
    // the ray: from the eye to what the scene drew at this pixel
    float depth = texture2D(tSceneDepth, vUv).x;
    vec4 view = uProjectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec3 end = (uViewInverse * vec4(view.xyz / view.w, 1.0)).xyz + uOffset;
    vec3 eye = uViewInverse[3].xyz + uOffset;
    vec3 dir = end - eye;
    float reach = length(dir);
    dir /= reach;
    // the part of it inside the smoke's box
    vec3 inv = 1.0 / (dir + vec3(equal(dir, vec3(0.0))) * 1e-6);
    vec3 a = (uGridMin - eye) * inv, b = (uGridMin + uGridSize - eye) * inv;
    vec3 lo = min(a, b), hi = max(a, b);
    float t0 = max(max(lo.x, max(lo.y, lo.z)), 0.0), t1 = min(min(hi.x, min(hi.y, hi.z)), reach);
    if (t1 <= t0) discard;

    float stepLen = clamp((t1 - t0) / float(uSteps), 0.14, 0.9);
    // each pixel starts its walk a different part of a step in: banding becomes fine grain
    // …and a different part every frame, so the grain never stands still long enough to be seen as a pattern
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.61803399);
    float t = t0 + stepLen * jitter;
    float through = 1.0; // how much of what is behind still shows
    vec3 lit = vec3(0.0);
    for (int i = 0; i < 40; i++) {
      if (i >= uSteps || t >= t1 || through < 0.05) break;
      vec3 p = eye + dir * t;
      vFine = t < 7.0 ? 1.0 : 0.0;
      // the fire: low in the burning room; it gives light, and hides a little of what is behind it
      bool burning = false;
      if (uFireOn > 0.004 && p.y < uFireTop && inRoom(p)) {
        vec4 f = flame(p);
        if (f.z > 0.004) {
          // the soot over the flames: it hides what burns behind it, and glows only where it is still in the fire
          burning = true;
          vec3 sooty = mix(vec3(0.045, 0.04, 0.036), vec3(1.0, 0.38, 0.07), f.w * 0.8);
          float a = 1.0 - exp(-f.z * 1.7 * stepLen);
          lit += sooty * a * through * uFireOn;
          through *= 1.0 - a * uFireOn;
        }
        if (f.x > 0.004) {
          burning = true;
          vec3 hot = mix(vec3(0.75, 0.07, 0.0), vec3(1.0, 0.36, 0.03), smoothstep(0.05, 0.4, f.y));
          hot = mix(hot, vec3(1.0, 0.78, 0.26), smoothstep(0.4, 0.75, f.y));
          hot = mix(hot, vec3(1.0, 0.96, 0.8), smoothstep(0.78, 1.0, f.y));
          float a = 1.0 - exp(-f.x * 2.6 * stepLen);
          // a flame hides the flame behind it: looked at through a whole room of fire it stays fire-coloured
          // (only adding light up, the far wall of the room was a white sheet)
          lit += hot * (0.7 + 0.8 * f.y) * a * through * uFireOn;
          through *= 1.0 - a * 0.4 * uFireOn; // (it hides little: the baked flames behind it are the fire's detail)
        }
      }
      float base = uOn > 0.004 ? field(p, true) : 0.0;
      if (base > 0.004) {
        vec2 lump = density(p, base);
        float d = lump.x * uOn;
        if (d > 0.002) {
          bool room = inRoom(p);
          vec3 col;
          vec3 toFire = uFire - p;
          float nearGlow = uFireGlow / (1.0 + dot(toFire, toFire) * 0.3);
          if (room) {
            // Over a fire the smoke is lit from BELOW, by whatever burns under that very spot: the
            // layer's hanging bellies glow orange, and what lies deeper in it, behind more smoke, is
            // dark. (One glow falling off from the room's middle left the ceiling a flat brown lid.)
            vec3 spot = texture2D(tBurn, (p.xz - uBurnField.xy) * uBurnField.zw).rgb;
            float under = spot.g * burnPower(uFireClock - spot.r, spot.g) * uFireOn;
            float below = field(p - vec3(0.0, 0.55, 0.0), false);
            float flicker = 0.78 + 0.44 * noise3(vec3(p.x * 0.7, uTime * 1.9, p.z * 0.7));
            float up = (0.1 + 0.6 * under) * exp(-below * 2.8) * flicker;
            // (the glow sits in the thin, hanging parts; a thick lump is soot-dark against it)
            float thin = 1.0 - smoothstep(0.3, 0.75, lump.y);
            col = vec3(0.06, 0.05, 0.045) * (1.2 - 0.6 * lump.y)
              + vec3(1.0, 0.36, 0.07) * up * (0.25 + 0.95 * thin)
              + vec3(1.0, 0.42, 0.1) * nearGlow * 0.3;
          } else {
            // daylight comes in by the corridor's windows (its +z side), a little from above: a
            // lump is pale on that side and grey in its own shade, so the layer has a form to it
            float shade = exp(-field(p + vec3(0.0, 0.3, 0.75), false) * 1.7);
            // the layer's underside catches what the floor throws back: its bellies are paler than its inside
            float skin = base < 0.98 || vFine > 0.5 ? exp(-field(p - vec3(0.0, 0.4, 0.0), false) * 2.2) : 0.11;
            col = vec3(0.3, 0.3, 0.31) * (0.3 + 0.7 * shade + 0.55 * skin) * (1.3 - 0.75 * lump.y);
            // ...and from the fire: smoke near its door glows from inside
            col += vec3(1.0, 0.42, 0.1) * fireLightVisible(p) * nearGlow;
          }
          // thick enough to hide the far end of a corridor, thin enough that the fire under it and the
          // exit sign a few metres on still show: smoke that hides everything teaches nothing
          float a = 1.0 - exp(-d * (room ? 0.5 : 0.62) * stepLen);
          lit += col * a * through;
          through *= 1.0 - a;
        }
      }
      t += base > 0.004 || burning ? stepLen : stepLen * 2.0; // clear air is crossed in double steps
    }
    gl_FragColor = vec4(lit, 1.0 - through); // premultiplied, linear: the lay-over turns it into screen colours
  }
`;

/** The half-size cloud laid over the frame. */
const OVER_FRAG = /* glsl */ `
  uniform sampler2D tCloud;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(tCloud, vUv);
    if (gl_FragColor.a < 0.004) discard;
    #include <colorspace_fragment>
  }
`;

export class SmokeVolume {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Data3DTexture;
  private readonly quad: THREE.Mesh;
  /** The cloud at half the screen's size. */
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly overScene = new THREE.Scene();
  private readonly over: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  /** The cloud is walked at 1 / `divide` of the screen's size (2: a quarter of the pixels). */
  private divide = 2;
  private readonly clear = new THREE.Color();

  private readonly burn: THREE.DataTexture;

  constructor(field: SmokeField, school: FireSchool, steps: number, burning: BurnField) {
    // the burn map with what stands at each spot: the fire's foot is the bench's top, not the floor under it
    const floor = school.heat[1], cells = burning.w * burning.h;
    const burnTexels = new Uint16Array(cells * 4);
    for (let j = 0; j < burning.h; j++) for (let i = 0; i < burning.w; i++) {
      const m = j * burning.w + i;
      burnTexels[m * 4] = THREE.DataUtils.toHalfFloat(burning.ignite[m]!);
      burnTexels[m * 4 + 1] = THREE.DataUtils.toHalfFloat(burning.fuel[m]!);
      burnTexels[m * 4 + 2] = THREE.DataUtils.toHalfFloat(fireFoot(burning.x0 + (i + 0.5) * burning.cell, floor + 1, burning.z0 + (j + 0.5) * burning.cell));
      burnTexels[m * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    this.burn = new THREE.DataTexture(burnTexels, burning.w, burning.h, THREE.RGBAFormat, THREE.HalfFloatType);
    this.burn.minFilter = this.burn.magFilter = THREE.LinearFilter;
    this.burn.wrapS = this.burn.wrapT = THREE.ClampToEdgeWrapping;
    this.burn.needsUpdate = true;

    // r: when smoke arrives; g: 1 where smoke ever comes. A cell it never reaches (a wall, a
    // cabinet, outside) takes the earliest arrival of its neighbours and g = 0: the arrival time
    // then runs on smoothly up to the surface, and g lets the smoke end there.
    const { nx, ny, nz, grid } = field, n = nx * ny * nz;
    const texels = new Uint16Array(n * 2);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const m = (k * ny + j) * nx + i;
      let arrive = grid[m]!, open = 1;
      if (!Number.isFinite(arrive)) {
        open = 0;
        arrive = 1e4;
        for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj, c = k + dk;
          if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
          const near = grid[(c * ny + b) * nx + a]!;
          if (near < arrive) arrive = near;
        }
      }
      texels[m * 2] = THREE.DataUtils.toHalfFloat(Math.min(arrive, 1e4));
      texels[m * 2 + 1] = THREE.DataUtils.toHalfFloat(open);
    }
    this.texture = new THREE.Data3DTexture(texels, nx, ny, nz);
    this.texture.format = THREE.RGFormat;
    this.texture.type = THREE.HalfFloatType;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = this.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    const c = field.cell;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSteps: { value: steps },
        tSceneDepth: waterPipelineUniforms.tSceneDepth,
        tSmoke: { value: this.texture },
        uProjectionInverse: { value: new THREE.Matrix4() }, uViewInverse: { value: new THREE.Matrix4() },
        uOffset: { value: new THREE.Vector3() },
        uGridMin: { value: new THREE.Vector3(...field.min) }, uGridSize: { value: new THREE.Vector3(nx * c, ny * c, nz * c) },
        uRoom: { value: new THREE.Vector4(school.heat[0], school.heat[2], school.heat[3], school.heat[5]) },
        uCorridorZ: { value: school.corridor[2] }, uCell: { value: c },
        uClock: { value: 0 }, uTime: { value: 0 }, uOn: { value: 0 },
        uLayer: { value: 1e4 }, uRoomLayer: { value: 1e4 }, uThickFront: { value: school.thickWest },
        uFire: { value: new THREE.Vector3() }, uFireGlow: { value: 0 },
        uFireHall:{value:new THREE.Vector4(school.corridor[0],school.corridor[2],school.corridor[3],school.corridor[5])},
        uFireDoorMin:{value:new THREE.Vector3(...school.fireDoor.slice(0,3))},uFireDoorMax:{value:new THREE.Vector3(...school.fireDoor.slice(3,6))},
        tBurn: { value: this.burn },
        uBurnField: { value: new THREE.Vector4(burning.x0, burning.z0, 1 / (burning.w * burning.cell), 1 / (burning.h * burning.cell)) },
        uFireClock: { value: 0 }, uFireOn: { value: 0 }, uFireTop: { value: floor + 4.4 }, uFrame: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.over = new THREE.ShaderMaterial({
      uniforms: { tCloud: { value: this.target.texture } },
      vertexShader: VERT, fragmentShader: OVER_FRAG,
      depthTest: false, depthWrite: false, transparent: true,
      // premultiplied: the smoke's own light plus what still shows through it
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
    });
    const overQuad = new THREE.Mesh(this.quad.geometry, this.over);
    overQuad.frustumCulled = false;
    this.overScene.add(overQuad);
  }

  /** Once a frame, before it is drawn. `offset`: the fire's root in the scene (absolute → scene coordinates). */
  set(state: { clock: number; time: number; on: number; layer: number; roomLayer: number; thickFront: number; fireX: number; fireY: number; fireZ: number; glow: number; fireClock: number; fireOn: number }, offset: THREE.Vector3): void {
    const u = this.material.uniforms;
    u.uClock!.value = state.clock;
    u.uTime!.value = state.time;
    u.uOn!.value = state.on;
    u.uLayer!.value = state.layer;
    u.uRoomLayer!.value = state.roomLayer;
    u.uThickFront!.value = state.thickFront;
    (u.uFire!.value as THREE.Vector3).set(state.fireX, state.fireY, state.fireZ);
    u.uFireGlow!.value = state.glow;
    u.uFireClock!.value = state.fireClock;
    u.uFireOn!.value = state.fireOn;
    // absolute = scene - root's place in the scene
    (u.uOffset!.value as THREE.Vector3).copy(offset).multiplyScalar(-1);
  }

  /**
   * How finely the cloud is worked out, changed while running (no shader is rebuilt): the screen
   * fraction it is walked at, and the steps of a walk (at most 40: the loop's bound, which is what its compile costs).
   */
  quality(divide: number, steps: number): void {
    this.divide = divide;
    this.material.uniforms.uSteps!.value = Math.min(40, steps);
  }

  /** The pass itself: the cloud at half size into its own target, then over the composed frame (the pipeline calls it with the screen as target, nothing cleared). */
  /** The two programs: null not asked for yet, false being compiled, true ready. */
  private compiled: boolean | null = null;
  readonly draw = (renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void => {
    const u = this.material.uniforms;
    // The walk's program is big (a loop of noise): compiled at its first draw it held the game for
    // TWO SECONDS, in the middle of play, the moment the fire started (tools/profile-fire-boot.mjs,
    // 2026-11-13). So it is compiled the first time the pass is asked for at all — the pause card is
    // still up — and off the main thread; until it is ready nothing is drawn (the smoke takes
    // seconds to come anyway). Each for the target it will draw into: that is part of a program.
    if (this.compiled !== true) {
      if (this.compiled === null) {
        this.compiled = false;
        const done = (): void => { this.compiled = true; };
        renderer.setRenderTarget(this.target);
        const walk = renderer.compileAsync(this.scene, this.camera);
        renderer.setRenderTarget(null);
        void Promise.all([walk, renderer.compileAsync(this.overScene, this.camera)]).then(done, done);
      }
      return;
    }
    if ((u.uOn!.value as number) < 0.004 && (u.uFireOn!.value as number) < 0.004) return; // no smoke, no fire: no pass
    (u.uProjectionInverse!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uViewInverse!.value as THREE.Matrix4).copy(camera.matrixWorld);
    u.uFrame!.value = ((u.uFrame!.value as number) + 1) % 1024;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.ceil(this.size.x / this.divide)), h = Math.max(1, Math.ceil(this.size.y / this.divide));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(this.clear, alpha);
    renderer.setRenderTarget(null);
    renderer.render(this.overScene, this.camera);
  };

  dispose(): void {
    this.texture.dispose();
    this.burn.dispose();
    this.target.dispose();
    this.over.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
