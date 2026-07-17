import { pino } from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // no pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
});
