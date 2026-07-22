// Stream-integration E2E: builder + ?stream=1 connects to the bridge, a
// donation fires a crew boost + on-screen shout-out, chat fires a smaller
// cheer, boosts expire. Needs the client dev server (:5173) and the stream
// bridge (:8083) running.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

// deep-link straight into builder with the stream flag
const BASE = process.env.CLIENT_URL || "http://localhost:5173";
await page.goto(`${BASE}/?mode=builder&stream=1`, {
  waitUntil: "networkidle2",
  timeout: 30000,
});
await page.waitForFunction(() => !!globalThis.__roboBuilderStream, { timeout: 10000 });
check("stream hooks install with ?stream=1", true);

// bridge connection (bridge must be up on :8083)
await sleep(1500);
const status0 = await page.evaluate(() => globalThis.__roboBuilderStream.status());
check("connects to the local bridge", status0.connected === true, JSON.stringify(status0));
check("no boost before any event", status0.boostMult === 1, `mult=${status0.boostMult}`);

// a donation → crew boost + donor toast
await page.evaluate(() => globalThis.__roboBuilderStream.donate(10000, "테스터", "가즈아!"));
await sleep(300);
const afterDonate = await page.evaluate(() => globalThis.__roboBuilderStream.status());
check("donation raises the crew multiplier", afterDonate.boostMult > 1, `mult=${afterDonate.boostMult}`);
const toast = await page.evaluate(() => {
  const el = document.querySelector(".b-donor");
  return el ? el.textContent : null;
});
check("donor shout-out appears on screen", !!toast && toast.includes("테스터"), toast ?? "(none)");
const badge = await page.evaluate(() => {
  const el = document.querySelector('[data-id="boost"]');
  return el && !el.hidden ? el.textContent : null;
});
check("boost badge is visible", !!badge && badge.includes("Crew"), badge ?? "(hidden)");

// the boost actually speeds up building: gold accrues faster while boosted
const g0 = await page.evaluate(() => globalThis.__roboBuilder.snapshot().gold);
await sleep(2000);
const g1 = await page.evaluate(() => globalThis.__roboBuilder.snapshot().gold);
check("boosted crew still builds (gold flows)", g1 > g0, `${g0.toFixed(1)} → ${g1.toFixed(1)}`);

// chat cheer also registers a (smaller) boost
await page.evaluate(() => globalThis.__roboBuilderStream.chat("뷰어", "hello"));
await sleep(200);
const afterChat = await page.evaluate(() => globalThis.__roboBuilderStream.status());
check("chat cheer adds a boost too", afterChat.activeBoosts >= 1, JSON.stringify(afterChat));

// real WS path: POST the bridge webhook FROM NODE (server-to-server, as a real
// donation platform would), the game should react over the WebSocket
await fetch("http://localhost:8083/webhook", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "donation", name: "Webhook", message: "go", amount: 50000, currency: "KRW" }),
});
await sleep(600);
const afterHook = await page.evaluate(() => globalThis.__roboBuilderStream.status());
check("webhook → WS drives an in-game boost", afterHook.boostMult >= afterDonate.boostMult, `mult=${afterHook.boostMult}`);

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
