/**
 * Live-stream integration contract — the ONE wire shape shared between the
 * Node stream bridge (`apps/stream-bridge`) and the Robo Builder client.
 *
 * The bridge listens to YouTube live chat / Super Chat and Korean donation
 * platforms (Toonation, Twip), normalizes each into a {@link StreamEvent},
 * and pushes it over a local WebSocket. The client reacts (crew boost +
 * on-screen celebration). Boost tuning lives here as a PURE function so it is
 * unit-tested and identical wherever it runs.
 */
import { z } from "zod";

export const STREAM_SOURCES = ["youtube", "toonation", "twip", "webhook", "manual"] as const;

/** A donation carries money; a chat message is free interaction. */
export const StreamEventSchema = z.object({
  /** Where the event came from (display + per-source rules). */
  source: z.enum(STREAM_SOURCES),
  kind: z.enum(["donation", "chat"]),
  /** Donor / chatter display name. */
  name: z.string().max(80).catch("").default(""),
  /** Attached message (Super Chat text, donation memo, chat body). */
  message: z.string().max(500).catch("").default(""),
  /** Amount normalized to KRW-equivalent (0 for free chat). */
  amountKrw: z.number().nonnegative().catch(0).default(0),
  /** Original amount + currency, kept for display ("US$5.00"). */
  display: z.string().max(40).catch("").default(""),
  /** Stable id for de-duplication (chat message id / donation id). */
  id: z.string().max(200).optional(),
});

export type StreamEvent = z.infer<typeof StreamEventSchema>;

/** WebSocket envelope the bridge sends and the client parses. */
export const StreamWireSchema = z.object({
  t: z.literal("stream-event"),
  event: StreamEventSchema,
});
export type StreamWire = z.infer<typeof StreamWireSchema>;

export interface StreamBoost {
  /** Extra build-speed multiplier this event adds (0 = none). */
  extraMult: number;
  /** How long the boost lasts, in milliseconds. */
  durationMs: number;
  /** Tier label for on-screen copy ("MEGA BOOST"). */
  tier: string;
}

/** Hard cap on the combined crew multiplier so a raid can't break pacing. */
export const MAX_STREAM_MULT = 6;

/**
 * Map a normalized KRW amount to a crew build-speed boost. Pure and
 * monotonic; chat (amount 0) gives a small courtesy nudge so interaction is
 * always felt. Tuned so a typical ₩1,000 tip doubles the crew for ~30 s.
 */
export function streamBoost(amountKrw: number, kind: "donation" | "chat"): StreamBoost {
  // Free chat is deliberately a small, short nudge so viewer spam can never
  // rival a paid donation (which should always feel bigger and last longer).
  if (kind === "chat" || amountKrw <= 0) {
    return { extraMult: 0.3, durationMs: 12_000, tier: "Cheer" };
  }
  if (amountKrw < 1_000) return { extraMult: 0.75, durationMs: 25_000, tier: "Thanks" };
  if (amountKrw < 5_000) return { extraMult: 1.25, durationMs: 35_000, tier: "Boost" };
  if (amountKrw < 10_000) return { extraMult: 2, durationMs: 50_000, tier: "Super Boost" };
  if (amountKrw < 30_000) return { extraMult: 3, durationMs: 70_000, tier: "Mega Boost" };
  return { extraMult: 5, durationMs: 100_000, tier: "LEGENDARY" };
}
