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
 * - **It must switch off in WebXR.** A headset owns the framebuffer; render
 *   targets and full-screen quads do not survive that, so `GameRenderer` falls
 *   back to the hull shells while presenting. That is why the shells are still
 *   built rather than deleted, and why they live on their own layer.
 */

/** Solid character geometry, rendered into the silhouette mask. */
export const INK_LAYER = 7;
/** Per-brick inverted-hull shells — the fallback, hidden when ink is on. */
export const HULL_LAYER = 6;

const INK_COLOR = new THREE.Color(0x17171c);

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tMask;
uniform sampler2D tMaskDepth;
uniform sampler2D tSceneDepth;
uniform vec2 texel;
uniform vec3 inkColor;
uniform float thickness;
varying vec2 vUv;

/** 1 where a character is visible, 0 elsewhere. */
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

  gl_FragColor = vec4(toSRGB(mix(scene, inkColor, smoothstep(0.2, 0.8, e) * visible)), 1.0);
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
  /** Reused so a per-frame camera clone never hits the allocator. */
  private readonly maskCamera = new THREE.PerspectiveCamera();
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer, thickness = 1.6) {
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
    renderer.render(scene, this.maskCamera);
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
    this.quadGeometry.dispose();
  }
}
