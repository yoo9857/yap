import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/**
 * A white line over a soft shadow. The first version was a hard black line with a white core:
 * readable, but the pure black against pure white jumped out of the soft crayon world. The
 * shadow is just dark enough to lift the line off white wool; on stone and brick the white reads.
 */
const SHADOW = 0x000000;
const SHADOW_OPACITY = 0.28;
const LINE = 0xffffff;
const LINE_OPACITY = 0.95;
/** CSS pixels at any distance (scaled by the renderer's pixel ratio when drawn). */
const SHADOW_PX = 5;
const LINE_PX = 2.5;
/** Edges are pulled this far toward the eye before the depth test, plus 0.6 % of their distance
 *  (depth precision falls with distance: a fixed pull z-fought the block face far away). */
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
    for (const [color, px, opacity, order] of [[SHADOW, SHADOW_PX, SHADOW_OPACITY, 10], [LINE, LINE_PX, LINE_OPACITY, 11]] as const) {
      // depthWrite off: the two lines sit at the SAME depth, and with both writing it, rounding
      // decided frame by frame which one won — the core blinked whenever the camera moved
      const material = new LineMaterial({ color, linewidth: px, worldUnits: false, fog: false, depthTest: !options.xray, depthWrite: false, transparent: true, opacity });
      material.onBeforeCompile = (shader) => {
        shader.uniforms.aimPull = this.pull;
        shader.vertexShader = "uniform float aimPull;\n" + shader.vertexShader.replace(
          "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
          `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
			start.xyz -= normalize( start.xyz ) * ( aimPull + 0.006 * length( start.xyz ) );
			end.xyz -= normalize( end.xyz ) * ( aimPull + 0.006 * length( end.xyz ) );`,
        );
      };
      material.customProgramCacheKey = () => "craftyap-aim-outline";
      const line = new LineSegments2(this.geometry, material);
      line.renderOrder = order; // the white line after its shadow, on top of it
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
  show(voxel: readonly [number, number, number] | null, mining = false, bounds?: { min: readonly number[]; max: readonly number[] }): void {
    this.object.visible = !!voxel;
    if (voxel) {
      // framed to what the cell holds (a half block: its half), not always the whole cell
      const lo = bounds?.min ?? [0, 0, 0], hi = bounds?.max ?? [1, 1, 1];
      this.object.position.set(voxel[0] + (lo[0]! + hi[0]!) / 2, voxel[1] + (lo[1]! + hi[1]!) / 2, voxel[2] + (lo[2]! + hi[2]!) / 2);
      this.object.scale.set(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
    }
    this.pull.value = mining ? PULL_MINING_M : PULL_M;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}
