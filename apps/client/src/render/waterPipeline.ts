import * as THREE from "three";

/**
 * Water that knows what is behind it (docs/WATER_DESIGN_KO.md, stages A and B; `?water2=1`).
 *
 * The plain path blends the water's surface over the finished picture, so the water cannot tell
 * how much of itself a pixel looks through, and "underwater" is one switch for the whole screen.
 * Here the frame is built in steps:
 *
 *   1. the scene WITHOUT water        → colour + depth
 *   2. the water's nearest FRONT face → depth   (where a ray from the eye enters water)
 *      the water's nearest BACK face  → depth   (where it leaves — or, seen from inside, the
 *                                                surface the eye looks out through)
 *   3. one full-screen pass: for every pixel, the length of water the ray passes through, and
 *      from that the tint and the murk (Beer–Lambert). A ray that starts in water (the back face
 *      comes first, or — no surface in sight — the pixel is below the waterline) is underwater
 *      from the eye on. So above, at and under the surface are all the same rule, per pixel.
 *   4. the water's surface on top: only what a surface adds (sky reflection, glints, foam),
 *      nearest layer only, fading out where the water gets thin (no hard line at a bank).
 *
 * The water meshes are closed surfaces round the water (faces toward air only), so front and back
 * faces bound real volumes: a sheet is as thick as it is drawn, and a space ENCLOSED by sheets is
 * air. A pool has no faces against its floor: there the scene's depth ends the water.
 */

/** Water meshes live on this layer only while the pipeline is on: the scene pass never sees them. */
export const WATER_LAYER = 11;

/** Set by the pipeline, read by the water shader (waterMesh.ts): where the scene and the nearest
 *  water faces are, per pixel. */
export const waterPipelineUniforms = {
  tSceneDepth: { value: null as THREE.Texture | null },
  tWaterFront: { value: null as THREE.Texture | null },
  tWaterBack: { value: null as THREE.Texture | null },
  uScreen: { value: new THREE.Vector2(1, 1) },
  uNearFar: { value: new THREE.Vector2(0.1, 400) },
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <packing>
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tSceneDepth;
uniform sampler2D tWaterFront;
uniform sampler2D tWaterBack;
uniform vec2 uNearFar;
uniform mat4 uProjectionInverse;
/** Where the near plane is under the drawn surface: a coarse grid of depths under it (0.5 = at the
 *  surface, more = under), read smoothly, so its 0.5 line is the waterline — level, tilted or the
 *  side of a fall. Pixels on the wet side with no water surface in sight are looking from inside
 *  the water. */
uniform sampler2D tInside;
/** The exact rule (the simple water, whose mesh is closed): per pixel, how many faces the ray leaves
 *  the water by (red) and enters it by (green), in 1/255 steps. One more out than in: the eye is in
 *  the water. */
uniform sampler2D tCount;
uniform float uCounting; // 1: use the count; 0: the older rule; -1: the camera is nowhere near water
uniform float uInsideMin; // metres of water an eye in water looks through at the least
uniform vec3 uAbsorb;   // per metre, r g b: red goes first
uniform vec3 uScatter;  // what deep water looks like (linear colour)

float viewZ(float depth) {
  return depth >= 1.0 ? 1.0e9 : -perspectiveDepthToViewZ(depth, uNearFar.x, uNearFar.y);
}

void main() {
  vec3 scene = texture2D(tScene, vUv).rgb;
  float sceneZ = min(viewZ(texture2D(tSceneDepth, vUv).x), uNearFar.y);
  float front = viewZ(texture2D(tWaterFront, vUv).x);
  float back = viewZ(texture2D(tWaterBack, vUv).x);
  bool none = front > 1.0e8 && back > 1.0e8;
  // does the ray start in water?
  vec2 crossed = texture2D(tCount, vUv).rg * 255.0;
  bool inside = uCounting > 0.5 ? crossed.r - crossed.g > 0.5
    : uCounting < -0.5 ? false
    : none ? texture2D(tInside, vUv).r > 0.5 : back < front;
  float from = inside ? 0.0 : front;
  float to = min(back, sceneZ);
  float water = (inside || front < 1.0e8) ? max(0.0, to - from) : 0.0;
  // view depth → length along this pixel's ray
  vec4 ray = uProjectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  water *= length(ray.xyz) / max(1.0e-4, abs(ray.z));
  // An eye IN water sees through at least this much of it. By length alone, standing in a fall
  // one cell wide looked like standing in air (half a metre of water is nearly clear), and the
  // ground underfoot — 30 cm away, no water face before it — was a clear hole in the haze.
  if (inside) water = max(water, uInsideMin);
  vec3 through = exp(-uAbsorb * water);
  gl_FragColor = vec4(scene * through + uScatter * (1.0 - through), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The grid the game measures the near plane on (see `WaterPipeline.inside`). */
export const INSIDE_W = 16, INSIDE_H = 9;

export class WaterPipeline {
  private readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly frontRT: THREE.WebGLRenderTarget;
  private readonly backRT: THREE.WebGLRenderTarget;
  private readonly countRT: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly composite: THREE.ShaderMaterial;
  private readonly clearColor = new THREE.Color();
  private width = 1;
  private height = 1;
  /** The near plane's depth under the drawn surface on an INSIDE_W × INSIDE_H grid (row 0 at the
   *  bottom; texel centres), as 128 + depth × 2550 clamped to a byte (±5 cm): set by the game each
   *  frame, then {@link insideChanged}. */
  readonly inside = new Uint8Array(INSIDE_W * INSIDE_H);
  private readonly insideTexture = new THREE.DataTexture(this.inside, INSIDE_W, INSIDE_H, THREE.RedFormat, THREE.UnsignedByteType);
  insideChanged(): void {
    this.insideTexture.needsUpdate = true;
  }
  /** The water's three materials for the extra passes (waterMesh.ts): nearest front face, nearest
   *  back face (depth only), and the surface drawn on top. */
  materials: { front: THREE.Material; back: THREE.Material; surface: THREE.Material; count: THREE.Material } | null = null;
  /** Is the camera at water this frame (set by the game: any water in the cells round it)? Only
   *  then is the eye-in-water question asked at all. */
  atWater = false;
  /** The water mesh is closed (the simple water): the count answers exactly. Otherwise (the
   *  older surface net, open against blocks) the measured grid and the nearest faces do. */
  exact = true;

  constructor(renderer: THREE.WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);
    const float = renderer.capabilities.isWebGL2 && renderer.extensions.has("EXT_color_buffer_half_float");
    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      samples: 4, // the canvas's antialiasing, which a render target otherwise loses
      type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthTexture: new THREE.DepthTexture(this.width, this.height),
    });
    const depthOnly = () => new THREE.WebGLRenderTarget(this.width, this.height, { depthTexture: new THREE.DepthTexture(this.width, this.height) });
    this.frontRT = depthOnly();
    this.backRT = depthOnly();
    this.countRT = new THREE.WebGLRenderTarget(this.width, this.height, { depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
    this.insideTexture.magFilter = this.insideTexture.minFilter = THREE.LinearFilter;
    this.insideTexture.needsUpdate = true;
    this.composite = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tSceneDepth: { value: this.sceneRT.depthTexture },
        tWaterFront: { value: this.frontRT.depthTexture },
        tWaterBack: { value: this.backRT.depthTexture },
        uNearFar: waterPipelineUniforms.uNearFar,
        uProjectionInverse: { value: new THREE.Matrix4() },
        tInside: { value: this.insideTexture },
        tCount: { value: this.countRT.texture },
        uCounting: { value: -1 },
        uInsideMin: { value: 5 },
        uAbsorb: { value: new THREE.Vector3(0.26, 0.075, 0.055) },
        uScatter: { value: new THREE.Color(0x0b4a6b) },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
    waterPipelineUniforms.tSceneDepth.value = this.sceneRT.depthTexture;
    waterPipelineUniforms.tWaterFront.value = this.frontRT.depthTexture;
    waterPipelineUniforms.tWaterBack.value = this.backRT.depthTexture;
  }

  /** The target the scene is drawn into: shaders warmed against it compile the variants this path uses. */
  get compileTarget(): THREE.WebGLRenderTarget {
    return this.sceneRT;
  }

  private setSize(width: number, height: number): void {
    const w = Math.max(1, width), h = Math.max(1, height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    this.frontRT.setSize(w, h);
    this.backRT.setSize(w, h);
    this.countRT.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
    waterPipelineUniforms.uScreen.value.set(this.width, this.height);
    waterPipelineUniforms.uNearFar.value.set(camera.near, camera.far);
    const layers = camera.layers.mask, background = scene.background, override = scene.overrideMaterial;
    const autoClear = renderer.autoClear, shadows = renderer.shadowMap.autoUpdate;
    try {
      // 1. the scene without its water
      camera.layers.disable(WATER_LAYER);
      renderer.setRenderTarget(this.sceneRT);
      renderer.render(scene, camera);
      // the shadow map is this frame's already: the water passes must not rebuild it (it ignores
      // camera layers, and would be redrawn three more times)
      renderer.shadowMap.autoUpdate = false;
      if (this.materials) {
        // 2. where a ray enters the water, and where it leaves it
        camera.layers.set(WATER_LAYER);
        scene.background = null;
        scene.overrideMaterial = this.materials.front;
        renderer.setRenderTarget(this.frontRT);
        renderer.render(scene, camera);
        scene.overrideMaterial = this.materials.back;
        renderer.setRenderTarget(this.backRT);
        renderer.render(scene, camera);
        // ...and, while the camera is at water, how many faces each ray leaves it and enters it by
        if (this.atWater && this.exact) {
          const alpha = renderer.getClearAlpha();
          renderer.getClearColor(this.clearColor);
          renderer.setClearColor(0x000000, 0);
          scene.overrideMaterial = this.materials.count;
          renderer.setRenderTarget(this.countRT);
          renderer.render(scene, camera);
          renderer.setClearColor(this.clearColor, alpha);
        }
      }
      // 3. the picture, seen through however much water each pixel looks through
      (this.composite.uniforms.uProjectionInverse!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      this.composite.uniforms.uCounting!.value = !this.atWater ? -1 : this.exact && this.materials ? 1 : 0;
      renderer.setRenderTarget(null);
      renderer.render(this.quadScene, this.quadCamera);
      if (this.materials) {
        // 4. the surface itself, over it
        renderer.autoClear = false;
        scene.overrideMaterial = this.materials.surface;
        renderer.render(scene, camera);
      }
    } finally {
      camera.layers.mask = layers;
      scene.background = background;
      scene.overrideMaterial = override;
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadows;
      renderer.setRenderTarget(null);
    }
  }

  dispose(): void {
    for (const rt of [this.sceneRT, this.frontRT, this.backRT, this.countRT]) { rt.depthTexture?.dispose(); rt.dispose(); }
    this.composite.dispose();
    this.insideTexture.dispose();
    waterPipelineUniforms.tSceneDepth.value = waterPipelineUniforms.tWaterFront.value = waterPipelineUniforms.tWaterBack.value = null;
  }
}
