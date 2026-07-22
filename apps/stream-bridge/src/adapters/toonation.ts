import { WebSocket } from "ws";
import type { StreamEvent } from "@robo/shared";
import type { AlertboxConfig } from "../config.js";
import { makeEvent, num, str, toKrw } from "../normalize.js";

/**
 * Toonation donation adapter. Like Twip, no public API — this follows the
 * reverse-engineered flow: scrape the alertbox page for its `payload` token,
 * open the raw WebSocket at ws.toon.at/<payload>, keep it alive with a
 * "#ping" every 12 s, and treat frames with `code === 101` as donations.
 * The donation `content` shape varies, so fields are read defensively (and
 * base64/JSON content is unwrapped); anything unmapped is logged.
 *
 * TOONATION_ALERTBOX_URL = your alert box URL, e.g. https://toon.at/widget/alertbox/<KEY>
 */
export class ToonationAdapter {
  private stopped = false;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: AlertboxConfig,
    private readonly onEvent: (e: StreamEvent) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const html = await (await fetch(this.cfg.alertboxUrl)).text();
      const payload = /"payload"\s*:\s*"([a-zA-Z0-9]+)"/.exec(html)?.[1];
      if (!payload) {
        console.warn("[toonation] could not parse payload from alertbox page — check TOONATION_ALERTBOX_URL");
        return;
      }
      this.connect(payload);
    } catch (err) {
      console.error("[toonation] failed to start:", (err as Error).message);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect(payload: string): void {
    if (this.stopped) return;
    const ws = new WebSocket(`wss://ws.toon.at/${payload}`);
    this.ws = ws;
    ws.on("open", () => {
      console.info("[toonation] connected");
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping("#ping");
      }, 12_000);
    });
    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      this.onMessage(text);
    });
    ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.stopped) {
        console.warn("[toonation] disconnected — reconnecting in 5s");
        setTimeout(() => this.connect(payload), 5_000);
      }
    });
    ws.on("error", (err) => console.warn("[toonation] socket error:", err.message));
  }

  private onMessage(text: string): void {
    let msg: { code?: number; content?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return; // non-JSON keepalive frames
    }
    if (msg.code !== 101) return; // 101 = donation
    const content = unwrap(msg.content);
    const name = str(content.sender ?? content.nickname ?? content.name);
    const message = str(content.message ?? content.comment ?? content.text);
    const amount = num(content.amount ?? content.price ?? content.value);
    this.onEvent(
      makeEvent({
        source: "toonation",
        kind: "donation",
        name,
        message,
        amountKrw: toKrw(amount, "KRW"),
        display: amount > 0 ? `₩${amount.toLocaleString("en-US")}` : "",
        id: str(content.id ?? content.uuid) || undefined,
      }),
    );
    if (amount <= 0) console.warn("[toonation] donation with no parseable amount:", text.slice(0, 300));
  }
}

/** Content may be an object, a JSON string, or base64-encoded JSON. */
function unwrap(content: unknown): Record<string, unknown> {
  if (content && typeof content === "object") return content as Record<string, unknown>;
  if (typeof content === "string") {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      /* not raw JSON — try base64 */
    }
    try {
      const decoded = Buffer.from(content, "base64").toString("utf8");
      return JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      /* give up */
    }
  }
  return {};
}
