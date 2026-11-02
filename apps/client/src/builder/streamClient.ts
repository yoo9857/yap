import { StreamWireSchema, type StreamEvent } from "@robo/shared";

/**
 * Connects the Robo Builder client to the local stream bridge
 * (`apps/stream-bridge`) over WebSocket and forwards normalized
 * {@link StreamEvent}s. Only created when the page is opened with `?stream=1`,
 * so ordinary play never touches the network. Auto-reconnects with backoff so
 * restarting the bridge mid-broadcast heals itself.
 */
export class StreamClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1_000;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly onEvent: (e: StreamEvent) => void,
    private readonly onStatus?: (connected: boolean) => void,
  ) {}

  start(): void {
    if (this.ws || this.timer) return; // already running: a second socket would double every boost
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(); // its onclose sees it is no longer current and stays quiet
  }

  private connect(): void {
    this.timer = null;
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retryMs = 1_000;
      this.onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let json: unknown;
      try {
        json = JSON.parse(String(ev.data));
      } catch {
        return; // ignore malformed frames
      }
      const parsed = StreamWireSchema.safeParse(json);
      if (parsed.success) this.onEvent(parsed.data.event);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // a socket stop() already let go of
      this.ws = null;
      this.onStatus?.(false);
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
  }
}
