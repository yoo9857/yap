import {
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "./messages.js";

export * from "./messages.js";

export type DecodeResult<T> =
  | { ok: true; msg: T }
  | { ok: false; error: string };

function decode<T>(
  raw: unknown,
  schema: { safeParse(v: unknown): { success: boolean; data?: T; error?: unknown } },
): DecodeResult<T> {
  if (typeof raw !== "string") return { ok: false, error: "non-string frame" };
  if (raw.length > 4096) return { ok: false, error: "frame too large" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success || parsed.data === undefined) {
    return { ok: false, error: "schema mismatch" };
  }
  return { ok: true, msg: parsed.data };
}

export function decodeClientMessage(raw: unknown): DecodeResult<ClientMessage> {
  return decode(raw, clientMessageSchema);
}

export function decodeServerMessage(raw: unknown): DecodeResult<ServerMessage> {
  return decode(raw, serverMessageSchema);
}

export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}
