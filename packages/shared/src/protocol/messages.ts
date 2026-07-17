import { z } from "zod";

/** Finite-only 3-vector — NaN/Infinity never crosses the wire. */
export const vec3Schema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const animStateSchema = z.enum(["idle", "run", "jump", "fall", "dead"]);
export type AnimState = z.infer<typeof animStateSchema>;

export const playerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  // printable, no control chars; anything renderable in a nametag
  .regex(/^[^\p{C}]+$/u);

export const playerInfoSchema = z.object({
  id: z.string().min(1).max(32),
  name: playerNameSchema,
  checkpoint: z.number().int().min(-1),
});
export type PlayerInfo = z.infer<typeof playerInfoSchema>;

// ---------------------------------------------------------------- client → server

export const clientHelloSchema = z.object({
  t: z.literal("c-hello"),
  v: z.number().int().positive(),
  name: playerNameSchema,
});

export const clientMoveSchema = z.object({
  t: z.literal("c-move"),
  seq: z.number().int().nonnegative(),
  pos: vec3Schema,
  vel: vec3Schema,
  yaw: z.number().finite(),
  anim: animStateSchema,
  grounded: z.boolean(),
});

export const clientCheckpointSchema = z.object({
  t: z.literal("c-checkpoint"),
  index: z.number().int().nonnegative(),
});

export const clientFinishSchema = z.object({
  t: z.literal("c-finish"),
  /** Tick-precise client-measured run time; the server cross-checks it
   *  against its own wall-clock measurement and only then adopts it. */
  timeMs: z.number().nonnegative().optional(),
});
/** death: big teleport back to checkpoint is legit; restart: full run reset. */
export const clientRespawnSchema = z.object({
  t: z.literal("c-respawn"),
  reason: z.enum(["death", "restart"]),
});
export const clientPongSchema = z.object({
  t: z.literal("c-pong"),
  nonce: z.number().int(),
});

export const clientMessageSchema = z.discriminatedUnion("t", [
  clientHelloSchema,
  clientMoveSchema,
  clientCheckpointSchema,
  clientFinishSchema,
  clientRespawnSchema,
  clientPongSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------- server → client

export const snapshotPlayerSchema = z.object({
  id: z.string(),
  pos: vec3Schema,
  yaw: z.number().finite(),
  anim: animStateSchema,
  grounded: z.boolean(),
});
export type SnapshotPlayer = z.infer<typeof snapshotPlayerSchema>;

export const dailyBoardEntrySchema = z.object({
  name: playerNameSchema,
  timeMs: z.number().nonnegative(),
  rank: z.number().int().positive(),
});
export type DailyBoardEntry = z.infer<typeof dailyBoardEntrySchema>;

export const serverWelcomeSchema = z.object({
  t: z.literal("s-welcome"),
  playerId: z.string(),
  roomId: z.string(),
  seed: z.number().int(),
  serverTimeMs: z.number(),
  snapshotHz: z.number().positive(),
  players: z.array(playerInfoSchema),
  /** Daily tower identity + today's persisted leaderboard. */
  dateStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayNumber: z.number().int(),
  dayStartMs: z.number(),
  nextDayStartMs: z.number(),
  board: z.array(dailyBoardEntrySchema),
});

export const serverPlayerJoinedSchema = z.object({
  t: z.literal("s-player-joined"),
  player: playerInfoSchema,
});

export const serverPlayerLeftSchema = z.object({
  t: z.literal("s-player-left"),
  playerId: z.string(),
});

export const serverSnapshotSchema = z.object({
  t: z.literal("s-snapshot"),
  serverTimeMs: z.number(),
  players: z.array(snapshotPlayerSchema),
});

export const serverCorrectionSchema = z.object({
  t: z.literal("s-correction"),
  pos: vec3Schema,
  reason: z.string(),
});

export const serverCheckpointOkSchema = z.object({
  t: z.literal("s-checkpoint-ok"),
  playerId: z.string(),
  index: z.number().int().nonnegative(),
});

export const serverFinishResultSchema = z.object({
  t: z.literal("s-finish-result"),
  playerId: z.string(),
  name: playerNameSchema,
  timeMs: z.number().nonnegative(),
  rank: z.number().int().positive(),
});

export const serverDailyBoardSchema = z.object({
  t: z.literal("s-daily-board"),
  dateStr: z.string(),
  entries: z.array(dailyBoardEntrySchema),
});

export const serverNoticeSchema = z.object({
  t: z.literal("s-notice"),
  kind: z.enum(["new-day"]),
  dateStr: z.string(),
});

export const serverPingSchema = z.object({
  t: z.literal("s-ping"),
  nonce: z.number().int(),
  serverTimeMs: z.number(),
});

export const serverErrorSchema = z.object({
  t: z.literal("s-error"),
  code: z.enum(["room-full", "bad-version", "kicked", "internal"]),
  msg: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion("t", [
  serverWelcomeSchema,
  serverPlayerJoinedSchema,
  serverPlayerLeftSchema,
  serverSnapshotSchema,
  serverCorrectionSchema,
  serverCheckpointOkSchema,
  serverFinishResultSchema,
  serverDailyBoardSchema,
  serverNoticeSchema,
  serverPingSchema,
  serverErrorSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ServerWelcome = z.infer<typeof serverWelcomeSchema>;
export type ServerSnapshot = z.infer<typeof serverSnapshotSchema>;
export type ClientMove = z.infer<typeof clientMoveSchema>;
export type ClientHello = z.infer<typeof clientHelloSchema>;
