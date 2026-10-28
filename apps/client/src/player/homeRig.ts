import * as THREE from "three";
import { emoteDef, type AnimState, type EmoteId } from "@robo/shared";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { HULL_LAYER, INK_LAYER } from "../render/inkOutline.js";
import { FaceCanvas, faceBitmap, type FaceSequences } from "./faceCanvas.js";
export type HomeVariant = "mascot" | "blue" | "purple" | "tt";
export type HomeAnim = AnimState | "carry" | "place" | "sit" | "wave" | "lie" | "crawl";
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
        const response = await fetch("/models/characters/face-animations.json");
        if (!response.ok)
            throw new Error("Missing character face manifest");
        const faces = await response.json() as FaceSequences;
        const results = await Promise.allSettled((["HOME", "TT"] as const).map(async (character) => {
            const [gltf] = await Promise.all([new GLTFLoader().loadAsync(`/models/characters/${character}/${character}.glb`), faceBitmap(character, "textures/face-neutral.png")]);
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
    side: THREE.BackSide,
    uniforms: { width: { value: 0.014 }, opacity: { value: 1 } },
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
export class HomeRig {
    readonly root = new THREE.Group();
    private readonly toy = new THREE.Group();
    private readonly model: THREE.Object3D;
    private readonly mixer: THREE.AnimationMixer;
    private readonly actions = new Map<string, THREE.AnimationAction>();
    private readonly solids: THREE.SkinnedMesh[] = [];
    private readonly ownedMaterials = new Set<THREE.Material>();
    private readonly hulls: THREE.SkinnedMesh[] = [];
    private readonly face: FaceCanvas;
    private current: THREE.AnimationAction | undefined;
    private previous: HomeAnim = "idle";
    private lastY: number | null = null;
    private readonly worldPosition = new THREE.Vector3();
    private transition: {
        name: string;
        left: number;
    } | null = null;
    private landTime = 0;
    private idleTime = 5 + Math.random() * 4;
    private idleMotion = "Idle";
    private idleIndex = 0;
    private emote: EmoteId = "none";
    private emoteSeq = -1;
    private emoteTime = 0;
    private facePriority = "normal";
    private squash = 0;
    private squashVelocity = 0;
    private disposed = false;
    constructor(source: HomeAssets, variant: HomeVariant) {
        this.root.name = source.character;
        this.root.userData.characterModel = source.character + "-v1.1";
        this.model = clone(source.scene);
        this.root.add(this.toy);
        this.toy.add(this.model);
        this.model.traverse(node => { if (node instanceof THREE.SkinnedMesh)
            this.solids.push(node as THREE.SkinnedMesh); });
        this.face = new FaceCanvas(source.character, source.faces, variant === "blue" ? "hue-rotate(150deg)" : variant === "purple" ? "hue-rotate(220deg)" : "none");
        for (const mesh of this.solids) {
            const original = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
            const material = original.clone();
            material.map = this.face.texture;
            material.roughness = .9;
            material.metalness = 0;
            mesh.material = material;
            this.ownedMaterials.add(material);
            mesh.layers.enable(INK_LAYER);
            mesh.castShadow = true;
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
        }
        this.mixer = new THREE.AnimationMixer(this.model);
        const once = new Set(["Wave", "Land", "Place", "Cheer", "Interact", "Hit", "Dead", "LieDown", "StandUp", "CrawlEnter", "CrawlExit"]);
        for (const clip of source.animations) {
            const name = clip.name.replace(/^(HOME|TT)_/, "");
            const action = this.mixer.clipAction(clip);
            if (once.has(name)) {
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;
            }
            this.actions.set(name, action);
        }
        this.play("Idle", 0);
        if (this.current)
            this.current.time = Math.random() * this.current.getClip().duration;
        this.mixer.update(0);
        disposers.set(this.root, () => this.dispose());
    }
    pop(impulse: number): void { if (Number.isFinite(impulse))
        this.squashVelocity += impulse; }
    setEmote(id: EmoteId, seq: number): void {
        if (this.emote === id && this.emoteSeq === seq)
            return;
        this.emote = id;
        this.emoteSeq = seq;
        const def = emoteDef(id);
        this.emoteTime = def?.posture && def.posture !== "stand" ? Infinity : def?.seconds ?? 0;
        this.facePriority = "normal";
        if (def?.faceClip)
            this.face.play(def.faceClip, def.faceClip === "sleepy" ? "sleep" : "neutral");
        else
            this.face.set(def?.face ?? "neutral");
        if (def?.clip && this.current?.getClip().name === def.clip)
            this.play(def.clip, .12, true);
        this.root.userData.emote = id;
        this.root.userData.emoteSeq = seq;
    }
    private play(name: string, fade = .16, restart = false): void {
        const next = this.actions.get(name) ?? this.actions.get("Idle");
        if (!next || (!restart && next === this.current))
            return;
        const old = this.current;
        const gait = ["Walk", "Run", "Carry", "Crawl"];
        const phase = old && gait.includes(old.getClip().name) && gait.includes(name) ? old.time / old.getClip().duration : 0;
        old?.fadeOut(fade);
        next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
        next.time = phase * next.getClip().duration;
        if (old && fade > 0)
            next.fadeIn(fade);
        this.current = next;
        this.root.userData.homeMotion = name;
    }
    update(anim: HomeAnim, planarSpeed: number, dt: number): void {
        if (this.disposed || !Number.isFinite(dt) || dt <= 0)
            return;
        dt = Math.min(dt, .05);
        const speed = Number.isFinite(planarSpeed) ? Math.max(0, planarSpeed) : 0;
        const air = anim === "jump" || anim === "fall", wasAir = this.previous === "jump" || this.previous === "fall";
        const low = (a: HomeAnim) => a === "lie" || a === "crawl";
        if (anim !== this.previous) {
            this.transition = null;
            if (anim === "lie" && !low(this.previous))
                this.transition = { name: "LieDown", left: .9 };
            else if (anim === "crawl" && !low(this.previous))
                this.transition = { name: "CrawlEnter", left: .65 };
            else if (!low(anim) && !air && anim !== "dead" && low(this.previous))
                this.transition = { name: this.previous === "lie" ? "StandUp" : "CrawlExit", left: this.previous === "lie" ? .8 : .65 };
        }
        if (wasAir && !air && anim !== "dead" && !low(anim) && anim !== "sit") {
            this.landTime = .22;
            this.pop(-2.2);
        }
        this.landTime = Math.max(0, this.landTime - dt);
        this.emoteTime = Math.max(0, this.emoteTime - dt);
        const y = this.root.getWorldPosition(this.worldPosition).y;
        const descending = anim === "fall" || (this.lastY !== null && air && y < this.lastY - .001);
        let motion = "Idle";
        if (anim === "dead")
            motion = "Dead";
        else if (this.transition && this.transition.left > 0) {
            motion = this.transition.name;
            this.transition.left -= dt;
        }
        else if (anim === "lie")
            motion = "Lie";
        else if (anim === "crawl")
            motion = speed > .10 ? "Crawl" : "CrawlIdle";
        else if (anim === "sit")
            motion = "Sit";
        else if (anim === "place")
            motion = "Place";
        else if (anim === "carry")
            motion = speed > .15 ? "Carry" : "Hold";
        else if (anim === "wave")
            motion = "Wave";
        else if (air)
            motion = descending ? "Fall" : "Jump";
        else if (this.landTime > 0)
            motion = "Land";
        else if (anim === "run" && speed > .15)
            motion = speed < 2.4 ? "Walk" : "Run";
        else if (this.emoteTime > 0 && emoteDef(this.emote)?.clip)
            motion = emoteDef(this.emote)!.clip!;
        else {
            this.idleTime -= dt;
            if (this.idleTime <= 0) {
                if (this.idleMotion === "Idle") {
                    this.idleMotion = this.idleIndex++ % 2 ? "IdleShift" : "IdleLook";
                    this.idleTime = this.actions.get(this.idleMotion)?.getClip().duration ?? 3.6;
                }
                else {
                    this.idleMotion = "Idle";
                    this.idleTime = 5 + Math.random() * 4;
                }
            }
            motion = this.idleMotion;
        }
        if (!motion.startsWith("Idle")) {
            this.idleMotion = "Idle";
            this.idleTime = 4.5;
        }
        this.play(motion, motion.startsWith("Idle") ? .28 : motion === "Land" ? .08 : low(anim) || low(this.previous) ? .22 : .16);
        let rate = 1;
        if (motion === "Walk")
            rate = THREE.MathUtils.clamp(speed / 1.6, .65, 1.45);
        else if (motion === "Run")
            rate = THREE.MathUtils.clamp(speed / 4.6 * 1.15, .8, 1.8);
        else if (motion === "Crawl")
            rate = THREE.MathUtils.clamp(speed / 1.25, .55, 1.5);
        else if (motion === "Carry")
            rate = THREE.MathUtils.clamp(speed / 2, .65, 1.6);
        this.current?.setEffectiveTimeScale(rate);
        this.mixer.update(dt);
        const priority = anim === "dead" ? "dead" : air ? "oh" : "normal";
        if (priority !== this.facePriority) {
            this.facePriority = priority;
            this.face.set(priority === "normal" ? (this.emoteTime > 0 ? emoteDef(this.emote)?.face ?? "neutral" : anim === "lie" ? "sleep" : "neutral") : priority);
        }
        this.face.update(dt);
        const h = Math.min(dt, 1 / 30);
        this.squashVelocity += (-190 * this.squash - 15 * this.squashVelocity) * h;
        this.squash = THREE.MathUtils.clamp(this.squash + this.squashVelocity * h, -.32, .4);
        const sy = low(anim) || anim === "dead" ? 1 : 1 + this.squash, sxz = 1 / Math.sqrt(sy);
        this.toy.scale.set(sxz, sy, sxz);
        this.previous = anim;
        this.lastY = y;
    }
    private dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
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


