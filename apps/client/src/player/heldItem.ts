import * as THREE from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {PICKAXE, type HeldItemId} from "../craft/toolDefinitions.js";
import {INK_LAYER} from "../render/inkOutline.js";

let prototype: THREE.Group | null = null;
let pending: Promise<boolean> | null = null;
export function preloadHeldItems(): Promise<boolean> {
    pending ??= new GLTFLoader().loadAsync(PICKAXE.modelUrl + "?v=" + PICKAXE.version)
        .then(g => { prototype = g.scene; return true; }).catch(() => false);
    return pending;
}
export function heldItemPrototype(id: HeldItemId): THREE.Group | null {
    return id === PICKAXE.id ? prototype : null;
}

/** The short mitten is weighted to the upper arm. Place its socket in the
 * thumb/palm cleft in bind space, independently of the current animation. */
export function handGrip(meshes: readonly THREE.SkinnedMesh[]): {
    bone: THREE.Bone;
    point: THREE.Vector3;
    rotation: THREE.Quaternion;
    bindRotation: THREE.Quaternion;
    restRotation: THREE.Quaternion;
} | null {
    for (const mesh of meshes) {
        const hand = mesh.skeleton.bones.findIndex(b => b.name.replace(/[._]/g, "").toLowerCase() === "handr");
        if (hand < 0) continue;
        const positions = mesh.geometry.getAttribute("position");
        const indices = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight");
        if (!indices || !weights) continue;
        const palm = new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[hand]!.clone().invert());
        const point = new THREE.Vector3(), influence = new Map<number, number>();
        for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(mesh.bindMatrix);
            if (point.distanceToSquared(palm) > .12 * .12) continue;
            for (let k = 0; k < 4; k++) {
                const index = indices.getComponent(i, k), weight = weights.getComponent(i, k);
                if (weight > 0) influence.set(index, (influence.get(index) ?? 0) + weight);
            }
        }
        const controller = [...influence].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (controller === undefined) continue;
        const inverse = mesh.skeleton.boneInverses[controller]!;
        const bindRotation = new THREE.Quaternion().setFromRotationMatrix(inverse.clone().invert());
        const toolRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...PICKAXE.grip.rotation as [number, number, number]));
        const rotation = bindRotation.clone().invert().multiply(toolRotation);
        const socket = palm.add(new THREE.Vector3(...PICKAXE.grip.bindOffset as [number, number, number]));
        socket.add(new THREE.Vector3(0, PICKAXE.grip.handleSlide * PICKAXE.grip.scale, 0).applyQuaternion(toolRotation));
        const bone = mesh.skeleton.bones[controller]!;
        return {bone, point: socket.applyMatrix4(inverse), rotation, bindRotation, restRotation: bone.quaternion.clone()};
    }
    return null;
}

export interface HeldItemMotion {
    speed?: number;
    gaitPhase?: number;
    grounded?: boolean;
}

/** Shape-preserving cubic Hermite curves keep velocity continuous through
 * intermediate keys. Only actual reversals/rest endpoints stop the stroke.
 * Harmonic tangents prevent overshooting the approved shoulder angles. */
function strokeCurve(values: readonly number[]): (phase: number) => number {
    const keys = PICKAXE.swing.phases;
    const tangents = keys.map(() => 0);
    for (let i = 1; i < keys.length - 1; i++) {
        const before = keys[i]! - keys[i - 1]!, after = keys[i + 1]! - keys[i]!;
        const a = (values[i]! - values[i - 1]!) / before, b = (values[i + 1]! - values[i]!) / after;
        if (a * b > 0) {
            const wa = 2 * after + before, wb = after + 2 * before;
            tangents[i] = (wa + wb) / (wa / a + wb / b);
        }
    }
    return phase => {
        for (let i = 1; i < keys.length; i++) if (phase <= keys[i]!) {
            const h = keys[i]! - keys[i - 1]!, t = THREE.MathUtils.clamp((phase - keys[i - 1]!) / h, 0, 1);
            const t2 = t * t, t3 = t2 * t;
            return (2 * t3 - 3 * t2 + 1) * values[i - 1]! + (t3 - 2 * t2 + t) * h * tangents[i - 1]!
                + (-2 * t3 + 3 * t2) * values[i]! + (t3 - t2) * h * tangents[i]!;
        }
        return values[values.length - 1]!;
    };
}
const stroke = {
    pitch: strokeCurve(PICKAXE.swing.pitch), side: strokeCurve(PICKAXE.swing.side),
    lean: strokeCurve(PICKAXE.swing.lean), roll: strokeCurve(PICKAXE.swing.roll), twist: strokeCurve(PICKAXE.swing.twist),
};

export class HeldItemInstance {
    readonly root = new THREE.Group();
    private readonly materials = new Set<THREE.Material>();
    private readonly meshes: THREE.Mesh[] = [];
    private allowed = false;
    private releasing = false;
    private readonly applied = new THREE.Quaternion();
    private readonly forward = new THREE.Vector3();
    private readonly rotation = new THREE.Quaternion();
    private readonly target = new THREE.Quaternion();
    private readonly base = new THREE.Quaternion();
    private readonly referenceRotation = new THREE.Quaternion();
    private readonly torsoOffset = new THREE.Quaternion();
    private readonly leanAxis = new THREE.Vector3();
    private readonly twistAxis = new THREE.Vector3();
    private readonly torsoTwist = new THREE.Quaternion();
    private readonly torso: THREE.Bone | null;
    private readonly restRotation: THREE.Quaternion;
    private readonly stance = new THREE.Quaternion();
    private readonly offset = new THREE.Quaternion();
    private readonly angles = new THREE.Euler();
    private readonly previousOffset = new THREE.Quaternion();
    private holdAge = 0;
    private clock = 0;
    private speed = 0;
    private lastSpeed = 0;
    private lastYaw: number | null = null;
    private turnLag = 0;
    private accelerationLag = 0;
    private lean = 0;
    private twist = 0;
    private swingStrength = 0;
    private opacity = 1;
    private equipOpacity = 0;
    private disposed = false;

    constructor(asset: THREE.Group, grip: NonNullable<ReturnType<typeof handGrip>>, option: string,
        private readonly reference?: THREE.Object3D) {
        this.restRotation = grip.restRotation.clone();
        this.torso = grip.bone.parent instanceof THREE.Bone && grip.bone.parent.name.toLowerCase() === "torso" ? grip.bone.parent : null;
        this.root.name = "HeldItem/" + PICKAXE.id;
        this.root.userData.item = PICKAXE.id;
        this.setOption(option);
        const model = asset.clone(true);
        model.updateMatrixWorld(true);
        const node = model.getObjectByName(PICKAXE.grip.node);
        if (!node) throw new Error("Missing item grip anchor");
        const inverse = new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(node.matrixWorld).invert();
        model.applyMatrix4(inverse);
        model.traverse(o => {
            if (!(o instanceof THREE.Mesh)) return;
            const source: THREE.Material[] = Array.isArray(o.material) ? o.material as THREE.Material[] : [o.material as THREE.Material];
            const copies = source.map(m => {
                const copy = m.clone();
                copy.transparent = true;
                copy.forceSinglePass = true;
                copy.opacity = 0;
                this.materials.add(copy);
                return copy;
            });
            o.material = copies.length === 1 ? copies[0]! : copies;
            o.userData.heldItem = true;
            this.meshes.push(o as THREE.Mesh);
            o.castShadow = false;
            o.receiveShadow = true;
            o.layers.disable(INK_LAYER);
        });
        this.root.add(model);
        this.root.position.copy(grip.point);
        this.root.quaternion.copy(grip.rotation);
        this.root.scale.setScalar(PICKAXE.grip.scale);
        grip.bone.add(this.root);
        this.applyOpacity();
    }

    setOption(option: string): void { this.root.userData.option = option; }
    get released(): boolean { return this.releasing && this.holdAge <= 1e-8; }
    release(): void { this.releasing = true; this.applyOpacity(); }
    resume(): void { this.releasing = false; this.applyOpacity(); }

    /** Remove only our previous offset before the animation mixer evaluates. */
    removePose(): void {
        const bone = this.root.parent;
        if (bone) bone.quaternion.multiply(this.applied.invert());
        this.applied.identity();
        this.torso?.quaternion.multiply(this.torsoOffset.invert());
        this.torsoOffset.identity();
    }

    updatePose(dt: number, phase: number | null, allowed: boolean, motion: HeldItemMotion = {}): void {
        if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
        dt = Math.min(dt, .25);
        if (this.releasing) phase = null;
        const tune = PICKAXE.grip.motion;
        this.clock += dt;
        const rawSpeed = Number.isFinite(motion.speed) ? Math.max(0, motion.speed!) : 0;
        this.speed = THREE.MathUtils.damp(this.speed, rawSpeed, tune.response, dt);
        const acceleration = THREE.MathUtils.clamp((rawSpeed - this.lastSpeed) / dt, -8, 8);
        this.lastSpeed = rawSpeed;
        this.accelerationLag = THREE.MathUtils.damp(this.accelerationLag,
            THREE.MathUtils.clamp(acceleration * tune.accelerationLag, -tune.maxAccelerationLag, tune.maxAccelerationLag), 10, dt);
        if (this.reference) {
            this.reference.getWorldDirection(this.forward);
            const yaw = Math.atan2(this.forward.x, this.forward.z);
            const delta = this.lastYaw === null ? 0 : Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw));
            this.lastYaw = yaw;
            // Teleports and hard facing resets must never wind up a spring.
            const rate = Math.abs(delta) > .6 ? 0 : delta / dt;
            this.turnLag = THREE.MathUtils.damp(this.turnLag,
                THREE.MathUtils.clamp(-rate * tune.turnLag, -tune.maxTurnLag, tune.maxTurnLag), 10, dt);
        }
        this.allowed = allowed;
        if (!allowed) {
            this.holdAge = this.swingStrength = this.equipOpacity = this.turnLag = this.accelerationLag = this.lean = this.twist = 0;
            this.previousOffset.identity();
            this.applyOpacity();
            return;
        }
        const bone = this.root.parent;
        if (!bone?.parent) return;
        this.holdAge = THREE.MathUtils.clamp(this.holdAge + (this.releasing
            ? -dt * PICKAXE.grip.equipSeconds / PICKAXE.grip.unequipSeconds : dt), 0, PICKAXE.grip.equipSeconds);
        const progress = Math.min(1, this.holdAge / PICKAXE.grip.equipSeconds);
        const holdWeight = THREE.MathUtils.smoothstep(progress, 0, 1);
        // Reveal the tool as the hand lifts into its grasp, rather than popping
        // it fully opaque on the first frame of the resting arm.
        this.equipOpacity = THREE.MathUtils.smoothstep(progress, .2, .75);
        this.applyOpacity();

        this.base.copy(bone.quaternion);
        this.swingStrength = THREE.MathUtils.damp(this.swingStrength, phase === null ? 0 : 1, 22, dt);
        const grounded = motion.grounded !== false;
        const sourceWeight = THREE.MathUtils.lerp(grounded ? tune.sourceArmWeight : tune.airArmWeight, tune.attackArmWeight, this.swingStrength);
        // The stored pose comes from this rig's approved Idle, including its
        // natural roll. Dampen empty-hand Run swing before adding item motion.
        this.stance.slerpQuaternions(this.restRotation, this.base, sourceWeight);
        const [x, y, z] = PICKAXE.grip.liftRotation as [number, number, number];
        const settle = Math.sin(Math.PI * progress) * .025;
        const gait = Number.isFinite(motion.gaitPhase) ? motion.gaitPhase! * Math.PI * 2 : this.clock * 10;
        const run = THREE.MathUtils.smoothstep(this.speed, 2.9, 4.4), movement = THREE.MathUtils.smoothstep(this.speed, .08, 2.2);
        const swayWeight = THREE.MathUtils.lerp(1, tune.attackSwayWeight, this.swingStrength) * (grounded ? 1 : .35);
        const sway = (axis: number): number => THREE.MathUtils.lerp(tune.walkSway[axis]!, tune.runSway[axis]!, run) * movement * swayWeight;
        const pitchSway = Math.sin(gait) * sway(0) + Math.sin(this.clock * 1.8) * tune.idleSway[0]! * (1 - movement);
        const yawSway = Math.sin(gait - .45) * sway(1) + this.turnLag * swayWeight
            + Math.sin(this.clock * 1.8 + .3) * tune.idleSway[1]! * (1 - movement);
        const rollSway = Math.sin(gait + .4) * sway(2) + Math.sin(this.clock * 1.8 + .6) * tune.idleSway[2]! * (1 - movement);
        const time = phase === null ? 0 : ((phase % 1) + 1) % 1;
        this.angles.set(pitchSway + this.accelerationLag * swayWeight + stroke.pitch(time) * this.swingStrength,
            yawSway + stroke.side(time) * this.swingStrength, rollSway + stroke.roll(time) * this.swingStrength);
        this.offset.setFromEuler(this.angles);
        // Continuous moving strokes use exact metadata time (including impact).
        // On release only, decay the last offset instead of snapping to zero.
        if (phase === null && this.swingStrength > .001) this.offset.copy(this.previousOffset).slerp(this.offset, 1 - Math.exp(-16 * dt));
        this.previousOffset.copy(this.offset);
        const targetLean = stroke.lean(time) * this.swingStrength * holdWeight;
        this.lean = phase === null ? THREE.MathUtils.damp(this.lean, 0, 16, dt) : targetLean;
        const targetTwist = stroke.twist(time) * this.swingStrength * holdWeight;
        this.twist = phase === null ? THREE.MathUtils.damp(this.twist, 0, 16, dt) : targetTwist;
        if (this.torso) {
            // Transfer a little upper-body weight forward while feet/root stay
            // planted. Rotate around character right, never the bone's rolled X.
            this.torso.getWorldQuaternion(this.rotation).invert();
            this.leanAxis.set(1, 0, 0);
            if (this.reference) this.leanAxis.applyQuaternion(this.reference.getWorldQuaternion(this.target));
            this.leanAxis.applyQuaternion(this.rotation).normalize();
            this.twistAxis.set(0, 1, 0);
            if (this.reference) this.twistAxis.applyQuaternion(this.target);
            this.twistAxis.applyQuaternion(this.rotation).normalize();
            const releaseWeight = this.releasing ? holdWeight : 1;
            this.torsoOffset.setFromAxisAngle(this.leanAxis, this.lean * releaseWeight)
                .multiply(this.torsoTwist.setFromAxisAngle(this.twistAxis, this.twist * releaseWeight));
            this.torso.quaternion.multiply(this.torsoOffset).normalize();
        }
        this.angles.set(x - settle, y, z);
        this.rotation.setFromEuler(this.angles).multiply(this.offset);
        // A small additive lift preserves the approved arm's natural roll.
        // Replacing its world orientation with the bind pose can twist the
        // whole mitten backwards merely to put the thumb on the other side.
        if (this.reference) {
            this.reference.getWorldQuaternion(this.referenceRotation);
            this.rotation.premultiply(this.referenceRotation).multiply(this.referenceRotation.invert());
        }
        bone.parent.getWorldQuaternion(this.target).multiply(this.stance).premultiply(this.rotation);
        bone.parent.getWorldQuaternion(this.rotation).invert();
        this.target.premultiply(this.rotation);
        bone.quaternion.slerp(this.target, holdWeight).normalize();

        this.applied.copy(this.base).invert().multiply(bone.quaternion).normalize();
    }

    private applyOpacity(): void {
        const opacity = this.opacity * this.equipOpacity, solid = opacity >= .999 && !this.releasing;
        this.root.visible = this.allowed && !this.releasing && opacity > .001;
        for (const material of this.materials) {
            material.opacity = opacity;
            // A transparent tool must not invisibly occlude the character.
            material.depthWrite = solid;
        }
        for (const mesh of this.meshes) {
            mesh.castShadow = solid;
            // The ink override ignores material alpha: enable it only once
            // the actual tool has finished appearing.
            if (solid) mesh.layers.enable(INK_LAYER);
            else mesh.layers.disable(INK_LAYER);
        }
    }
    setOpacity(opacity: number): void {
        this.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
        this.applyOpacity();
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.removePose();
        this.root.removeFromParent();
        for (const material of this.materials) material.dispose();
        this.materials.clear();
        this.meshes.length = 0;
    }
}
