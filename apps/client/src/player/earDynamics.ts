import * as THREE from "three";
interface Ear {
    bone: THREE.Bone;
    mesh: THREE.SkinnedMesh;
    samples: number[];
    applied: THREE.Quaternion;
    pitch: number;
    roll: number;
    vp: number;
    vr: number;
    side: number;
    parentRotation: THREE.Quaternion | null;
    tip?: THREE.Bone;
    tipApplied: THREE.Quaternion;
    fold: number;
    vf: number;
}
const clamp = THREE.MathUtils.clamp;
/** Secondary ear motion is applied after body mixing and removed before capturing a pose. */
export class EarDynamics {
    private readonly ears: Ear[] = [];
    private lastSpeed = 0;
    private lastYaw: number | null = null;
    private time = 0;
    private readonly axisX = new THREE.Vector3(1, 0, 0);
    private readonly axisZ = new THREE.Vector3(0, 0, 1);
    private readonly pitchRotation = new THREE.Quaternion();
    private readonly rollRotation = new THREE.Quaternion();
    private readonly tipRotation = new THREE.Quaternion();
    private readonly parentRotation = new THREE.Quaternion();
    private readonly deltaRotation = new THREE.Quaternion();
    private readonly direction = new THREE.Vector3();
    private readonly point = new THREE.Vector3();
    constructor(private readonly root: THREE.Object3D, meshes: readonly THREE.SkinnedMesh[]) {
        for (const mesh of meshes)
            for (const side of ["L", "R"]) {
                const index = mesh.skeleton.bones.findIndex(b => b.name.replace(/[._]/g, "") === "ear" + side), bone = mesh.skeleton.bones[index];
                if (!bone)
                    continue;
                const tipIndex = mesh.skeleton.bones.findIndex(b => b.name.replace(/[._]/g, "") === "eartip" + side), tip = mesh.skeleton.bones[tipIndex];
                const skin = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight"), samples: number[] = [];
                for (let v = 0; v < skin.count; v++)
                    for (let i = 0; i < 4; i++)
                        if ((skin.getComponent(v, i) === index || skin.getComponent(v, i) === tipIndex) && weights.getComponent(v, i) > .25) {
                            samples.push(v);
                            break;
                        }
                this.ears.push({ bone, mesh, samples, applied: new THREE.Quaternion(), pitch: 0, roll: 0, vp: 0, vr: 0, side: side === "L" ? 1 : -1, parentRotation: null, tip, tipApplied: new THREE.Quaternion(), fold: 0, vf: 0 });
            }
    }
    removeOffset(): void { for (const ear of this.ears) {
        ear.bone.quaternion.multiply(ear.applied.invert()).normalize();
        ear.applied.identity();
        if (ear.tip) {
            ear.tip.quaternion.multiply(ear.tipApplied.invert()).normalize();
            ear.tipApplied.identity();
        }
    } }
    kick(impulse: number): void { for (const ear of this.ears) {
        ear.vp += clamp(impulse, -4, 4) * .23;
        ear.vr += ear.side * clamp(impulse, -4, 4) * .04;
        ear.vf -= clamp(impulse, -4, 4) * 1.25;
    } }
    update(dt: number, speed: number, air: boolean, low: boolean): void {
        if (!this.ears.length)
            return;
        this.time += dt;
        this.root.updateMatrixWorld(true);
        this.root.getWorldDirection(this.direction);
        const yaw = Math.atan2(this.direction.x, this.direction.z), turn = this.lastYaw === null ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / dt;
        const acceleration = clamp((speed - this.lastSpeed) / dt, -40, 40);
        this.lastYaw = yaw;
        this.lastSpeed = speed;
        for (const ear of this.ears) {
            const parent = ear.bone.parent;
            let bodyPitch = 0, bodyRoll = 0;
            if (parent) {
                parent.getWorldQuaternion(this.parentRotation);
                if (ear.parentRotation) {
                    this.deltaRotation.copy(ear.parentRotation).invert().multiply(this.parentRotation);
                    if (this.deltaRotation.w < 0)
                        this.deltaRotation.set(-this.deltaRotation.x, -this.deltaRotation.y, -this.deltaRotation.z, -this.deltaRotation.w);
                    bodyPitch = clamp(2 * this.deltaRotation.x / dt, -8, 8);
                    bodyRoll = clamp(2 * this.deltaRotation.z / dt, -8, 8);
                }
                if (!ear.parentRotation)
                    ear.parentRotation = new THREE.Quaternion();
                ear.parentRotation.copy(this.parentRotation);
            }
            const amplitude = low ? .15 : 1;
            const targetPitch = clamp((-speed * .021 - acceleration * .003 - bodyPitch * .025 + (air ? .045 : 0)), -.20, .20) * amplitude + Math.sin(this.time * 1.35 + ear.side * .6) * .004;
            const targetRoll = clamp(-turn * .023 - bodyRoll * .025, -.13, .13) * amplitude + Math.sin(this.time * 1.05 + ear.side * .9) * .003;
            const phase = (this.time + (ear.side > 0 ? 1.1 : 4.5)) % 7.2;
            const relax = phase < 1.3 ? Math.sin(Math.PI * phase / 1.3) ** 2 * .16 : 0;
            const targetFold = clamp(.055 + relax + speed * .011 - acceleration * .007 - bodyPitch * .02, -.20, .36) * (low ? .12 : 1);
            for (let remaining = dt; remaining > 1e-8;) {
                const h = Math.min(remaining, 1 / 120), stiff = ear.side > 0 ? 62 : 51, damp = ear.side > 0 ? 9 : 8.1;
                ear.vp += (stiff * (targetPitch - ear.pitch) - damp * ear.vp) * h;
                ear.vr += (stiff * (targetRoll - ear.roll) - damp * ear.vr) * h;
                ear.pitch = clamp(ear.pitch + ear.vp * h, -.24, .24);
                ear.roll = clamp(ear.roll + ear.vr * h, -.16, .16);
                ear.vf += ((ear.side > 0 ? 43 : 36) * (targetFold - ear.fold) - (ear.side > 0 ? 7.3 : 6.5) * ear.vf) * h;
                ear.fold = clamp(ear.fold + ear.vf * h, -.30, .48);
                remaining -= h;
            }
            let floor = Infinity;
            if (low)
                for (const index of ear.samples)
                    floor = Math.min(floor, ear.mesh.getVertexPosition(index, this.point).y);
            const base = ear.bone.quaternion.clone(), tipBase = ear.tip?.quaternion.clone();
            let gain = low ? .3 : 1;
            for (let attempt = 0; attempt < 8; attempt++) {
                this.pitchRotation.setFromAxisAngle(this.axisX, ear.pitch * gain);
                this.rollRotation.setFromAxisAngle(this.axisZ, ear.roll * gain);
                ear.applied.copy(this.pitchRotation).multiply(this.rollRotation);
                ear.bone.quaternion.copy(base).multiply(ear.applied).normalize();
                if (ear.tip && tipBase) {
                    ear.tipApplied.copy(this.tipRotation.setFromAxisAngle(this.axisX, ear.fold * gain * .55));
                    ear.tip.quaternion.copy(tipBase).multiply(ear.tipApplied).normalize();
                }
                this.root.updateMatrixWorld(true);
                if (!low)
                    break;
                let min = Infinity;
                for (const index of ear.samples)
                    min = Math.min(min, ear.mesh.getVertexPosition(index, this.point).y);
                if (min >= Math.min(.001, floor) - .0001)
                    break;
                gain *= .4;
            }
        }
    }
}
