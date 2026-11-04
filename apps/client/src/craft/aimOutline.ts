import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/** Ink and paper: a dark line reads on wool and sand, the light core on stone and coal. */
const INK = 0x17120f;
const PAPER = 0xfff6d8;
/** CSS pixels at any distance (scaled by the renderer's pixel ratio when drawn). The ink shows
 *  (INK_PX - PAPER_PX) / 2 ≈ 2 px either side of the paper core — at 1.3 px it did not read. */
const INK_PX = 6;
const PAPER_PX = 2.2;
/** Edges are pulled this far toward the eye before the depth test. */
const PULL_M = 0.045;
/** While the block is being broken its cracked copy opens outward by a few cm (miningFracture's
 *  seams), and seen at an angle a 4.5 cm pull covers less than that along the surface: the
 *  pieces covered the box and it went pale as the dig started. Its far edges are a metre back. */
const PULL_MINING_M = 0.12;

/**
 * The box around the block under the crosshair.
 *
 * Why it is not a plain `LineSegments` box any more:
 * - WebGL draws every `LineBasicMaterial` 1 px wide (`linewidth` is ignored), which vanished on a
 *   busy brick texture and shrank to nothing at a distance.
 * - Joined blocks are ONE shell (kitShell): the aimed cell's edges on a shared side lie exactly on
 *   the neighbour's surface, so a depth-tested 1.002 box lost those edges to z-fighting and read
 *   as a frame of the wrong size. Pulling the edges a few centimetres toward the eye before the
 *   depth test lets every front edge win against the surface it lies on, while the far edges stay
 *   hidden behind the block itself (it is a metre deep, far more than the pull).
 */
export class AimOutline {
  readonly object = new THREE.Group();
  private readonly geometry: LineSegmentsGeometry;
  private readonly materials: LineMaterial[] = [];
  private readonly size = new THREE.Vector2();
  /** Shared by both lines' shaders. */
  private readonly pull = { value: PULL_M };

  /** `size`: box edge in metres. `xray`: drawn over everything (the machine lab's build cursor,
   *  which must show through the parts around it) — no depth test, so no pull either. */
  constructor(options: { size?: number; xray?: boolean } = {}) {
    const size = options.size ?? 1.004;
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size));
    this.geometry = new LineSegmentsGeometry().fromEdgesGeometry(edges);
    edges.dispose();
    for (const [color, px, order] of [[INK, INK_PX, 10], [PAPER, PAPER_PX, 11]] as const) {
      const material = new LineMaterial({ color, linewidth: px, worldUnits: false, fog: false, depthTest: !options.xray });
      material.onBeforeCompile = (shader) => {
        shader.uniforms.aimPull = this.pull;
        shader.vertexShader = "uniform float aimPull;\n" + shader.vertexShader.replace(
          "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
          `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
			start.xyz -= normalize( start.xyz ) * aimPull;
			end.xyz -= normalize( end.xyz ) * aimPull;`,
        );
      };
      material.customProgramCacheKey = () => "craftyap-aim-outline";
      const line = new LineSegments2(this.geometry, material);
      line.renderOrder = order; // the paper core after the ink, on top of it
      line.frustumCulled = false; // one box; the boot warm-up draws it far below the world
      // never something to hit: LineSegments2.raycast also throws without `raycaster.camera`,
      // which any scene-wide raycast (tests, picking) does not set
      line.raycast = () => {};
      // pixel width follows whatever this frame renders into (canvas or the ink pass's target)
      line.onBeforeRender = (renderer) => {
        const target = renderer.getRenderTarget();
        if (target) this.size.set(target.width, target.height);
        else renderer.getDrawingBufferSize(this.size);
        material.resolution.copy(this.size);
        material.linewidth = px * renderer.getPixelRatio();
      };
      this.materials.push(material);
      this.object.add(line);
    }
    this.object.visible = false;
  }

  /** Centre on a cell (its min corner), or hide. `mining`: the cell is breaking (see PULL_MINING_M). */
  show(voxel: readonly [number, number, number] | null, mining = false): void {
    this.object.visible = !!voxel;
    if (voxel) this.object.position.set(voxel[0] + 0.5, voxel[1] + 0.5, voxel[2] + 0.5);
    this.pull.value = mining ? PULL_MINING_M : PULL_M;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}
