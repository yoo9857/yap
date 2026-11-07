import "./touchControls.css";
import { t } from "../ui/i18n.js";
export { isTouchPlay } from "../input/touchPlay.js";

/** What the touch layer asks the game for; the game keeps every rule (CraftGame wires these). */
export interface TouchHooks {
  /** A drag on the view, in screen pixels. */
  look(dx: number, dy: number): void;
  /** ⛏ pressed / let go (left mouse: tap a classmate, swing, dig). */
  primary(down: boolean): void;
  /** 🧱 pressed / let go (right mouse: place, sit, open a door; held builds on). */
  secondary(down: boolean): void;
  /** ☰: back to the pause card. */
  pause(): void;
  /** 🎒: the bag (E). */
  bag(): void;
  /** 😊: emotes and character (C). */
  emotes(): void;
  /** 💬: the classroom chat (Enter); null outside a class. */
  chat: (() => void) | null;
  /** 🧑‍🏫: the teacher's class tools (F2); null for everyone else. */
  tools: (() => void) | null;
}

const JOY_RADIUS = 56;
const DEAD = 0.14;

/**
 * Phone / tablet controls for the voxel modes, standing in for the captured mouse:
 * a floating joystick (bottom left: wherever the thumb lands is the centre), a look pad
 * (drag anywhere else on the view), and buttons for jump, dig, place, the bag, emotes,
 * chat and pause. It only reports input — the game decides what it means — and every
 * control follows its own pointer, so moving, looking and digging work at once.
 */
export class TouchControls {
  /** Joystick, -1..1: x = strafe right, z = forward. */
  moveX = 0;
  moveZ = 0;
  jump = false;
  private readonly root = document.createElement("div");
  private readonly joyBase = document.createElement("div");
  private readonly joyKnob = document.createElement("div");
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };

  constructor(parent: HTMLElement, private readonly hooks: TouchHooks) {
    document.body.classList.add("touch");
    this.root.className = "tc-root";
    this.root.hidden = true;

    const look = div("tc-look");
    look.addEventListener("pointerdown", (e) => {
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      look.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    look.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.lookId) return;
      // coalesced events carry every sample of a fast swipe since the last frame
      const dx = e.clientX - this.lookLast.x, dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      if (dx || dy) this.hooks.look(dx, dy);
    });
    const lookEnd = (e: PointerEvent) => { if (e.pointerId === this.lookId) this.lookId = null; };
    look.addEventListener("pointerup", lookEnd);
    look.addEventListener("pointercancel", lookEnd);

    const joy = div("tc-joy");
    this.joyBase.className = "tc-joy-base";
    this.joyKnob.className = "tc-joy-knob";
    this.joyBase.append(this.joyKnob);
    joy.append(this.joyBase);
    joy.addEventListener("pointerdown", (e) => {
      if (this.joyId !== null) return;
      this.joyId = e.pointerId;
      const box = joy.getBoundingClientRect();
      this.joyOrigin = { x: e.clientX, y: e.clientY };
      this.joyBase.style.left = `${e.clientX - box.left}px`;
      this.joyBase.style.top = `${e.clientY - box.top}px`;
      this.joyBase.classList.add("on");
      this.joyKnob.style.transform = "";
      joy.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    joy.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.joyId) return;
      let dx = e.clientX - this.joyOrigin.x, dy = e.clientY - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) { dx = (dx / len) * JOY_RADIUS; dy = (dy / len) * JOY_RADIUS; }
      this.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      const nx = dx / JOY_RADIUS, nz = -dy / JOY_RADIUS;
      const mag = Math.hypot(nx, nz);
      // a dead zone on the length, not per axis: per axis snapped diagonals to the nearest key
      const k = mag < DEAD ? 0 : (mag - DEAD) / (1 - DEAD) / mag;
      this.moveX = nx * k;
      this.moveZ = nz * k;
    });
    const joyEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = null;
      this.moveX = this.moveZ = 0;
      this.joyBase.classList.remove("on");
      this.joyKnob.style.transform = "";
    };
    joy.addEventListener("pointerup", joyEnd);
    joy.addEventListener("pointercancel", joyEnd);

    const pad = div("tc-pad");
    pad.append(
      this.hold("tc-btn tc-place", "🧱", t("놓기", "Place"), (on) => this.hooks.secondary(on)),
      this.hold("tc-btn tc-mine", "⛏️", t("캐기", "Dig"), (on) => this.hooks.primary(on)),
      this.hold("tc-btn tc-jump", "⬆️", t("점프", "Jump"), (on) => (this.jump = on)),
    );
    const top = div("tc-top");
    top.append(
      this.tap("tc-small", "😊", t("감정표현", "Emotes"), () => this.hooks.emotes()),
      this.tap("tc-small", "🎒", t("가방", "Bag"), () => this.hooks.bag()),
    );
    const chat = this.hooks.chat;
    const tools = this.hooks.tools;
    if (tools) top.append(this.tap("tc-small", "🧑‍🏫", t("수업 도구", "Class tools"), tools));
    if (chat) top.append(this.tap("tc-small", "💬", t("채팅", "Chat"), chat));
    top.append(this.tap("tc-small", "☰", t("메뉴", "Menu"), () => this.hooks.pause()));

    this.root.append(look, joy, pad, top);
    parent.append(this.root);
  }

  /** Shown in play only: the menu card and panels get the screen to themselves. */
  setPlaying(playing: boolean): void {
    if (this.root.hidden === !playing) return;
    this.root.hidden = !playing;
    if (!playing) this.release();
  }

  /** Let go of everything held (a panel opened over a held button never sees its pointerup). */
  release(): void {
    this.moveX = this.moveZ = 0;
    this.joyId = this.lookId = null;
    this.joyBase.classList.remove("on");
    this.joyKnob.style.transform = "";
    if (this.jump) this.jump = false;
    for (const b of this.root.querySelectorAll<HTMLElement>(".tc-btn.down")) {
      b.classList.remove("down");
      b.dispatchEvent(new Event("tc-release"));
    }
  }

  dispose(): void {
    this.root.remove();
    document.body.classList.remove("touch");
  }

  private hold(cls: string, icon: string, label: string, set: (on: boolean) => void): HTMLElement {
    const b = this.button(cls, icon, label);
    let id: number | null = null;
    b.addEventListener("pointerdown", (e) => {
      if (id !== null) return;
      id = e.pointerId;
      b.setPointerCapture(e.pointerId);
      b.classList.add("down");
      set(true);
      e.preventDefault();
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      b.classList.remove("down");
      set(false);
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("tc-release", () => { id = null; set(false); });
    return b;
  }

  private tap(cls: string, icon: string, label: string, run: () => void): HTMLElement {
    const b = this.button(cls, icon, label);
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  }

  private button(cls: string, icon: string, label: string): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.setAttribute("aria-label", label);
    const i = document.createElement("span");
    i.className = "tc-icon";
    i.textContent = icon;
    const l = document.createElement("small");
    l.textContent = label;
    b.append(i, l);
    return b;
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}
