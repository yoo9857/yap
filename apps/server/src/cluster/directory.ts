import { classKey, partyCodeSchema } from "@robo/shared";

/**
 * Where does a connection's game live?
 *
 * Every socket names its game in its URL, and that name is its ROUTE. The
 * directory maps each LIVE route to the one shard that holds it, so a class
 * (or a party's world, or a tower room) exists in exactly one process and its
 * players meet there:
 *
 *   /ws?mode=class&room=햇살반    → "class:햇살반"   (classKey: case/space-insensitive)
 *   /ws?mode=class&room=party:AB… → "class:party:ab…" (a party room's build field)
 *   /ws?mode=party                → "hub"            (the room list: one place, the primary)
 *   /ws?party=ABCDEF              → "tower:party:ABCDEF"
 *   /ws                           → "tower:public"   (one shard, so players fill rooms together)
 *
 * A class socket without `room` comes from a page older than routing. It goes
 * to shard 0, which refuses it unless it already holds that class, and the
 * refusal ("bad-version") reloads the page into a routed one.
 */
export type Route = string;
export const HUB_ROUTE: Route = "hub";
export const UNROUTED_CLASS: Route = "class:?";
export const PUBLIC_TOWER: Route = "tower:public";

export function routeOf(url: string): Route {
  const params = new URL(url, "http://x").searchParams;
  const mode = params.get("mode");
  if (mode === "party") return HUB_ROUTE;
  if (mode === "class") {
    const room = params.get("room");
    return room && room.trim() ? classRoute(room) : UNROUTED_CLASS;
  }
  const party = params.get("party")?.toUpperCase();
  return party && partyCodeSchema.safeParse(party).success ? towerPartyRoute(party) : PUBLIC_TOWER;
}

export const classRoute = (room: string): Route => `class:${classKey(room)}`;
export const towerPartyRoute = (code: string): Route => `tower:party:${code}`;
export const partyFieldRoute = (code: string): Route => classRoute(`party:${code}`);

/**
 * The directory: route → shard. Everything above it only asks `place` and
 * reports `release`, so a multi-machine deployment swaps this for a shared
 * store (e.g. Redis: route → node, with the same hand-off counter as a
 * compare-and-delete) without touching the callers. Async for that reason.
 */
export interface RoomDirectory {
  /** The shard for this route: where it lives now, or — if nowhere — the least loaded one. */
  place(route: Route): Promise<number>;
  /** The shard has nothing of this route left. True if the mapping was removed (see LiveDirectory). */
  release(route: Route, shard: number, seen: number): Promise<boolean>;
}

/**
 * Sticky, load-aware placement in one primary's memory.
 *
 * A NEW route goes to the shard with the least load (its last reported
 * sockets plus what has been handed to it since), so a hot shard stops
 * receiving new classes while a cold one fills — unlike hashing, which
 * spreads only the COUNT of classes and left one shard saturated while
 * another idled at 20% in the load test. A LIVE route keeps its shard until
 * that shard gives it back.
 *
 * Giving back is a compare-and-delete on a hand-off counter: the primary
 * counts sockets it handed to the route's shard, the shard counts sockets it
 * received, and `release` only deletes when the two agree. A socket still in
 * flight therefore keeps the mapping, and the class can never open on a second
 * shard while the first still has a player arriving.
 */
export class LiveDirectory implements RoomDirectory {
  private readonly live = new Map<Route, { shard: number; handed: number }>();
  private readonly base: number[];
  private readonly pending: number[];
  private readonly up: boolean[];

  constructor(readonly shards: number) {
    if (!Number.isInteger(shards) || shards < 1) throw new Error(`bad shard count ${shards}`);
    this.base = new Array<number>(shards).fill(0);
    this.pending = new Array<number>(shards).fill(0);
    this.up = new Array<boolean>(shards).fill(true);
  }

  place(route: Route): Promise<number> {
    return Promise.resolve(this.placeNow(route));
  }

  release(route: Route, shard: number, seen: number): Promise<boolean> {
    return Promise.resolve(this.releaseNow(route, shard, seen));
  }

  placeNow(route: Route): number {
    if (route === UNROUTED_CLASS) return 0; // not placed: shard 0 only answers "refresh"
    let entry = this.live.get(route);
    if (!entry) {
      entry = { shard: this.leastLoaded(), handed: 0 };
      this.live.set(route, entry);
    }
    entry.handed++;
    this.pending[entry.shard]!++;
    return entry.shard;
  }

  releaseNow(route: Route, shard: number, seen: number): boolean {
    const entry = this.live.get(route);
    if (!entry || entry.shard !== shard || entry.handed !== seen) return false;
    this.live.delete(route);
    return true;
  }

  /** A shard's measured load (its open game sockets). Replaces the guesses made since the last one. */
  report(shard: number, load: number): void {
    this.base[shard] = load;
    this.pending[shard] = 0;
  }

  /** Down shards get no NEW routes; a shard that died loses its routes (their games died with it). */
  setUp(shard: number, up: boolean): void {
    this.up[shard] = up;
    if (up) return;
    for (const [route, entry] of this.live) if (entry.shard === shard) this.live.delete(route);
    this.base[shard] = 0;
    this.pending[shard] = 0;
  }

  /** A `place` whose hand-off never happened (the socket closed while waiting, the send failed):
   *  take it back so the counters can still agree. A route nobody ever reached is forgotten. */
  cancelNow(route: Route, shard: number): void {
    const entry = this.live.get(route);
    if (!entry || entry.shard !== shard || entry.handed === 0) return;
    entry.handed--;
    this.pending[shard] = Math.max(0, this.pending[shard]! - 1);
    if (entry.handed === 0) this.live.delete(route);
  }

  where(route: Route): number | undefined {
    return this.live.get(route)?.shard;
  }

  get size(): number {
    return this.live.size;
  }

  private leastLoaded(): number {
    let best = -1, bestLoad = Infinity;
    for (let s = 0; s < this.shards; s++) {
      if (!this.up[s]) continue;
      const load = this.base[s]! + this.pending[s]!;
      if (load < bestLoad) { best = s; bestLoad = load; }
    }
    // nothing up (boot): place anyway; the upgrade waits for the shard to become ready
    return best === -1 ? 0 : best;
  }
}

/**
 * The shard's half of the hand-off counter: which routes it holds, how many
 * sockets it has received for each (`seen`) and how many are open. A route
 * with no open socket and no live game is offered back to the directory.
 */
export class RouteLedger {
  private readonly routes = new Map<Route, { seen: number; open: number }>();

  /** A socket (or a party-open) for this route arrived. */
  arrive(route: Route, socket: boolean): void {
    const entry = this.routes.get(route) ?? { seen: 0, open: 0 };
    entry.seen++;
    if (socket) entry.open++;
    this.routes.set(route, entry);
  }

  leave(route: Route): void {
    const entry = this.routes.get(route);
    if (entry && entry.open > 0) entry.open--;
  }

  has(route: Route): boolean {
    return this.routes.has(route);
  }

  /** Routes this shard could give back: no socket open and `live` says nothing of it remains. */
  idle(live: (route: Route) => boolean): [Route, number][] {
    const out: [Route, number][] = [];
    for (const [route, entry] of this.routes) if (entry.open === 0 && !live(route)) out.push([route, entry.seen]);
    return out;
  }

  /** The directory accepted the release made at `seen`. A later arrival keeps the route. */
  released(route: Route, seen: number): void {
    if (this.routes.get(route)?.seen === seen) this.routes.delete(route);
  }

  get size(): number {
    return this.routes.size;
  }
}
