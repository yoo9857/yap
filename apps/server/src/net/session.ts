import type { WebSocket } from "ws";
import {
  decodeClientMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@robo/shared";
import { log } from "../log.js";

const MOVE_BUCKET = { ratePerSec: 40, burst: 80 };
const EVENT_BUCKET = { ratePerSec: 8, burst: 16 };
const MAX_BUFFERED_BYTES = 256 * 1024;
const KILL_BUFFERED_BYTES = 1024 * 1024;
const MAX_DROPPED = 200;

interface Bucket {
  tokens: number;
  last: number;
  ratePerSec: number;
  burst: number;
}

function makeBucket(cfg: { ratePerSec: number; burst: number }): Bucket {
  return { tokens: cfg.burst, last: Date.now(), ...cfg };
}

function takeToken(b: Bucket, now: number): boolean {
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 1000) * b.ratePerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * One connected socket: decoding, per-type rate limiting, backpressure-aware
 * sending, and liveness. Protocol/game logic lives in Room — a Session only
 * delivers already-validated (schema-level) messages.
 */
export class Session {
  onMessage: ((msg: ClientMessage) => void) | null = null;
  /** Multiple owners (ws registry, room) each need close notification —
   *  a single overwritable callback caused a session-registry leak. */
  private readonly closeListeners = new Set<() => void>();
  alive = true;

  private readonly moveBucket = makeBucket(MOVE_BUCKET);
  private readonly eventBucket = makeBucket(EVENT_BUCKET);
  private dropped = 0;
  private closed = false;

  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
    readonly remoteAddress: string,
  ) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.strike("binary-frame");
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const decoded = decodeClientMessage(data.toString());
      if (!decoded.ok) {
        this.strike(decoded.error);
        return;
      }
      const now = Date.now();
      const bucket = decoded.msg.t === "c-move" ? this.moveBucket : this.eventBucket;
      if (!takeToken(bucket, now)) {
        this.strike(`rate-limit:${decoded.msg.t}`);
        return;
      }
      this.onMessage?.(decoded.msg);
    });
    ws.on("pong", () => {
      this.alive = true;
    });
    ws.on("close", () => {
      this.closed = true;
      for (const cb of this.closeListeners) {
        try {
          cb();
        } catch (err) {
          log.error({ session: this.id, err }, "close listener failed");
        }
      }
      this.closeListeners.clear();
    });
    ws.on("error", (err) => {
      log.warn({ session: this.id, err: err.message }, "socket error");
    });
  }

  addCloseListener(cb: () => void): void {
    this.closeListeners.add(cb);
  }

  /** Returns false when the message was skipped for backpressure. */
  send(msg: ServerMessage, droppable = false): boolean {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return false;
    if (this.ws.bufferedAmount > KILL_BUFFERED_BYTES) {
      log.warn({ session: this.id }, "client hopelessly behind — disconnecting");
      this.close(1008, "backpressure");
      return false;
    }
    if (droppable && this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      return false; // skip this snapshot; the next one is just as good
    }
    this.ws.send(encodeMessage(msg));
    return true;
  }

  ping(): void {
    if (this.closed) return;
    this.alive = false;
    this.ws.ping();
  }

  terminate(): void {
    this.closed = true;
    this.ws.terminate();
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  private strike(reason: string): void {
    this.dropped++;
    if (this.dropped === 1 || this.dropped % 50 === 0) {
      log.warn({ session: this.id, reason, dropped: this.dropped }, "dropped client message");
    }
    if (this.dropped > MAX_DROPPED) {
      this.send({ t: "s-error", code: "kicked", msg: "protocol violations" });
      this.close(1008, "protocol violations");
    }
  }
}
