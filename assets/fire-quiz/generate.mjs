// Generates the fire drill's QUIZ art (the teacher's quiz, craft/fire/fireQuiz.ts) with the Codex
// CLI's image generation, in the in-game pack's lineless soft-3D style (assets/ui-game). One Codex
// run per picture, a few at a time; pictures already in raw/ are skipped, so re-running only fills
// the gaps.
//
//   node assets/fire-quiz/generate.mjs              # everything missing
//   node assets/fire-quiz/generate.mjs fire-bin     # just these names
//
// Then: node assets/fire-quiz/build.mjs  (trim, scale, WebP → apps/client/public/ui/quiz)
//
// The pictures carry NO text and NO right/wrong marks: the quiz draws those itself (two languages,
// and a picture must not give its own answer away).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
// the style reference: this pack's own hero once it exists (generate it first, look at it, then the
// rest follow it), else the in-game pack's hero
const HERO = join(RAW, "fire-bin.png"), GAME_HERO = join(HERE, "../ui-game/raw/btn-round.png");
const REFS = process.env.UI_REF ? process.env.UI_REF.split(",").map((p) => join(HERE, p)) : existsSync(HERO) ? [HERO] : existsSync(GAME_HERO) ? [GAME_HERO] : [];
const PARALLEL = Number(process.env.UI_PARALLEL ?? 4);
const CODEX_JS = process.env.CODEX_JS ?? join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
mkdirSync(RAW, { recursive: true });

const STYLE = `Illustration for a children's fire-safety puzzle game inside a cute kids' voxel building game called CraftYap, in a modern LINELESS soft-3D style (the clay / soft-plastic look of current casual mobile games). NO outlines and NO dark ink lines anywhere: every shape is separated only by colour and value. Rendered like smooth satin toy plastic (not glassy, not wet): soft studio light from the upper left, gentle gradients, a subtle warm rim light, soft ambient occlusion where parts meet and a soft contact shadow on the floor. Rounded, chunky, slightly squishy forms; toy-brick details (round studs, brick proportions) where they fit. Palette, saturated but softened: sunny yellow #ffd21c, sky blue #3d8bf0, grass green #5cc455, warm wood #d39a5c, cream #fff6e3, coral red #ff5a6e, soft navy #2b3f7a; fire is warm orange and yellow, smoke is soft grey. Friendly and calm, never frightening: no injuries, no panic faces. One clear subject, centred, filling about 80% of the canvas, readable at 200 px. TRANSPARENT background (a real alpha channel, not a drawn checkerboard). No text, no letters, no numbers, no logos, no watermark, no check marks, no crosses.`;
// The quiz's own UI pieces (board, buttons, stars): the in-game pack's words (assets/ui-game), so the
// quiz reads as part of the same game. Unlike the pictures they MAY carry a ring or a cross.
const UI_STYLE = `Game UI asset for a cute kids' voxel building game called CraftYap, in a modern LINELESS soft-3D style (the clay / soft-plastic look of current casual mobile games). NO outlines and NO dark ink lines anywhere: every shape is separated only by colour and value. Rendered like smooth satin toy plastic (not glassy, not wet): soft studio light from the upper left, gentle gradients, a subtle warm rim light, soft ambient occlusion where parts meet and a soft contact shadow under raised parts. Rounded, chunky, slightly squishy forms; toy-brick details (round studs on top, brick proportions) where they fit. Palette, saturated but softened: sunny yellow #ffd21c, sky blue #3d8bf0, grass green #5cc455, warm wood #d39a5c, cream #fff6e3, coral red #ff5a6e, soft navy #2b3f7a. Flat FRONT view, no perspective tilt, centred, symmetrical. TRANSPARENT background (a real alpha channel, not a drawn checkerboard). No text, no letters, no numbers, no logos, no watermark.`;
// the same child in every picture
const KID = "the game's mascot: a cute chunky cube-shaped character in sunny yellow, like a toy brick with a simple friendly face (two dot eyes, a small smile) on its front, short round arms and short legs";

const ASSETS = [
  // the hero: what "a small fire" is
  ["fire-bin", "1024x1024", "A small fire burning in a round metal waste-paper bin standing on a light classroom floor: orange and yellow flames about as tall as the bin itself, a little soft grey smoke above them. Seen from the front, the bin in the lower half, the flames in the upper half, clear empty space left and right."],
  ["fire-big", "1024x1024", "A big fire: tall orange flames filling an open classroom doorway from floor to top, much taller than a child, with thick dark-grey smoke rolling out at the top of the door. A small school desk beside the door shows how big the fire is."],
  ["phone", "1024x1024", "A chunky red toy telephone handset lying at a slight angle, with a coiled cord, seen from the front. Nothing else."],
  // the extinguisher, in four steps (each one a single clear action; no arrows that give an order away)
  ["pass-pin", "1024x1024", `Close-up of the top of a red fire extinguisher: a yellow mitten-like hand pulling the round metal safety-pin ring sideways out of the handle. The pin and its ring are the clear focus.`],
  ["pass-aim", "1024x1024", `${KID} holding a red fire extinguisher in both hands and pointing its black hose nozzle down toward a small fire in a waste bin at the lower right. Nothing is spraying yet.`],
  ["pass-squeeze", "1024x1024", `Close-up of the top of a red fire extinguisher: a yellow mitten-like hand squeezing the black lever handle down firmly. The pressed handle is the clear focus. No pin in it.`],
  ["pass-sweep", "1024x1024", `${KID} spraying a wide white cloud of powder from a red fire extinguisher's hose across the bottom of a small fire in a waste bin, the hose swung to one side as if sweeping from side to side; the flames are getting smaller.`],
  // what to do
  ["act-alarm", "1024x1024", `${KID} reaching up and pressing a round red fire-alarm button on a wall, a small red bell above it ringing with little motion lines.`],
  ["act-towel", "1024x1024", `${KID} holding a wet sky-blue towel over its nose and mouth with both hands, a few water drops falling from the towel.`],
  ["act-low", "1024x1024", `${KID} crawling low on hands and knees along a floor; a thick layer of soft grey smoke fills the top third of the picture and the air near the floor is clear.`],
  ["act-exit", "1024x1024", `${KID} walking toward a doorway with a glowing green emergency-exit sign above it (a white running-figure pictogram on green, no letters) and stairs leading down beyond the door.`],
  ["act-gather", "1024x1024", `Four of ${KID.replace("the game's mascot: a cute", "cute")} standing calmly together inside a green circle painted on a schoolyard, a small flag on a pole beside them, a toy-brick school building small in the background.`],
  // what NOT to do
  ["bad-elevator", "1024x1024", `An elevator with its doors open and soft grey smoke drifting out of it; ${KID} stands in front of it, about to step in.`],
  ["bad-goback", "1024x1024", `${KID} running back toward a school door that has grey smoke coming out of it, reaching for a blue backpack left just inside the door.`],
  ["bad-hide", "1024x1024", `${KID} crouching and hiding under a wooden school desk while soft grey smoke fills the room around it.`],
  ["bad-upright", "1024x1024", `${KID} walking upright with its head inside a thick layer of grey smoke that fills the top half of the picture, one hand waving the smoke away.`],
  // the quiz's own pieces
  ["medal", "1024x1024", "A chunky gold medal with a big star embossed on it, hanging from a short red-and-white ribbon. Front view."],
  ["cheer", "1024x1024", `${KID} jumping with both arms up, very happy, with a few small yellow confetti stars around it.`],
  ["think", "1024x1024", `${KID} tilting its head with one hand on its chin, thinking, with a small soft-yellow light bulb glowing above it.`],
  // the quiz's UI (a 4th entry: drawn in UI_STYLE)
  ["ui-o", "1024x1024", "A big round push button of soft grass-green plastic, slightly domed, with a thick raised white ring (a plain circle: the sign for YES) on its face. Fills about 82% of the canvas.", "ui"],
  ["ui-x", "1024x1024", "A big round push button of soft coral-red plastic, slightly domed, with a thick raised white diagonal cross (the sign for NO) on its face. Fills about 82% of the canvas.", "ui"],
  ["ui-target", "1024x1024", "A round aiming ring: one chunky white soft-plastic ring with four small sunny-yellow tabs pointing inward at the top, bottom, left and right. The middle of the ring is completely empty and transparent. Fills about 86% of the canvas.", "ui"],
  ["ui-star", "1024x1024", "One chunky, puffy five-pointed star in glossy gold with a soft highlight. Fills about 84% of the canvas.", "ui"],
  ["ui-star-off", "1024x1024", "One chunky, puffy five-pointed star in pale cream-grey, matte, as an empty placeholder of the same shape. Fills about 84% of the canvas.", "ui"],
];

const only = process.argv.slice(2);
const todo = ASSETS.filter(([name]) => (only.length ? only.includes(name) : true) && !existsSync(join(RAW, `${name}.png`)));
console.log(`${todo.length} to generate (${ASSETS.length - todo.length} already in raw/)`);

function run([name, size, subject, kind]) {
  const prompt = `Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. It must be a PNG with a real transparent alpha background (if the tool returns an opaque image, remove the flat background so it becomes transparent). The attached image, if any, is ONLY a style reference (a finished picture of the same pack: match its lineless soft-3D plastic, lighting and colours exactly); do not copy its subject.\n\n${kind === "ui" ? UI_STYLE : STYLE}\n\nSubject: ${subject}\nCanvas: ${size}.\n\nDo not create or change any other file. When the file is saved, reply with its path only.`;
  return new Promise((resolve) => {
    const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE];
    // `-i` takes several files, so nothing may follow it: the prompt comes on stdin
    for (const ref of REFS) args.push("-i", ref);
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
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
  while (queue.length) await run(queue.shift());
}));
const missing = ASSETS.filter(([name]) => !existsSync(join(RAW, `${name}.png`))).map(([n]) => n);
writeFileSync(join(RAW, "_status.json"), JSON.stringify({ at: new Date().toISOString(), missing }, null, 2));
console.log(missing.length ? `\nStill missing (${missing.length}): ${missing.join(", ")}\nRun the script again to retry them.` : "\nAll pictures generated.");
