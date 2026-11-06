// Blade-assembly mini-game sprites, in the approved mockups' style (ChatGPT image generation via Codex).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const STYLE = "in EXACTLY the style of the attached mockup: premium soft clay / satin 3D game art, gentle studio light from the upper left, pastel colours, smooth rounded forms, NO outlines, no text";
const SPRITE = "a single isolated game sprite on a FULLY TRANSPARENT background (PNG with alpha — use the image tool's transparent background option), centred, nothing else in the image, no shadow on the ground, no frame";
const JOBS = [
  ["r-scene", `The STAGE BACKGROUND of a wind-turbine blade-assembly mini-game ${STYLE}: a soft sky-blue backdrop with two small fluffy clouds and a few faint curved white wind streaks, a gentle green rolling hill along the very bottom; the CENTRE is left empty (the hub will be drawn there); a cream wooden workbench tray along the LEFT edge, empty. NO hub, NO blades, NO text. Opaque, landscape 1536x640.`],
  ["r-hub", `${SPRITE}: the FRONT VIEW of a wind-turbine ROTOR HUB — a round light-grey hub disc with a blue rounded nose cone in the middle, and SIX evenly spaced round empty mounting sockets (cream rings with a dark hole) around its rim, like a clock face; ${STYLE}. Square 1024x1024.`],
  ["r-blade", `${SPRITE}: ONE long white wind-turbine BLADE lying perfectly VERTICAL — the wide rounded ROOT with a small grey round mounting flange at the BOTTOM, tapering smoothly to a narrow rounded TIP at the TOP, a slight airfoil twist shown by soft shading; ${STYLE}. Tall portrait 1024x1536.`],
  ["r-bolt", `${SPRITE}: a chunky shiny steel HEX BOLT head seen from the front (a hexagon with a round washer under it); ${STYLE}. Square 1024x1024.`],
  ["ui-icon-rotor", `${SPRITE}: an app-style rounded square ICON TILE, soft sky-blue, with a white three-blade wind-turbine rotor with a blue nose; ${STYLE}. Square 1024x1024.`],
];
const queue = [...JOBS];
const run = ([name, prompt]) => new Promise((res) => {
  const c = spawn(process.execPath, [CODEX_JS, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, "-i", join(HERE, "raw", "mock-generator.png")], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as sprites/${name}.png in the current directory. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, "sprites", `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log("done");
