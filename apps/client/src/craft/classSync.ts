import {pickaxeCycle,pickaxeImpacts,PICKAXE} from "./toolDefinitions.js";
import { surfaceStyle } from "./blockMaterials.js";
import type { FurnitureLayout } from "./furniture/layout.js";
import * as THREE from "three";
import type { ClassEdit, ClassMember, ClassSettings, ClassAnim, ClassServerMessage, CharacterPresentation, BonkCandidate } from "@robo/shared";
import { BonkFx } from "./bonkFx.js";
import { CharacterRig, disposeRig } from "../player/rig.js";
import type { ClassClient, ClassSession } from "../net/classClient.js";
import { ClassHud } from "./classHud.js";
import { turnToward } from "./smoothing.js";
import { SOLID_ID, blockById } from "./blocks.js";
import type { FieldWindow } from "./fieldWorld.js";
import type { VoxelView } from "./voxelView.js";
import { t } from "../ui/i18n.js";

const MOVE_HZ = 10;
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
  swimming?: boolean;
  toolPhase?:number;
  toolOption?:string;
  attacking?:boolean;
  /** Last drawn gait / dig / swing times, to sound the frame a foot plants or a blow lands. */
  cuePhase?: number;
  cueDig?: number;
  toolT?: number;
}

export interface ClassSyncHooks {
  /** Move the local player to grid coordinates (gather). */
  teleport(x: number, y: number, z: number): void;
  toast(text: string): void;
  clearKeys(): void;
  worldChanged?(): void;
  /** The tap connected and we are the one who was hit. */
  bonked?(push: { vx: number; vz: number; vy: number }): void;
  /** The connect sound, for everyone who can see it, at the chest that was hit (grid metres). */
  impact?(x?: number, y?: number, z?: number): void;
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
  private members: ClassMember[];
  private settings: ClassSettings;
  private readonly outbox: ClassEdit[] = [];
  private readonly pending = new Map<string, { prev: [number, number]; at: number }>();
  private moveTimer = 0;
  private online = true;
  private readonly tmp = new THREE.Vector3();
  private readonly fx: BonkFx;

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
      settings: (next) => client.send({ t: "k-settings", ...next }),
      end: () => client.send({ t: "k-end" }),
      resetWorld: () => client.send({ t: "k-reset-world" }),
      typing: () => hooks.clearKeys(),
    });
    this.hud.setMembers(this.members);
    this.hud.setSettings(this.settings);

    client.onMembers = (members) => {
      this.members = members;
      this.hud.setMembers(members);
      for (const id of [...this.remotes.keys()]) {
        if (!members.some((m) => m.id === id && m.online)) this.dropRemote(id);
      }
    };
    client.onSnap = (players) => this.applySnap(players);
    client.onEdit = (edits, by) => this.applyEdits(edits, by);
    client.onFurniture = (items, rejected) => {
      furniture.load(items, true);
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
        if (settings.buildLocked !== was.buildLocked)
          hooks.toast(settings.buildLocked ? t("🧱 선생님이 건축을 잠갔어요", "🧱 The teacher locked building") : t("🧱 다시 건축할 수 있어요", "🧱 You can build again"));
        if (settings.chatLocked !== was.chatLocked)
          hooks.toast(settings.chatLocked ? t("💬 선생님이 채팅을 잠갔어요", "💬 The teacher locked the chat") : t("💬 다시 채팅할 수 있어요", "💬 You can chat again"));
      }
    };
    client.onBonk = (msg) => this.applyBonk(msg);
    client.onGather = ([ax, y, az]) => {
      const [x, z] = field.toGrid(ax, az);
      // fan out around the teacher instead of stacking in one cell
      const angle = Math.random() * Math.PI * 2;
      hooks.teleport(x + Math.cos(angle) * 2.5, y + 0.5, z + Math.sin(angle) * 2.5);
      hooks.toast(t("📣 선생님이 불렀어요!", "📣 The teacher called you over!"));
    };
    client.onWorldReset = () => {
      field.replaceAll([]);
      furniture.clear();
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

  get role(): "teacher" | "student" {
    return this.session.role;
  }

  /** Students can't touch blocks while the teacher has building locked. */
  canBuild(): boolean {
    return this.online && (this.session.role === "teacher" || !this.settings.buildLocked);
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
    this.flushEdits();
    const now = performance.now();
    for (const [key, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(key);

    this.moveTimer += dt;
    if (this.moveTimer >= 1 / MOVE_HZ) {
      this.moveTimer = 0;
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
    return this.settings.tapsLocked !== true;
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

  /** The field window scrolled under the player. */
  shift(dx: number, dz: number): void {
    this.fx.shift(dx, dz);
  }

  private sendMove(body: { x: number; y: number; z: number }, yaw: number, anim: ClassAnim, presentation?: CharacterPresentation): void {
    const [ax, az] = this.field.toAbsolute(body.x, body.z);
    this.client.send({ t: "k-move", pos: [ax, body.y, az], yaw, anim, ...presentation });
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
    if (!this.online) {
      for (const r of this.remotes.values()) r.rig.root.visible = false;
      return;
    }
    const k = 1 - Math.pow(0.0005, frameDt); // ~100 ms catch-up
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (now - r.seenAt > 3000) {
        r.rig.root.visible = false;
        continue;
      }
      const before = this.tmp.copy(r.pos);
      // a teleport/gather snaps instead of sliding across the map
      if (r.pos.distanceToSquared(r.target) > 64) r.pos.copy(r.target);
      else r.pos.lerp(r.target, k);
      r.speed = frameDt > 0 ? Math.hypot(r.pos.x - before.x, r.pos.z - before.z) / frameDt : 0;
      const [x, z] = this.field.toGrid(r.pos.x, r.pos.z);
      r.rig.root.visible = true;
      r.rig.root.position.set(x, r.pos.y, z);
      r.drawnYaw = turnToward(r.drawnYaw, r.yaw, frameDt, 0.06, 20);
      r.rig.root.rotation.y = r.drawnYaw;
      const toolTime=r.attacking?(r.toolPhase??0)*pickaxeCycle(r.toolOption)+(now-r.seenAt)/1000:undefined;
      r.rig.update(r.anim, r.speed, frameDt,{swimming:r.swimming,toolTime});
      this.remoteSounds(r, x, z, toolTime);
    }
    this.fx.update(frameDt);
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

  private applySnap(players: Extract<ClassServerMessage, {t: "s-k-snap"}>["players"]): void {
    const now = performance.now();
    for (const p of players) {
      if (p.id === this.session.you) continue;
      let r = this.remotes.get(p.id);
      if (!r) {
        const member = this.members.find((m) => m.id === p.id);
        if (!member) continue;
        const rig = new CharacterRig();
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
        };
        this.remotes.set(p.id, r);
      }
      r.rig.setCharacter(p.character ?? "mascot");
      r.rig.setHeldItem(p.heldItem??null,p.toolOption??PICKAXE.defaultOption);
      r.toolOption=p.toolOption;r.toolPhase=p.toolPhase;r.attacking=!!p.heldItem&&p.action==="interact";
      r.rig.setEmote(p.emote ?? "none", p.emoteSeq ?? 0);
      r.rig.performAction(p.action??"none",p.actionSeq??0,p.actionLoop??false);
      r.swimming=p.swimming;
      r.target.set(...p.pos);
      r.yaw = p.yaw;
      r.anim = p.anim;
      r.seenAt = now;
    }
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
    }
  }

  private undo(edits: ClassEdit[], authoritative: boolean): void {
    for (const [ax, y, az, block, shape] of edits) {
      const key = `${ax},${y},${az}`;
      const p = this.pending.get(key);
      if (!p && !authoritative) continue;
      this.pending.delete(key);
      const cell = this.field.applyRemote(ax, y, az, authoritative ? block : p!.prev[0], authoritative ? shape : p!.prev[1]);
      if (cell) { this.view.markCellDirty(cell[0], cell[1], cell[2]); this.view.markWaterDirty(cell[0], cell[1], cell[2]); }
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
      members: this.members.map((m) => ({ name: m.name, role: m.role, online: m.online })),
      remotes: [...this.remotes.entries()].map(([id, r]) => ({
        id,
        name: this.members.find((m) => m.id === id)?.name,
        visible: r.rig.root.visible,
        abs: [r.target.x, r.target.y, r.target.z],
      })),
    };
  }

  dispose(): void {
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.fx.dispose();
    this.hud.dispose();
    this.client.close();
    this.pending.clear(); this.outbox.length = 0; this.members = [];
  }
}
