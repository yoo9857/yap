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

  assign(session: Session, name: string): Room {
    for (const room of this.rooms.values()) {
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
