import * as THREE from "three";
import type { FaceId } from "@robo/shared";
export interface FaceSequence {
    label: string;
    fps: number;
    duration: number;
    loop: boolean;
    frames: string[];
}
export interface FaceSequences {
    sequences: Record<string, FaceSequence>;
}
const cache = new Map<string, Promise<ImageBitmap>>();
const FACE_ROOT = "/models/characters/";
export async function faceBitmap(character: "HOME" | "TT", file: string): Promise<ImageBitmap> {
    const url = FACE_ROOT + character + "/" + file;
    let pending = cache.get(url);
    if (pending) {
        cache.delete(url);
        cache.set(url, pending);
        return pending;
    }
    const w = character === "TT" ? 1024 : 512;
    pending = fetch(url).then(async (response) => {
        if (!response.ok)
            throw new Error(`Face image ${response.status}: ${url}`);
        return createImageBitmap(await response.blob(), { resizeWidth: w, resizeHeight: 512, resizeQuality: "high" });
    }).catch((error: unknown) => { cache.delete(url); throw error; });
    cache.set(url, pending);
    while (cache.size > 32) {
        const oldest = cache.keys().next().value;
        if (!oldest)
            break;
        const evicted = cache.get(oldest);
        cache.delete(oldest);
        // GPU/canvas owners copy pixels before the cached bitmap can be retired.
        // Let GC release evicted bitmaps after pending draws finish.
        void evicted;
    }
    return pending;
}
/** A bounded image cache and one GPU canvas per rig, including camera material clones. */
export class FaceCanvas {
    readonly texture: THREE.CanvasTexture;
    private readonly canvas = document.createElement("canvas");
    private readonly ctx: CanvasRenderingContext2D;
    private requested = "";
    private ticket = 0;
    private dead = false;
    private base: FaceId = "neutral";
    private blinkIn = 3 + Math.random() * 2.4;
    private active: {
        sequence: FaceSequence;
        time: number;
        end: FaceId;
        loop: boolean;
    } | null = null;
    constructor(private readonly character: "HOME" | "TT", private readonly sequences: FaceSequences, private readonly filter = "none") {
        this.canvas.width = character === "TT" ? 1024 : 512;
        this.canvas.height = 512;
        this.ctx = this.canvas.getContext("2d")!;
        this.ctx.fillStyle = character === "TT" ? "#A366EF" : "#FFD147";
        this.ctx.fillRect(0, 0, this.canvas.width, 512);
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.flipY = false;
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.anisotropy = 4;
        this.set("neutral");
    }
    set(face: FaceId): void {
        this.base = face;
        this.active = null;
        this.blinkIn = 3 + Math.random() * 2.4;
        void this.draw(`textures/face-${face}.png`);
    }
    play(name: string, end: FaceId = "neutral"): void {
        const sequence = this.sequences.sequences[name];
        if (!sequence) {
            this.set(end);
            return;
        }
        this.base = end;
        this.active = { sequence, time: 0, end, loop: sequence.loop };
        void this.draw(sequence.frames[0]!);
    }
    update(dt: number): void {
        const active = this.active;
        if (!active) {
            if (this.base === "neutral") {
                this.blinkIn -= dt;
                if (this.blinkIn <= 0)
                    this.play("blink");
            }
            return;
        }
        active.time += dt;
        if (active.time >= active.sequence.duration) {
            if (active.loop)
                active.time %= active.sequence.duration;
            else {
                this.set(active.end);
                return;
            }
        }
        const i = Math.min(active.sequence.frames.length - 1, Math.floor(active.time * active.sequence.fps));
        void this.draw(active.sequence.frames[i]!);
        const next = active.sequence.frames[Math.min(i + 1, active.sequence.frames.length - 1)];
        if (next)
            void faceBitmap(this.character, next).catch(() => { });
    }
    private async draw(file: string): Promise<void> {
        if (this.dead || this.requested === file)
            return;
        this.requested = file;
        const ticket = ++this.ticket;
        try {
            const bitmap = await faceBitmap(this.character, file);
            if (this.dead || this.ticket !== ticket)
                return;
            this.ctx.filter = this.filter;
            this.ctx.drawImage(bitmap, 0, 0, this.canvas.width, 512);
            this.texture.needsUpdate = true;
        }
        catch {
            if (ticket === this.ticket)
                this.requested = "";
        }
    }
    dispose(): void { this.dead = true; this.ticket++; this.texture.dispose(); this.canvas.width = 1; this.canvas.height = 1; }
}
