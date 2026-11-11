import {pickaxeCycle,pickaxeImpacts,PICKAXE} from "./toolDefinitions.js";
import { surfaceStyle } from "./blockMaterials.js";
import type { FurnitureLayout } from "./furniture/layout.js";
import * as THREE from "three";
import type { ClassEdit, ClassMember, ClassSettings, ClassAnim, ClassServerMessage, ClassClientMessage, CharacterPresentation, BonkCandidate } from "@robo/shared";
import { classKey, isWater, plotBounds } from "@robo/shared";
import { BonkFx } from "./bonkFx.js";
import { CharacterRig, disposeRig } from "../player/rig.js";
import type { ClassClient, ClassSession } from "../net/classClient.js";
import { ClassHud } from "./classHud.js";
import { SeatingView } from "./seatingView.js";
import { LessonOverlay } from "./lessonOverlay.js";
import { turnToward } from "./smoothing.js";
import { RemoteTrack, SnapClock, type TrackPose } from "./remoteTrack.js";
import { SOLID_ID, blockById } from "./blocks.js";
import { BODY_WIDTH, overlapsShapedVoxel } from "./voxelBody.js";
import type { FieldWindow } from "./fieldWorld.js";
import type { VoxelView } from "./voxelView.js";
import { t } from "../ui/i18n.js";

const MOVE_HZ = 10;
/** Classmates beyond these distances (m) are posed every 3rd / 6th frame. */
const LOD_MID_M = 45;
const LOD_FAR_M = 80;
/** Classmates' face textures are drawn at this fraction of the player's own (a quarter of the upload). */
const REMOTE_FACE_RESOLUTION = 0.5;
/** Only this many nearest classmates get a shadow and the ink outline (each is another full pass). */
const FULL_DETAIL = 10;
/** Crowd detail is re-ranked this often (ms), not every frame. */
const DETAIL_RANK_MS = 300;
/** Sent edits are remembered this long, so a refusal can be undone locally. */
const PENDING_MS = 10_000;

interface Remote {
  rig: CharacterRig;
  /** Latest reported position, absolute field coordinates. */
  target: THREE.Vector3;
  /** Smoothed render position, absolute. */
  pos: THREE.Vector3;
  /** Latest reported body heading. */
  yaw: number;
  /** Drawn heading, turning toward `yaw` (reports arrive at only 20 Hz). */
  drawnYaw: number;
  anim: ClassAnim;
  speed: number;
  seenAt: number;
  /** Received path on the server's clock (snapshot interpolation); empty with an older server. */
  track: RemoteTrack;
  /** Animation time not yet applied (far characters pose every few frames). */
  animDt?: number;
  /** Which frame of the LOD cycle this character poses on. */
  lodSlot?: number;
  /** Drawn with shadow + ink outline (one of the nearest few) or plain. */
  fullDetail?: boolean;
  swimming?: boolean;
  toolOption?:string;
  attacking?:boolean;
  /** Their swing time, run on our own clock and only ever moved FORWARD by a report:
   *  snapshots repeat the last phase they heard, and re-anchoring on a stale one
   *  rewound the stroke and played its blow twice. Undefined while not swinging. */
  toolClock?: number;
  /** Seconds the clock waits when a report says we ran well ahead (a pause, never a rewind). */
  toolHold?: number;
  /** Last drawn gait / dig / swing times, to sound the frame a foot plants or a blow lands. */
  cuePhase?: number;
  cueDig?: number;
  toolT?: number;
}

export interface ClassSyncHooks {
  /** The camera classmates are drawn for: off-screen ones are not drawn at all (crowd culling). */
  camera?(): THREE.Camera;
  /** Move the local player to grid coordinates (gather). */
  teleport(x: number, y: number, z: number): void;
  /** Lift the own robot out of the ground to the surface above it (the teacher's 땅 위로 올라오기). */
  rescue?(): void;
  /** Turn the player (body and view) to a heading — a seat faces the teacher. */
  face?(yaw: number): void;
  /** A class panel closed: capture the mouse again and go back to play. */
  resumePlay?(): void;
  /** The way the player looks (camera yaw): the teacher's plots go in front of the view. */
  viewYaw?(): number;
  /** Another panel owns the screen: the teacher's F2 tools wait. */
  panelBusy?(): boolean;
  toast(text: string): void;
  clearKeys(): void;
  worldChanged?(): void;
  /** A solid cell appeared at grid (x, y, z) from outside — a classmate's brick, a rolled-back edit:
   *  the player or pet standing in it must be moved out. */
  solidPlaced?(x: number, y: number, z: number): void;
  /** The shared furniture layout was replaced from outside: local undo history no longer applies. */
  furnitureReset?(): void;
  /** The furniture layout was replaced from the server: step anyone out of a piece that now stands on them. */
  furnitureMoved?(): void;
  /** The tap connected and we are the one who was hit. */
  bonked?(push: { vx: number; vz: number; vy: number }): void;
  /** The connect sound, for everyone who can see it, at the chest that was hit (grid metres). */
  impact?(x?: number, y?: number, z?: number): void;
  /** A lesson cue: an announcement arrived, or the class timer ran out. */
  chime?(kind: "announce" | "time"): void;
  /** Power plants from the server (science mode), in arrival order once the game runs. */
  plants?(msg: Extract<ClassServerMessage, { t: "s-k-plants" }>): void;
  /** A classmate's sound at a grid position (their steps, digs, blows, bricks). */
  sound?: (kind: ClassmateSound, family: string, x: number, y: number, z: number, wet?: boolean) => void;
}

export type ClassmateSound = "step" | "hit" | "break" | "place" | "swing";

function nameTag(name: string, teacher: boolean): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 30px system-ui, sans-serif";
  const label = (teacher ? "👩‍🏫 " : "") + name;
  const w = Math.min(248, ctx.measureText(label).width + 28);
  ctx.fillStyle = teacher ? "rgba(214,136,0,0.92)" : "rgba(20,22,28,0.72)";
  ctx.beginPath();
  ctx.roundRect((256 - w) / 2, 8, w, 48, 16);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 128, 33, 236);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, fog: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 2.35;
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * The classroom inside the game: everyone else's robot with a name tag, our
 * position and block edits out, theirs in, plus the teacher's gather/locks.
 * All network coordinates are ABSOLUTE field coordinates; this class is the
 * only place that converts to and from the local scrolling grid.
 */
export class ClassSync {
  private readonly session: Pick<ClassSession, "you" | "role">;
  readonly hud: ClassHud;
  private readonly remotes = new Map<string, Remote>();

  /** Is a classmate standing in this ABSOLUTE cell? The same box the server judges furniture with
   *  (on their last reported position), so a sofa on a friend is refused here, not rolled back. */
  bodyIn(x: number, y: number, z: number): boolean {
    for (const { target: p } of this.remotes.values()) {
      if (p.x + 0.3 > x && p.x - 0.3 < x + 1 && p.y + 1.8 > y && p.y < y + 1 && p.z + 0.3 > z && p.z - 0.3 < z + 1) return true;
    }
    return false;
  }
  private members: ClassMember[];
  private settings: ClassSettings;
  private readonly outbox: ClassEdit[] = [];
  private readonly pending = new Map<string, { prev: [number, number]; at: number }>();
  private moveTimer = 0;
  private online = true;
  private readonly tmp = new THREE.Vector3();
  /** The server's snapshot clock as seen over this link, shared by every remote's track. */
  private readonly snapClock = new SnapClock();
  /** Our own grid position (from the last tick): how far each classmate is, for animation LOD. */
  private meX = 0;
  private meZ = 0;
  private frameNo = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly bounds = new THREE.Sphere(new THREE.Vector3(), 1.4);
  private rankedAt = 0;
  private readonly pose: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0 };
  private readonly fx: BonkFx;
  /** The teacher's seating: booths with dividers and name signs (F2 → 자리 배치). */
  private readonly seating: SeatingView;
  /**
   * Things that act on the GAME (move the player, toast) wait for its first frame: the reliable
   * replay runs inside this constructor, while the game that hosts us is still being built — a
   * seat sent on join (s-k-gather) teleporting a half-built game failed the whole boot.
   */
  private started = false;
  private readonly early: (() => void)[] = [];
  private whenStarted(fn: () => void): void {
    if (this.started) fn();
    else this.early.push(fn);
  }

  /** The teacher's lesson tools on screen (timer, freeze card, announcements). */
  private readonly lesson: LessonOverlay;

  /** The plots as the server sent them (absolute), and whether students may leave theirs. */
  private seats: { name: string; pos: [number, number, number]; yaw: number }[] = [];
  private roam = false;

  constructor(
    readonly client: ClassClient,
    session: ClassSession,
    private readonly field: FieldWindow,
    private readonly view: VoxelView,
    private readonly scene: THREE.Scene,
    private readonly hooks: ClassSyncHooks,
    furniture: FurnitureLayout,
  ) {
    // The full initial edit array can contain 300,000 tuples. The field owns
    // the live state; retain only identity, not a second obsolete world copy.
    this.session = { you: session.you, role: session.role };
    this.fx = new BonkFx(scene);
    this.seating = new SeatingView(scene);
    this.lesson = new LessonOverlay(session.role, () => hooks.chime?.("time"));
    this.online = client.connected;
    this.members = session.members;
    this.settings = session.settings;
    field.replaceAll(session.edits);
    furniture.load(session.furniture);
    this.hud = new ClassHud(session.role, session.you, session.room, session.teacher, {
      chat: (text) => client.send({ t: "k-chat", text }),
      kick: (m) => client.send({ t: "k-kick", playerId: m.id }),
      gather: () => {
        client.send({ t: "k-gather" });
        hooks.toast(t("📣 학생들을 불렀어요", "📣 You called everyone over"));
      },
      roam: (on) => {
        client.send({ t: "k-arrange", roam: on });
        hooks.toast(on ? t("🚶 학생들이 자유롭게 돌아다닐 수 있어요", "🚶 The students may roam now") : t("🪑 학생들을 자기 자리로 돌려보냈어요", "🪑 The students are back on their plots"));
      },
      unarrange: () => {
        client.send({ t: "k-arrange", clear: true });
        hooks.toast(t("🧹 칸막이와 이름 팻말을 치웠어요", "🧹 Fences and name signs put away"));
      },
      arrange: () => {
        const yaw = hooks.viewYaw?.();
        client.send(yaw === undefined || !Number.isFinite(yaw) ? { t: "k-arrange" } : { t: "k-arrange", yaw });
        hooks.toast(t("🪑 학생마다 15×20칸 땅을 나눠 줬어요", "🪑 Every student got a 15×20 plot of their own"));
      },
      freeze: (on) => {
        client.send({ t: "k-lesson", freeze: on });
        hooks.toast(on ? t("✋ 학생들을 멈췄어요 — F2 → 5로 풀어요", "✋ The students are frozen — F2 → 5 lets them go") : t("▶️ 학생들이 다시 움직여요", "▶️ The students can move again"));
      },
      timer: (sec) => {
        client.send({ t: "k-lesson", timer: sec });
        if (sec === 0) hooks.toast(t("⏱️ 타이머를 껐어요", "⏱️ Timer stopped"));
      },
      announce: (text) => client.send({ t: "k-announce", text }),
      visit: (m) => this.visit(m),
      toolsOpen: (open, resume) => {
        hooks.clearKeys();
        if (open) document.exitPointerLock();
        else if (resume) hooks.resumePlay?.();
      },
      busy: () => hooks.panelBusy?.() ?? false,
      settings: (next) => client.send({ t: "k-settings", ...next }),
      end: () => client.send({ t: "k-end" }),
      resetWorld: () => client.send({ t: "k-reset-world" }),
      drainWater: () => client.send({ t: "k-drain-water" }),
      plot: (m, op) => client.send({ t: "k-plot", name: m.name, op }),
      rescue: () => hooks.rescue?.(),
      typing: () => hooks.clearKeys(),
    });
    this.hud.setMembers(this.members);
    this.hud.setSettings(this.settings);
    this.hud.setOnline(this.online);

    client.onMembers = (members) => {
      this.members = members;
      this.hud.setMembers(members);
      for (const id of [...this.remotes.keys()]) {
        if (!members.some((m) => m.id === id && m.online)) this.dropRemote(id);
      }
    };
    client.onSnap = (players, ts) => this.applySnap(players, ts);
    client.onEdit = (edits, by) => this.applyEdits(edits, by);
    client.onWet = (cells) => {
      for (const [ax, y, az, water] of cells) {
        const cell = field.applyWet(ax, y, az, water);
        if (cell) view.markWaterDirty(cell[0], cell[1], cell[2]);
      }
    };
    client.onFurniture = (items, rejected) => {
      furniture.load(items, true);
      hooks.furnitureMoved?.();
      if (rejected) hooks.furnitureReset?.();
      if (rejected) hooks.toast(t("🛋️ 다른 변경이나 건축 잠금 때문에 가구 작업을 적용하지 못했어요", "🛋️ That furniture change didn't go through (someone else changed it, or building is locked)"));
    };
    client.onReject = (edits, authoritative) => this.undo(edits, authoritative);
    client.onChat = (msg) => this.hud.chat(msg.name, msg.role, msg.text, msg.system);
    client.onSettings = (settings) => {
      const was = this.settings;
      this.settings = settings;
      this.hud.setSettings(settings);
      if (this.session.role === "student") {
        if ((settings.tapsLocked ?? false) !== (was.tapsLocked ?? false))
          hooks.toast(settings.tapsLocked ? t("👋 선생님이 친구 밀기를 껐어요", "👋 The teacher turned friend taps off") : t("👋 다시 친구를 살짝 밀 수 있어요", "👋 Friend taps are back on"));
        if ((settings.plantsLocked ?? false) !== (was.plantsLocked ?? false))
          hooks.toast(settings.plantsLocked ? t("⚡ 선생님이 발전소 짓기를 잠갔어요", "⚡ The teacher locked power plants") : t("⚡ 다시 발전소를 지을 수 있어요", "⚡ You can build power plants again"));
        if (settings.buildLocked !== was.buildLocked)
          hooks.toast(settings.buildLocked ? t("🧱 선생님이 건축을 잠갔어요", "🧱 The teacher locked building") : t("🧱 다시 건축할 수 있어요", "🧱 You can build again"));
        if (settings.chatLocked !== was.chatLocked)
          hooks.toast(settings.chatLocked ? t("💬 선생님이 채팅을 잠갔어요", "💬 The teacher locked the chat") : t("💬 다시 채팅할 수 있어요", "💬 You can chat again"));
      }
    };
    client.onBonk = (msg) => this.applyBonk(msg);
    client.onSeats = (seats, roam) => {
      const wasKept = this.keptIn();
      const wasRoam = this.roam;
      this.seats = seats;
      this.roam = roam;
      this.seating.set(seats);
      this.hud.setSeated(seats.length > 0, roam, seats.map((x) => x.name));
      // tell a student when the TEACHER lets them out or calls them back (a new seating or our own
      // plot appearing has its own toast with the seat — never two at once)
      if (this.session.role === "student" && seats.length > 0 && wasRoam !== roam) {
        const kept = this.keptIn();
        if (wasKept && !kept) this.whenStarted(() => hooks.toast(t("🚶 이제 자유롭게 돌아다닐 수 있어요", "🚶 You may roam now")));
        else if (!wasKept && kept) this.whenStarted(() => hooks.toast(t("🪑 자기 자리로 — 선생님이 풀어 줄 때까지 울타리 안에서 움직여요", "🪑 Back to your plot — stay inside the fence until the teacher lets you out")));
      }
    };
    client.onLesson = (lesson) => {
      const was = this.lesson.frozen;
      this.lesson.set(lesson);
      this.hud.setLesson(lesson);
      if (lesson.frozen && !was && this.session.role === "student") this.whenStarted(() => hooks.clearKeys());
    };
    // after the first frame, in order: science mode draws them over the world the game has built
    client.onPlants = (msg) => this.whenStarted(() => hooks.plants?.(msg));
    client.onAnnounce = (text) => {
      this.lesson.announce(text);
      this.hud.chat("", "teacher", `📢 ${text}`, true);
      this.whenStarted(() => hooks.chime?.("announce"));
    };
    client.onGather = ([ax, y, az], yaw, nudge) => this.whenStarted(() => {
      const [x, z] = field.toGrid(ax, az);
      if (nudge) {
        // strayed past our fence: back just inside it, same facing, no fuss
        hooks.teleport(x, y + 0.05, z);
        return;
      }
      if (yaw !== undefined) {
        // a seat: exactly this spot, facing the teacher
        hooks.teleport(x, y + 0.5, z);
        hooks.face?.(yaw);
        hooks.toast(t("🪑 내 자리를 받았어요 — 이름 팻말이 있는 15×20칸 땅이에요", "🪑 You got your own plot — the 15×20 one with your name sign"));
        return;
      }
      // fan out around the teacher instead of stacking in one cell
      const angle = Math.random() * Math.PI * 2;
      hooks.teleport(x + Math.cos(angle) * 2.5, y + 0.5, z + Math.sin(angle) * 2.5);
      hooks.toast(t("📣 선생님이 불렀어요!", "📣 The teacher called you over!"));
    });
    client.onWaterDrained = () => {
      field.drainWater();
      // Unsent pours and old rollback values must not bring the drained water back.
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        if (isWater(this.outbox[i]![3])) this.outbox.splice(i, 1);
      }
      for (const p of this.pending.values()) if (isWater(p.prev[0])) p.prev = [0, 0];
      view.drainWater();
      hooks.toast(t("💧 반 전체의 물을 모두 뺐어요", "💧 All water in the class field has been drained"));
    };
    client.onWorldReset = () => {
      field.replaceAll([]);
      furniture.clear();
      hooks.furnitureReset?.();
      this.pending.clear();
      this.outbox.length = 0;
      view.markDirty();
      hooks.worldChanged?.();
      hooks.toast(t("🧹 들판이 새로 비워졌어요", "🧹 The field has been cleared"));
    };
    client.onConnection = (online) => {
      this.online = online;
      this.hud.setOnline(online);
    };
    client.onResync = (fresh) => {
      this.session.you = fresh.you;
      this.session.role = fresh.role;
      this.hud.setYou(fresh.you);
      for (const id of [...this.remotes.keys()]) this.dropRemote(id);
      // the server restarted and the class was opened afresh: say so instead
      // of silently swapping everyone's buildings for an empty field
      if (fresh.edits.length === 0 && field.hasEdits()) hooks.toast(t("⚠️ 서버가 다시 시작되어 반이 새로 열렸어요", "⚠️ The server restarted, so the class was opened fresh"));
      // the server's field wins: anything sent while offline never landed
      field.replaceAll(fresh.edits);
      furniture.load(fresh.furniture, true);
      hooks.furnitureMoved?.();
      hooks.furnitureReset?.();
      this.pending.clear();
      this.outbox.length = 0;
      view.markDirty();
      this.members = fresh.members;
      this.hud.setMembers(fresh.members);
      this.settings = fresh.settings;
      this.hud.setSettings(fresh.settings);
      hooks.worldChanged?.();
    };
    client.onEnded = (reason) => {
      this.online = false;
      for (const id of [...this.remotes.keys()]) this.dropRemote(id);
      hooks.clearKeys();
      this.hud.showEnded(
        reason === "kicked"
          ? t("선생님이 수업에서 내보냈어요.", "The teacher removed you from the class.")
          : reason === "replaced"
            ? t("다른 탭(또는 다른 기기)에서 같은 이름으로 이 반에 들어왔어요. 이 화면은 연결을 끝냈어요.", "You joined this class from another tab or device, so this one has been disconnected.")
          : reason === "closed"
            ? this.session.role === "teacher"
              ? t("수업을 마쳤어요. 모든 학생의 연결이 끝났어요.", "Class ended. Every student has been disconnected.")
              : t("선생님이 수업을 마쳤어요. 수고했어요!", "The teacher ended the class. Great work!")
            : reason === "no-class"
              ? t("서버가 다시 시작되어 수업이 끝났어요. 선생님이 반을 다시 열면 참여해 주세요.", "The server restarted and the class ended. Join again once the teacher reopens it.")
            : t("연결이 끝났어요. 다시 참여해 주세요.", "You were disconnected. Please join again."),
      );
    };
    client.activate(); // replay reliable edits that arrived during world/graphics setup
  }

  /** This student is kept on their plot right now (a seating stands, roaming is off, it has one). */
  private keptIn(): boolean {
    return this.myPlot() !== null;
  }

  private myPlot(): { name: string; pos: [number, number, number]; yaw: number } | null {
    if (this.session.role !== "student" || this.roam || this.seats.length === 0) return null;
    const me = this.members.find((m) => m.id === this.session.you)?.name;
    if (!me) return null;
    // the server's own name rule (case/space-insensitive): the plot it gave is found the same way
    const key = classKey(me);
    return this.seats.find((s) => classKey(s.name) === key) ?? null;
  }

  /**
   * Where this student may stand right now, in GRID coordinates ([minX, maxX, minZ, maxZ]), or null
   * when free: their own plot while the teacher keeps the class on its plots. The game clamps the
   * body into it after every physics step (the fence holds them); the server pulls back anything
   * that still gets out (an older page, a shove).
   */
  confineBox(): [number, number, number, number] | null {
    // not before our first frame: the seat teleport sent on join waits for it (whenStarted), and
    // clamping first would drag the body from its spawn to the plot's edge, into whatever is there
    if (!this.started) return null;
    const plot = this.myPlot();
    if (!plot) return null;
    const [x0, x1, z0, z1] = plotBounds(plot);
    const [gx0, gz0] = this.field.toGrid(x0, z0);
    const [gx1, gz1] = this.field.toGrid(x1, z1);
    return [Math.min(gx0, gx1), Math.max(gx0, gx1), Math.min(gz0, gz1), Math.max(gz0, gz1)];
  }

  /** May we change the cell at grid (x, z)? A student kept on their plot only changes their own
   *  plot's cells (the server refuses the rest — checking here first means no optimistic edit that
   *  pops back a moment later). */
  canEditAt(x: number, z: number): boolean {
    const box = this.confineBox();
    if (!box) return true;
    const e = 1e-6;
    return x >= box[0] - e && x + 1 <= box[1] + e && z >= box[2] - e && z + 1 <= box[3] + e;
  }

  /** Our own name in the class (plants are owned by name). */
  get myName(): string {
    return this.members.find((m) => m.id === this.session.you)?.name ?? "";
  }

  /** A power-plant change for the server (science mode). */
  sendPlant(op: Omit<Extract<ClassClientMessage, { t: "k-plant" }>, "t">): void {
    this.client.send({ t: "k-plant", ...op });
  }

  /** May we change an ABSOLUTE cell (x, z)? `canEditAt` in absolute coordinates. */
  canEditAbs(x: number, z: number): boolean {
    const [gx, gz] = this.field.toGrid(x, z);
    return this.canEditAt(gx, gz);
  }

  /** The teacher's F2 class-tools panel is up (it owns the screen like the bag). */
  get toolsOpen(): boolean {
    return this.hud.toolsOpen;
  }

  get role(): "teacher" | "student" {
    return this.session.role;
  }

  /** Students can't touch blocks while the teacher has building locked (or the class frozen). */
  /** The teacher turned pets off for this class. */
  get petsOff(): boolean { return this.settings.petsOff === true; }
  /** Students may not build power plants right now (the teacher's own may). */
  get plantsLocked(): boolean { return this.settings.plantsLocked === true && this.session.role === "student"; }

  canBuild(): boolean {
    return this.online && (this.session.role === "teacher" || (!this.settings.buildLocked && !this.lesson.frozen));
  }

  /** The teacher froze the class (모두 멈춰) and we are a student: no moving, building or taps. */
  get frozen(): boolean {
    return this.session.role === "student" && this.lesson.frozen;
  }

  /** The teacher goes to a student: 3 m in front of them, facing them (they see the teacher arrive
   *  and the teacher sees their face and what they are building). */
  private visit(member: ClassMember): void {
    const r = this.remotes.get(member.id);
    if (!r) {
      this.hooks.toast(t(`📍 ${member.name} 학생의 위치를 아직 몰라요 — 잠시 후 다시 해 봐요`, `📍 ${member.name}'s position hasn't arrived yet — try again in a moment`));
      return;
    }
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    const [x, z] = this.field.toGrid(r.target.x + fx * 3, r.target.z + fz * 3);
    this.hooks.teleport(x, r.target.y + 0.5, z);
    this.hooks.face?.(r.yaw + Math.PI);
    this.hooks.toast(t(`👀 ${member.name} 학생에게 왔어요`, `👀 You're at ${member.name}'s side`));
  }

  /** A local block change (grid coordinates) — queue it for the class. */
  recordEdit(x: number, y: number, z: number, prevBlock: number, prevShape: number, block: number, shape: number): void {
    const [ax, az] = this.field.toAbsolute(x, z);
    const key = `${ax},${y},${az}`;
    if (!this.pending.has(key)) this.pending.set(key, { prev: [prevBlock, prevShape], at: performance.now() });
    this.outbox.push([ax, y, az, block, shape]);
  }

  flushEdits(): void {
    while (this.outbox.length > 0) {
      if (!this.client.send({ t: "k-edit", edits: this.outbox.slice(0, 8) })) break;
      this.outbox.splice(0, 8);
    }
  }

  /** Per fixed tick: flush edits, report position, glide remote robots. */
  tick(dt: number, body: { x: number; y: number; z: number }, yaw: number, anim: ClassAnim, presentation?: CharacterPresentation): void {
    this.meX = body.x;
    this.meZ = body.z;
    this.flushEdits();
    const now = performance.now();
    for (const [key, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(key);

    this.moveTimer += dt;
    if (this.moveTimer >= 1 / MOVE_HZ) {
      // carry the remainder: resetting to 0 sent every 7th tick (8.6 Hz), not every 6th
      this.moveTimer = Math.min(this.moveTimer - 1 / MOVE_HZ, 1 / MOVE_HZ);
      this.sendMove(body, yaw, anim, presentation);
    }
  }

  /** Send the position now, so a tap is judged against where we actually are. */
  reportNow(body: { x: number; y: number; z: number }, yaw: number, anim: ClassAnim, presentation?: CharacterPresentation): void {
    this.moveTimer = 0;
    this.sendMove(body, yaw, anim, presentation);
  }

  /** False while the teacher has taps switched off: a click on a classmate digs as usual. */
  get tapsAllowed(): boolean {
    return this.settings.tapsLocked !== true && !this.frozen;
  }

  sendBonk(target: string, yaw: number, pitch: number, seq: number): void {
    this.client.send({ t: "k-bonk", target, yaw, pitch, seq });
  }

  /** Classmates in local grid metres, where the player is drawn. */
  bonkTargets(): BonkCandidate[] {
    const out: BonkCandidate[] = [];
    for (const [id, remote] of this.remotes) {
      if (!remote.rig.root.visible) continue;
      const [x, z] = this.field.toGrid(remote.pos.x, remote.pos.z);
      out.push({ id, x, y: remote.pos.y, z });
    }
    return out;
  }

  /** Would a block in this GRID cell land inside a classmate? Checked against both where they are
   *  drawn (~0.1 s behind) and where they last reported, with a slightly widened body. A brick
   *  dropped on someone used to bury them, and their client then popped them up out of it —
   *  players felt "flung" whenever they stood close. */
  bodyInGridCell(x: number, y: number, z: number, shape: number): boolean {
    for (const remote of this.remotes.values()) {
      for (const p of [remote.pos, remote.target]) {
        const [rx, rz] = this.field.toGrid(p.x, p.z);
        if (Math.abs(rx - x - 0.5) > 1.5 || Math.abs(rz - z - 0.5) > 1.5 || Math.abs(p.y - y) > 2.5) continue;
        if (overlapsShapedVoxel({ x: rx, y: p.y, z: rz, vx: 0, vy: 0, vz: 0, grounded: true, w: BODY_WIDTH + 0.16 }, x, y, z, shape)) return true;
      }
    }
    return false;
  }

  /** The field window scrolled under the player. */
  shift(dx: number, dz: number): void {
    this.fx.shift(dx, dz);
  }

  private sendMove(body: { x: number; y: number; z: number }, yaw: number, anim: ClassAnim, presentation?: CharacterPresentation): void {
    const [ax, az] = this.field.toAbsolute(body.x, body.z);
    this.client.send({ t: "k-move", pos: [ax, body.y, az], yaw, anim, ct: Math.round(performance.now()), ...presentation });
  }

  private applyBonk(msg: Extract<ClassServerMessage, { t: "s-k-bonk" }>): void {
    if (msg.target === this.session.you) this.hooks.bonked?.({ vx: msg.vx, vz: msg.vz, vy: msg.vy });
    else this.remotes.get(msg.target)?.rig.flashHit();
    if (msg.by !== this.session.you) this.remotes.get(msg.by)?.rig.performAction("hit", msg.seq, false);
    const remote = this.remotes.get(msg.target);
    remote?.rig.pop(-1.3);
    const [x, z] = this.field.toGrid(msg.at[0], msg.at[2]);
    this.fx.burst(x, msg.at[1], z, msg.vx, msg.vz);
    // the tapper already heard it on their own swing's contact frame
    if (msg.by !== this.session.you) this.hooks.impact?.(x, msg.at[1], z);
  }

  /** Per rendered frame: place remote robots in local grid space. */
  render(frameDt: number): void {
    this.frameNo++;
    if (!this.started) {
      // the game is whole now: what arrived while it was being built happens here, in order
      this.started = true;
      for (const fn of this.early.splice(0)) fn();
    }
    this.seating.update((ax, az) => this.field.toGrid(ax, az));
    const camera = this.hooks.camera?.();
    if (camera) {
      camera.updateMatrixWorld();
      this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewProj);
    }
    if (!this.online) {
      for (const r of this.remotes.values()) r.rig.root.visible = false;
      this.fx.update(frameDt); // tap chips in flight finish instead of freezing mid-air
      return;
    }
    const k = 1 - Math.pow(0.0005, frameDt); // ~100 ms catch-up
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (now - r.seenAt > 3000) {
        r.rig.root.visible = false;
        continue;
      }
      if (!r.track.empty && r.track.draw(this.snapClock.renderTime(now), frameDt * 1000, this.pose)) {
        // drawn a moment in the past, between two received samples: late or bunched
        // packets change nothing visible (craft/remoteTrack.ts)
        r.pos.set(this.pose.x, this.pose.y, this.pose.z);
        r.speed = this.pose.speed;
        r.yaw = this.pose.yaw;
      } else {
        // an older server (no stamps): chase the latest report
        const before = this.tmp.copy(r.pos);
        // a teleport/gather snaps instead of sliding across the map
        if (r.pos.distanceToSquared(r.target) > 64) r.pos.copy(r.target);
        else r.pos.lerp(r.target, k);
        r.speed = frameDt > 0 ? Math.hypot(r.pos.x - before.x, r.pos.z - before.z) / frameDt : 0;
      }
      const [x, z] = this.field.toGrid(r.pos.x, r.pos.z);
      r.rig.root.position.set(x, r.pos.y, z);
      // Crowd culling: characters are skinned with frustum culling off (their bounds move
      // with the animation), so an off-screen classmate still cost its main, ink and shadow
      // passes. Cull here with a sphere that holds any pose; the path still advances.
      this.bounds.center.set(x, r.pos.y + 0.9, z);
      const onScreen = !camera || this.frustum.intersectsSphere(this.bounds);
      r.rig.root.visible = onScreen;
      if (!onScreen) {
        r.animDt = (r.animDt ?? 0) + frameDt;
        continue;
      }
      r.drawnYaw = turnToward(r.drawnYaw, r.yaw, frameDt, 0.06, 20);
      r.rig.root.rotation.y = r.drawnYaw;
      let toolTime: number | undefined;
      if (r.attacking && r.toolClock !== undefined) {
        const wait = Math.min(r.toolHold ?? 0, frameDt);
        r.toolHold = (r.toolHold ?? 0) - wait;
        r.toolClock += frameDt - wait;
        toolTime = r.toolClock;
      }
      // Animation LOD: a skinned character costs the same CPU at 80 m as at 3 m. Far ones
      // pose every 3rd / 6th frame with the time they missed (positions still move every frame),
      // staggered by id so the work spreads across frames instead of landing together.
      const dist = Math.hypot(x - this.meX, z - this.meZ);
      const every = dist > LOD_FAR_M ? 3 : dist > LOD_MID_M ? 2 : 1;
      r.animDt = (r.animDt ?? 0) + frameDt;
      if (every === 1 || r.attacking || (this.frameNo + (r.lodSlot ??= Math.floor(Math.random() * 6))) % every === 0) {
        r.rig.update(r.anim, r.speed, r.animDt,{swimming:r.swimming,toolTime});
        r.animDt = 0;
      }
      this.remoteSounds(r, x, z, toolTime);
    }
    if (now - this.rankedAt > DETAIL_RANK_MS) {
      this.rankedAt = now;
      this.rankDetail();
    }
    this.fx.update(frameDt);
  }

  private warmRig: CharacterRig | null = null;

  /**
   * Boot warm-up (behind the loading screen): one stand-in classmate — a character at the
   * classmates' face resolution with a name tag — drawn beside the player, so the one-time
   * cost of the first classmate on screen (measured as a ~80 ms frame) is paid while loading,
   * not the moment somebody walks into view.
   */
  warm(on: boolean, at?: { x: number; y: number; z: number }): void {
    if (on && !this.warmRig && at) {
      const rig = new CharacterRig("mascot", REMOTE_FACE_RESOLUTION);
      rig.root.add(nameTag(" ", false));
      rig.root.position.set(at.x + 1, at.y, at.z + 1);
      rig.update("idle", 0, 1 / 60);
      this.scene.add(rig.root);
      this.warmRig = rig;
    } else if (!on && this.warmRig) {
      this.scene.remove(this.warmRig.root);
      disposeRig(this.warmRig.root);
      this.warmRig = null;
    }
  }

  /**
   * Detail tiers: the nearest FULL_DETAIL on-screen classmates keep their shadow and ink
   * outline; the rest of a big class are drawn plain (one pass instead of three). Changes
   * only flip flags and layers — no material or shader variant switches.
   */
  private rankDetail(): void {
    // hysteresis: whoever has full detail keeps it until someone is clearly (1.5 m) nearer — a
    // seated class stands at near-equal distances, and a plain ranking flipped their shadows
    // (and ink) on and off every frame as the viewer moved
    const shown = [...this.remotes.values()].filter((r) => r.rig.root.visible)
      .map((r) => ({ r, d: Math.hypot(r.rig.root.position.x - this.meX, r.rig.root.position.z - this.meZ) - (r.fullDetail ? 1.5 : 0) }))
      .sort((a, b) => a.d - b.d);
    shown.forEach(({ r }, i) => {
      const full = i < FULL_DETAIL;
      if (r.fullDetail === full) return;
      r.fullDetail = full;
      r.rig.setDetail(full);
    });
  }

/** The surface family of the solid block at absolute (ax, y, az), or null for air/water. */
  private familyAt(ax: number, y: number, az: number): string | null {
    const [id] = this.field.cellAt(Math.floor(ax), Math.floor(y), Math.floor(az));
    if (!id || SOLID_ID[id] === 0) return null;
    const def = blockById(id);
    return def ? surfaceStyle(def.key).family : null;
  }

  /** What a classmate is hitting: the first solid cell in front of them at waist or foot height. */
  private facedFamily(r: Remote): string | null {
    const fx = Math.sin(r.drawnYaw), fz = Math.cos(r.drawnYaw);
    for (const reach of [0.9, 1.6]) for (const h of [0.6, 0.1, 1.2]) {
      const fam = this.familyAt(r.pos.x + fx * reach, r.pos.y + h, r.pos.z + fz * reach);
      if (fam) return fam;
    }
    return null;
  }

  /**
   * A classmate's steps, digs and pickaxe blows, from the same drawn motion
   * that makes ours (CharacterRig.motionCue / the tool time): heard where they
   * stand, quieter with distance, panned by direction (CraftGame forwards to Sfx.at).
   */
  private remoteSounds(r: Remote, gx: number, gz: number, toolTime: number | undefined): void {
    const sound = this.hooks.sound;
    if (!sound) return;
    const cue = r.rig.motionCue;
    const crossed = (prev: number | undefined, cur: number, at: number) => prev !== undefined && prev >= 0 && (prev <= cur ? prev < at && at <= cur : prev < at || at <= cur);
    if (cue?.gait && r.speed > 0.3 && !r.swimming && (r.anim === "run" || r.anim === "idle" || r.anim === "crawl")) {
      const plants = cue.gait === "crawl" ? [0.44, 0.94] : [0, 0.5];
      if (plants.some((p) => crossed(r.cuePhase, cue.phase, p))) {
        const fam = this.familyAt(r.pos.x, r.pos.y - 0.05, r.pos.z);
        if (fam) sound("step", fam, gx, r.pos.y, gz);
      }
      r.cuePhase = cue.phase;
    } else r.cuePhase = -1;
    if (cue?.digPhase != null) {
      if (crossed(r.cueDig, cue.digPhase, 0.5)) { const fam = this.facedFamily(r); if (fam) sound("hit", fam, gx, r.pos.y + 0.6, gz); }
      r.cueDig = cue.digPhase;
    } else r.cueDig = -1;
    if (toolTime !== undefined) {
      const prev = r.toolT ?? toolTime;
      const cycle = pickaxeCycle(r.toolOption);
      if (toolTime > prev && Math.floor(prev / cycle - PICKAXE.swing.impactAt + 0.2) !== Math.floor(toolTime / cycle - PICKAXE.swing.impactAt + 0.2)) sound("swing", "", gx, r.pos.y + 1, gz);
      if (pickaxeImpacts(prev, toolTime, r.toolOption) > 0) { const fam = this.facedFamily(r); if (fam) sound("hit", fam, gx, r.pos.y + 0.6, gz); }
      r.toolT = toolTime;
    } else r.toolT = undefined;
  }

  private applySnap(players: Extract<ClassServerMessage, {t: "s-k-snap"}>["players"], ts?: number): void {
    const now = performance.now();
    const stamp = ts === undefined ? undefined : this.snapClock.observe(now, ts);
    for (const p of players) {
      if (p.id === this.session.you) continue;
      let r = this.remotes.get(p.id);
      if (!r) {
        const member = this.members.find((m) => m.id === p.id);
        if (!member) continue;
        const rig = new CharacterRig("mascot", REMOTE_FACE_RESOLUTION);
        rig.root.add(nameTag(member.name, member.role === "teacher"));
        this.scene.add(rig.root);
        r = {
          rig,
          target: new THREE.Vector3(...p.pos),
          pos: new THREE.Vector3(...p.pos),
          yaw: p.yaw,
          drawnYaw: p.yaw,
          anim: p.anim,
          speed: 0,
          seenAt: now,
          track: new RemoteTrack(),
        };
        this.remotes.set(p.id, r);
      }
      r.rig.setCharacter(p.character ?? "mascot");
      r.rig.setHeldItem(p.heldItem??null,p.toolOption??PICKAXE.defaultOption);
      this.followSwing(r, !!p.heldItem && p.action === "interact", p.toolPhase ?? 0, p.toolOption);
      r.rig.setEmote(p.emote ?? "none", p.emoteSeq ?? 0);
      r.rig.performAction(p.action??"none",p.actionSeq??0,p.actionLoop??false);
      r.swimming=p.swimming;
      r.target.set(...p.pos);
      r.yaw = p.yaw;
      // the position's own arrival time when the server sends it (moves and snapshots tick out of
      // phase: stamping with the snapshot time stalled then leapt), else the snapshot's
      if (stamp !== undefined) r.track.push(p.at ?? stamp, p.pos[0], p.pos[1], p.pos[2], p.yaw, p.at !== undefined && ts !== undefined ? ts - p.at : 0);
      r.anim = p.anim;
      r.seenAt = now;
    }
  }

  /** Steer a classmate's swing clock toward a report without ever winding it back (see Remote.toolClock). */
  private followSwing(r: Remote, attacking: boolean, phase: number, option: string | undefined): void {
    const cycle = pickaxeCycle(option);
    if (!attacking) r.toolClock = undefined;
    else if (r.toolClock === undefined || !r.attacking || option !== r.toolOption) {
      r.toolClock = phase * cycle;
      r.toolHold = 0;
    } else {
      let d = phase - (r.toolClock / cycle) % 1;
      d -= Math.round(d); // the short way round the stroke, in (-0.5, 0.5]
      if (d > 0) { r.toolClock += d * cycle; r.toolHold = 0; } // behind: catch up
      else if (d < -0.3) r.toolHold = -d * cycle; // far ahead: wait for them (a stale report is a small lag, ignored)
    }
    r.attacking = attacking;
    r.toolOption = option;
  }

  private applyEdits(edits: ClassEdit[], by = ""): void {
    // a classmate's bricks are heard where they land; the server's water ("") and our own echoes are silent,
    // and a big stamp or a field reset sounds once, not hundreds of times
    let voiced = 0;
    const voice = by !== "" && by !== this.session.you && edits.length <= 32;
    for (const [ax, y, az, block, shape] of edits) {
      this.pending.delete(`${ax},${y},${az}`); // someone else's write supersedes ours
      const [prev] = this.field.cellAt(ax, y, az);
      const was = voice && voiced < 2 ? this.familyAt(ax, y, az) : null;
      const cell = this.field.applyRemote(ax, y, az, block, shape);
      if (!cell) continue;
      if (voice && voiced < 2) {
        const now = this.familyAt(ax, y, az);
        if (was && !now) { this.hooks.sound?.("break", was, cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5); voiced++; }
        else if (!was && now) { this.hooks.sound?.("place", now, cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5); voiced++; }
      }
      // the server's water flowing (water ↔ air) never changes a brick
      if (SOLID_ID[prev] === 0 && SOLID_ID[block] === 0) this.view.markWaterDirty(cell[0], cell[1], cell[2]);
      else { this.view.markCellDirty(cell[0], cell[1], cell[2]); this.view.markWaterDirty(cell[0], cell[1], cell[2]); }
      if (SOLID_ID[prev] === 0 && SOLID_ID[block] !== 0) this.hooks.solidPlaced?.(cell[0], cell[1], cell[2]);
    }
  }

  private undo(edits: ClassEdit[], authoritative: boolean): void {
    for (const [ax, y, az, block, shape] of edits) {
      const key = `${ax},${y},${az}`;
      const p = this.pending.get(key);
      if (!p && !authoritative) continue;
      this.pending.delete(key);
      const restored = authoritative ? block : p!.prev[0];
      const cell = this.field.applyRemote(ax, y, az, restored, authoritative ? shape : p!.prev[1]);
      if (cell) {
        this.view.markCellDirty(cell[0], cell[1], cell[2]); this.view.markWaterDirty(cell[0], cell[1], cell[2]);
        if (SOLID_ID[restored] !== 0) this.hooks.solidPlaced?.(cell[0], cell[1], cell[2]); // a refused dig puts the block back: maybe on us
      }
    }
    if (this.session.role === "student" && this.settings.buildLocked) this.hooks.toast(t("🧱 지금은 건축이 잠겨 있어요", "🧱 Building is locked right now"));
  }

  private dropRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.rig.root);
    disposeRig(r.rig.root);
    this.remotes.delete(id);
  }

  debug() {
    return {
      role: this.session.role,
      you: this.session.you,
      online: this.online,
      settings: this.settings,
      /** Plots drawn (fences and name signs). */
      seating: this.seating.count,
      /** The plots as the server sent them (absolute), whether students may roam, and whether WE are kept in. */
      plots: this.seats.map((x) => ({ name: x.name, pos: x.pos })),
      roam: this.roam,
      kept: this.keptIn(),
      /** The lesson overlay as drawn (timer text, freeze card, announcement). */
      lesson: this.lesson.state(),
      toolsOpen: this.hud.toolsOpen,
      canBuild: this.canBuild(),
      members: this.members.map((m) => ({ name: m.name, role: m.role, online: m.online })),
      remotes: [...this.remotes.entries()].map(([id, r]) => ({
        id,
        name: this.members.find((m) => m.id === id)?.name,
        visible: r.rig.root.visible,
        /** Meshes actually drawn inside the robot (a blink INSIDE the model shows here). */
        meshes: (() => { let n = 0; r.rig.root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) n++; }); return n; })(),
        abs: [r.target.x, r.target.y, r.target.z],
        drawn: [r.pos.x, r.pos.y, r.pos.z],
        // the upper-body layer it plays (homeRig.ts: "Upper/Interact" while digging); the model
        // inside CharacterRig's stable root carries it
        upper: r.rig.root.children.find((c) => c.userData.upperMotion !== undefined)?.userData.upperMotion as string | undefined,
      })),
    };
  }

  dispose(): void {
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.fx.dispose();
    this.seating.dispose();
    this.lesson.dispose();
    this.hud.dispose();
    this.client.close();
    this.pending.clear(); this.outbox.length = 0; this.members = [];
  }
}
