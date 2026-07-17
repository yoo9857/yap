import {
  SNAPSHOT_HZ,
  generateLevel,
  type ClientMessage,
  type DayInfo,
  type LevelDef,
  type PlayerInfo,
  type ServerMessage,
  type SnapshotPlayer,
} from "@robo/shared";
import { log } from "../log.js";
import type { Session } from "../net/session.js";
import type { RecordStore } from "./records.js";
import {
  applyRespawn,
  createValidationState,
  validateCheckpoint,
  validateFinish,
  validateMove,
  type ValidationState,
} from "./validation.js";

const KICK_SCORE = 12;
const SCORE_DECAY_PER_SEC = 0.5;
/** Adopt the tick-precise client-measured time when it agrees with the
 *  server's wall-clock measurement within this tolerance. */
const CLIENT_TIME_TOLERANCE = (serverMs: number) => Math.max(1000, serverMs * 0.05);

interface RoomPlayer {
  session: Session;
  info: PlayerInfo;
  lastMove: SnapshotPlayer | null;
  validation: ValidationState;
  violationScore: number;
  finished: boolean;
}

/**
 * One shared daily-tower instance: membership, message handling with sanity
 * validation, snapshot broadcasting, persisted daily records. Every handler
 * is wrapped so one player's weirdness can never take the room down.
 */
export class Room {
  private readonly players = new Map<string, RoomPlayer>();
  private readonly level: LevelDef;
  private readonly snapshotTimer: NodeJS.Timeout;
  private readonly pingTimer: NodeJS.Timeout;
  private pingNonce = 0;
  emptySinceMs: number | null = Date.now();

  constructor(
    readonly id: string,
    readonly day: DayInfo,
    private readonly records: RecordStore,
    private readonly maxPlayers: number,
  ) {
    this.level = generateLevel(day.seed);
    this.snapshotTimer = setInterval(() => {
      try {
        this.broadcastSnapshots();
        this.decayViolations();
      } catch (err) {
        log.error({ room: this.id, err }, "snapshot tick failed");
      }
    }, 1000 / SNAPSHOT_HZ);
    this.pingTimer = setInterval(() => {
      const msg: ServerMessage = {
        t: "s-ping",
        nonce: this.pingNonce++,
        serverTimeMs: Date.now(),
      };
      for (const p of this.players.values()) p.session.send(msg, true);
    }, 5000);
  }

  get seed(): number {
    return this.day.seed;
  }

  get size(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  join(session: Session, name: string): void {
    const player: RoomPlayer = {
      session,
      info: { id: session.id, name, checkpoint: -1 },
      lastMove: null,
      validation: createValidationState(this.level.spawn),
      violationScore: 0,
      finished: false,
    };
    this.players.set(session.id, player);
    this.emptySinceMs = null;

    session.send({
      t: "s-welcome",
      playerId: session.id,
      roomId: this.id,
      seed: this.day.seed,
      serverTimeMs: Date.now(),
      snapshotHz: SNAPSHOT_HZ,
      players: [...this.players.values()]
        .filter((p) => p.session.id !== session.id)
        .map((p) => p.info),
      dateStr: this.day.dateStr,
      dayNumber: this.day.dayNumber,
      dayStartMs: this.day.dayStartMs,
      nextDayStartMs: this.day.nextDayStartMs,
      board: this.records.board(this.day.dateStr),
    });
    this.broadcastExcept(session.id, { t: "s-player-joined", player: player.info });

    session.onMessage = (msg) => {
      try {
        this.handle(player, msg);
      } catch (err) {
        log.error({ room: this.id, player: session.id, err }, "message handler failed");
      }
    };
    session.addCloseListener(() => this.leave(session.id));
    log.info({ room: this.id, player: session.id, name, size: this.size }, "player joined");
  }

  leave(playerId: string): void {
    if (!this.players.delete(playerId)) return;
    this.broadcastExcept(playerId, { t: "s-player-left", playerId });
    if (this.players.size === 0) this.emptySinceMs = Date.now();
    log.info({ room: this.id, player: playerId, size: this.size }, "player left");
  }

  /** The tower day rolled over while this room is live. */
  notifyNewDay(dateStr: string): void {
    this.broadcast({ t: "s-notice", kind: "new-day", dateStr });
  }

  private handle(player: RoomPlayer, msg: ClientMessage): void {
    const now = Date.now();
    switch (msg.t) {
      case "c-move": {
        const verdict = validateMove(player.validation, msg, now, this.level);
        if (!verdict.ok) {
          this.punish(player, 1, verdict.reason);
          return;
        }
        player.lastMove = {
          id: player.info.id,
          pos: msg.pos,
          yaw: msg.yaw,
          anim: msg.anim,
          grounded: msg.grounded,
        };
        break;
      }
      case "c-checkpoint": {
        if (!validateCheckpoint(player.validation, msg.index, this.level)) {
          this.punish(player, 2, "bad-checkpoint");
          return;
        }
        player.info.checkpoint = msg.index;
        this.broadcast({ t: "s-checkpoint-ok", playerId: player.info.id, index: msg.index });
        break;
      }
      case "c-finish": {
        if (player.finished) return;
        const verdict = validateFinish(player.validation, now, this.level);
        if (!verdict.ok) {
          this.punish(player, 2, verdict.reason);
          return;
        }
        player.finished = true;

        // hybrid precision: prefer the client's tick-exact measurement when
        // it agrees with the server's authoritative wall-clock window
        let timeMs = verdict.timeMs;
        if (
          msg.timeMs !== undefined &&
          Math.abs(msg.timeMs - verdict.timeMs) <= CLIENT_TIME_TOLERANCE(verdict.timeMs)
        ) {
          timeMs = msg.timeMs;
        }

        const { rank } = this.records.submitBest(this.day.dateStr, player.info.name, timeMs);
        this.broadcast({
          t: "s-finish-result",
          playerId: player.info.id,
          name: player.info.name,
          timeMs,
          rank,
        });
        this.broadcast({
          t: "s-daily-board",
          dateStr: this.day.dateStr,
          entries: this.records.board(this.day.dateStr),
        });
        log.info({ room: this.id, player: player.info.id, timeMs, rank }, "finish recorded");
        break;
      }
      case "c-respawn": {
        applyRespawn(player.validation, msg.reason, this.level);
        if (msg.reason === "restart") {
          player.info.checkpoint = -1;
          player.finished = false;
        }
        break;
      }
      case "c-pong":
        break; // ws-level pong handles liveness; nothing to do
      case "c-hello":
        break; // already joined — ignore
    }
  }

  private punish(player: RoomPlayer, weight: number, reason: string): void {
    player.violationScore += weight;
    log.info(
      { room: this.id, player: player.info.id, reason, score: player.violationScore },
      "violation",
    );
    // soft correction: snap back to the last accepted position (or anchor)
    const pos = player.validation.lastPos ?? player.validation.anchor ?? this.level.spawn;
    player.session.send({ t: "s-correction", pos: [...pos], reason });
    if (player.violationScore > KICK_SCORE) {
      player.session.send({ t: "s-error", code: "kicked", msg: "too many violations" });
      player.session.close(1008, "too many violations");
    }
  }

  private decayViolations(): void {
    const decay = SCORE_DECAY_PER_SEC / SNAPSHOT_HZ;
    for (const p of this.players.values()) {
      if (p.violationScore > 0) p.violationScore = Math.max(0, p.violationScore - decay);
    }
  }

  private broadcastSnapshots(): void {
    if (this.players.size < 2) return;
    const now = Date.now();
    for (const target of this.players.values()) {
      const others: SnapshotPlayer[] = [];
      for (const p of this.players.values()) {
        if (p !== target && p.lastMove) others.push(p.lastMove);
      }
      target.session.send({ t: "s-snapshot", serverTimeMs: now, players: others }, true);
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.players.values()) p.session.send(msg);
  }

  private broadcastExcept(playerId: string, msg: ServerMessage): void {
    for (const p of this.players.values()) {
      if (p.session.id !== playerId) p.session.send(msg);
    }
  }

  destroy(): void {
    clearInterval(this.snapshotTimer);
    clearInterval(this.pingTimer);
    for (const p of this.players.values()) {
      p.session.close(1001, "room closed");
    }
    this.players.clear();
  }
}
