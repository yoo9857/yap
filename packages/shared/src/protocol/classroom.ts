import { MAX_BLOCK_SHAPE } from "../blockShapes.js";
import { z } from "zod";
import { playerNameSchema } from "./messages.js";
import { characterIdSchema, emoteIdSchema, characterActionSchema, heldItemSchema, toolOptionSchema } from "../character.js";

/**
 * Classroom protocol — the education field's live multiplayer. A teacher
 * opens a class under a CLASS NAME (and their own name); students type that
 * class name plus their own, see whose class it is (`k-peek`), and join.
 * Everyone shares one field: block edits are relayed in
 * ABSOLUTE field coordinates (the field scrolls its voxel window per client,
 * so grid coordinates would differ between machines).
 *
 * Kept apart from the tower protocol (own message prefix `k-`/`s-k-`, own
 * version) so neither can break the other. Rides the same `/ws` endpoint,
 * selected with `?mode=class`.
 */

/** 3: named classrooms. 4: water. 5: paced live-world streaming + reliable replay. 6: character emotes and low postures. 7: construction shapes through code 50. 8: light player taps. 9: half blocks and stairs. 10: water inside shaped blocks (s-k-wet). 11: plot nudges. 12: lesson tools (freeze, timer, announcements). 14: teacher water cleanup (k-drain-water / s-k-water-drained). */
export const CLASS_PROTOCOL_VERSION = 14;
/** Highest block layer of the field grid (WORLD_Y - 1). */
export const CLASS_MAX_Y = 55;
/** Field coordinates are bounded so a hostile client can't grow the store
 *  with absurd keys; ±1 000 km of walking is plenty. */
export const CLASS_MAX_COORD = 1_000_000;
const COORD = CLASS_MAX_COORD;
export const CLASS_MAX_STUDENTS = 40;
export const CLASS_CHAT_MAX = 120;
/** A big on-screen announcement (F2 → 공지), shorter than a chat line: it is read from across the room. */
export const CLASS_ANNOUNCE_MAX = 60;
/** The lesson timer's longest run (s): one class period and then some. */
export const CLASS_TIMER_MAX_S = 60 * 60;
export const CLASS_PASSWORD_MIN = 4;
export const CLASS_PASSWORD_MAX = 32;

const coordSchema = z.number().int().min(-COORD).max(COORD);

/** A class (room) name, e.g. "햇살반" or "3학년 2반". */
export const CLASS_ROOM_MAX = 20;
export const classRoomNameSchema = z.string().trim().min(1).max(CLASS_ROOM_MAX);
const vec3Schema = z.tuple([
  z.number().finite().min(-COORD).max(COORD),
  z.number().finite().min(-64).max(256),
  z.number().finite().min(-COORD).max(COORD),
]);

export const classRoleSchema = z.enum(["teacher", "student"]);
export type ClassRole = z.infer<typeof classRoleSchema>;
export const classAnimSchema = z.enum(["idle", "run", "jump", "fall", "sit", "lie", "crawl"]);
export type ClassAnim = z.infer<typeof classAnimSchema>;
const presentationShape = { heldItem:heldItemSchema.nullable().optional(), toolOption:toolOptionSchema.optional(), toolPhase:z.number().finite().min(0).max(1).optional(), action:characterActionSchema.optional(), actionSeq:z.number().int().min(0).max(1_000_000_000).optional(), actionLoop:z.boolean().optional(), swimming:z.boolean().optional(), character: characterIdSchema.optional(), emote: emoteIdSchema.optional(), emoteSeq: z.number().int().min(0).max(1_000_000_000).optional() };

/** One block write: absolute x/z, y, block id (0 = air), brick shape. */
export const classEditSchema = z.tuple([
  coordSchema,
  z.number().int().min(0).max(CLASS_MAX_Y),
  coordSchema,
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(MAX_BLOCK_SHAPE),
]);
export type ClassEdit = z.infer<typeof classEditSchema>;

/** The water a shaped block holds (waterlog.ts): absolute x/z, y, water id or 0 (dry). */
export const classWetSchema = z.tuple([
  coordSchema,
  z.number().int().min(0).max(CLASS_MAX_Y),
  coordSchema,
  z.number().int().min(0).max(255),
]);
export type ClassWet = z.infer<typeof classWetSchema>;

/** Exact furniture value, including colour and open/closed state. */
const furnitureBase = z.tuple([
  z.string().min(1).max(48), coordSchema,
  z.number().int().min(0).max(CLASS_MAX_Y), coordSchema,
  z.number().int().min(0).max(3), z.number().int().min(0).max(32),
]);
export const classFurnitureSchema = z.union([
  furnitureBase,
  z.tuple([...furnitureBase.items, z.number().int().min(0).max(1)]),
]);
export type ClassFurniture = z.infer<typeof classFurnitureSchema>;

// ---------------------------------------------------------------- client → server

export const classClientSchema = z.discriminatedUnion("t", [
  /** Open (or, with the key from a previous welcome, re-take) a class. */
  z.object({
    t: z.literal("k-host"),
    v: z.number().int(),
    room: classRoomNameSchema,
    teacher: playerNameSchema,
    /** Required to open a NEW class, or to re-open a saved one from a
     *  browser that doesn't hold the host key (another school PC). */
    password: z.string().max(CLASS_PASSWORD_MAX).optional(),
    hostKey: z.string().max(64).optional(),
  }),
  z.object({
    t: z.literal("k-join"),
    v: z.number().int(),
    room: classRoomNameSchema,
    student: playerNameSchema,
    /** Re-claims the same seat after a dropped connection. */
    seatKey: z.string().max(64).optional(),
  }),
  /** "Whose class is this?" — answered with s-k-room, then the socket closes.
   *  Lets a student confirm the teacher's name before joining. */
  z.object({ t: z.literal("k-peek"), v: z.number().int(), room: classRoomNameSchema }),
  z.object({
    t: z.literal("k-move"), pos: vec3Schema, yaw: z.number().finite(), anim: classAnimSchema,
    /** The sender's clock (ms) when it measured `pos`. The server maps it onto its own clock,
     *  so the timeline everyone draws on carries no network jitter. Optional (older clients). */
    ct: z.number().finite().nonnegative().optional(),
    ...presentationShape,
  }),
  /** Up to one placed piece (4 cells) per message. */
  z.object({ t: z.literal("k-edit"), edits: z.array(classEditSchema).min(1).max(8) }),
  z.object({
    t: z.literal("k-furniture"),
    placed: z.array(classFurnitureSchema).max(32),
    removed: z.array(classFurnitureSchema).max(32),
  }),
  z.object({ t: z.literal("k-chat"), text: z.string().trim().min(1).max(CLASS_CHAT_MAX) }),
  /** A light tap. The server resolves who it hits from the last positions. */
  z.object({
    t: z.literal("k-bonk"),
    /** Who the crosshair was on. The server only checks that one (optional: older builds). */
    target: z.string().max(64).optional(),
    yaw: z.number().finite(),
    pitch: z.number().finite().min(-1.6).max(1.6),
    seq: z.number().int().min(0).max(1_000_000_000),
  }),
  // teacher only — the server checks the role
  z.object({ t: z.literal("k-kick"), playerId: z.string().max(32) }),
  z.object({ t: z.literal("k-gather") }),
  /** Seat the online students in rows in front of the teacher (a 15 × 20 cell area, F2 → 자리 배치);
   *  `clear` takes the seating (fences and name signs) away again; `yaw` is the way the teacher looks
   *  (the plots go in front of the view; without it, the body's heading). `roam` alone lets the
   *  students walk off their plots (true) or sends them back and keeps them in (false). */
  z.object({ t: z.literal("k-arrange"), clear: z.boolean().optional(), yaw: z.number().finite().optional(), roam: z.boolean().optional() }),
  /** Lesson-wide state (F2): `freeze` stops every student (no moving, building, chatting or taps —
   *  "eyes on me"); `timer` starts a countdown everyone sees (seconds; 0 stops it). */
  z.object({
    t: z.literal("k-lesson"),
    freeze: z.boolean().optional(),
    timer: z.number().int().min(0).max(CLASS_TIMER_MAX_S).optional(),
  }),
  /** A big message in the middle of every screen for a few seconds (F2 → 공지). */
  z.object({ t: z.literal("k-announce"), text: z.string().trim().min(1).max(CLASS_ANNOUNCE_MAX) }),
  z.object({ t: z.literal("k-settings"), chatLocked: z.boolean(), buildLocked: z.boolean(), tapsLocked: z.boolean().optional() }),
  z.object({ t: z.literal("k-end") }),
  /** Teacher wipes the saved field back to empty grass. */
  z.object({ t: z.literal("k-reset-world") }),
  /** Teacher removes all water while keeping buildings and furniture. */
  z.object({ t: z.literal("k-drain-water") }),
]);
export type ClassClientMessage = z.infer<typeof classClientSchema>;

// ---------------------------------------------------------------- server → client

export const classMemberSchema = z.object({
  id: z.string(),
  name: playerNameSchema,
  role: classRoleSchema,
  online: z.boolean(),
});
export type ClassMember = z.infer<typeof classMemberSchema>;

/** `tapsLocked` (teacher turns friend taps off) is optional: classes saved before it read as unlocked. */
export const classSettingsSchema = z.object({ chatLocked: z.boolean(), buildLocked: z.boolean(), tapsLocked: z.boolean().optional() });
export type ClassSettings = z.infer<typeof classSettingsSchema>;

export const classErrorCodeSchema = z.enum([
  "bad-version",
  "no-class", // no class is open under that class name
  "teacher-taken", // the class's teacher is already online in it
  "room-taken", // that class name belongs to another teacher
  "name-taken", // a student with that name is online in the class
  "class-full",
  "banned", // removed by the teacher a moment ago
  "bad-password", // wrong / too-short class password
  "bad-name",
  "internal",
]);
export type ClassErrorCode = z.infer<typeof classErrorCodeSchema>;

export const classServerSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("s-k-welcome"),
    you: z.string(),
    role: classRoleSchema,
    room: classRoomNameSchema,
    teacher: playerNameSchema,
    /** Teacher: proves ownership on reconnect. Student: keeps their seat. */
    key: z.string(),
    members: z.array(classMemberSchema),
    settings: classSettingsSchema,
    /** Number of edits that follow in s-k-world batches. */
    editCount: z.number().int().nonnegative(),
    furniture: z.array(classFurnitureSchema).max(3000),
    /** Seconds within which this server always sends something (an empty snap at worst), so a
     *  client can tell a dead link from a quiet class. Optional: older servers make no promise. */
    keepalive: z.number().positive().max(60).optional(),
  }),
  z.object({
    t: z.literal("s-k-furniture"), furniture: z.array(classFurnitureSchema).max(3000),
    rejected: z.boolean().optional(),
  }),
  /** Answer to k-peek. `exists`: saved or live; `open`: a student may join now. */
  z.object({
    t: z.literal("s-k-room"),
    room: z.string(),
    exists: z.boolean(),
    open: z.boolean(),
    teacher: playerNameSchema.optional(),
  }),
  z.object({ t: z.literal("s-k-world"), edits: z.array(classEditSchema) }),
  /** The teacher wiped the field: drop every edit. */
  z.object({ t: z.literal("s-k-world-reset") }),
  /** Ordered cleanup barrier, including water outside each client's window. */
  z.object({ t: z.literal("s-k-water-drained") }),
  z.object({ t: z.literal("s-k-members"), members: z.array(classMemberSchema) }),
  z.object({
    t: z.literal("s-k-snap"),
    /** Server clock (ms) when this snapshot was taken: clients draw others on this timeline
     *  (craft/remoteTrack.ts). Optional: older servers send none and clients fall back. */
    ts: z.number().finite().nonnegative().optional(),
    players: z.array(z.object({
      id: z.string(), pos: vec3Schema, yaw: z.number(), anim: classAnimSchema,
      /** Server clock (ms) when this position ARRIVED. Interpolating on the snapshot's time
       *  instead stalls then leaps, because moves and snapshots tick out of phase. */
      at: z.number().finite().nonnegative().optional(),
      ...presentationShape,
    })),
  }),
  z.object({ t: z.literal("s-k-edit"), by: z.string(), edits: z.array(classEditSchema) }),
  /** Water moved inside shaped blocks (the server's flow; also the whole layer after a join, and the
   *  cells of a refused edit). A written block clears its cell's water on both sides by itself. */
  z.object({ t: z.literal("s-k-wet"), cells: z.array(classWetSchema) }),
  z.object({
    t: z.literal("s-k-chat"),
    from: z.string(),
    name: playerNameSchema,
    role: classRoleSchema,
    text: z.string(),
    system: z.boolean().optional(),
  }),
  /** Come to `pos` (absolute). With `yaw` it is an exact spot (a seat) facing that way; without, the
   *  student fans out around it (gather). `nudge`: a student kept on their plot strayed out —
   *  stand exactly at `pos` (just inside the fence), keep facing and say nothing (a seat's teleport
   *  and toast every 2 s read as the child blinking). */
  z.object({ t: z.literal("s-k-gather"), pos: vec3Schema, yaw: z.number().finite().optional(), nudge: z.boolean().optional() }),
  /** The class's seating, for everyone (on change and on join): each seat's student, spot (absolute)
   *  and heading. Drawn as booths with dividers and a name sign; an empty list clears it. */
  z.object({
    t: z.literal("s-k-seats"),
    seats: z.array(z.object({ name: z.string().max(64), pos: vec3Schema, yaw: z.number().finite() })).max(400),
    /** Students may walk off their plots (the teacher's 자유롭게 돌아다니기); absent = kept in. */
    roam: z.boolean().optional(),
  }),
  /** The lesson's state (on change and on EVERY join): students frozen, and the timer — `timerLeft`
   *  ms of `timerTotal` (absent: no timer). Clients count down on their own clock from arrival. */
  z.object({
    t: z.literal("s-k-lesson"),
    frozen: z.boolean().optional(),
    timerLeft: z.number().int().min(0).max(CLASS_TIMER_MAX_S * 1000).optional(),
    timerTotal: z.number().int().min(1).max(CLASS_TIMER_MAX_S * 1000).optional(),
  }),
  /** The teacher's announcement: shown big in the middle of the screen for a few seconds. */
  z.object({ t: z.literal("s-k-announce"), text: z.string().max(CLASS_ANNOUNCE_MAX) }),
  /** A tap connected. `at` is the chest in absolute field coordinates. */
  z.object({
    t: z.literal("s-k-bonk"),
    by: z.string(),
    target: z.string(),
    seq: z.number().int().min(0).max(1_000_000_000),
    vx: z.number().finite(),
    vz: z.number().finite(),
    vy: z.number().finite(),
    at: z.tuple([
      z.number().finite().min(-COORD).max(COORD),
      z.number().finite().min(-64).max(260),
      z.number().finite().min(-COORD).max(COORD),
    ]),
  }),
  z.object({ t: z.literal("s-k-settings"), settings: classSettingsSchema }),
  /** Your edit was refused (build lock) — undo it locally. */
  z.object({ t: z.literal("s-k-reject"), edits: z.array(classEditSchema), authoritative: z.boolean().optional() }),
  z.object({ t: z.literal("s-k-kicked") }),
  z.object({ t: z.literal("s-k-closed") }),
  z.object({ t: z.literal("s-k-error"), code: classErrorCodeSchema }),
]);
export type ClassServerMessage = z.infer<typeof classServerSchema>;

function decodeWith<T>(raw: unknown, schema: z.ZodType<T>, maxLen: number): T | null {
  if (typeof raw !== "string" || raw.length > maxLen) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function decodeClassClient(raw: unknown): ClassClientMessage | null {
  return decodeWith(raw, classClientSchema, 16384);
}

/**
 * The protocol version an entry message claims, even when the rest of it no
 * longer parses: a page that was not refreshed across a protocol change sends
 * last version's k-host/k-join, which fails the schema — and must be told to
 * refresh, not left on "connecting…" until it times out. Null when there is no
 * such claim.
 */
export function claimedClassVersion(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length > 16384) return null;
  try {
    const msg = JSON.parse(raw) as { t?: unknown; v?: unknown };
    const entry = msg.t === "k-host" || msg.t === "k-join" || msg.t === "k-peek";
    return entry && typeof msg.v === "number" ? msg.v : null;
  } catch {
    return null;
  }
}

/** World batches are large; the server is trusted for size, not shape. */
export function decodeClassServer(raw: unknown): ClassServerMessage | null {
  return decodeWith(raw, classServerSchema, 4 * 1024 * 1024);
}

/** Class names (and people's names, for clashes) are matched case- and
 *  space-insensitively ("햇살  반" = "햇살 반", "Kim" = "kim"). */
export function classKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
