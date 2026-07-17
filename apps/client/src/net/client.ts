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
  onCorrection?(pos: Vec3): void;
  onFinishResult?(entry: FinishEntry, isLocal: boolean): void;
  onRemoteCheckpoint?(playerId: string, index: number): void;
  onKicked?(msg: string): void;
  /** Fired on every (re)join with the server-authoritative daily tower. */
  onWelcome?(daily: DailyInfo): void;
  onBoard?(entries: DailyBoardEntry[]): void;
  onNewDay?(dateStr: string): void;
}

/**
 * Protocol layer: join flow, snapshot ingestion into remote ghosts, 20 Hz
 * move reports. Connection loss degrades to solo play; a reconnect re-runs
 * the hello → welcome resync (state-based protocol — nothing to replay).
 */
export class NetworkClient {
  /** Today's persisted leaderboard (server-authoritative, deduped). */
  board: DailyBoardEntry[] = [];
  daily: DailyInfo | null = null;
  private readonly socket = new GameSocket();
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
      this.socket.send({ t: "c-hello", v: PROTOCOL_VERSION, name: this.name });
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

  connect(name: string): void {
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
        this.events.onWelcome?.(this.daily);
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
        this.events.onCorrection?.(msg.pos);
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
        this.board = msg.entries;
        this.events.onBoard?.(this.board);
        break;
      case "s-notice":
        if (msg.kind === "new-day") this.events.onNewDay?.(msg.dateStr);
        break;
      case "s-error":
        if (msg.code === "kicked" || msg.code === "room-full" || msg.code === "bad-version") {
          this.socket.stop();
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
