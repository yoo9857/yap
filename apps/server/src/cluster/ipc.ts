import type { IncomingHttpHeaders } from "node:http";
import type { ProcessSample } from "../metrics.js";
import type { ClassAdminAnswer, ClassAdminOp } from "../classroom/classAdmin.js";

/** How the site's API reaches the process that owns a class (set by runSingle / runPrimary). */
export type ClassAdminRun = (room: string, account: number, op: ClassAdminOp) => Promise<ClassAdminAnswer>;
export interface ClassDesk { run: ClassAdminRun | null }

/**
 * Messages between the cluster primary and its shards (Node IPC, JSON). The
 * primary owns the internet-facing parts — HTTP, connection limits, the party
 * hub — and the shards own the games. Kept to a handful of plain messages so
 * a later multi-machine version can carry the same ones over a network bus.
 */
export type ToShard =
  /** A /ws request the primary has routed here. The raw TCP socket travels as the IPC handle. */
  | { t: "upgrade"; route: string; url: string; method: string; headers: IncomingHttpHeaders; address: string; head: string }
  /** Every party room and its seated names (the shard's `partyGate`/`partyMember` mirror). */
  | { t: "roster"; rooms: [string, string[]][] }
  /** A party room's build game is starting: open its field now (optional; first join opens it too). */
  | { t: "party-open"; route: string; code: string }
  /** The directory dropped these routes (the shard offered them back at hand-off count `seen`). */
  | { t: "released"; routes: [string, number][] }
  /** 반 설정: the owner's account asks about / changes its class; answered with "class-admin-done" (classAdmin.ts). */
  | { t: "class-admin"; id: number; route: string; room: string; account: number; op: ClassAdminOp }
  | { t: "shutdown" };

export type ShardCounts = { classes: number; partyFields: number; online: number; classSockets: number; towerRooms: number; towerPlayers: number };

export type ToPrimary =
  | { t: "ready" }
  /** A routed socket closed: the primary frees its connection-limit slot. */
  | { t: "closed"; address: string }
  | { t: "stats"; sample: ProcessSample; counts: ShardCounts }
  /** Routes with no socket and no game left here, each with its hand-off count (directory.ts). */
  | { t: "release"; routes: [string, number][] }
  /** Players in each party's game on this shard (build field / tower room), sent when it changes. */
  | { t: "party-counts"; build: [string, number][]; tower: [string, number][] }
  | { t: "class-admin-done"; id: number; answer: ClassAdminAnswer };
