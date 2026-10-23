import * as THREE from "three";

/**
 * Silhouette ink: the outline pass the characters are drawn with.
 *
 * ## Why this exists
 *
 * Every creature part used to carry its own inverted-hull shell — a copy of
 * the brick pushed out along its normals and drawn back-faces-only. That gives
 * a line around each BRICK, which is wrong, because a creature is not a pile
 * of bricks to the eye: the head's shell pushes a centimetre into the neck,
 * the tail's cuts a band across the rump, the ear's rings its own root. No
 * amount of tuning the line weight removes those; they are not lines that are
 * too thick, they are lines that should not be there at all.
 *
 * This is the technique cel-shaded games use instead (Guilty Gear, Borderlands,
 * Breath of the Wild): render the subject into a mask, find the edges of the
 * MASK, and ink those. A mask has edges only at the outside of the silhouette,
 * so interior joints get nothing and the animal reads as one object. The line
 * is also measured in PIXELS, so it keeps its weight at any distance — which a
 * hull, being geometry, never could.
 *
 * ## Per frame
 *
 * 1. The whole scene renders into `sceneRT` (MSAA, plus a depth texture).
 * 2. Only `INK_LAYER` renders into `maskRT` — flat white on black, with its
 *    own depth buffer.
 * 3. One full-screen pass finds mask edges, checks the mask's depth against
 *    the scene's so a character behind a wall is not inked through it, and
 *    writes ink over the scene colour.
 *
 * ## The traps, all of which were hit on the way here
 *
 * - **The mask needs its OWN depth buffer.** Sharing the scene's looks like a
 *   free way to get occlusion, but re-rasterising the same triangles does not
 *   reproduce the same depth bit-for-bit (more so with MSAA in the mix), so
 *   `LESS_EQUAL` fails in patches and punches holes through the middle of the
 *   silhouette — which the edge detector then faithfully inks. Occlusion is
 *   done by comparing the two depths in the composite instead.
 * - **The composite must convert to sRGB itself.** A raw `ShaderMaterial` gets
 *   none of three's output chunks, so writing the linear render target
 *   straight to the canvas yields a dark, over-saturated image.
 * - **Every light must be visible to the mask camera** (`light.layers.enableAll()`
 *   wherever a light is made). three gathers lights per render() filtered by
 *   the camera's layers, and the mask pass shares the scene's render state: a
 *   mask camera that saw no lights flipped the light setup 2 → 0 → 2 every
 *   frame, bumping its version, and three then re-derived the shader program
 *   — parameters, cache-key strings — for EVERY lit object, EVERY frame. That
 *   was the top of the CPU profile and ~90% of the garbage (10–24 MB/s, a GC
 *   pause several times a second): the "turning the camera stutters" feel.
 *   Lights draw nothing, so seeing them costs the mask pass nothing.
 * - **It must switch off in WebXR.** A headset owns the framebuffer; render
 *   targets and full-screen quads do not survive that, so `GameRenderer` falls
 *   back to the hull shells while presenting. That is why the shells are still
 *   built rather than deleted, and why they live on their own layer.
 */

/** Solid character geometry, rendered into the silhouette mask. */
export const INK_LAYER = 7;
/**
 * The same, for INSTANCED meshes (furniture). They get their own layer and
 * their own mask material because one override material shared between plain
 * and instanced meshes needs a different shader for each, and three then
 * re-derives the program — parameters, cache-key string — on every object,
 * every frame. Measured: ~90% of the mode's garbage (10–24 MB/s) and the top
 * of the CPU profile, the moment the first sofa was placed.
 */
export const INK_INSTANCED_LAYER = 8;
/** Per-brick inverted-hull shells — the fallback, hidden when ink is on. */
export const HULL_LAYER = 6;

const INK_COLOR = new THREE.Color(0x17171c);

/**
 * How strongly furniture is inked, relative to characters (1). Characters are
 * the subject and keep a bold line; furniture is set dressing, and at full
 * weight a room of it looked drawn-on next to the un-outlined voxel world.
 */
const INK_WEIGHT_INSTANCED = 0.55;
/** Ink fades with distance (m) from full at START to FLOOR × full at END. */
const INK_FADE_START = 8;
const INK_FADE_END = 40;
const INK_FADE_FLOOR = 0.2;

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
#include <packing>
uniform sampler2D tScene;
uniform sampler2D tMask;
uniform sampler2D tMaskDepth;
uniform sampler2D tSceneDepth;
uniform vec2 texel;
uniform vec3 inkColor;
uniform float thickness;
uniform float cameraNear;
uniform float cameraFar;
uniform vec2 fadeRange;
uniform float fadeFloor;
varying vec2 vUv;

/** The ink WEIGHT where something inked is visible (1 for characters, less
 *  for furniture — see INK_WEIGHT_INSTANCED), 0 elsewhere. */
float maskAt(vec2 uv) { return texture2D(tMask, uv).r; }

/** three writes linear colour into a render target; the canvas expects sRGB. */
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 scene = texture2D(tScene, vUv).rgb;
  float c = maskAt(vUv);
  vec2 o = texel * thickness;

  // Eight neighbours: the diagonals are what stop the line breaking up on
  // near-45° silhouettes, which a plus-shaped kernel leaves as a staircase.
  float e = 0.0;
  float best = c;
  vec2 bestUv = vUv;
  for (int i = 0; i < 8; i++) {
    vec2 d = vec2(0.0);
    if (i == 0) d = vec2(o.x, 0.0);
    else if (i == 1) d = vec2(-o.x, 0.0);
    else if (i == 2) d = vec2(0.0, o.y);
    else if (i == 3) d = vec2(0.0, -o.y);
    else if (i == 4) d = vec2(o.x, o.y);
    else if (i == 5) d = vec2(-o.x, -o.y);
    else if (i == 6) d = vec2(o.x, -o.y);
    else d = vec2(-o.x, o.y);
    float m = maskAt(vUv + d);
    e = max(e, abs(m - c));
    if (m > best) { best = m; bestUv = vUv + d; }
  }

  // Occlusion: ink is painted just OUTSIDE the silhouette, so test the
  // character's depth where it actually is (the brightest neighbour) against
  // whatever the scene drew at the pixel being painted. Without this a pet
  // behind a wall still gets a crisp outline drawn over the wall.
  float charDepth = texture2D(tMaskDepth, bestUv).r;
  float sceneDepth = texture2D(tSceneDepth, vUv).r;
  float visible = step(charDepth, sceneDepth + 0.0015);

  // The edge test runs on the mask NORMALISED by the object's weight, so a
  // light-weight object still gets a crisp line — just a fainter one.
  float edge = smoothstep(0.2, 0.8, e / max(best, 1e-3));

  // A line of constant PIXEL width is right up close and wrong far away: a
  // distant chair is a few pixels of furniture inside a frame of ink, while
  // the un-outlined world around it reads as soft. Fade the ink with the
  // object's distance, down to a floor, so far things settle into the scene.
  float dist = -perspectiveDepthToViewZ(charDepth, cameraNear, cameraFar);
  float fade = mix(1.0, fadeFloor, smoothstep(fadeRange.x, fadeRange.y, dist));

  gl_FragColor = vec4(toSRGB(mix(scene, inkColor, edge * best * fade * visible)), 1.0);
}
`;

export class InkOutline {
  private readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly maskRT: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly composite: THREE.ShaderMaterial;
  private readonly maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  /** A separate material object, so its (instanced) program is cached apart.
   *  Its grey is the furniture's ink weight: the mask carries it to the
   *  composite, which draws that object's line at that strength. */
  private readonly maskMaterialInstanced = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(INK_WEIGHT_INSTANCED, INK_WEIGHT_INSTANCED, INK_WEIGHT_INSTANCED, THREE.LinearSRGBColorSpace),
    fog: false,
  });
  /** Reused so a per-frame camera clone never hits the allocator. */
  private readonly maskCamera = new THREE.PerspectiveCamera();
  private width = 1;
  private height = 1;

  /** Line weight in PIXELS. 1.6 read fine in a close-up and vanished at
   *  gameplay distance, where the old world-space hull had been worth ~2.6px
   *  on a character — which is the weight this art style expects. */
  constructor(renderer: THREE.WebGLRenderer, thickness = 2.6) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);

    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      // MSAA, because routing through a render target otherwise throws away
      // the antialiasing the canvas had for free.
      samples: 4,
      depthTexture: new THREE.DepthTexture(this.width, this.height),
    });
    this.maskRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      depthTexture: new THREE.DepthTexture(this.width, this.height),
    });
    // The mask is a binary coverage buffer; smoothing it is what gives the
    // edge test a gradient to work with instead of a staircase.
    this.maskRT.texture.minFilter = THREE.LinearFilter;
    this.maskRT.texture.magFilter = THREE.LinearFilter;

    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tMask: { value: this.maskRT.texture },
        tMaskDepth: { value: this.maskRT.depthTexture },
        tSceneDepth: { value: this.sceneRT.depthTexture },
        texel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        inkColor: { value: INK_COLOR },
        thickness: { value: thickness },
        cameraNear: { value: 0.1 },
        cameraFar: { value: 400 },
        fadeRange: { value: new THREE.Vector2(INK_FADE_START, INK_FADE_END) },
        fadeFloor: { value: INK_FADE_FLOOR },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new THREE.Mesh(this.quadGeometry, this.composite));
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    this.maskRT.setSize(w, h);
    (this.composite.uniforms.texel!.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.composite.uniforms.cameraNear!.value = camera.near;
    this.composite.uniforms.cameraFar!.value = camera.far;
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;

    // 1. the world, offscreen. The hull-shell layer is already off (see
    //    GameRenderer), so characters arrive here with no per-brick lines.
    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);

    // Every render() rebuilds the shadow map by default, and it ignores the
    // camera's layers while doing it — so the mask and composite passes were
    // each re-shadowing the entire voxel island. That cost more than the ink
    // itself (measured: +223 draw calls, +1.2M triangles a frame). The map
    // from pass 1 is still exactly right; freeze it for the rest of the frame.
    renderer.shadowMap.autoUpdate = false;

    // 2. the characters alone, flat white on black, with their own depth so
    //    the silhouette is solid.
    this.maskCamera.copy(camera);
    this.maskCamera.layers.set(INK_LAYER);
    scene.overrideMaterial = this.maskMaterial;
    scene.background = null;
    renderer.setRenderTarget(this.maskRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false; // one cleared mask, drawn in two passes
    renderer.render(scene, this.maskCamera);
    this.maskCamera.layers.set(INK_INSTANCED_LAYER);
    scene.overrideMaterial = this.maskMaterialInstanced;
    renderer.render(scene, this.maskCamera);
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    // 3. composite
    renderer.setRenderTarget(prevTarget);
    renderer.render(this.quadScene, this.quadCamera);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
  }

  dispose(): void {
    this.sceneRT.depthTexture?.dispose();
    this.maskRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.maskRT.dispose();
    this.composite.dispose();
    this.maskMaterial.dispose();
    this.maskMaterialInstanced.dispose();
    this.quadGeometry.dispose();
  }
}
