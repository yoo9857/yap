import { dayInfoAt, type DayInfo } from "@robo/shared";
import { log } from "../log.js";
import type { Session } from "../net/session.js";
import type { RecordStore } from "./records.js";
import { Room } from "./room.js";

const EMPTY_ROOM_TTL_MS = 60_000;
const DAY_CHECK_INTERVAL_MS = 1000;

/**
 * Assigns players into rooms for TODAY's tower. At midnight (tower timezone)
 * the day rolls over: live rooms get an s-notice, stay playable for whoever
 * is inside, but receive no new players and are collected once empty.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private nextRoomNumber = 1;
  private day: DayInfo;
  private readonly gcTimer: NodeJS.Timeout;
  private readonly dayTimer: NodeJS.Timeout;

  constructor(
    private readonly maxPlayersPerRoom: number,
    private readonly records: RecordStore,
    private readonly dayUtcOffsetMin: number,
  ) {
    this.day = dayInfoAt(Date.now(), dayUtcOffsetMin);
    log.info(
      { dateStr: this.day.dateStr, dayNumber: this.day.dayNumber, seed: this.day.seed },
      "daily tower",
    );
    this.gcTimer = setInterval(() => this.gc(), 15_000);
    this.dayTimer = setInterval(() => this.checkRollover(), DAY_CHECK_INTERVAL_MS);
  }

  get currentDay(): DayInfo {
    return this.day;
  }

  /**
   * Into today's tower. With a party code the player goes into that party's
   * own room (made on first use, never shared with strangers); otherwise into
   * the first public room with space.
   */
  assign(session: Session, name: string, party?: string): Room {
    if (party && (!this.partyGate || this.partyGate(party))) {
      const id = `party-${party}`;
      let room = this.rooms.get(id);
      // yesterday's party room stays for those inside; a newcomer gets today's
      if (room && room.seed !== this.day.seed && room.size === 0) {
        room.destroy();
        this.rooms.delete(id);
        room = undefined;
      }
      if (room && room.seed !== this.day.seed) {
        // players still on yesterday's tower keep it; it is collected once empty
        this.rooms.set(`${id}~${room.seed}`, room);
        room = undefined;
      }
      if (!room) {
        room = new Room(id, this.day, this.records, this.maxPlayersPerRoom);
        this.rooms.set(id, room);
        log.info({ room: id, dateStr: this.day.dateStr }, "party tower room created");
      }
      // a full party room refuses rather than dropping the player among strangers
      if (room.isFull) throw new Error("party tower room is full");
      room.join(session, name);
      return room;
    }
    for (const room of this.rooms.values()) {
      if (room.id.startsWith("party-")) continue;
      if (!room.isFull && room.seed === this.day.seed) {
        room.join(session, name);
        return room;
      }
    }
    const id = `room-${this.nextRoomNumber++}`;
    const room = new Room(id, this.day, this.records, this.maxPlayersPerRoom);
    this.rooms.set(id, room);
    log.info({ room: id, dateStr: this.day.dateStr }, "room created");
    room.join(session, name);
    return room;
  }

  /** Players in a party's tower room right now. */
  partyPlayers(party: string): number {
    // today's room and any still running yesterday's tower (kept under `party-X~seed`)
    let n = 0;
    for (const [key, room] of this.rooms) if (key === `party-${party}` || key.startsWith(`party-${party}~`)) n += room.size;
    return n;
  }

  /** Any public (non-party) tower room alive here? */
  holdsPublic(): boolean {
    for (const key of this.rooms.keys()) if (!key.startsWith("party-")) return true;
    return false;
  }

  /** Any tower room of this party alive here (today's or yesterday's)? */
  holdsParty(code: string): boolean {
    for (const key of this.rooms.keys()) if (key === `party-${code}` || key.startsWith(`party-${code}~`)) return true;
    return false;
  }

  /** Tower rooms and the players in them (for /metrics). */
  stats(): { rooms: number; players: number } {
    let players = 0;
    for (const room of this.rooms.values()) players += room.size;
    return { rooms: this.rooms.size, players };
  }

  /** Players per party code in its tower rooms (the party hub's "is the game still running"). */
  partyCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, room] of this.rooms) {
      if (!key.startsWith("party-") || room.size === 0) continue;
      const code = key.slice("party-".length).split("~")[0]!;
      out.set(code, (out.get(code) ?? 0) + room.size);
    }
    return out;
  }

  /** Is `code` a live hub room? Set by the server; unset (tests) means any code. */
  partyGate: ((code: string) => boolean) | null = null;

  private checkRollover(): void {
    if (Date.now() < this.day.nextDayStartMs) return;
    this.day = dayInfoAt(Date.now(), this.dayUtcOffsetMin);
    log.info(
      { dateStr: this.day.dateStr, dayNumber: this.day.dayNumber, seed: this.day.seed },
      "tower day rolled over",
    );
    for (const room of this.rooms.values()) {
      room.notifyNewDay(this.day.dateStr);
    }
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.size === 0 && room.emptySinceMs !== null && now - room.emptySinceMs > EMPTY_ROOM_TTL_MS) {
        room.destroy();
        this.rooms.delete(id);
        log.info({ room: id }, "empty room collected");
      }
    }
  }

  shutdown(): void {
    clearInterval(this.gcTimer);
    clearInterval(this.dayTimer);
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }
}
