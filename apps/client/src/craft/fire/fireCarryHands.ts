import * as THREE from "three";
import { MITTEN, RIGHT_MITTEN, fitGrip, gripMaterial } from "./toyGrip.js";

interface Socket {
  bone: THREE.Bone;
  palm: THREE.Vector3;
  cap: THREE.Vector3;
}

/** Rotates around the real shoulder cap, keeping the short mitten rig attached to its torso. */
export class FireCarryHands {
  private root: THREE.Object3D | null = null;
  private rig: THREE.Object3D | undefined;
  private sockets: (Socket | null)[] = [];
  private readonly shoulder = new THREE.Vector3();
  private readonly palm = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly current = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly weightedTurn = new THREE.Quaternion();
  private readonly capParent = new THREE.Vector3();

  private find(mesh: THREE.SkinnedMesh, side: "R" | "L"): Socket | null {
    const bones = mesh.skeleton.bones;
    const index = bones.findIndex(bone => bone.name.replace(/[._]/g, "").toUpperCase() === `UPPERARM${side}`);
    const hand = bones.findIndex(bone => bone.name.replace(/[._]/g, "").toUpperCase() === `HAND${side}`);
    const cap: unknown = mesh.userData[`arm_cap_${side}`];
    if (index < 0 || hand < 0 || !Array.isArray(cap) || cap.length !== 3) return null;
    const inverse = mesh.skeleton.boneInverses[index]!;
    const palm = new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[hand]!.clone().invert()).applyMatrix4(inverse);
    return {
      bone: bones[index]!, palm,
      cap: new THREE.Vector3(Number(cap[0]), Number(cap[1]), Number(cap[2])).applyMatrix4(mesh.bindMatrix).applyMatrix4(inverse),
    };
  }

  pose(root: THREE.Object3D | null, right: THREE.Vector3, left: THREE.Vector3, strength: number, aiming: number, pitch: number, gait: number, tuck = 0): boolean {
    if (!root) return false;
    if (root !== this.root || root.children[0] !== this.rig) {
      this.root = root;
      this.rig = root.children[0];
      let mesh: THREE.SkinnedMesh | null = null;
      root.traverse(o => { if (!mesh && o instanceof THREE.SkinnedMesh) mesh = o; });
      this.sockets = mesh ? [this.find(mesh, "R"), this.find(mesh, "L")] : [];
    }
    const [r, l] = this.sockets;
    if (!r || !l) return false;
    this.arm(root, r, right, strength, -.61, -.16 + .10 * aiming + gait, .29 + .05 * aiming - .18 * tuck);
    this.arm(root, l, left, strength, .55 - .07 * aiming, -.08 + .16 * aiming + THREE.MathUtils.clamp(pitch, -.8, .8) * .15 + gait, .34 + .07 * aiming - .16 * tuck);
    return true;
  }

  private arm(root: THREE.Object3D, socket: Socket, out: THREE.Vector3, strength: number, x: number, y: number, z: number): void {
    const { bone, cap, palm } = socket;
    const parent = bone.parent!;
    bone.updateWorldMatrix(true, false);
    this.shoulder.copy(cap).applyMatrix4(bone.matrixWorld);
    this.palm.copy(palm).applyMatrix4(bone.matrixWorld);
    root.worldToLocal(this.desired.copy(this.shoulder));
    this.desired.x = x;
    this.desired.y += y;
    this.desired.z += z;
    root.localToWorld(this.desired);
    parent.worldToLocal(this.desired);
    parent.worldToLocal(this.palm);
    this.capParent.copy(this.shoulder);
    parent.worldToLocal(this.capParent);
    this.current.copy(this.palm).sub(this.capParent).normalize();
    this.desired.sub(this.capParent).normalize();
    this.turn.setFromUnitVectors(this.current, this.desired);
    this.weightedTurn.slerpQuaternions(IDENTITY, this.turn, strength);
    bone.quaternion.premultiply(this.weightedTurn).normalize();
    bone.position.copy(this.capParent).sub(this.palm.copy(cap).multiply(bone.scale).applyQuaternion(bone.quaternion));
    bone.updateWorldMatrix(false, true);
    out.copy(palm).applyMatrix4(bone.matrixWorld);
  }
}

const IDENTITY = new THREE.Quaternion();

/** The nozzle rests under the cartoon palm; its rear ferrule stays outside it. */
export function positionViewNozzleGrip(rotation:THREE.Quaternion,hand:THREE.Vector3,out:THREE.Vector3):THREE.Vector3 {
  return out.set(.075,-.075,0).applyQuaternion(rotation).add(hand);
}

/** Camera-space grips keep both hands visible across changes in view pitch. */
export function positionViewGrips(
  camera: THREE.Camera, rotation: THREE.Quaternion, right: THREE.Vector3, left: THREE.Vector3,
  aim: number, tuck: number, gait: number,
): void {
  // Keep the hands in the lower part of the frame when portrait mode widens FOV.
  const screenScale=camera instanceof THREE.PerspectiveCamera
    ? 1/(camera.projectionMatrix.elements[5]*Math.tan(THREE.MathUtils.degToRad(35))) : 1;
  right.set(.323 - tuck*.05, (-.345 + gait - tuck*.10)*screenScale, -.76 + tuck*.34)
    .applyQuaternion(rotation).add(camera.position);
  left.set(-.278 + aim*.035, (-.290 + aim*.02 + gait - tuck*.12)*screenScale, -.80 - aim*.035 + tuck*.34)
    .applyQuaternion(rotation).add(camera.position);
}

/** Continuous mascot hands and forearms, seated around the actual tool grips. */
export class FireFirstPersonArms {
  readonly root = new THREE.Group();
  private readonly arms = [RIGHT_MITTEN,MITTEN].map(geometry => new THREE.Mesh(geometry.clone(), gripMaterial(0xffd12f)));
  private readonly lastWrists = [new THREE.Vector3(Infinity,0,0),new THREE.Vector3(Infinity,0,0)];
  private lastGrasp=-1;
  private readonly towardWrist = new THREE.Vector3();
  private readonly localWrist = new THREE.Vector3();
  private readonly opening = new THREE.Vector3();
  private readonly vertical = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly facing = new THREE.Quaternion();
  private readonly basis = new THREE.Matrix4();

  constructor() {
    this.root.name = "Extinguisher first-person hands";
    this.root.visible = false;
    for (const [i, mitten] of this.arms.entries()) {
      mitten.name = `${i === 0 ? "Right" : "Left"} continuous character hand`;
      mitten.frustumCulled = false;
      this.root.add(mitten);
    }
  }

  pose(camera: THREE.Camera, right: THREE.Vector3, left: THREE.Vector3, originX: number, originZ: number, variant: string, handleAxis: THREE.Vector3, nozzleAxis: THREE.Vector3, grasp=1): void {
    camera.getWorldQuaternion(this.facing);
    const colors = GRIP_COLORS[variant] ?? GRIP_COLORS.mascot!;
    this.arms.forEach((mitten, i) => {
      const grip = i === 0 ? right : left;
      const side = i === 0 ? 1 : -1;
      this.axis.copy(i === 0 ? handleAxis : nozzleAxis).normalize();
      this.towardWrist.set(side*(i===0?.40:.25),i===0?-.72:-.91,i===0?.58:.39).applyQuaternion(this.facing).normalize();
      // The palm and forearm share their direction, avoiding a folded right wrist.
      this.opening.copy(this.towardWrist).negate();
      this.opening.addScaledVector(this.axis,-this.opening.dot(this.axis));
      if (this.opening.lengthSq() < .001) {
        this.opening.set(1,0,0).applyQuaternion(this.facing);
        this.opening.addScaledVector(this.axis,-this.opening.dot(this.axis));
      }
      this.opening.normalize();
      this.vertical.crossVectors(this.axis,this.opening).normalize();
      this.basis.makeBasis(this.opening,this.vertical,this.axis);
      mitten.quaternion.setFromRotationMatrix(this.basis);
      mitten.position.copy(grip);
      mitten.material = gripMaterial(colors);
      this.localWrist.set(this.towardWrist.dot(this.opening), this.towardWrist.dot(this.vertical), this.towardWrist.dot(this.axis));
      if (Math.abs(grasp-this.lastGrasp)>1e-5||this.localWrist.distanceToSquared(this.lastWrists[i]!)>1e-10) {
        fitGrip(mitten.geometry,this.localWrist,i===0,grasp);
        this.lastWrists[i]!.copy(this.localWrist);
      }
      mitten.position.x += originX;
      mitten.position.z += originZ;
    });
    this.lastGrasp=grasp;
  }

  dispose(): void {
    for (const mesh of this.arms) mesh.geometry.dispose();
  }
}

const GRIP_COLORS: Record<string,number> = {
  mascot:0xffd12f,
  tt:0xb9a4eb,
  blue:0x8bcde5,
  purple:0xbb9fe6,
};
