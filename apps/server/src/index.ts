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

/** SHARDS=auto: leave one core to the primary (HTTP, TLS-less sockets, the hub), at most 8 shards. */
const shards = config.SHARDS === "auto" ? Math.max(1, Math.min(8, availableParallelism() - 1)) : Number(config.SHARDS);

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
