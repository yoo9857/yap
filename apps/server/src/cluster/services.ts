import { resolve } from "node:path";
import type { Config } from "../config.js";
import { createRecordStore, type RecordStore } from "../game/records.js";
import { RoomManager } from "../game/roomManager.js";
import { ClassManager } from "../classroom/classManager.js";
import { createClassStore } from "../classroom/classStore.js";
import { log } from "../log.js";

/** The game state one process holds: tower rooms + daily records, and classes (incl. party fields). */
export interface GameServices {
  records: RecordStore;
  rooms: RoomManager;
  classes: ClassManager;
  counts(): { classes: number; partyFields: number; online: number; classSockets: number; towerRooms: number; towerPlayers: number };
  shutdown(): void;
}

export function createGameServices(config: Config, entryDir: string): GameServices {
  // classes live in the same SQLite file as the records, so the existing bind-mount and daily
  // backup cover them too. With shards, every shard opens it (WAL: one writer at a time, readers
  // never blocked); a class is only ever written by the one shard that owns it.
  const dbPath = resolve(entryDir, config.DB_PATH);
  const records = createRecordStore(dbPath);
  const rooms = new RoomManager(config.MAX_PLAYERS_PER_ROOM, records, config.DAY_UTC_OFFSET_MIN);
  const classes = new ClassManager(createClassStore(dbPath));
  return {
    records,
    rooms,
    classes,
    counts() {
      const c = classes.stats(), r = rooms.stats();
      return { classes: c.classes, partyFields: c.partyFields, online: c.online, classSockets: c.sockets, towerRooms: r.rooms, towerPlayers: r.players };
    },
    shutdown() {
      for (const [name, step] of [
        ["rooms", () => rooms.shutdown()],
        ["classes", () => classes.shutdown()],
        ["records", () => records.close()],
      ] as const) {
        try {
          step();
        } catch (err) {
          log.error({ err, step: name }, "shutdown step failed");
        }
      }
    },
  };
}
