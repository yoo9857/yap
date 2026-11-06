/**
 * Science mode (T): the layer where power plants are planned, built and watched.
 *
 * In science mode a right click lays a plant's BLUEPRINT on the ground; R turns it, X takes it back
 * up. Every cell of the blueprint is an ITEM SOCKET (a hologram box): the FRAME (뼈대) goes in from
 * the underbody up, one layer at a time — foundation, tower, nacelle — and then the working PARTS.
 * Holding the socket's item and right-clicking fits it; a middle click on a socket puts its item in
 * hand. With every socket filled, a right click on the plant switches it on and the rotor turns.
 * Every site carries a floating label (state, frame %, what comes next). The rules live in
 * plants.ts; this class is the glue.
 *
 * Coordinates: sites are ABSOLUTE (like furniture and field edits); the scene is GRID. The host's
 * originX/Z (0 on the island) is the only conversion, and it happens here.
 */
import * as THREE from "three";
import { isWater } from "@robo/shared";
import type { RayHit, VoxelWorld } from "../voxelWorld.js";
import { t, isEnglish } from "../../ui/i18n.js";
import {
  BLUEPRINTS,
  MAX_PLANTS,
  fitItem,
  isFilled,
  loadPlants,
  missingParts,
  plantProgress,
  plantStatus,
  savePlants,
  siteProblem,
  siteSockets,
  socketOpen,
  takeOut,
  type PlantKind,
  type PlantSite,
  type PlantStatus,
  type PlantTuple,
  type Progress,
  type SiteProblem,
  type SiteSocket,
  type SocketItem,
} from "./plants.js";
import { PARTS, isPartKey, type PartKey } from "./parts.js";
import { FRAMES, isFrameKey } from "./frames.js";
import { MODEL_KEYS, disposeItemAssets, itemModel, itemModelSource, loadItemModels } from "./itemModels.js";
import { PlantEffects } from "./plantEffects.js";
import { StatusBoard, type BoardPlant } from "./statusBoard.js";
import { villagePower } from "./energy.js";
import { MiniGame } from "./miniGame.js";
import { MINI_GAMES } from "./miniGameRules.js";
import "./science.css";

export interface ScienceHost {
  scene: THREE.Scene;
  world: VoxelWorld;
  /** Absolute coordinates of grid cell (0, 0); 0 on the island. */
  originX(): number;
  originZ(): number;
  /** The block id an ABSOLUTE cell holds now (inside or outside the live window). */
  blockAt(x: number, y: number, z: number): number;
  /** Whether the player's body overlaps a GRID cell. */
  playerIn(x: number, y: number, z: number): boolean;
  /** Whether solid furniture stands in a GRID cell. */
  furnitureIn(x: number, y: number, z: number): boolean;
  /** The look ray in GRID coordinates (eye, unit direction) and its reach. */
  ray(): { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; reach: number };
  /** The item in hand ("" for none / empty hands). */
  heldKey(): string;
  /** Spend one of an item (the field never runs out); false when there is none. `check` only
   *  asks, spending nothing. */
  takeItem(key: string, check?: boolean): boolean;
  /** Return items to the bag (a taken-back blueprint gives its pieces back). */
  giveItem(key: string, n: number): void;
  /** Put an item in hand (a right click on a socket while holding something else). */
  holdItem(key: string): void;
  toast(text: string): void;
  sound(name: "place" | "pickup" | "click" | "clear" | "checkpoint"): void;
  /** Mode switched (the game drops held clicks, hides its block ghost…). */
  changed(active: boolean): void;
  /** A panel of ours opened: free the mouse and close the game's other panels. */
  openPanel(): void;
  /** Our panel closed: capture the mouse again (from a click or key: a user gesture). */
  resumePlay(): void;
  /** Filled sockets became solid or stopped being solid: physics and rays must look again. */
  solidsChanged(): void;
}

const isEmptyId = (id: number): boolean => id === 0 || isWater(id);

/** Hologram colours (multiplied into the white grid texture per instance). */
const FRAME_WAIT = new THREE.Color(0x2c78c0);
const FRAME_OPEN = new THREE.Color(0x7fe3ff);
const PART_WAIT = new THREE.Color(0x8a6a1e);
const PART_OPEN = new THREE.Color(0xffc93a);
const AIMED = new THREE.Color(0xfff6c8);
const BLOCKED = new THREE.Color(0xff5a5a);
const PREVIEW_OK = new THREE.Color(0x7cf09a);
const PREVIEW_BAD = new THREE.Color(0xff6a5a);
/** Seconds the "scan" takes to sweep a new blueprint from the ground up. */
const SCAN_TIME = 0.7;
/** Labels farther than this (m) are hidden: a field of distant plates is noise. */
const LABEL_RANGE = 70;
/** Rotor speed while running (rad/s). */
const ROTOR_SPEED = 2.4;
/** Top layer of a blueprint, for the scan sweep. */
const TOP_LAYER = 8;

/** A white cell outline over a faint fill: the hologram look, tinted per instance. */
function hologramTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,255,255,0.26)";
  g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(255,255,255,1)";
  g.lineWidth = 6;
  g.strokeRect(2.5, 2.5, s - 5, s - 5);
  g.strokeStyle = "rgba(255,255,255,0.32)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(s / 2, 8);
  g.lineTo(s / 2, s - 8);
  g.moveTo(8, s / 2);
  g.lineTo(s - 8, s / 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

interface SiteRuntime {
  site: PlantSite;
  progress: Progress;
  status: PlantStatus;
  /** performance.now() / 1000 when laid (drives the scan sweep); 0 = loaded, no sweep. */
  born: number;
  label: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  labelKey: string;
  /** Fitted item models by socket index. */
  models: Map<number, THREE.Group>;
  /** The site's sockets, absolute — a site never moves, so they are computed once. */
  sockets: SiteSocket[];
  /** "x,y,z" → socket (aim lookups). */
  at: Map<string, SiteSocket>;
  /** See-through copies of the item each OPEN socket wants: kids see what goes where. */
  ghosts: Map<number, THREE.Group>;
}

const STATUS_TEXT: Record<PlantStatus, () => string> = {
  building: () => t("건설 중", "Building"),
  parts: () => t("부품 대기", "Needs parts"),
  ready: () => t("가동 준비", "Ready"),
  running: () => t("가동 중", "Running"),
  inspection: () => t("점검 중", "Check"),
};
const STATUS_COLOR: Record<PlantStatus, string> = {
  building: "#3d8fe0",
  parts: "#f0a020",
  ready: "#1fb5a8",
  running: "#3fbf6a",
  inspection: "#e8664f",
};

const PROBLEM_TEXT = (p: Exclude<SiteProblem, null>): string =>
  ({
    outside: t("여기는 설계도가 다 들어가지 않아요", "The blueprint doesn't fit here"),
    blocked: t("막힌 칸이 있어요 — 빈 땅을 골라요", "Something is in the way — pick open ground"),
    ground: t("평평한 땅 위에 펼쳐요", "Lay it on flat ground"),
    overlap: t("다른 설계도와 겹쳐요", "It overlaps another blueprint"),
    player: t("로봇이나 가구가 설계도 안에 있어요 — 비켜 주세요", "You or a piece of furniture is inside it — clear the spot"),
  })[p];

/** An item's display name (frame piece or part). */
export function itemLabel(key: SocketItem): string {
  const def = isPartKey(key) ? PARTS[key] : FRAMES[key];
  return isEnglish() ? def.name : def.ko;
}
/** Kept for callers that only deal with parts. */
export const partLabel = (key: PartKey): string => itemLabel(key);

/** Korean object particle (기초 블록을 / 허브를). */
function obj(key: SocketItem): string {
  const name = itemLabel(key);
  if (isEnglish()) return name;
  const last = name.charCodeAt(name.length - 1) - 0xac00;
  return name + (last >= 0 && last < 11172 && last % 28 !== 0 ? "을" : "를");
}

function itemNote(key: SocketItem): string {
  const def = isPartKey(key) ? PARTS[key] : FRAMES[key];
  return isEnglish() ? def.noteEn : def.note;
}

const LAYER_NAME = (dy: number): string =>
  dy === 0 ? t("기초", "foundation") : dy <= 6 ? t("탑", "tower") : t("머리(나셀)", "head (nacelle)");

/** Item icons for the floating labels, decoded once; labels waiting for one redraw when it lands. */
const ICONS = new Map<string, HTMLImageElement>();
const WAITING = new Map<string, Set<{ labelKey: string }>>();
function itemIcon(key: SocketItem, waiter: { labelKey: string }): HTMLImageElement | null {
  let img = ICONS.get(key);
  if (!img) {
    const fresh = new Image();
    fresh.decoding = "async";
    fresh.addEventListener("load", () => {
      for (const w of WAITING.get(key) ?? []) w.labelKey = "";
      WAITING.delete(key);
    });
    fresh.src = isPartKey(key) ? PARTS[key].icon : FRAMES[key].icon;
    ICONS.set(key, fresh);
    img = fresh;
  }
  if (img.complete && img.naturalWidth > 0) return img;
  let set = WAITING.get(key);
  if (!set) WAITING.set(key, (set = new Set()));
  set.add(waiter);
  return null;
}

/** A packed ABSOLUTE cell key for the solid-cell set (|x|,|z| < 32768, 0 ≤ y < 256). */
const cellKey = (x: number, y: number, z: number): number => ((x + 32768) * 65536 + (z + 32768)) * 256 + y;

export class ScienceMode {
  private on = false;
  private kind: PlantKind = "wind";
  private rot = 0;
  private readonly sites: SiteRuntime[] = [];
  private nextId = 1;
  private readonly texture = hologramTexture();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly holoMat: THREE.MeshBasicMaterial;
  private readonly previewMat: THREE.MeshBasicMaterial;
  private readonly holo: THREE.InstancedMesh;
  private readonly preview: THREE.InstancedMesh;
  private holoDirty = true;
  private lastOrigin = "";
  private scanning = false;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly tint = new THREE.Color();
  /** The last preview: where a right click would lay the blueprint, and why not if it can't. */
  private plan: { site: PlantSite; problem: SiteProblem } | null = null;
  private lastPlan: { site: PlantSite; problem: SiteProblem } | null = null;
  private previewKey = "";
  private previewAge = 0;
  private aimed: SiteRuntime | null = null;
  /** The empty socket under the crosshair (nearest along the look ray), if any. */
  private aimedSocket: { r: SiteRuntime; socket: SiteSocket } | null = null;
  private readonly bar: HTMLElement;
  private readonly tintEl: HTMLElement;
  private readonly taskEl: HTMLElement;
  private lastTask = "";
  private lastFrame = 0;
  private peeking = false;
  /** Bumped on every change worth saving: the game's save signature includes it. */
  private ver = 0;
  private readonly effects: PlantEffects;
  private readonly board: StatusBoard;
  /** The fitting mini-game window (grounding · generator · wiring). */
  private readonly game: MiniGame;
  private readonly arrow: HTMLElement;
  private readonly proj = new THREE.Vector3();
  private disposed = false;
  private lightTimer = 0;
  /** Boot warm-up: hidden copies of every science shader (see setWarm). */
  private warmGroup: THREE.Group | null = null;
  /** Open socket instances that pulse (index in `holo`, cell, kind), rewritten without a rebuild. */
  private readonly pulsing: Array<{ i: number; x: number; y: number; z: number; part: boolean }> = [];
  /** ABSOLUTE cells holding a fitted item (physics, rays and block placement treat them as solid). */
  private readonly solid = new Set<number>();
  /** Items whose science note was already shown this session (the first fit tells the story). */
  private readonly told = new Set<SocketItem>();
  /** The see-through look of the item an open socket wants (frames cyan, parts gold, aimed bright). */
  private readonly ghostFrame = new THREE.MeshBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
  private readonly ghostPart = new THREE.MeshBasicMaterial({ color: 0xffd25a, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
  private readonly ghostAimed = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
  /** The site the last right click built on: holding the button keeps building it. */
  private holdSite: SiteRuntime | null = null;

  constructor(private readonly host: ScienceHost) {
    const maxCells = Math.max(...Object.values(BLUEPRINTS).map((b) => b.sockets.reduce((n, x) => n + (x.size ? x.size[0] * x.size[1] * x.size[2] : 1), 0)));
    const common = { map: this.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false } as const;
    this.holoMat = new THREE.MeshBasicMaterial({ ...common, opacity: 0.4 });
    this.previewMat = new THREE.MeshBasicMaterial({ ...common, opacity: 0.75 });
    this.holo = new THREE.InstancedMesh(this.box, this.holoMat, MAX_PLANTS * maxCells);
    this.holo.count = 0;
    this.holo.frustumCulled = false;
    this.holo.renderOrder = 2;
    this.holo.setColorAt(0, FRAME_WAIT);
    this.preview = new THREE.InstancedMesh(this.box, this.previewMat, maxCells);
    this.preview.count = 0;
    this.preview.frustumCulled = false;
    this.preview.renderOrder = 3;
    this.preview.setColorAt(0, PREVIEW_OK);
    this.preview.visible = false;
    this.holo.raycast = () => {};
    this.preview.raycast = () => {};
    host.scene.add(this.holo, this.preview);

    this.tintEl = document.createElement("div");
    this.tintEl.className = "sci-tint";
    this.bar = document.createElement("div");
    this.bar.className = "sci-bar";
    this.bar.innerHTML = `
      <div class="sci-pill"><span class="sci-dot"></span>${t("과학 모드", "Science mode")}<kbd>T</kbd><span class="sci-pill-quiet">${t("나가기", "exit")}</span></div>
      <div class="sci-task"><b>${t("지금 할 일", "Next")}</b><span data-id="task"></span></div>
      <div class="sci-keys"><span><kbd>${t("오른쪽 클릭", "Right click")}</kbd>${t("펼치기 · 끼우기 (꾹: 계속) · 가동", "Lay · fit (hold: keep going) · switch on")}</span><span><kbd>${t("왼쪽 꾹", "Hold left")}</kbd>${t("빼기", "Take out")}</span><span><kbd>R</kbd>${t("돌리기", "Turn")}</span><span><kbd>X</kbd>${t("걷기", "Take back")}</span><span><kbd>Tab</kbd>${t("현황판", "Status")}</span></div>`;
    this.taskEl = this.bar.querySelector<HTMLElement>('[data-id="task"]')!;
    this.arrow = document.createElement("div");
    this.arrow.className = "sci-arrow";
    document.body.append(this.tintEl, this.bar, this.arrow);
    this.effects = new PlantEffects(host.scene);
    this.game = new MiniGame(document.body, (name) => this.host.sound(name));
    this.board = new StatusBoard(document.body, {
      pick: (id) => this.pick(id),
      close: () => this.closeBoard(true),
    });
    // the Blender models stream in; fitted items swap from the built-in stand-ins when they land
    void loadItemModels().then(() => {
      if (this.disposed) return;
      for (const r of this.sites) {
        for (const m of [...r.models.values(), ...r.ghosts.values()]) this.host.scene.remove(m);
        r.models.clear();
        r.ghosts.clear();
        this.syncModels(r);
      }
    });
  }

  get active(): boolean {
    return this.on;
  }

  get version(): number {
    return this.ver;
  }

  setActive(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    document.body.classList.toggle("sci-on", on);
    this.holoMat.opacity = on ? 0.62 : 0.4;
    this.preview.visible = false;
    this.host.sound("click");
    this.host.changed(on);
  }

  toggle(): void {
    this.setActive(!this.on);
  }

  get boardOpen(): boolean {
    return this.board.open;
  }

  /** A panel of ours owns the screen (the status board or a mini-game). */
  get panelOpen(): boolean {
    return this.board.open || this.game.isOpen;
  }

  /** Play resumed with a panel up (the mouse was captured again): close them, nothing is fitted. */
  closePanels(): void {
    this.closeBoard(false);
    this.game.close(false);
  }

  /** Dev / E2E: the open mini-game and a way to finish it through its own rules. */
  gameState(): { open: boolean; kind: string | null; loading: boolean } {
    return { open: this.game.isOpen, kind: this.game.current, loading: this.game.loading };
  }

  solveGame(): void {
    this.game.solve();
  }

  /** Tab: the status board (any mode). Opening frees the mouse; closing captures it again. */
  toggleBoard(): void {
    if (this.game.isOpen) return; // a mini-game owns the screen
    if (this.board.open) this.closeBoard(true);
    else {
      this.board.setOpen(true);
      this.board.update(this.boardPlants(), this.village());
      this.host.openPanel();
      this.host.sound("click");
    }
  }

  closeBoard(resume: boolean): void {
    if (!this.board.open) return;
    this.board.setOpen(false);
    if (resume) this.host.resumePlay();
  }

  /** A card was clicked: close the board and light a beacon over that plant. */
  pick(id: number): void {
    const r = this.sites.find((x) => x.site.id === id);
    this.closeBoard(true);
    if (!r) return;
    const ox = this.host.originX();
    const oz = this.host.originZ();
    this.effects.showBeacon(id, r.site.x - ox, r.site.y, r.site.z - oz);
    const bp = BLUEPRINTS[r.site.kind];
    const dist = Math.round(this.distanceTo(r));
    this.host.toast(t(`📍 ${bp.ko} #${id} — 노란 빛기둥을 따라가요 (${dist} m)`, `📍 ${bp.name} #${id} — follow the yellow beam (${dist} m)`));
  }

  /** Science mode's own keys (only while it is on). True when the key was ours. */
  handleKey(key: string, repeat: boolean): boolean {
    if (!this.on) return false;
    if (key === "r") {
      if (!repeat) this.rot = (this.rot + 1) % 4;
      return true;
    }
    if (key === "x") {
      if (!repeat && this.aimed) this.remove(this.aimed);
      return true;
    }
    return key === "f";
  }

  /**
   * Right button held down: keep building the plant the press started on, one piece per call, in
   * order (the next open socket, bottom-up). True when a piece went in.
   */
  holdBuild(): boolean {
    if (this.game.isOpen) return false;
    const r = this.aimedSocket?.r ?? this.aimed ?? this.holdSite;
    if (!r || this.distanceTo(r) > 9) return false;
    if (r.status !== "building" && r.status !== "parts") return false;
    return this.fitNext(r);
  }

  /** Fit the next open socket of a site (the aimed one first if it is open). */
  private fitNext(r: SiteRuntime): boolean {
    const aimed = this.aimedSocket?.r === r && socketOpen(r.site, this.aimedSocket.socket.index) ? this.aimedSocket.socket : null;
    const next = aimed ?? r.sockets.find((s) => socketOpen(r.site, s.index));
    if (!next) return false;
    const before = r.site.filled;
    this.fit(r, next, next.item);
    return r.site.filled !== before;
  }

  /** The aimed socket's ghost shines white; the rest keep their colour. */
  private aimedGhost: THREE.Group | null = null;
  private markAimedGhost(): void {
    const g = this.aimedSocket ? (this.aimedSocket.r.ghosts.get(this.aimedSocket.socket.index) ?? null) : null;
    if (g === this.aimedGhost) return;
    const paint = (group: THREE.Group | null, mat: (part: boolean) => THREE.Material) => {
      if (!group) return;
      const part = isPartKey(group.name);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = mat(part);
      });
    };
    paint(this.aimedGhost, (part) => (part ? this.ghostPart : this.ghostFrame));
    paint(g, () => this.ghostAimed);
    this.aimedGhost = g;
  }

  /** Middle click: the aimed socket's item, to put in hand (null: not aiming at an empty socket). */
  pickAimed(): SocketItem | null {
    return this.aimedSocket?.socket.item ?? null;
  }

  /**
   * A right click in ANY mode, before the game's own: fit the held item into the aimed socket, or
   * switch a ready plant on. True when it was ours (the game then does nothing else with the click).
   */
  interact(): boolean {
    const held = this.host.heldKey();
    const heldItem = isPartKey(held) || isFrameKey(held);
    // a socket answers when it is open or an item is in hand; otherwise the click places the
    // block behind it as usual (building around a plant must still work)
    if (this.aimedSocket && (heldItem || socketOpen(this.aimedSocket.r.site, this.aimedSocket.socket.index))) {
      return this.fit(this.aimedSocket.r, this.aimedSocket.socket, held);
    }
    // aiming at the plant itself (not a socket) while it is still being built: fit the next piece
    if (this.aimed && (this.aimed.status === "building" || this.aimed.status === "parts")) return this.fitNext(this.aimed);
    const r = this.aimed;
    if (r && r.status === "ready") return this.switchOn(r);
    // in science mode the click goes on to lay a blueprint, whatever is in hand (after building
    // you are usually still holding a piece — that must not block the next plan)
    if (heldItem && !this.on) {
      this.host.toast(t("🔩 발전소 설계도의 빛나는 칸을 바라보고 오른쪽 클릭해요 (블록처럼 놓을 수 없어요)", "🔩 Aim at a glowing slot of a power-plant blueprint and right click (items can't be placed like blocks)"));
      return true;
    }
    return false;
  }

  /** Right click in science mode (after `interact`): lay the previewed blueprint. */
  place(): boolean {
    if (!this.on || !this.plan) return false;
    if (this.plan.problem) {
      this.host.toast(`📐 ${PROBLEM_TEXT(this.plan.problem)}`);
      return false;
    }
    if (this.sites.length >= MAX_PLANTS) {
      this.host.toast(t("설계도가 너무 많아요 — X로 하나 걷어 주세요", "Too many blueprints — take one back with X"));
      return false;
    }
    const site = { ...this.plan.site, id: this.nextId++ };
    this.add(site, performance.now() / 1000);
    const bp = BLUEPRINTS[site.kind];
    this.host.toast(t(`${bp.icon} ${bp.ko} 설계도를 펼쳤어요 — 맨 아래 기초부터 칸마다 뼈대를 끼워요`, `${bp.icon} ${bp.name} blueprint laid — fit the frame slot by slot, starting with the foundation`));
    this.host.sound("place");
    this.previewKey = "";
    return true;
  }

  /** A GRID cell holding a fitted item: solid for bodies and rays, and no block may go in. */
  solidAt(gx: number, y: number, gz: number): boolean {
    return this.solid.size > 0 && this.solid.has(cellKey(gx + this.host.originX(), y, gz + this.host.originZ()));
  }

  /** Held left click on a fitted item (GRID cell): take it back out. True when something came out. */
  takeOutAt(gx: number, y: number, gz: number): boolean {
    const key = `${gx + this.host.originX()},${y},${gz + this.host.originZ()}`;
    const r = this.sites.find((x) => x.at.has(key));
    const socket = r?.at.get(key);
    if (!r || !socket) return false;
    const out = takeOut(r.site, socket.index);
    if (out.result === "above") {
      this.host.toast(t("🏗️ 위층부터 빼요 — 위에 끼운 뼈대가 있어요", "🏗️ Take it apart from the top — something above rests on this"));
      return false;
    }
    if (out.result === "parts-first") {
      const parts = r.sockets.filter((s) => s.kind === "part" && isFilled(r.site, s.index)).map((s) => itemLabel(s.item)).join(" · ");
      this.host.toast(t(`🔩 부품을 먼저 빼요: ${parts}`, `🔩 Take the parts out first: ${parts}`));
      return false;
    }
    if (out.result !== "ok") return false;
    r.site = out.site;
    this.ver++;
    this.host.giveItem(socket.item, 1);
    this.refresh(r);
    this.host.toast(t(`↩️ ${obj(socket.item)} 뺐어요 (뼈대 ${r.progress.pct}%)`, `↩️ Took the ${itemLabel(socket.item)} out (frame ${r.progress.pct}%)`));
    this.host.sound("pickup");
    return true;
  }

  /** Is a GRID cell a fitted item (a held left click there takes it out instead of mining)? */
  fittedAt(gx: number, y: number, gz: number): boolean {
    return this.solidAt(gx, y, gz);
  }

  /** A block write at an ABSOLUTE cell: a block in an empty socket shows red. */
  onCellWritten(x: number, y: number, z: number): void {
    const key = `${x},${y},${z}`;
    for (const r of this.sites) if (r.at.has(key)) this.holoDirty = true;
  }

  load(raw: unknown): void {
    for (const r of [...this.sites]) this.remove(r, true);
    for (const site of loadPlants(raw)) this.add({ ...site, id: this.nextId++ }, 0);
  }

  toJSON(): PlantTuple[] {
    return savePlants(this.sites.map((r) => r.site));
  }

  /** Dev / E2E view of the sites and the live preview. */
  debug(): {
    active: boolean;
    rot: number;
    sites: Array<PlantSite & { pct: number; state: string; status: PlantStatus; missingParts: PartKey[]; layer: number | null; spinning: boolean }>;
    plan: { site: PlantSite; problem: SiteProblem } | null;
    models: string[];
    aimedSlot: { site: number; part: SocketItem; index: number } | null;
    task: string;
  } {
    return {
      active: this.on,
      rot: this.rot,
      sites: this.sites.map((r) => ({
        ...r.site,
        pct: r.progress.pct,
        state: r.progress.state,
        status: r.status,
        missingParts: missingParts(r.site),
        layer: r.progress.layer,
        spinning: r.status === "running",
      })),
      plan: this.plan,
      models: MODEL_KEYS.map((k) => `${k}:${itemModelSource(k)}`),
      aimedSlot: this.aimedSocket ? { site: this.aimedSocket.r.site.id, part: this.aimedSocket.socket.item, index: this.aimedSocket.socket.index } : null,
      task: this.lastTask,
    };
  }

  /** Lay a blueprint at an absolute anchor without aiming (dev hook). */
  debugLay(x: number, y: number, z: number, rot = 0): SiteProblem {
    if (this.sites.length >= MAX_PLANTS) return "overlap";
    const site: PlantSite = { id: 0, kind: this.kind, x, y, z, rot, filled: 0, on: false };
    const problem = this.problem(site);
    if (!problem) this.add({ ...site, id: this.nextId++ }, performance.now() / 1000);
    return problem;
  }

  /** Every socket of a site, ABSOLUTE (dev hook). */
  socketsOf(index: number): Array<{ x: number; y: number; z: number; item: SocketItem; kind: string; filled: boolean; open: boolean }> {
    const r = this.sites[index];
    return r ? r.sockets.map((s) => ({ x: s.x, y: s.y, z: s.z, item: s.item, kind: s.kind, filled: isFilled(r.site, s.index), open: socketOpen(r.site, s.index) })) : [];
  }

  /** Fit the held item into socket `socket` of site `site` without aiming (dev hook: the same rules). */
  debugFit(site: number, socket: number): boolean {
    const r = this.sites[site];
    const s = r?.sockets[socket];
    if (!r || !s) return false;
    const before = r.site.filled;
    this.fit(r, s, this.host.heldKey());
    return r.site.filled !== before;
  }

  // ------------------------------------------------------------ per frame

  render(aim: RayHit | null, camera: THREE.Camera, playing: boolean): void {
    const now = performance.now() / 1000;
    const dt = this.lastFrame ? Math.min(0.1, now - this.lastFrame) : 0;
    this.lastFrame = now;
    if (this.warmGroup) {
      // one instance each, far below the world: their programs compile behind the loading screen
      this.m.makeTranslation(0, -1000, 0);
      this.holo.setMatrixAt(0, this.m);
      this.holo.count = 1;
      this.holo.instanceMatrix.needsUpdate = true;
      this.preview.setMatrixAt(0, this.m);
      this.preview.count = 1;
      this.preview.visible = true;
      this.preview.instanceMatrix.needsUpdate = true;
      return;
    }
    const ox = this.host.originX();
    const oz = this.host.originZ();
    const origin = `${ox},${oz}`;
    if (origin !== this.lastOrigin) {
      this.lastOrigin = origin;
      this.holoDirty = true;
      for (const r of this.sites) {
        this.placeModels(r);
        this.effects.moveBeacon(r.site.id, r.site.x - ox, r.site.y, r.site.z - oz);
      }
    }

    const socketBefore = this.aimedSocket;
    this.aimedSocket = this.findAimedSocket(aim);
    this.aimed = this.findAimed(aim);
    if (socketBefore?.socket !== this.aimedSocket?.socket) this.holoDirty = true;
    const pulse = 0.5 + 0.5 * Math.sin(now * 4);
    if (this.holoDirty || this.scanning) this.rebuildHolograms(now, pulse);
    else if (this.pulsing.length) this.pulseSockets(pulse);
    this.updatePreview(aim, playing);
    for (const r of this.sites) {
      this.updateLabel(r, camera, ox, oz);
      if (r.status === "running") {
        const blades = r.sockets.find((s) => s.item === "part-blades");
        const spin = blades ? r.models.get(blades.index)?.getObjectByName("spin") : undefined;
        if (spin) spin.rotation.z -= ROTOR_SPEED * dt;
      }
    }
    if (this.on) this.holoMat.opacity = 0.56 + 0.08 * Math.sin(now * 3.2);
    this.ghostFrame.opacity = 0.38 + 0.2 * pulse;
    this.ghostPart.opacity = 0.42 + 0.22 * pulse;
    this.markAimedGhost();
    this.effects.update(dt, now);
    if (this.board.open) this.board.update(this.boardPlants(), this.village());
    this.updateArrow(camera);
    // the task line: always in science mode; in block mode only when it has something to say
    const held = this.host.heldKey();
    const task = this.task();
    const peek = !this.on && playing && task !== null && (this.aimed !== null || this.aimedSocket !== null || isPartKey(held) || isFrameKey(held));
    if (peek !== this.peeking) {
      this.peeking = peek;
      document.body.classList.toggle("sci-peek", peek);
    }
    if (this.on || peek) this.setTask(task ?? t("땅을 바라보면 설계도가 보여요", "Look at the ground to see the blueprint"));
  }

  /**
   * Boot warm-up: every science shader drawn once behind the loading screen (hologram and preview
   * instances, each item model, sparks, the beacon), far below the world.
   */
  setWarm(on: boolean): void {
    if (on && !this.warmGroup) {
      const g = new THREE.Group();
      g.position.set(0, -1000, 0);
      MODEL_KEYS.forEach((k, i) => {
        const m = itemModel(k);
        m.position.x = i * 2;
        m.traverse((o) => (o.frustumCulled = false));
        g.add(m);
      });
      this.host.scene.add(g);
      this.warmGroup = g;
      this.effects.setWarm(true);
    } else if (!on && this.warmGroup) {
      this.host.scene.remove(this.warmGroup);
      this.warmGroup = null;
      this.effects.setWarm(false);
      this.holoDirty = true;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.lightTimer) window.clearTimeout(this.lightTimer);
    this.setWarm(false);
    for (const r of this.sites) this.disposeSite(r);
    this.host.scene.remove(this.holo, this.preview);
    this.holo.dispose();
    this.preview.dispose();
    this.box.dispose();
    this.holoMat.dispose();
    this.previewMat.dispose();
    this.texture.dispose();
    this.ghostFrame.dispose();
    this.ghostPart.dispose();
    this.ghostAimed.dispose();
    disposeItemAssets();
    this.effects.dispose();
    this.game.dispose();
    this.board.dispose();
    this.arrow.remove();
    this.bar.remove();
    this.tintEl.remove();
    document.body.classList.remove("sci-on", "sci-peek");
  }

  // ------------------------------------------------------------ actions

  private fit(r: SiteRuntime, socket: SiteSocket, _held: string): boolean {
    // one click: the glowing shape shows what goes in, and that very item comes out of the bag —
    // children learn the order and the names from the shapes and notes, not by hunting a hotbar
    const need = socket.item;
    const ox = this.host.originX();
    const oz = this.host.originZ();
    if (socket.cells.some((c) => this.host.playerIn(c.x - ox, c.y, c.z - oz))) {
      this.host.toast(t("🚶 로봇이 그 칸에 서 있어요 — 한 걸음 비켜서 끼워요", "🚶 You're standing in that slot — step aside first"));
      return true;
    }
    const empty = socket.cells.every((c) => isEmptyId(this.host.blockAt(c.x, c.y, c.z)));
    const fit = fitItem(r.site, socket.index, need, empty);
    switch (fit.result) {
      case "order": {
        const next = r.progress.layer ?? 0;
        this.host.toast(t(`🏗️ 아래층부터 쌓아요 — 지금은 ${LAYER_NAME(next)} 층 차례예요`, `🏗️ Build from the bottom up — the ${LAYER_NAME(next)} comes first`));
        return true;
      }
      case "frame-first":
        this.host.toast(t(`🧱 뼈대를 먼저 완성해요 (${r.progress.pct}%) — 부품은 그다음이에요`, `🧱 Finish the frame first (${r.progress.pct}%) — parts come after`));
        return true;
      case "wrong-item":
        this.host.toast(t(`🔩 여기는 ${itemLabel(need)} 자리예요 — 가운데 클릭으로 맞는 걸 들어요`, `🔩 This is the ${itemLabel(need)} slot — middle click to hold the right one`));
        return true;
      case "filled":
        this.host.toast(t(`✅ ${itemLabel(need)}${isEnglish() ? " is already in" : "는 이미 들어갔어요"}`, `✅ The ${itemLabel(need)} is already in`));
        return true;
      case "blocked":
        this.host.toast(t("⛏️ 칸에 블록이 있어요 — 캐내고 끼워요", "⛏️ A block is in the slot — mine it out first"));
        return true;
      case "ok":
        break;
    }
    if (!this.host.takeItem(need, true)) {
      this.host.toast(t(`가방에 ${itemLabel(need)}${isEnglish() ? "" : "가"} 없어요`, `No ${itemLabel(need)} in your bag`));
      return true;
    }
    // the three key pieces open a mini-game first; the piece goes in when it is finished
    const kind = MINI_GAMES[need];
    if (kind) {
      if (this.game.isOpen) return true;
      this.host.openPanel();
      this.host.sound("click");
      this.game.open(kind, (ok) => {
        this.host.resumePlay();
        if (!ok) {
          this.host.toast(t(`🎮 미니게임을 끝내면 ${obj(need)} 끼워져요 — 다시 오른쪽 클릭`, `🎮 Finish the mini-game to fit the ${itemLabel(need)} — right click again`));
          return;
        }
        this.commitFit(r, socket);
      });
      return true;
    }
    this.commitFit(r, socket);
    return true;
  }

  /** The fit itself, after the checks (and the mini-game, for the three key pieces). */
  private commitFit(r: SiteRuntime, socket: SiteSocket): void {
    const need = socket.item;
    // the world may have moved on while a mini-game was open: check again
    const empty = socket.cells.every((c) => isEmptyId(this.host.blockAt(c.x, c.y, c.z)));
    const fit = fitItem(r.site, socket.index, need, empty);
    if (fit.result !== "ok" || !this.sites.includes(r)) return;
    if (!this.host.takeItem(need)) {
      this.host.toast(t(`가방에 ${itemLabel(need)}${isEnglish() ? "" : "가"} 없어요`, `No ${itemLabel(need)} in your bag`));
      return;
    }
    const layerBefore = r.progress.layer;
    this.holdSite = r;
    r.site = fit.site;
    this.ver++;
    this.refresh(r);
    const p = r.progress;
    const note = itemNote(need);
    const first = !this.told.has(need);
    this.told.add(need);
    if (socket.kind === "frame" && p.state !== "built") {
      if (p.layer !== layerBefore) {
        this.host.toast(t(`✅ ${LAYER_NAME(layerBefore ?? 0)} 층 완성! 다음은 ${LAYER_NAME(p.layer ?? 0)} — ${this.nextLayer(r)} (뼈대 ${p.pct}%)`, `✅ ${LAYER_NAME(layerBefore ?? 0)} done! Next: the ${LAYER_NAME(p.layer ?? 0)} — ${this.nextLayer(r)} (frame ${p.pct}%)`));
        this.host.sound("clear");
        return;
      }
      this.host.toast(first
        ? t(`📘 ${itemLabel(need)} — ${note} (뼈대 ${p.pct}%)`, `📘 ${itemLabel(need)} — ${note} (frame ${p.pct}%)`)
        : t(`🏗️ ${itemLabel(need)} 끼움 · 뼈대 ${p.pct}%`, `🏗️ ${itemLabel(need)} fitted · frame ${p.pct}%`));
    } else if (socket.kind === "part") {
      const left = missingParts(r.site);
      this.host.toast(
        left.length
          ? t(`🔩 ${itemLabel(need)} 장착! ${note} · 남은 부품: ${left.map(itemLabel).join(" · ")}`, `🔩 ${itemLabel(need)} fitted! ${note} · Still needed: ${left.map(itemLabel).join(" · ")}`)
          : t(`🔩 ${itemLabel(need)} 장착! ${note} · 이제 발전소를 오른쪽 클릭해서 가동해요`, `🔩 ${itemLabel(need)} fitted! ${note} · Now right-click the plant to switch it on`),
      );
    }
    this.host.sound("place");
  }

  private switchOn(r: SiteRuntime): boolean {
    r.site = { ...r.site, on: true };
    this.ver++;
    this.refresh(r);
    const bp = BLUEPRINTS[r.site.kind];
    const chain = (isEnglish() ? bp.chainEn : bp.chain).join(" → ");
    this.host.toast(t(`⚡ ${bp.ko} 가동! ${chain}`, `⚡ ${bp.name} running! ${chain}`));
    this.host.sound("checkpoint");
    return true;
  }

  // ------------------------------------------------------------ internals

  private refresh(r: SiteRuntime): void {
    const before = r.status;
    r.progress = plantProgress(r.site);
    r.status = plantStatus(r.site);
    this.syncModels(r);
    this.holoDirty = true;
    if (r.status === "running" && before !== "running") this.lightUp();
    if (before === r.status) return;
    const bp = BLUEPRINTS[r.site.kind];
    const name = isEnglish() ? bp.name : bp.ko;
    if (before === "running" && r.status === "inspection") {
      this.host.toast(t(`🛠️ ${name} 점검 중 — 빠진 아이템을 다시 끼우면 바로 돌아요`, `🛠️ ${name} stopped for a check — fit the missing item and it runs again`));
    } else if (before === "inspection" && r.status === "running") {
      this.host.toast(t(`⚡ ${name} 다시 가동!`, `⚡ ${name} running again!`));
      this.host.sound("checkpoint");
    } else if (before === "building" && r.status === "parts") {
      this.host.toast(t(`🎉 ${name} 뼈대 완성! 이제 금색 칸에 부품을 넣어요: ${missingParts(r.site).map(itemLabel).join(" · ")}`, `🎉 ${name} frame complete! Now fit the parts into the gold slots: ${missingParts(r.site).map(itemLabel).join(" · ")}`));
      this.host.sound("clear");
    }
  }

  /** A plant just started: say how much of the village is lit now. */
  private lightUp(): void {
    const v = this.village();
    if (this.lightTimer) window.clearTimeout(this.lightTimer);
    this.lightTimer = window.setTimeout(() => {
      this.lightTimer = 0;
      if (this.disposed) return;
      this.host.toast(v.lit >= v.demand
        ? t(`🏠 마을 집 ${v.demand}채 모두 불이 켜졌어요! (⚡ ${v.supply}/${v.demand})`, `🏠 All ${v.demand} houses are lit! (⚡ ${v.supply}/${v.demand})`)
        : t(`🏠 마을 집 ${v.lit}채에 불이 켜졌어요 (⚡ ${v.supply}/${v.demand}) · Tab 현황판`, `🏠 ${v.lit} houses lit (⚡ ${v.supply}/${v.demand}) · Tab for status`));
    }, 1600);
  }

  private village() {
    return villagePower(this.sites.map((r) => ({ kind: r.site.kind, running: r.status === "running" })));
  }

  private distanceTo(r: SiteRuntime): number {
    const ray = this.host.ray();
    return Math.hypot(r.site.x - this.host.originX() + 0.5 - ray.ox, r.site.z - this.host.originZ() + 0.5 - ray.oz);
  }

  private boardPlants(): BoardPlant[] {
    return this.sites.map((r) => ({
      id: r.site.id,
      kind: r.site.kind,
      status: r.status,
      pct: r.progress.pct,
      parts: r.sockets.filter((s) => s.kind === "part").map((s) => ({ part: s.item as PartKey, filled: isFilled(r.site, s.index) })),
      distance: this.distanceTo(r),
    }));
  }

  private add(site: PlantSite, born: number): void {
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 512;
    labelCanvas.height = 176;
    const tex = new THREE.CanvasTexture(labelCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // a constant on-screen size (like a name tag): readable from across the field
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false }));
    label.scale.set(0.32, 0.32 * (176 / 512), 1);
    label.renderOrder = 20;
    label.raycast = () => {};
    this.host.scene.add(label);
    const sockets = siteSockets(site);
    const at = new Map(sockets.flatMap((s) => s.cells.map((c) => [`${c.x},${c.y},${c.z}`, s] as const)));
    const r: SiteRuntime = { site, progress: plantProgress(site), status: plantStatus(site), born, label, labelCanvas, labelKey: "", models: new Map(), sockets, at, ghosts: new Map() };
    this.sites.push(r);
    this.syncModels(r);
    this.holoDirty = true;
    this.ver++;
    if (born) this.scanning = true;
  }

  private remove(r: SiteRuntime, quiet = false): void {
    const i = this.sites.indexOf(r);
    if (i < 0) return;
    this.sites.splice(i, 1);
    this.disposeSite(r);
    if (this.aimed === r) this.aimed = null;
    if (this.aimedSocket?.r === r) this.aimedSocket = null;
    this.holoDirty = true;
    this.previewKey = "";
    this.ver++;
    if (quiet) return;
    // everything fitted comes back to the bag
    const back = r.sockets.filter((s) => isFilled(r.site, s.index));
    for (const s of back) this.host.giveItem(s.item, 1);
    this.host.toast(back.length
      ? t(`📐 설계도를 걷었어요 — 끼운 아이템 ${back.length}개는 가방으로 돌아갔어요`, `📐 Blueprint taken back — ${back.length} item(s) back in the bag`)
      : t("📐 설계도를 걷었어요", "📐 Blueprint taken back"));
    this.host.sound("pickup");
  }

  private disposeSite(r: SiteRuntime): void {
    this.host.scene.remove(r.label);
    r.label.material.map?.dispose();
    r.label.material.dispose();
    for (const m of r.models.values()) this.host.scene.remove(m);
    r.models.clear();
    for (const g of r.ghosts.values()) this.host.scene.remove(g);
    r.ghosts.clear();
    if (this.holdSite === r) this.holdSite = null;
    this.effects.drop(r.site.id);
    let changed = false;
    for (const s of r.sockets) for (const c of s.cells) changed = this.solid.delete(cellKey(c.x, c.y, c.z)) || changed;
    if (changed) this.host.solidsChanged();
  }

  /** Models and solid cells follow the filled bits (shared geometry: adding one is cheap). */
  private syncModels(r: SiteRuntime): void {
    let solidChanged = false;
    for (const s of r.sockets) {
      const has = isFilled(r.site, s.index);
      const model = r.models.get(s.index);
      if (has && !model) {
        const g = itemModel(s.item);
        r.models.set(s.index, g);
        this.host.scene.add(g);
      } else if (!has && model) {
        this.host.scene.remove(model);
        r.models.delete(s.index);
      }
      // every fitted cell is solid — the rotor's too: a held left click must be able to aim at it
      // to take it out (an open rotor cell let the ray pass straight through, and it never came off)
      for (const c of s.cells) {
        const k = cellKey(c.x, c.y, c.z);
        if (has && !this.solid.has(k)) {
          this.solid.add(k);
          solidChanged = true;
        } else if (!has && this.solid.delete(k)) solidChanged = true;
      }
    }
    if (solidChanged) this.host.solidsChanged();
    // ghosts: the shape of what goes in, in every socket that is open right now
    for (const s of r.sockets) {
      const want = socketOpen(r.site, s.index);
      const ghost = r.ghosts.get(s.index);
      if (want && !ghost) {
        const g = itemModel(s.item);
        const mat = s.kind === "part" ? this.ghostPart : this.ghostFrame;
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.material = mat;
            m.castShadow = false;
            m.receiveShadow = false;
            m.renderOrder = 1;
          }
        });
        r.ghosts.set(s.index, g);
        this.host.scene.add(g);
      } else if (!want && ghost) {
        this.host.scene.remove(ghost);
        r.ghosts.delete(s.index);
      }
    }
    const terminal = r.sockets.find((s) => s.item === "part-wire-terminal");
    this.effects.sync(r.site.id, terminal ? isFilled(r.site, terminal.index) : false, r.status === "running");
    this.placeModels(r);
  }

  private placeModels(r: SiteRuntime): void {
    const ox = this.host.originX();
    const oz = this.host.originZ();
    this.effects.place(r.site.id, r.site.x - ox, r.site.y, r.site.z - oz, r.site.rot);
    for (const s of r.sockets) {
      for (const g of [r.models.get(s.index), r.ghosts.get(s.index)]) {
        if (!g) continue;
        g.position.set(s.cx - ox, s.cy, s.cz - oz);
        g.rotation.y = (-r.site.rot * Math.PI) / 2;
      }
    }
  }

  private problem(site: PlantSite): SiteProblem {
    const ox = this.host.originX();
    const oz = this.host.originZ();
    const w = this.host.world;
    return siteProblem(
      site,
      {
        inBounds: (x, y, z) => w.inBounds(x - ox, y, z - oz),
        blockAt: (x, y, z) => this.host.blockAt(x, y, z),
        isEmpty: isEmptyId,
        isGround: (x, y, z) => w.isSolid(x - ox, y, z - oz),
        occupied: (x, y, z) => this.host.playerIn(x - ox, y, z - oz) || this.host.furnitureIn(x - ox, y, z - oz),
      },
      this.sites.map((r) => r.site),
    );
  }

  /** The site the crosshair is on: one of its sockets (filled ones are solid, so the ray stops on
   *  them), the cell in front of one, or the ground under its foundation. */
  private findAimed(aim: RayHit | null): SiteRuntime | null {
    if (this.aimedSocket) return this.aimedSocket.r;
    if (!aim) return null;
    const ox = this.host.originX();
    const oz = this.host.originZ();
    const [bx, by, bz] = aim.before;
    const [vx, vy, vz] = aim.voxel;
    const before = `${bx + ox},${by},${bz + oz}`;
    const voxel = `${vx + ox},${vy},${vz + oz}`;
    for (const r of this.sites) if (r.at.has(voxel) || r.at.has(before)) return r;
    for (const r of this.sites) {
      const s = r.site;
      if (vy === s.y - 1 && Math.abs(vx + ox - s.x) <= 1 && Math.abs(vz + oz - s.z) <= 1) return r;
    }
    return null;
  }

  /**
   * The empty socket the look ray crosses first, if it is nearer than what the ray hits: empty
   * sockets are air, so the voxel ray passes through them. Slab test per socket box.
   */
  private findAimedSocket(aim: RayHit | null): { r: SiteRuntime; socket: SiteSocket } | null {
    const ray = this.host.ray();
    const ox = this.host.originX();
    const oz = this.host.originZ();
    const limit = Math.min(ray.reach, aim ? aim.dist + 0.6 : ray.reach);
    // open sockets win, with a forgiving box (a child's aim is rough); a closed one only answers
    // when no open one is under the crosshair, so it can say "not yet" without stealing the aim
    const PAD = 0.22;
    let open: { r: SiteRuntime; socket: SiteSocket } | null = null;
    let openT = Infinity;
    let closed: { r: SiteRuntime; socket: SiteSocket } | null = null;
    let closedT = Infinity;
    for (const r of this.sites) {
      if (Math.abs(r.site.x - ox - ray.ox) > ray.reach + 4 || Math.abs(r.site.z - oz - ray.oz) > ray.reach + 4) continue;
      for (const s of r.sockets) {
        if (isFilled(r.site, s.index)) continue;
        const isOpen = socketOpen(r.site, s.index);
        const pad = isOpen ? PAD : 0;
        for (const c of s.cells) {
          const tHit = slabHit(ray, c.x - ox - pad, c.y - pad, c.z - oz - pad, 1 + 2 * pad);
          if (tHit === null || tHit > limit + pad) continue;
          if (isOpen && tHit < openT) {
            openT = tHit;
            open = { r, socket: s };
          } else if (!isOpen && tHit < closedT) {
            closedT = tHit;
            closed = { r, socket: s };
          }
        }
      }
    }
    return open ?? closed;
  }

  private updatePreview(aim: RayHit | null, playing: boolean): void {
    this.plan = null;
    // the plan is worked out whenever science mode is on (a click must find it), but drawn only
    // while playing — a paused game shows no floating preview
    if (!this.on || !aim || this.aimed) {
      this.preview.visible = false;
      return;
    }
    const ox = this.host.originX();
    const oz = this.host.originZ();
    const [bx, by, bz] = aim.before;
    const site: PlantSite = { id: 0, kind: this.kind, x: bx + ox, y: by, z: bz + oz, rot: this.rot, filled: 0, on: false };
    const key = `${site.x},${site.y},${site.z},${site.rot},${this.ver},${this.host.world.version}`;
    if (key === this.previewKey && this.previewAge++ < 12 && this.lastPlan) {
      this.plan = this.lastPlan;
      this.preview.visible = playing;
      return;
    }
    this.previewKey = key;
    this.previewAge = 0;
    const problem = this.problem(site);
    this.plan = { site, problem };
    this.lastPlan = this.plan;
    const cells = siteSockets(site).flatMap((x) => x.cells);
    const color = problem ? PREVIEW_BAD : PREVIEW_OK;
    this.q.identity();
    this.s.setScalar(0.97);
    cells.forEach((c, i) => {
      this.v.set(c.x - ox + 0.5, c.y + 0.5, c.z - oz + 0.5);
      this.m.compose(this.v, this.q, this.s);
      this.preview.setMatrixAt(i, this.m);
      this.preview.setColorAt(i, color);
    });
    this.preview.count = cells.length;
    this.preview.instanceMatrix.needsUpdate = true;
    if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
    this.preview.visible = playing;
  }

  /** Open sockets breathe: only their instances are rewritten (no rebuild, no garbage). */
  private pulseSockets(pulse: number): void {
    const ox = this.host.originX();
    const oz = this.host.originZ();
    this.q.identity();
    for (const p of this.pulsing) {
      this.s.setScalar(0.86 + 0.08 * pulse);
      this.v.set(p.x - ox + 0.5, p.y + 0.5, p.z - oz + 0.5);
      this.m.compose(this.v, this.q, this.s);
      this.holo.setMatrixAt(p.i, this.m);
      this.tint.copy(p.part ? PART_WAIT : FRAME_WAIT).lerp(p.part ? PART_OPEN : FRAME_OPEN, 0.55 + 0.45 * pulse);
      this.holo.setColorAt(p.i, this.tint);
    }
    this.holo.instanceMatrix.needsUpdate = true;
    if (this.holo.instanceColor) this.holo.instanceColor.needsUpdate = true;
  }

  private rebuildHolograms(now: number, pulse: number): void {
    this.holoDirty = false;
    this.scanning = false;
    this.pulsing.length = 0;
    const ox = this.host.originX();
    const oz = this.host.originZ();
    this.q.identity();
    let n = 0;
    for (const r of this.sites) {
      // a new blueprint sweeps up from the ground, one layer at a time
      const sweep = r.born ? (now - r.born) / SCAN_TIME : Infinity;
      if (sweep < 1) this.scanning = true;
      for (const s of r.sockets) {
        if (isFilled(r.site, s.index)) continue; // fitted: the model shows
        if (s.dy / TOP_LAYER > sweep) continue;
        const part = s.kind === "part";
        const open = socketOpen(r.site, s.index);
        const aimed = this.aimedSocket?.socket === s;
        for (const c of s.cells) {
          const blocked = !isEmptyId(this.host.blockAt(c.x, c.y, c.z));
          // an open socket shows its item's see-through shape instead of a box (cleaner, and it
          // says WHAT goes there); boxes stay for "not yet" sockets and red for blocked cells
          if (!blocked && (open || aimed)) continue;
          let scale = open ? 0.86 + 0.08 * pulse : part ? 0.7 : 0.92;
          if (aimed) {
            this.tint.copy(AIMED);
            scale = 1.02;
          } else if (blocked) {
            this.tint.copy(BLOCKED);
            scale = 1.04;
          } else if (open) {
            this.tint.copy(part ? PART_WAIT : FRAME_WAIT).lerp(part ? PART_OPEN : FRAME_OPEN, 0.55 + 0.45 * pulse);
            this.pulsing.push({ i: n, x: c.x, y: c.y, z: c.z, part });
          } else this.tint.copy(part ? PART_WAIT : FRAME_WAIT);
          this.s.setScalar(scale);
          this.v.set(c.x - ox + 0.5, c.y + 0.5, c.z - oz + 0.5);
          this.m.compose(this.v, this.q, this.s);
          this.holo.setMatrixAt(n, this.m);
          this.holo.setColorAt(n, this.tint);
          n++;
        }
      }
    }
    this.holo.count = n;
    this.holo.instanceMatrix.needsUpdate = true;
    if (this.holo.instanceColor) this.holo.instanceColor.needsUpdate = true;
  }

  private updateLabel(r: SiteRuntime, camera: THREE.Camera, ox: number, oz: number): void {
    const { site, progress } = r;
    r.label.position.set(site.x - ox + 0.5, site.y + 10.6, site.z - oz + 0.5);
    r.label.visible = camera.position.distanceTo(r.label.position) < LABEL_RANGE;
    const focus = this.aimed === r;
    const key = `${progress.pct}/${r.status}/${site.filled}/${focus}`;
    if (key === r.labelKey) return;
    r.labelKey = key;
    drawLabel(r.labelCanvas, r, focus);
    r.label.material.map!.needsUpdate = true;
  }

  /** What the next layer still needs, in words ("기초 블록 8 · 기초 중심 1"). */
  private nextLayer(r: SiteRuntime): string {
    const layer = r.progress.layer;
    if (layer === null) return "";
    const need = new Map<SocketItem, number>();
    for (const s of r.sockets) if (s.kind === "frame" && s.dy === layer && !isFilled(r.site, s.index)) need.set(s.item, (need.get(s.item) ?? 0) + 1);
    return [...need].map(([k, n]) => `${itemLabel(k)} ${n}`).join(" · ");
  }

  /** What to do next, given what is aimed at and held. null = nothing worth saying. */
  private task(): string | null {
    const held = this.host.heldKey();
    if (this.aimedSocket) {
      const { r, socket } = this.aimedSocket;
      const open = socketOpen(r.site, socket.index);
      if (!open && socket.kind === "part") return t(`이 금색 칸은 ${itemLabel(socket.item)} 자리예요 — 뼈대(${r.progress.pct}%)를 먼저 완성해요`, `This gold slot is for the ${itemLabel(socket.item)} — finish the frame (${r.progress.pct}%) first`);
      if (!open) return t(`이 칸은 ${itemLabel(socket.item)} 자리 — 아래 ${LAYER_NAME(r.progress.layer ?? 0)} 층부터 채워요`, `This is the ${itemLabel(socket.item)} slot — fill the ${LAYER_NAME(r.progress.layer ?? 0)} below first`);
      return t(`오른쪽 클릭 → ${obj(socket.item)} 끼워요 · 꾹 누르고 있으면 다음 칸도 차례대로`, `Right click → fit the ${itemLabel(socket.item)} · hold it to keep going`);
    }
    if (this.aimed) {
      const r = this.aimed;
      switch (r.status) {
        case "building":
          return t(`${LAYER_NAME(r.progress.layer ?? 0)} 층 차례 (뼈대 ${r.progress.pct}%) — 빛나는 모양을 오른쪽 클릭, 꾹 누르면 차례대로 지어져요`, `The ${LAYER_NAME(r.progress.layer ?? 0)} is next (frame ${r.progress.pct}%) — right click a glowing shape, hold to keep building`);
        case "parts":
          return t(`부품 대기 — 금색 모양을 오른쪽 클릭해요: ${missingParts(r.site).map(itemLabel).join(" · ")}`, `Needs parts — right click the gold shapes: ${missingParts(r.site).map(itemLabel).join(" · ")}`);
        case "ready":
          return t("가동 준비 완료! 발전소를 오른쪽 클릭해서 가동해요", "Ready! Right-click the plant to switch it on");
        case "running": {
          const bp = BLUEPRINTS[r.site.kind];
          return t(`⚡ 가동 중 — ${bp.chain.join(" → ")}`, `⚡ Running — ${bp.chainEn.join(" → ")}`);
        }
        case "inspection":
          return t("점검 중 — 빠진 아이템을 다시 끼우면 돌아요", "Stopped for a check — fit the missing item again");
      }
    }
    if (isPartKey(held) || isFrameKey(held)) return t(`${obj(held)} 들었어요 — 설계도의 빛나는 칸을 바라보고 오른쪽 클릭`, `Holding the ${itemLabel(held)} — aim at a blueprint's glowing slot and right click`);
    if (!this.on) return null;
    const plan = this.plan;
    if (plan?.problem) return PROBLEM_TEXT(plan.problem);
    if (plan) return t(`오른쪽 클릭으로 ${BLUEPRINTS[plan.site.kind].ko} 설계도를 펼쳐요 · R로 방향 돌리기`, `Right click to lay the ${BLUEPRINTS[plan.site.kind].name.toLowerCase()} blueprint · R to turn it`);
    return null;
  }

  private setTask(text: string): void {
    if (text === this.lastTask) return;
    this.lastTask = text;
    this.taskEl.textContent = text;
  }

  /**
   * The arrow toward a beacon that is off screen: on the left or right edge (the way to turn),
   * at mid height — the top of the screen belongs to the guide bar and toasts.
   */
  private updateArrow(camera: THREE.Camera): void {
    const target = this.effects.beaconTarget();
    const r = target ? this.sites.find((x) => x.site.id === target.id) : undefined;
    if (!target || !r) {
      this.arrow.classList.remove("show");
      return;
    }
    this.proj.copy(target.pos);
    this.proj.y += 5;
    this.proj.project(camera);
    if (this.proj.z < 1 && Math.abs(this.proj.x) < 0.92 && Math.abs(this.proj.y) < 0.9) {
      this.arrow.classList.remove("show");
      return;
    }
    this.proj.copy(target.pos).applyMatrix4(camera.matrixWorldInverse);
    const right = this.proj.x >= 0;
    const bp = BLUEPRINTS[r.site.kind];
    const label = `${isEnglish() ? bp.name : bp.ko} #${r.site.id} · ${Math.round(this.distanceTo(r))} m`;
    const html = right ? `${label}<i></i>` : `<i class="left"></i>${label}`;
    if (this.arrow.innerHTML !== html) this.arrow.innerHTML = html;
    this.arrow.classList.toggle("right", right);
    this.arrow.style.top = `${window.innerHeight * 0.46}px`;
    this.arrow.classList.add("show");
  }
}

/** Ray vs an axis-aligned cube (min corner, side): the entry distance, or null. */
function slabHit(ray: { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }, x: number, y: number, z: number, size: number): number | null {
  let t0 = 0;
  let t1 = Infinity;
  const axes: Array<[number, number, number]> = [[ray.ox, ray.dx, x], [ray.oy, ray.dy, y], [ray.oz, ray.dz, z]];
  for (const [o, d, lo] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > lo + size) return null;
      continue;
    }
    let a = (lo - o) / d;
    let b = (lo + size - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/** A soft white plate: icon + name and a state badge, the frame's progress bar, then what comes
 *  next — the next layer's pieces while building, the part icons after. */
function drawLabel(c: HTMLCanvasElement, r: SiteRuntime, focus: boolean): void {
  const { site, progress: p, status } = r;
  const g = c.getContext("2d")!;
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  const plate = (x: number, y: number, w: number, h: number, rad: number) => {
    g.beginPath();
    g.roundRect(x, y, w, h, rad);
  };
  g.fillStyle = "rgba(20,40,80,0.22)";
  plate(8, 12, W - 16, H - 16, 30);
  g.fill();
  g.fillStyle = focus ? "rgba(255,255,255,0.98)" : "rgba(255,255,255,0.9)";
  plate(6, 4, W - 12, H - 18, 30);
  g.fill();
  const bp = BLUEPRINTS[site.kind];
  g.font = '700 34px "Jua", system-ui, sans-serif';
  g.textBaseline = "middle";
  g.fillStyle = "#24324a";
  g.fillText(`${bp.icon} ${isEnglish() ? bp.name : bp.ko}`, 26, 40);
  const badge = STATUS_TEXT[status]();
  g.font = '700 26px "Jua", system-ui, sans-serif';
  const bw = g.measureText(badge).width + 32;
  g.fillStyle = STATUS_COLOR[status];
  plate(W - 22 - bw, 20, bw, 40, 20);
  g.fill();
  g.fillStyle = "#fff";
  g.fillText(badge, W - 22 - bw + 16, 41);
  const bx = 26;
  const by = 72;
  const bwid = W - 52 - 96;
  g.fillStyle = "#e3eaf4";
  plate(bx, by, bwid, 20, 10);
  g.fill();
  g.fillStyle = p.state === "built" ? "#3fbf6a" : "#3d8fe0";
  if (p.pct > 0) {
    plate(bx, by, Math.max(20, (bwid * p.pct) / 100), 20, 10);
    g.fill();
  }
  g.fillStyle = "#24324a";
  g.font = '700 30px "Jua", system-ui, sans-serif';
  g.textAlign = "right";
  g.fillText(`${p.pct}%`, W - 26, by + 11);
  g.textAlign = "left";
  g.font = '700 22px "Jua", system-ui, sans-serif';
  g.fillStyle = "#5b6a82";
  if (p.state !== "built") {
    // the next layer's pieces, as icons with counts
    g.fillText(t("다음", "Next"), 26, 128);
    const need = new Map<SocketItem, number>();
    for (const s of r.sockets) if (s.kind === "frame" && s.dy === p.layer && !isFilled(site, s.index)) need.set(s.item, (need.get(s.item) ?? 0) + 1);
    let x = 92;
    for (const [item, n] of need) {
      g.fillStyle = "#eaf3ff";
      g.beginPath();
      g.arc(x + 20, 128, 22, 0, Math.PI * 2);
      g.fill();
      const icon = itemIcon(item, r);
      if (icon) g.drawImage(icon, x + 2, 110, 36, 36);
      g.fillStyle = "#24324a";
      g.fillText(`×${n}`, x + 46, 128);
      x += 96;
    }
    return;
  }
  g.fillText(t("부품", "Parts"), 26, 128);
  let x = 92;
  const parts = r.sockets.filter((s) => s.kind === "part");
  for (const s of parts) {
    const has = isFilled(site, s.index);
    g.fillStyle = has ? "#e8f7ee" : "#f1f4f8";
    g.beginPath();
    g.arc(x + 20, 128, 22, 0, Math.PI * 2);
    g.fill();
    if (!has) {
      g.setLineDash([5, 4]);
      g.strokeStyle = "#b4bfcf";
      g.lineWidth = 2.5;
      g.stroke();
      g.setLineDash([]);
    }
    const icon = itemIcon(s.item, r);
    if (icon) {
      g.globalAlpha = has ? 1 : 0.32;
      g.drawImage(icon, x + 2, 110, 36, 36);
      g.globalAlpha = 1;
    }
    x += 52;
  }
  const done = parts.filter((s) => isFilled(site, s.index)).length;
  g.fillStyle = "#5b6a82";
  g.fillText(`${done}/${parts.length}`, x + 4, 128);
}
