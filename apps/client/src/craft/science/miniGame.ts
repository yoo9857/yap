/**
 * The fitting mini-game window (an Among Us-style task in premium casual-game dress): grounding,
 * generator, wiring, rotor. Rules are in miniGameRules.ts; the motion kit (particles, verlet rope,
 * springs, tweens, shake, flowing electrons) in miniFx.ts; the painted art is generated for it
 * (public/ui/minigame/*.webp — mockups, prompts and build script in assets/powercard/minigame;
 * stage positions are measured against that art). Everything reacts: a hammer winds up and strikes
 * with a shake and a dirt burst, cables swing, the magnet spins on like a flywheel, electrons run
 * down live wires, a dragged blade turns to face its socket. It frees the mouse while open (the
 * host does that), closes with ✕ / Esc (nothing fitted), and calls back on success.
 */
import { t } from "../../ui/i18n.js";
import {
  BLADES,
  HUB_MOUNTS,
  ROD_HITS,
  generator,
  grounding,
  rotor,
  startWiring,
  wiring,
  WIRE_TO,
  type GeneratorState,
  type GroundingState,
  type MiniGameKind,
  type RotorState,
  type Terminal,
  type WireColour,
  type WiringState,
} from "./miniGameRules.js";
import { Flow, Particles, Rope, Shake, Spring, Tweens, ease, svgEl as el } from "./miniFx.js";

const ART = "/ui/minigame/";
const ART_FILES = [
  "g-scene", "g-rod", "g-hammer", "g-clip",
  "gen-coil", "gen-magnet", "gen-meter", "gen-bulb-off", "gen-bulb-on",
  "w-scene", "w-jack-plus", "w-jack-minus", "w-jack-ground", "w-plug-red", "w-plug-black", "w-plug-earth",
  "r-scene", "r-hub", "r-blade", "r-bolt",
  "ui-icon-ground", "ui-icon-magnet", "ui-icon-plug", "ui-icon-rotor",
];
/**
 * The art is fetched once into blob URLs (with retries) before a game draws, so an SVG <image> never
 * waits on the network mid-game — a slow or dropped request used to leave a stage with pieces missing.
 */
const artBlobs = new Map<string, string>();
const artLoads = new Map<string, Promise<boolean>>();
const loadArt = (name: string): Promise<boolean> => {
  let p = artLoads.get(name);
  if (!p) {
    p = (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(`${ART}${name}.webp${attempt ? `?r=${attempt}` : ""}`);
          if (!res.ok) throw new Error(String(res.status));
          const url = URL.createObjectURL(await res.blob());
          const probe = new Image();
          probe.src = url;
          await probe.decode();
          artBlobs.set(name, url);
          return true;
        } catch {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      artLoads.delete(name); // let a later open try again
      return false;
    })();
    artLoads.set(name, p);
  }
  return p;
};
const ART_OF: Record<MiniGameKind, string[]> = {
  grounding: ["g-scene", "g-rod", "g-hammer", "g-clip", "ui-icon-ground"],
  generator: ["gen-coil", "gen-magnet", "gen-meter", "gen-bulb-off", "gen-bulb-on", "ui-icon-magnet"],
  wiring: ["w-scene", "w-jack-plus", "w-jack-minus", "w-jack-ground", "w-plug-red", "w-plug-black", "w-plug-earth", "ui-icon-plug"],
  rotor: ["r-scene", "r-hub", "r-blade", "r-bolt", "ui-icon-rotor"],
};
const art = (name: string) => artBlobs.get(name) ?? `${ART}${name}.webp`;

export type GameSound = "place" | "pickup" | "click" | "clear" | "checkpoint";

const META: Record<MiniGameKind, { icon: string; title: () => string; sub: () => string; done: () => string }> = {
  grounding: {
    icon: "ui-icon-ground",
    title: () => t("접지하기", "Grounding"),
    sub: () => t("구리 접지봉을 땅에 박고, 접지선을 물려요", "Drive the copper rod in, then clip the earth wire on"),
    done: () => t("남는 전기와 번개가 땅으로 안전하게 빠져요. 그래서 접지선은 '생명선'이에요.", "Leftover electricity and lightning run safely into the ground — the earth wire is a lifeline."),
  },
  generator: {
    icon: "ui-icon-magnet",
    title: () => t("자석과 코일", "Magnet and coil"),
    sub: () => t("자석을 빙글빙글 돌려요 — 멈추면 바늘도 0!", "Spin the magnet round — stop, and the needle drops to 0!"),
    done: () => t("코일 안에서 자석이 돌 때만 전기가 생겨요. 이게 발전기의 원리예요.", "Electricity flows only while the magnet turns inside the coil — that is how a generator works."),
  },
  wiring: {
    icon: "ui-icon-plug",
    title: () => t("전선 연결", "Wiring"),
    sub: () => t("같은 색 단자에 꽂아요 (빨강 +, 검정 −, 초록·노랑 접지)", "Plug each into its terminal (red +, black −, green-yellow earth)"),
    done: () => t("색이 정해져 있어서 누구나 안전하게 연결해요. 빨강 +, 검정 −, 초록·노랑은 땅(접지).", "The colour code keeps everyone safe: red +, black −, green-yellow to earth."),
  },
  rotor: {
    icon: "ui-icon-rotor",
    title: () => t("날개 조립", "Blade assembly"),
    sub: () => t("날개 3장을 허브 구멍에 끼우고 볼트를 조여요", "Mount three blades on the hub and tighten the bolts"),
    done: () => t("날개를 똑같은 간격(120°)으로 달아야 균형이 맞아 흔들리지 않고 돌아요.", "Evenly spaced blades (120° apart) keep the rotor balanced, so it spins without wobbling."),
  },
};

const img = (parent: Element, name: string, x: number, y: number, w: number, h: number, extra: Record<string, string | number> = {}) =>
  el("image", { href: art(name), "data-art": name, x, y, width: w, height: h, preserveAspectRatio: "xMidYMid meet", ...extra }, parent);

type Live =
  | { kind: "grounding"; s: GroundingState }
  | { kind: "generator"; s: GeneratorState }
  | { kind: "wiring"; s: WiringState }
  | { kind: "rotor"; s: RotorState };

export class MiniGame {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly iconEl: HTMLImageElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly chipEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly actions: HTMLElement;
  private kind: MiniGameKind | null = null;
  private onDone: ((ok: boolean) => void) | null = null;
  private raf = 0;
  /** >0 while the win celebration plays (seconds left, counted down by the frame loop — a timer
   *  can be throttled by the browser and leave the window open). */
  private finishing = 0;
  /** This game's pointer handlers on the shared SVG (reset each open, so nothing piles up). */
  private dragHandlers: { type: "pointerdown" | "pointermove" | "pointerup"; fn: (e: PointerEvent) => void }[] = [];
  private dragOn(type: "pointerdown" | "pointermove" | "pointerup", fn: (e: PointerEvent) => void): void {
    this.dragHandlers.push({ type, fn });
  }
  private g: Live | null = null;
  private redraw: () => void = () => {};
  private tick: (dt: number) => void = () => {};
  private tweens = new Tweens();
  private particles: Particles | null = null;
  private readonly shake: Shake;
  /** Seconds since the player last touched the stage (drives the hint hand). */
  private idle = 0;
  private hand: SVGGElement | null = null;
  private handPath: [number, number, number, number] | null = null;

  constructor(parent: HTMLElement, private readonly sound: (name: GameSound) => void = () => {}) {
    this.root = document.createElement("div");
    this.root.className = "sci-game";
    this.root.innerHTML = `
      <div class="sci-game-card" role="dialog" aria-modal="true">
        <div class="sci-game-head">
          <img class="sci-game-icon" alt="" />
          <div><h2></h2><p></p></div>
          <span class="sci-game-chip"></span>
          <button type="button" class="sci-game-x" aria-label="${t("닫기", "Close")}">✕</button>
        </div>
        <div class="sci-game-stage">
          <div class="sci-game-actions"></div>
          <p class="sci-game-note"></p>
          <div class="sci-game-confetti"></div>
        </div>
      </div>`;
    this.stage = this.root.querySelector(".sci-game-stage")!;
    this.svg = el("svg", { class: "sci-game-svg" });
    this.stage.prepend(this.svg);
    this.shake = new Shake(this.stage);
    this.iconEl = this.root.querySelector(".sci-game-icon")!;
    this.titleEl = this.root.querySelector("h2")!;
    this.subEl = this.root.querySelector(".sci-game-head p")!;
    this.chipEl = this.root.querySelector(".sci-game-chip")!;
    this.noteEl = this.root.querySelector(".sci-game-note")!;
    this.actions = this.root.querySelector(".sci-game-actions")!;
    this.root.querySelector(".sci-game-x")!.addEventListener("click", () => this.close(false));
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.close(false);
    });
    this.svg.addEventListener("pointerdown", () => {
      this.idle = 0;
    });
    // drags capture on the SVG itself (it never moves); a piece that is re-parented or redrawn while
    // held lost its own capture, and the drop never came (a blade stayed stuck to the tray)
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
      this.svg.addEventListener(type, (e) => {
        const want = type === "pointercancel" ? "pointerup" : type;
        for (const h of this.dragHandlers) if (h.type === want) h.fn(e);
      });
    }
    parent.appendChild(this.root);
    // warm every game's art in the background (each open still waits for its own)
    const idle = (globalThis as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
    idle(() => {
      for (const f of ART_FILES) void loadArt(f);
    });
  }

  get isOpen(): boolean {
    return this.kind !== null;
  }

  get current(): MiniGameKind | null {
    return this.kind;
  }

  /** True while the open game is still fetching its art. */
  loading = false;
  private session = 0;

  open(kind: MiniGameKind, onDone: (ok: boolean) => void): void {
    this.close(false);
    this.kind = kind;
    this.onDone = onDone;
    const session = ++this.session;
    const need = ART_OF[kind];
    if (need.every((n) => artBlobs.has(n))) {
      this.start(kind);
      return;
    }
    // first time (or a failed fetch): show the window with a spinner and draw once the art is in
    this.loading = true;
    this.root.dataset.kind = kind;
    this.titleEl.textContent = META[kind].title();
    this.subEl.textContent = t("준비하는 중…", "Getting ready…");
    this.chipEl.innerHTML = "";
    this.actions.innerHTML = "";
    this.noteEl.classList.remove("show");
    this.svg.innerHTML = "";
    this.root.classList.remove("won", "zap");
    this.root.classList.add("open", "loading");
    void Promise.all(need.map(loadArt)).then(() => {
      if (this.session !== session || this.kind !== kind) return;
      this.loading = false;
      this.root.classList.remove("loading");
      this.start(kind);
    });
  }

  private start(kind: MiniGameKind): void {
    this.dragHandlers = [];
    this.finishing = 0;
    this.idle = 0;
    this.tweens = new Tweens();
    const meta = META[kind];
    this.root.dataset.kind = kind;
    this.iconEl.src = art(meta.icon);
    this.titleEl.textContent = meta.title();
    this.subEl.textContent = meta.sub();
    this.chipEl.innerHTML = "";
    this.noteEl.textContent = "";
    this.noteEl.classList.remove("show");
    this.actions.innerHTML = "";
    this.svg.innerHTML = "";
    this.root.querySelector(".sci-game-confetti")!.innerHTML = "";
    this.root.classList.remove("won", "zap");
    if (kind === "grounding") this.buildGrounding();
    else if (kind === "generator") this.buildGenerator();
    else if (kind === "wiring") this.buildWiring();
    else this.buildRotor();
    // shared layers on top: particles, then the hint hand
    this.particles = new Particles(el("g", { "pointer-events": "none" }, this.svg));
    this.hand = el("g", { opacity: 0, "pointer-events": "none" }, this.svg);
    el("path", { fill: "none", stroke: "#ffffff", "stroke-width": 8, "stroke-linecap": "round", "stroke-dasharray": "4 18", class: "sci-g-march" }, this.hand);
    el("circle", { r: 34, fill: "none", stroke: "#ffffff", "stroke-width": 7, class: "sci-g-ring" }, this.hand);
    this.root.classList.add("open");
    let last = performance.now();
    const loop = (now: number) => {
      const real = Math.min(0.5, (now - last) / 1000);
      const dt = Math.min(0.05, real);
      last = now;
      this.tweens.update(dt);
      if (this.finishing > 0) {
        // the closing beat runs on real time: slow frames slow the animation, not the hand-off
        this.finishing -= real;
        if (this.finishing <= 0) {
          this.finishing = 0;
          this.close(true);
          return;
        }
      }
      this.tick(dt);
      this.particles?.update(dt);
      this.shake.update(dt);
      this.updateHand(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    (this.root.querySelector(".sci-game-x") as HTMLElement).focus({ preventScroll: true });
  }

  close(ok: boolean): void {
    if (!this.kind) return;
    this.loading = false;
    this.root.classList.remove("loading");
    cancelAnimationFrame(this.raf);
    this.finishing = 0;
    this.kind = null;
    this.g = null;
    this.particles = null;
    this.tweens.clear();
    this.root.classList.remove("open", "won");
    this.stage.style.transform = "";
    const cb = this.onDone;
    this.onDone = null;
    cb?.(ok);
  }

  /** Dev hook: play the open game to the end through its own rules. */
  solve(): void {
    const g = this.g;
    if (!g) return;
    if (g.kind === "grounding") {
      for (let i = 0; i < ROD_HITS; i++) g.s = grounding.hit(g.s);
      g.s = grounding.drop(g.s, 0).state;
    } else if (g.kind === "generator") {
      for (let i = 0; i < 40 && !generator.done(g.s); i++) g.s = generator.turn(g.s, Math.PI / 3, 1 / 30);
    } else if (g.kind === "wiring") {
      for (const w of ["red", "black", "earth"] as WireColour[]) g.s = wiring.connect(g.s, w, WIRE_TO[w]).state;
    } else {
      let s = rotor.start();
      for (const m of [0, 2, 4]) s = rotor.tighten(rotor.attach(s, m).state, m).state;
      g.s = rotor.spin(s);
    }
    this.redraw();
    this.checkDone();
  }

  dispose(): void {
    this.close(false);
    this.root.remove();
  }

  // ------------------------------------------------------------ shared

  private sub(text: string): void {
    this.subEl.textContent = text;
  }

  private chip(label: string, on: number, of: number): void {
    const html = `<b>${label}</b><span class="sci-game-dots">${Array.from({ length: of }, (_, i) => `<i class="${i < on ? "on" : ""}"></i>`).join("")}</span>`;
    if (this.chipEl.innerHTML !== html) this.chipEl.innerHTML = html;
  }

  private svgPoint(e: PointerEvent): { x: number; y: number } {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  /** Where the idle hint hand should point (from → to), or null for none. */
  private hint(path: [number, number, number, number] | null): void {
    this.handPath = path;
  }

  private updateHand(dt: number): void {
    if (!this.hand) return;
    this.idle += dt;
    if (!this.handPath || this.idle < 3 || this.finishing) {
      this.hand.setAttribute("opacity", "0");
      return;
    }
    const [x1, y1, x2, y2] = this.handPath;
    const path = this.hand.firstElementChild as SVGPathElement;
    const ring = this.hand.lastElementChild as SVGCircleElement;
    const mx = (x1 + x2) / 2;
    const my = Math.min(y1, y2) - Math.abs(x2 - x1) * 0.18;
    path.setAttribute("d", `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`);
    ring.setAttribute("cx", String(x2));
    ring.setAttribute("cy", String(y2));
    this.hand.setAttribute("opacity", String(Math.min(0.9, (this.idle - 3) * 2)));
  }

  private confetti(): void {
    const box = this.root.querySelector(".sci-game-confetti")!;
    box.innerHTML = "";
    const colours = ["#ffcf3a", "#7fe3a0", "#7fc4ff", "#ff8a7a", "#c7a8ff"];
    for (let i = 0; i < 30; i++) {
      const c = document.createElement("i");
      const a = (i / 30) * Math.PI * 2;
      c.style.background = colours[i % colours.length]!;
      c.style.setProperty("--dx", `${Math.cos(a) * (180 + (i % 5) * 45)}px`);
      c.style.setProperty("--dy", `${Math.sin(a) * (130 + (i % 4) * 30) - 70}px`);
      c.style.setProperty("--r", `${(i % 2 ? 1 : -1) * (200 + i * 15)}deg`);
      box.appendChild(c);
    }
  }

  private checkDone(): void {
    const g = this.g;
    if (!g || this.finishing) return;
    const done = g.kind === "grounding" ? grounding.done(g.s) : g.kind === "generator" ? generator.done(g.s) : g.kind === "wiring" ? wiring.done(g.s) : rotor.done(g.s);
    if (!done) return;
    this.sub(t("✅ 완료! 발전소에 끼워져요", "✅ Done! It goes into the plant"));
    this.noteEl.textContent = `📘 ${META[g.kind].done()}`;
    this.noteEl.classList.add("show");
    this.root.classList.add("won");
    this.actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    this.hint(null);
    this.confetti();
    this.sound("clear");
    this.finishing = 2.6;
    // the frame loop closes the window on time; a stalled frame loop (hidden tab, a busy machine)
    // must not leave a finished game open, so a timer backs it up — whichever comes first
    const session = this.session;
    setTimeout(() => {
      if (this.session === session && this.finishing > 0) {
        this.finishing = 0;
        this.close(true);
      }
    }, 3400);
  }

  // ------------------------------------------------------------ grounding

  private buildGrounding(): void {
    const state = { kind: "grounding" as const, s: grounding.start() };
    this.g = state;
    const s = this.svg;
    s.setAttribute("viewBox", "0 0 1400 583");
    img(s, "g-scene", 0, 0, 1400, 583, { preserveAspectRatio: "none" });
    for (const [y, d] of [[90, 0], [150, 1.4], [120, 2.6]] as const) el("path", { d: `M 600 ${y} q 60 -18 120 0 t 120 0`, fill: "none", stroke: "rgba(255,255,255,0.7)", "stroke-width": 5, "stroke-linecap": "round", class: "sci-g-wind", style: `animation-delay:${d}s` }, s);
    const ROD_X = 1010;
    const ROD_H = 330;
    const ROD_W = 56;
    const topFor = (hits: number) => 70 + (hits / ROD_HITS) * 220;
    const rodY = new Spring(topFor(0), topFor(0), 260, 14);
    const rod = img(s, "g-rod", ROD_X - ROD_W / 2, 0, ROD_W, ROD_H);
    const ripple = el("ellipse", { cx: ROD_X, cy: 470, rx: 0, ry: 0, fill: "none", stroke: "#ffe46b", "stroke-width": 6, opacity: 0 }, s);
    const guide = el("path", { fill: "none", stroke: "#ffffff", "stroke-width": 7, "stroke-linecap": "round", "stroke-dasharray": "2 18", class: "sci-g-hint" }, s);
    const ring = el("ellipse", { rx: 46, ry: 16, fill: "none", stroke: "#7dffb0", "stroke-width": 7, class: "sci-g-ring" }, s);
    const LUG = { x: 318, y: 206 };
    const cableBase = el("path", { fill: "none", stroke: "#2f9a3e", "stroke-width": 26, "stroke-linecap": "round" }, s);
    const cableStripe = el("path", { fill: "none", stroke: "#ffd23a", "stroke-width": 26, "stroke-linecap": "butt", "stroke-dasharray": "18 22" }, s);
    const cableShine = el("path", { fill: "none", stroke: "rgba(255,255,255,0.45)", "stroke-width": 6, "stroke-linecap": "round", transform: "translate(-3 -7)" }, s);
    const flowLayer = el("g", { "pointer-events": "none" }, s);
    const current = new Flow(flowLayer, cableBase, 7, "#fff27a", 9);
    const CLIP_W = 230;
    const CLIP_H = 85;
    const clipG = el("g", { class: "drag" }, s);
    img(clipG, "g-clip", -CLIP_W, -CLIP_H * 0.58, CLIP_W, CLIP_H);
    el("rect", { x: -CLIP_W, y: -CLIP_H * 0.7, width: CLIP_W + 20, height: CLIP_H * 1.3, fill: "transparent" }, clipG);
    // hammer art 210×200: head centre at (59, 54), the handle's end at (189, 180) — it swings from there
    const HAM = { w: 210, h: 200, hx: 59, hy: 54, px: 189, py: 180 };
    const hammerG = el("g", { "pointer-events": "none" }, s);
    const hammer = img(hammerG, "g-hammer", 0, 0, HAM.w, HAM.h);
    const bang = el("g", { opacity: 0, "pointer-events": "none" }, s);
    el("ellipse", { cx: 0, cy: 0, rx: 92, ry: 58, fill: "#fff6c9" }, bang);
    el("path", { d: "M 30 40 L 60 78 L 8 50 Z", fill: "#fff6c9" }, bang);
    el("text", { x: 0, y: 16, "text-anchor": "middle", fill: "#5a3b00", "font-size": 48, "font-family": "Jua, system-ui, sans-serif" }, bang).textContent = t("쾅!", "Bang!");
    const hitZone = el("rect", { x: ROD_X - 150, y: 0, width: 330, height: 520, fill: "transparent", class: "hit" }, s);
    const REST = { x: 760, y: 300 };
    const clip = { x: REST.x, y: REST.y };
    const rope = new Rope(16, LUG.x, LUG.y, REST.x - CLIP_W + 10, REST.y + 4, 1.1);
    let swing = 0; // hammer swing time: 0 idle, >0 animating (seconds)
    let queued = 0; // taps made during a swing: each gets its own blow (a child mashes the button)
    let flowRate = 0;
    let dragging = false;
    const head = () => ({ x: ROD_X, y: rodY.value + 22 });
    const draw = () => {
      const ready = state.s.hits >= ROD_HITS && !state.s.connected;
      if (state.s.hits < ROD_HITS) this.chip(`${state.s.hits} / ${ROD_HITS}`, state.s.hits, ROD_HITS);
      else this.chip(state.s.connected ? "✓" : t("접지선", "Wire"), ROD_HITS, ROD_HITS);
      guide.style.display = ready ? "" : "none";
      ring.style.display = ready ? "" : "none";
      hammerG.style.display = state.s.hits >= ROD_HITS ? "none" : "";
      hitZone.style.display = state.s.hits >= ROD_HITS ? "none" : "";
      if (!this.finishing) {
        this.sub(state.s.hits < ROD_HITS
          ? t("① 망치로 쾅! — 구리 접지봉을 땅속 깊이 박아요", "① Bang! Drive the copper rod deep into the ground")
          : state.s.connected ? t("⚡ 전기가 접지선을 타고 땅속으로 빠져요!", "⚡ The current runs down the wire into the ground!")
          : t("② 초록·노랑 접지선의 집게를 끌어다 빛나는 봉 머리에 물려요", "② Drag the green-yellow wire's clip onto the glowing rod head"));
      }
      this.hint(state.s.hits < ROD_HITS ? [ROD_X + 60, 120, ROD_X + 20, 150] : ready ? [clip.x - 60, clip.y, head().x, head().y] : null);
    };
    this.redraw = draw;
    const btn = document.createElement("button");
    const hit = () => {
      // blows still to land: the queue, plus the swing in progress only if it has not struck yet
      // (counting a swing in its recoil, whose blow is already in `hits`, ate a fast child's tap)
      const pending = queued + (swing > 0 && swing < 0.24 ? 1 : 0);
      if (state.s.hits + pending >= ROD_HITS || this.finishing) return;
      if (swing > 0) queued++;
      else swing = 0.0001;
    };
    hitZone.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hit();
    });
    btn.type = "button";
    btn.className = "sci-game-btn";
    btn.innerHTML = `<img src="${art("g-hammer")}" alt="" />${t("쾅! 박기", "Bang!")}`;
    btn.addEventListener("click", hit);
    this.actions.appendChild(btn);
    clipG.addEventListener("pointerdown", (e) => {
      if (state.s.connected || this.finishing) return;
      dragging = true;
      this.svg.setPointerCapture(e.pointerId);
      this.sound("pickup");
    });
    this.dragOn("pointermove", (e) => {
      if (!dragging) return;
      const p = this.svgPoint(e);
      clip.x = Math.max(260, Math.min(1380, p.x + 10));
      clip.y = Math.max(40, Math.min(560, p.y));
    });
    this.dragOn("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      const h = head();
      const res = grounding.drop(state.s, Math.hypot(clip.x - 40 - h.x, clip.y - h.y) / 2.5);
      state.s = res.state;
      if (res.result === "ok") {
        // the clip snaps onto the head: a flash, sparks, then current running into the earth
        const from = { ...clip };
        this.tweens.add(0.18, (k) => {
          const e2 = ease.outBack(k);
          clip.x = from.x + (h.x + 30 - from.x) * e2;
          clip.y = from.y + (h.y + 4 - from.y) * e2;
        });
        this.particles?.burst(h.x, h.y, { count: 22, colours: ["#fff27a", "#ffffff", "#7dffb0"], speed: [200, 520], gravity: 300, size: [4, 9] });
        this.sound("click");
        this.tweens.add(1.2, (k) => {
          ripple.setAttribute("rx", String(40 + 260 * k));
          ripple.setAttribute("ry", String(10 + 50 * k));
          ripple.setAttribute("opacity", String(0.9 * (1 - k)));
        });
        this.tweens.add(0.5, (k) => (flowRate = k * 0.9));
        draw();
        this.checkDone();
        return;
      }
      if (res.result === "rod-first") this.sub(t("먼저 망치로 봉을 끝까지 박아요!", "Drive the rod all the way in first!"));
      const from = { ...clip };
      this.tweens.add(0.35, (k) => {
        const e2 = ease.outBack(k);
        clip.x = from.x + (REST.x - from.x) * e2;
        clip.y = from.y + (REST.y - from.y) * e2;
      });
      draw();
    });
    this.tick = (dt) => {
      // the hammer swings from the end of its handle: rest (a slight hover) → wind-up (head back) →
      // strike (head down onto the rod) → recoil back to rest
      const now = performance.now();
      let rot = Math.sin(now / 520) * 1.5;
      if (swing > 0) {
        const before = swing;
        swing += dt;
        const k = swing;
        if (k < 0.16) {
          rot = 30 * ease.outCubic(k / 0.16);
        } else if (k < 0.24) {
          const m = (k - 0.16) / 0.08;
          rot = 30 - 44 * m * m; // accelerating down
        } else {
          if (before < 0.24) {
            // impact: the rod goes in, the stage shakes, dirt and sparks fly
            state.s = grounding.hit(state.s);
            rodY.target = topFor(state.s.hits);
            rodY.vel = 600;
            this.shake.kick(14);
            this.particles?.burst(ROD_X, 440, { count: 18, colours: ["#a86a3a", "#c98a4a", "#7a4a2a", "#7fc35a"], speed: [180, 460], angle: -Math.PI / 2, spread: 2.2, gravity: 1400, size: [6, 14] });
            this.particles?.burst(ROD_X, rodY.value + 10, { count: 12, colours: ["#fff27a", "#ffffff"], speed: [220, 520], angle: -Math.PI / 2, spread: 2.6, gravity: 500, size: [3, 7] });
            this.tweens.add(0.6, (m) => {
              const sc = m < 0.3 ? 0.6 + m * 1.6 : 1.08 - (m - 0.3) * 0.12;
              bang.setAttribute("transform", `translate(${ROD_X - 175} ${(rodY.value + 40 - m * 26).toFixed(1)}) scale(${sc.toFixed(2)})`);
              bang.setAttribute("opacity", String(m < 0.6 ? 1 : (1 - m) / 0.4));
            });
            this.sound("place");
            draw();
            if (state.s.hits >= ROD_HITS) btn.disabled = true;
          }
          const m = Math.min(1, (k - 0.24) / 0.3);
          rot = -14 + 14 * ease.outBack(m); // bounces off the rod, settles
          if (k > 0.54) {
            swing = queued > 0 && state.s.hits < ROD_HITS ? 0.0001 : 0;
            if (queued > 0) queued--;
          }
        }
      }
      const top = rodY.update(dt);
      rod.setAttribute("y", top.toFixed(1));
      // at rest the head hovers just above the rod's head; the strike's -14° brings it down onto it
      const hx = ROD_X - HAM.hx;
      const hy = rodY.target - 34 - HAM.hy;
      hammer.setAttribute("x", hx.toFixed(1));
      hammer.setAttribute("y", hy.toFixed(1));
      hammerG.setAttribute("transform", `rotate(${rot.toFixed(1)} ${(hx + HAM.px).toFixed(1)} ${(hy + HAM.py).toFixed(1)})`);
      const h = head();
      ring.setAttribute("cx", String(h.x));
      ring.setAttribute("cy", h.y.toFixed(1));
      guide.setAttribute("d", `M ${clip.x + 20} ${clip.y} Q ${(clip.x + h.x) / 2} ${Math.min(clip.y, h.y) - 90} ${h.x - 40} ${h.y}`);
      clipG.setAttribute("transform", `translate(${clip.x.toFixed(1)} ${clip.y.toFixed(1)})`);
      rope.update(dt, LUG.x, LUG.y, clip.x - CLIP_W + 10, clip.y + 4);
      const d = rope.d();
      cableBase.setAttribute("d", d);
      cableStripe.setAttribute("d", d);
      cableShine.setAttribute("d", d);
      current.update(dt, flowRate);
    };
    draw();
  }

  // ------------------------------------------------------------ generator

  private buildGenerator(): void {
    const state = { kind: "generator" as const, s: generator.start() };
    this.g = state;
    const s = this.svg;
    s.setAttribute("viewBox", "0 0 1400 583");
    const defs = el("defs", {}, s);
    const bg = el("radialGradient", { id: "sci-gen-bg", cx: "35%", cy: "45%", r: "75%" }, defs);
    el("stop", { offset: "0%", "stop-color": "#effaf5" }, bg);
    el("stop", { offset: "100%", "stop-color": "#cdeee0" }, bg);
    const bar = el("linearGradient", { id: "sci-gen-bar", x1: 0, x2: 1 }, defs);
    el("stop", { offset: "0%", "stop-color": "#8ff06a" }, bar);
    el("stop", { offset: "100%", "stop-color": "#3fcf5c" }, bar);
    const glowG = el("radialGradient", { id: "sci-gen-glow" }, defs);
    el("stop", { offset: "0%", "stop-color": "#ffb45a", "stop-opacity": 0.9 }, glowG);
    el("stop", { offset: "100%", "stop-color": "#ffb45a", "stop-opacity": 0 }, glowG);
    const mk = el("marker", { id: "sci-gen-arrow", viewBox: "0 0 10 10", refX: 5, refY: 5, markerWidth: 3, markerHeight: 3, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0 0L10 5L0 10z", fill: "#6fd6a7" }, mk);
    el("rect", { x: 0, y: 0, width: 1400, height: 583, fill: "url(#sci-gen-bg)" }, s);
    const COIL = { x: 175, y: 25, w: 480, h: 538 };
    const C = { x: COIL.x + COIL.w / 2, y: COIL.y + COIL.h * 0.43 };
    const coilGlow = el("circle", { cx: C.x, cy: C.y, r: 250, fill: "url(#sci-gen-glow)", opacity: 0 }, s);
    const wire = el("path", { d: "M 640 430 C 760 430, 780 300, 880 300", fill: "none", stroke: "#e39a5a", "stroke-width": 12, "stroke-linecap": "round" }, s);
    img(s, "gen-coil", COIL.x, COIL.y, COIL.w, COIL.h);
    const flowLayer = el("g", { "pointer-events": "none" }, s);
    const electrons = new Flow(flowLayer, wire, 6, "#fff27a", 8);
    // field lines around the magnet, turning with it
    const field = el("g", { opacity: 0, "pointer-events": "none" }, s);
    for (const r of [120, 150]) {
      el("ellipse", { cx: C.x, cy: C.y - r * 0.35, rx: r, ry: r * 0.42, fill: "none", stroke: "#7fb6ff", "stroke-width": 4, "stroke-dasharray": "10 12" }, field);
      el("ellipse", { cx: C.x, cy: C.y + r * 0.35, rx: r, ry: r * 0.42, fill: "none", stroke: "#ff9a8a", "stroke-width": 4, "stroke-dasharray": "10 12" }, field);
    }
    const hintArc = el("path", { d: `M ${C.x - 120} ${C.y - 150} A 170 170 0 0 1 ${C.x + 130} ${C.y - 140}`, fill: "none", stroke: "#6fd6a7", "stroke-width": 16, "stroke-linecap": "round", "marker-end": "url(#sci-gen-arrow)", class: "sci-g-hint" }, s);
    const MAG = { w: 300, h: 108 };
    // motion-blur ghosts behind the magnet
    const ghostOp = [0.35, 0.18];
    const ghosts = ghostOp.map(() => img(s, "gen-magnet", C.x - MAG.w / 2, C.y - MAG.h / 2, MAG.w, MAG.h, { opacity: 0 }));
    const magnet = img(s, "gen-magnet", C.x - MAG.w / 2, C.y - MAG.h / 2, MAG.w, MAG.h);
    const METER = { x: 860, y: 70, w: 380, h: 255 };
    img(s, "gen-meter", METER.x, METER.y, METER.w, METER.h);
    const P = { x: METER.x + METER.w / 2, y: METER.y + METER.h * 0.72 };
    const needle = el("line", { x1: P.x, y1: P.y, x2: P.x - 120, y2: P.y, stroke: "#e2463a", "stroke-width": 11, "stroke-linecap": "round" }, s);
    el("circle", { cx: P.x, cy: P.y, r: 20, fill: "#2f8a6c" }, s);
    const BULB = { x: 1255, y: 40, w: 120, h: 200 };
    const rays = el("g", { opacity: 0, "pointer-events": "none" }, s);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      el("line", { x1: BULB.x + 60 + Math.cos(a) * 80, y1: BULB.y + 80 + Math.sin(a) * 80, x2: BULB.x + 60 + Math.cos(a) * 112, y2: BULB.y + 80 + Math.sin(a) * 112, stroke: "#ffd84a", "stroke-width": 8, "stroke-linecap": "round" }, rays);
    }
    const glow = el("circle", { cx: BULB.x + BULB.w / 2, cy: BULB.y + 75, r: 90, fill: "#ffe46b", opacity: 0 }, s);
    img(s, "gen-bulb-off", BULB.x, BULB.y, BULB.w, BULB.h);
    const on = img(s, "gen-bulb-on", BULB.x - 6, BULB.y - 2, BULB.w + 12, BULB.h + 2, { opacity: 0 });
    const label = el("g", {}, s);
    el("rect", { x: 900, y: 360, width: 420, height: 64, rx: 32, fill: "#fffdf6" }, label);
    const labelText = el("text", { x: 1110, y: 404, "text-anchor": "middle", fill: "#245a45", "font-size": 34, "font-family": "Jua, system-ui, sans-serif" }, label);
    el("rect", { x: 880, y: 450, width: 460, height: 58, rx: 29, fill: "#e4f3ec" }, s);
    const fill = el("rect", { x: 886, y: 456, width: 0, height: 46, rx: 23, fill: "url(#sci-gen-bar)" }, s);
    const sparkle = el("text", { x: 886, y: 494, "font-size": 40, fill: "#fff8c0" }, s);
    sparkle.textContent = "✦";
    const needleSpring = new Spring(0, 0, 90, 7);
    let spin = 0; // the magnet's angular velocity (rad/s): it spins on after a flick, like a flywheel
    let dragging = false;
    let lastAngle = 0;
    let dragTurn = 0;
    let flicker = 0;
    let shown = -1;
    const draw = () => {
      const st = state.s;
      labelText.textContent = t(`만든 전기 ${Math.round(st.charge * 100)}%`, `Made ${Math.round(st.charge * 100)}%`);
      fill.setAttribute("width", String(Math.max(0, 448 * st.charge)));
      sparkle.setAttribute("x", String(870 + 448 * st.charge));
      sparkle.style.display = st.charge > 0.02 ? "" : "none";
      hintArc.style.display = st.charge > 0.06 ? "none" : "";
      this.chip(`${Math.round(st.charge * 100)}%`, Math.round(st.charge * 4), 4);
      if (!this.finishing) {
        this.sub(st.meter > 0.15
          ? t("⚡ 전기가 흘러요! 바늘이 올라가고 전구가 켜졌어요 — 계속 돌려요", "⚡ Current! The needle rises and the bulb lights — keep turning")
          : st.charge > 0.05 ? t("멈추면 바늘이 0으로 — 다시 빙글빙글 돌려요!", "Stopped: the needle is back at 0 — spin it again!")
          : t("자석을 잡고 빙글빙글 돌려요 (휙 돌리면 계속 돌아요)", "Grab the magnet and spin it (flick it and it keeps going)"));
      }
      this.hint(st.charge < 0.06 ? [C.x + 120, C.y - 60, C.x + 60, C.y + 120] : null);
    };
    this.redraw = draw;
    const angleOf = (e: PointerEvent) => {
      const p = this.svgPoint(e);
      return Math.atan2(p.y - C.y, p.x - C.x);
    };
    this.dragOn("pointerdown", (e) => {
      const p = this.svgPoint(e);
      if (Math.hypot(p.x - C.x, p.y - C.y) > 260 || this.finishing) return;
      dragging = true;
      lastAngle = angleOf(e);
      s.setPointerCapture(e.pointerId);
    });
    this.dragOn("pointermove", (e) => {
      if (!dragging) return;
      const a2 = angleOf(e);
      let d = a2 - lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      lastAngle = a2;
      dragTurn += d;
    });
    const end = () => (dragging = false);
    this.dragOn("pointerup", end);
    this.tick = (dt) => {
      if (dragging) spin = spin * 0.6 + (dragTurn / Math.max(dt, 1 / 120)) * 0.4; // the hand drives it
      else spin *= Math.exp(-1.1 * dt); // friction slows a free magnet
      const turned = dragging ? dragTurn : spin * dt;
      dragTurn = 0;
      if (!this.finishing) {
        if (Math.abs(turned) > 2e-3) state.s = generator.turn(state.s, turned, Math.max(dt, 1 / 120));
        else state.s = generator.idle(state.s, dt);
      } else state.s = { ...state.s, angle: state.s.angle + spin * dt };
      const st = state.s;
      const deg = (st.angle * 180) / Math.PI;
      magnet.setAttribute("transform", `rotate(${deg.toFixed(1)} ${C.x} ${C.y})`);
      const speed = Math.min(1, Math.abs(spin) / 14);
      ghosts.forEach((gh, i) => {
        gh.setAttribute("transform", `rotate(${(deg - Math.sign(spin) * (i + 1) * 9 * speed).toFixed(1)} ${C.x} ${C.y})`);
        gh.setAttribute("opacity", (ghostOp[i]! * speed).toFixed(2));
      });
      field.setAttribute("opacity", (st.meter * 0.8).toFixed(2));
      field.setAttribute("transform", `rotate(${deg.toFixed(1)} ${C.x} ${C.y})`);
      coilGlow.setAttribute("opacity", (st.meter * 0.55).toFixed(2));
      needleSpring.target = st.meter;
      const nv = Math.max(-0.05, Math.min(1.08, needleSpring.update(dt)));
      const a = Math.PI - nv * Math.PI * 0.92;
      needle.setAttribute("x2", (P.x + Math.cos(a) * 130).toFixed(1));
      needle.setAttribute("y2", (P.y - Math.sin(a) * 130).toFixed(1));
      flicker += dt * 30;
      const lit = st.meter < 0.35 ? st.meter * (0.6 + 0.4 * Math.sin(flicker)) : st.meter;
      on.setAttribute("opacity", Math.min(1, lit * 1.5).toFixed(2));
      glow.setAttribute("opacity", (lit * 0.5).toFixed(2));
      rays.setAttribute("opacity", Math.max(0, (lit - 0.5) * 2).toFixed(2));
      rays.setAttribute("transform", `rotate(${((performance.now() / 40) % 360).toFixed(1)} ${BULB.x + 60} ${BULB.y + 80})`);
      electrons.update(dt, st.meter * 1.6);
      if (st.meter > 0.6 && Math.random() < dt * 8) this.particles?.burst(C.x + (Math.random() - 0.5) * 380, C.y + (Math.random() - 0.5) * 380, { count: 1, colours: ["#fff27a"], speed: [20, 60], gravity: -40, life: [0.4, 0.7], size: [3, 6] });
      const pct = Math.round(st.charge * 100);
      if (pct !== shown) {
        shown = pct;
        draw();
      }
      this.checkDone();
    };
    draw();
  }

  // ------------------------------------------------------------ wiring

  private buildWiring(): void {
    const state = { kind: "wiring" as const, s: startWiring() };
    this.g = state;
    const s = this.svg;
    s.setAttribute("viewBox", "0 0 1400 700");
    img(s, "w-scene", 0, 0, 1400, 700, { preserveAspectRatio: "none" });
    const defs = el("defs", {}, s);
    el("feGaussianBlur", { stdDeviation: 7 }, el("filter", { id: "sci-w-blur", x: "-20%", y: "-50%", width: "140%", height: "200%" }, defs));
    el("feGaussianBlur", { stdDeviation: 18 }, el("filter", { id: "sci-w-halo", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs));
    // the cabinet door's HINGES: the painted door met the cabinet at a bare seam, so it read as a
    // loose panel. Two chunky clay knuckles (lit from the upper left like the art, no outlines) on
    // the seam at x 1246, near the door's top and bottom.
    const hingeGrad = el("linearGradient", { id: "sci-w-hinge", x1: "0", y1: "0", x2: "1", y2: "0" }, defs);
    for (const [o, c] of [[0, "#b4c3ec"], [0.35, "#8197d2"], [0.78, "#5169a9"], [1, "#3f5391"]] as const) el("stop", { offset: o, "stop-color": c }, hingeGrad);
    el("feGaussianBlur", { stdDeviation: 3 }, el("filter", { id: "sci-w-soft", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs));
    for (const hy of [168, 498]) {
      const h = el("g", { transform: `translate(1246 ${hy})`, "pointer-events": "none" }, s);
      el("rect", { x: -10, y: -29, width: 24, height: 64, rx: 12, fill: "#1d2650", opacity: 0.3, filter: "url(#sci-w-soft)" }, h);
      el("rect", { x: -12, y: -32, width: 24, height: 64, rx: 12, fill: "url(#sci-w-hinge)" }, h);
      el("rect", { x: -12, y: -1.5, width: 24, height: 3, fill: "#34457c", opacity: 0.45 }, h);
      el("rect", { x: -7, y: -27, width: 4, height: 22, rx: 2, fill: "#ffffff", opacity: 0.35 }, h);
      el("rect", { x: -7, y: 5, width: 4, height: 22, rx: 2, fill: "#ffffff", opacity: 0.3 }, h);
      el("ellipse", { cx: 0, cy: -32, rx: 6.5, ry: 3.2, fill: "#d3dcf5" }, h);
      el("ellipse", { cx: 0, cy: 32, rx: 6.5, ry: 3.2, fill: "#6a80bd" }, h);
    }
    const SOCKETS = [{ x: 478, y: 268 }, { x: 478, y: 354 }, { x: 478, y: 440 }];
    const MOUNTS = [{ x: 1124, y: 186 }, { x: 1124, y: 330 }, { x: 1124, y: 476 }];
    const COLOUR: Record<WireColour, { base: string; plug: string }> = {
      red: { base: "#e0564f", plug: "w-plug-red" },
      black: { base: "#3d4150", plug: "w-plug-black" },
      earth: { base: "#3fae4a", plug: "w-plug-earth" },
    };
    // the cabinet's sockets are JACKS drawn in the SAME strict side view as the plugs, the barrel's
    // open end to the left: a plug's collar slides into the barrel and disappears exactly at its rim.
    // (A first set was turned toward the viewer with the hole showing; against the side-on plug that
    // always read as the plug tucked BEHIND the socket.) cy: the barrel's centre line, measured.
    const JACK: Record<Terminal, { art: string; aspect: number; cy: number }> = {
      plus: { art: "w-jack-plus", aspect: 512 / 291, cy: 0.505 },
      minus: { art: "w-jack-minus", aspect: 512 / 307, cy: 0.502 },
      ground: { art: "w-jack-ground", aspect: 512 / 264, cy: 0.5 },
    };
    const JW = 186;
    const JX = 1018; // the flange clears the cabinet's inner wall (x ≈ 1221)
    /** The barrel's rim: where a plug going in disappears (just inside the rounded left edge). */
    const RIM = JX + 5;
    const termAt = new Map<Terminal, { x: number; y: number }>();
    const termGlow = new Map<Terminal, SVGEllipseElement>();
    const termImg = new Map<Terminal, SVGImageElement>();
    const termH = new Map<Terminal, number>();
    state.s.terminals.forEach((term, i) => {
      const j = JACK[term];
      const jh = JW / j.aspect;
      const mouth = { x: RIM, y: MOUNTS[i]!.y };
      termAt.set(term, mouth);
      termH.set(term, jh);
      termGlow.set(term, el("ellipse", { cx: JX + JW * 0.5, cy: mouth.y, rx: JW * 0.55, ry: jh * 0.55, fill: "#8affb8", opacity: 0, filter: "url(#sci-w-halo)" }, s));
      termImg.set(term, img(s, j.art, JX, mouth.y - j.cy * jh, JW, jh));
    });
    // the motor's own sockets: a lamp beside each that lights when its wire is home
    const lamps = new Map<WireColour, SVGCircleElement>();
    const cableLayer = el("g", {}, s);
    const flowLayer = el("g", { "pointer-events": "none" }, s);
    const plugsLayer = el("g", {}, s);
    // where a plug meets the rim: a soft contact shadow on the plug, so the joint has depth
    const lips = new Map<Terminal, SVGGElement>();
    const lipLayer = el("g", { "pointer-events": "none" }, s);
    state.s.terminals.forEach((term) => {
      const m = termAt.get(term)!;
      const lip = el("g", {}, lipLayer);
      el("ellipse", { cx: RIM - 3, cy: m.y, rx: 7, ry: 27, fill: "#10142a", opacity: 0.32, filter: "url(#sci-w-blur)" }, lip);
      lip.style.display = "none";
      lips.set(term, lip);
    });
    const badges = el("g", { "pointer-events": "none" }, s);
    const PLUG = { w: 190, h: 76 };
    // each plug is drawn at its art's own proportions, so its back (where the cable goes in) is
    // where the picture really is: a fixed box left the earth plug's cable on a thin stub in the air
    const PLUG_ART: Record<WireColour, { h: number; aspect: number }> = {
      red: { h: 76, aspect: 512 / 218 },
      black: { h: 78, aspect: 512 / 206 },
      earth: { h: 84, aspect: 512 / 292 },
    };
    /** The collar's front face, as a fraction of the plug art's width (the pin is the rest). */
    const COLLAR = 0.78;
    /** A plug in a jack is drawn a little smaller, so its collar fits the hole. */
    const SEAT = 0.8;
    const plugW = (w: WireColour) => PLUG_ART[w].h * PLUG_ART[w].aspect;
    /** Where the cable meets the plug: tucked a little under its back, turned with the plug (which
     *  turns about its own middle, like a thing held in the hand). */
    const tail = (w: WireColour, c: { pos: { x: number; y: number }; seat: number; tilt: number }) => {
      const pw = plugW(w) * c.seat;
      const a = (c.tilt * Math.PI) / 180;
      const rx = -(plugW(w) - 16) * c.seat + pw / 2; // relative to the pivot
      return { x: c.pos.x - pw / 2 + Math.cos(a) * rx, y: c.pos.y + Math.sin(a) * rx };
    };
    const rest = (w: WireColour) => {
      const sock = SOCKETS[state.s.wires.indexOf(w)]!;
      return { x: sock.x + 330, y: sock.y };
    };
    interface Cable { pos: { x: number; y: number }; rope: Rope; base: SVGPathElement; stripe: SVGPathElement | null; shine: SVGPathElement; glow: SVGPathElement; node: SVGGElement; clip: SVGRectElement; flow: Flow; tilt: number; lastX: number; push: number; live: number; mouthX: number | null; seat: number; grab: { x: number; y: number } }
    const cables = new Map<WireColour, Cable>();
    for (const w of state.s.wires) {
      const sock = SOCKETS[state.s.wires.indexOf(w)]!;
      const r = rest(w);
      // the glow under the cable: an energy front that runs motor -> terminal when it connects
      const glow = el("path", { fill: "none", stroke: "#fff27a", "stroke-width": 46, "stroke-linecap": "round", opacity: 0, filter: "url(#sci-w-blur)" }, cableLayer);
      const base = el("path", { fill: "none", stroke: COLOUR[w].base, "stroke-width": 28, "stroke-linecap": "round" }, cableLayer);
      const stripe = w === "earth" ? el("path", { fill: "none", stroke: "#ffd23a", "stroke-width": 28, "stroke-dasharray": "20 26" }, cableLayer) : null;
      const shine = el("path", { fill: "none", stroke: "rgba(255,255,255,0.35)", "stroke-width": 7, "stroke-linecap": "round", transform: "translate(-2 -8)" }, cableLayer);
      const node = el("g", { class: "drag", "data-wire": w }, plugsLayer);
      const pw = plugW(w);
      // the pin is clipped at the jack's mouth while it goes in, so it disappears INTO the socket
      const clipPath = el("clipPath", { id: `sci-w-clip-${w}`, clipPathUnits: "userSpaceOnUse" }, defs);
      const clip = el("rect", { x: -600, y: -300, width: 2000, height: 600 }, clipPath);
      img(el("g", { "clip-path": `url(#sci-w-clip-${w})` }, node), COLOUR[w].plug, -pw, -PLUG_ART[w].h / 2, pw, PLUG_ART[w].h);
      el("rect", { x: -PLUG.w - 10, y: -PLUG.h, width: PLUG.w + 30, height: PLUG.h * 2, fill: "transparent" }, node);
      lamps.set(w, el("circle", { cx: sock.x - 8, cy: sock.y - 46, r: 9, fill: "#55606e", stroke: "#ffffff", "stroke-width": 3, opacity: 0.9 }, s));
      cables.set(w, { pos: { ...r }, rope: new Rope(24, sock.x, sock.y, r.x - pw + 16, r.y, 1.05, 1600, 0.35), base, stripe, shine, glow, node, clip, flow: new Flow(flowLayer, base, 5, "#fff27a", 7), tilt: 0, lastX: r.x, push: 0, live: 0, mouthX: null, seat: 1, grab: { x: 0, y: 0 } });
    }
    const draw = () => {
      const n = Object.keys(state.s.connected).length;
      this.chip(`${n} / 3`, n, 3);
      const next = state.s.wires.find((w) => !state.s.connected[w]);
      if (next) {
        const p = cables.get(next)!.pos;
        const tm = termAt.get(WIRE_TO[next])!;
        this.hint([p.x - 60, p.y, tm.x - 30, tm.y]);
      } else this.hint(null);
    };
    this.redraw = draw;
    let dragging: WireColour | null = null;
    for (const [w, c] of cables) {
      c.node.addEventListener("pointerdown", (e) => {
        if (state.s.connected[w] || this.finishing) return;
        dragging = w;
        const p = this.svgPoint(e);
        c.grab = { x: c.pos.x - p.x, y: c.pos.y - p.y }; // held where it was grabbed: no jump
        this.svg.setPointerCapture(e.pointerId);
        this.sound("pickup");
      });
      this.dragOn("pointermove", (e) => {
        if (dragging !== w) return;
        const p = this.svgPoint(e);
        c.pos = { x: Math.min(1360, p.x + c.grab.x), y: Math.max(40, Math.min(660, p.y + c.grab.y)) };
      });
      this.dragOn("pointerup", () => {
        if (dragging !== w) return;
        dragging = null;
        let target: Terminal | null = null;
        for (const [term, m] of termAt) if (Math.hypot(c.pos.x - m.x, c.pos.y - m.y) < 130) target = term;
        const back = () => {
          const from = { ...c.pos };
          const to = rest(w);
          this.tweens.add(0.4, (k) => {
            const e2 = ease.outBack(k);
            c.pos = { x: from.x + (to.x - from.x) * e2, y: from.y + (to.y - from.y) * e2 };
          });
        };
        if (!target) {
          back();
          return;
        }
        const res = wiring.connect(state.s, w, target);
        state.s = res.state;
        const m = termAt.get(target)!;
        if (res.result === "ok") {
          // 1) the plug lines up in front of the terminal, 2) is pushed IN (click), 3) the cable goes
          // taut and current runs down it, 4) the terminal and the motor's lamp light and stay lit
          const from = { ...c.pos };
          const tilt0 = c.tilt;
          // home: the pin and almost all of the collar inside the barrel, the coloured boot outside.
          // lineUp: level with the barrel, the pin's tip just short of the rim.
          const home = { x: m.x + 20 + (1 - COLLAR) * plugW(w) * SEAT, y: m.y };
          const lineUp = m.x - 16;
          const term = target;
          const sock = SOCKETS[state.s.wires.indexOf(w)]!;
          this.tweens.add(0.18, (k) => {
            const e2 = ease.outCubic(k);
            c.pos = { x: from.x + (lineUp - from.x) * e2, y: from.y + (home.y - from.y) * e2 };
            c.tilt = tilt0 * (1 - e2);
            c.seat = 1 + (SEAT - 1) * e2;
          }, () => {
            c.mouthX = m.x;
            lips.get(term)!.style.display = "";
            this.tweens.add(0.14, (k) => {
              c.pos = { x: lineUp + (home.x - lineUp) * ease.outBack(k), y: home.y };
              c.push = Math.sin(k * Math.PI);
            }, () => {
              c.push = 0;
              c.rope.setSlack(1.03); // snug, not drawn tight: a taut cable folds at its straight leads
              this.sound("click");
              this.shake.kick(3);
              // the jack takes the push: it gives a few pixels and springs back (it is fixed to the wall)
              const ti = termImg.get(term)!;
              this.tweens.add(0.32, (k) => {
                const dx = 5 * Math.sin(k * Math.PI) * (1 - k);
                ti.setAttribute("transform", `translate(${dx.toFixed(2)} 0)`);
              });
              const ringNode = termGlow.get(term)!;
              this.tweens.add(0.6, (k) => {
                ringNode.setAttribute("opacity", String(0.95 - 0.45 * ease.outCubic(k)));
              });
              const pop = el("text", { x: m.x - 70, y: m.y - 70, "text-anchor": "middle", "font-size": 40, "font-weight": 900, fill: "#ffffff", stroke: "#2b6b43", "stroke-width": 8, "paint-order": "stroke", opacity: 0 }, badges);
              pop.textContent = t("딸깍!", "Click!");
              this.tweens.add(0.8, (k) => {
                pop.setAttribute("opacity", String(k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.6) / 0.4)));
                pop.setAttribute("y", String(m.y - 70 - 26 * ease.outCubic(k)));
              }, () => pop.remove());
              this.particles?.burst(m.x, m.y, { count: 22, colours: ["#fff27a", "#8affb8", "#ffffff"], speed: [180, 480], gravity: 260, size: [4, 9] });
              this.tweens.add(0.55, (k) => {
                c.live = k;
              }, () => {
                const lamp = lamps.get(w)!;
                lamp.setAttribute("fill", "#5dff9a");
                lamp.setAttribute("stroke", "#eafff1");
                this.particles?.burst(sock.x - 8, sock.y - 46, { count: 10, colours: ["#5dff9a", "#ffffff"], speed: [80, 220], gravity: 0, size: [3, 6] });
              });
              const bx = JX + JW - 18;
              const by = m.y - 44;
              const badge = el("g", { transform: `translate(${bx} ${by}) scale(0)` }, badges);
              el("circle", { r: 26, fill: "#2fb463", stroke: "#ffffff", "stroke-width": 4 }, badge);
              el("path", { d: "M -11 0 L -3 9 L 13 -9", fill: "none", stroke: "#fff", "stroke-width": 7, "stroke-linecap": "round", "stroke-linejoin": "round" }, badge);
              this.tweens.add(0.35, (k) => badge.setAttribute("transform", `translate(${bx} ${by}) scale(${ease.outBack(k).toFixed(2)})`));
            });
          });
        } else if (res.result === "wrong") {
          this.root.classList.remove("zap");
          void this.root.getBoundingClientRect();
          this.root.classList.add("zap");
          this.shake.kick(16);
          this.particles?.burst(m.x - 30, m.y + 10, { count: 26, colours: ["#ff5a4a", "#fff27a", "#ffffff"], speed: [240, 640], gravity: 600, size: [3, 8] });
          this.sound("pickup");
          this.sub(t("⚡ 찌릿! 그 단자가 아니에요 — 색을 다시 봐요 (빨강 +, 검정 −, 초록·노랑 접지)", "⚡ Zap! Not that one — check the colours (red +, black −, green-yellow earth)"));
          this.tweens.add(2.2, () => {}, () => {
            if (this.g === state && !this.finishing) this.sub(META.wiring.sub());
          });
          back();
        } else back();
        draw();
        this.checkDone();
      });
    }
    this.tick = (dt) => {
      for (const [w, c] of cables) {
        const sock = SOCKETS[state.s.wires.indexOf(w)]!;
        c.lastX = c.pos.x;
        // which jack it is near (while carried): it levels out to slide in, and the jack glows faintly
        let near: Terminal | null = null;
        if (dragging === w) for (const [term, m] of termAt) if (!Object.values(state.s.connected).includes(term) && Math.hypot(c.pos.x - m.x, c.pos.y - m.y) < 130) near = term;
        for (const [term, g] of termGlow) {
          if (Object.values(state.s.connected).includes(term)) continue;
          const want = near === term ? 0.35 : 0;
          const cur = Number(g.getAttribute("opacity") ?? 0);
          g.setAttribute("opacity", (cur + (want - cur) * Math.min(1, dt * 12)).toFixed(3));
        }
        // the plug points along the cable's pull (its back follows the cable), held level near a jack
        // and while it goes in; once in, it is fixed level
        if (c.mouthX === null) {
          const dir = c.rope.endDir(5);
          let want = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
          want = Math.max(-32, Math.min(32, want));
          // resting plugs lie level (side by side, not crossing); only a carried one follows its cable
          if (near || dragging !== w) want = 0;
          c.tilt += (want - c.tilt) * Math.min(1, dt * (near ? 14 : 7));
        }
        // a seated plug squashes along its length only (pushed in), never sideways
        const sx = c.seat * (1 - 0.06 * c.push);
        const pivot = (-plugW(w) * sx) / 2;
        c.node.setAttribute("transform", `translate(${c.pos.x.toFixed(1)} ${c.pos.y.toFixed(1)}) rotate(${c.tilt.toFixed(2)} ${pivot.toFixed(1)} 0) scale(${sx.toFixed(3)} ${c.seat.toFixed(3)})`);
        // the pin and collar tip vanish at the barrel's rim (in the plug's own, scaled units)
        c.clip.setAttribute("width", c.mouthX === null ? "2000" : Math.max(0, (c.mouthX - c.pos.x) / sx + 600).toFixed(1));
        const tl = tail(w, c);
        // the cable leaves the motor's outlet straight out to the right, and the plug straight out of its back
        const a = (c.tilt * Math.PI) / 180;
        const lead = 20 * c.seat;
        c.rope.update(dt, sock.x, sock.y, tl.x, tl.y, { dx: 20, dy: 0 }, { dx: -Math.cos(a) * lead, dy: -Math.sin(a) * lead });
        const d = c.rope.d();
        c.base.setAttribute("d", d);
        c.stripe?.setAttribute("d", d);
        c.shine.setAttribute("d", d);
        if (c.live > 0) {
          // the energy front: a glow drawn from the motor end to `live` of the way, then a steady hum
          c.glow.setAttribute("d", d);
          let len = 0;
          try {
            len = c.glow.getTotalLength();
          } catch {
            len = 0;
          }
          if (len > 0) {
            c.glow.setAttribute("stroke-dasharray", `${(len * c.live).toFixed(1)} ${len.toFixed(1)}`);
            const hum = c.live >= 1 ? 0.35 + 0.12 * Math.sin(performance.now() / 260) : 0.85;
            c.glow.setAttribute("opacity", hum.toFixed(2));
          }
        }
        c.flow.update(dt, state.s.connected[w] && c.live >= 1 ? 0.9 : 0);
      }
    };
    draw();
  }

  // ------------------------------------------------------------ rotor (blade assembly)

  private buildRotor(): void {
    const state = { kind: "rotor" as const, s: rotor.start() };
    this.g = state;
    const s = this.svg;
    s.setAttribute("viewBox", "0 0 1400 583");
    img(s, "r-scene", 0, 0, 1400, 583, { preserveAspectRatio: "none" });
    for (const [y, d] of [[200, 0], [330, 1.1], [270, 2.2]] as const) el("path", { d: `M 380 ${y} q 70 -20 140 0 t 140 0`, fill: "none", stroke: "rgba(255,255,255,0.75)", "stroke-width": 5, "stroke-linecap": "round", class: "sci-g-wind", style: `animation-delay:${d}s` }, s);
    const HUB = { x: 780, y: 285, size: 330 };
    // hub art: 586×600, centre (293, 300), sockets on a 217 px circle every 60° from the top
    const scale = HUB.size / 586;
    const R = 217 * scale;
    const mountAngle = (i: number) => -Math.PI / 2 + (i * Math.PI * 2) / HUB_MOUNTS;
    const mountPos = (i: number) => ({ x: HUB.x + Math.cos(mountAngle(i)) * R, y: HUB.y + Math.sin(mountAngle(i)) * R });
    const bladeAngle = (i: number) => (mountAngle(i) * 180) / Math.PI + 90;
    // the rotor turns as one group: mounted blades, the hub, the sockets' glow and the bolts
    const rotorG = el("g", {}, s);
    const mountedLayer = el("g", {}, rotorG);
    img(rotorG, "r-hub", HUB.x - HUB.size / 2, HUB.y - 300 * scale, HUB.size, 600 * scale);
    const socketRings = el("g", { "pointer-events": "none" }, rotorG);
    const boltsLayer = el("g", {}, rotorG);
    const trayLayer = el("g", {}, s); // loose blades (outside the rotor, on top)
    const rings = Array.from({ length: HUB_MOUNTS }, (_, i) => {
      const p = mountPos(i);
      return el("circle", { cx: p.x, cy: p.y, r: 30, fill: "none", stroke: "#7dffb0", "stroke-width": 6, opacity: 0, class: "sci-g-ring" }, socketRings);
    });
    const BLADE = { len: 250, w: 40 };
    const TRAY = [{ x: 106, y: 515 }, { x: 169, y: 515 }, { x: 232, y: 515 }];
    interface Blade { node: SVGGElement; x: number; y: number; ang: number; mount: number | null; tray: number }
    const blades: Blade[] = TRAY.map((p, i) => {
      const node = el("g", { class: "drag" }, trayLayer);
      img(node, "r-blade", -BLADE.w / 2, -BLADE.len, BLADE.w, BLADE.len);
      el("rect", { x: -BLADE.w, y: -BLADE.len, width: BLADE.w * 2, height: BLADE.len + 10, fill: "transparent" }, node);
      return { node, x: p.x, y: p.y, ang: 0, mount: null, tray: i };
    });
    const bolts = new Map<number, { node: SVGGElement; spin: number }>();
    let rotorAngle = 0;
    let rotorSpeed = 0;
    let wobble = 0;
    let testing = 0;
    let settling = false;
    const draw = () => {
      const st = state.s;
      const tight = st.tight.length;
      const mounting = st.mounted.length < BLADES;
      this.chip(mounting ? `${st.mounted.length} / ${BLADES}` : `${tight} / ${BLADES}`, mounting ? st.mounted.length : tight, BLADES);
      rings.forEach((r, i) => r.setAttribute("opacity", mounting && !st.mounted.includes(i) ? "0.85" : "0"));
      if (this.finishing) return;
      const free = blades.find((b) => b.mount === null);
      if (st.test === "wobble") {
        this.sub(t("😵 덜컹덜컹! 날개가 한쪽에 몰렸어요 — 날개를 눌러 빼고, 한 칸씩 건너뛰어 달아요", "😵 Wobble! The blades are bunched up — tap one to take it off, then skip a socket between blades"));
        this.hint(null);
      } else if (mounting) {
        this.sub(t("① 날개를 끌어다 허브의 빛나는 구멍에 끼워요 (3장)", "① Drag the blades into the hub's glowing sockets (three)"));
        if (free) {
          const target = [0, 2, 4, 1, 3, 5].find((i) => !st.mounted.includes(i)) ?? 0;
          const p = mountPos(target);
          this.hint([free.x, free.y - 120, p.x, p.y]);
        }
      } else if (tight < BLADES) {
        this.sub(t("② 반짝이는 볼트를 눌러 꽉 조여요", "② Tap each shiny bolt to tighten it"));
        const loose = st.mounted.find((m) => !st.tight.includes(m));
        if (loose !== undefined) {
          const p = mountPos(loose);
          this.hint([p.x + 60, p.y - 40, p.x, p.y]);
        }
      } else {
        this.sub(t("③ 바람이 불어요 — 시험 회전!", "③ Here comes the wind — test spin!"));
        this.hint(null);
      }
    };
    this.redraw = draw;
    const busy = () => this.finishing !== 0 || testing > 0 || settling;
    const startTest = () => {
      testing = 0.0001;
      state.s = rotor.spin(state.s);
      this.sound("checkpoint");
      draw();
    };
    const addBolt = (mount: number) => {
      const p = mountPos(mount);
      const node = el("g", { class: "hit" }, boltsLayer);
      img(node, "r-bolt", -24, -24, 48, 48);
      el("circle", { r: 34, fill: "transparent" }, node);
      const bolt = { node, spin: 0 };
      bolts.set(mount, bolt);
      node.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (busy()) return;
        const res = rotor.tighten(state.s, mount);
        state.s = res.state;
        if (res.result !== "ok") return;
        this.tweens.add(0.45, (k) => (bolt.spin = 360 * ease.outCubic(k)));
        this.particles?.burst(p.x, p.y, { count: 8, colours: ["#ffffff", "#cfe3ff"], speed: [120, 260], gravity: 300, size: [3, 6] });
        this.sound("click");
        draw();
        // a short beat, then the wind (frame-driven, like everything here: timers can be throttled)
        if (rotor.ready(state.s)) this.tweens.add(0.45, () => {}, () => this.g === state && startTest());
      });
    };
    const removeBolt = (mount: number) => {
      bolts.get(mount)?.node.remove();
      bolts.delete(mount);
    };
    const nearestFree = (b: Blade) => {
      let best = -1;
      let bestD = 1e9;
      for (let i = 0; i < HUB_MOUNTS; i++) {
        if (state.s.mounted.includes(i)) continue;
        const mp = mountPos(i);
        const d = Math.hypot(b.x - mp.x, b.y - mp.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return { best, bestD };
    };
    const toTray = (b: Blade) => {
      trayLayer.appendChild(b.node);
      const from = { x: b.x, y: b.y, a: b.ang };
      const to = TRAY[b.tray]!;
      this.tweens.add(0.42, (k) => {
        const e2 = ease.outBack(k);
        b.x = from.x + (to.x - from.x) * e2;
        b.y = from.y + (to.y - from.y) * e2;
        b.ang = from.a * (1 - ease.outCubic(k));
      });
    };
    let dragging: Blade | null = null;
    for (const b of blades) {
      b.node.addEventListener("pointerdown", (e) => {
        if (busy()) return;
        if (b.mount !== null) {
          // a mounted blade comes off with a tap (its bolt too) and flies back to the tray
          state.s = rotor.detach(state.s, b.mount);
          removeBolt(b.mount);
          b.mount = null;
          toTray(b);
          this.sound("pickup");
          draw();
          return;
        }
        // (it is already on the tray layer: moving the node now would drop the pointer capture)
        dragging = b;
        this.svg.setPointerCapture(e.pointerId);
        this.sound("pickup");
      });
      this.dragOn("pointermove", (e) => {
        if (dragging !== b) return;
        const p = this.svgPoint(e);
        b.x = p.x;
        b.y = p.y + BLADE.len * 0.45;
        // near the hub it turns to face out from the nearest free socket
        const { best, bestD } = nearestFree(b);
        const want = best >= 0 && bestD < 260 ? bladeAngle(best) : 0;
        let diff = want - b.ang;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        b.ang += diff * 0.25;
      });
      this.dragOn("pointerup", () => {
        if (dragging !== b) return;
        dragging = null;
        const { best, bestD } = nearestFree(b);
        const res = best >= 0 && bestD < 130 ? rotor.attach(state.s, best) : null;
        if (res && res.result === "ok") {
          state.s = res.state;
          b.mount = best;
          mountedLayer.appendChild(b.node);
          const from = { x: b.x, y: b.y, a: b.ang };
          const target = mountPos(best);
          let ta = bladeAngle(best);
          while (ta - from.a > 180) ta -= 360;
          while (ta - from.a < -180) ta += 360;
          this.tweens.add(0.22, (k) => {
            const e2 = ease.outBack(k);
            b.x = from.x + (target.x - from.x) * e2;
            b.y = from.y + (target.y - from.y) * e2;
            b.ang = from.a + (ta - from.a) * e2;
          });
          addBolt(best);
          this.particles?.burst(target.x, target.y, { count: 10, colours: ["#ffffff", "#7dffb0"], speed: [120, 300], gravity: 200, size: [3, 7] });
          this.sound("place");
        } else toTray(b);
        draw();
      });
    }
    this.tick = (dt) => {
      if (testing > 0) {
        testing += dt;
        const smooth = state.s.test === "smooth";
        rotorSpeed = Math.min(smooth ? 9 : 6, rotorSpeed + dt * 7);
        if (!smooth) wobble = Math.min(1, wobble + dt * 2);
        if (smooth && Math.random() < dt * 14) this.particles?.burst(380 + Math.random() * 100, 150 + Math.random() * 300, { count: 1, colours: ["#ffffff"], speed: [500, 700], angle: 0, spread: 0.2, gravity: 0, life: [0.5, 0.8], size: [3, 5] });
        if (!smooth && testing > 2.2) {
          // the wobble test ends: the rotor eases back to rest so the child can fix it
          testing = 0;
          settling = true;
          const from = rotorAngle;
          const target = Math.ceil(from / (Math.PI * 2)) * Math.PI * 2; // the next full turn
          rotorSpeed = 0;
          this.tweens.add(0.8, (k) => (rotorAngle = from + (target - from) * ease.outCubic(k)), () => {
            rotorAngle = 0;
            settling = false;
            draw();
          });
        }
        if (smooth && testing > 1.1) this.checkDone();
      } else {
        rotorSpeed *= Math.exp(-2.5 * dt);
        wobble *= Math.exp(-3 * dt);
      }
      if (testing > 0 || state.s.test === "smooth") rotorAngle += rotorSpeed * dt;
      const now = performance.now();
      const wx = Math.sin(now / 45) * 14 * wobble;
      const wy = Math.cos(now / 38) * 10 * wobble;
      rotorG.setAttribute("transform", `translate(${wx.toFixed(1)} ${wy.toFixed(1)}) rotate(${((rotorAngle * 180) / Math.PI).toFixed(1)} ${HUB.x} ${HUB.y})`);
      if (wobble > 0.3) this.shake.kick(wobble * 6);
      for (const b of blades) b.node.setAttribute("transform", `translate(${b.x.toFixed(1)} ${b.y.toFixed(1)}) rotate(${b.ang.toFixed(1)})`);
      for (const [m, bolt] of bolts) {
        const p = mountPos(m);
        const tight = state.s.tight.includes(m);
        const pulse = tight ? 1 : 1 + Math.sin(now / 160) * 0.12;
        bolt.node.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${bolt.spin.toFixed(1)}) scale(${pulse.toFixed(2)})`);
      }
    };
    draw();
  }
}
