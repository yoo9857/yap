import type * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmupGpuAsync } from "../src/render/textures.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const scene = {} as THREE.Scene, camera = {} as THREE.Camera;
describe("cancelled graphics preparation", () => {
  it("cancels pending shader polling without touching a disposed program", async () => {
    vi.useFakeTimers(); const abort = new AbortController(), render = vi.fn(), check = vi.fn(() => false);
    const renderer = { compile() {}, info: { programs: [{ program: {} }] }, getContext: () => ({
      getExtension: () => ({ COMPLETION_STATUS_KHR: 0x91b1 }), getProgramParameter: check, isContextLost: () => false,
    }) } as unknown as THREE.WebGLRenderer;
    const preparing = warmupGpuAsync(renderer, scene, camera, render, 2, abort.signal);
    abort.abort(); await preparing;
    expect(check).toHaveBeenCalledOnce(); expect(render).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels an awaited display frame when a mode closes while hidden", async () => {
    let nextFrame = 0; const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => ++nextFrame); vi.stubGlobal("cancelAnimationFrame", cancel);
    const abort = new AbortController(), render = vi.fn();
    const renderer = { compile() {}, getContext: () => ({ getExtension: () => null, isContextLost: () => false }) } as unknown as THREE.WebGLRenderer;
    const preparing = warmupGpuAsync(renderer, scene, camera, render, 2, abort.signal);
    abort.abort(); await preparing;
    expect(render).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledWith(1);
  });
});
