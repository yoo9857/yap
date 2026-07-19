import * as THREE from "three";

/**
 * Owns the WebGL renderer, scene, lighting and sky. The directional light's
 * shadow frustum follows the player up the tower so shadows stay sharp.
 */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Exposed so game modes can grade their own mood (builder = golden hour). */
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;

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
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff4d6, 2.0);
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

    window.addEventListener("resize", this.onResize);
  }

  /** Keep the sun (and its shadow box) centered on the action. */
  trackTarget(target: THREE.Vector3): void {
    this.sun.position.set(target.x + 18, target.y + 35, target.z + 14);
    this.sun.target.position.copy(target);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Stop resize callbacks and release the WebGL context when a mode closes. */
  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };
}
