import { createServer } from "node:http";
import { partyFieldName } from "@robo/shared";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { ProcessMeter } from "../metrics.js";
import { createRequestHandler } from "../http/handler.js";
import { attachWsServer, createSocketHub } from "../net/wsServer.js";
import { PartyManager } from "../party/partyManager.js";
import { createGameServices } from "./services.js";

/** Everything in one process: HTTP, every game, the party hub. SHARDS=1 (the default). */
export function runSingle(config: Config, entryDir: string, staticRoot: string | null): (reason: string, code: number) => void {
  const game = createGameServices(config, entryDir);
  const { rooms, classes } = game;
  // the hub's rooms: in memory only; each room's game runs on the classroom
  // field ("build") or a tower room of its own ("tower"), keyed by its code
  const parties = new PartyManager({
    prepare: (room) => (room.game === "build" ? classes.openParty(partyFieldName(room.code)) !== null : true),
    players: (room) => (room.game === "build" ? classes.partyOnline(room.code) : rooms.partyPlayers(room.code)),
  });
  // party worlds open only for rooms that exist
  classes.partyGate = (code) => parties.has(code);
  classes.partyMember = (code, name) => parties.isMember(code, name);
  rooms.partyGate = (code) => parties.has(code);

  const meter = new ProcessMeter();
  const metrics = () => ({
    mode: "single",
    processes: [{ role: "single", ...meter.sample() }],
    totals: { ...game.counts(), partyRooms: parties.roomCount },
  });
  const httpServer = createServer(createRequestHandler(staticRoot, metrics));
  const closeWs = attachWsServer(httpServer, createSocketHub(rooms, classes, { parties }), {
    perAddress: config.MAX_CONN_PER_IP,
    total: config.MAX_CONNECTIONS,
  });

  httpServer.listen(config.PORT, config.HOST, () => {
    log.info({ port: config.PORT, static: staticRoot ?? "off", shards: 1 }, "robo server listening");
  });

  let shuttingDown = false;
  return (reason, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, "shutting down");
    // hard exit if graceful close hangs — armed first, so a step that throws
    // below cannot leave the process lingering until docker's SIGKILL
    setTimeout(() => process.exit(code), 3000).unref();
    for (const [name, step] of [
      ["ws", closeWs],
      ["parties", () => parties.shutdown()],
      ["game", () => game.shutdown()],
    ] as const) {
      try {
        step();
      } catch (err) {
        log.error({ err, step: name }, "shutdown step failed");
      }
    }
    meter.stop();
    httpServer.close(() => process.exit(code));
  };
}
