import {
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@robo/shared";

export type ConnectionState = "connecting" | "online" | "offline";

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;
const MALFORMED_WINDOW_MS = 10_000;
const MALFORMED_LIMIT = 5;

/**
 * Reconnecting WebSocket with exponential backoff + jitter and schema-checked
 * receive. Connection loss is non-fatal by design: the game keeps playing
 * solo and this socket keeps trying forever.
 */
export class GameSocket {
  onStateChange: ((state: ConnectionState) => void) | null = null;
  onMessage: ((msg: ServerMessage) => void) | null = null;
  /** Fired on every fresh OPEN — the protocol layer re-sends its hello. */
  onOpen: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private state: ConnectionState = "offline";
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private malformedTimes: number[] = [];

  private get url(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
  }

  stop(): void {
    this.enabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "client stopped");
    this.ws = null;
    this.setState("offline");
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encodeMessage(msg));
    return true;
  }

  /** Drop the current socket and reconnect (e.g. suspected version skew). */
  forceReconnect(): void {
    this.ws?.close(4000, "client-forced reconnect");
  }

  private connect(): void {
    if (!this.enabled) return;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.setState("online");
      this.onOpen?.();
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      const decoded = decodeServerMessage(ev.data);
      if (!decoded.ok) {
        this.countMalformed();
        return;
      }
      this.onMessage?.(decoded.msg);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close always follows; nothing to do here
    });
  }

  private scheduleReconnect(): void {
    if (!this.enabled) {
      this.setState("offline");
      return;
    }
    this.setState("connecting");
    const delay =
      Math.min(BACKOFF_BASE_MS * 2 ** this.attempts, BACKOFF_MAX_MS) * (0.7 + Math.random() * 0.6);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private countMalformed(): void {
    const now = performance.now();
    this.malformedTimes = this.malformedTimes.filter((t) => now - t < MALFORMED_WINDOW_MS);
    this.malformedTimes.push(now);
    if (this.malformedTimes.length > MALFORMED_LIMIT) {
      // likely protocol version skew (stale tab vs redeployed server)
      console.warn("too many malformed server messages — reconnecting");
      this.malformedTimes = [];
      this.forceReconnect();
    }
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange?.(s);
  }
}
