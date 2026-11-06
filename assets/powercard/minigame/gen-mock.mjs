// Mini-game UI mockups (ChatGPT image generation via Codex): premium casual-game quality.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const STYLE = "A finished, TOP-TIER mobile/PC casual game UI screen — the polish of the best game UI shots on Pinterest and Dribbble (think Toca Boca, Animal Crossing, Monument Valley, Supercell-level finish): soft clay / satin 3D illustration with gentle studio lighting, rich but harmonious pastel colours, smooth rounded shapes, tactile chunky buttons with soft depth, subtle glows and soft shadows, NO black outlines anywhere, crisp readable layout with clear hierarchy, generous spacing. It is a pop-up TASK WINDOW (like Among Us tasks, but cute and premium) centred over a softly blurred voxel game world, for kids aged 8-12 learning how electricity is made. Korean UI text only, short and large (a title, one instruction line, a progress chip); no English words. Landscape 1536x1024.";
const JOBS = [
  ["mock-grounding", `${STYLE} TASK: 접지하기 (grounding). A cutaway of the ground: grass on top, layered soil below with little pebbles; on the left the base of a white wind-turbine tower on a concrete pad; on the right a copper earth rod being driven into the soil by a big friendly hammer (impact sparkle, '쾅!' bubble), a progress chip '2 / 4'; a green-and-yellow striped earth cable with a chunky clip that the player will drag from the tower to the rod's head (a dotted guide path with a glowing target ring on the rod head). A large rounded primary button '쾅! 박기' at the bottom. Title '접지하기', instruction '구리 접지봉을 땅에 박고, 접지선을 물려요'.`],
  ["mock-generator", `${STYLE} TASK: 발전기 (generator). A beautiful cutaway generator: a big ring of glossy copper coil windings seen from the front, and inside it a chunky red-and-blue bar magnet (N and S) the player spins with a drag (curved arrow hint, motion trails); on the right a premium analog ammeter dial with a needle swinging up, a glowing light bulb above it, and a fat charge bar filling with energy (sparkle at its tip) labelled '만든 전기 72%'. Title '자석과 코일', instruction '자석을 빙글빙글 돌려요 — 멈추면 바늘도 0!'.`],
  ["mock-wiring", `${STYLE} TASK: 전선 연결 (wiring). On the left three chunky cable ends with plugs coming from the generator: red, black, and green-and-yellow striped; on the right a cute navy electrical cabinet with its door open, showing three big screw terminals with coloured rings and symbols '+', '−' and the earth symbol, in shuffled order; one red cable already connected with a soft glow and a check mark, the black one being dragged as a smooth curved cable toward its terminal with a glowing snap target. A progress chip '1 / 3'. Title '전선 연결', instruction '같은 색 단자에 꽂아요 (빨강 +, 검정 −, 초록·노랑 접지)'.`],
];
const queue = [...JOBS];
const run = ([name, prompt]) => new Promise((res) => {
  const refs = ["ref-icons.png", "ref-generator-icon.webp", `ref-${name.replace("mock-", "")}-now.png`].map((f) => join(HERE, f));
  const c = spawn(process.execPath, [CODEX_JS, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, ...refs.flatMap((r) => ["-i", r])], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as raw/${name}.png in the current directory. The attached images are references: the game's item style (soft clay 3D icons, no outlines) and the CURRENT plain version of this screen, which must be redesigned to a far higher, premium standard. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, "raw", `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log("done");
