import type { WebSocketServer, WebSocket } from "ws";
import type { StreamEvent } from "@robo/shared";

/**
 * Fan-out hub: keeps the set of connected Robo Builder clients and broadcasts
 * each normalized {@link StreamEvent} to all of them, de-duplicating by event
 * id (donation platforms and chat polling both re-deliver on reconnect).
 */
export class Hub {
  private readonly clients = new Set<WebSocket>();
  private readonly seen = new Map<string, number>();

  constructor(wss: WebSocketServer) {
    wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  push(event: StreamEvent): void {
    if (event.id) {
      if (this.seen.has(event.id)) return;
      this.seen.set(event.id, Date.now());
      this.prune();
    }
    const msg = JSON.stringify({ t: "stream-event", event });
    for (const ws of this.clients) {
      // 1 === WebSocket.OPEN (avoid importing the value in a type-only setup)
      if (ws.readyState === 1) ws.send(msg);
    }
    const money = event.amountKrw > 0 ? ` (${event.display})` : "";
    console.info(
      `[hub] ${event.source} ${event.kind}${money} from "${event.name}" → ${this.clients.size} client(s)`,
    );
  }

  /** Keep the dedup map bounded — drop ids older than 10 minutes. */
  private prune(): void {
    if (this.seen.size < 500) return;
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, ts] of this.seen) if (ts < cutoff) this.seen.delete(id);
  }
}
