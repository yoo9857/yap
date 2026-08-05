// Render every VR viewpoint to a JPEG and build a single self-contained HTML
// page you can just double-click — the headset-free way to see what VR looks
// like. Needs `pnpm dev` running.
//
//   node tools/vr-tour.mjs [outdir] [landmarkIndex] [buildFraction]
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outDir = process.argv[2] ?? "export/vr";
const landmark = Number(process.argv[3] ?? 3);
const fraction = Number(process.argv[4] ?? 1);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Head pitch, in degrees, that a person would naturally adopt here. */
const LOOK = { plaza: 34, yard: 4, frontier: -8, overlook: -6 };

const NOTES = {
  plaza:
    "Ground level, deliberately closer than a fit-the-whole-thing-in-frame distance. Real 331 m scale only lands when the structure overflows your view and you crane your neck to find the top — the one shot a monitor can never give you.",
  yard: "Down among the brick pile and the crew's path, where the workers are already at eye level.",
  frontier:
    "The construction deck, which climbs as the build rises. Half the build height and well back, so the placed blocks sit between −30° and the horizon with the ghost of what is still to come rising above them.",
  overlook:
    "Level with the monument's middle and close enough that it looms — roughly 85° of vertical view at any landmark scale.",
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=builder&vr=1&reset=1", {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 15000 });
await page.evaluate(
  ([i, f]) => {
    globalThis.__roboBuilder.jumpTo(i, f);
    globalThis.__roboBuilder.addGold(400);
  },
  [landmark, fraction],
);
// Let the reveal "pour" catch up before shooting: capture too early and the
// upper half of the monument is still the translucent ghost of the unbuilt
// blueprint. A big catch-up recaps over ~8 s, so 13 s is comfortably clear.
// (pourDone() is no help here — it only reports TRUE at 100 %, and a fraction
// below 1 is exactly what stops the landmark completing and rolling over.)
await sleep(13000);
// hide the flat-screen DOM HUD: it is not part of what a headset shows
// hide everything a headset would NOT show: the flat DOM HUD and the VR button
await page.addStyleTag({
  content: ".builder-hud, .b-toast, #VRButton, button { display: none !important; }",
});
await page.evaluate(() => globalThis.__roboBuilder.vrPreview(true));

const shots = [];
const seen = new Set();
for (let i = 0; i < 16 && seen.size < 4; i++) {
  await sleep(1500); // past the fade-in
  const s = await page.evaluate(() => globalThis.__roboBuilder.vrStatus());
  if (!seen.has(s.station)) {
    seen.add(s.station);
    await page.evaluate((deg) => globalThis.__roboBuilder.vrLook(deg), LOOK[s.station] ?? 0);
    await sleep(250);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 82, encoding: "base64" });
    writeFileSync(`${outDir}/vr-${s.station}.jpg`, Buffer.from(jpeg, "base64"));
    shots.push({ station: s.station, jpeg, rig: s.rig, yaw: s.yaw });
    console.log(`captured ${s.station.padEnd(9)} rig=[${s.rig.map((v) => v.toFixed(0))}]`);
  }
  await page.evaluate(() => globalThis.__roboBuilder.vrSkip());
  await sleep(800);
}
// and one mid-cut frame, to show the comfort blinder doing its job
await page.evaluate(() => globalThis.__roboBuilder.vrSkip());
let blinkShot = null;
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => globalThis.__roboBuilder.vrStatus());
  if (s.blind > 0.55) {
    blinkShot = await page.screenshot({ type: "jpeg", quality: 82, encoding: "base64" });
    writeFileSync(`${outDir}/vr-cut.jpg`, Buffer.from(blinkShot, "base64"));
    console.log(`captured cut       blind=${s.blind.toFixed(2)}`);
    break;
  }
  await sleep(10);
}
const name = await page.evaluate(
  (i) => globalThis.__roboBuilder.landmarks()[i % 7].name,
  landmark,
);
await browser.close();

const order = ["plaza", "yard", "frontier", "overlook"];
shots.sort((a, b) => order.indexOf(a.station) - order.indexOf(b.station));
const html = `<!doctype html>
<meta charset="utf-8"><title>Robo Builder — VR viewpoints</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:16px/1.6 "Jua",system-ui,sans-serif; background:#12161b; color:#e8eef5; }
  header { padding:28px 24px 8px; max-width:1040px; margin:0 auto; }
  h1 { font-size:1.7rem; margin:0 0 6px; }
  .sub { color:#9fb0c0; margin:0 0 4px; }
  main { max-width:1040px; margin:0 auto; padding:16px 24px 56px; }
  figure { margin:0 0 34px; }
  img { width:100%; height:auto; display:block; border-radius:12px; border:2px solid #2b3440; }
  figcaption { padding:10px 2px 0; }
  .name { font-weight:700; color:#f9d71c; }
  .note { color:#b9c6d4; }
  .meta { color:#7d8b99; font-size:.85rem; font-family:ui-monospace,monospace; }
</style>
<header>
  <h1>Robo Builder — what VR actually looks like</h1>
  <p class="sub">${name}, rendered through the VR rig at a headset-like 100° field of view. Flat-screen capture, no headset needed.</p>
  <p class="meta">In a headset you also get stereo depth and free head-look; the viewpoint itself never moves.</p>
</header>
<main>
${shots
  .map(
    (s) => `  <figure>
    <img alt="${s.station} viewpoint" src="data:image/jpeg;base64,${s.jpeg}">
    <figcaption>
      <div class="name">${s.station}</div>
      <div class="note">${NOTES[s.station] ?? ""}</div>
      <div class="meta">standing at x=${s.rig[0].toFixed(0)} y=${s.rig[1].toFixed(0)} z=${s.rig[2].toFixed(0)} m &middot; head tilted ${LOOK[s.station] ?? 0}&deg;</div>
    </figcaption>
  </figure>`,
  )
  .join("\n")}
${
  blinkShot
    ? `  <figure>
    <img alt="mid-cut blinder" src="data:image/jpeg;base64,${blinkShot}">
    <figcaption>
      <div class="name">between viewpoints</div>
      <div class="note">Every change of viewpoint is a cut hidden behind a black blinder sphere on the head. A teleport you can see still reads as a lurch, and that is what makes people sick.</div>
    </figcaption>
  </figure>`
    : ""
}
</main>`;
writeFileSync(`${outDir}/index.html`, html);
console.log(`\nwrote ${outDir}/index.html  (open this — images are embedded)`);
