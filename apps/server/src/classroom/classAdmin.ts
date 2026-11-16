import { randomBytes } from "node:crypto";
import { z } from "zod";
import { classKey, playerNameSchema, type ClassSettings, type ClassTheme } from "@robo/shared";
import { hashPassword, type SavedClass } from "./classStore.js";

/**
 * 반 설정 (the teacher's /teacher/ page → a class): what the owner of a class may see and change
 * BETWEEN lessons — the roster, the class password, the locks a lesson starts with, the field, the
 * seating, the class itself. Pure: a saved class in, a saved class out. Who may ask and when is
 * `ClassManager.admin` (the owner's account, and never while anyone is in the class: during a
 * lesson the same things are done from F2, and a change made to the save would be written over
 * by the running class).
 */
export const CLASS_ADMIN_ROSTER_MAX = 200; // (the saved roster's own cap: MAX_SAVED_SEATS)

const flag = z.boolean().optional();
export const classAdminOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get") }),
  z.object({ op: z.literal("add-students"), names: z.array(z.string().max(40)).min(1).max(60) }),
  z.object({ op: z.literal("remove-student"), name: z.string().min(1).max(40) }),
  z.object({ op: z.literal("password"), password: z.string().min(4).max(100) }),
  z.object({ op: z.literal("settings"), chatLocked: flag, buildLocked: flag, tapsLocked: flag, plantsLocked: flag, petsOff: flag }),
  z.object({ op: z.literal("reset-field") }),
  z.object({ op: z.literal("clear-seats") }),
  z.object({ op: z.literal("delete") }),
]);
export type ClassAdminOp = z.infer<typeof classAdminOpSchema>;

/** What the page shows of a class: names and counts — never a key, a hash or the field itself. */
export interface ClassView {
  name: string;
  teacher: string;
  theme: ClassTheme;
  students: { name: string; online: boolean }[];
  settings: { chatLocked: boolean; buildLocked: boolean; tapsLocked: boolean; plantsLocked: boolean; petsOff: boolean };
  field: { blocks: number; furniture: number; plants: number };
  seats: number;
  /** People in the class right now (0: between lessons — the settings can be changed). */
  online: number;
}

export type ClassAdminAnswer =
  | { ok: true; class: ClassView }
  | { ok: true; deleted: true }
  /** not-found: no such class OR not this account's (one answer). busy: a lesson is running. */
  | { ok: false; error: "not-found" | "busy" | "fields" | "unavailable" };

export function classView(key: string, d: SavedClass, live?: { students: { name: string; online: boolean }[]; settings: ClassSettings; online: number }): ClassView {
  const s = live?.settings ?? d.settings;
  return {
    name: d.roomName ?? d.teacherName ?? key,
    teacher: d.teacherName,
    theme: d.theme ?? "craft",
    students: live?.students ?? d.students.map((x) => ({ name: x.name, online: false })),
    settings: { chatLocked: s.chatLocked, buildLocked: s.buildLocked, tapsLocked: s.tapsLocked === true, plantsLocked: s.plantsLocked === true, petsOff: s.petsOff === true },
    field: { blocks: d.edits.length, furniture: d.furniture?.length ?? 0, plants: d.plants?.length ?? 0 },
    seats: d.seating?.seats.length ?? 0,
    online: live?.online ?? 0,
  };
}

/** The save after `op` (never "get" or "delete": those change nothing here), or null when the op asks for nothing valid. */
export function applyClassAdmin(d: SavedClass, op: Exclude<ClassAdminOp, { op: "get" | "delete" }>): SavedClass | null {
  switch (op.op) {
    case "add-students": {
      const taken = new Set([classKey(d.teacherName), ...d.students.map((s) => classKey(s.name))]);
      const added: { name: string; key: string }[] = [];
      for (const raw of op.names) {
        const name = playerNameSchema.safeParse(raw.trim().replace(/\s+/g, " "));
        if (!name.success || taken.has(classKey(name.data))) continue; // a name already there (or the teacher's) is simply skipped
        taken.add(classKey(name.data));
        // a seat nobody holds yet: the student who joins under this name gets it (joinStudent takes an offline seat by name)
        added.push({ name: name.data, key: randomBytes(16).toString("hex") });
      }
      if (added.length === 0 || d.students.length + added.length > CLASS_ADMIN_ROSTER_MAX) return null;
      return { ...d, students: [...d.students, ...added] };
    }
    case "remove-student": {
      const gone = classKey(op.name);
      if (!d.students.some((s) => classKey(s.name) === gone)) return null;
      const seats = d.seating?.seats.filter((s) => classKey(s.name) !== gone);
      // their seat goes with them; what they built stays the class's
      return { ...d, students: d.students.filter((s) => classKey(s.name) !== gone), seating: d.seating && seats && seats.length > 0 ? { ...d.seating, seats } : undefined };
    }
    case "password": {
      const { hash, salt } = hashPassword(op.password);
      return { ...d, passHash: hash, salt };
    }
    case "settings": {
      const now = d.settings, pick = (next: boolean | undefined, old: boolean | undefined) => next ?? old === true;
      const plantsLocked = pick(op.plantsLocked, now.plantsLocked), petsOff = pick(op.petsOff, now.petsOff);
      return {
        ...d,
        // (the two newer switches are written only while ON, as the class itself writes them)
        settings: { chatLocked: pick(op.chatLocked, now.chatLocked), buildLocked: pick(op.buildLocked, now.buildLocked), tapsLocked: pick(op.tapsLocked, now.tapsLocked),
          ...(plantsLocked ? { plantsLocked: true } : {}), ...(petsOff ? { petsOff: true } : {}) },
      };
    }
    case "reset-field":
      // what 들판 비우기 clears in a lesson: blocks, furniture, power plants (the seating stays)
      return { ...d, edits: [], furniture: [], plants: undefined };
    case "clear-seats":
      return { ...d, seating: undefined };
  }
}
