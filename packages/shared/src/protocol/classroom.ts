import { z } from "zod";
import { playerNameSchema } from "./messages.js";

/**
 * Classroom protocol — the education field's live multiplayer. A teacher
 * opens a class under their own name; students join by typing that teacher's
 * name plus their own. Everyone shares one field: block edits are relayed in
 * ABSOLUTE field coordinates (the field scrolls its voxel window per client,
 * so grid coordinates would differ between machines).
 *
 * Kept apart from the tower protocol (own message prefix `k-`/`s-k-`, own
 * version) so neither can break the other. Rides the same `/ws` endpoint,
 * selected with `?mode=class`.
 */

export const CLASS_PROTOCOL_VERSION = 1;
/** Highest block layer of the field grid (WORLD_Y - 1). */
export const CLASS_MAX_Y = 55;
/** Field coordinates are bounded so a hostile client can't grow the store
 *  with absurd keys; ±1 000 km of walking is plenty. */
const COORD = 1_000_000;
export const CLASS_MAX_STUDENTS = 40;
export const CLASS_CHAT_MAX = 120;
export const CLASS_PASSWORD_MIN = 4;
export const CLASS_PASSWORD_MAX = 32;

const coordSchema = z.number().int().min(-COORD).max(COORD);
const vec3Schema = z.tuple([
  z.number().finite().min(-COORD).max(COORD),
  z.number().finite().min(-64).max(256),
  z.number().finite().min(-COORD).max(COORD),
]);

export const classRoleSchema = z.enum(["teacher", "student"]);
export type ClassRole = z.infer<typeof classRoleSchema>;
export const classAnimSchema = z.enum(["idle", "run", "jump"]);

/** One block write: absolute x/z, y, block id (0 = air), brick shape. */
export const classEditSchema = z.tuple([
  coordSchema,
  z.number().int().min(0).max(CLASS_MAX_Y),
  coordSchema,
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(17),
]);
export type ClassEdit = z.infer<typeof classEditSchema>;

// ---------------------------------------------------------------- client → server

export const classClientSchema = z.discriminatedUnion("t", [
  /** Open (or, with the key from a previous welcome, re-take) a class. */
  z.object({
    t: z.literal("k-host"),
    v: z.number().int(),
    teacher: playerNameSchema,
    /** Required to open a NEW class, or to re-open a saved one from a
     *  browser that doesn't hold the host key (another school PC). */
    password: z.string().max(CLASS_PASSWORD_MAX).optional(),
    hostKey: z.string().max(64).optional(),
  }),
  z.object({
    t: z.literal("k-join"),
    v: z.number().int(),
    teacher: playerNameSchema,
    student: playerNameSchema,
    /** Re-claims the same seat after a dropped connection. */
    seatKey: z.string().max(64).optional(),
  }),
  z.object({ t: z.literal("k-move"), pos: vec3Schema, yaw: z.number().finite(), anim: classAnimSchema }),
  /** Up to one placed piece (4 cells) per message. */
  z.object({ t: z.literal("k-edit"), edits: z.array(classEditSchema).min(1).max(8) }),
  z.object({ t: z.literal("k-chat"), text: z.string().trim().min(1).max(CLASS_CHAT_MAX) }),
  // teacher only — the server checks the role
  z.object({ t: z.literal("k-kick"), playerId: z.string().max(32) }),
  z.object({ t: z.literal("k-gather") }),
  z.object({ t: z.literal("k-settings"), chatLocked: z.boolean(), buildLocked: z.boolean() }),
  z.object({ t: z.literal("k-end") }),
  /** Teacher wipes the saved field back to empty grass. */
  z.object({ t: z.literal("k-reset-world") }),
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

export const classSettingsSchema = z.object({ chatLocked: z.boolean(), buildLocked: z.boolean() });
export type ClassSettings = z.infer<typeof classSettingsSchema>;

export const classErrorCodeSchema = z.enum([
  "bad-version",
  "no-class", // nobody is teaching under that name
  "teacher-taken", // that teacher name is already running a class
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
    teacher: playerNameSchema,
    /** Teacher: proves ownership on reconnect. Student: keeps their seat. */
    key: z.string(),
    members: z.array(classMemberSchema),
    settings: classSettingsSchema,
    /** Number of edits that follow in s-k-world batches. */
    editCount: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal("s-k-world"), edits: z.array(classEditSchema) }),
  /** The teacher wiped the field: drop every edit. */
  z.object({ t: z.literal("s-k-world-reset") }),
  z.object({ t: z.literal("s-k-members"), members: z.array(classMemberSchema) }),
  z.object({
    t: z.literal("s-k-snap"),
    players: z.array(z.object({ id: z.string(), pos: vec3Schema, yaw: z.number(), anim: classAnimSchema })),
  }),
  z.object({ t: z.literal("s-k-edit"), by: z.string(), edits: z.array(classEditSchema) }),
  z.object({
    t: z.literal("s-k-chat"),
    from: z.string(),
    name: playerNameSchema,
    role: classRoleSchema,
    text: z.string(),
    system: z.boolean().optional(),
  }),
  z.object({ t: z.literal("s-k-gather"), pos: vec3Schema }),
  z.object({ t: z.literal("s-k-settings"), settings: classSettingsSchema }),
  /** Your edit was refused (build lock) — undo it locally. */
  z.object({ t: z.literal("s-k-reject"), edits: z.array(classEditSchema) }),
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
  return decodeWith(raw, classClientSchema, 2048);
}

/** World batches are large; the server is trusted for size, not shape. */
export function decodeClassServer(raw: unknown): ClassServerMessage | null {
  return decodeWith(raw, classServerSchema, 4 * 1024 * 1024);
}

/** Teacher names are matched case- and space-insensitively ("Kim  Ji" = "kim ji"). */
export function classKey(teacher: string): string {
  return teacher.trim().replace(/\s+/g, " ").toLowerCase();
}
