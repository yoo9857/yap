// Headless smoke test: boots the game in Edge, collects console + page errors,
// simulates a few seconds of play input, and reports the player's state.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.SMOKE_URL ?? "http://localhost:5173/?mode=tower";
const PLAY_MS = Number(process.env.SMOKE_PLAY_MS ?? 4000);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--use-angle=swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
const logs = [];
page.on("console", (msg) => {
  const text = msg.text();
  logs.push(`[${msg.type()}] ${text}`);
  if (msg.type() === "error") errors.push(text);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });

// wait for boot overlay to hide (game started) or error state
const bootResult = await page
  .waitForFunction(
    () => {
      const o = document.getElementById("boot-overlay");
      if (!o) return "no-overlay";
      if (o.classList.contains("hidden")) return "ok";
      if (o.classList.contains("error")) return "fatal";
      return false;
    },
    { timeout: 20000 },
  )
  .then((h) => h.jsonValue())
  .catch(() => "timeout");

console.log(`boot: ${bootResult}`);

if (bootResult === "ok") {
  // hold W + tap space a few times: should move & jump without exceptions
  await page.keyboard.down("KeyW");
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down("Space");
    await new Promise((r) => setTimeout(r, 120));
    await page.keyboard.up("Space");
    await new Promise((r) => setTimeout(r, PLAY_MS / 5));
  }
  await page.keyboard.up("KeyW");

  const state = await page.evaluate(() => globalThis.__robo?.snapshot?.() ?? null);
  console.log("state:", JSON.stringify(state));
}

console.log(`console lines: ${logs.length}`);
for (const l of logs.slice(0, 30)) console.log("  " + l);
if (errors.length) {
  console.log(`ERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 20)) console.log("  " + e);
}

await browser.close();
process.exit(bootResult === "ok" && errors.length === 0 ? 0 : 1);
