import * as THREE from "three";
export interface ArmAttachment {
    bone: THREE.Bone;
    cap: THREE.Vector3;
    anchor: THREE.Vector3;
}
/** Bind an actual point inside the upper arm's cap, rather than its remote rig origin. */
export function bindArmAttachments(meshes: readonly THREE.SkinnedMesh[]): ArmAttachment[] {
    const result: ArmAttachment[] = [];
    for (const mesh of meshes)
        for (const side of ["L", "R"]) {
            const value: unknown = mesh.userData["arm_cap_" + side];
            if (!Array.isArray(value) || value.length !== 3 || !value.every((n: unknown) => typeof n === "number" && Number.isFinite(n)))
                continue;
            const index = mesh.skeleton.bones.findIndex(b => b.name.replace(/[._]/g, "") === "upperarm" + side);
            const bone = mesh.skeleton.bones[index];
            if (!bone?.parent)
                continue;
            const cap = new THREE.Vector3(value[0] as number, value[1] as number, value[2] as number).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[index]!);
            bone.updateMatrix();
            result.push({ bone, cap, anchor: cap.clone().applyMatrix4(bone.matrix) });
        }
    return result;
}
const offset = new THREE.Vector3();
/** Compensate rotation around the cap, keeping it attached even during additive mixing. */
export function constrainArms(attachments: readonly ArmAttachment[]): void {
    for (const { bone, cap, anchor } of attachments) {
        offset.copy(cap).multiply(bone.scale).applyQuaternion(bone.quaternion);
        bone.position.copy(anchor).sub(offset);
    }
}
interface Pose {
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: THREE.Vector3;
}
/** A short bridge starts from the rendered pose, including an interrupted bridge. */
export class PoseBridge {
    private readonly source: Pose[];
    private readonly targetRotation = new THREE.Quaternion();
    private elapsed = 0;
    private seconds = 0;
    get active(): boolean { return this.elapsed < this.seconds; }
    constructor(private readonly bones: readonly THREE.Bone[]) { this.source = bones.map(() => ({ position: new THREE.Vector3(), rotation: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) })); }
    begin(seconds: number): void {
        this.elapsed = 0;
        this.seconds = seconds;
        this.bones.forEach((bone, i) => { const s = this.source[i]!; s.position.copy(bone.position); s.rotation.copy(bone.quaternion).normalize(); s.scale.copy(bone.scale); });
    }
    apply(dt: number): void {
        if (!this.active)
            return;
        this.elapsed = Math.min(this.seconds, this.elapsed + dt);
        const t = this.elapsed / this.seconds, alpha = t * t * (3 - 2 * t);
        this.bones.forEach((bone, i) => { const s = this.source[i]!; this.targetRotation.copy(bone.quaternion).normalize(); bone.position.lerpVectors(s.position, bone.position, alpha); bone.scale.lerpVectors(s.scale, bone.scale, alpha); bone.quaternion.slerpQuaternions(s.rotation, this.targetRotation, alpha).normalize(); });
    }
}
