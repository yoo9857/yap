import { z } from "zod";
import { characterIdSchema } from "../character.js";
import { playerNameSchema } from "./messages.js";

export const PLAZA_PROTOCOL_VERSION = 1;
export const PLAZA_CHANNEL_SIZE = 32;
export const PLAZA_SPAWN = [0, 0.16, 10] as const;
export const plazaPositionSchema = z.tuple([z.number().finite().min(-225).max(225), z.number().finite().min(-12).max(90), z.number().finite().min(-225).max(225)]);
const pose = {
  pos: plazaPositionSchema,
  yaw: z.number().finite().min(-Math.PI).max(Math.PI),
  anim: z.enum(["idle", "run", "jump", "fall"]),
};
export const plazaPlayerSchema = z.object({ id: z.string().max(32), name: playerNameSchema, character: characterIdSchema, ...pose });
export type PlazaPlayer = z.infer<typeof plazaPlayerSchema>;
export const plazaClientSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("z-hello"), v: z.number().int(), name: playerNameSchema, character: characterIdSchema, channel: z.number().int().min(1).max(999).optional() }),
  z.object({ t: z.literal("z-move"), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), ...pose }),
  z.object({ t: z.literal("z-chat"), text: z.string().trim().min(1).max(120).regex(/^[^\p{C}]+$/u) }),
  z.object({ t: z.literal("z-profile"), name: playerNameSchema, character: characterIdSchema }),
  z.object({ t: z.literal("z-reset") }),
]);
export type PlazaClientMessage = z.infer<typeof plazaClientSchema>;
export const plazaServerSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("s-z-welcome"), you: z.string(), channel: z.number().int(), players: z.array(plazaPlayerSchema).max(PLAZA_CHANNEL_SIZE) }),
  z.object({ t: z.literal("s-z-snapshot"), players: z.array(plazaPlayerSchema).max(PLAZA_CHANNEL_SIZE) }),
  z.object({ t: z.literal("s-z-chat"), id: z.string(), name: playerNameSchema, text: z.string().max(120) }),
  z.object({ t: z.literal("s-z-correct"), pos: plazaPositionSchema }),
  z.object({ t: z.literal("s-z-error"), code: z.enum(["version", "full", "capacity"]) }),
]);
export type PlazaServerMessage = z.infer<typeof plazaServerSchema>;
function decode<T>(raw: unknown, schema: z.ZodType<T>, limit: number): T | null {
  if (typeof raw !== "string" || raw.length > limit) return null;
  try { const result = schema.safeParse(JSON.parse(raw)); return result.success ? result.data : null; } catch { return null; }
}
export const decodePlazaClient = (raw: unknown): PlazaClientMessage | null => decode(raw, plazaClientSchema, 2048);
export const decodePlazaServer = (raw: unknown): PlazaServerMessage | null => decode(raw, plazaServerSchema, 64 * 1024);
