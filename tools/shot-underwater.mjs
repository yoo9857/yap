// The underwater screen: a wide pond (its inside is falling water), the camera well under, at the
// waterline (the wash covers only what is below it) and above; and beside a waterfall in the open
// (not underwater). Prints the state at each and shoots it.
//   node tools/shot-underwater.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/underwater";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
let failed = 0;
const check = (label, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`); if (!ok) failed++; };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  await page.goto(`${BASE}/?mode=field&reset=1`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const [X, Y, Z] = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const cx = X, cz = Z - 16;
  await page.evaluate((cx, cz, Y) => {
    const c = globalThis.__roboCraft;
    // a pond 18 × 18 and three deep (too wide to be a "basin": under its surface it is falling water)
    for (let x = cx - 9; x < cx + 9; x++) for (let z = cz - 9; z < cz + 9; z++) for (let y = Y - 3; y <= Y - 1; y++) c.mineAt(x, y, z);
    for (let x = cx - 9; x < cx + 9; x++) for (let z = cz - 9; z < cz + 9; z++) c.pourAt(x, Y - 1, z);
    for (const [x, z] of [[cx - 3, cz], [cx + 2, cz - 3], [cx, cz + 3]]) { c.placeAt(x, Y - 3, z, "red-bricks"); c.placeAt(x, Y - 2, z, "oak-planks"); }
    // and a sheet of water down a wall, away from the pond
    for (let y = Y; y <= Y + 5; y++) c.placeAt(cx + 16, y, cz - 1, "stone"); // a wall the water runs down
    c.pourAt(cx + 16, Y + 6, cz);
    c.renderFlags({ robot: false });
  }, cx, cz, Y);
  for (let i = 0; i < 12; i++) { await frames(60); await new Promise((r) => setTimeout(r, 400)); }
  // a teleport scrolls the field window under the player: grid coordinates move, so follow the origin
  const origin = () => page.evaluate(() => { const c = globalThis.__roboCraft, a = c.absolute(), p = c.snapshot().pos; return [Math.round(a[0] - p[0]), Math.round(a[1] - p[2])]; });
  const o0 = await origin();
  const here = async (pos) => { const o = await origin(); return [pos[0] + o0[0] - o[0], pos[1], pos[2] + o0[1] - o[1]]; };
  const state = () => page.evaluate(() => {
    const c = globalThis.__roboCraft, tint = document.querySelector(".craft-underwater");
    return { underwater: c.water().underwater, on: tint.classList.contains("on"), clip: tint.style.clipPath, cam: c.cameraState?.() ?? null, inside: c.blockAt(...c.snapshot().pos.map(Math.floor)) };
  });
  const at = async (name, pos, yaw, pitch) => {
    await page.evaluate(([p, y, pi]) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); }, [await here(pos), yaw, pitch]);
    await frames(50);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    return state();
  };
  const deep = await at("deep", [cx + 0.5, Y - 2.9, cz + 4.5], Math.PI, 0.05);
  check("well under the pond's surface the screen is underwater", deep.underwater && deep.on && deep.clip === "", JSON.stringify(deep).slice(0, 160));
  // First person (the camera IS the eye), lowered through the surface a centimetre at a time: the
  // wash must cover a growing part of the screen on the way — never nothing and then everything.
  await page.evaluate(() => globalThis.__roboCraft.firstPerson(true));
  const seen = [];
  let shot = false;
  for (let dy = 0.5; dy > -0.9; dy -= 0.01) {
    const cover = await page.evaluate(([p]) => new Promise((done) => {
      const c = globalThis.__roboCraft; c.teleport(...p); c.look(Math.PI, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => done(c.water().cover)));
    }), [await here([cx + 0.5, Y - 1 + dy, cz + 4.5])]);
    if (cover > 0.02 && cover < 0.98) {
      seen.push(cover);
      if (!shot && cover > 0.35 && cover < 0.65) {
        shot = true;
        // hold the eye there while the wash fades in (0.15 s), then shoot
        const held = await here([cx + 0.5, Y - 1 + dy, cz + 4.5]);
        for (let i = 0; i < 30; i++) await page.evaluate(([p]) => new Promise((done) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(Math.PI, 0); requestAnimationFrame(() => done()); }), [held]);
        console.log("held", JSON.stringify(await page.evaluate(() => { const t = document.querySelector(".craft-underwater"); return { cover: globalThis.__roboCraft.water().cover, clip: t.style.clipPath, opacity: getComputedStyle(t).opacity }; })));
        await page.screenshot({ path: `${OUT}/waterline.png` });
      }
    }
  }
  const partial = seen.length > 0;
  await page.evaluate(() => globalThis.__roboCraft.firstPerson(false));
  check("crossing the surface, the wash covers only the part of the screen below the waterline", partial && seen.every((c, i) => i === 0 || c >= seen[i - 1] - 0.25), `${seen.length} steps: ${seen.slice(0, 8).map((c) => c.toFixed(2)).join(" ")}`);
  const above = await at("above", [cx + 0.5, Y + 2, cz + 12], Math.PI, -0.4);
  check("standing on the bank it is not", !above.underwater && !above.on, JSON.stringify(above).slice(0, 160));
  const fall = await at("fall", [cx + 16.5, Y + 0.05, cz + 0.5], Math.PI, 0.3);
  check("inside a sheet of water running down a wall it is not", !fall.underwater && !fall.on, JSON.stringify(fall).slice(0, 160));
  console.log(failed ? `${failed} FAILED` : "all underwater checks passed");
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
