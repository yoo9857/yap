// Web ↔ native comparison: shoot Craft Island in the web game from a few fixed viewpoints, and
// write each camera (eye, look direction, fov) so the native client can render the SAME view:
//   node tools/shot-native-compare.mjs [outdir]        (needs `pnpm dev`)
//   → <outdir>/web-<name>.png + views.json
//   then: CRAFTYAP_VIEW="ex,ey,ez,dx,dy,dz,fov" target/release/craftyap.exe   (engine/)
// This is how gaps between the web renderer and the native one are found (docs/ANDROID.md).
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "tmp/compare";
mkdirSync(OUT, { recursive: true });

// robot position + view yaw/pitch (the third-person camera sits behind the robot)
const VIEWS = [
  { name: "castle", at: [40, 30, 66], yaw: 0, pitch: -0.25 },
  { name: "meadow", at: [100, 40, 100], yaw: 2.4, pitch: -0.15 },
  { name: "shore", at: [20, 40, 120], yaw: -0.8, pitch: -0.2 },
];

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?mode=craft&reset=1", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden") && globalThis.__roboCraft, { timeout: 60000 });
await page.evaluate(() => {
  const scene = globalThis.__roboCraft.scene();
  scene.onBeforeRender = (_r, _s, cam) => (globalThis.__cam = cam);
  globalThis.__roboCraft.renderFlags({ robot: false });
});
const views = [];
for (const v of VIEWS) {
  await page.evaluate((v) => globalThis.__roboCraft.teleport(...v.at), v);
  await new Promise((r) => setTimeout(r, 2500)); // fall, land, chunks settle
  await page.evaluate((v) => globalThis.__roboCraft.look(v.yaw, v.pitch), v);
  await new Promise((r) => setTimeout(r, 1500));
  // hide the HUD/menu so only the world is compared
  await page.evaluate(() => document.querySelectorAll("body > *:not(canvas):not(#app)").forEach((e) => (e.style.visibility = "hidden")));
  const cam = await page.evaluate(() => {
    const c = globalThis.__cam;
    const e = c.matrixWorld.elements;
    return { eye: [e[12], e[13], e[14]], dir: [-e[8], -e[9], -e[10]], fov: c.fov, near: c.near, far: c.far };
  });
  await page.screenshot({ path: `${OUT}/web-${v.name}.png` });
  views.push({ name: v.name, ...cam, env: [...cam.eye, ...cam.dir, cam.fov].map((n) => +n.toFixed(4)).join(",") });
  console.log(v.name, views.at(-1).env);
}
writeFileSync(`${OUT}/views.json`, JSON.stringify(views, null, 2));
await browser.close();
