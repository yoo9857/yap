import { StreamEventSchema, type StreamEvent } from "@robo/shared";

/**
 * Rough fixed FX rates → KRW. The boost tiers (`streamBoost` in shared) are
 * coarse, so approximate conversion is fine — this is game feel, not
 * accounting. Unknown currencies fall back to the USD rate.
 */
const USD_KRW = 1350;
const KRW_PER: Record<string, number> = {
  KRW: 1,
  USD: USD_KRW,
  JPY: 9,
  EUR: 1450,
  GBP: 1700,
  TWD: 42,
  CAD: 1000,
  AUD: 900,
  HKD: 175,
};

export function toKrw(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const rate = KRW_PER[currency?.toUpperCase()] ?? USD_KRW;
  return Math.round(amount * rate);
}

/** Human-readable original amount, e.g. "US$5.00" or "₩5,000". */
export function formatDisplay(amount: number, currency: string): string {
  const cur = (currency || "KRW").toUpperCase();
  if (cur === "KRW") return `₩${Math.round(amount).toLocaleString("en-US")}`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(amount);
  } catch {
    return `${amount} ${cur}`;
  }
}

/** Safe coercion of untrusted values — never stringifies an object. */
export function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Parse a number from a value that may be a string like "₩5,000". */
export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Build + validate a StreamEvent, clamping strings to the schema limits. */
export function makeEvent(input: {
  source: StreamEvent["source"];
  kind: StreamEvent["kind"];
  name?: string;
  message?: string;
  amountKrw?: number;
  display?: string;
  id?: string;
}): StreamEvent {
  return StreamEventSchema.parse({
    source: input.source,
    kind: input.kind,
    name: (input.name ?? "").slice(0, 80),
    message: (input.message ?? "").slice(0, 500),
    amountKrw: input.amountKrw ?? 0,
    display: (input.display ?? "").slice(0, 40),
    id: input.id ? input.id.slice(0, 200) : undefined,
  });
}
