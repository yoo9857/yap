// Two concept directions for the power-plant card game (Codex image generation).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const REFS = ["../ui-game/raw/btn-round.png", "../ui-game/raw/pet-dog.png"].map((p) => join(HERE, p)).filter(existsSync);
const COMMON = "Concept art for a cute kids' educational card game about electricity inside the voxel building game CraftYap. Six power plants, one per card, laid out as a neat row of six portrait game cards on a soft plain background: coal/thermal plant (chimney with soft grey smoke), hydro dam with water, wind turbines, solar panels, nuclear plant (cooling tower), geothermal plant (steam from the ground). Each card has a small coloured top band for its type and an empty area at the bottom for numbers (no text, no letters, no numbers anywhere). Landscape 1536x1024.";
const JOBS = [
  ["concept-a-soft3d", `${COMMON} STYLE A: modern LINELESS soft-3D clay / satin-plastic look of current casual mobile games — no outlines at all, shapes separated by colour and value, rounded squishy forms, soft studio light, gentle gradients, pastel-but-saturated palette (sunny yellow, sky blue, grass green, cream, coral). Each plant is a cute rounded toy model on a little round base.`],
  ["concept-b-voxel", `${COMMON} STYLE B: the plants are built from chunky toy building bricks and voxel blocks (round studs on top, brick proportions) like dioramas in a LEGO-like block world, isometric three-quarter view, bright clean colours, soft daylight, small blocky characters or a little shiba dog near one plant; still no black outlines.`],
];
const run = ([name, prompt]) => new Promise((res) => {
  const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE];
  if (REFS.length) args.push("-i", ...REFS);
  const c = spawn(process.execPath, [CODEX_JS, ...args], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. The attached images are only style hints for the game's look. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, "raw", `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(JOBS.map(run));
console.log("done");
