import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { makeEvent, num, str, toKrw } from "./normalize.js";
import { YoutubeAdapter } from "./adapters/youtube.js";
import { TwipAdapter } from "./adapters/twip.js";
import { ToonationAdapter } from "./adapters/toonation.js";

// Load .env if present (Node >= 20.12 has process.loadEnvFile).
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  /* no .env — rely on the ambient environment */
}

const config = loadConfig(process.env);

const httpServer = createServer((req, res) => handleHttp(req, res));
const wss = new WebSocketServer({ server: httpServer, path: "/" });
const hub = new Hub(wss);

httpServer.listen(config.port, () => {
  console.info(`[bridge] listening on :${config.port}  (ws://localhost:${config.port})`);
  console.info(
    `[bridge] open the game with  ?mode=builder&stream=1&streamPort=${config.port}`,
  );
  const enabled = [
    config.youtube && "youtube",
    config.twip && "twip",
    config.toonation && "toonation",
    "webhook",
  ].filter(Boolean);
  console.info(`[bridge] sources enabled: ${enabled.join(", ")}`);
});

// ---- adapters -------------------------------------------------------------

if (config.youtube) void new YoutubeAdapter(config.youtube, (e) => hub.push(e)).start();
if (config.twip) void new TwipAdapter(config.twip, (e) => hub.push(e)).start();
if (config.toonation) void new ToonationAdapter(config.toonation, (e) => hub.push(e)).start();

// ---- generic HTTP webhook (any platform can POST here) --------------------

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, clients: hub.clientCount });
  }
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/webhook") {
    return json(res, 404, { error: "not found" });
  }
  if (config.webhookSecret && req.headers["x-bridge-secret"] !== config.webhookSecret) {
    return json(res, 401, { error: "bad secret" });
  }

  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 64_000) req.destroy(); // cap payload
  });
  req.on("end", () => {
    try {
      const p = JSON.parse(body) as Record<string, unknown>;
      const kind = p.kind === "chat" ? "chat" : "donation";
      const amountKrw =
        typeof p.amountKrw === "number"
          ? p.amountKrw
          : toKrw(num(p.amount), str(p.currency) || "KRW");
      const display =
        str(p.display) || (amountKrw > 0 ? `₩${amountKrw.toLocaleString("en-US")}` : "");
      hub.push(
        makeEvent({
          source: "webhook",
          kind,
          name: str(p.name) || str(p.nickname),
          message: str(p.message) || str(p.comment),
          amountKrw,
          display,
          id: str(p.id) || undefined,
        }),
      );
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.info("\n[bridge] shutting down");
    wss.close();
    httpServer.close();
    process.exit(0);
  });
}
