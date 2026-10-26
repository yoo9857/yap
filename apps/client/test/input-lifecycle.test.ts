import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardInput } from "../src/input/keyboard.js";
import { InputState } from "../src/input/inputState.js";
afterEach(() => vi.unstubAllGlobals());
describe("player input lifecycle", () => {
  it("clears held keys and queued jump/respawn edges on focus loss", () => {
    const target = new EventTarget(); vi.stubGlobal("window", target); vi.stubGlobal("HTMLElement", class {});
    const input = new InputState(), keyboard = new KeyboardInput(); input.addSource(keyboard);
    for (const code of ["KeyW", "Space", "KeyR"]) target.dispatchEvent(Object.assign(new Event("keydown"), { code, repeat: false }));
    target.dispatchEvent(new Event("blur"));
    expect(input.sample()).toEqual({ moveX: 0, moveZ: 0, jumpHeld: false, jumpPressed: false, respawnPressed: false });
    input.dispose();
  });
  it("unregisters controls when an input source is disposed", () => {
    const target = new EventTarget(); vi.stubGlobal("window", target); vi.stubGlobal("HTMLElement", class {});
    const input = new InputState(), keyboard = new KeyboardInput(); input.addSource(keyboard);
    keyboard.dispose();
    target.dispatchEvent(Object.assign(new Event("keydown"), { code: "Space", repeat: false }));
    expect(input.sample().jumpPressed).toBe(false);
    input.dispose();
  });
});
