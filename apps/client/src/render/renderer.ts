import * as THREE from "three";
import { HULL_LAYER, InkOutline } from "./inkOutline.js";

/**
 * Owns the WebGL renderer, scene, lighting and sky. The directional light's
 * shadow frustum follows the player up the tower so shadows stay sharp.
 *
 * Characters are inked in SCREEN SPACE (`inkOutline.ts`) rather than with a
 * per-brick hull, so a creature gets one line around its silhouette instead of
 * one around every piece it is built from. The hulls are still built and still
 * in the scene — they live on `HULL_LAYER`, which the camera drops while the
 * ink pass is running and picks back up when it cannot run, because WebXR
 * cannot render through the render targets the pass needs. `?ink=0` forces the
 * fallback for comparison.
 */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Exposed so game modes can grade their own mood (builder = golden hour). */
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private ink: InkOutline | null = null;

  constructor(mount: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // cap at 1.5: on 2×/retina panels a full 2.0 quadruples fragment work for
    // little visible gain on this blocky art, and that headroom is what stops
    // the intermittent GPU-bound hitches on high-DPI laptops
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x7ec8f0);
    this.scene.fog = new THREE.Fog(0x9fd8f5, 60, 160);

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      400,
    );

    this.hemi = new THREE.HemisphereLight(0xdff3ff, 0x5a7d54, 0.9);
    this.hemi.layers.enableAll(); // see inkVisibleLights
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff4d6, 2.0);
    this.sun.layers.enableAll(); // see inkVisibleLights
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -22;
    cam.right = 22;
    cam.top = 22;
    cam.bottom = -22;
    cam.near = 1;
    cam.far = 120;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Hull shells are on their own layer so the ink pass can drop them in one
    // call; the camera has to opt in for the fallback to be visible at all.
    this.camera.layers.enable(HULL_LAYER);
    const wantsInk = new URLSearchParams(location.search).get("ink") !== "0";
    if (wantsInk && this.renderer.capabilities.isWebGL2) {
      this.ink = new InkOutline(this.renderer);
      this.camera.layers.disable(HULL_LAYER);
    }

    window.addEventListener("resize", this.onResize);
  }

  /**
   * Turn on WebXR presentation. `local-floor` means y = 0 is the physical floor
   * and the headset supplies the real eye height — so a viewpoint we place at
   * y = 40 puts the player's eyes ~41.6 m up, standing, not floating.
   */
  enableXr(): void {
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local-floor");
  }

  /**
   * Parent the camera under a rig Group and return it.
   *
   * In an XR session the headset OWNS the camera's local transform — anything
   * we write to `camera.position/quaternion` is overwritten each frame. Placing
   * the viewer therefore means moving this rig instead. The rig stays at
   * identity until someone moves it, so world-space camera math elsewhere is
   * unchanged for the flat-screen path.
   */
  attachXrRig(): THREE.Group {
    if (this.xrRig) return this.xrRig;
    const rig = new THREE.Group();
    rig.add(this.camera);
    this.scene.add(rig);
    this.xrRig = rig;
    return rig;
  }

  private xrRig: THREE.Group | null = null;

  /** Keep the sun (and its shadow box) centered on the action. */
  trackTarget(target: THREE.Vector3): void {
    this.sun.position.set(target.x + 18, target.y + 35, target.z + 14);
    this.sun.target.position.copy(target);
  }

  render(): void {
    // Presenting to a headset means the XR system owns the framebuffer, and a
    // full-screen composite through a render target does not survive that —
    // so the per-brick hulls come back for the duration.
    const presenting = this.renderer.xr.isPresenting;
    if (!this.ink || presenting) {
      this.camera.layers.enable(HULL_LAYER);
      this.renderer.info.autoReset = true;
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.camera.layers.disable(HULL_LAYER);
    // `renderer.info` resets on every render() by default, so with three
    // passes a frame the overlay would report the full-screen quad's two
    // triangles as the whole scene. Reset once per FRAME and let the passes
    // accumulate, which is the honest number.
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    const size = this.renderer.getDrawingBufferSize(this.tmpSize);
    this.ink.setSize(size.x, size.y);
    this.ink.render(this.renderer, this.scene, this.camera);
  }

  private readonly tmpSize = new THREE.Vector2();

  /** Stop resize callbacks and release the WebGL context when a mode closes. */
  dispose(): void {
    this.ink?.dispose();
    this.ink = null;
    window.removeEventListener("resize", this.onResize);
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly onResize = (): void => {
    // while presenting, the headset owns the drawing buffer size and three
    // rejects setSize with a console warning — don't even ask
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };
}
