import type { StreamEvent } from "@robo/shared";
import type { AlertboxConfig } from "../config.js";
import { makeEvent, num, str, toKrw } from "../normalize.js";

/**
 * Twip donation adapter. Twip has no public API, so this follows the
 * community-reverse-engineered flow: scrape the alertbox widget page for the
 * `__TOKEN__` and `version`, then open the Socket.IO v2 connection at
 * io.mytwip.net and listen for "new donate" / "new cheer". Field names are
 * read defensively; anything unmapped is logged so it can be adjusted.
 *
 * TWIP_ALERTBOX_URL = your alert box URL, e.g. https://twip.kr/widgets/alertbox/<KEY>
 */
export class TwipAdapter {
  private stopped = false;
  private socket: { close(): void } | null = null;

  constructor(
    private readonly cfg: AlertboxConfig,
    private readonly onEvent: (e: StreamEvent) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const key = this.cfg.alertboxUrl.split("?")[0]!.replace(/\/$/, "").split("/").pop() ?? "";
      const html = await (await fetch(this.cfg.alertboxUrl)).text();
      const token = /window\.__TOKEN__ = '([^']+)'/.exec(html)?.[1];
      const version = /version: '([^']+)'/.exec(html)?.[1];
      if (!key || !token || !version) {
        console.warn("[twip] could not parse token/version from alertbox page — check TWIP_ALERTBOX_URL");
        return;
      }

      const { default: io } = await import("socket.io-client");
      const socket = io("https://io.mytwip.net", {
        query: { alertbox_key: key, version, token },
        transports: ["websocket"],
        path: "/socket.io",
        reconnection: true,
      });
      this.socket = socket;

      socket.on("connect", () => console.info("[twip] connected"));
      socket.on("disconnect", () => console.warn("[twip] disconnected"));
      socket.on("new donate", (d: unknown) => this.onDonate(d));
      socket.on("new cheer", (d: unknown) => this.onDonate(d));
    } catch (err) {
      console.error("[twip] failed to start:", (err as Error).message);
    }
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private onDonate(raw: unknown): void {
    if (this.stopped) return;
    const d = (raw ?? {}) as Record<string, unknown>;
    const name = str(d.nickname ?? d.name ?? d.username);
    const message = str(d.comment ?? d.message ?? d.memo);
    const amount = num(d.amount ?? d.price ?? d.value);
    // Twip amounts are KRW
    this.onEvent(
      makeEvent({
        source: "twip",
        kind: "donation",
        name,
        message,
        amountKrw: toKrw(amount, "KRW"),
        display: amount > 0 ? `₩${amount.toLocaleString("en-US")}` : "",
        id: str(d.id ?? d._id) || undefined,
      }),
    );
    if (amount <= 0) console.warn("[twip] donation with no parseable amount:", JSON.stringify(raw));
  }
}
