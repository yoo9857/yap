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

async function head(path, method = "GET") {
  const r = await fetch(base + path, { method, signal: AbortSignal.timeout(15000) });
  return { status: r.status, type: r.headers.get("content-type") ?? "", cache: r.headers.get("cache-control") ?? "", body: r };
}

// 1) health
try {
  const r = await fetch(base + "/healthz");
  check("healthz returns ok", r.status === 200 && (await r.text()).trim() === "ok");
} catch (e) {
  check("healthz returns ok", false, String(e));
}

// 2) HTML shell + no-cache + Korean game identity (not the retired income blog)
try {
  const r = await head("/");
  const html = await r.body.text();
  check("index.html served", r.status === 200 && r.type.includes("text/html"));
  check("index.html is no-cache", r.cache.includes("no-cache"), r.cache);
  const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
  check("Korean block-game title present", title.includes("크래프트얍") && title.includes("CraftYap") && title.includes("블록 게임"), title);
  check("homepage declares Korean", /<html\b[^>]*lang="ko"/.test(html));
  check("income-blog metadata removed", !/make money|side hustles|passive income|affiliate marketing/i.test(html));
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
  check("game and website structured data present", schema["@graph"]?.some((item) => item["@type"] === "VideoGame") && schema["@graph"]?.some((item) => item["@type"] === "WebSite"));
  check("OG image uses the Sunny Village artwork", html.includes('property="og:image" content="https://craftyap.com/backgrounds/craftyap-sunny-village-share.jpg"'));
} catch (e) {
  check("index.html served", false, String(e));
}

// 3) static assets + correct MIME + caching
for (const [path, wantType] of [
  ["/craftyap-logo.png", "image/png"],
  ["/backgrounds/craftyap-sunny-village-desktop.avif", "image/avif"],
  ["/backgrounds/craftyap-sunny-village-desktop.webp", "image/webp"],
  ["/backgrounds/craftyap-sunny-village-mobile.avif", "image/avif"],
  ["/backgrounds/craftyap-sunny-village-mobile.webp", "image/webp"],
  ["/backgrounds/craftyap-sunny-village-share.jpg", "image/jpeg"],
  ["/audio/bgm-tower.mp3", "audio/mpeg"],
  ["/textures/blocks/water.png", "image/png"],
  ["/robots.txt", "text/plain"],
  ["/llms.txt", "text/plain"],
  ["/indexnow-key.txt", "text/plain"],
  ["/guide/guide.css", "text/css"],
  ["/guide/guide.js", "text/javascript"],
  ["/guide/assets/island.webp", "image/webp"],
  ["/guide/assets/workshop.webp", "image/webp"],
  ["/guide/assets/tower.webp", "image/webp"],
  ["/guide/assets/builder.webp", "image/webp"],
  ["/guide/assets/battle.webp", "image/webp"],
  ["/note/note.css", "text/css"],
  ["/note/feed.xml", "application/xml"],
]) {
  try {
    // Inspect headers without starting and cancelling an audio/image stream.
    const r = await head(path, "HEAD");
    check(`asset ${path}`, r.status === 200 && r.type.split(";")[0].trim() === wantType, `${r.status} ${r.type}`);
    await r.body.body?.cancel();
  } catch (e) {
    check(`asset ${path}`, false, String(e));
  }
}

// Crawlable Korean guide, sitemap discovery and canonical/404 routing.
try {
  const r = await head("/guide/");
  const html = await r.body.text();
  check("Korean guide is a real HTML page", r.status === 200 && r.type.includes("text/html") && /<h1\b[^>]*>/i.test(html) && html.includes("크래프트얍") && html.includes('href="https://craftyap.com/guide/"'));
  const sitemap = await fetch(base + "/sitemap.xml");
  const xml = await sitemap.text();
  check("sitemap discovers game and guide", sitemap.status === 200 && xml.includes("<loc>https://craftyap.com/</loc>") && xml.includes("<loc>https://craftyap.com/guide/</loc>"));
  const notes = await head("/note/");
  const notesHtml = await notes.body.text();
  check("dev notes index is a real HTML page", notes.status === 200 && notes.type.includes("text/html") && /<h1\b[^>]*>/i.test(notesHtml) && notesHtml.includes('href="https://craftyap.com/note/"'));
  check("sitemap discovers dev notes", xml.includes("<loc>https://craftyap.com/note/</loc>"));
  const robots = await (await fetch(base + "/robots.txt")).text();
  check("robots allows crawling and points to sitemap", robots.includes("Allow: /") && robots.includes("Sitemap: https://craftyap.com/sitemap.xml"));
  for (const path of ["/?mode=field&room=seo-test&student=seo-test", "/?mode=field&host=seo-test&pass=seo-test", "/?preview=char"]) {
    const session = await fetch(base + path);
    check(`session page excluded from search ${path}`, session.status === 200 && session.headers.get("x-robots-tag") === "noindex, nofollow" && session.headers.get("cache-control") === "no-store");
    await session.body?.cancel();
  }
  const publicGame = await fetch(base + "/?mode=craft");
  check("ordinary game links remain crawlable", publicGame.status === 200 && !publicGame.headers.get("x-robots-tag")?.includes("noindex"));
  await publicGame.body?.cancel();
  for (const [from, to] of [["/guide", "/guide/"], ["/guide/index.html", "/guide/"], ["/index.html", "/"], ["/?read=1", "/"], ["/?article=ai-automation", "/"], ["/?about=team&mode=craft", "/?mode=craft"]]) {
    const redirect = await fetch(base + from, { redirect: "manual" });
    check(`canonical redirect ${from}`, redirect.status === 301 && redirect.headers.get("location") === to);
    await redirect.body?.cancel();
  }
  const missing = await fetch(base + "/does-not-exist-seo-check", { redirect: "manual" });
  check("unknown page returns a real 404", missing.status === 404 && missing.headers.get("x-robots-tag") === "noindex");
  await missing.body?.cancel();
} catch (e) {
  check("crawlable guide and canonical routing", false, String(e));
}

// 4) WebSocket upgrade at /ws, without joining a live classroom or game.
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
// Let the WebSocket close handshake finish before Node tears down its handles.
process.exitCode = passed === results.length ? 0 : 1;
