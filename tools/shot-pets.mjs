// Pose every adoptable pet on the ?preview=char turntable and screenshot it.
// This is how the rigs' proportions get judged — reasoning about rounded boxes
// with a constant-width ink line does not work, you have to look.
//
//   node tools/shot-pets.mjs <outdir> [species]
//
// With no species it shoots the whole lineup plus a per-species sheet.
// Needs `pnpm dev` running. Headless Edge + swiftshader, like the other tools.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const EDGE = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const OUT = process.argv[2] ?? "shots";
const ONLY = process.argv[3] ?? null;
mkdirSync(OUT, { recursive: true });

const D = Math.PI / 180;
// Camera framing per species: [eyeY, distance, lookY]. A giraffe and a cat
// cannot share one framing — the cat becomes a speck or the giraffe loses its
// head off the top of the shot.
const FRAME = {
  dog: [0.62, 2.1, 0.45],
  cat: [0.52, 1.8, 0.38],
  elephant: [1.2, 3.6, 0.95],
  giraffe: [1.5, 4.2, 1.2],
  panda: [0.8, 2.6, 0.6],
};
// Head height and the distance a face needs to fill the frame. Faces are
// where every one of these rigs has gone wrong, and they are unjudgeable at
// whole-body framing — a blob that reads fine at two metres is a mess at arm's
// length, and the pet stands right next to the player in game.
const FACE = {
  dog: [0.84, 0.95],
  cat: [0.6, 0.8],
  elephant: [1.42, 1.6],
  giraffe: [2.2, 1.0],
  panda: [1.05, 1.25],
};
const POSES = [
  ["front-idle", "idle", 0],
  ["side-idle", "idle", 90 * D],
  ["threequarter-idle", "idle", 35 * D],
  ["side-walk", "walk", 90 * D],
  ["side-run", "run", 90 * D],
  ["threequarter-sit", "sit", 35 * D],
];
const FACE_POSES = [
  ["face-front", "idle", 0],
  ["face-threequarter", "idle", 32 * D],
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text()); });

await page.goto("http://localhost:5173/?preview=char", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__charPreview, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));

const species = ONLY ? [ONLY] : await page.evaluate(() => globalThis.__charPreview.pets.map((p) => p.species));

if (!ONLY) {
  // The lineup: everybody at once, which is the only way a species that has
  // drifted off-model (wrong bulk, wrong ink weight) becomes obvious.
  await page.evaluate(() => {
    globalThis.__charPreview.solo(null);
    globalThis.__charPreview.pinPets("idle", 20 * (Math.PI / 180));
    globalThis.__charPreview.camera.position.set(0, 1.9, 9.4);
    globalThis.__charPreview.camera.lookAt(0, 1.0, 1.4);
  });
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${OUT}/00-lineup.png` });
  console.log("shot 00-lineup");
}

for (const key of species) {
  const frame = FRAME[key] ?? FRAME.dog;
  for (const [name, anim, yaw] of POSES) {
    await page.evaluate(
      (k, f, a, y) => {
        globalThis.__charPreview.solo(k);
        globalThis.__charPreview.pinPets(a, y);
        globalThis.__charPreview.camera.position.set(0, f[0], 1.8 + f[1]);
        globalThis.__charPreview.camera.lookAt(0, f[2], 1.8);
      },
      key, frame, anim, yaw,
    );
    await new Promise((r) => setTimeout(r, 900)); // let the sit/gait settle
    await page.screenshot({ path: `${OUT}/${key}-${name}.png` });
  }

  const face = FACE[key] ?? FACE.dog;
  for (const [name, anim, yaw] of FACE_POSES) {
    await page.evaluate(
      (k, f, a, y) => {
        globalThis.__charPreview.solo(k);
        globalThis.__charPreview.pinPets(a, y);
        globalThis.__charPreview.camera.position.set(0, f[0], 1.8 + f[1]);
        globalThis.__charPreview.camera.lookAt(0, f[0], 1.8);
      },
      key, face, anim, yaw,
    );
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: `${OUT}/${key}-${name}.png` });
  }
  console.log("shot", key);
}

await browser.close();
