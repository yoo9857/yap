import type { InputSource, MutableInputFrame } from "./inputState.js";

/**
 * WASD / arrows + Space. Edge presses are latched immediately in the DOM
 * handler and drained on the next fixed-tick sample.
 */
export class KeyboardInput implements InputSource {
  private readonly events = new AbortController();
  private readonly held = new Set<string>();
  private jumpEdge = false;
  private respawnEdge = false;

  constructor() {
    // typing in the nickname input must never reach game controls
    const isEditable = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    window.addEventListener("keydown", (e) => {
      if (e.repeat || isEditable(e.target)) return;
      this.held.add(e.code);
      if (e.code === "Space") {
        this.jumpEdge = true;
        e.preventDefault();
      }
      if (e.code === "KeyR") this.respawnEdge = true;
    }, { signal: this.events.signal });
    window.addEventListener("keyup", (e) => {
      this.held.delete(e.code);
    }, { signal: this.events.signal });
    window.addEventListener("blur", () => {
      this.clear();
    }, { signal: this.events.signal });
  }

  private clear(): void { this.held.clear(); this.jumpEdge = this.respawnEdge = false; }
  dispose(): void { this.events.abort(); this.clear(); }

  read(frame: MutableInputFrame): void {
    if (this.held.has("KeyA") || this.held.has("ArrowLeft")) frame.moveX -= 1;
    if (this.held.has("KeyD") || this.held.has("ArrowRight")) frame.moveX += 1;
    if (this.held.has("KeyW") || this.held.has("ArrowUp")) frame.moveZ += 1;
    if (this.held.has("KeyS") || this.held.has("ArrowDown")) frame.moveZ -= 1;
    if (this.held.has("Space")) frame.jumpHeld = true;
    if (this.jumpEdge) {
      frame.jumpPressed = true;
      this.jumpEdge = false;
    }
    if (this.respawnEdge) {
      frame.respawnPressed = true;
      this.respawnEdge = false;
    }
  }
}
