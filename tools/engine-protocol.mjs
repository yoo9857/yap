// pnpm engine:protocol [--check] (tsx: imports the TypeScript sources) — wire-protocol fixtures for the
// Rust client (engine/crates/net). Every variant of the party and classroom schemas, once with every
// optional field and once with none, each validated by zod here. engine/crates/net/tests/protocol.rs
// then requires the Rust types to read each one and write it back unchanged, so a field added to a
// zod schema and not to protocol.rs fails CI instead of being silently dropped by the app.
// --check (CI) fails when the written file is stale or a variant has no fixture.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLASS_PROTOCOL_VERSION,
  PARTY_PROTOCOL_VERSION,
  classClientSchema,
  classServerSchema,
  partyClientSchema,
  partyServerSchema,
} from "../packages/shared/src/index.ts";

const out = fileURLToPath(new URL("../engine/crates/net/tests/fixtures.json", import.meta.url));

const look = {
  heldItem: "pickaxe-basic", toolOption: "light-grip", toolPhase: 0.25, action: "hit", actionSeq: 7,
  actionLoop: true, swimming: false, character: "tt", emote: "wave", emoteSeq: 3,
};
const furniture = [["chair", -12, 3, 40, 1, 2], ["door", 5, 2, -7, 3, 0, 1]];
const members = [{ id: "p1", name: "김선생", role: "teacher", online: true }, { id: "p2", name: "Mina", role: "student", online: false }];
const edits = [[-120, 4, 33, 7, 0], [5, 55, -1_000_000, 0, 82]];

/** Per `t`: [with every optional field, with none] (one entry when there is nothing optional). */
const samples = {
  partyClient: {
    "p-hello": [{ t: "p-hello", v: PARTY_PROTOCOL_VERSION, name: "민수", seat: { code: "ABCDEF", key: "k".repeat(16) } }, { t: "p-hello", v: PARTY_PROTOCOL_VERSION, name: "민수" }],
    "p-list": [{ t: "p-list" }],
    "p-create": [{ t: "p-create", title: "같이 짓자", game: "build", max: 12, public: true }],
    "p-join": [{ t: "p-join", code: "QWERTY" }],
    "p-quick": [{ t: "p-quick", game: "tower" }, { t: "p-quick" }],
    "p-leave": [{ t: "p-leave" }],
    "p-ready": [{ t: "p-ready", ready: true }],
    "p-chat": [{ t: "p-chat", text: "안녕!" }],
    "p-set": [{ t: "p-set", game: "build", title: "새 방", max: 8, public: false }, { t: "p-set" }],
    "p-start": [{ t: "p-start" }],
    "p-stop": [{ t: "p-stop" }],
    "p-kick": [{ t: "p-kick", id: "p3" }],
  },
  partyServer: {
    "s-p-welcome": [{ t: "s-p-welcome", you: "p1" }],
    "s-p-rooms": [{ t: "s-p-rooms", rooms: [{ code: "ABCDEF", title: "방", game: "build", host: "민수", players: 3, max: 8, state: "playing" }] }, { t: "s-p-rooms", rooms: [] }],
    "s-p-room": [{ t: "s-p-room", room: { code: "ABCDEF", title: "방", game: "tower", max: 8, public: true, state: "waiting", host: "p1", members: [{ id: "p1", name: "민수", ready: true, online: true }] }, key: "seatkey-123", you: "p2" }],
    "s-p-left": [{ t: "s-p-left", reason: "kicked" }],
    "s-p-start": [{ t: "s-p-start", game: "build", code: "ABCDEF" }],
    "s-p-chat": [{ t: "s-p-chat", from: "p1", name: "민수", text: "가자", system: true }, { t: "s-p-chat", from: "p1", name: "민수", text: "가자" }],
    "s-p-error": [{ t: "s-p-error", code: "game-limit" }],
  },
  classClient: {
    "k-host": [{ t: "k-host", v: CLASS_PROTOCOL_VERSION, room: "햇살반", teacher: "김선생", password: "1234", hostKey: "hk" }, { t: "k-host", v: CLASS_PROTOCOL_VERSION, room: "햇살반", teacher: "김선생" }],
    "k-join": [{ t: "k-join", v: CLASS_PROTOCOL_VERSION, room: "햇살반", student: "Mina", seatKey: "sk" }, { t: "k-join", v: CLASS_PROTOCOL_VERSION, room: "햇살반", student: "Mina" }],
    "k-peek": [{ t: "k-peek", v: CLASS_PROTOCOL_VERSION, room: "햇살반" }],
    "k-move": [
      { t: "k-move", pos: [10.5, 4, -3.25], yaw: 1.5, anim: "run", ct: 12345.5, ...look },
      { t: "k-move", pos: [0, 0, 0], yaw: 0, anim: "idle" },
      { t: "k-move", pos: [0, 0, 0], yaw: 0, anim: "crawl", heldItem: null },
    ],
    "k-edit": [{ t: "k-edit", edits }],
    "k-furniture": [{ t: "k-furniture", placed: furniture, removed: [] }],
    "k-chat": [{ t: "k-chat", text: "선생님!" }],
    "k-bonk": [{ t: "k-bonk", target: "p2", yaw: 0.5, pitch: -0.2, seq: 9 }, { t: "k-bonk", yaw: 0.5, pitch: -0.2, seq: 9 }],
    "k-kick": [{ t: "k-kick", playerId: "p2" }],
    "k-gather": [{ t: "k-gather" }],
    "k-settings": [{ t: "k-settings", chatLocked: true, buildLocked: false, tapsLocked: true }, { t: "k-settings", chatLocked: false, buildLocked: true }],
    "k-end": [{ t: "k-end" }],
    "k-reset-world": [{ t: "k-reset-world" }],
  },
  classServer: {
    "s-k-welcome": [
      { t: "s-k-welcome", you: "p2", role: "student", room: "햇살반", teacher: "김선생", key: "sk", members, settings: { chatLocked: false, buildLocked: false, tapsLocked: true }, editCount: 1200, furniture, keepalive: 2.5 },
      { t: "s-k-welcome", you: "p1", role: "teacher", room: "햇살반", teacher: "김선생", key: "hk", members: [], settings: { chatLocked: false, buildLocked: false }, editCount: 0, furniture: [] },
    ],
    "s-k-furniture": [{ t: "s-k-furniture", furniture, rejected: true }, { t: "s-k-furniture", furniture: [] }],
    "s-k-room": [{ t: "s-k-room", room: "햇살반", exists: true, open: true, teacher: "김선생" }, { t: "s-k-room", room: "없는반", exists: false, open: false }],
    "s-k-world": [{ t: "s-k-world", edits }],
    "s-k-world-reset": [{ t: "s-k-world-reset" }],
    "s-k-members": [{ t: "s-k-members", members }],
    "s-k-snap": [
      { t: "s-k-snap", ts: 99812.25, players: [{ id: "p2", pos: [1.25, 3, -8], yaw: -2, anim: "jump", at: 99800.5, ...look }, { id: "p3", pos: [0, 0, 0], yaw: 0, anim: "idle", heldItem: null }] },
      { t: "s-k-snap", players: [] },
    ],
    "s-k-edit": [{ t: "s-k-edit", by: "p2", edits }],
    "s-k-wet": [{ t: "s-k-wet", cells: [[3, 2, -4, 19], [3, 2, -5, 0]] }],
    "s-k-chat": [{ t: "s-k-chat", from: "p1", name: "김선생", role: "teacher", text: "모여요", system: true }, { t: "s-k-chat", from: "p2", name: "Mina", role: "student", text: "네" }],
    "s-k-gather": [{ t: "s-k-gather", pos: [12, 5, -30.5] }],
    "s-k-bonk": [{ t: "s-k-bonk", by: "p2", target: "p3", seq: 4, vx: 1.5, vz: -0.5, vy: 2, at: [1, 2.2, 3] }],
    "s-k-settings": [{ t: "s-k-settings", settings: { chatLocked: true, buildLocked: true, tapsLocked: false } }],
    "s-k-reject": [{ t: "s-k-reject", edits, authoritative: true }, { t: "s-k-reject", edits: [] }],
    "s-k-kicked": [{ t: "s-k-kicked" }],
    "s-k-closed": [{ t: "s-k-closed" }],
    "s-k-error": [{ t: "s-k-error", code: "name-taken" }],
  },
};
const schemas = { partyClient: partyClientSchema, partyServer: partyServerSchema, classClient: classClientSchema, classServer: classServerSchema };

const problems = [];
const fixtures = { versions: { party: PARTY_PROTOCOL_VERSION, class: CLASS_PROTOCOL_VERSION } };
for (const [group, schema] of Object.entries(schemas)) {
  const tags = schema.options.map((option) => option.shape.t.value);
  for (const tag of tags) if (!samples[group][tag]) problems.push(`${group}: no fixture for "${tag}" (add one to tools/engine-protocol.mjs and a variant to protocol.rs)`);
  for (const tag of Object.keys(samples[group])) if (!tags.includes(tag)) problems.push(`${group}: fixture "${tag}" is not in the schema any more`);
  fixtures[group] = Object.values(samples[group]).flat();
  for (const msg of fixtures[group]) {
    const parsed = schema.safeParse(msg);
    if (!parsed.success) problems.push(`${group} ${msg.t}: ${parsed.error.message}`);
    // zod strips unknown keys: a sample key the schema does not know would test nothing
    else if (JSON.stringify(parsed.data) !== JSON.stringify(msg)) problems.push(`${group} ${msg.t}: zod changed the sample (unknown or reordered key?)`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const text = JSON.stringify(fixtures, null, 1) + "\n";
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing */ }
  if (current !== text) {
    console.error("engine/crates/net/tests/fixtures.json is stale: run pnpm engine:protocol");
    process.exit(1);
  }
  console.log("protocol fixtures up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${Object.values(fixtures).filter(Array.isArray).flat().length} fixtures`);
}
