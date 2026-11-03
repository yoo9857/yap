import { z } from "zod";
import { playerNameSchema } from "./messages.js";

/**
 * Party protocol — the online hub's rooms. Players open a room (public in the
 * list, or private behind its 6-letter code), wait in it, the host picks the
 * game and starts, and everyone moves into that game together. A room that is
 * already playing still takes new players: they go straight into the game.
 *
 * The room itself is only the meeting place; each game runs on its own
 * server (the classroom field for "build", the tower rooms for "tower"),
 * keyed by the room code. Rides `/ws?mode=party`; own `p-`/`s-p-` prefix and
 * version so it can never break the tower or classroom protocols.
 */
export const PARTY_PROTOCOL_VERSION = 1;

/** Games a room can play. Persisted nowhere, but sent over the wire: only append. */
export const PARTY_GAMES = ["build", "tower"] as const;
export const partyGameSchema = z.enum(PARTY_GAMES);
export type PartyGame = z.infer<typeof partyGameSchema>;

/** The largest room. Each game also has its own cap (PARTY_GAME_MAX). */
export const PARTY_MAX_PLAYERS = 50;
/** How many players each game can actually hold: the party field takes the whole room; a tower
 *  room is the tower server's own size (MAX_PLAYERS_PER_ROOM, 8 by default). */
export const PARTY_GAME_MAX: Record<PartyGame, number> = { build: 50, tower: 8 };
export const PARTY_TITLE_MAX = 20;
export const PARTY_CHAT_MAX = 120;
/** Room codes: no 0/O, 1/I/L — read aloud across a classroom without mistakes. */
export const PARTY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PARTY_CODE_LENGTH = 6;
export const partyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(new RegExp(`^[${PARTY_CODE_ALPHABET}]{${PARTY_CODE_LENGTH}}$`));

/** The classroom field name a "build" room's world lives under. */
export function partyFieldName(code: string): string {
  return `party:${code}`;
}

const titleSchema = z.string().trim().min(1).max(PARTY_TITLE_MAX);
const maxSchema = z.number().int().min(2).max(PARTY_MAX_PLAYERS);

// ---------------------------------------------------------------- client → server

export const partyClientSchema = z.discriminatedUnion("t", [
  /** First message. `seat` re-takes a seat held from before (back from a game, or a refresh). */
  z.object({
    t: z.literal("p-hello"),
    v: z.number().int(),
    name: playerNameSchema,
    seat: z.object({ code: partyCodeSchema, key: z.string().min(8).max(64) }).optional(),
  }),
  /** Start receiving the public room list (and its updates). */
  z.object({ t: z.literal("p-list") }),
  z.object({ t: z.literal("p-create"), title: titleSchema, game: partyGameSchema, max: maxSchema, public: z.boolean() }),
  z.object({ t: z.literal("p-join"), code: partyCodeSchema }),
  /** Into the fullest public room with space, or a new one. */
  z.object({ t: z.literal("p-quick"), game: partyGameSchema.optional() }),
  z.object({ t: z.literal("p-leave") }),
  z.object({ t: z.literal("p-ready"), ready: z.boolean() }),
  z.object({ t: z.literal("p-chat"), text: z.string().trim().min(1).max(PARTY_CHAT_MAX) }),
  // host only — the server checks
  z.object({
    t: z.literal("p-set"),
    game: partyGameSchema.optional(),
    title: titleSchema.optional(),
    max: maxSchema.optional(),
    public: z.boolean().optional(),
  }),
  z.object({ t: z.literal("p-start") }),
  /** Back to the waiting room for everyone. */
  z.object({ t: z.literal("p-stop") }),
  z.object({ t: z.literal("p-kick"), id: z.string().max(32) }),
]);
export type PartyClientMessage = z.infer<typeof partyClientSchema>;

// ---------------------------------------------------------------- server → client

export const partyStateSchema = z.enum(["waiting", "playing"]);
export type PartyState = z.infer<typeof partyStateSchema>;

export const partySummarySchema = z.object({
  code: z.string(),
  title: z.string(),
  game: partyGameSchema,
  host: z.string(),
  players: z.number().int().nonnegative(),
  max: z.number().int(),
  state: partyStateSchema,
});
export type PartySummary = z.infer<typeof partySummarySchema>;

export const partyMemberSchema = z.object({
  id: z.string(),
  name: playerNameSchema,
  ready: z.boolean(),
  /** Connected to the room right now (false: in the game, or between pages). */
  online: z.boolean(),
});
export type PartyMember = z.infer<typeof partyMemberSchema>;

export const partyRoomSchema = z.object({
  code: z.string(),
  title: z.string(),
  game: partyGameSchema,
  max: z.number().int(),
  public: z.boolean(),
  state: partyStateSchema,
  host: z.string(),
  members: z.array(partyMemberSchema),
});
export type PartyRoomInfo = z.infer<typeof partyRoomSchema>;

export const partyErrorCodeSchema = z.enum([
  "bad-version",
  "bad-name",
  "not-found",
  "full",
  "name-taken",
  "kicked",
  "not-host",
  "not-ready",
  "too-many-rooms",
  /** The picked game holds fewer players than are seated (a tower room takes 8). */
  "game-limit",
  "rate",
  "internal",
]);
export type PartyErrorCode = z.infer<typeof partyErrorCodeSchema>;

export const partyServerSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("s-p-welcome"), you: z.string() }),
  z.object({ t: z.literal("s-p-rooms"), rooms: z.array(partySummarySchema).max(200) }),
  /** The room you are in, and the key that re-takes your seat later. */
  /** `you`: which seat is yours (names can change; the seat id cannot). */
  z.object({ t: z.literal("s-p-room"), room: partyRoomSchema, key: z.string(), you: z.string() }),
  z.object({ t: z.literal("s-p-left"), reason: z.enum(["left", "kicked", "closed"]) }),
  /** The host started: go into the game. Also sent to whoever joins a room that is playing. */
  z.object({ t: z.literal("s-p-start"), game: partyGameSchema, code: z.string() }),
  z.object({ t: z.literal("s-p-chat"), from: z.string(), name: z.string(), text: z.string(), system: z.boolean().optional() }),
  z.object({ t: z.literal("s-p-error"), code: partyErrorCodeSchema }),
]);
export type PartyServerMessage = z.infer<typeof partyServerSchema>;

function decodeWith<T>(raw: unknown, schema: z.ZodType<T>, maxLen: number): T | null {
  if (typeof raw !== "string" || raw.length > maxLen) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function decodePartyClient(raw: unknown): PartyClientMessage | null {
  return decodeWith(raw, partyClientSchema, 2048);
}

export function decodePartyServer(raw: unknown): PartyServerMessage | null {
  return decodeWith(raw, partyServerSchema, 256 * 1024);
}

/** Display names, Korean first (the client wraps them in t()). */
export const PARTY_GAME_NAMES: Record<PartyGame, [ko: string, en: string]> = {
  build: ["함께 짓기", "Build together"],
  tower: ["Daily Tower", "Daily Tower"],
};
