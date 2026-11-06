import cluster, { type Worker } from "node:cluster";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { ProcessMeter, type ProcessSample } from "../metrics.js";
import { createRequestHandler } from "../http/handler.js";
import { ConnectionGate, WS_OPTIONS, clientAddress } from "../net/wsServer.js";
import { PartyManager } from "../party/partyManager.js";
import { HUB_ROUTE, LiveDirectory, PUBLIC_TOWER, partyFieldRoute, routeOf } from "./directory.js";
import type { ShardCounts, ToPrimary, ToShard } from "./ipc.js";
import { handoffPending } from "../net/handoff.js";

/** A crashed shard comes back after this (its classes reload from the database on rejoin). */
const RESPAWN_MS = 1000;
/** An upgrade for a shard that is (re)starting waits this long before being told to retry. After a
 *  deploy every client reconnects in the same second, often before the shards have booted. */
const READY_WAIT_MS = 5000;

interface ShardSlot {
  index: number;
  worker: Worker | null;
  ready: boolean;
  /** Upgrades waiting for this shard to become ready. */
  waiting: (() => void)[];
  /** Connection-limit slots held by this shard's sockets, per address — freed all at once if it dies. */
  held: Map<string, number>;
  sample: (ProcessSample & { role: string; shard: number }) | null;
  counts: ShardCounts | null;
  build: Map<string, number>;
  tower: Map<string, number>;
}

/**
 * The cluster's front door. It owns everything that must be ONE thing for the
 * whole server — the port, the per-address connection limits, the party hub's
 * room list — and hands every game socket to the shard its route maps to
 * (directory.ts). It relays no game traffic: after the handoff a socket
 * belongs to its shard alone.
 */
export function runPrimary(config: Config, staticRoot: string | null, shards: number): (reason: string, code: number) => void {
  const directory = new LiveDirectory(shards);
  // nothing is up until it says so: boot-time sockets wait instead of all piling onto shard 0
  for (let i = 0; i < shards; i++) directory.setUp(i, false);
  const slots: ShardSlot[] = Array.from({ length: shards }, (_, index) => ({
    index, worker: null, ready: false, waiting: [], held: new Map(), sample: null, counts: null, build: new Map(), tower: new Map(),
  }));
  const gate = new ConnectionGate({ perAddress: config.MAX_CONN_PER_IP, total: config.MAX_CONNECTIONS });
  let shuttingDown = false;

  const toShard = (slot: ShardSlot, msg: ToShard, handle?: Socket, onFail?: () => void): boolean => {
    const w = slot.worker;
    if (!w || !slot.ready || !w.isConnected()) { onFail?.(); return false; }
    // send()'s boolean is backpressure, NOT failure: a false return is still queued and delivered
    // (refusing on it double-handled sockets already on their way). Real failures come back here.
    const failed = (err: Error | null) => {
      if (!err) return;
      log.warn({ err, shard: slot.index, t: msg.t }, "send to shard failed");
      if (handle && !handle.destroyed) handle.destroy(); // the client reconnects with backoff
      onFail?.();
    };
    try {
      if (handle) w.send(msg, handle, failed);
      else w.send(msg, failed);
      return true;
    } catch (err) {
      failed(err as Error);
      return false;
    }
  };

  // ---------------------------------------------------------------- party hub (here, one copy)

  const parties = new PartyManager({
    prepare: (room) => {
      // the field opens on its first join anyway; asking now just saves that join a beat
      if (room.game === "build") {
        const route = partyFieldRoute(room.code);
        const slot = slots[directory.placeNow(route)]!;
        // counted as a hand-off: the shard's ledger counts it too, so the counters still agree
        toShard(slot, { t: "party-open", route, code: room.code }, undefined, () => directory.cancelNow(route, slot.index));
      }
      return true;
    },
    players: (room) => {
      let n = 0;
      for (const s of slots) n += (room.game === "build" ? s.build : s.tower).get(room.code) ?? 0;
      return n;
    },
  });
  // seat changes reach every shard before the page that caused them can navigate into a game:
  // the broadcast is queued in this same tick, a navigation takes hundreds of milliseconds
  let rosterQueued = false;
  let lastRoster = "";
  const broadcastRoster = (force = false) => {
    const rooms = parties.roster();
    const sig = JSON.stringify(rooms);
    if (!force && sig === lastRoster) return;
    lastRoster = sig;
    for (const s of slots) toShard(s, { t: "roster", rooms });
  };
  parties.onRosterChange = () => {
    if (rosterQueued) return;
    rosterQueued = true;
    queueMicrotask(() => { rosterQueued = false; broadcastRoster(); });
  };

  // ---------------------------------------------------------------- shards

  function fork(slot: ShardSlot): void {
    const worker = cluster.fork({ SHARD_INDEX: String(slot.index), SHARD_COUNT: String(shards) });
    slot.worker = worker;
    slot.ready = false;
    worker.on("message", (msg: ToPrimary) => {
      switch (msg.t) {
        case "ready":
          slot.ready = true;
          directory.setUp(slot.index, true);
          // a (re)started shard learns the whole roster before its first socket
          toShard(slot, { t: "roster", rooms: parties.roster() });
          for (const wake of slot.waiting.splice(0)) wake();
          if (!booted && slots.every((s) => s.ready)) markBooted();
          return;
        case "closed": {
          const n = slot.held.get(msg.address) ?? 0;
          if (n <= 0) return;
          if (n === 1) slot.held.delete(msg.address); else slot.held.set(msg.address, n - 1);
          gate.release(msg.address);
          return;
        }
        case "stats":
          slot.sample = { role: "shard", shard: slot.index, ...msg.sample };
          slot.counts = msg.counts;
          directory.report(slot.index, msg.counts.classSockets + msg.counts.towerPlayers);
          return;
        case "release": {
          const routes = msg.routes.filter(([route, seen]) => directory.releaseNow(route, slot.index, seen));
          if (routes.length) toShard(slot, { t: "released", routes });
          return;
        }
        case "party-counts":
          slot.build = new Map(msg.build);
          slot.tower = new Map(msg.tower);
          return;
      }
    });
    worker.on("exit", (code, signal) => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      slot.ready = false;
      directory.setUp(slot.index, false); // its games died with it: their routes are placed afresh
      slot.sample = null;
      slot.counts = null;
      slot.build.clear();
      slot.tower.clear();
      // its sockets died with it
      for (const [address, n] of slot.held) for (let i = 0; i < n; i++) gate.release(address);
      slot.held.clear();
      if (shuttingDown) return;
      log.error({ shard: slot.index, code, signal }, "shard exited — restarting");
      setTimeout(() => { if (!shuttingDown) fork(slot); }, RESPAWN_MS);
    });
  }
  // boot: routes are placed once every shard is up (or READY_WAIT_MS passed — then on those that are)
  let booted = false;
  let markBooted = () => {};
  const bootWait = new Promise<void>((resolve) => {
    markBooted = () => { booted = true; resolve(); };
    setTimeout(markBooted, READY_WAIT_MS);
  });
  for (const slot of slots) fork(slot);

  // ---------------------------------------------------------------- HTTP + upgrades

  const meter = new ProcessMeter();
  const metrics = () => {
    const totals: Record<string, number> = { partyRooms: parties.roomCount, sockets: gate.total };
    for (const s of slots) for (const [k, v] of Object.entries(s.counts ?? {})) totals[k] = (totals[k] ?? 0) + v;
    return {
      mode: "cluster",
      shards,
      up: slots.filter((s) => s.ready).length,
      routes: directory.size,
      processes: [{ role: "primary", ...meter.sample() }, ...slots.flatMap((s) => (s.sample ? [{ ...s.sample, counts: s.counts }] : []))],
      totals,
    };
  };
  // healthy = every shard is up (docker's healthcheck and the deploy's wait read this)
  const httpServer = createServer(createRequestHandler(staticRoot, metrics, () => slots.every((s) => s.ready)));
  // terminates only what stays here: the hub's sockets, and polite refusals
  const local = new WebSocketServer({ noServer: true, ...WS_OPTIONS });

  const refuse = (req: IncomingMessage, socket: Duplex, head: Buffer, reason: string) => {
    // 1013 "try again later": every client reconnects with backoff
    local.handleUpgrade(req, socket, head, (ws) => ws.close(1013, reason));
  };

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = req.url ?? "/";
      if (new URL(url, "http://x").pathname !== "/ws" || shuttingDown) {
        socket.destroy();
        return;
      }
      const address = clientAddress(req);
      if (handoffPending()) {
        // a deploy is handing the games over to the new container: come back in a moment
        refuse(req, socket, head, "busy");
        return;
      }
      if (!gate.admit(address)) {
        log.warn({ from: address, open: gate.total }, "connection refused: too many sockets");
        refuse(req, socket, head, "busy");
        return;
      }
      let route = routeOf(url);
      // a party link whose hub room is gone (expired, or a deploy) plays the public tower, as it
      // did before shards; routing it to its own route would strand it in a room of its own
      if (route.startsWith("tower:party:") && !parties.has(route.slice("tower:party:".length))) route = PUBLIC_TOWER;
      if (route === HUB_ROUTE) {
        // freed when the TCP socket goes, not the WebSocket: a handshake ws aborts (bad key,
        // wrong method) never reaches the callback, and its slot would be held forever
        socket.once("close", () => gate.release(address));
        local.handleUpgrade(req, socket, head, (ws) => parties.accept(ws, address));
        return;
      }
      // right after a (re)boot nothing is up yet: placing now would pin every reconnecting class
      // to the one fallback shard for the whole lesson. Wait until all shards have said ready.
      if (!booted) await bootWait;
      const slot = slots[await directory.place(route)]!;
      if (!slot.ready) {
        await new Promise<void>((wake) => {
          const waiter = () => { clearTimeout(timer); wake(); };
          const timer = setTimeout(() => {
            // a shard in a crash loop must not collect one waiter per attempt
            const i = slot.waiting.indexOf(waiter);
            if (i >= 0) slot.waiting.splice(i, 1);
            wake();
          }, READY_WAIT_MS);
          slot.waiting.push(waiter);
        });
        if (socket.destroyed) { directory.cancelNow(route, slot.index); gate.release(address); return; }
      }
      const sent = toShard(
        slot,
        { t: "upgrade", route, url, method: req.method ?? "GET", headers: req.headers, address, head: head.toString("base64") },
        socket as Socket,
        () => {
          // never arrived: the shard will not report this socket's close, so free its slot here
          directory.cancelNow(route, slot.index);
          const n = slot.held.get(address) ?? 0;
          if (n <= 0) return;
          if (n === 1) slot.held.delete(address); else slot.held.set(address, n - 1);
          gate.release(address);
        },
      );
      if (!sent) {
        // the shard is restarting: the client's backoff brings it back in a second or two
        gate.release(address);
        if (!socket.destroyed) refuse(req, socket, head, "restarting");
        return;
      }
      slot.held.set(address, (slot.held.get(address) ?? 0) + 1);
    })().catch((err: unknown) => {
      log.error({ err }, "upgrade routing failed");
      socket.destroy();
    });
  });

  httpServer.listen(config.PORT, config.HOST, () => {
    log.info({ port: config.PORT, static: staticRoot ?? "off", shards }, "robo server listening (cluster)");
  });

  return (reason, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, "shutting down cluster");
    setTimeout(() => process.exit(code), 4000).unref();
    try { parties.shutdown(); } catch (err) { log.error({ err }, "party shutdown failed"); }
    local.close();
    meter.stop();
    // each shard saves its classes; we wait for all of them before going
    const live = slots.flatMap((s) => (s.worker ? [s.worker] : []));
    for (const s of slots) if (!toShard(s, { t: "shutdown" })) s.worker?.kill();
    let left = live.length;
    const done = () => httpServer.close(() => process.exit(code));
    if (left === 0) done();
    for (const w of live) w.once("exit", () => { if (--left === 0) done(); });
  };
}
