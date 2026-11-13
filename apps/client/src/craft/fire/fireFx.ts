import * as THREE from "three";
import type { FireSchool } from "@robo/shared";
import type { ClimbSpot } from "./drillRules.js";
import { loadTexture } from "../../render/textures.js";
import { settings } from "../../ui/settings.js";
import type { WaterPipeline } from "../../render/waterPipeline.js";
import { SmokeVolume } from "./smokeVolume.js";
import { BURN_FADE_S, BURN_GROW_S, BURN_HOLD_S, BURN_PEAK, CLIMB_S_PER_M, burnField, climbSpots, fireFoot, smokeField, supportRadius } from "./drillRules.js";

/** The baked flame flipbooks (assets/fx/fire → `node assets/fx/fire/build.mjs`); bump `?v=` when one is re-baked. */
export const FIRE_FLAMES_URL = "/textures/fx/fire-flames.webp?v=1";
export const FIRE_RIDGES_URL = "/textures/fx/fire-ridge.webp?v=1";
export const FIRE_WALL_URL = "/textures/fx/fire-wall.webp?v=1";

/**
 * The fire drill's flames, smoke and extinguisher spray.
 *
 * The big fire is ONE burning area that spreads (drillRules `burnField`: when each spot of the
 * burning room's floor catches). That map is a small texture here, and everything reads it:
 *   - the FLOOR draws the area itself — a glowing edge that creeps outward, coals and char behind it
 *   - flames, smoke and sparks are scattered over the whole room once, and each one burns only
 *     where (and as hard as) the map says at this moment of the drill's clock
 * So the fire widens the way a spill of burning fuel does: no fire "appears", the edge arrives.
 * The small waste-bin fire is the one fire with a place of its own (`aKind` 0).
 *
 * Every system is ONE draw call (instanced camera-facing quads moved in the vertex shader from a
 * seed and the clock — nothing is written per frame but a few uniforms, so there is no garbage).
 * Coordinates are ABSOLUTE field coordinates under the drill's root group.
 *
 * Two lights flicker with the fire. They exist from the constructor on, at intensity 0 when
 * nothing burns: a light that APPEARS after the boot warm-up changes the light count and
 * recompiles every lit material (a felt hitch).
 */

const QUAD = new THREE.PlaneGeometry(1, 1);

/** `count` puffs with a random vec4 seed each. */
function puffGeometry(count: number, rand: () => number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = QUAD.index;
  g.setAttribute("position", QUAD.getAttribute("position"));
  g.setAttribute("uv", QUAD.getAttribute("uv"));
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < seed.length; i++) seed[i] = rand();
  g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
  g.instanceCount = count;
  return g;
}

/** A small deterministic generator: the same fire looks the same on every screen. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // each octave turned: value noise laid straight on itself shows its squares
  float fbm(vec2 p) {
    return vnoise(p) * 0.6 + vnoise(mat2(0.8, -0.6, 0.6, 0.8) * p * 2.1 + 3.7) * 0.3 + vnoise(mat2(0.28, 0.96, -0.96, 0.28) * p * 4.3 + 1.3) * 0.1;
  }
`;
/**
 * Billboards that meet a wall must not be CUT by it (a hard line across every puff, and smoke
 * showing through into the next room). Each fire belongs to a room — a box — and every pixel
 * fades out as it nears that box's walls and ceiling: soft particles without a depth texture.
 */
const PLACE = /* glsl */ `
  varying vec3 vWorld;
  varying float vBox;
  /** A camera-facing corner: centre (absolute), offset on the screen plane. */
  void place(vec3 c, vec2 off) {
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    mv.xy += off;
    gl_Position = projectionMatrix * mv;
    vWorld = c + vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * off.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * off.y;
  }
`;
const WALLS = /* glsl */ `
  uniform vec3 uBoxMin[2], uBoxMax[2];
  varying vec3 vWorld;
  varying float vBox;
  float wallFade(float soft) {
    vec3 lo = mix(uBoxMin[0], uBoxMin[1], vBox), hi = mix(uBoxMax[0], uBoxMax[1], vBox);
    vec2 a = smoothstep(vec2(0.0), vec2(soft), min(vWorld.xz - lo.xz, hi.xz - vWorld.xz));
    return a.x * a.y * smoothstep(0.0, soft, hi.y - vWorld.y);
  }
  /** For what burns ON a wall: only the ceiling ends it. */
  float ceilingFade(float soft) {
    return smoothstep(0.0, soft, mix(uBoxMax[0].y, uBoxMax[1].y, vBox) - vWorld.y);
  }
`;
/** The burn map: when a spot caught (r) and how much burns there (g) → how hard it burns now. */
const BURN = /* glsl */ `
  uniform sampler2D uBurn;
  uniform vec4 uField; // x0, z0, 1 / width, 1 / depth
  uniform float uClock, uLit;
  /** Seconds since the spot at (x, z) caught (negative: the edge has not arrived), and its fuel. */
  vec2 burnAge(vec2 xz) {
    vec2 b = texture2D(uBurn, (xz - uField.xy) * uField.zw).rg;
    return vec2(uClock - b.r, b.g);
  }
  /** the rule (drillRules burnPower): up to its peak, then down to what the spot's fuel keeps burning. */
  float burnPower(float age, float fuel) {
    float settle = min(0.95, 0.38 + (fuel - 1.0) * 1.1);
    return smoothstep(0.0, ${BURN_GROW_S.toFixed(1)}, age) * (settle + (${BURN_PEAK.toFixed(2)} - settle) * (1.0 - smoothstep(${BURN_HOLD_S.toFixed(1)}, ${(BURN_HOLD_S + BURN_FADE_S).toFixed(1)}, age)));
  }
`;
/**
 * Smoke is not a grey disc: it is a lump with a lit top and a dark belly, eaten by noise that
 * churns, turning slowly, never the same way up as its neighbour. `smokeBody(uv, seed, time)`
 * gives (shade, density).
 */
const SMOKE_BODY = /* glsl */ `
  vec2 smokeBody(vec2 uv, float seed, float time) {
    float ang = seed * 6.2832 + time * 0.22 * (fract(seed * 7.3) - 0.5);
    vec2 q = uv - 0.5;
    vec2 r = vec2(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
    // the churn: the noise is dragged through itself
    vec2 flow = r * 2.4 + vec2(seed * 17.0, seed * 9.0 - time * 0.12);
    flow += (vec2(vnoise(flow * 1.3 + time * 0.2), vnoise(flow * 1.3 + 31.7 - time * 0.17)) - 0.5) * 0.9;
    float n = fbm(flow);
    float fine = vnoise(flow * 5.5 + 7.0);
    float density = smoothstep(1.0, 0.1, length(q) * 2.0 + (n - 0.5) * 1.2 + (fine - 0.5) * 0.25);
    density *= smoothstep(1.0, 0.72, length(q) * 2.0); // …and ends INSIDE its quad: no straight edge ever shows
    // lit from above (windows, lamps), dark underneath; lumps shade themselves
    float shade = 0.62 + q.y * 0.7 + (n - 0.5) * 0.7 + (fine - 0.5) * 0.2;
    return vec2(clamp(shade, 0.15, 1.25), density * density * (3.0 - 2.0 * density));
  }
`;
const SOFT_DISC = /* glsl */ `
  float disc = smoothstep(1.0, 0.15, length(vUv - 0.5) * 2.0);
`;
/** Every fire system: where a puff burns, how big, and whether it is the bin's (0) or the room's (1). */
const FIRE_HEAD = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec3 aBase, aNormal; // aNormal: out of the face a climbing flame burns on (zero: it stands free)
  attribute float aFin; // a climbing fire's layers: 0 the one on the face, -1 / +1 the ones standing off it to either side
  attribute float aSize, aKind, aDelay, aRise; // aDelay: seconds after the floor under it catches; aRise: how far up its face goes (climbing)
  uniform float uTime, uCeil, uBin, uRoomFlames; // uRoomFlames: 0 while the room's fire is drawn as a volume (smokeVolume.ts)
  varying vec2 vUv;
  varying float vLife, vSeed, vPow;
  ${PLACE}
  ${BURN}
  float firePower() {
    if (aKind < 0.5) return uBin * uLit;
    vec2 b = burnAge(aBase.xz);
    return b.y * burnPower(b.x - aDelay, b.y) * uLit;
  }
  /** How far up its face a climbing fire has got (m): from the foot, a metre every ${CLIMB_S_PER_M} s, as far as the face goes. */
  float climbed() {
    return clamp((burnAge(aBase.xz).x - aDelay) / ${CLIMB_S_PER_M.toFixed(1)}, 0.35, aRise);
  }
`;

/**
 * A flame is a FLIPBOOK of a simulated fire (assets/fx/fire: Blender's gas solver, 64 frames that
 * loop without a seam, 8 x 8 on the sheet). There are two:
 *   column  one standing flame over a 0.6 m burner (the bin; here and there in the room, the peaks)
 *   ridge   a 2.4 m strip of patchy fuel burning: a low wall of fire with peaks and saddles
 * A burning AREA is ridges, many and overlapping: where the fire has joined up they read as one
 * fire with a ragged skyline, not as posts standing side by side.
 * Each flame is one upright sprite — it turns to the camera round its own height, never lies down
 * — whose bottom edge is the fuel's surface, so it stands on its place. Every flame plays from
 * its own moment, some mirrored, and two frames are blended so 18 pictures a second read as motion.
 */
const FLAME_FRAMES = 64, FLAME_COLS = 8;
const FLAME_VERT = /* glsl */ `
  ${FIRE_HEAD}
  varying vec3 vFrame; // this frame, the next one, and how far between them
  varying float vSheet, vWall; // vSheet: 0 column, 1 ridge, 2 a wall's fire
  void main() {
    float power = firePower();
    if (power < 0.01 || (aKind > 0.5 && uRoomFlames < 0.5)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // nothing burns here yet (or the volume draws it): not a pixel is spent on it
    // in the room four flames in five are ridges; the bin's fire is a column
    bool climbing = dot(aNormal, aNormal) > 0.5;
    vWall = climbing ? 1.0 : 0.0;
    vSheet = aKind < 0.5 ? 0.0 : climbing ? 2.0 : aSeed.w > 0.2 ? 1.0 : 0.0;
    float grown = 0.35 + 0.65 * min(power, 1.4);
    // column: the sheet shows 2 x 3 m, drawn 1 x 1.5 m at size 1 (its fire about 1.2 m tall).
    // ridge: 3 x 2 m, drawn 1.9 x 1.25 m at size 1 — it gains height as it gets going, hardly width
    vec2 size = vSheet > 0.5 ? vec2(1.9 * (0.75 + 0.25 * min(power, 1.0)), 1.25 * grown) * aSize : vec2(1.0, 1.5) * aSize * grown;
    vec3 toCam = cameraPosition - (modelMatrix * vec4(aBase, 1.0)).xyz;
    // free: turned to the camera round its own height. Climbing: flat on its face, a hand's width off it
    vec3 right = climbing ? vec3(aNormal.z, 0.0, -aNormal.x) : normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
    vec3 c;
    if (climbing) {
      // on a face the fire is as tall as it has climbed (the picture's fire fills ~0.75 of its height).
      // It is drawn in LAYERS: one on the face, two standing a little off it to either side — from
      // an angle they slide over each other, which is what gives a wall's fire its depth. (Sheets
      // set square to the wall were tried: seen along the room they are upright bars.)
      float layer = abs(aFin);
      float tall = climbed() / 0.75 * (1.0 - 0.2 * layer);
      size = vec2(tall * 0.6667, tall);
      c = aBase + aNormal * (0.07 + layer * (0.2 + 0.25 * aSeed.y)) + right * (aFin * tall * 0.22 + position.x * size.x) + vec3(0.0, (position.y + 0.5) * size.y, 0.0);
    } else c = aBase + right * (position.x * size.x) + vec3(0.0, (position.y + 0.5) * size.y, 0.0);
    vWorld = c;
    vBox = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(c, 1.0);
    vUv = vec2(aSeed.z > 0.5 ? 1.0 - uv.x : uv.x, uv.y);
    float f = fract(uTime * (0.85 + 0.3 * aSeed.y) * 18.0 / ${FLAME_FRAMES}.0 + aSeed.x) * ${FLAME_FRAMES}.0;
    vFrame = vec3(floor(f), mod(floor(f) + 1.0, ${FLAME_FRAMES}.0), fract(f));
    vLife = 0.0;
    vSeed = aSeed.x;
    vPow = min(1.0, power * 2.5);
  }
`;
const FLAME_FRAG = /* glsl */ `
  uniform sampler2D uFlames, uRidges, uWallFire;
  varying vec2 vUv;
  varying float vPow, vSheet, vWall;
  varying vec3 vFrame;
  ${WALLS}
  vec3 flame(float frame) {
    vec2 cell = vec2(mod(frame, ${FLAME_COLS}.0), floor(frame / ${FLAME_COLS}.0));
    // keep off the cell's edge: the neighbour's fire must not bleed in
    vec2 uv = (cell + vec2(mix(0.012, 0.988, vUv.x), 1.0 - mix(0.008, 0.992, vUv.y))) / ${FLAME_COLS}.0;
    uv.y = 1.0 - uv.y;
    if (vSheet < 0.5) return texture2D(uFlames, uv).rgb;
    if (vSheet < 1.5) return texture2D(uRidges, uv).rgb;
    return texture2D(uWallFire, uv).rgb;
  }
  void main() {
    vec3 col = mix(flame(vFrame.x), flame(vFrame.y), vFrame.z);
    // the bake's tallest tongues leave the picture: the sprite thins out before its top edge
    // no hard line where the picture's burner was: a flame has no shelf under it
    // …and no hard foot: the bake's burner is a bright flat bar, which stacked up as white blocks.
    // The foot is eaten in by the flame's own brightness, so it is ragged, never a straight line.
    float lum = max(col.r, max(col.g, col.b));
    float foot = smoothstep(0.0, 0.11, vUv.y - (1.0 - lum) * 0.05);
    float k = vPow * mix(wallFade(0.2), ceilingFade(0.3), vWall) * smoothstep(1.0, 0.78, vUv.y) * foot;
    // a wall's fire was baked from a square patch of fuel: its sides are let go softly, so the
    // fires along a wall run into each other instead of standing as panels
    if (vSheet > 1.5) k *= smoothstep(0.44, 0.14, abs(vUv.x - 0.5) + (1.0 - lum) * 0.08);
    // premultiplied, and mostly OVER rather than added: a fire's body hides the fire behind it, so a
    // room full of flames stays flames (added up, they were one white sheet) and near ones read as near
    // (only its bright body: the dim edges of a flame are light, they cover nothing)
    gl_FragColor = vec4(col * 1.2 * k, lum * lum * 0.7 * k);
    #include <colorspace_fragment>
  }
`;

/** What a climbing fire leaves on its wall: soot that grows up from where it burns, and the wall glowing under it. */
const SOOT_VERT = /* glsl */ `
  ${FIRE_HEAD}
  void main() {
    vec2 b = burnAge(aBase.xz);
    float age = b.x - aDelay;
    if (aKind < 0.5 || age < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 right = vec3(aNormal.z, 0.0, -aNormal.x);
    vec2 size = vec2(1.6 * aSize, climbed() * 1.7 + 0.5); // above the flames, where the smoke runs up the face
    vec3 c = aBase + aNormal * 0.035 + right * (position.x * size.x) + vec3(0.0, (position.y + 0.5) * size.y, 0.0);
    vWorld = c;
    vBox = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(c, 1.0);
    vUv = uv;
    vLife = age;
    vSeed = aSeed.x * 23.0;
    vPow = uLit;
  }
`;
const SOOT_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vLife, vSeed, vPow;
  ${NOISE}
  ${WALLS}
  void main() {
    vec2 q = vec2((vUv.x - 0.5) * 2.0, vUv.y);
    float n = fbm(q * vec2(2.2, 1.6) + vSeed);
    // a tongue of soot: widest where the fire is, drawn out upward, and it keeps growing for a while
    float grown = smoothstep(0.0, 30.0, vLife);
    float reach = mix(0.3, 1.0, grown);
    float shape = smoothstep(1.0, 0.3, abs(q.x) * (1.0 + q.y * 1.3) + (n - 0.5) * 0.8) * smoothstep(reach, reach * 0.35, q.y + (n - 0.5) * 0.3) * smoothstep(0.0, 0.06, q.y);
    float ember = shape * smoothstep(0.35, 0.0, q.y) * smoothstep(0.45, 0.75, vnoise(q * 9.0 + vSeed)) * (0.6 + 0.4 * sin(uTime * 1.8 + n * 11.0));
    float fade = vPow * ceilingFade(0.3) * smoothstep(0.0, 3.0, vLife);
    gl_FragColor = vec4(vec3(1.0, 0.38, 0.07) * ember * fade, shape * 0.8 * fade);
    #include <colorspace_fragment>
  }
`;

/** The smoke a fire throws up: it rises, meets the ceiling and rolls out along it. */
const PLUME_VERT = /* glsl */ `
  ${FIRE_HEAD}
  void main() {
    float power = firePower();
    if (power < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float life = fract(uTime * (0.1 + aSeed.y * 0.07) + aSeed.x);
    float top = uCeil - 0.45;
    float y = aBase.y + aSize * 0.7 + life * (7.0 + aSeed.y * 3.0);
    float over = max(0.0, y - top);
    float ang = aSeed.w * 6.2832 + sin(uTime * 0.2 + aSeed.x * 9.0) * 0.6;
    float spread = aSize * (0.1 + life * 0.5) + over * 1.1;
    vec3 p = vec3(aBase.x + cos(ang) * spread, min(y, top - aSeed.z * 0.35), aBase.z + sin(ang) * spread);
    float size = (0.6 + life * 1.9 + over * 0.25) * sqrt(aSize) * (0.5 + 0.5 * min(power, 1.3));
    place(p, position.xy * size);
    vBox = aKind;
    vUv = uv;
    vLife = life;
    vSeed = aSeed.x + aSeed.z;
    vPow = min(1.0, power * 1.5);
  }
`;
const PLUME_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vLife, vSeed, vPow;
  ${NOISE}
  ${WALLS}
  ${SMOKE_BODY}
  void main() {
    vec2 body = smokeBody(vUv, vSeed, uTime);
    // black soot off the fire, greying and thinning as it climbs and cools
    vec3 col = mix(vec3(0.05, 0.045, 0.04), vec3(0.3, 0.29, 0.28), smoothstep(0.1, 0.95, vLife)) * body.x;
    // …and its belly glows with the fire under it while it is young
    float under = smoothstep(0.3, 0.0, vLife) * clamp(0.75 - vUv.y, 0.0, 1.0);
    col += vec3(0.95, 0.36, 0.06) * under * 0.9;
    float a = body.y * smoothstep(0.0, 0.08, vLife) * smoothstep(1.0, 0.65, vLife) * 0.62 * vPow * wallFade(0.5);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`;

const EMBER_VERT = /* glsl */ `
  ${FIRE_HEAD}
  void main() {
    float power = firePower();
    if (power < 0.25) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float rate = 0.3 + aSeed.y * 0.45;
    float life = fract(uTime * rate + aSeed.x);
    float wob = aSeed.w * 40.0;
    vec3 p = aBase + vec3(
      (aSeed.z - 0.5) * 0.7 * aSize + sin(uTime * 2.7 + wob) * 0.22 * life,
      (0.3 + life * (1.6 + aSeed.y * 2.2)) * aSize * (0.4 + 0.6 * min(power, 1.3)),
      (aSeed.w - 0.5) * 0.7 * aSize + cos(uTime * 2.1 + wob) * 0.22 * life
    );
    place(p, position.xy * (0.05 + aSeed.z * 0.04) * (1.0 - life * 0.6));
    vBox = aKind;
    vUv = uv;
    vLife = life;
    vSeed = aSeed.x;
    // sparks come with a fire that has got going, and not on every cycle
    vPow = smoothstep(0.25, 0.9, power) * step(0.35, fract(aSeed.x * 7.0 + floor(uTime * rate + aSeed.x) * 0.37));
  }
`;
const EMBER_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vLife, vPow;
  ${WALLS}
  void main() {
    ${SOFT_DISC}
    float a = disc * (1.0 - vLife) * vPow * wallFade(0.1);
    gl_FragColor = vec4(mix(vec3(1.0, 0.75, 0.3), vec3(1.0, 0.25, 0.02), vLife) * a, 0.0);
    #include <colorspace_fragment>
  }
`;

/**
 * The burning area itself, drawn ON the floor: ahead of the edge the floor only darkens with the
 * heat; AT the edge a bright ragged line eats outward; behind it, coals that breathe and char.
 * This is what makes the fire one thing that spreads.
 */
const FLOOR_VERT = /* glsl */ `
  varying vec3 vWorld;
  varying float vBox;
  void main() {
    vWorld = position;
    vBox = 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FLOOR_FRAG = /* glsl */ `
  uniform float uTime;
  ${NOISE}
  ${WALLS}
  ${BURN}
  void main() {
    vec2 xz = vWorld.xz;
    float n = fbm(xz * 1.9);
    float fine = fbm(mat2(0.6, 0.8, -0.8, 0.6) * xz * 6.0 + 5.0);
    // the edge is never a clean line: it is seconds ahead here and behind there
    vec2 b = burnAge(xz);
    float age = b.x + (n - 0.5) * 7.0 + (fine - 0.5) * 2.0;
    float scorch = smoothstep(-9.0, 0.0, age);                            // the floor browning before it catches
    float front = smoothstep(-1.2, 0.3, age) * smoothstep(5.0, 0.6, age); // the line that eats outward
    float burnt = smoothstep(0.0, 6.0, age);
    float breathe = 0.55 + 0.45 * sin(uTime * 1.6 + n * 14.0 + fine * 5.0);
    // coals: small, scattered, breathing — a burnt floor is black with points of fire, not a lit sheet
    float coals = burnt * smoothstep(0.6, 0.82, fbm(mat2(0.8, 0.6, -0.6, 0.8) * xz * 5.0 + 11.0)) * breathe;
    vec3 glow = vec3(1.0, 0.62, 0.16) * front * (0.7 + 0.5 * fine) + vec3(1.0, 0.34, 0.05) * coals * 0.8 + vec3(0.9, 0.22, 0.03) * burnt * 0.04;
    float dark = max(scorch * 0.45, burnt * 0.9);
    float fade = uLit * wallFade(0.1);
    // premultiplied: the char darkens the floor under it, the edge and the coals add their light
    gl_FragColor = vec4(glow * fade, dark * fade);
    #include <colorspace_fragment>
  }
`;

/** What the small fire stands on: coals and soot on the bin's rim (the room's fire has the floor). */
/**
 * The fire's light on the ceiling over it. A point light under a flat ceiling draws a round pool
 * (owner 2026-11-13: "just a circle stuck there"); what a fire throws up there has the shape of
 * what burns under it, leans and licks with the flames, and is never the same twice. One quad
 * under each ceiling, added to the frame: the burning room's reads the burn map (the light is as
 * wide as the fire is, and grows with it), the corridor's is the waste bin's fire.
 */
const CEIL_FRAG = /* glsl */ `
  uniform float uTime, uBin, uStrength;
  uniform vec4 uClip; // the room this ceiling belongs to: min x, min z, max x, max z
  uniform vec3 uSpot; // one fire under it (x, z, reach in metres); reach 0: the burn map
  varying vec3 vWorld;
  ${NOISE}
  ${BURN}
  void main() {
    vec2 xz = vWorld.xz;
    vec2 edge = min(xz - uClip.xy, uClip.zw - xz);
    if (min(edge.x, edge.y) < 0.0) discard; // never on the next room's ceiling
    // the flames under it lean: the light is looked up a little to one side, differently everywhere, all the time
    vec2 lean = vec2(vnoise(xz * 0.45 + vec2(uTime * 0.31, 3.0)), vnoise(xz * 0.45 + vec2(7.0, -uTime * 0.27))) - 0.5;
    vec2 at = xz + lean * 2.6;
    float light = 0.0;
    if (uSpot.z > 0.0) {
      vec2 d = (at - uSpot.xy) / uSpot.z;
      light = min(1.6, uBin) * exp(-dot(d, d) * 2.4);
    } else {
      // what burns under here and round about (light spreads as it rises)
      vec2 c = burnAge(at);
      light = burnPower(c.x, c.y) * c.y * 0.3;
      for (int i = 0; i < 4; i++) {
        vec2 o = i == 0 ? vec2(1.7, 0.6) : i == 1 ? vec2(-0.6, 1.7) : i == 2 ? vec2(-1.7, -0.6) : vec2(0.6, -1.7);
        vec2 a = burnAge(at + o);
        light += burnPower(a.x, a.y) * a.y * 0.175;
      }
    }
    if (light < 0.004) discard;
    // tongues of light: brighter where a flame has just leapt, and all of it trembling
    float lick = 0.5 + 1.0 * fbm(xz * 1.2 + vec2(-uTime * 0.9, uTime * 0.7));
    float tremble = 0.86 + 0.14 * sin(uTime * 11.0 + lean.x * 22.0 + lean.y * 9.0);
    float v = light * lick * tremble * uStrength * uLit;
    gl_FragColor = vec4(vec3(1.0, 0.33, 0.05) * v, 0.0);
  }
`;
const BED_VERT = /* glsl */ `
  ${FIRE_HEAD}
  void main() {
    float power = firePower();
    float reach = aSize * 0.95 * (0.45 + 0.55 * min(power, 1.4));
    vec3 p = aBase + vec3(position.x * reach, 0.025, position.y * reach);
    vWorld = p;
    vBox = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vUv = uv;
    vLife = 0.0;
    vSeed = 3.7;
    vPow = min(1.0, power * 2.5);
  }
`;
const BED_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed, vPow;
  ${NOISE}
  ${WALLS}
  void main() {
    vec2 q = (vUv - 0.5) * 2.0;
    float n = fbm(q * 3.0 + vSeed);
    float d = length(q) + (n - 0.5) * 0.5;
    float burnt = smoothstep(1.0, 0.45, d);
    float breathe = 0.55 + 0.45 * sin(uTime * 1.7 + n * 12.0 + vSeed);
    float coals = smoothstep(0.75, 0.15, d) * smoothstep(0.35, 0.7, vnoise(q * 7.0 + vSeed * 2.0)) * breathe;
    vec3 col = vec3(1.0, 0.42, 0.08) * coals * 1.3 + vec3(1.0, 0.3, 0.05) * smoothstep(0.6, 0.0, d) * 0.35;
    float fade = vPow * wallFade(0.12);
    gl_FragColor = vec4(col * fade, burnt * 0.78 * fade);
    #include <colorspace_fragment>
  }
`;

/**
 * The smoke that fills the building: ONE puff per cell of the rules' smoke field (drillRules
 * `smokeField`: which cells smoke can reach without passing anything solid, and when). A puff is
 * there once the smoke has arrived at its cell — so the cloud goes round furniture, stays out of
 * closed rooms and rolls through doorways along the ceiling. Outside the burning room it hangs
 * as a layer down to `uLayer` (the rules' smoke floor: crawl under it), except west of
 * `uThickFront`, where it stands floor to ceiling. A puff is about as wide as its cell, so its
 * dense middle never reaches into a wall.
 */
const CLOUD_VERT = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec3 aAt;
  attribute float aArrive, aRoom;
  uniform float uTime, uClock, uLit, uLayer, uRoomLayer, uThickFront, uCell;
  varying vec2 vUv;
  varying float vFade, vSeed, vRoom;
  void main() {
    // in the burning room it gathers over the flames (and never hides them); west of the thick front it stands to the floor
    float bottom = aRoom > 0.5 ? uRoomLayer : aAt.x < uThickFront ? -1e4 : uLayer;
    float dens = smoothstep(0.0, 9.0, uClock - aArrive) * smoothstep(bottom - 0.3, bottom + 0.45, aAt.y) * uLit;
    if (dens < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // the smoke is not here (yet): the cell costs nothing
    // it never stands still: each puff wanders inside its own cell, and the whole layer drifts
    vec3 p = aAt + (aSeed.xyz - 0.5) * uCell * 0.6
      + vec3(sin(uTime * 0.21 + aSeed.w * 40.0), sin(uTime * 0.17 + aSeed.x * 31.0) * 0.4, cos(uTime * 0.19 + aSeed.y * 23.0)) * uCell * 0.22;
    float size = uCell * (2.0 + aSeed.w * 0.8);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    vSeed = aSeed.x + aSeed.w;
    vFade = dens;
    vRoom = aRoom;
  }
`;
const CLOUD_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vFade, vSeed, vRoom;
  ${NOISE}
  void main() {
    vec2 q = vUv - 0.5;
    float ang = vSeed * 6.2832 + uTime * 0.12 * (fract(vSeed * 7.3) - 0.5);
    vec2 r = vec2(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
    float n = fbm(r * 2.6 + vec2(vSeed * 17.0, vSeed * 9.0 - uTime * 0.06));
    float d = length(q) * 2.0;
    float density = smoothstep(1.0, 0.2, d + (n - 0.5) * 0.9) * smoothstep(1.0, 0.72, d);
    // lit from above, dark underneath; blacker in the room it comes from
    float shade = 0.72 + q.y * 0.55 + (n - 0.5) * 0.55;
    vec3 col = mix(vec3(0.34, 0.34, 0.35), vec3(0.11, 0.1, 0.095), vRoom * 0.75) * clamp(shade, 0.2, 1.2);
    gl_FragColor = vec4(col, density * vFade * 0.3);
    #include <colorspace_fragment>
  }
`;

const SPRAY_VERT = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime, uOn, uLen;
  uniform vec3 uFrom, uDir;
  varying vec2 vUv;
  varying float vLife;
  void main() {
    float life = fract(uTime * 1.6 + aSeed.x);
    vec3 side = normalize(cross(uDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
    vec3 up = cross(side, uDir);
    // out fast, then billowing where it lands: most of a puff's life is spent on the fire
    float along = 1.0 - (1.0 - life) * (1.0 - life);
    float spread = 0.06 + along * 1.1;
    vec3 p = uFrom + uDir * (along * uLen) + side * (aSeed.y - 0.5) * spread + up * ((aSeed.z - 0.5) * spread * 0.8 + along * 0.1);
    float size = (0.14 + along * 1.15) * uOn;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    vLife = life;
  }
`;
const SPRAY_FRAG = /* glsl */ `
  uniform float uOn;
  varying vec2 vUv;
  varying float vLife;
  void main() {
    ${SOFT_DISC}
    gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), disc * smoothstep(1.0, 0.7, vLife) * smoothstep(0.0, 0.06, vLife) * 0.55 * uOn);
    #include <colorspace_fragment>
  }
`;

function unseen(mesh: THREE.Mesh, order: number): THREE.Mesh {
  mesh.frustumCulled = false; // the shader places the puffs; the quad's own bounds mean nothing
  mesh.renderOrder = order;
  mesh.raycast = () => {};
  return mesh;
}

/** What the drill's rules say the fire is doing this frame. */
export interface FireState {
  /** The drill's clock (s): the burn map is read against it. */
  clock: number;
  /** The smoke's clock (s): the smoke field is read against it (it hurries when the escape begins). */
  smokeClock: number;
  /** The small fire's strength (0 = out, above 1 as it grows). */
  bin: number;
  /** How much of the room burns (0 → 1) and the middle of what burns (absolute x, z): the light and the roar. */
  level: number;
  centreX: number;
  centreZ: number;
  /** Is there smoke at all (0 before the drill is set off and after it is done, else 1). */
  smoke: number;
  /** Outside the burning room: how far down the smoke layer hangs (absolute y), and where its floor-to-ceiling end has got to (absolute x). */
  smokeFloor: number;
  thickFront: number;
}

/**
 * The fire must never cost the game its frame rate (owner 2026-11-13: "no frame drops, on a
 * phone or a poor PC"). The frame time is measured while the fire is drawn; when it stays slow,
 * the fire is made cheaper one step at a time — first the smoke's volume (coarser, fewer steps),
 * then how many flames, smoke columns and sparks are drawn. Never back up: quality that goes up
 * and down is worse to look at than quality that settled. Each step only changes numbers (a
 * uniform, a draw count): no shader is rebuilt, so the change itself costs nothing.
 */
export const FIRE_QUALITY: readonly { divide: number; steps: number; sprites: number }[] = [
  { divide: 1.5, steps: 44, sprites: 1 },
  { divide: 2, steps: 36, sprites: 1 },
  { divide: 3, steps: 28, sprites: 1 },
  { divide: 4, steps: 22, sprites: 0.8 },
  { divide: 4, steps: 18, sprites: 0.6 },
  { divide: 5, steps: 14, sprites: 0.42 },
];
/** Slower than this (ms a frame) on average for `SLOW_FOR_S` and the next step is taken. */
const SLOW_FRAME_MS = 21;
const SLOW_FOR_S = 1.2;

const flicker = (t: number, k: number): number => 0.8 + 0.2 * Math.sin(t * 11.3 + k) * Math.sin(t * 7.1 + 1.3 * k) + 0.08 * Math.sin(t * 23.7 + k);

export class FireFx {
  readonly root = new THREE.Group();
  /** Where the small fire stands (absolute), on the bin's rim. */
  readonly bin: readonly [number, number, number];
  /** Shared by every fire material: one write a frame reaches them all. */
  private readonly shared = { uTime: { value: 0 }, uClock: { value: 0 }, uBin: { value: 0 }, uLit: { value: 1 }, uRoomFlames: { value: 1 } };
  private readonly cloud: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh;
  /** The smoke as a volume, once the frame has a depth to read (see `update`); until then, and where it never has, the puffs. */
  private volume: SmokeVolume | null = null;
  private pipeline: WaterPipeline | null = null;
  private readonly school: FireSchool;
  private readonly offset = new THREE.Vector3();
  /** Which step of `FIRE_QUALITY` the fire is drawn at, and the measuring that moves it. */
  private level = 0;
  private frameMs = 16;
  private slowFor = 0;
  private lastFrame = 0;
  private readonly scaled: { geometry: THREE.InstancedBufferGeometry; total: number }[] = [];
  private readonly volumeState = { clock: 0, time: 0, on: 0, layer: 0, roomLayer: 0, thickFront: 0, fireX: 0, fireY: 0, fireZ: 0, glow: 0, fireClock: 0, fireOn: 0 };
  private readonly spray: THREE.ShaderMaterial;
  /** The fire's light on the ceilings (not drawn on the cheapest quality steps). */
  private readonly ceilGlows: THREE.Mesh[] = [];
  private readonly binLight: THREE.PointLight;
  private readonly blazeLight: THREE.PointLight;
  private readonly ceiling: number;
  /** Where the corridor's smoke layer hangs down to right now (it sinks toward what the rules say, never jumps). */
  private layerY: number;
  private readonly floorY: number;
  private readonly owned: { dispose(): void }[] = [];
  private smokeLevel = 0;
  private sprayLevel = 0;
  /** 1 while the fires burn; 0 before the drill is set off (a class waiting through the briefing). */
  private litLevel = 1;
  private seen = false;

  /**
   * `pipeline`: the frame's pipeline when it has one (it gives the smoke the scene's depth) —
   * asked every frame until it answers, because the game turns it on after the drill is built.
   */
  constructor(school: FireSchool, private readonly getPipeline: () => WaterPipeline | null = () => null) {
    this.school = school;
    const rand = mulberry(20261113);
    const small = school.fires.find((f) => f.small)!;
    // every flame stands on what the school has under it (see fireFoot)
    this.bin = [small.at[0], fireFoot(...small.at), small.at[2]];
    const ceil = school.corridor[4];
    const floor = (this.floorY = school.heat[1]);

    // the rooms the fires burn in: the corridor (the small fire, the smoke) and the burning room
    const inset = 0.04;
    const boxMin = [school.corridor, school.heat].map((b) => new THREE.Vector3(b[0] + inset, b[1], b[2] + inset));
    const boxMax = [school.corridor, school.heat].map((b) => new THREE.Vector3(b[3] - inset, Math.min(b[4], ceil) - inset, b[5] - inset));
    const walls = { uBoxMin: { value: boxMin }, uBoxMax: { value: boxMax } };

    // the burn map as a texture: r = when the spot catches, g = how much burns there
    const field = burnField();
    const texels = new Uint16Array(field.w * field.h * 2);
    for (let k = 0; k < field.w * field.h; k++) {
      texels[k * 2] = THREE.DataUtils.toHalfFloat(field.ignite[k]!);
      texels[k * 2 + 1] = THREE.DataUtils.toHalfFloat(field.fuel[k]!);
    }
    const burn = new THREE.DataTexture(texels, field.w, field.h, THREE.RGFormat, THREE.HalfFloatType);
    burn.magFilter = burn.minFilter = THREE.LinearFilter;
    burn.wrapS = burn.wrapT = THREE.ClampToEdgeWrapping;
    burn.needsUpdate = true;
    const fw = field.w * field.cell, fd = field.h * field.cell;
    const burning = { uBurn: { value: burn }, uField: { value: new THREE.Vector4(field.x0, field.z0, 1 / fw, 1 / fd) }, uClock: this.shared.uClock, uLit: this.shared.uLit };
    // black until the flipbook has loaded (black adds nothing); a missing file leaves coals, sparks and smoke
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    const flames = { value: blank as THREE.Texture }, ridges = { value: blank as THREE.Texture };
    const wallFire = { value: blank as THREE.Texture };
    for (const [url, slot] of [[FIRE_FLAMES_URL, flames], [FIRE_RIDGES_URL, ridges], [FIRE_WALL_URL, wallFire]] as const) {
      void loadTexture(url).then((sheet) => {
        if (!sheet) return;
        sheet.minFilter = sheet.magFilter = THREE.LinearFilter; // no mipmaps: a far flame would sample its neighbours' cells
        sheet.generateMipmaps = false;
        sheet.needsUpdate = true;
        slot.value = sheet;
      });
    }
    this.owned.push(blank);
    const fireUniforms = { uTime: this.shared.uTime, uBin: this.shared.uBin, uRoomFlames: this.shared.uRoomFlames, uCeil: { value: ceil }, uFlames: flames, uRidges: ridges, uWallFire: wallFire, ...burning, ...walls };
    const additive = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation } as const;
    this.owned.push(burn);

    /**
     * One instanced mesh: `binCount` puffs on the small fire and `roomCount` scattered over the
     * burning room (each standing on what is under it, `size()` big).
     */
    const system = (binCount: number, roomCount: number, size: () => number, vertexShader: string, fragmentShader: string, order: number, blend: "add" | "mix", flat = false, climbing: readonly (ClimbSpot & { fin?: number })[] = []): void => {
      const total = binCount + roomCount + climbing.length;
      const geometry = puffGeometry(total, rand);
      const base = new Float32Array(total * 3), sizes = new Float32Array(total), kind = new Float32Array(total);
      const normal = new Float32Array(total * 3), delay = new Float32Array(total), rise = new Float32Array(total), fins = new Float32Array(total);
      const seeds = geometry.getAttribute("aSeed").array as Float32Array;
      const fits = vertexShader === FLAME_VERT; // flames are sized to what they stand on
      for (let i = 0; i < total; i++) {
        if (i < binCount) { base.set(this.bin, i * 3); sizes[i] = small.size; continue; }
        kind[i] = 1;
        sizes[i] = size();
        const spot = climbing[i - binCount - roomCount];
        if (spot) { // at the foot of an upright face: a wall, the side of a cabinet
          base.set(spot.at, i * 3);
          normal.set([spot.normal[0], 0, spot.normal[1]], i * 3);
          delay[i] = spot.delay;
          rise[i] = spot.rise;
          fins[i] = spot.fin ?? 0;
          continue;
        }
        let x = 0, y = 0, z = 0, room = 9;
        for (let tries = 0; tries < 8; tries++) {
          x = field.x0 + 0.35 + rand() * (fw - 0.7);
          z = field.z0 + 0.35 + rand() * (fd - 0.7);
          // on what stands there: mostly the floor or a bench, one in four on top of whatever is tallest (a cabinet)
          y = rand() < 0.25 ? fireFoot(x, floor + 2.2, z) : fireFoot(x, floor + 1, z);
          if (!fits) break;
          room = supportRadius(x, y, z, 2.2);
          if (room >= (y > floor + 1.45 ? 0.3 : 0.15)) break; // a ledge too small to carry a flame (a lamp, a shelf's edge): somewhere else
        }
        if (fits) {
          // a flame is as wide as what carries it (a ridge's fire is ~0.76 of its size to each side,
          // a column's ~0.25): on a narrow top it is a column, never a ridge hanging over the edge
          if (room < 0.5) { seeds[i * 4 + 3] = 0.1; sizes[i] = Math.min(sizes[i]!, (room + 0.05) / 0.25); }
          else if (seeds[i * 4 + 3]! > 0.2) sizes[i] = Math.min(sizes[i]!, (room + 0.1) / 0.76);
        }
        base.set([x, y, z], i * 3);
        delay[i] = (y - floor) * 4; // what stands higher catches a little later
      }
      geometry.setAttribute("aNormal", new THREE.InstancedBufferAttribute(normal, 3));
      geometry.setAttribute("aDelay", new THREE.InstancedBufferAttribute(delay, 1));
      geometry.setAttribute("aRise", new THREE.InstancedBufferAttribute(rise, 1));
      geometry.setAttribute("aFin", new THREE.InstancedBufferAttribute(fins, 1));
      geometry.setAttribute("aBase", new THREE.InstancedBufferAttribute(base, 3));
      geometry.setAttribute("aSize", new THREE.InstancedBufferAttribute(sizes, 1));
      geometry.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 1));
      const material = new THREE.ShaderMaterial({
        uniforms: fireUniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false,
        ...(flat ? { side: THREE.DoubleSide } : {}),
        ...(blend === "add" ? additive : {}),
      });
      this.root.add(unseen(new THREE.Mesh(geometry, material), order));
      this.owned.push(geometry, material);
      if (total > 8) this.scaled.push({ geometry, total }); // the governor may draw fewer of these (see FIRE_QUALITY)
    };
    // touch devices draw a lighter fire: the same area, fewer tongues
    const light = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 0.55 : 1;
    system(1, 0, () => 1, BED_VERT, BED_FRAG, 27, "add", true);
    system(22, Math.round(190 * light), () => 1.3 + rand() * 1.1, PLUME_VERT, PLUME_FRAG, 28, "mix");
    // where the fire climbs: upright faces of the room, found on the map itself
    const climbs = climbSpots(Math.round(70 * light), rand);
    system(0, 0, () => 0.8 + rand() * 0.6, SOOT_VERT, SOOT_FRAG, 26, "add", true, climbs);
    // each climbing fire: one sheet on the face and two standing a little off it
    const sheets = climbs.flatMap((spot) => [spot, { ...spot, fin: 1 }, { ...spot, fin: -1 }]);
    system(2, Math.round(150 * light), () => 0.8 + rand() * rand() * 1.5, FLAME_VERT, FLAME_FRAG, 30, "add", true, sheets);
    system(10, Math.round(150 * light), () => 0.8 + rand() * 1.2, EMBER_VERT, EMBER_FRAG, 30, "add");

    // the burning area on the floor
    const floorGeo = new THREE.PlaneGeometry(fw, fd);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(field.x0 + fw / 2, floor + 0.03, field.z0 + fd / 2);
    const floorMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.shared.uTime, ...burning, ...walls },
      vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, transparent: true, depthWrite: false, ...additive,
    });
    this.root.add(unseen(new THREE.Mesh(floorGeo, floorMat), 26));
    this.owned.push(floorGeo, floorMat);

    // the fire's light on the ceilings (see CEIL_FRAG): the burning room's, and the corridor's over the bin
    const ceilGlow = (x0: number, z0: number, x1: number, z1: number, y: number, clip: readonly number[], spot: THREE.Vector3, strength: number): void => {
      const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      geo.rotateX(Math.PI / 2); // facing down
      geo.translate((x0 + x1) / 2, y - 0.03, (z0 + z1) / 2);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.shared.uTime, uBin: this.shared.uBin, uStrength: { value: strength }, uSpot: { value: spot },
          uClip: { value: new THREE.Vector4(clip[0]! + 0.05, clip[2]! + 0.05, clip[3]! - 0.05, clip[5]! - 0.05) }, ...burning },
        vertexShader: FLOOR_VERT, fragmentShader: CEIL_FRAG, transparent: true, depthWrite: false, ...additive,
      });
      const mesh = unseen(new THREE.Mesh(geo, mat), 26);
      this.root.add(mesh);
      this.ceilGlows.push(mesh);
      this.owned.push(geo, mat);
    };
    ceilGlow(field.x0, field.z0, field.x0 + fw, field.z0 + fd, Math.min(school.heat[4], ceil), school.heat, new THREE.Vector3(0, 0, 0), 0.6);
    const reach = 3.2;
    ceilGlow(this.bin[0] - reach * 1.6, this.bin[2] - reach * 1.6, this.bin[0] + reach * 1.6, this.bin[2] + reach * 1.6, ceil, school.corridor, new THREE.Vector3(this.bin[0], this.bin[2], reach), 0.42);

    // the fire's light on the room: one for the small fire, one that follows the middle of the big fire
    const lamp = (distance: number): THREE.PointLight => {
      const l = new THREE.PointLight(0xff7a2a, 0, distance, 1.6);
      l.layers.enableAll(); // or the ink mask's pass sees a different light count (see CLAUDE.md)
      this.root.add(l);
      return l;
    };
    this.binLight = lamp(9);
    this.binLight.position.set(this.bin[0], this.bin[1] + 0.55, this.bin[2]);
    this.blazeLight = lamp(24);

    // the smoke that fills the building: a puff per cell the rules say smoke reaches (fewer on touch devices)
    this.ceiling = ceil;
    this.layerY = ceil;
    // (the puffs are the fallback now — a touch device, `?smoke=puffs` — so they take every third or fifth cell)
    const cells = smokeField(), stride = light < 1 ? 5 : 3, puffs = Math.ceil(cells.count / stride);
    const cloudGeo = puffGeometry(puffs, rand);
    const cellAt = new Float32Array(puffs * 3), cellArrive = new Float32Array(puffs), cellRoom = new Float32Array(puffs);
    for (let q = 0; q < puffs; q++) {
      const m = q * stride;
      cellAt.set(cells.at.subarray(m * 3, m * 3 + 3), q * 3);
      cellArrive[q] = cells.arrive[m]!;
      cellRoom[q] = cells.room[m]!;
    }
    cloudGeo.setAttribute("aAt", new THREE.InstancedBufferAttribute(cellAt, 3));
    cloudGeo.setAttribute("aArrive", new THREE.InstancedBufferAttribute(cellArrive, 1));
    cloudGeo.setAttribute("aRoom", new THREE.InstancedBufferAttribute(cellRoom, 1));
    this.cloud = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.shared.uTime, uClock: { value: 0 }, uLit: { value: 0 }, uLayer: { value: ceil }, uRoomLayer: { value: ceil }, uThickFront: { value: school.thickWest },
        uCell: { value: cells.cell * Math.cbrt(stride) * 1.15 },
      },
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false,
    });
    this.cloudMesh = unseen(new THREE.Mesh(cloudGeo, this.cloud), 31);
    this.root.add(this.cloudMesh);

    this.spray = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOn: { value: 0 }, uLen: { value: 4 }, uFrom: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, 0, 1) } },
      vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG, transparent: true, depthWrite: false,
    });
    const sprayGeo = puffGeometry(64, rand);
    this.root.add(unseen(new THREE.Mesh(sprayGeo, this.spray), 32));
    this.owned.push(cloudGeo, sprayGeo, this.cloud, this.spray);
    // where to start: the low graphics preset starts light (the governor only ever goes down from there)
    const asked = Number(new URLSearchParams(location.search).get("firequality") ?? NaN);
    this.setQuality(Number.isFinite(asked) ? asked : settings.graphics === "low" ? 3 : 0);
  }

  /**
   * Once a frame. `state`: what the rules say burns and how the smoke stands; `spray`: while the
   * extinguisher sprays, the jet in absolute coordinates — from the nozzle, along `dir` (unit),
   * `len` metres to where it lands — else null; `lit`: false before the drill is set off.
   */
  update(dt: number, time: number, state: FireState, spray: { from: THREE.Vector3; dir: THREE.Vector3; len: number } | null, lit = true): void {
    // (the first frame takes the drill's word as it is: a student joining a class in its briefing
    // saw the whole fire for two seconds while it faded out)
    if (!this.seen) { this.seen = true; this.litLevel = lit ? 1 : 0; }
    this.litLevel += ((lit ? 1 : 0) - this.litLevel) * Math.min(1, dt * 1.5);
    this.govern(lit);
    this.shared.uTime.value = time;
    this.shared.uClock.value = state.clock;
    this.shared.uBin.value = state.bin;
    this.shared.uLit.value = this.litLevel;

    // (low, so the ceiling is far from them: the hot round pool a lamp near a ceiling draws is CEIL_FRAG's job now)
    this.binLight.intensity = Math.min(1.6, state.bin) * this.litLevel * 6.5 * flicker(time, 0);
    this.blazeLight.position.set(state.centreX, this.floorY + 0.9, state.centreZ);
    this.blazeLight.intensity = Math.sqrt(state.level) * this.litLevel * 22 * flicker(time, 2.4);

    // the smoke: the cells fill by the clock; outside the burning room it hangs down to `layer`
    this.smokeLevel += (state.smoke * this.litLevel - this.smokeLevel) * Math.min(1, dt * 0.8);
    this.layerY += (Math.min(this.ceiling, state.smokeFloor) - this.layerY) * Math.min(1, dt * 0.35);
    this.cloud.uniforms.uLit!.value = this.smokeLevel;
    this.cloud.uniforms.uClock!.value = state.smokeClock;
    this.cloud.uniforms.uLayer!.value = this.layerY;
    // the burning room's own layer: from the ceiling down as more of it burns, to a little over head height
    const roomLayer = this.ceiling - 0.4 - (this.ceiling - this.floorY - 2.9) * Math.min(1, state.level * 1.4);
    this.cloud.uniforms.uRoomLayer!.value = roomLayer;
    // the volume takes over from the puffs as soon as the frame has a depth for it to read
    if (!this.volume && !this.pipeline && new URLSearchParams(location.search).get("smoke") !== "puffs") {
      this.pipeline = this.getPipeline();
      if (this.pipeline) {
        this.volume = new SmokeVolume(smokeField(), this.school, FIRE_QUALITY[this.level]!.steps, burnField());
        this.volume.quality(FIRE_QUALITY[this.level]!.divide, FIRE_QUALITY[this.level]!.steps);
        this.pipeline.after.push(this.volume.draw);
        this.cloudMesh.visible = false;
      }
    }
    if (this.volume) {
      const v = this.volumeState;
      v.clock = state.smokeClock; v.time = time; v.on = this.smokeLevel;
      v.layer = this.layerY; v.roomLayer = roomLayer; v.thickFront = state.thickFront;
      v.fireX = state.centreX; v.fireY = this.floorY + 1.2; v.fireZ = state.centreZ;
      // the fire's body (a glowing mass that joins the baked flames up) while the volume is fine
      // enough to carry it; on the cheapest steps, and without a volume, the flames stand alone
      const volumeFire = FIRE_QUALITY[this.level]!.steps >= 22 && new URLSearchParams(location.search).get("fire") !== "sprites";
      v.fireClock = state.clock;
      v.fireOn = volumeFire ? this.litLevel * 0.55 : 0;
      v.glow = Math.sqrt(state.level) * this.litLevel * (0.26 + 0.07 * flicker(time, 2.4));
      this.volume.set(v, this.root.getWorldPosition(this.offset));
    }
    this.cloud.uniforms.uThickFront!.value = state.thickFront;

    this.sprayLevel += ((spray ? 1 : 0) - this.sprayLevel) * Math.min(1, dt * 14);
    this.spray.uniforms.uTime!.value = time;
    this.spray.uniforms.uOn!.value = this.sprayLevel;
    if (spray) {
      (this.spray.uniforms.uFrom!.value as THREE.Vector3).copy(spray.from);
      (this.spray.uniforms.uDir!.value as THREE.Vector3).copy(spray.dir);
      this.spray.uniforms.uLen!.value = spray.len;
    }
  }

  /** Measure the frame; when it stays slow while the fire is drawn, take the next cheaper step. */
  private govern(lit: boolean): void {
    const now = performance.now(), ms = now - this.lastFrame;
    this.lastFrame = now;
    // not burning, the first frame, or the tab was away. (A frame of a quarter second is a weak
    // machine, not an absence: those were left out, so the machines that needed the cheaper steps
    // most never got them.)
    if (!lit || ms <= 0 || ms > 1500) return;
    this.frameMs += (Math.min(ms, 250) - this.frameMs) * 0.1;
    this.slowFor = this.frameMs > SLOW_FRAME_MS ? this.slowFor + ms / 1000 : 0;
    // under 30 frames a second it is far from enough: two steps at once, after half the wait
    const badly = this.frameMs > 34;
    if (this.slowFor < (badly ? SLOW_FOR_S / 2 : SLOW_FOR_S) || this.level >= FIRE_QUALITY.length - 1) return;
    this.setQuality(this.level + (badly ? 2 : 1));
    this.slowFor = 0;
    this.frameMs = 16; // judge the new step on its own frames
  }

  /** Draw the fire at a step of `FIRE_QUALITY` (the governor's; also for tests and `?firequality=N`). */
  setQuality(level: number): void {
    this.level = Math.min(FIRE_QUALITY.length - 1, Math.max(0, level));
    for (const glow of this.ceilGlows) glow.visible = this.level < 4;
    const q = FIRE_QUALITY[this.level]!;
    this.volume?.quality(q.divide, q.steps);
    for (const s of this.scaled) s.geometry.instanceCount = Math.max(1, Math.round(s.total * q.sprites));
  }

  /** Dev: what the effects are being drawn with. */
  debug(): Record<string, unknown> {
    const u = this.spray.uniforms;
    return {
      quality: this.level, frameMs: this.frameMs, volume: this.volume !== null, lit: this.litLevel,
      sprayLevel: this.sprayLevel, smokeLevel: this.smokeLevel, clock: this.shared.uClock.value, bin: this.shared.uBin.value,
      smokeFloor: this.layerY, thickFront: this.cloud.uniforms.uThickFront!.value as number,
      light: [this.binLight.intensity, this.blazeLight.intensity],
      from: (u.uFrom!.value as THREE.Vector3).toArray(), dir: (u.uDir!.value as THREE.Vector3).toArray(), time: u.uTime!.value,
    };
  }

  dispose(): void {
    if (this.volume && this.pipeline) {
      const at = this.pipeline.after.indexOf(this.volume.draw);
      if (at >= 0) this.pipeline.after.splice(at, 1);
      this.volume.dispose();
    }
    for (const o of this.owned) o.dispose();
  }
}
