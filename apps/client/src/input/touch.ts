import type { InputSource, MutableInputFrame } from "./inputState.js";

/**
 * Mobile controls: virtual joystick on the left third of the screen + a jump
 * button. Creates its own DOM; only attached on coarse-pointer devices.
 */
export class TouchInput implements InputSource {
  private moveX = 0;
  private moveZ = 0;
  private jumpHeld = false;
  private jumpEdge = false;
  private joyPointer: number | null = null;
  private joyOrigin = { x: 0, y: 0 };

  static isTouchDevice(): boolean {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  constructor(parent: HTMLElement) {
    const zone = document.createElement("div");
    zone.className = "touch-joy-zone";
    const knob = document.createElement("div");
    knob.className = "touch-joy-knob";
    zone.appendChild(knob);
    parent.appendChild(zone);

    const jumpBtn = document.createElement("div");
    jumpBtn.className = "touch-jump-btn";
    jumpBtn.textContent = "JUMP";
    parent.appendChild(jumpBtn);

    const RADIUS = 52;

    zone.addEventListener("pointerdown", (e) => {
      this.joyPointer = e.pointerId;
      this.joyOrigin = { x: e.clientX, y: e.clientY };
      zone.setPointerCapture(e.pointerId);
      knob.style.transform = "translate(0px, 0px)";
      e.preventDefault();
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.joyPointer) return;
      let dx = e.clientX - this.joyOrigin.x;
      let dy = e.clientY - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) {
        dx = (dx / len) * RADIUS;
        dy = (dy / len) * RADIUS;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const dead = 0.18;
      const nx = dx / RADIUS;
      const ny = dy / RADIUS;
      this.moveX = Math.abs(nx) > dead ? nx : 0;
      this.moveZ = Math.abs(ny) > dead ? -ny : 0;
    });
    const joyEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.joyPointer) return;
      this.joyPointer = null;
      this.moveX = 0;
      this.moveZ = 0;
      knob.style.transform = "translate(0px, 0px)";
    };
    zone.addEventListener("pointerup", joyEnd);
    zone.addEventListener("pointercancel", joyEnd);

    jumpBtn.addEventListener("pointerdown", (e) => {
      this.jumpHeld = true;
      this.jumpEdge = true;
      e.preventDefault();
    });
    const jumpEnd = () => (this.jumpHeld = false);
    jumpBtn.addEventListener("pointerup", jumpEnd);
    jumpBtn.addEventListener("pointercancel", jumpEnd);
  }

  read(frame: MutableInputFrame): void {
    frame.moveX += this.moveX;
    frame.moveZ += this.moveZ;
    if (this.jumpHeld) frame.jumpHeld = true;
    if (this.jumpEdge) {
      frame.jumpPressed = true;
      this.jumpEdge = false;
    }
  }
}
