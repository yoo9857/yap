import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * Shared brick geometries + orientation, used by both the world renderer
 * (`voxelView`) and the placement ghost so a preview always matches what lands.
 */

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Soft rounded cube, slightly oversized so neighbours overlap (no grooves). */
export function cubeBrickGeometry(): THREE.BufferGeometry {
  return new RoundedBoxGeometry(1.1, 1.1, 1.1, 1, 0.07);
}

/** Round (cylinder) brick — the "○" piece. */
export function roundBrickGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.56, 0.56, 1.1, 16);
}

/** Stud cap for flat-topped bricks. Sized for a 0.5 m sub-cell (4 studs per 1 m
 *  voxel — see voxelView) so the studs are as small + dense as the jump map's
 *  0.7 m tessellated bricks, instead of one big stud that reads oversized. */
export function studGeometry(): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(0.09, 0.1, 0.1, 12);
  g.translate(0, 0.05, 0); // sits on the brick top
  return g;
}

/**
 * A right-triangular wedge filling the cell: full height at the back (−Z) edge,
 * tapering to zero at the front (+Z) edge. Every face is wound CCW so
 * computeVertexNormals gives correct OUTWARD flat normals (a mixed winding is
 * what made the slope shade wrong). Rotated per instance for its facings.
 */
export function slopeBrickGeometry(s = 0.55): THREE.BufferGeometry {
  const L0 = [-s, -s, -s], L1 = [-s, s, -s], L2 = [-s, -s, s]; // left cap (x=−s)
  const R0 = [s, -s, -s], R1 = [s, s, -s], R2 = [s, -s, s]; //     right cap (x=+s)
  const tri = (a: number[], b: number[], c: number[]): number[] => [...a, ...b, ...c];
  const pos = [
    ...tri(L0, L2, L1), // left cap        → −X
    ...tri(R0, R1, R2), // right cap       → +X
    ...tri(L0, R0, R2), ...tri(L0, R2, L2), // bottom → −Y
    ...tri(L0, L1, R1), ...tri(L0, R1, R0), // back wall → −Z
    ...tri(L1, R2, R1), ...tri(L1, L2, R2), // sloped face → +Y+Z
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  // grain map needs a uv channel; a flat one gives an even tint (fine on a slope)
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  geo.computeVertexNormals();
  return geo;
}

/** Quaternion for a brick oriented by yaw (about Y) then tilt (about X). */
export function brickOrientation(yaw: number, tilt: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const qy = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw * (Math.PI / 2));
  const qx = new THREE.Quaternion().setFromAxisAngle(X_AXIS, tilt * (Math.PI / 2));
  return out.multiplyQuaternions(qx, qy); // apply yaw first, then tilt
}
