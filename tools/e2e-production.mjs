// Production E2E: SERVE_STATIC single-port deploy — static client + same-origin
// WS. No dev debug hooks here: interacts through the real DOM like a player.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8090;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: "C:/robo",
  env: { ...process.env, PORT: String(PORT), SERVE_STATIC: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[server-err] ${d}`));
await sleep(1500);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});

async function openAndStart(name) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`PAGEERROR(${name}):`, e.message));
  await page.goto(`http://localhost:${PORT}/?mode=tower`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
    { timeout: 25000 },
  );
  await page.type('[data-id="name"]', name);
  await page.click('[data-id="start"]');
  return page;
}

const a = await openAndStart("프로도");
const b = await openAndStart("네오");
await sleep(3000);

const readPlayers = (page) =>
  page.evaluate(() => document.querySelector('[data-id="players"]')?.textContent ?? "?");
const playersA = await readPlayers(a);
await a.bringToFront();
await sleep(500);
const playersA2 = await readPlayers(a);
const playersB = await readPlayers(b);

check("production page boots and starts", true);
check(
  "both production tabs joined the same room (HUD shows 2 players)",
  (playersA.includes("2") || playersA2.includes("2")) && playersB.includes("2"),
  `A="${playersA2}" B="${playersB}"`,
);

// movement sanity in prod build: HUD height % changes after running+jumping
await a.click("#app");
const heightBefore = await a.evaluate(() => document.querySelector('[data-id="height"]')?.textContent);
await a.keyboard.down("KeyW");
await sleep(700);
await a.keyboard.down("Space");
await sleep(150);
await a.keyboard.up("Space");
await sleep(300);
const heightDuring = await a.evaluate(() => document.querySelector('[data-id="height"]')?.textContent);
await a.keyboard.up("KeyW");
check("prod build gameplay responds (height % changes mid-jump)", heightBefore !== heightDuring, `${heightBefore} → ${heightDuring}`);

await browser.close();
server.kill();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
