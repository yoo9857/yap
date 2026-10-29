import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FaceCanvas, type FaceSequences } from "../src/player/faceCanvas.js";
const draw = vi.fn<(...args: unknown[]) => void>();
let decode: ReturnType<typeof vi.fn>;
beforeEach(() => {
    draw.mockClear();
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", filter: "", fillRect: vi.fn(), drawImage: draw }) }) });
    decode = vi.fn(() => Promise.resolve({ width: 1024, height: 512 } as ImageBitmap));
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) })));
});
afterEach(() => vi.unstubAllGlobals());
function sequence(file: string): FaceSequences { return { sequences: { test: { label: "test", fps: 10, duration: .4, loop: false, frames: ["a", "b", "c", "d"], sheets: { TT: { file, columns: 4, rows: 1, frameWidth: 576, frameHeight: 256, crop: [96, 96, 576, 256] } } } } }; }
describe("face decode and timing", () => {
    it("waits for a cold sheet, then draws its first frame while preserving the ear panel", async () => {
        let ready!: (value: ImageBitmap) => void;
        const sheet = new Promise<ImageBitmap>(resolve => { ready = resolve; });
        decode.mockImplementation((_blob: Blob, options: ImageBitmapOptions) => options.resizeWidth ? Promise.resolve({ width: 1024, height: 512 } as ImageBitmap) : sheet);
        const face = new FaceCanvas("TT", sequence("cold-test-sheet.png"));
        face.play("test");
        face.update(3);
        await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
        ready({ width: 2304, height: 256 } as ImageBitmap);
        await vi.waitFor(() => expect(draw.mock.calls.some(c => c.length === 9)).toBe(true));
        const last = () => draw.mock.calls.at(-1)!;
        expect(last().slice(1)).toEqual([0, 0, 576, 256, 96, 96, 576, 256]);
        face.update(.06);
        expect(last()[1]).toBe(0);
        face.update(.05);
        expect(last()[1]).toBe(576);
        face.dispose();
    });
    it("ignores a sheet that arrives after a new expression or disposal", async () => {
        let ready!: (value: ImageBitmap) => void;
        const sheet = new Promise<ImageBitmap>(resolve => { ready = resolve; });
        decode.mockImplementation((_blob: Blob, options: ImageBitmapOptions) => options.resizeWidth ? Promise.resolve({ width: 1024, height: 512 } as ImageBitmap) : sheet);
        const face = new FaceCanvas("TT", sequence("stale-test-sheet.png"));
        face.play("test");
        await vi.waitFor(() => expect(decode).toHaveBeenCalled());
        face.set("happy");
        await vi.waitFor(() => expect(draw).toHaveBeenCalled());
        const count = draw.mock.calls.length;
        face.dispose();
        ready({ width: 2304, height: 256 } as ImageBitmap);
        await new Promise(resolve => setTimeout(resolve, 0));
        face.update(1);
        expect(draw).toHaveBeenCalledTimes(count);
    });
});
it("retries the neutral atlas after an initial connection failure", async () => {
    let attempts = 0;
    const fetcher = vi.fn((url: string) => { if (url.includes("HOME/textures/face-neutral") && attempts++ === 0)
        return Promise.reject(new Error("temporary")); return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) }); });
    vi.stubGlobal("fetch", fetcher);
    const meta = sequence("retry-test-sheet.png");
    meta.sequences.test!.sheets!.HOME = meta.sequences.test!.sheets!.TT;
    const face = new FaceCanvas("HOME", meta);
    await new Promise(resolve => setTimeout(resolve, 0));
    face.play("test");
    await vi.waitFor(() => expect(draw.mock.calls.some(c => c.length === 9)).toBe(true));
    expect(attempts).toBe(2);
    face.dispose();
});
