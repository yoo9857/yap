// Wiring mini-game: panel-mount JACK sockets whose mouth faces the incoming plug (left), so a plug can
// be drawn going IN — the first terminals were screw heads seen face-on and a plug could only touch
// them. ChatGPT image generation via Codex, in the approved mockup's style.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_JS = join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const STYLE = "in EXACTLY the style of the attached images (the wiring mockup and the plug sprite): premium soft clay / satin 3D game art, gentle studio light from the upper left, pastel colours, smooth rounded forms, NO outlines, no text other than the one symbol";
const SPRITE = "a single isolated game sprite on a FULLY TRANSPARENT background (PNG with alpha — use the image tool's transparent background option), nothing else in the image, no cast shadow, no frame";
// v2: a STRICT side elevation, the same view as the plug sprite. The first jacks were turned toward
// the viewer (the mouth an ellipse) while the plug is drawn exactly side-on, so an inserted plug always
// looked tucked BEHIND the socket. In one shared side view the plug's collar simply disappears into the
// barrel's open left end.
const jack = (colour, symbol) => `${SPRITE}: a chunky panel-mount electrical JACK SOCKET (the receptacle the attached plug sprite plugs into), drawn as a STRICT ORTHOGRAPHIC SIDE ELEVATION — exactly the same flat side-on view as the attached plug sprite, its axis perfectly HORIZONTAL, NOT turned toward the viewer at all, so NO opening/hole face is visible. Left to right: an open-ended round BARREL whose left end is a slightly flared ${colour} collar ring (seen edge-on: a rounded vertical band a little taller than the rest), then the ${colour} barrel body, then a cream round mounting flange (seen edge-on as a tall rounded vertical disc) on the RIGHT end that is fixed to a wall. The barrel's inside diameter must be just bigger than the attached plug's cream collar, i.e. the barrel is about 1.25× as tall as the plug's collar. A small round cream badge sits on top of the barrel showing the symbol ${symbol}. NO plug, NO cable, NO hole visible. Centred, landscape 1024x640, the socket filling about 75% of the width; ${STYLE}.`;
const JOBS = [
  ["w-jack-plus", jack("glossy RED", "'+'")],
  ["w-jack-minus", jack("glossy dark charcoal-grey", "'−' (minus)")],
  ["w-jack-ground", jack("glossy GREEN with yellow diagonal stripes", "the electrical earth/ground symbol (⏚: a vertical line over three shrinking horizontal bars)")],
];
const queue = [...JOBS];
const run = ([name, prompt]) => new Promise((res) => {
  const refs = [join(HERE, "sprites", "w-plug-red.png"), join(HERE, "raw", "mock-wiring.png")];
  const c = spawn(process.execPath, [CODEX_JS, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", HERE, ...refs.flatMap((r) => ["-i", r])], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  c.stdin.end(`Use your image generation tool to create exactly ONE image and save it as sprites/${name}.png in the current directory. ${prompt}\nDo not create or change any other file. Reply with the path only.`);
  c.on("close", () => {
    const ok = existsSync(join(HERE, "sprites", `${name}.png`));
    console.log(`${ok ? "OK  " : "MISS"} ${name}${ok ? "" : " " + err.trim().split("\n").slice(-1)}`);
    res();
  });
});
await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log("done");
