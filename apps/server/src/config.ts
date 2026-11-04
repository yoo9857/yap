import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8081),
  HOST: z.string().default("0.0.0.0"),
  SNAPSHOT_HZ: z.coerce.number().positive().max(60).default(15),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().positive().max(32).default(8),
  SERVE_STATIC: z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((v) => v === "1" || v === "true"),
  /** Resolved relative to the compiled entry (apps/server/dist/index.js). */
  STATIC_DIR: z.string().default("../../client/dist"),
  /** Daily-record SQLite path, resolved relative to the entry directory. */
  DB_PATH: z.string().default("../data/records.db"),
  /** Tower-day timezone as minutes east of UTC (default KST +9h). */
  DAY_UTC_OFFSET_MIN: z.coerce.number().int().min(-720).max(840).default(540),
  /** Open WebSockets per client address (a whole school shares one public IP) and in total. */
  MAX_CONN_PER_IP: z.coerce.number().int().positive().default(200),
  MAX_CONNECTIONS: z.coerce.number().int().positive().default(4000),
  /**
   * Game processes. 1 = everything in this one process (the default, and what dev runs).
   * N > 1 = a primary (HTTP, connection limits, party hub) handing each socket to one of N
   * shard processes by its room (cluster/directory.ts). "auto" = cores − 1, at most 8.
   * Only worth raising together with the container's CPU limit (docker-compose `cpus`).
   */
  SHARDS: z
    .string()
    .default("1")
    .refine((v) => v === "auto" || /^[1-9]\d?$/.test(v), "SHARDS must be 1-99 or auto"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

/** Parse and validate the environment once at boot; crash loudly if invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    console.error("invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
