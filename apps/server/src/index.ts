import cluster from "node:cluster";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { runSingle } from "./cluster/single.js";
import { runPrimary } from "./cluster/primary.js";
import { runShard } from "./cluster/shard.js";
import { decideShards, readCapacity } from "./cluster/capacity.js";
import { setHandoffFile } from "./net/handoff.js";
import { createSiteStore, type SiteStore } from "./site/siteStore.js";
import { createSiteApi } from "./site/siteApi.js";
import { createClassIndex } from "./classroom/classStore.js";
import type { ClassDesk } from "./cluster/ipc.js";

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
  // the process that takes game sockets (single, or the cluster's primary) honours the deploy's hand-over lock
  setHandoffFile(resolve(entryDir, config.HANDOFF_FILE));
  // The site's own data (teachers' accounts, inquiries) and its API live in the process that answers
  // HTTP. A database that cannot be reached must not keep the GAMES from starting: the API answers
  // 503 until the next start, and says why in the log.
  let site: SiteStore | null = null;
  try {
    site = await createSiteStore(config.DATABASE_URL);
  } catch (err) {
    log.error({ err: (err as Error).message }, "site database unreachable: accounts, inquiries and the admin are closed (503)");
  }
  // 수업 관리 lists an account's classes straight from the games' file (read-only): this process may hold no classes
  const classIndex = createClassIndex(resolve(entryDir, config.DB_PATH));
  // 반 설정 is asked of the process that owns the class (set by runSingle / runPrimary below)
  const desk: ClassDesk = { run: null };
  const api = createSiteApi(site, {
    adminPassword: config.ADMIN_PASSWORD, pepper: config.AUTH_PEPPER, processes: shards, classes: (owner) => classIndex.owned(owner),
    classAdmin: (room, account, op) => desk.run?.(room, account, op) ?? Promise.resolve({ ok: false, error: "unavailable" }),
  });
  const stopGames = shards > 1 ? runPrimary(config, staticRoot, shards, api, desk) : runSingle(config, entryDir, staticRoot, api, desk);
  const shutdown = (reason: string, code: number) => {
    classIndex.close();
    site?.close().catch((err: unknown) => log.error({ err }, "site store close failed"));
    stopGames(reason, code);
  };
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
