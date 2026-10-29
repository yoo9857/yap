import { beforeAll, describe, it, expect, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HomeRig, disposeHomeRig, type HomeAssets, type HomeAnim } from "../src/player/homeRig.js";
vi.mock("../src/player/faceCanvas.js", async () => {
    const T = await import("three");
    return { faceBitmap: vi.fn(), FaceCanvas: class {
            texture = new T.Texture();
            set() { }
            play() { }
            update() { }
            dispose() { this.texture.dispose(); }
        } };
});
const all = new Map<string, HomeAssets>();
async function load(character: "HOME" | "TT"): Promise<HomeAssets> {
    const file = new URL(`../public/models/characters/${character}/${character}.glb`, import.meta.url);
    const raw = await readFile(file);
    const array = new ArrayBuffer(raw.length);
    new Uint8Array(array).set(raw);
    const loader = new GLTFLoader();
    loader.register(() => ({ name: "NO_IMAGE_DECODE", loadTexture: () => Promise.resolve(new THREE.Texture()) }));
    const gltf = await loader.parseAsync(array, "");
    return { scene: gltf.scene, animations: gltf.animations, character, faces: { sequences: {} } };
}
beforeAll(async () => {
    for (const c of ["HOME", "TT"] as const)
        all.set(c, await load(c));
});
function solid(r: THREE.Object3D): THREE.SkinnedMesh {
    const result = r.getObjectsByProperty("type", "SkinnedMesh").find(m => m.name !== "Character XR outline");
    if (!(result instanceof THREE.SkinnedMesh))
        throw Error("Missing skin");
    return result as THREE.SkinnedMesh;
}
interface Cap {
    bone: THREE.Bone;
    point: THREE.Vector3;
    anchor: THREE.Vector3;
}
function caps(mesh: THREE.SkinnedMesh, metadata = mesh.userData): Cap[] {
    return ["L", "R"].map(side => {
        const raw: unknown = metadata["arm_cap_" + side];
        if (!Array.isArray(raw) || raw.length !== 3)
            throw Error("Missing cap metadata");
        const index = mesh.skeleton.bones.findIndex(b => b.name.replace(/[._]/g, "") === "upperarm" + side), bone = mesh.skeleton.bones[index]!;
        const point = new THREE.Vector3(...raw as [
            number,
            number,
            number
        ]).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[index]!);
        bone.updateMatrix();
        return { bone, point, anchor: point.clone().applyMatrix4(bone.matrix) };
    });
}
function drift(attachments: Cap[]): number {
    let max = 0;
    for (const cap of attachments) {
        cap.bone.updateMatrix();
        max = Math.max(max, cap.point.clone().applyMatrix4(cap.bone.matrix).distanceTo(cap.anchor));
    }
    return max;
}
function sampler(asset: HomeAssets) {
    const root = asset.scene, mixer = new THREE.AnimationMixer(root), mesh = solid(root);
    return { root, mesh, sample(name: string, time: number) { mixer.stopAllAction(); const clip = asset.animations.find(c => c.name === name)!; const action = mixer.clipAction(clip); action.reset().setLoop(THREE.LoopOnce, 1).play(); action.clampWhenFinished = true; action.time = time; mixer.update(0); root.updateMatrixWorld(true); } };
}
const report: Record<string, unknown> = {};
describe("actual arm attachment and transition continuity", () => {
    for (const c of ["HOME", "TT"] as const) {
        it(`${c}: keeps cap points attached through every exported clip`, () => {
            const a = all.get(c)!, s = sampler(a);
            s.sample("Idle", 0);
            const connections = caps(s.mesh);
            let max = 0;
            for (const clip of a.animations)
                for (let k = 0; k <= 40; k++) {
                    s.sample(clip.name, clip.duration * k / 40);
                    max = Math.max(max, drift(connections));
                }
            report[c] = { source_attachment_error_m: max };
            expect(max).toBeLessThan(.0015);
        });
        it(`${c}: matches all posture bridge endpoints to their destination loop`, () => {
            const a = all.get(c)!, s = sampler(a), p = new THREE.Vector3();
            const edges: Record<string, [
                string,
                string
            ]> = { LieToCrawl: ["Lie", "CrawlIdle"], CrawlToLie: ["CrawlIdle", "Lie"], LieDown: ["Idle", "Lie"], StandUp: ["Lie", "Idle"], CrawlEnter: ["Idle", "CrawlIdle"], CrawlExit: ["CrawlIdle", "Idle"], SitDown: ["Idle", "Sit"], SitToStand: ["Sit", "Idle"], SitToLie: ["Sit", "Lie"], LieToSit: ["Lie", "Sit"], SitToCrawl: ["Sit", "CrawlIdle"], CrawlToSit: ["CrawlIdle", "Sit"] };
            let worst = 0;
            for (const [bridge, ends] of Object.entries(edges))
                for (const end of [0, 1]) {
                    s.sample(ends[end]!, 0);
                    const expected = Array.from({ length: s.mesh.geometry.getAttribute("position").count }, (_, i) => s.mesh.getVertexPosition(i, new THREE.Vector3()).clone());
                    s.sample(bridge, end * a.animations.find(k => k.name === bridge)!.duration);
                    for (let i = 0; i < expected.length; i++)
                        worst = Math.max(worst, s.mesh.getVertexPosition(i, p).distanceTo(expected[i]!));
                }
            report[c] = { ...(report[c] as object), endpoint_error_m: worst };
            expect(worst).toBeLessThan(.0002);
        });
        it(`${c}: has no instantaneous hand jump when reversing a roll`, () => {
            const r = new HomeRig(all.get(c)!, c === "HOME" ? "mascot" : "tt"), mesh = solid(r.root);
            const connections = caps(mesh);
            for (let i = 0; i < 100; i++)
                r.update("lie", 0, 1 / 60);
            for (let i = 0; i < 35; i++)
                r.update("crawl", 0, 1 / 60);
            r.root.updateMatrixWorld(true);
            const before = connections.map(k => k.bone.localToWorld(k.point.clone()));
            r.update("lie", 0, .00001);
            r.root.updateMatrixWorld(true);
            const movement = Math.max(...connections.map((k, i) => k.bone.localToWorld(k.point.clone()).distanceTo(before[i]!)));
            expect(movement).toBeLessThan(.001);
            expect(drift(connections)).toBeLessThan(.00001);
            for (let i = 0; i < 100; i++) {
                r.update(i < 30 ? "crawl" : "lie", 0, 1 / 60);
                expect(drift(connections)).toBeLessThan(.00001);
            }
            report[c] = { ...(report[c] as object), reversal_step_m: movement };
            disposeHomeRig(r.root);
        });
    }
    it("records the rendered skin positions through a full roll for visual QA", async () => {
        const data: Record<string, unknown> = {};
        for (const c of ["HOME", "TT"] as const) {
            const r = new HomeRig(all.get(c)!, c === "HOME" ? "mascot" : "tt"), mesh = solid(r.root), connections = caps(mesh), point = new THREE.Vector3();
            for (let i = 0; i < 100; i++)
                r.update("lie", 0, 1 / 60);
            const frames: number[][] = [];
            let worst = 0;
            for (let frame = 0; frame < 240; frame++) {
                const anim: HomeAnim = frame < 120 ? "crawl" : "lie";
                r.update(anim, 0, 1 / 60);
                r.root.updateMatrixWorld(true);
                worst = Math.max(worst, drift(connections));
                const coords: number[] = [];
                for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
                    mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
                    coords.push(point.x, point.y, point.z);
                }
                if (frame % 3 === 0)
                    frames.push(coords);
            }
            expect(worst).toBeLessThan(.00001);
            const rest = Array.from(mesh.geometry.getAttribute("position").array);
            let earFrames: number[][] | undefined;
            if (c === "TT") {
                earFrames = [];
                const e = new HomeRig(all.get(c)!, "tt"), em = solid(e.root);
                for (let k = 0; k < 240; k++) {
                    const run = k >= 40 && k < 100 || k >= 160 && k < 210;
                    if (k >= 160 && k < 210)
                        e.root.rotation.y += (1 / 60) * 1.1;
                    e.update(run ? "run" : "idle", run ? 4.6 : 0, 1 / 60);
                    e.root.updateMatrixWorld(true);
                    if (k % 3 === 0) {
                        const positions: number[] = [];
                        for (let i = 0; i < em.geometry.getAttribute("position").count; i++) {
                            em.getVertexPosition(i, point).applyMatrix4(em.matrixWorld);
                            positions.push(point.x, point.y, point.z);
                        }
                        earFrames.push(positions);
                    }
                }
                disposeHomeRig(e.root);
            }
            data[c] = { rest, frames, fps: 20, earFrames };
            disposeHomeRig(r.root);
        }
        const output = process.env.CRAFTYAP_MOTION_QA;
        if (output) {
            await writeFile(join(output, "runtime-poses.json"), JSON.stringify(data));
            await writeFile(join(output, "validation-attachments.json"), JSON.stringify(report, null, 2));
        }
    });
});
describe("TT ear inertia", () => {
    function pair() { const random = vi.spyOn(Math, "random").mockReturnValue(.25); const a = new HomeRig(all.get("TT")!, "tt"), b = new HomeRig(all.get("TT")!, "tt"); random.mockRestore(); return [a, b] as const; }
    function ear(r: HomeRig, side = "L") { return solid(r.root).skeleton.bones.find(b => b.name.replace(/[._]/g, "") === "ear" + side)!; }
    const angle = (a: THREE.Quaternion, b: THREE.Quaternion) => a.clone().normalize().angleTo(b.clone().normalize());
    it("lags on acceleration and settles after stopping, with slightly different ears", () => {
        const [a, b] = pair();
        for (let i = 0; i < 40; i++) {
            a.update("idle", 0, 1 / 60);
            b.update("idle", 0, 1 / 60);
        }
        for (let i = 0; i < 18; i++) {
            a.update("idle", 4.6, 1 / 60);
            b.update("idle", 0, 1 / 60);
        }
        const left = angle(ear(a).quaternion, ear(b).quaternion), right = angle(ear(a, "R").quaternion, ear(b, "R").quaternion);
        expect(left).toBeGreaterThan(.04);
        expect(Math.abs(left - right)).toBeGreaterThan(.001);
        expect(Math.max(left, right)).toBeLessThan(.32);
        const last = ear(a).quaternion.clone();
        a.update("idle", 0, 1 / 60);
        b.update("idle", 0, 1 / 60);
        expect(angle(last, ear(a).quaternion)).toBeLessThan(.04);
        for (let i = 0; i < 170; i++) {
            a.update("idle", 0, 1 / 60);
            b.update("idle", 0, 1 / 60);
        }
        expect(angle(ear(a).quaternion, ear(b).quaternion)).toBeLessThan(.015);
        disposeHomeRig(a.root);
        disposeHomeRig(b.root);
    });
    it("responds to jump/landing impulses without invalid rotations or floor penetration when lying", () => {
        const [a, b] = pair();
        a.pop(3);
        a.pop(Number.NaN);
        for (let i = 0; i < 15; i++) {
            a.update("idle", 0, 1 / 60);
            b.update("idle", 0, 1 / 60);
        }
        expect(angle(ear(a).quaternion, ear(b).quaternion)).toBeGreaterThan(.01);
        const mesh = solid(a.root), point = new THREE.Vector3();
        let min = 0;
        for (let k = 0; k < 150; k++) {
            a.update(k < 100 ? "lie" : "crawl", 0, 1 / 60);
            a.root.updateMatrixWorld(true);
            for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
                mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
                min = Math.min(min, point.y);
            }
            expect(ear(a).quaternion.toArray().every(Number.isFinite)).toBe(true);
        }
        expect(min).toBeGreaterThan(-.006);
        disposeHomeRig(a.root);
        disposeHomeRig(b.root);
    });
});
it("TT has a flexible tip on each ear, folds under an impulse and keeps its joint fixed", () => {
    const r = new HomeRig(all.get("TT")!, "tt");
    const bones = solid(r.root).skeleton.bones;
    const tips = ["L", "R"].map(side => bones.find(b => b.name.replace(/[._]/g, "") === "eartip" + side)!);
    expect(tips.every(Boolean)).toBe(true);
    r.update("idle", 0, 1 / 60);
    const before = tips.map(b => ({ position: b.position.clone(), rotation: b.quaternion.clone() }));
    r.pop(-3);
    for (let i = 0; i < 15; i++)
        r.update("idle", 0, 1 / 60);
    for (let i = 0; i < tips.length; i++) {
        expect(tips[i]!.position.distanceTo(before[i]!.position)).toBeLessThan(.00001);
        const angle = tips[i]!.quaternion.clone().normalize().angleTo(before[i]!.rotation.normalize());
        expect(angle).toBeGreaterThan(.05);
        expect(angle).toBeLessThan(.55);
        expect(tips[i]!.parent?.name.replace(/[._]/g, "")).toBe("ear" + (i === 0 ? "L" : "R"));
    }
    disposeHomeRig(r.root);
});
