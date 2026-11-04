import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

/**
 * How many game processes this machine can actually use — decided at boot
 * from what the container is ALLOWED, so resizing the server (or its docker
 * limits) needs no config change: 1 core runs the single process, 2+ cores a
 * shard per core. Every input may be missing or unreadable; then the safe
 * answer (fewer processes) wins.
 */
export interface Capacity {
  /** Cores the OS reports (host cores, or the CPU affinity set). */
  cores: number;
  /** cgroup CPU quota in cores (docker `cpus`), null when unlimited/unknown. */
  cpuQuota: number | null;
  /** cgroup memory limit in bytes (docker `mem_limit`), 0 when unlimited/unknown. */
  memoryBytes: number;
}

export interface ShardDecision {
  shards: number;
  /** Why, for the boot log: an operator reading it should not need this file. */
  reason: string;
}

/** Memory per process: the primary, and a shard with room for its loaded classes. */
export const PRIMARY_MIB = 80;
export const SHARD_MIB = 150;
export const MAX_SHARDS = 8;

export function decideShards(requested: string, cap: Capacity): ShardDecision {
  const usable = Math.max(1, Math.floor(Math.min(cap.cores, cap.cpuQuota ?? Infinity)));
  const byMemory = cap.memoryBytes > 0 ? Math.floor((cap.memoryBytes / 1048576 - PRIMARY_MIB) / SHARD_MIB) : Infinity;
  const where = `${usable} usable core(s)${cap.memoryBytes > 0 ? `, ${Math.round(cap.memoryBytes / 1048576)} MiB limit` : ""}`;

  if (requested !== "auto") {
    const asked = Number(requested);
    if (asked > 1 && byMemory < asked) {
      // more processes than the memory limit holds would get the whole container OOM-killed
      const shards = Math.max(1, byMemory);
      return { shards, reason: `SHARDS=${asked} lowered to ${shards}: ${where} cannot hold more` };
    }
    return { shards: asked, reason: asked > usable ? `SHARDS=${asked} (more than ${where}: they will share cores)` : `SHARDS=${asked}` };
  }
  // One core: a primary plus one shard would only add a process hop and ~70 MiB. A shard per
  // core above that — the primary relays no game traffic, so it needs no core of its own.
  if (usable <= 1) return { shards: 1, reason: `auto: ${where} → single process` };
  const shards = Math.max(1, Math.min(MAX_SHARDS, usable, byMemory));
  return { shards, reason: `auto: ${where} → ${shards === 1 ? "single process" : `${shards} shards`}` };
}

/** What this process may use. Never throws. */
export function readCapacity(): Capacity {
  let cores = 1;
  try { cores = availableParallelism(); } catch { /* keep 1 */ }
  let memoryBytes = 0;
  try { memoryBytes = process.constrainedMemory(); } catch { /* unknown */ }
  // a huge value is cgroup's "no limit"
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0 || memoryBytes > 2 ** 50) memoryBytes = 0;
  return { cores, cpuQuota: readCpuQuota(), memoryBytes };
}

/** docker `cpus` as cores: cgroup v2 `cpu.max` ("max 100000" = unlimited), else v1 cfs files. */
export function readCpuQuota(read: (path: string) => string = (p) => readFileSync(p, "utf8")): number | null {
  try {
    const [quota, period] = read("/sys/fs/cgroup/cpu.max").trim().split(/\s+/);
    if (quota === "max") return null;
    const q = Number(quota), p = Number(period);
    if (q > 0 && p > 0) return q / p;
  } catch { /* not cgroup v2 */ }
  try {
    const q = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").trim());
    const p = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us").trim());
    if (q > 0 && p > 0) return q / p; // -1 = unlimited
  } catch { /* not linux, or no cgroup */ }
  return null;
}
