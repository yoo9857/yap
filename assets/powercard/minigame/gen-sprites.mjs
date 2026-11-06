// Mini-game sprites, cut from the approved mockups' style (ChatGPT image generation via Codex).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const STYLE = "in EXACTLY the style of the attached mockup: premium soft clay / satin 3D game art, gentle studio light from the upper left, pastel colours, smooth rounded forms, NO outlines, no text unless asked";
const SPRITE = "a single isolated game sprite on a FULLY TRANSPARENT background (PNG with alpha — use the image tool's transparent background option), centred, nothing else in the image, no shadow on the ground, no frame";
const JOBS = [
  ["g-scene", "mock-grounding", `The STAGE BACKGROUND of the grounding mini-game ${STYLE}: a wide cutaway — blue sky with two soft clouds, a grass strip with little tufts, layered soil underneath (light brown then darker brown, a few smooth pebbles); on the LEFT a white wind-turbine tower base on a round concrete pad with bolts, with a small steel grounding lug (a square plate with a hole) on the tower's side. NO rod, NO hammer, NO cable, NO bubbles, NO text. Opaque, landscape 1536x640.`],
  ["g-rod", "mock-grounding", `${SPRITE}: a long copper EARTH ROD standing vertically, with a rounded copper cap/clamp head at the top (a little bolt on it) and a slight point at the bottom; ${STYLE}. Tall portrait 1024x1536.`],
  ["g-hammer", "mock-grounding", `${SPRITE}: a big friendly cartoon HAMMER (grey steel head, rounded wooden handle), tilted ready to strike, head at the upper left, handle toward the lower right; ${STYLE}. Square 1024x1024.`],
  ["g-clip", "mock-grounding", `${SPRITE}: the END of a green-and-yellow striped earth cable finishing in a chunky metal crocodile CLIP pointing to the right (only a short piece of cable on the left); ${STYLE}. Landscape 1536x1024.`],
  ["gen-coil", "mock-generator", `${SPRITE}: the generator's COPPER COIL RING seen from the front — a thick ring of glossy copper windings held by cream clips, mounted on a mint-green stand at the bottom — with an EMPTY centre (no magnet inside); ${STYLE}. Square 1024x1024.`],
  ["gen-magnet", "mock-generator", `${SPRITE}: a chunky horizontal BAR MAGNET, left half red with a white 'N', right half blue with a white 'S', a small cream round pivot in the middle; no motion blur; ${STYLE}. Landscape 1536x1024.`],
  ["gen-meter", "mock-generator", `${SPRITE}: an analog AMMETER DIAL in a mint rounded case — a cream half-round face with tick marks and a '0' at the left end, NO needle; ${STYLE}. Landscape 1536x1024.`],
  ["gen-bulb-off", "mock-generator", `${SPRITE}: a light BULB, OFF — clear glass with a dark filament, cream screw base; ${STYLE}. Portrait 1024x1536.`],
  ["gen-bulb-on", "mock-generator", `${SPRITE}: the same light BULB, ON — warm glowing yellow filament and a soft golden glow inside the glass; ${STYLE}. Portrait 1024x1536.`],
  ["w-scene", "mock-wiring", `The STAGE BACKGROUND of the wiring mini-game ${STYLE}: a soft lavender backdrop; on the LEFT the cutaway generator (copper coil, red/blue magnet inside, little terminal box) with a cream connector block on its right side holding THREE empty round cable sockets stacked vertically; on the RIGHT a navy electrical cabinet with its door open, its inside holding THREE EMPTY round mounting plates stacked vertically (no screws, no symbols). NO cables, NO plugs, NO text, NO hand. Opaque, landscape 1536x768.`],
  ["w-term-plus", "mock-wiring", `${SPRITE}: a round screw TERMINAL seen from the front — a silver cross-head screw in a thick glossy RED ring, with a small cream tag above it showing a '+' sign; ${STYLE}. Square 1024x1024.`],
  ["w-term-minus", "mock-wiring", `${SPRITE}: a round screw TERMINAL seen from the front — a silver cross-head screw in a thick glossy DARK CHARCOAL ring, with a small cream tag above it showing a '−' sign; ${STYLE}. Square 1024x1024.`],
  ["w-term-ground", "mock-wiring", `${SPRITE}: a round screw TERMINAL seen from the front — a silver cross-head screw in a thick glossy GREEN ring, with a small cream tag above it showing the electrical earth/ground symbol (⏚); ${STYLE}. Square 1024x1024.`],
  ["w-plug-red", "mock-wiring", `${SPRITE}: a chunky RED cable PLUG head pointing to the right (cream collar, silver pin), only a very short stub of red cable on the left; ${STYLE}. Landscape 1536x1024.`],
  ["w-plug-black", "mock-wiring", `${SPRITE}: a chunky DARK CHARCOAL cable PLUG head pointing to the right (cream collar, silver pin), only a very short stub of charcoal cable on the left; ${STYLE}. Landscape 1536x1024.`],
  ["w-plug-earth", "mock-wiring", `${SPRITE}: a chunky GREEN cable PLUG head pointing to the right (cream collar, silver pin), only a very short stub of green-and-yellow striped cable on the left; ${STYLE}. Landscape 1536x1024.`],
  ["ui-icon-ground", "mock-grounding", `${SPRITE}: an app-style rounded square ICON TILE, mint green, with a white electrical earth/ground symbol (⏚); ${STYLE}. Square 1024x1024.`],
  ["ui-icon-magnet", "mock-generator", `${SPRITE}: an app-style rounded square ICON TILE, soft mint, with a red-and-blue horseshoe magnet; ${STYLE}. Square 1024x1024.`],
  ["ui-icon-plug", "mock-wiring", `${SPRITE}: an app-style rounded square ICON TILE, soft green, with a navy-and-white electric plug; ${STYLE}. Square 1024x1024.`],
];
const queue = [...JOBS];
const run = ([name, mock, prompt]) => new Promise((res) => {
  const c = spawn(process.execPath, [CODEX_JS, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, "-i", join(HERE, "raw", `${mock}.png`)], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as sprites/${name}.png in the current directory. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, "sprites", `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log("done");
