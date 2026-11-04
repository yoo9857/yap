import type { RequestListener } from "node:http";
import { existsSync, createReadStream, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { log } from "../log.js";
import { metricsAllowed } from "../metrics.js";

/**
 * Static files (production single-port mode), /healthz, and the operator-only
 * /metrics. Shared by the single server and the cluster primary.
 */
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
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".glb": "model/gltf-binary",
};


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

export function createRequestHandler(staticRoot: string | null, metrics: () => unknown, ready: () => boolean = () => true): RequestListener {
  return (req, res) => {
    if (req.url === "/healthz") {
      if (ready()) res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      else res.writeHead(503, { "content-type": "text/plain", "retry-after": "1" }).end("starting");
      return;
    }
    if (req.url === "/metrics") {
      if (!metricsAllowed(req.socket.remoteAddress, req.headers)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(metrics()));
      return;
    }
    if (!staticRoot) {
      res.writeHead(404).end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // "/.//evil.com/index.html" parses to the path "//evil.com/index.html", and a
      // redirect to that is protocol-relative: another site. Paths start with one slash.
      url.pathname = url.pathname.replace(/^\/{2,}/, "/");
      // Retire the unrelated editorial URLs without discarding game/class links.
      let redirect = false;
      if (url.pathname === "/") {
        for (const key of ["read", "article", "about"]) {
          if (url.searchParams.has(key)) {
            url.searchParams.delete(key);
            redirect = true;
          }
        }
      }
      if (url.pathname.endsWith("/index.html")) {
        url.pathname = url.pathname.slice(0, -"index.html".length);
        redirect = true;
      }
      if (redirect) {
        res.writeHead(301, { location: url.pathname + url.search, "cache-control": "no-cache" }).end();
        return;
      }
      // sanitize: resolve inside the static root only
      const rawPath = url.pathname;
      const safe = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
      let filePath = join(staticRoot, safe);
      if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        if (!rawPath.endsWith("/")) {
          res.writeHead(301, { location: rawPath + "/" + url.search, "cache-control": "no-cache" }).end();
          return;
        }
        filePath = join(filePath, "index.html");
      }
      if (!existsSync(filePath)) {
        // Missing URLs must not masquerade as the homepage (soft 404s).
        res.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "x-robots-tag": "noindex",
          "cache-control": "no-cache",
        }).end("페이지를 찾을 수 없습니다. 크래프트얍: https://craftyap.com/");
        return;
      }
      const sessionPage = extname(filePath) === ".html" &&
        ["room", "host", "teacher", "student", "pass", "preview"].some((key) => url.searchParams.has(key));
      const contentType = MIME[extname(filePath)] ?? "application/octet-stream";
      const stat = statSync(filePath);
      const size = stat.size;
      // validators, so a revalidation (index.html is no-cache) can be a 304
      const etag = `W/"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const lastModified = stat.mtime.toUTCString();
      if (!sessionPage && (req.method === "GET" || req.method === "HEAD")) {
        const inm = req.headers["if-none-match"];
        const ims = req.headers["if-modified-since"];
        const fresh = inm !== undefined
          ? inm.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")
          : ims !== undefined && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000;
        if (fresh) {
          res.writeHead(304, { etag, "last-modified": lastModified, "cache-control": cacheControlFor(rawPath, filePath) }).end();
          return;
        }
      }
      const media = contentType.startsWith("video/");
      let start = 0;
      let end = size - 1;
      let partial = false;
      // Browsers seek and loop video using single byte ranges, including suffixes.
      if (media && req.method === "GET" && req.headers.range && !req.headers["if-range"]) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        const suffix = match?.[1] === "";
        start = suffix ? Math.max(0, size - Number(match[2])) : Number(match?.[1]);
        end = suffix || !match?.[2] ? size - 1 : Math.min(Number(match[2]), size - 1);
        if (!match || (!match[1] && !match[2]) || (suffix && Number(match[2]) <= 0) ||
            !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
          res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", "content-length": 0 }).end();
          return;
        }
        partial = true;
      }
      res.writeHead(partial ? 206 : 200, {
        "content-type": contentType,
        "content-length": partial ? end - start + 1 : size,
        ...(media ? { "accept-ranges": "bytes" } : {}),
        ...(partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
        "cache-control": sessionPage ? "no-store" : cacheControlFor(rawPath, filePath),
        ...(sessionPage ? {} : { etag, "last-modified": lastModified }),
        // Class/player links and internal previews are not public search pages.
        ...(sessionPage ? { "x-robots-tag": "noindex, nofollow" } : {}),
      });
      if (req.method === "HEAD") { res.end(); return; }
      const stream = createReadStream(filePath, partial ? { start, end } : undefined);
      res.on("close", () => stream.destroy());
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
  };
}
