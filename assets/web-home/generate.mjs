// Generates the web home's pictures with the Codex CLI's image generation (ChatGPT login):
// the hero scene without a logo (the first frame of the menu video), the two worlds of the
// mode choice, and the mascot for the way-in card. One Codex run per picture; pictures already
// in raw/ are skipped, so running it again only fills the gaps (delete one to redo it).
//
//   node assets/web-home/generate.mjs              # everything missing
//   node assets/web-home/generate.mjs world-games   # just these names
//
// Then: node assets/web-home/build.mjs  (→ apps/client/public/home/*.webp)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
// the approved menu art: every picture here belongs to that world
const REF = process.env.WEB_REF ?? join(HERE, "../../output/grok/craftyap-sunny-village-loop-20261028/v3-detailed-world/reference.png");
const PARALLEL = Number(process.env.WEB_PARALLEL ?? 4);
const CODEX_JS = process.env.CODEX_JS ?? join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
mkdirSync(RAW, { recursive: true });

const WORLD = `A bright, cheerful 3D illustration for a kids' block-building game: everything is built from chunky glossy toy building bricks with studs, soft rounded edges, soft studio daylight, gentle shadows, saturated candy colours. The cute characters are simple block creatures with dot eyes and rosy cheeks (a yellow cube child with a blue cap is the hero). It is the SAME world and rendering style as the attached reference picture. No text, no letters, no numbers, no logo, no watermark, no UI, no frame.`;

const ASSETS = [
  ["hero-village", "1536x1024", `Recreate the attached reference picture as faithfully as you can: the same sunny toy-brick village, the castle with waterfalls on the left, the river and stone bridge in the middle, the market, waterwheel and windmill on the right, the floating islands, the same characters in the same places, the same framing, light and palette. ONE change: remove the big logo and every letter completely. Where the logo was there is open blue sky with soft white clouds and two or three small distant floating islands. Keep the little white flying robot. No text, no letters, no logo, no watermark anywhere. Keep the important scenery inside the middle 16:9 band of the canvas (the top and bottom 8% may be cropped).`],
  ["world-education", "1536x1024", `${WORLD}\n\nScene: an outdoor toy-brick CLASSROOM on an endless flat green studded field under a soft pale sky. Block children build one colourful brick house together: the yellow cube child with the blue cap lifts a brick, a purple bunny cube and a blue cube help, a small brown puppy watches. A green chalkboard on an easel, a few little brick desks, a school bell on a post. Dominant colours: fresh greens with yellow accents. COMPOSITION: the whole scene sits in the LOWER HALF of the picture, centred; the UPPER 45% is calm open sky with a few soft clouds only (large text is laid over it later). Eye-level, slightly from above, like a diorama.`],
  ["world-games", "1536x1024", `${WORLD}\n\nScene: an ADVENTURE playground of floating toy-brick islands in a deep blue sky. In the middle a grassy voxel island with a small castle and a waterfall; a tall tower of jump platforms rises beside it; a brick car with big wheels drives over a bridge and a little brick plane flies past; the yellow cube child with the blue cap jumps with joy, two friendly robot cubes cheer. Dominant colours: rich blues with bright red, yellow and green accents. COMPOSITION: the whole scene sits in the LOWER HALF of the picture, centred; the UPPER 45% is calm deep-blue sky with a few soft clouds only (large text is laid over it later). Eye-level, slightly from above, like a diorama.`],
  // the three 플레이 미리보기 pictures: one set, one style (a real screenshot beside an illustration looked like two sites)
  ["preview-build", "1536x1024", `${WORLD}

Scene: the yellow cube child with the blue cap BUILDING a little brick house on a grassy voxel island by the sea: he holds a pickaxe in one hand and sets a brick with the other; a brown puppy sits beside him; a wooden crafting table with bricks on it; trees, flowers and a small waterfall behind. Close, cosy, sunny. COMPOSITION: everything important lies inside the MIDDLE horizontal band of the picture (the top and bottom quarter get cropped away), spread across the full width.`],
  ["preview-machine", "1536x1024", `${WORLD}

Scene: a MACHINE the player built from bricks, driving fast along a grassy path beside a brick castle wall: a chunky car with four big rubber wheels, a glowing cyan thruster at the back, small wings and a propeller, the yellow cube child with the blue cap at the wheel, laughing; dust puffs and speed lines of small bricks behind it. Dynamic three-quarter view. COMPOSITION: everything important lies inside the MIDDLE horizontal band of the picture (the top and bottom quarter get cropped away), spread across the full width.`],
  ["preview-class", "1536x1024", `${WORLD}

Scene: a CLASS building together on a flat green studded field: five different block children (yellow with a blue cap, purple bunny, blue cube, orange cube, pink cube) each on their own small fenced plot, building little brick houses and towers side by side, a friendly teacher block character with round glasses waving in front, a green chalkboard beside her. Bright, friendly, orderly. COMPOSITION: everything important lies inside the MIDDLE horizontal band of the picture (the top and bottom quarter get cropped away), spread across the full width.`],
  // the big picture of a lesson in the lobby's lesson select (one per lesson: add the next lesson's here)
  ["lesson-fire", "1536x1024", `${WORLD}

Scene: a FIRE DRILL at a toy-brick school, friendly and safe, not scary: in a bright school corridor the yellow cube child with the blue cap aims a red fire extinguisher at a small fire in a metal waste bin, white powder spraying; behind, a blue cube child presses a red fire alarm button on the wall and a purple bunny cube crouches low holding a wet towel to its mouth, heading for a green EXIT door with a running-figure sign (no letters); a few soft grey smoke puffs under the ceiling. Dominant colours: warm reds and oranges against cream walls. COMPOSITION: everything important lies inside the MIDDLE horizontal band of the picture (the top and bottom sixth get cropped away), spread across the full width.`],
  // the 도입 사례 page's science lesson (its other two cards use lesson-fire and preview-build)
  ["case-science", "1536x1024", `${WORLD}

Scene: a SCIENCE lesson on a flat green studded field: the yellow cube child with the blue cap and a blue cube child have built a toy-brick WIND TURBINE (a tall white brick tower on a grey brick foundation, three big white blades, a small nacelle); a cable runs from its base to a little brick house whose windows glow warm and to a lamp post that is lit; the yellow child holds up a spare blade piece, the blue child points at the turning blades, happy and proud; a few loose brick parts lie on the grass. Soft sky with a few clouds, no text, no letters, no logos, no UI.`],
  ["mascot", "1024x1024", `${WORLD}\n\nSubject: ONLY the hero, the yellow cube child with the blue cap, whole body, standing and waving one hand with a big happy open smile, a little tilted, seen from the front and slightly from the side. Centred, filling about 80% of the canvas. TRANSPARENT background (a PNG with a real alpha channel, not a drawn checkerboard), no ground, no shadow on the ground.`, true],
];

const only = process.argv.slice(2);
const todo = ASSETS.filter(([name]) => (only.length ? only.includes(name) : true) && !existsSync(join(RAW, `${name}.png`)));
console.log(`${todo.length} to generate (${ASSETS.length - todo.length} already in raw/)`);

function run([name, size, subject, alpha]) {
  const prompt = `Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory.${alpha ? " It must be a PNG with a real transparent alpha background (if the tool returns an opaque image, remove the flat background so it becomes transparent)." : ""} The attached picture is the reference.\n\n${subject}\nCanvas: ${size}.\n\nDo not create or change any other file. When the file is saved, reply with its path only.`;
  return new Promise((resolve) => {
    // `-i` takes several files, so nothing may follow it: the prompt comes on stdin
    const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, "-i", REF];
    const child = spawn(process.execPath, [CODEX_JS, ...args], { stdio: ["pipe", "ignore", "pipe"] });
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
console.log(missing.length ? `\nStill missing (${missing.length}): ${missing.join(", ")}\nRun the script again to retry them.` : "\nAll pictures generated.");
