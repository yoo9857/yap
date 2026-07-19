import { createServer } from "node:http";
import { existsSync, createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createRecordStore } from "./game/records.js";
import { RoomManager } from "./game/roomManager.js";
import { attachWsServer } from "./net/wsServer.js";

const config = loadConfig();
const entryDir = dirname(fileURLToPath(import.meta.url));
const records = createRecordStore(resolve(entryDir, config.DB_PATH));
const rooms = new RoomManager(config.MAX_PLAYERS_PER_ROOM, records, config.DAY_UTC_OFFSET_MIN);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const staticRoot = config.SERVE_STATIC ? resolve(entryDir, config.STATIC_DIR) : null;

/**
 * Cache policy per asset class:
 * - Vite's content-hashed `/assets/*` never change → immutable for a year.
 * - The HTML shell must revalidate so a new deploy is picked up immediately.
 * - Everything else in public/ (textures, audio, logo) is stable but not
 *   hashed → a day, revalidated.
 * `urlPath` is the raw request path (always forward-slash), NOT the
 * OS-normalized filesystem path — comparing URL semantics here.
 */
function cacheControlFor(urlPath: string, resolvedFile: string): string {
  if (resolvedFile.endsWith("index.html")) return "no-cache";
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=86400";
}

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (!staticRoot) {
    res.writeHead(404).end();
    return;
  }
  try {
    // sanitize: resolve inside the static root only
    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    const safe = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(staticRoot, safe);
    if (!filePath.startsWith(staticRoot)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(staticRoot, "index.html"); // SPA fallback
    }
    if (!existsSync(filePath)) {
      res.writeHead(404).end("client build not found — run pnpm build");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": cacheControlFor(rawPath, filePath),
    });
    const stream = createReadStream(filePath);
    stream.on("error", (err) => {
      // async read failure must never take the process down
      log.error({ err, filePath }, "static stream failed");
      res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    log.error({ err }, "static serve failed");
    res.writeHead(500).end();
  }
});

const closeWs = attachWsServer(httpServer, rooms);

httpServer.listen(config.PORT, config.HOST, () => {
  log.info(
    { port: config.PORT, static: staticRoot ?? "off" },
    "robo server listening",
  );
});

// ---------------------------------------------------------------- lifecycle

let shuttingDown = false;
function shutdown(reason: string, code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ reason }, "shutting down");
  closeWs();
  rooms.shutdown();
  records.close();
  httpServer.close(() => process.exit(code));
  // hard exit if graceful close hangs
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception");
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ reason }, "unhandled rejection");
  shutdown("unhandledRejection", 1);
});
