// Gameplay mock screenshots on the real CraftYap phone screen (HUD references are real captures).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const REFS = ["ref-hud.png", "ref-hud-panel.png", "ref-world.png", "raw/model-sheet.png", "raw/hologram.png"].map((p) => join(HERE, p));
const BASE = "A GAMEPLAY SCREENSHOT of the CraftYap mobile game in landscape, matching the attached real screenshots EXACTLY: the same voxel world (1-metre blocks with rounded toy-brick edges and round studs, game textures, soft daylight, no black outlines), the same third-person camera behind the character, and the SAME HUD in the same places — a dark-navy rounded name plate top-left with a house icon, a row of round cream bubble buttons top-right (pet, smiley, bag, menu), a translucent joystick ring bottom-left, a hotbar of square block slots bottom-centre, round cream action buttons bottom-right around a big pickaxe button ringed in yellow. Lineless soft UI: navy glass panels, cream pills, yellow accents. Keep any on-screen text to a minimum and in Korean if any appears; no English words. Wide landscape 1536x704 (phone aspect).";
const JOBS = [
  ["play-1-choose", `${BASE} Moment: the player has long-pressed an empty grass plot next to a small stream; a navy glass panel slides up from the bottom-centre showing five power-plant cards side by side (thermal, hydro, wind, solar, geothermal) drawn as small blocky models on cream cards with a coloured top band, the hydro card lifted and highlighted with a yellow ring; a dashed glowing square outline marks the chosen plot in the world.`],
  ["play-2-hologram", `${BASE} Moment: a translucent light-blue HOLOGRAM of the hydro dam stands on the plot; the lower part is already solid stone bricks placed by the player, three glowing yellow cells inside mark the turbine, generator and wire terminal; a small progress ring floats above it about two-thirds full; the yellow HOME robot faces it holding a stone block, and the green placement ghost shows on the next hologram cell.`],
  ["play-3-task", `${BASE} Moment: an Among-Us-style TASK window is open over the dimmed world: a big rounded navy panel in the centre with a large cream valve wheel the player is turning (a curved arrow hint around it), a vertical water-level gauge beside it with a target band in green and the water level just reaching it; the dam behind the panel is dimmed. A small round close button at the panel's top-right corner.`],
  ["play-4-cards", `${BASE} Moment: a CARD COMBINATION task window is open over the dimmed world: three empty card slots in a row connected by arrows, the first two already filled with cards (a water-drop energy card, a turbine card) and the player dragging the third card (a generator card) from a hand of four cards fanned at the bottom of the panel into the last slot; the slots glow yellow when correct.`],
  ["play-5-power", `${BASE} Moment: evening golden-hour light; the finished hydro dam is running — water pours through it, a small turbine spins with motion lines, sparkles travel along power lines on wooden posts to a row of small block houses whose windows now glow warm yellow; a short horizontal power meter bar appears at the top-centre, filled green past a target tick; the HOME robot cheers with both arms up.`],
];
const queue = [...JOBS];
const run = ([name, prompt]) => new Promise((res) => {
  const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, "-i", ...REFS];
  const c = spawn(process.execPath, [CODEX_JS, ...args], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, "raw", `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log("done");
