// Generates the home-hub UI asset pack with the Codex CLI's image generation
// (ChatGPT login). One Codex run per asset, a few at a time; files that already
// exist in raw/ are skipped, so re-running only fills the gaps.
//
//   node assets/ui-hub/generate.mjs            # everything missing
//   node assets/ui-hub/generate.mjs icon-bell   # just these names
//
// Prompts mirror PROMPTS.md (keep the two in step).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
const REF = process.env.UI_REF ?? "C:/Users/AI배움터/Desktop/크래프트얍 봄맞이 크래프트 페스티벌.png";
const PARALLEL = Number(process.env.UI_PARALLEL ?? 4);
// Run Codex's own entry with this node, no shell: the reference image path has
// spaces, and a shell would split it.
const CODEX_JS = process.env.CODEX_JS ?? join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
mkdirSync(RAW, { recursive: true });

const STYLE = `Game UI asset for a cute kids' voxel building game called CraftYap. Style: chunky glossy toy-building-brick plastic (studs on top, rounded edges, soft studio light), mixed with a playful crayon-doodle look: every shape has a thick dark ink outline (#1f1f1f, about 6px at 1024px). Palette: sunny yellow #ffd21c, sky blue #2f7de1, grass green #52b84d, warm wood #cf9152, cream #fff7e0, red accent #ef3a5d. Flat FRONT view, no perspective, no tilt, centred, perfectly symmetrical left/right. TRANSPARENT background (PNG with a real alpha channel, not a drawn checkerboard). No text, no letters, no numbers, no logos, no watermark.`;
const ICON = "A single game icon, centred, filling about 80% of the canvas, chunky 3D toy-brick style, thick ink outline, transparent background.";

const ASSETS = [
  ["panel-frame", "1024x1024", "A square UI panel frame made of toy bricks: a cream rounded-rectangle board edge with a yellow brick rim and small studs along the top edge, and a tiny brick cluster decorating each corner. The INSIDE is completely empty and transparent. Rim thickness exactly the same on all four sides, about 10% of the width. The straight edges between the corners are plain and repeatable."],
  ["panel-frame-blue", "1024x1024", "Same kind of square panel frame, but the rim is sky-blue bricks with white studs and white corner bricks. Inside completely transparent, even rim thickness about 10%, plain repeatable straight edges."],
  ["card-frame", "1024x1536", "A portrait card frame: thick white glossy brick rim with the ink outline, rounded corners, studs only along the top edge. Inside fully transparent. Even rim thickness about 7% of the width."],
  ["card-frame-gold", "1024x1536", "The same portrait card frame in golden-yellow glossy bricks with tiny sparkle stars on the four corners (the selected card). Inside fully transparent, even rim about 7%."],
  ["bar-frame", "1536x1024", "A wide horizontal toolbar frame drawn in the middle third of the canvas: dark navy rounded bar with a yellow brick rim, studs along the top, rounded ends. Inside of the bar transparent. Even rim thickness. Everything outside the bar transparent."],
  ["title-plaque", "1536x1024", "A small horizontal title plaque in the middle of the canvas: a yellow toy-brick bar with studs on top and two little silver nails at the ends; the face is plain yellow (text is added later). Everything else transparent."],
  ["start-button", "1536x1024", "A huge pill-shaped start button in the middle of the canvas, made of one glossy sunny-yellow toy brick, long and wide, a row of studs on top, a darker orange bottom edge so it looks pressable, a white glossy highlight along the top. Plain face, no text, no icon. Everything else transparent."],
  ["start-button-pressed", "1536x1024", "The same huge yellow pill start button pressed down: the dark bottom edge almost gone, the face slightly darker. Plain face. Everything else transparent."],
  ["tab-active", "1024x1024", "A small rounded tab button in the middle of the canvas: white glossy brick with the ink outline and a short blue brick underline. Plain face. Everything else transparent."],
  ["icon-home", "1024x1024", `${ICON} Subject: a little toy-brick house with a red roof.`],
  ["icon-map", "1024x1024", `${ICON} Subject: a folded treasure map with a red pin.`],
  ["icon-create", "1024x1024", `${ICON} Subject: a crossed hammer and wrench made of bricks.`],
  ["icon-community", "1024x1024", `${ICON} Subject: two speech bubbles, one blue and one yellow.`],
  ["icon-bell", "1024x1024", `${ICON} Subject: a golden bell.`],
  ["icon-mail", "1024x1024", `${ICON} Subject: a white envelope with a red heart seal.`],
  ["icon-friends", "1024x1024", `${ICON} Subject: two cute block-head characters side by side.`],
  ["icon-settings", "1024x1024", `${ICON} Subject: a chunky blue gear.`],
  ["icon-bag", "1024x1024", `${ICON} Subject: a brown adventure backpack.`],
  ["icon-shop", "1024x1024", `${ICON} Subject: a little shop stall with a red and white striped awning.`],
  ["icon-character", "1024x1024", `${ICON} Subject: a cute white bunny block-character head.`],
  ["icon-gallery", "1024x1024", `${ICON} Subject: a wooden picture frame showing a tiny voxel island.`],
  ["icon-party", "1024x1024", `${ICON} Subject: a party popper with colourful confetti.`],
  ["icon-trophy", "1024x1024", `${ICON} Subject: a golden trophy cup.`],
  ["icon-guide", "1024x1024", `${ICON} Subject: an open storybook.`],
  ["icon-lock", "1024x1024", `${ICON} Subject: a small golden padlock.`],
  ["icon-coin", "1024x1024", `${ICON} Subject: a gold coin with a star on it.`],
  ["icon-gem", "1024x1024", `${ICON} Subject: a blue crystal gem.`],
  ["icon-calendar", "1024x1024", `${ICON} Subject: a desk calendar with a green check mark.`],
  ["icon-gift", "1024x1024", `${ICON} Subject: a gift box with a red ribbon.`],
  ["icon-grad", "1024x1024", `${ICON} Subject: a graduation cap.`],
  ["icon-crown", "1024x1024", `${ICON} Subject: a golden crown.`],
  ["badge-soon", "1536x1024", "A small rounded coming-soon badge in the middle of the canvas: a yellow brick pill with a tiny padlock on the left; the rest of the face is plain (text is added later). Everything else transparent."],
  ["ribbon-corner", "1024x1024", "A diagonal corner ribbon for the top-right corner of a card: a yellow band with the ink outline running from the top edge to the right edge, plain face. Everything else transparent."],
  ["avatar-frame", "1024x1024", "A square avatar frame of golden bricks with studs on top and a small star at the bottom centre; the inside is completely transparent."],
  ["deco-bricks", "1536x1024", "A loose little pile of 6 to 8 colourful toy bricks and two small flowers, to decorate the corner of a panel. Everything else transparent."],
];

const only = process.argv.slice(2);
const todo = ASSETS.filter(([name]) => (only.length ? only.includes(name) : true) && !existsSync(join(RAW, `${name}.png`)));
console.log(`${todo.length} to generate (${ASSETS.length - todo.length} already in raw/)`);

function run([name, size, subject]) {
  const prompt = `Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. It must be a PNG with a real transparent alpha background (if the tool returns an opaque image, remove the flat background so it becomes transparent). The attached screenshot is ONLY a style reference for the game's look; do not copy its layout or text.\n\n${STYLE}\n\nSubject: ${subject}\nCanvas: ${size}.\n\nDo not create or change any other file. When the file is saved, reply with its path only.`;
  return new Promise((resolve) => {
    const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE];
    // `-i` takes several files, so nothing may follow it: the prompt comes on stdin
    if (existsSync(REF)) args.push("-i", REF);
    const child = existsSync(CODEX_JS)
      ? spawn(process.execPath, [CODEX_JS, ...args], { stdio: ["pipe", "ignore", "pipe"] })
      : spawn("codex", args.map((a) => (/\s/.test(a) ? `"${a}"` : a)), { shell: true, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.end(prompt);
    child.on("close", (code) => {
      const ok = existsSync(join(RAW, `${name}.png`));
      console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : ` (codex exit ${code}) ${err.trim().split("\n").slice(-2).join(" | ")}`}`);
      resolve(ok);
    });
  });
}

const queue = [...todo];
const results = [];
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
  while (queue.length) results.push(await run(queue.shift()));
}));
const missing = ASSETS.filter(([name]) => !existsSync(join(RAW, `${name}.png`))).map(([n]) => n);
writeFileSync(join(HERE, "raw", "_status.json"), JSON.stringify({ at: new Date().toISOString(), missing }, null, 2));
console.log(missing.length ? `\nStill missing (${missing.length}): ${missing.join(", ")}\nRun the script again to retry them.` : "\nAll assets generated.");
