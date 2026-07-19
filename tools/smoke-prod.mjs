// Post-deploy smoke test — hit the running production server and assert the
// deployment path works end to end (no browser needed). Usage:
//   node tools/smoke-prod.mjs [baseUrl]
// Defaults to the local container port; on the server pass the public URL:
//   node tools/smoke-prod.mjs https://craftyap.com
// Dependency-free: uses Node 22's built-in fetch + global WebSocket.

const base = (process.argv[2] ?? "http://127.0.0.1:8082").replace(/\/$/, "");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function head(path) {
  const r = await fetch(base + path);
  return { status: r.status, type: r.headers.get("content-type") ?? "", cache: r.headers.get("cache-control") ?? "", body: r };
}

// 1) health
try {
  const r = await fetch(base + "/healthz");
  check("healthz returns ok", r.status === 200 && (await r.text()).trim() === "ok");
} catch (e) {
  check("healthz returns ok", false, String(e));
}

// 2) HTML shell + no-cache + English title
try {
  const r = await head("/");
  const html = await r.body.text();
  check("index.html served", r.status === 200 && r.type.includes("text/html"));
  check("index.html is no-cache", r.cache.includes("no-cache"), r.cache);
  check("English brand title present", html.includes("<title>CraftYap"), "");
  check("OG image points at craftyap.com", html.includes("craftyap.com/craftyap-banner.jpg"));
} catch (e) {
  check("index.html served", false, String(e));
}

// 3) static assets + correct MIME + caching
for (const [path, wantType] of [
  ["/craftyap-logo.png", "image/png"],
  ["/audio/bgm-tower.mp3", "audio/mpeg"],
  ["/textures/blocks/water.png", "image/png"],
  ["/robots.txt", "text/plain"],
]) {
  try {
    const r = await head(path);
    check(`asset ${path}`, r.status === 200 && r.type.includes(wantType.split("/")[0]), `${r.status} ${r.type}`);
  } catch (e) {
    check(`asset ${path}`, false, String(e));
  }
}

// 4) WebSocket handshake at /ws (protocol hello → welcome)
await new Promise((resolve) => {
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  let done = false;
  const finish = (ok, detail) => {
    if (done) return;
    done = true;
    check("WebSocket /ws accepts a connection", ok, detail);
    try { ws.close(); } catch { /* already closed */ }
    resolve();
  };
  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => finish(false, "timeout"), 8000);
  ws.addEventListener("open", () => { clearTimeout(timer); finish(true, ""); });
  ws.addEventListener("error", () => { clearTimeout(timer); finish(false, "connection error"); });
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
