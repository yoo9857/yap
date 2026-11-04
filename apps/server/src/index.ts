import cluster from "node:cluster";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { runSingle } from "./cluster/single.js";
import { runPrimary } from "./cluster/primary.js";
import { runShard } from "./cluster/shard.js";
import { decideShards, readCapacity } from "./cluster/capacity.js";

const config = loadConfig();
const entryDir = dirname(fileURLToPath(import.meta.url));
const staticRoot = config.SERVE_STATIC ? resolve(entryDir, config.STATIC_DIR) : null;

// how many game processes: from what the container is allowed (cluster/capacity.ts), so resizing
// the server needs no config change. Shards are told their count, never re-decide it.
const decision = cluster.isWorker ? null : decideShards(config.SHARDS, readCapacity());
const shards = decision?.shards ?? 1;

if (cluster.isWorker) {
  // a shard: no port, no signals of its own to route — runShard wires its lifecycle
  runShard(config, entryDir, Number(process.env.SHARD_INDEX), Number(process.env.SHARD_COUNT));
} else {
  log.info({ shards, why: decision?.reason }, "game processes");
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
