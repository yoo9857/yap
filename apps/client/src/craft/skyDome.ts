import * as THREE from "three";

/**
 * Gradient sky for the voxel modes: deep blue overhead easing down to the FOG
 * colour at the horizon. Distant chunks fade into fog, so the horizon has to
 * be that same colour or faded terrain reads as a pale wall against a blue
 * sky. Follows the camera (never reachable) and ignores fog itself.
 */
export class SkyDome {
  private readonly mesh: THREE.Mesh;
  private readonly uniforms: { top: { value: THREE.Color }; horizon: { value: THREE.Color } };

  constructor(
    private readonly scene: THREE.Scene,
    top: number,
    horizon: number,
  ) {
    this.uniforms = { top: { value: new THREE.Color(top) }, horizon: { value: new THREE.Color(horizon) } };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        varying vec3 vDir;
        void main() {
          // flat fog colour at and below the horizon, easing to blue above
          float t = smoothstep(0.0, 0.45, vDir.y);
          gl_FragColor = vec4(mix(horizon, top, t), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    // inside the camera's 400 m far plane
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(350, 32, 16), material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    scene.background = new THREE.Color(horizon);
  }

  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
