// Generates the IN-GAME HUD asset pack (hotbar, touch buttons, stick, bars, plates, and two animated
// sprite sheets) with the Codex CLI's image generation, in the SAME style as assets/ui-hub (the
// home hub's pack). One Codex run per asset, a few at a time; files already in raw/ are skipped.
//
//   node assets/ui-game/generate.mjs            # everything missing
//   node assets/ui-game/generate.mjs btn-round  # just these names
//
// Then: node assets/ui-game/build.mjs  (trim, scale, slice the sheets, WebP → apps/client/public/ui/game)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
// the style reference: the pack's own hero piece once it exists (generate it first, review it, then
// the rest follow its look); UI_REF overrides. The ink-outlined hub art is NOT a reference any more:
// the in-game pack is lineless (owner's call 2026-11-05 — the outlined set read as artificial).
const HERO = join(RAW, "btn-round.png");
const REFS = process.env.UI_REF ? process.env.UI_REF.split(",").map((p) => join(HERE, p)) : existsSync(HERO) ? [HERO] : [];
const PARALLEL = Number(process.env.UI_PARALLEL ?? 4);
const CODEX_JS = process.env.CODEX_JS ?? join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
mkdirSync(RAW, { recursive: true });

// the hub pack's style, word for word (assets/ui-hub/generate.mjs): the two packs must read as one game
const STYLE = `Game UI asset for a cute kids' voxel building game called CraftYap, in a modern LINELESS soft-3D style (the clay / soft-plastic look of current casual mobile games). NO outlines and NO dark ink lines anywhere: every shape is separated only by colour and value. Rendered like smooth satin toy plastic (not glassy, not wet): soft studio light from the upper left, gentle gradients, a subtle warm rim light, soft ambient occlusion where parts meet and a soft contact shadow under raised parts. Rounded, chunky, slightly squishy forms; toy-brick details (round studs on top, brick proportions) where they fit. Palette, saturated but softened: sunny yellow #ffd21c, sky blue #3d8bf0, grass green #5cc455, warm wood #d39a5c, cream #fff6e3, coral red #ff5a6e, soft navy #2b3f7a. Flat FRONT view, no perspective tilt, centred, symmetrical. TRANSPARENT background (a real alpha channel, not a drawn checkerboard). No text, no letters, no numbers, no logos, no watermark.`;
const ICON = "A single in-game HUD icon, centred, filling about 70% of the canvas, chunky and readable at 40px, lineless soft-3D, transparent background.";
const SHEET = "A sprite sheet: a 3 x 2 grid of SIX equal square cells (each exactly a third of the width and half of the height), frames read left to right, top row first. Every cell shows the SAME subject at the SAME size and position, only the animation stage changes. No borders, no gaps drawn, no numbers. Transparent background everywhere.";

const ASSETS = [
  // hotbar
  ["slot", "1024x1024", "A square hotbar slot made of one cream toy brick seen from the front: a thick white satin rim, slightly rounded corners, the inside a flat soft cream (#fff7e0) recess so an item icon can sit on it. Even rim thickness about 9% of the width. Plain, no studs on the face."],
  ["slot-selected", "1024x1024", "The same square hotbar slot, selected: a thick sunny-yellow satin rim with tiny studs along its top edge and a soft golden glow just outside the rim; the inside the same flat cream recess. Even rim about 9%."],
  // touch controls
  ["btn-round", "1024x1024", "A big round touch button: a white satin toy-brick disc, a soft darker underside so it looks pressable, a soft highlight on the top half. Plain face, nothing drawn on it."],
  ["btn-round-pressed", "1024x1024", "The same round white button pressed down: the dark bottom edge almost gone, the face a little darker and lower. Plain face."],
  ["stick-base", "1024x1024", "A virtual joystick base: a large translucent-looking navy ring of toy bricks with four small arrow notches (up, down, left, right) on the ring, the centre empty and transparent."],
  ["stick-knob", "1024x1024", "A joystick knob: a round sunny-yellow toy-brick button with four studs on its face in a square and a pressable darker bottom edge."],
  ["glyph-dig", "1024x1024", `${ICON} Subject: a chunky toy pickaxe with a wooden handle and a grey stone head, tilted 45 degrees.`],
  ["glyph-place", "1024x1024", `${ICON} Subject: a single cream toy brick with four studs and a small green plus sign badge on its corner.`],
  ["glyph-jump", "1024x1024", `${ICON} Subject: a bold upward chevron arrow made of two yellow toy bricks.`],
  ["glyph-chat", "1024x1024", `${ICON} Subject: a white speech bubble with three dots.`],
  ["glyph-exit", "1024x1024", `${ICON} Subject: a little wooden door slightly open with an arrow pointing out.`],
  // bars and plates
  ["progress-frame", "1536x1024", "A thin horizontal progress bar frame across the middle of the canvas: a navy rounded bar with a cream brick rim, studs along the top, the inside transparent (the fill is drawn later). Rounded ends, even rim. Everything outside transparent."],
  ["name-plate", "1536x1024", "A small horizontal name tag plate in the middle of the canvas: a navy rounded pill with a thin yellow brick rim and one tiny stud at each end; the face plain (text is added later). Everything else transparent."],
  ["toast-frame", "1536x1024", "A wide notification banner in the middle of the canvas: a sunny-yellow toy-brick plaque with studs along the top, rounded ends, a plain face (text is added later). Everything else transparent."],
  // pets (the adoption chip and its five choices; the animals match creatureRig.ts's look)
  ["glyph-paw", "1024x1024", `${ICON} Subject: a single chunky paw print, four toes and a pad, warm wood brown with a cream highlight.`],
  ["pet-dog", "1024x1024", `${ICON} Subject: the head of a cute blocky shiba inu dog, front view, orange-tan and cream fur, pointy ears, made of rounded toy bricks, friendly smile.`],
  ["pet-cat", "1024x1024", `${ICON} Subject: the head of a cute blocky white cat, front view, pink inner ears, green eyes, made of rounded toy bricks.`],
  ["pet-elephant", "1024x1024", `${ICON} Subject: the head of a cute blocky baby elephant, front view, soft grey, big round ears, short curled trunk, made of rounded toy bricks.`],
  ["pet-giraffe", "1024x1024", `${ICON} Subject: the head of a cute blocky baby giraffe, front view, yellow with brown patches, two little horns, made of rounded toy bricks.`],
  ["pet-panda", "1024x1024", `${ICON} Subject: the head of a cute blocky panda, front view, white with black ears and black eye patches, made of rounded toy bricks.`],
  // the lobby's navigation rail and the in-game side column: one icon family (same size, weight, light)
  ["nav-home", "1024x1024", `${ICON} Subject: a small rounded toy house with a sunny-yellow roof and a cream front with a round door, one stud on the roof ridge.`],
  ["nav-edu", "1024x1024", `${ICON} Subject: a soft green chalkboard on a little wooden easel with a small cream building brick resting on its ledge.`],
  ["nav-play", "1024x1024", `${ICON} Subject: a chunky rounded game controller in sky blue with a yellow d-pad and two coral buttons.`],
  ["nav-friends", "1024x1024", `${ICON} Subject: two cute rounded blocky buddy heads side by side, one yellow and one sky blue, smiling.`],
  ["nav-settings", "1024x1024", `${ICON} Subject: a chunky rounded cog wheel in soft navy with a cream centre.`],
  ["nav-menu", "1024x1024", `${ICON} Subject: three soft rounded cream bars stacked (a menu icon), puffy and squishy.`],
  ["glyph-bag", "1024x1024", `${ICON} Subject: a cute chunky backpack made of soft rounded warm-wood-brown fabric with a cream flap, a small round yellow button clasp and two studs on top.`],
  // the building shapes (F): one cream toy brick each, seen at a three-quarter angle so the form reads
  ["piece-cube", "1024x1024", `${ICON} Subject: a single cream toy building brick cube with four round studs on top, three-quarter view from above so its shape reads.`],
  ["piece-slope", "1024x1024", `${ICON} Subject: a single cream toy building brick shaped as a ramp (a wedge: a full block cut diagonally, the slope rising from front to back) with two studs on the high back edge, three-quarter view.`],
  ["piece-corner", "1024x1024", `${ICON} Subject: a single cream toy building brick shaped as a corner ramp (a pyramid-like corner piece sloping down on two sides) with one stud on the high corner, three-quarter view.`],
  ["piece-round", "1024x1024", `${ICON} Subject: a single cream toy building brick shaped as a round cylinder with one big round stud on top, three-quarter view.`],
  ["piece-slab", "1024x1024", `${ICON} Subject: a single cream toy building brick plate, half the height of a cube, with four round studs on top, three-quarter view.`],
  ["piece-stairs", "1024x1024", `${ICON} Subject: a single cream toy building brick shaped as two steps of a staircase with studs on each step, three-quarter view.`],
  ["glyph-turn", "1024x1024", `${ICON} Subject: a chunky curved rotation arrow going round clockwise, sky blue, with a small cream toy brick in its centre.`],
  // the lobby's big start button (wide, stretched by its rounded ends)
  ["btn-start", "1536x1024", "A wide pill-shaped start button across the middle of the canvas (about 85% of the width, 30% of the height): sunny-yellow soft satin plastic, a row of small round studs along its top edge, a soft darker golden underside so it looks pressable, a gentle highlight on the upper half. Plain face, nothing written on it. Everything else transparent."],
  ["btn-start-pressed", "1536x1024", "The same wide yellow pill start button pressed down: the darker underside almost gone, the face a touch darker and lower, studs along the top. Plain face. Everything else transparent."],
  // the teacher's F2 class tools: one icon family with the nav rail (same size, weight, light)
  ["tool-seat", "1024x1024", `${ICON} Subject: a small square patch of green grass ground seen from slightly above, bordered by a low cream picket fence, with a tiny yellow wooden name sign on a post at its front edge.`],
  ["tool-gather", "1024x1024", `${ICON} Subject: a chunky sunny-yellow megaphone pointing right with three small soft sky-blue sound arcs in front of it.`],
  ["tool-clear", "1024x1024", `${ICON} Subject: a cute chunky broom with a warm wood handle and a sunny-yellow bristle head sweeping up two small cream fence pieces.`],
  ["tool-roam", "1024x1024", `${ICON} Subject: a pair of chunky rounded sneaker shoe prints walking diagonally, sky blue with cream soles.`],
  ["tool-home", "1024x1024", `${ICON} Subject: a chunky cream wooden school chair with a small sunny-yellow seat cushion and a soft green curved arrow pointing down into it.`],
  ["tool-freeze", "1024x1024", `${ICON} Subject: a big friendly open hand raised palm forward (a gentle "stop, look here" gesture), coral red sleeve cuff, cream hand, with a small soft sky-blue snowflake badge on the corner.`],
  ["tool-timer", "1024x1024", `${ICON} Subject: a chunky round stopwatch in sunny yellow with a cream face, one soft navy hand, a button on top, a coral red quarter wedge marking time on the face.`],
  ["tool-visit", "1024x1024", `${ICON} Subject: a pair of chunky rounded binoculars in soft navy with sky-blue glossy lenses.`],
  ["tool-announce", "1024x1024", `${ICON} Subject: a small rounded cream billboard sign on two wooden legs with a big coral red exclamation-shaped balloon floating above it (no letters).`],
  ["tool-lock-build", "1024x1024", `${ICON} Subject: a single cream toy brick with four studs and a chunky golden padlock hanging on its front.`],
  ["tool-lock-chat", "1024x1024", `${ICON} Subject: a white rounded speech bubble with a chunky golden padlock in front of its lower corner.`],
  ["tool-teacher", "1024x1024", `${ICON} Subject: a soft green chalkboard with a small sunny-yellow star and a cream apple resting on its wooden ledge.`],
  // animated sheets
  ["fx-crack", "1536x1024", `${SHEET} Subject: cracks spreading over a square block face, drawn as deep recessed fissures (dark grey-brown inside with a pale lit edge on one side, NOT ink lines; no block, no fill): frame 1 a tiny chip at the centre, frame 6 cracks reaching all four edges, each frame a little more cracked.`],
  ["fx-poof", "1536x1024", `${SHEET} Subject: a cute cartoon dust puff when a toy brick lands: frame 1 a tiny puff at the bottom centre, frames 2-4 three or four round cream clouds and small brick crumbs growing outward, frames 5-6 the clouds fading and shrinking away to almost nothing.`],
];

const only = process.argv.slice(2);
const todo = ASSETS.filter(([name]) => (only.length ? only.includes(name) : true) && !existsSync(join(RAW, `${name}.png`)));
console.log(`${todo.length} to generate (${ASSETS.length - todo.length} already in raw/)`);

function run([name, size, subject]) {
  const prompt = `Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. It must be a PNG with a real transparent alpha background (if the tool returns an opaque image, remove the flat background so it becomes transparent). The attached image, if any, is ONLY a style reference (a finished asset of the same pack: match its lineless soft-3D plastic, lighting and colours exactly); do not copy its subject.\n\n${STYLE}\n\nSubject: ${subject}\nCanvas: ${size}.\n\nDo not create or change any other file. When the file is saved, reply with its path only.`;
  return new Promise((resolve) => {
    const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE];
    const refs = REFS.filter((p) => existsSync(p));
    if (refs.length) args.push("-i", ...refs);
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
console.log(missing.length ? `\nStill missing (${missing.length}): ${missing.join(", ")}\nRun the script again to retry them.` : "\nAll assets generated.");
