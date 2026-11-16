import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A host ticket: how a GAME socket proves which teacher's account opens a class (docs/ACCOUNTS.md).
 *
 * The session cookie is known to the process that answers HTTP; a class's socket goes to a shard,
 * which has no sessions. So the page asks the API for a ticket — the account's id and an expiry,
 * signed — and sends it in `k-host`; the shard checks the signature with a key every process
 * derives from the same secret (AUTH_PEPPER). It is good for two minutes and for nothing else: it
 * is not a session, and a copied one is useless after that.
 */
const TTL_MS = 2 * 60_000;
/** Without AUTH_PEPPER (dev) the key is this process's own: fine for one process, and the cluster
 *  (many processes) simply gets no tickets — a class is then opened by its password, as before. */
const OWN = randomBytes(32);

export function ticketKey(pepper: string | undefined, processes: number): Buffer | null {
  if (pepper && pepper.length >= 32) return createHmac("sha256", pepper).update("craftyap host ticket v1").digest();
  return processes > 1 ? null : OWN;
}

const sign = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

export function makeTicket(key: Buffer, teacherId: number, now: number): string {
  const body = `${teacherId}.${now + TTL_MS}`;
  return `${body}.${sign(key, body)}`;
}

/** The account a ticket is for, or null (malformed, forged, expired). */
export function readTicket(key: Buffer | null, ticket: string, now: number): number | null {
  if (!key || ticket.length > 200) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts as [string, string, string];
  if (!/^[1-9]\d{0,15}$/.test(id) || !/^\d{13,16}$/.test(exp)) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(key, `${id}.${exp}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Number(exp) > now ? Number(id) : null;
}
