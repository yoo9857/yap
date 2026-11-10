import * as THREE from "three";
import { GARAGE_LAYER } from "./garageStage.js";

/** A thin silhouette around the real part; it never paints over its colour. */
export class PartSelection {
  readonly object = new THREE.Group();
  private readonly shells: THREE.Mesh[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly resolution = new THREE.Vector2(1600, 900);
  private readonly width = { value: 2 };
  private readonly material = new THREE.ShaderMaterial({
    uniforms: {
      viewport: { value: this.resolution },
      ink: { value: new THREE.Color(0xf2d497) },
      width: this.width,
    },
    vertexShader: `
      uniform vec2 viewport;
      uniform float width;
      void main() {
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vec3 viewNormal = normalize(normalMatrix * normal);
        vec4 clip = projectionMatrix * view;
        vec2 direction = (projectionMatrix * vec4(viewNormal, 0.0)).xy;
        direction /= max(length(direction), .0001);
        clip.xy += direction * width * 2.0 / viewport * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: `
      uniform vec3 ink;
      void main() {
        gl_FragColor = vec4(ink, .88);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  constructor() {
    this.object.name = "garage-block-selection";
    this.object.visible = false;
  }

  show(meshes: readonly THREE.InstancedMesh[], selection: number | readonly number[]): void {
    let used = 0;
    const indices = [...new Set(typeof selection === "number" ? [selection] : selection)];
    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.every(material => material.transparent)) continue;
      for (const index of indices) {
        const slot = (mesh.userData.partIndices as number[]).indexOf(index);
        if (index < 0 || slot < 0) continue;
        let shell = this.shells[used];
        if (!shell) {
          shell = new THREE.Mesh(mesh.geometry, this.material);
          shell.layers.set(GARAGE_LAYER);
          shell.matrixAutoUpdate = false;
          shell.frustumCulled = false;
          shell.renderOrder = 12;
          shell.raycast = () => {};
          shell.onBeforeRender = renderer => {
            renderer.getDrawingBufferSize(this.resolution);
            this.width.value = 2 * renderer.getPixelRatio();
          };
          this.shells.push(shell);
          this.object.add(shell);
        }
        shell.geometry = mesh.geometry;
        mesh.getMatrixAt(slot, this.matrix);
        shell.matrix.multiplyMatrices(mesh.matrixWorld, this.matrix);
        shell.matrixWorldNeedsUpdate = true;
        shell.visible = true;
        used++;
      }
    }
    this.shells.forEach((shell, i) => { shell.visible = i < used; });
    this.object.visible = used > 0;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.clear();
    this.material.dispose();
    this.shells.length = 0;
  }
}
