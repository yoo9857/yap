// Part item icons (science mode): one object each, in the pickaxe icon's style.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = join(dirname(fileURLToPath(import.meta.url)), "parts");
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const REFS = [join(HERE, "ref-pickaxe-icon.png")];
const BASE = "A GAME INVENTORY ICON in exactly the style of the attached pickaxe icon: one chunky toy-like object, soft-3D clay/satin render, smooth rounded bevels, gentle studio light from the upper left, soft colours, NO black outlines, NO text, NO shadow on the ground, centred with generous margin, on a PLAIN PURE WHITE (#ffffff) background. Square 1024x1024. Slight three-quarter view from above.";
const JOBS = [
  ["part-blades", `${BASE} Object: a WIND TURBINE ROTOR — three long white tapered blades joined at a round light-grey hub with a small blue nose cap, like a toy windmill rotor.`],
  ["part-generator", `${BASE} Object: an ELECTRIC GENERATOR — a short horizontal steel-grey cylinder lying on a small base, with bright copper coil bands wrapped around its middle, a shaft sticking out of one end, and a small yellow lightning-bolt plate on its side.`],
  ["part-wire-terminal", `${BASE} Object: a WIRE TERMINAL BOX — a small rounded dark-blue box with two shiny copper screw posts on top, one with a red cap and one with a black cap, and a short coiled copper cable coming out of its side.`],
];
const queue = [...JOBS];
const run = ([name, prompt]) => new Promise((res) => {
  const c = spawn(process.execPath, [CODEX_JS, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, "-i", ...REFS], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as ${name}.png in the current directory. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => { const ok = existsSync(join(HERE, `${name}.png`)); console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`); res(); });
});
await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log("done");
