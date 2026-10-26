import { afterEach, describe, expect, it, vi } from "vitest";
import { Bgm } from "../src/audio/bgm.js";
import { Sfx } from "../src/audio/sfx.js";
afterEach(() => vi.unstubAllGlobals());
describe("mode audio cleanup", () => {
  it("does not restart disposed music on later user gestures", () => {
    const window = new EventTarget(); vi.stubGlobal("window", window);
    const play = vi.fn(() => Promise.resolve());
    vi.stubGlobal("Audio", class extends EventTarget {
      src = ""; volume = 1; loop = false; muted = false; paused = true;
      play = play; pause() {} load() {} removeAttribute() { this.src = ""; }
    });
    const bgm = new Bgm(["one.mp3", "two.mp3"]); bgm.dispose(); bgm.dispose();
    const before = play.mock.calls.length;
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(Object.assign(new Event("keydown"), { key: "m" }));
    expect(play).toHaveBeenCalledTimes(before);
  });
  it("closes its AudioContext and removes all unlock callbacks", () => {
    const window = new EventTarget(); vi.stubGlobal("window", window);
    const close = vi.fn(() => Promise.resolve()); let contexts = 0;
    vi.stubGlobal("AudioContext", class { state = "running"; close = close; constructor() { contexts++; } });
    const sfx = new Sfx(); window.dispatchEvent(new Event("pointerdown"));
    expect(contexts).toBe(1); sfx.dispose(); sfx.dispose();
    window.dispatchEvent(new Event("pointerdown")); sfx.play("click");
    expect(close).toHaveBeenCalledOnce(); expect(contexts).toBe(1);
  });
});
