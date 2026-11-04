import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { runSingle } from "./cluster/single.js";
import { runPrimary } from "./cluster/primary.js";
import { runShard } from "./cluster/shard.js";

const config = loadConfig();
const entryDir = dirname(fileURLToPath(import.meta.url));
const staticRoot = config.SERVE_STATIC ? resolve(entryDir, config.STATIC_DIR) : null;

/**
 * SHARDS=auto: leave one core to the primary (HTTP, the hub), at most 8 shards — and no more than
 * the container's memory holds: each process costs ~70 MiB before any class is loaded, and
 * docker's mem_limit kills the whole container, not one shard.
 */
function autoShards(): number {
  const byCpu = availableParallelism() - 1;
  const limit = process.constrainedMemory(); // 0 when unconstrained
  const byMemory = limit > 0 ? Math.floor((limit / 1048576 - PRIMARY_MIB) / SHARD_MIB) : Infinity;
  return Math.max(1, Math.min(8, byCpu, byMemory));
}
const PRIMARY_MIB = 80;
const SHARD_MIB = 150; // its own ~70 MiB plus room for loaded classes and their streams
const shards = config.SHARDS === "auto" ? autoShards() : Number(config.SHARDS);

if (cluster.isWorker) {
  // a shard: no port, no signals of its own to route — runShard wires its lifecycle
  runShard(config, entryDir, Number(process.env.SHARD_INDEX), Number(process.env.SHARD_COUNT));
} else {
  const shutdown = shards > 1 ? runPrimary(config, staticRoot, shards) : runSingle(config, entryDir, staticRoot);
  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception");
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason }, "unhandled rejection");
    shutdown("unhandledRejection", 1);
  });
}
