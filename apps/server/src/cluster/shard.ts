import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { ProcessMeter } from "../metrics.js";
import { WS_OPTIONS, createSocketHub } from "../net/wsServer.js";
import { nameKey } from "../party/partyRoom.js";
import { PUBLIC_TOWER, RouteLedger, UNROUTED_CLASS, classRoute, towerPartyRoute, type Route } from "./directory.js";
import type { ToPrimary, ToShard } from "./ipc.js";
import { createGameServices } from "./services.js";

const STATS_MS = 2000;
const COUNTS_MS = 1000;
/** How often routes with nothing left are offered back to the directory. */
const RELEASE_MS = 5000;

/**
 * One game process of the cluster. It never listens on a port: the primary
 * accepts each TCP connection, decides by route that it belongs here, and
 * passes the socket over IPC together with the HTTP upgrade request it had
 * already read. From then on the socket talks to this process directly — the
 * primary does not relay game traffic.
 */
export function runShard(config: Config, entryDir: string, index: number, shards: number): void {
  const send = (msg: ToPrimary) => process.send?.(msg);
  const ledger = new RouteLedger();
  const game = createGameServices(config, entryDir);
  const { rooms, classes } = game;

  // the party hub lives on the primary; this mirror answers the games' synchronous questions
  const roster = new Map<string, Set<string>>();
  classes.partyGate = (code) => roster.has(code);
  classes.partyMember = (code, name) => roster.get(code)?.has(nameKey(name)) ?? false;
  rooms.partyGate = (code) => roster.has(code);
  // a class/tower room exists in exactly one shard: the one the directory placed its route on
  classes.owns = (key) => ledger.has(classRoute(key));
  const hub = createSocketHub(rooms, classes, {
    parties: null,
    ownsTower: (party) => ledger.has(party ? towerPartyRoute(party) : PUBLIC_TOWER),
  });
  /** Is anything of this route still alive here (a loaded class, a tower room)? */
  const live = (route: Route): boolean => {
    if (route.startsWith("class:")) return classes.holds(route.slice("class:".length));
    if (route === PUBLIC_TOWER) return rooms.holdsPublic();
    if (route.startsWith("tower:party:")) return rooms.holdsParty(route.slice("tower:party:".length));
    return false;
  };

  const wss = new WebSocketServer({ noServer: true, ...WS_OPTIONS });
  const meter = new ProcessMeter();

  function upgrade(msg: Extract<ToShard, { t: "upgrade" }>, socket: Socket): void {
    const tracked = msg.route !== UNROUTED_CLASS;
    if (tracked) ledger.arrive(msg.route, true);
    // the slot is the primary's: give it back however this socket ends (even a failed handshake)
    socket.once("close", () => {
      if (tracked) ledger.leave(msg.route);
      send({ t: "closed", address: msg.address });
    });
    const req = { method: msg.method, url: msg.url, headers: msg.headers, socket } as unknown as IncomingMessage;
    wss.handleUpgrade(req, socket, Buffer.from(msg.head, "base64"), (ws) => {
      try {
        hub.accept(ws, msg.url, msg.address);
      } catch (err) {
        log.error({ err }, "shard accept failed");
        ws.close(1011, "internal");
      }
    });
  }

  process.on("message", (raw: unknown, handle?: unknown) => {
    const msg = raw as ToShard;
    try {
      switch (msg.t) {
        case "upgrade":
          if (handle) upgrade(msg, handle as Socket);
          return;
        case "roster":
          roster.clear();
          for (const [code, names] of msg.rooms) roster.set(code, new Set(names.map(nameKey)));
          return;
        case "party-open":
          ledger.arrive(msg.route, false);
          classes.openParty(`party:${msg.code}`);
          return;
        case "released":
          for (const [route, seen] of msg.routes) ledger.released(route, seen);
          return;
        case "shutdown":
          shutdown("primary", 0);
          return;
      }
    } catch (err) {
      log.error({ err, t: msg.t }, "shard message failed");
    }
  });

  let lastCounts = "";
  const timers = [
    setInterval(() => send({ t: "stats", sample: meter.sample(), counts: game.counts() }), STATS_MS),
    setInterval(() => {
      const build = [...classes.partyCounts()], tower = [...rooms.partyCounts()];
      const sig = JSON.stringify([build, tower]);
      if (sig === lastCounts) return;
      lastCounts = sig;
      send({ t: "party-counts", build, tower });
    }, COUNTS_MS),
    setInterval(() => {
      const routes = ledger.idle(live);
      if (routes.length) send({ t: "release", routes });
    }, RELEASE_MS),
  ];

  let shuttingDown = false;
  function shutdown(reason: string, code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason, shard: index }, "shard shutting down");
    setTimeout(() => process.exit(code), 2500).unref();
    for (const t of timers) clearInterval(t);
    try { hub.close(); } catch (err) { log.error({ err }, "shard hub close failed"); }
    // saves every class and drops sockets; never "lesson over" (see ClassManager.shutdown)
    game.shutdown();
    meter.stop();
    wss.close();
    process.exit(code);
  }
  // the primary is our lifeline: if it is gone, nobody can reach us any more
  process.on("disconnect", () => shutdown("primary gone", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("uncaughtException", (err) => {
    log.fatal({ err, shard: index }, "uncaught exception");
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason, shard: index }, "unhandled rejection");
    shutdown("unhandledRejection", 1);
  });

  send({ t: "ready" });
  log.info({ shard: index, of: shards, pid: process.pid }, "shard ready");
}
