import * as THREE from "three";
import { emoteDef, type AnimState, type EmoteId, type CharacterAction, type CharacterPosture } from "@robo/shared";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { HULL_LAYER, INK_SKINNED_LAYER } from "../render/inkOutline.js";
import { castsSkinnedShadow } from "../render/instancedDepth.js";
import { FaceCanvas, faceBitmap, type FaceSequences } from "./faceCanvas.js";
import { PostureMotion, gaitBlend, gaitCadence } from "./motionPolicy.js";
import { EarDynamics } from "./earDynamics.js";
import { bindArmAttachments, constrainArms, PoseBridge, type ArmAttachment } from "./attachmentConstraints.js";
import {handGrip,HeldItemInstance,heldItemPrototype,preloadHeldItems} from "./heldItem.js";
import {PICKAXE,pickaxeCycle,type HeldItemId} from "../craft/toolDefinitions.js";
export type HomeVariant = "mascot" | "blue" | "purple" | "tt";
export type HomeAnim = AnimState | "carry" | "place" | "sit" | "wave" | "lie" | "crawl";
export interface MotionContext {
    swimming?: boolean;
}
export interface HomeAssets {
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
    character: "HOME" | "TT";
    faces: FaceSequences;
}
const assets = new Map<"HOME" | "TT", HomeAssets>();
let pending: Promise<boolean> | null = null;
const disposers = new WeakMap<THREE.Object3D, () => void>();
export function preloadHomeCharacter(): Promise<boolean> {
    pending ??= (async () => {
        const response = await fetch("/models/characters/face-animations.json?v=1.2.1-fold");
        if (!response.ok)
            throw new Error("Missing character face manifest");
        const faces = await response.json() as FaceSequences;
        const results = await Promise.allSettled((["HOME", "TT"] as const).map(async (character) => {
            const [gltf] = await Promise.all([new GLTFLoader().loadAsync(`/models/characters/${character}/${character}.glb?v=1.2.1-fold`), faceBitmap(character, "textures/face-neutral.png").catch(() => null)]);
            assets.set(character, { scene: gltf.scene, animations: gltf.animations, character, faces });
        }));
        if (results.every(r => r.status === "rejected"))
            throw new Error("Character models unavailable");
        return true;
    })().catch((error: unknown) => { console.warn("Character assets unavailable; using the built-in mascot.", error); return false; });
    return pending;
}
export function createHomeRig(variant: HomeVariant): HomeRig | null { const source = assets.get(variant === "tt" ? "TT" : "HOME"); return source ? new HomeRig(source, variant) : null; }
export function disposeHomeRig(root: THREE.Object3D): void { disposers.get(root)?.(); }
const hullMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, uniforms: { width: { value: .014 }, opacity: { value: 1 } },
    vertexShader: `
#include <common>
#include <skinning_pars_vertex>
uniform float width;
void main() {
#include <beginnormal_vertex>
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
transformed += normalize(objectNormal) * width;
gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}`,
    fragmentShader: "uniform float opacity; void main(){gl_FragColor=vec4(0.09,0.09,0.12,opacity);}",
});
const loops = new Set(["Idle", "IdleShift", "IdleLook", "Walk", "Run", "Jump", "Fall", "Carry", "Hold", "Sit", "Lie", "CrawlIdle", "Crawl", "Swim", "SwimIdle", "Sleep"]);
const smooth = (v: number): number => { const t = THREE.MathUtils.clamp(v, 0, 1); return t * t * (3 - 2 * t); };
interface Blend {
    from: Map<string, number>;
    time: number;
    seconds: number;
}
/** Feet stay in the caller's coordinate system. Clip clocks are explicit so low FPS,
 * mirrored posture changes and upper-body layers share a single time source. */
export class HomeRig {
    readonly root = new THREE.Group();
    readonly seatContactHeight = .127415;
    private readonly toy = new THREE.Group();
    private readonly model: THREE.Object3D;
    private readonly mixer: THREE.AnimationMixer;
    private readonly actions = new Map<string, THREE.AnimationAction>();
    private readonly active = new Set<string>();
    private readonly targets = new Map<string, number>();
    private readonly solids: THREE.SkinnedMesh[] = [];
    private readonly ownedMaterials = new Set<THREE.Material>();
    private readonly hulls: THREE.SkinnedMesh[] = [];
    private readonly soleSamples = new Map<THREE.SkinnedMesh, number[]>();
    private readonly face: FaceCanvas;
    private readonly posture = new PostureMotion();
    private readonly attachments: ArmAttachment[];
    private readonly poseBridge: PoseBridge;
    private readonly ears: EarDynamics;
    private postureKey = "pose/stand";
    private floorLift = 0;
    private group = "";
    private blend: Blend | null = null;
    private previous: HomeAnim = "idle";
    private lastY: number | null = null;
    private readonly position = new THREE.Vector3();
    private readonly sample = new THREE.Vector3();
    private phase = Math.random();
    private landTime = 0;
    private takeoff = 0;
    private idleTime = 5 + Math.random() * 4;
    private idleMotion = "Idle";
    private idleIndex = 0;
    private emote: EmoteId = "none";
    private emoteSeq = -1;
    private emoteAge = 0;
    private facePriority = "";
    private work: CharacterAction = "none";
    private workSeq = -1;
    private workAge = 0;
    private workLoop = false;
    private overlay = "";
    private squash = 0;
    private squashVelocity = 0;
    private disposed = false;
    private itemId:HeldItemId|null=null;
    private itemOption=PICKAXE.defaultOption;
    private heldItem:HeldItemInstance|null=null;
    get postureBusy(): boolean { return this.posture.transition !== null || this.poseBridge.active; }
    constructor(source: HomeAssets, variant: HomeVariant) {
        this.root.name = source.character;
        this.root.userData.characterModel = source.character + "-v1.2.1";
        this.model = clone(source.scene);
        this.root.add(this.toy);
        this.toy.add(this.model);
        this.model.traverse(node => {
            if (node instanceof THREE.SkinnedMesh)
                this.solids.push(node as THREE.SkinnedMesh);
        });
        this.face = new FaceCanvas(source.character, source.faces, variant === "blue" ? "hue-rotate(150deg)" : variant === "purple" ? "hue-rotate(220deg)" : "none");
        for (const mesh of this.solids) {
            const original = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
            const material = original.clone();
            material.map = this.face.texture;
            material.roughness = .9;
            material.metalness = 0;
            // A little self-light from its own paint: a toy mascot must read in its
            // true colour on the shaded side too, not as a darker olive figure.
            material.emissiveMap = this.face.texture;
            material.emissive.set(0xffffff);
            material.emissiveIntensity = .18;
            mesh.material = material;
            this.ownedMaterials.add(material);
            mesh.layers.enable(INK_SKINNED_LAYER);
            castsSkinnedShadow(mesh);
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            const hull = new THREE.SkinnedMesh(mesh.geometry, hullMaterial);
            hull.name = "Character XR outline";
            hull.layers.set(HULL_LAYER);
            hull.frustumCulled = false;
            hull.bindMode = mesh.bindMode;
            hull.bind(mesh.skeleton, mesh.bindMatrix);
            hull.bindMatrixInverse.copy(mesh.bindMatrixInverse);
            hull.onBeforeRender = () => { hull.material.uniforms.opacity!.value = hull.material.opacity; };
            mesh.add(hull);
            this.hulls.push(hull);
            // A few rest-space sole points on both shoes; no per-frame whole-mesh scan.
            const p = mesh.geometry.getAttribute("position"), indices: number[] = [];
            for (let i = 0; i < p.count; i++)
                if (p.getY(i) < .012)
                    indices.push(i);
            this.soleSamples.set(mesh, indices.filter((_, i) => i % Math.max(1, Math.floor(indices.length / 16)) === 0));
        }
        this.mixer = new THREE.AnimationMixer(this.model);
        const clips = new Map(source.animations.map(clip => [clip.name.replace(/^(HOME|TT)_/, ""), clip]));
        for (const [name, clip] of clips) {
            const action = this.mixer.clipAction(clip);
            action.setLoop(loops.has(name) ? THREE.LoopRepeat : THREE.LoopOnce, loops.has(name) ? Infinity : 1);
            action.clampWhenFinished = true;
            action.paused = true;
            this.actions.set(name, action);
        }
        for (const name of ["Wave", "Cheer", "Interact", "Place", "Hit", "CrawlReach"]) {
            const sourceClip = clips.get(name), ref = clips.get(name === "CrawlReach" ? "CrawlIdle" : "Idle");
            if (!sourceClip || !ref)
                continue;
            const clip = sourceClip.clone();
            clip.name = "Upper/" + name;
            clip.tracks = clip.tracks.filter(track => /^(torso|upper_arm|forearm|hand)/.test(THREE.PropertyBinding.parseTrackName(track.name).nodeName ?? ""));
            if (!clip.tracks.length)
                continue;
            THREE.AnimationUtils.makeClipAdditive(clip, 0, ref);
            const action = this.mixer.clipAction(clip);
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
            action.paused = true;
            this.actions.set(clip.name, action);
        }
        this.select([["Idle", 1]], "Idle", 0);
        this.actions.get("Idle")!.time = this.phase * this.actions.get("Idle")!.getClip().duration;
        this.applyBlend(0);
        this.mixer.update(0);
        this.model.updateMatrixWorld(true);
        this.attachments = bindArmAttachments(this.solids);
        this.poseBridge = new PoseBridge([...new Set(this.solids.flatMap(m => m.skeleton.bones))]);
        this.ears = new EarDynamics(this.root, this.solids);
        disposers.set(this.root, () => this.dispose());
    }
    setHeldOpacity(opacity:number):void {this.heldItem?.setOpacity(opacity);}
    setHeldItem(id:HeldItemId|null,option=PICKAXE.defaultOption):void {
        if(this.disposed||this.itemId===id&&this.itemOption===option&&(!id||this.heldItem))return;
        this.heldItem?.dispose();this.heldItem=null;this.itemId=id;this.itemOption=option;
        if(!id)return;
        const source=heldItemPrototype(id),grip=handGrip(this.solids);
        if(source&&grip)this.heldItem=new HeldItemInstance(source,grip,option);
        else if(!source)void preloadHeldItems().then(ok=>{if(ok&&!this.disposed&&this.itemId===id)this.setHeldItem(id,this.itemOption);});
    }
    pop(impulse: number): void {
        if (Number.isFinite(impulse)) {
            this.squashVelocity += impulse;
            this.ears?.kick(impulse);
        }
    }
    setEmote(id: EmoteId, seq: number): void {
        if (this.emote === id && this.emoteSeq === seq)
            return;
        this.emote = id;
        this.emoteSeq = seq;
        this.emoteAge = 0;
        this.facePriority = "";
        const def = emoteDef(id);
        if (def?.faceClip)
            this.face.play(def.faceClip, def.faceClip === "sleepy" ? "sleep" : "neutral");
        else
            this.face.set(def?.face ?? "neutral");
        if (def?.clip) {
            const a = this.actions.get(def.clip);
            if (a) {
                a.time = 0;
            }
        }
        this.root.userData.emote = id;
        this.root.userData.emoteSeq = seq;
    }
    performAction(id: CharacterAction, seq: number, loop = false): void {
        if (this.work === id && this.workSeq === seq && this.workLoop === loop)
            return;
        this.work = id;
        this.workSeq = seq;
        this.workAge = 0;
        this.workLoop = loop;
    }
    private activate(name: string): THREE.AnimationAction | undefined {
        const a = this.actions.get(name);
        if (!a)
            return;
        if (!this.active.has(name)) {
            a.reset().play();
            a.paused = true;
            a.weight = 0;
            this.active.add(name);
        }
        return a;
    }
    private select(entries: [
        string,
        number
    ][], key: string, seconds = .16): void {
        this.targets.clear();
        for (const [name, w] of entries)
            if (this.activate(name))
                this.targets.set(name, w);
        if (key === this.group)
            return;
        const from = new Map<string, number>();
        for (const n of this.active)
            from.set(n, this.actions.get(n)!.weight);
        this.blend = { from, time: 0, seconds };
        this.group = key;
    }
    private applyBlend(dt: number): void {
        if (this.blend)
            this.blend.time += dt;
        const t = this.blend ? smooth(this.blend.seconds ? this.blend.time / this.blend.seconds : 1) : 1;
        for (const n of this.active) {
            if (n.startsWith("Upper/"))
                continue;
            const a = this.actions.get(n)!, target = this.targets.get(n) ?? 0;
            a.weight = (this.blend?.from.get(n) ?? target) * (1 - t) + target * t;
            if (t === 1 && target === 0) {
                a.stop();
                this.active.delete(n);
            }
        }
        if (t === 1)
            this.blend = null;
    }
    private setTime(name: string, time: number, loop = false): void {
        const a = this.actions.get(name);
        if (!a)
            return;
        const d = a.getClip().duration;
        a.time = loop ? ((time % d) + d) % d : Math.min(d, Math.max(0, time));
    }
    update(anim: HomeAnim, planarSpeed: number, dt: number, context: MotionContext = {}): void {
        if (this.disposed || !Number.isFinite(dt) || dt <= 0)
            return;
        dt = Math.min(dt, .25);
        this.ears.removeOffset();
        const speed = Number.isFinite(planarSpeed) ? Math.max(0, planarSpeed) : 0;
        const swimming = !!context.swimming, air = !swimming && (anim === "jump" || anim === "fall"), wasAir = this.previous === "jump" || this.previous === "fall";
        const wanted: CharacterPosture = anim === "sit" ? "sit" : anim === "lie" ? "lie" : anim === "crawl" ? "crawl" : "stand";
        const step = this.posture.update(wanted, dt);
        const postureKey = step ? `step/${step.serial}` : `pose/${this.posture.pose}`;
        const postureBoundary = postureKey !== this.postureKey;
        if (postureBoundary) {
            this.poseBridge.begin(step ? .12 : .16);
            this.postureKey = postureKey;
        }
        const y = this.root.getWorldPosition(this.position).y;
        const descending = anim === "fall" || (this.lastY !== null && air && y < this.lastY - .001);
        if (air && !wasAir) {
            this.ears.kick(2.1);
            this.takeoff = anim === "jump" ? .1667 : 0;
            this.landTime = 0;
        }
        if (wasAir && !air && !swimming && wanted === "stand" && anim !== "dead") {
            this.landTime = .25;
            this.pop(-1.6);
        }
        this.emoteAge += dt;
        this.workAge += dt;
        for (const name of this.active) {
            if (name.startsWith("Upper/"))
                continue;
            const a = this.actions.get(name)!;
            this.setTime(name, a.time + dt, loops.has(name));
        }
        const def = emoteDef(this.emote), emoting = !!def && (!!def.posture || this.emoteAge < def.seconds);
        const moving = anim === "run" && speed > .1;
        let motion = "Idle", key = "", entries: [
            string,
            number
        ][];
        if (anim === "dead")
            motion = "Dead";
        else if (step)
            motion = step.clip;
        else if (swimming)
            motion = speed > .12 ? "Swim" : "SwimIdle";
        else if (wanted === "lie")
            motion = "Lie";
        else if (wanted === "crawl")
            motion = speed > .1 ? "Crawl" : "CrawlIdle";
        else if (wanted === "sit")
            motion = "Sit";
        else if (air)
            motion = descending ? "Fall" : this.takeoff > 0 ? "Takeoff" : "Jump";
        else if (this.landTime > 0)
            motion = "Land";
        else if (anim === "carry")
            motion = speed > .1 ? "Carry" : "Hold";
        else if (anim === "place")
            motion = "Place";
        else if (anim === "wave")
            motion = "Wave";
        else if (moving)
            motion = "Locomotion";
        else if (emoting && def?.clip) {
            motion = def.clip;
            key = motion + ":" + this.emoteSeq;
        }
        else {
            this.idleTime -= dt;
            if (this.idleTime <= 0) {
                this.idleMotion = this.idleMotion === "Idle" ? (this.idleIndex++ % 2 ? "IdleShift" : "IdleLook") : "Idle";
                this.idleTime = this.idleMotion === "Idle" ? 5 + Math.random() * 4 : this.actions.get(this.idleMotion)?.getClip().duration ?? 3.6;
            }
            motion = this.idleMotion;
        }
        if (!motion.startsWith("Idle")) {
            this.idleMotion = "Idle";
            this.idleTime = 4.5;
        }
        if (motion === "Locomotion") {
            const b = gaitBlend(speed);
            this.phase = (this.phase + dt * gaitCadence(speed, b)) % 1;
            entries = [["Walk", 1 - b], ["Run", b]];
        }
        else
            entries = [[motion, 1]];
        if (motion === "Crawl" && this.group !== "Crawl")
            this.phase = 0;
        this.select(entries, key || (step ? `${motion}/${step.serial}` : motion), postureBoundary ? 0 : motion === "Land" ? .06 : motion.startsWith("Idle") ? .25 : .14);
        if (step)
            this.setTime(motion, step.elapsed / step.seconds * (this.actions.get(motion)?.getClip().duration ?? step.seconds));
        if (motion === "Locomotion") {
            for (const name of ["Walk", "Run"])
                this.setTime(name, this.phase * this.actions.get(name)!.getClip().duration);
        }
        else if (motion === "Carry" || motion === "Crawl") {
            const travel = motion === "Carry" ? .42 / .64 : .34 / .58;
            this.phase = (this.phase + dt * speed / travel) % 1;
            this.setTime(motion, this.phase * this.actions.get(motion)!.getClip().duration);
        }
        else if (emoting && motion === def?.clip)
            this.setTime(motion, this.emoteAge);
        this.applyBlend(dt);
        // Work has priority over gestures. Crawl uses a supporting reach instead of lifting both hands.
        let overlay = "", overlayAge = 0, overlayLoop = false;
        const workClip = this.work === "interact" ? "Interact" : this.work === "place" ? "Place" : this.work === "hit" ? "Hit" : "";
        if (!air && !swimming && !step && wanted !== "lie" && anim !== "dead") {
            if (workClip && (this.workLoop || this.workAge < (this.actions.get(workClip)?.getClip().duration ?? 0))) {
                overlay = wanted === "crawl" ? "CrawlReach" : workClip;
                overlayAge = this.workAge*(this.heldItem&&this.work==="interact"?(this.actions.get(workClip)?.getClip().duration??pickaxeCycle(this.itemOption))/pickaxeCycle(this.itemOption):1);
                overlayLoop = this.workLoop;
            }
            else if (emoting && def?.clip && (moving || wanted === "sit")) {
                overlay = def.clip;
                overlayAge = this.emoteAge;
            }
        }
        const target = overlay ? "Upper/" + overlay : "";
        if (target)
            this.activate(target);
        for (const name of [...this.active])
            if (name.startsWith("Upper/")) {
                const a = this.actions.get(name)!, goal = name === target ? 1 : 0;
                a.weight = THREE.MathUtils.damp(a.weight, goal, 24, dt);
                if (goal)
                    this.setTime(name, overlayAge, overlayLoop);
                if (!goal && a.weight < .002) {
                    a.stop();
                    this.active.delete(name);
                }
            }
        this.overlay = target;
        this.mixer.update(0);
        this.poseBridge.apply(dt);
        constrainArms(this.attachments);
        this.ears.update(dt, speed, air, wanted !== "stand" || !!step || anim === "dead");
        const priority = anim === "dead" ? "dead" : air ? "oh" : wanted === "lie" && !emoting ? "sleep" : "normal";
        if (priority !== this.facePriority) {
            const previous = this.facePriority;
            this.facePriority = priority;
            if (priority !== "normal")
                this.face.set(priority);
            else if (previous && previous !== "normal")
                this.face.set(emoting && !def?.faceClip ? def?.face ?? "neutral" : "neutral");
        }
        if (!emoting && this.emote !== "none") {
            this.emote = "none";
            this.face.set(wanted === "lie" ? "sleep" : "neutral");
        }
        if(this.heldItem)this.heldItem.root.visible=wanted==="stand"&&!swimming&&anim!=="dead"&&!step;
        this.face.update(dt);
        for (let remaining = dt; remaining > 1e-8;) {
            const h = Math.min(remaining, 1 / 120);
            this.squashVelocity += (-190 * this.squash - 15 * this.squashVelocity) * h;
            this.squash = THREE.MathUtils.clamp(this.squash + this.squashVelocity * h, -.24, .28);
            remaining -= h;
        }
        const sy = wanted !== "stand" || step || anim === "dead" || swimming ? 1 : 1 + this.squash;
        this.toy.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
        this.toy.position.y = 0;
        // Only lift actual sole penetration; do not pin airborne or intentionally raised feet.
        if (!air && !swimming && anim !== "dead") {
            this.root.updateMatrixWorld(true);
            let min = 0;
            for (const mesh of this.solids)
                for (const index of this.soleSamples.get(mesh) ?? []) {
                    mesh.getVertexPosition(index, this.sample);
                    min = Math.min(min, this.sample.y * sy);
                }
            this.floorLift = THREE.MathUtils.damp(this.floorLift, Math.min(.08, Math.max(0, -min)), 28, dt);
            this.toy.position.y = this.floorLift;
        }
        if (air || swimming || anim === "dead")
            this.floorLift = 0;
        this.root.userData.homeMotion = motion === "Locomotion" ? (gaitBlend(speed) < .5 ? "Walk" : "Run") : motion;
        this.root.userData.upperMotion = this.overlay;
        this.root.userData.postureBusy = this.postureBusy;
        this.landTime = Math.max(0, this.landTime - dt);
        this.takeoff = Math.max(0, this.takeoff - dt);
        this.previous = air ? descending ? "fall" : "jump" : anim;
        this.lastY = y;
    }
    private dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.heldItem?.dispose();this.heldItem=null;
        this.face.dispose();
        this.mixer.stopAllAction();
        this.mixer.uncacheRoot(this.model);
        for (const skeleton of new Set(this.solids.map(m => m.skeleton)))
            skeleton.dispose();
        for (const mesh of this.solids) {
            const mat = mesh.material as THREE.Material;
            if (!this.ownedMaterials.has(mat))
                mat.dispose();
        }
        for (const mat of this.ownedMaterials)
            mat.dispose();
        for (const hull of this.hulls)
            if (hull.material !== hullMaterial)
                (hull.material as THREE.Material).dispose();
        disposers.delete(this.root);
    }
}
