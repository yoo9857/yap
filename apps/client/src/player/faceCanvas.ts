import * as THREE from "three";
import type { FaceId } from "@robo/shared";
export interface FaceSheet {
    file: string;
    columns: number;
    rows: number;
    frameWidth: number;
    frameHeight: number;
    crop: [
        number,
        number,
        number,
        number
    ];
}
export interface FaceSequence {
    label: string;
    fps: number;
    duration: number;
    loop: boolean;
    frames: string[];
    sheets?: Partial<Record<"HOME" | "TT", FaceSheet>>;
}
export interface FaceSequences {
    sequences: Record<string, FaceSequence>;
}
interface Cached {
    pending: Promise<ImageBitmap>;
    bytes: number;
}
const cache = new Map<string, Cached>();
const MAX_BYTES = 96 * 1024 * 1024;
function bitmap(character: "HOME" | "TT", file: string, sheet = false): Promise<ImageBitmap> {
    const url = `/models/characters/${character}/${file}?v=1.2`;
    const old = cache.get(url);
    if (old) {
        cache.delete(url);
        cache.set(url, old);
        return old.pending;
    }
    const entry: Cached = { pending: Promise.resolve(null as unknown as ImageBitmap), bytes: 0 };
    entry.pending = fetch(url).then(async (response) => {
        if (!response.ok)
            throw new Error(`Face image ${response.status}: ${url}`);
        const blob = await response.blob();
        const image = await createImageBitmap(blob, sheet ? {} : { resizeWidth: character === "TT" ? 1024 : 512, resizeHeight: 512, resizeQuality: "high" });
        entry.bytes = image.width * image.height * 4;
        let total = [...cache.values()].reduce((sum, e) => sum + e.bytes, 0);
        for (const [key, value] of cache) {
            if (total <= MAX_BYTES)
                break;
            if (key !== url) {
                cache.delete(key);
                total -= value.bytes;
            }
        }
        // Active canvases/sequences may still hold an evicted bitmap; GC releases it safely.
        return image;
    }).catch((error: unknown) => {
        if (cache.get(url) === entry)
            cache.delete(url);
        throw error;
    });
    cache.set(url, entry);
    return entry.pending;
}
export function faceBitmap(character: "HOME" | "TT", file: string): Promise<ImageBitmap> { return bitmap(character, file); }
interface Playback {
    sequence: FaceSequence;
    time: number;
    end: FaceId;
    ready: boolean;
    image?: ImageBitmap;
    sheet?: FaceSheet;
    frame: number;
}
/** The animation clock starts after decoding. A crop leaves TT's ear atlas intact. */
export class FaceCanvas {
    readonly texture: THREE.CanvasTexture;
    private readonly canvas = document.createElement("canvas");
    private readonly ctx: CanvasRenderingContext2D;
    private ticket = 0;
    private dead = false;
    private base: FaceId = "neutral";
    private blinkIn = 3 + Math.random() * 2.4;
    private active: Playback | null = null;
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
        if (this.dead)
            return;
        this.base = face;
        this.active = null;
        this.blinkIn = 3 + Math.random() * 2.4;
        const ticket = ++this.ticket;
        void faceBitmap(this.character, `textures/face-${face}.png`).then(image => {
            if (!this.dead && this.ticket === ticket)
                this.draw(image);
        }).catch(() => { });
    }
    play(name: string, end: FaceId = "neutral"): void {
        if (this.dead)
            return;
        const sequence = this.sequences.sequences[name];
        if (!sequence) {
            this.set(end);
            return;
        }
        const ticket = ++this.ticket, sheet = sequence.sheets?.[this.character];
        const active: Playback = { sequence, time: 0, end, ready: false, sheet, frame: -1 };
        this.base = end;
        this.active = active;
        void Promise.all([faceBitmap(this.character, "textures/face-neutral.png"), sheet ? bitmap(this.character, sheet.file, true) : faceBitmap(this.character, sequence.frames[0]!)]).then(([neutral, image]) => {
            if (this.dead || this.ticket !== ticket)
                return;
            this.draw(neutral);
            active.image = image;
            active.ready = true;
            this.drawFrame(active, 0);
        }).catch(() => {
            if (!this.dead && this.ticket === ticket)
                this.set(end);
        });
    }
    update(dt: number): void {
        if (this.dead || !Number.isFinite(dt) || dt <= 0)
            return;
        const active = this.active;
        if (!active) {
            if (this.base === "neutral") {
                this.blinkIn -= dt;
                if (this.blinkIn <= 0)
                    this.play("blink");
            }
            return;
        }
        if (!active.ready)
            return;
        active.time += dt;
        if (active.time >= active.sequence.duration) {
            if (active.sequence.loop)
                active.time %= active.sequence.duration;
            else {
                this.set(active.end);
                return;
            }
        }
        const frame = Math.min(active.sequence.frames.length - 1, Math.floor(active.time * active.sequence.fps));
        this.drawFrame(active, frame);
    }
    private drawFrame(active: Playback, frame: number): void {
        if (active.frame === frame)
            return;
        active.frame = frame;
        if (active.sheet && active.image) {
            const s = active.sheet, [x, y, w, h] = s.crop;
            this.ctx.filter = this.filter;
            this.ctx.drawImage(active.image, (frame % s.columns) * s.frameWidth, Math.floor(frame / s.columns) * s.frameHeight, s.frameWidth, s.frameHeight, x, y, w, h);
            this.texture.needsUpdate = true;
        }
        else {
            const ticket = this.ticket;
            void faceBitmap(this.character, active.sequence.frames[frame]!).then(image => {
                if (!this.dead && this.ticket === ticket && active.frame === frame)
                    this.draw(image);
            }).catch(() => { });
        }
    }
    private draw(image: ImageBitmap): void { this.ctx.filter = this.filter; this.ctx.drawImage(image, 0, 0, this.canvas.width, 512); this.texture.needsUpdate = true; }
    dispose(): void {
        if (this.dead)
            return;
        this.dead = true;
        this.ticket++;
        this.active = null;
        this.texture.dispose();
        this.canvas.width = this.canvas.height = 1;
    }
}
