import type * as THREE from "three";
import {
  PROTOCOL_VERSION,
  SEND_HZ,
  SIM_HZ,
  type AnimState,
  type ClientMessage,
  type DailyBoardEntry,
  type ServerMessage,
  type Vec3,
} from "@robo/shared";
import { GameSocket, type ConnectionState } from "./socket.js";
import { ServerClock } from "./clock.js";
import { RemotePlayer } from "../player/remotePlayer.js";

const TICKS_PER_SEND = Math.round(SIM_HZ / SEND_HZ);

export interface LocalSnapshot {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  anim: AnimState;
  grounded: boolean;
}

export interface FinishEntry {
  playerId: string;
  name: string;
  timeMs: number;
  rank: number;
}

export interface DailyInfo {
  seed: number;
  dateStr: string;
  dayNumber: number;
  dayStartMs: number;
  nextDayStartMs: number;
}

export interface NetworkEvents {
  onConnectionState?(state: ConnectionState): void;
  /** `reason` is the server's: a move rejected, or a finish it would not record. */
  onCorrection?(pos: Vec3, reason: string): void;
  onFinishResult?(entry: FinishEntry, isLocal: boolean): void;
  onRemoteCheckpoint?(playerId: string, index: number): void;
  onKicked?(msg: string): void;
  /** Fired on every (re)join with the server-authoritative daily tower. */
  /** `rejoin`: a later welcome on a new session (reconnect) — the server's run state starts over. */
  onWelcome?(daily: DailyInfo, rejoin: boolean): void;
  onBoard?(entries: DailyBoardEntry[]): void;
  onNewDay?(dateStr: string): void;
}

/**
 * Protocol layer: join flow, snapshot ingestion into remote ghosts, 20 Hz
 * move reports. Connection loss degrades to solo play; a reconnect re-runs
 * the hello → welcome resync (state-based protocol — nothing to replay).
 */
/** `?party=CODE` (a hub room started Daily Tower): ride that room's own tower room. */
const PARTY_CODE = (() => {
  const code = new URLSearchParams(location.search).get("party")?.toUpperCase() ?? "";
  return /^[A-Z2-9]{6}$/.test(code) ? code : "";
})();

export class NetworkClient {
  /** Today's persisted leaderboard (server-authoritative, deduped). */
  board: DailyBoardEntry[] = [];
  daily: DailyInfo | null = null;
  /** Has any session welcomed us yet? (The next one is a rejoin.) */
  private welcomed = false;
  private readonly socket = new GameSocket(PARTY_CODE);
  private readonly clock = new ServerClock();
  private readonly remotes = new Map<string, RemotePlayer>();
  private playerId: string | null = null;
  private joined = false;
  private name = "Player";
  private seq = 0;
  /** Progress events wait for the next c-move so the server always validates
   *  them against a position at (or next to) the pad they were earned on. */
  private progressQueue: ClientMessage[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly events: NetworkEvents,
  ) {
    this.socket.onOpen = () => {
      this.socket.send({ t: "c-hello", v: PROTOCOL_VERSION, name: this.name, ...(PARTY_CODE ? { party: PARTY_CODE } : {}) });
    };
    this.socket.onStateChange = (state) => {
      if (state !== "online") {
        this.joined = false;
        this.clock.reset();
        // never leave frozen statues around while disconnected
        for (const r of this.remotes.values()) r.setVisible(false);
      }
      this.events.onConnectionState?.(state);
    };
    this.socket.onMessage = (msg) => this.handle(msg);
  }

  get state(): ConnectionState {
    return this.socket.connectionState;
  }

  get playerCount(): number {
    return 1 + (this.joined ? this.remotes.size : 0);
  }

  /** Kicked or out of date: no more connects until the page reloads. */
  private refused = false;

  connect(name: string): void {
    if (this.refused) return;
    if (this.name !== name && this.joined) {
      // rename = rejoin (the protocol has no rename message on purpose)
      this.name = name;
      this.socket.forceReconnect();
      return;
    }
    this.name = name;
    this.socket.start();
  }

  /** Rejoin (e.g. the tower day rolled over and our room is stale). */
  reconnect(): void {
    if (this.refused) return;
    this.socket.forceReconnect();
  }

  /** Go (and stay) offline — solo play, used by physics test harnesses. */
  disconnect(): void {
    this.socket.stop();
    for (const r of this.remotes.values()) r.setVisible(false);
  }

  sendMoveIfDue(tick: number, local: LocalSnapshot): void {
    if (!this.joined || tick % TICKS_PER_SEND !== 0) return;
    const sent = this.socket.send({
      t: "c-move",
      seq: this.seq++,
      pos: local.pos,
      vel: local.vel,
      yaw: local.yaw,
      anim: local.anim,
      grounded: local.grounded,
    });
    if (sent && this.progressQueue.length > 0) {
      for (const item of this.progressQueue) this.socket.send(item);
      this.progressQueue.length = 0;
    }
  }

  sendCheckpoint(index: number): void {
    this.progressQueue.push({ t: "c-checkpoint", index });
  }

  /** `timeMs` is the tick-precise client measurement (server cross-checks). */
  sendFinish(timeMs: number): void {
    this.progressQueue.push({ t: "c-finish", timeMs });
  }

  /** Server-clock estimate (ms) — the shared platform-timeline source. */
  serverNowMs(): number | null {
    return this.clock.now();
  }

  sendRespawn(reason: "death" | "restart"): void {
    // a checkpoint/finish still queued from the run being thrown away must not follow the restart
    if (reason === "restart") this.progressQueue.length = 0;
    if (this.joined) this.socket.send({ t: "c-respawn", reason });
  }

  /** Render-frame update of every remote ghost. */
  update(frameDt: number): void {
    const now = this.clock.now();
    for (const r of this.remotes.values()) r.update(now, frameDt);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "s-welcome": {
        this.playerId = msg.playerId;
        this.joined = true;
        this.progressQueue.length = 0; // never replay pre-reconnect progress
        this.clock.sample(msg.serverTimeMs);
        this.daily = {
          seed: msg.seed,
          dateStr: msg.dateStr,
          dayNumber: msg.dayNumber,
          dayStartMs: msg.dayStartMs,
          nextDayStartMs: msg.nextDayStartMs,
        };
        this.board = msg.board;
        for (const r of this.remotes.values()) r.dispose();
        this.remotes.clear();
        for (const p of msg.players) this.addRemote(p.id, p.name);
        const rejoin = this.welcomed;
        this.welcomed = true;
        this.events.onWelcome?.(this.daily, rejoin);
        this.events.onBoard?.(this.board);
        break;
      }
      case "s-player-joined":
        this.addRemote(msg.player.id, msg.player.name);
        break;
      case "s-player-left": {
        this.remotes.get(msg.playerId)?.dispose();
        this.remotes.delete(msg.playerId);
        break;
      }
      case "s-snapshot": {
        this.clock.sample(msg.serverTimeMs);
        for (const p of msg.players) {
          if (p.id === this.playerId) continue;
          const remote = this.remotes.get(p.id) ?? this.addRemote(p.id, "???");
          remote.push(p, msg.serverTimeMs);
        }
        break;
      }
      case "s-ping":
        this.clock.sample(msg.serverTimeMs);
        this.socket.send({ t: "c-pong", nonce: msg.nonce });
        break;
      case "s-correction":
        this.events.onCorrection?.(msg.pos, msg.reason);
        break;
      case "s-checkpoint-ok":
        if (msg.playerId !== this.playerId) {
          this.events.onRemoteCheckpoint?.(msg.playerId, msg.index);
        }
        break;
      case "s-finish-result": {
        const entry: FinishEntry = {
          playerId: msg.playerId,
          name: msg.name,
          timeMs: msg.timeMs,
          rank: msg.rank,
        };
        this.events.onFinishResult?.(entry, msg.playerId === this.playerId);
        break;
      }
      case "s-daily-board":
        // a run finished in a room still on yesterday's tower is recorded on yesterday's board:
        // that board is not today's and must not replace it
        if (this.daily && msg.dateStr !== this.daily.dateStr) break;
        this.board = msg.entries;
        this.events.onBoard?.(this.board);
        break;
      case "s-notice":
        if (msg.kind === "new-day") this.events.onNewDay?.(msg.dateStr);
        break;
      case "s-error":
        if (msg.code === "kicked" || msg.code === "room-full" || msg.code === "bad-version") {
          // a kick or an out-of-date page stays offline for the visit: the next
          // run's connect() would otherwise hand a kicked player a clean session
          if (msg.code !== "room-full") this.refused = true;
          this.socket.stop();
          // offline for good: free the ghosts now, not on a welcome that will never come
          for (const r of this.remotes.values()) r.dispose();
          this.remotes.clear();
          this.events.onKicked?.(msg.msg);
        }
        break;
    }
  }

  private addRemote(id: string, name: string): RemotePlayer {
    const existing = this.remotes.get(id);
    if (existing) return existing;
    const remote = new RemotePlayer(id, name, this.scene);
    this.remotes.set(id, remote);
    return remote;
  }

  nameOf(playerId: string): string | null {
    return this.remotes.get(playerId)?.name ?? null;
  }

  /** DEV/testing only: raw message injection (e.g. forged moves). */
  debugSend(msg: ClientMessage): boolean {
    return this.socket.send(msg);
  }

  /** DEV debug view. */
  debugRemotes(): { id: string; name: string; pos: number[] }[] {
    return [...this.remotes.values()].map((r) => ({
      id: r.id,
      name: r.name,
      pos: r.rig.root.position.toArray(),
    }));
  }
}
