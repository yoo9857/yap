// In-game style concepts for modeling: references are real CraftYap screenshots.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const REFS = ["ref-world.png", "ref-island.png", "ref-character.png"].map((p) => join(HERE, p));
const LOOK = "Match the attached CraftYap game screenshots EXACTLY in look: everything built from 1-metre voxel blocks with soft rounded toy-brick edges and small round studs on top faces, the game's own block textures (stone bricks, oak planks, sand, grass with studs, glass, glowstone, iron/gold blocks), bright soft daylight, gentle shadows, no black outlines. The blocky yellow HOME robot or purple TT bunny character from the screenshots stands nearby for scale (about 2 blocks tall). No text, no letters, no numbers.";
const JOBS = [
  ["ingame-scene", `${LOOK} Subject: a three-quarter aerial view of a small island in that game where six power plants stand side by side on grass and sand, each built from the game's blocks at believable game scale (each roughly 6-10 blocks wide): a thermal plant (stone-brick building, red-and-white brick chimney with soft smoke, coal blocks), a hydro dam across a stream of the game's water, two wind turbines (white blocks, slowly turning blades), a solar farm (rows of tilted blue glass panels on posts), a nuclear plant (a cooling tower of light stone blocks with soft steam, a small domed building), a geothermal plant (orange pipes from steaming red ground). Thin power lines on wooden posts connect them to a few small block houses with glowing windows. Landscape 1536x1024.`],
  ["model-sheet", `${LOOK} Subject: a clean MODEL REFERENCE SHEET for 3D modelers on a plain light-grey background: the same six power plants (thermal, hydro dam, wind turbine, solar farm, nuclear cooling tower, geothermal) in a 3 x 2 grid, every one shown from the SAME three-quarter angle at the SAME scale, each standing on its own square plinth of grass blocks (a 6 x 6 block footprint), built only from 1-metre voxel blocks and simple block shapes (cubes, half blocks, ramps, stairs, cylinders) so each can be modeled block by block; a tiny blocky character beside the first plant for scale. Even soft studio lighting, no background scenery. Landscape 1536x1024.`],
];
const run = ([name, prompt]) => new Promise((res) => {
  const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, "-i", ...REFS];
  const c = spawn(process.execPath, [CODEX_JS, ...args], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, "raw", `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(JOBS.map(run));
console.log("done");
