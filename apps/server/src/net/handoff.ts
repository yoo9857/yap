import { statSync } from "node:fs";

/**
 * Zero-downtime deploys (scripts/zero-downtime-deploy.sh): the new container starts beside the old
 * one, then for a few seconds — while nginx switches over and the OLD container saves every
 * classroom and closes — no process may take a NEW game socket. A class opened on the new
 * container before the old one saved it would load a stale field, and the two would diverge.
 *
 * The deploy marks that window with a file in the shared data directory (both containers see the
 * same bind mount). While it is fresh, every new game socket is refused 1013 "try again later",
 * which every client already answers by reconnecting with backoff; pages and assets keep serving.
 * A lock older than HANDOFF_MAX_MS is ignored, so a deploy that died mid-way can never lock the
 * games out for good.
 */
export const HANDOFF_MAX_MS = 60_000;

let lockPath: string | null = null;

export function setHandoffFile(path: string | null): void {
  lockPath = path;
}

/** A deploy is handing the games over right now: refuse new game sockets (they retry). */
export function handoffPending(now = Date.now()): boolean {
  if (!lockPath) return false;
  try {
    return now - statSync(lockPath).mtimeMs < HANDOFF_MAX_MS;
  } catch {
    return false; // no lock: the normal case
  }
}
