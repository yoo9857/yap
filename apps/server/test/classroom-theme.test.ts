// Learning themes (protocol v17): a class is the sandbox by default, or the fire drill — whose
// field is the drill's school, stamped by the server and closed to every edit.
import { describe, expect, it } from "vitest";
import { classServerSchema, decodeClassClient, fireSchool, CLASS_PROTOCOL_VERSION, type ClassEdit, type ClassServerMessage } from "@robo/shared";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { hashPassword, readSaved } from "../src/classroom/classStore.js";

const { hash, salt } = hashPassword("1234");
const AUTH = { passHash: hash, salt };

class Peer implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  send(msg: ClassServerMessage): void { this.inbox.push(msg); }
  close(): void {}
  last<T extends ClassServerMessage["t"]>(t: T): Extract<ClassServerMessage, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ClassServerMessage, { t: T }> | undefined;
  }
  world(): ClassEdit[] {
    return this.inbox.flatMap((m) => (m.t === "s-k-world" ? m.edits : []));
  }
}

const sorted = (edits: readonly ClassEdit[]) => [...edits].map((e) => e.join(",")).sort();

function fireClass() {
  const room = new ClassRoom("Ms Kim", AUTH, undefined, "Fire", { theme: "fire" });
  const teacher = new Peer(), student = new Peer();
  room.hostTeacher(teacher);
  room.joinStudent(student, "Ara");
  return { room, teacher, student };
}

describe("a fire-drill class", () => {
  it("opens on the drill's school, and says so in the welcome", () => {
    const { teacher, student } = fireClass();
    const school = fireSchool();
    for (const peer of [teacher, student]) {
      const welcome = peer.last("s-k-welcome")!;
      expect(welcome.theme).toBe("fire");
      expect(welcome.editCount).toBe(school.edits.length);
      expect(welcome.furniture).toEqual(school.furniture);
      expect(sorted(peer.world())).toEqual(sorted(school.edits));
      expect(classServerSchema.safeParse(welcome).success).toBe(true);
    }
  });

  it("refuses every change to its field — the teacher's too", () => {
    const { room, teacher, student } = fireClass();
    const school = fireSchool();
    const wall = school.edits[0]!; // the Blender campus clears this old voxel-ground cell
    for (const peer of [teacher, student]) {
      peer.inbox = [];
      room.handle(peer, { t: "k-edit", edits: [[wall[0], wall[1], wall[2], 3, 0], [40, 4, 40, 3, 0]] });
      // the sender is handed the cells as they are; nobody else hears anything
      expect(peer.last("s-k-reject")!.edits).toEqual([wall, [40, 4, 40, 0, 0]]);
      room.handle(peer, { t: "k-furniture", placed: [["chair", 40, 4, 40, 0, 0]], removed: [["chair", 0, 4, 0, 0, 0]] });
      expect(peer.last("s-k-furniture")).toMatchObject({ rejected: true, furniture: school.furniture });
      room.handle(peer, { t: "k-plant", op: "lay", kind: "wind", x: 40, y: 4, z: 40, rot: 0 });
      expect(peer.last("s-k-plants")!.plants).toEqual([]);
    }
    expect(student.inbox.some((m) => m.t === "s-k-edit")).toBe(false);
    room.handle(teacher, { t: "k-reset-world" });
    room.handle(teacher, { t: "k-drain-water" });
    expect(student.inbox.some((m) => m.t === "s-k-world-reset" || m.t === "s-k-water-drained")).toBe(false);
    expect(room.editCount).toBe(school.edits.length);
  });

  it("keeps the lesson tools: chat, freeze and announcements work as in any class", () => {
    const { room, teacher, student } = fireClass();
    room.handle(teacher, { t: "k-lesson", freeze: true });
    expect(student.last("s-k-lesson")!.frozen).toBe(true);
    room.handle(teacher, { t: "k-announce", text: "운동장으로!" });
    expect(student.last("s-k-announce")!.text).toBe("운동장으로!");
  });

  it("stores its theme and none of its field; restored, it is today's school again", () => {
    const { room } = fireClass();
    const saved = room.toSaved();
    expect(saved).toMatchObject({ theme: "fire", edits: [], furniture: [] });
    // through the store's reader (a JSON round trip), as after a restart
    const read = readSaved(JSON.parse(JSON.stringify(saved)))!;
    expect(read.theme).toBe("fire");
    // …whatever cells the save holds (they are the class's sandbox, not shown in a fire lesson).
    // Opened with no pick it is the lesson it had last; what a teacher PICKS decides (see the last suite).
    const back = new ClassRoom(read.teacherName, AUTH, { ...read, edits: [[0, 30, 0, 3, 0]] });
    expect(back.theme).toBe("fire");
    const teacher = new Peer();
    expect(back.hostTeacher(teacher, { password: "1234" })).toBe("ok");
    expect(sorted(teacher.world())).toEqual(sorted(fireSchool().edits));
    expect(teacher.last("s-k-welcome")!.furniture).toEqual(fireSchool().furniture);
  });
});

describe("the sandbox stays what it was", () => {
  it("has no theme on the wire or in the save, and takes edits", () => {
    const room = new ClassRoom("Ms Kim", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    expect(room.theme).toBe("craft");
    expect("theme" in teacher.last("s-k-welcome")!).toBe(false);
    room.handle(teacher, { t: "k-edit", edits: [[2, 4, 2, 3, 0]] });
    const saved = room.toSaved();
    expect("theme" in saved).toBe(false);
    expect(saved.edits).toEqual([[2, 4, 2, 3, 0]]);
    // a row from before themes (or with a damaged one) reads as the sandbox
    expect(readSaved(JSON.parse(JSON.stringify({ ...saved, theme: "lava" })))!.theme).toBeUndefined();
    expect(new ClassRoom("Ms Kim", AUTH, readSaved(JSON.parse(JSON.stringify(saved)))!).theme).toBe("craft");
  });

  it("k-host carries the theme only when asked; an unknown one is refused by the schema", () => {
    const host = (extra: object) => decodeClassClient(JSON.stringify({ t: "k-host", v: CLASS_PROTOCOL_VERSION, room: "R", teacher: "T", password: "1234", ...extra }));
    expect(host({})).toMatchObject({ t: "k-host" });
    expect(host({ theme: "fire" })).toMatchObject({ theme: "fire" });
    expect(host({ theme: "lava" })).toBeNull();
  });
});

describe("the fire drill, run by the teacher", () => {
  /** A fire class with `n` students online, named so that name order is S01, S02, … */
  function drillClass(n: number) {
    const room = new ClassRoom("Ms Kim", AUTH, undefined, "Fire", { theme: "fire" });
    const teacher = new Peer();
    room.hostTeacher(teacher);
    const students = Array.from({ length: n }, (_, i) => {
      const peer = new Peer();
      room.joinStudent(peer, `S${String(i + 1).padStart(2, "0")}`);
      return peer;
    });
    const teamsOf = (peer: Peer) => new Map(peer.last("s-k-drill")!.teams);
    const sizes = (peer: Peer) => {
      const count = new Map<number, number>();
      for (const team of teamsOf(peer).values()) count.set(team, (count.get(team) ?? 0) + 1);
      return [...count.values()].sort((a, b) => b - a); // biggest first: which team is the bigger one does not matter
    };
    return { room, teacher, students, teamsOf, sizes };
  }

  it("starts in the briefing: everyone is told nobody is set off", () => {
    const { teacher, students } = drillClass(3);
    for (const peer of [teacher, ...students]) {
      expect(peer.last("s-k-drill")).toMatchObject({ size: 0, teams: [], go: [], run: 0, reports: [] });
      expect(classServerSchema.safeParse(peer.last("s-k-drill")).success).toBe(true);
    }
  });

  it("forms even teams in name order — never one child alone", () => {
    const { room, teacher, students, teamsOf, sizes } = drillClass(21);
    room.handle(teacher, { t: "k-drill", op: "teams", size: 5 });
    expect(sizes(students[0]!)).toEqual([5, 4, 4, 4, 4]);
    const teams = teamsOf(students[0]!);
    expect(teams.get("S01")).toBe(1);
    expect(teams.get("S05")).toBe(1);
    expect(teams.get("S21")).toBe(5);
    room.handle(teacher, { t: "k-drill", op: "teams", size: 4 });
    expect(sizes(students[0]!)).toEqual([4, 4, 4, 3, 3, 3]);
    // exactly divisible: full teams
    const even = drillClass(8);
    even.room.handle(even.teacher, { t: "k-drill", op: "teams", size: 4 });
    expect(even.sizes(even.teacher)).toEqual([4, 4]);
    // and taken away again
    even.room.handle(even.teacher, { t: "k-drill", op: "teams", size: 0 });
    expect(even.teacher.last("s-k-drill")).toMatchObject({ size: 0, teams: [] });
  });

  it("sets teams off one at a time, or everyone at once", () => {
    const { room, teacher, students } = drillClass(8);
    room.handle(teacher, { t: "k-drill", op: "teams", size: 4 });
    const run = students[0]!.last("s-k-drill")!.run;
    room.handle(teacher, { t: "k-drill", op: "start", team: 2 });
    expect(students[0]!.last("s-k-drill")).toMatchObject({ go: [2], run });
    room.handle(teacher, { t: "k-drill", op: "start", team: 2 }); // twice is once
    room.handle(teacher, { t: "k-drill", op: "start", team: 1 });
    expect(students[0]!.last("s-k-drill")!.go).toEqual([2, 1]);
    // a team that does not exist means everyone
    const all = drillClass(3);
    all.room.handle(all.teacher, { t: "k-drill", op: "start", team: 9 });
    expect(all.students[0]!.last("s-k-drill")!.go).toEqual([0]);
  });

  it("gathers progress for the board, and stop puts everyone back to the briefing", () => {
    const { room, teacher, students } = drillClass(2);
    room.handle(teacher, { t: "k-drill", op: "start" });
    room.handle(students[0]!, { t: "k-drill-report", step: 3 });
    room.handle(students[1]!, { t: "k-drill-report", step: 7, stars: 3, seconds: 95 });
    expect(teacher.last("s-k-drill")!.reports).toEqual([{ name: "S01", step: 3 }, { name: "S02", step: 7, stars: 3, seconds: 95 }]);
    const run = teacher.last("s-k-drill")!.run;
    room.handle(teacher, { t: "k-drill", op: "stop" });
    expect(students[0]!.last("s-k-drill")).toMatchObject({ go: [], reports: [], run: run + 1 });
  });

  it("is the teacher's to run; a late student joins the smallest team and is told the state", () => {
    const { room, teacher, students, teamsOf } = drillClass(7);
    room.handle(students[0]!, { t: "k-drill", op: "start" });
    expect(teacher.last("s-k-drill")!.go).toEqual([]);
    room.handle(teacher, { t: "k-drill", op: "teams", size: 4 }); // 4 + 3
    room.handle(teacher, { t: "k-drill", op: "start", team: 2 });
    const late = new Peer();
    room.joinStudent(late, "Zed");
    expect(teamsOf(late).get("Zed")).toBe(2); // the team of three
    expect(late.last("s-k-drill")!.go).toEqual([2]); // …which is already off
    expect(teamsOf(teacher).get("Zed")).toBe(2); // everyone knows
    // a ninth child finds both teams full: a team of their own
    const ninth = new Peer();
    room.joinStudent(ninth, "Zoe");
    expect(teamsOf(ninth).get("Zoe")).toBe(3);
  });

  it("survives a restart (teams, who is off, the run) and ends with the lesson", () => {
    const { room, teacher } = drillClass(8);
    room.handle(teacher, { t: "k-drill", op: "teams", size: 4 });
    room.handle(teacher, { t: "k-drill", op: "start", team: 1 });
    const saved = readSaved(JSON.parse(JSON.stringify(room.toSaved())))!;
    expect(saved.drill).toMatchObject({ size: 4, go: [1] });
    const back = new ClassRoom(saved.teacherName, AUTH, saved);
    const again = new Peer();
    back.hostTeacher(again, { password: "1234" });
    expect(again.last("s-k-drill")).toMatchObject({ size: 4, go: [1], run: saved.drill!.run });
    expect(again.last("s-k-drill")!.teams).toHaveLength(8);
    back.close();
    expect(back.toSaved().drill).toMatchObject({ size: 0, teams: [], go: [] });
  });

  it("means nothing in a sandbox class", () => {
    const room = new ClassRoom("Ms Kim", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    room.handle(teacher, { t: "k-drill", op: "start" });
    room.handle(teacher, { t: "k-drill-report", step: 2 });
    expect(teacher.last("s-k-drill")).toBeUndefined();
  });
});

// The bug of 2026-11-13: teachers picked the fire drill for the class name they always use — a
// class that already existed as a sandbox — and got the sandbox.
describe("the lesson is what the teacher picks, every time the class is opened", () => {
  function sandboxWithABuild() {
    const room = new ClassRoom("Ms Kim", AUTH, undefined, "3-2");
    const teacher = new Peer();
    room.hostTeacher(teacher);
    room.joinStudent(new Peer(), "Ara");
    room.handle(teacher, { t: "k-edit", edits: [[100, 4, 100, 3, 0], [101, 4, 100, 3, 0]] });
    return readSaved(JSON.parse(JSON.stringify(room.toSaved())))!;
  }

  it("an existing sandbox class opened as a fire drill IS the fire drill", () => {
    const saved = sandboxWithABuild();
    expect(saved.edits.length).toBe(2);
    const room = new ClassRoom(saved.teacherName, AUTH, saved, undefined, { theme: "fire" });
    expect(room.theme).toBe("fire");
    const teacher = new Peer();
    room.hostTeacher(teacher, { hostKey: saved.teacherKey });
    expect(teacher.last("s-k-welcome")!.theme).toBe("fire");
    expect(sorted(teacher.world())).toEqual(sorted(fireSchool().edits)); // the school, not the class's blocks
    expect(teacher.last("s-k-drill")).toMatchObject({ size: 0, go: [] }); // …in its briefing
  });

  it("the class's building is kept under the fire lesson, and is there again at the next sandbox lesson", () => {
    const saved = sandboxWithABuild();
    const fire = new ClassRoom(saved.teacherName, AUTH, saved, undefined, { theme: "fire" });
    const teacher = new Peer();
    fire.hostTeacher(teacher, { hostKey: saved.teacherKey });
    fire.joinStudent(new Peer(), "Bo"); // someone new joins during the drill
    fire.handle(teacher, { t: "k-drill", op: "start" });
    const during = readSaved(JSON.parse(JSON.stringify(fire.toSaved())))!;
    expect(during.theme).toBe("fire");
    expect(sorted(during.edits)).toEqual(sorted(saved.edits)); // untouched
    expect(during.students.map((x) => x.name).sort()).toEqual(["Ara", "Bo"]);

    const back = new ClassRoom(during.teacherName, AUTH, during, undefined, { theme: "craft" });
    expect(back.theme).toBe("craft");
    const again = new Peer();
    back.hostTeacher(again, { hostKey: during.teacherKey });
    expect(again.last("s-k-welcome")!.theme).toBeUndefined();
    expect(sorted(again.world())).toEqual(sorted(saved.edits));
    expect(again.last("s-k-drill")).toBeUndefined(); // the drill belongs to the fire lesson
  });

  it("no pick (an older client, a reconnect) opens the lesson the class had last", () => {
    const saved = sandboxWithABuild();
    expect(new ClassRoom(saved.teacherName, AUTH, saved).theme).toBe("craft");
    const fire = readSaved(JSON.parse(JSON.stringify(new ClassRoom(saved.teacherName, AUTH, saved, undefined, { theme: "fire" }).toSaved())))!;
    expect(new ClassRoom(fire.teacherName, AUTH, fire).theme).toBe("fire");
  });
});

describe("the teacher's quiz (protocol v19)", () => {
  function quizClass() {
    const room = new ClassRoom("Ms Kim", AUTH, undefined, "Fire", { theme: "fire" });
    const teacher = new Peer(), a = new Peer(), b = new Peer();
    room.hostTeacher(teacher);
    room.joinStudent(a, "Ara");
    room.joinStudent(b, "Bo");
    return { room, teacher, a, b };
  }

  it("is started by the teacher for everyone, each one with a number of its own", () => {
    const { room, teacher, a } = quizClass();
    expect(a.last("s-k-drill")!.quiz).toBeUndefined();
    room.handle(a, { t: "k-drill", op: "quiz" }); // a student cannot
    expect(a.last("s-k-drill")!.quiz).toBeUndefined();
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    expect(a.last("s-k-drill")!.quiz).toBe(1);
    expect(classServerSchema.safeParse(a.last("s-k-drill")).success).toBe(true);
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    expect(a.last("s-k-drill")!.quiz).toBe(2);
  });

  it("gathers everyone's answers for the board; a new quiz wipes the last one's", () => {
    const { room, teacher, a, b } = quizClass();
    room.handle(a, { t: "k-drill-report", step: 0, quiz: 2, quizScore: 2 }); // no quiz is being asked: not counted
    expect(teacher.last("s-k-drill")!.reports.find((r) => r.name === "Ara")?.quiz).toBeUndefined();
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    room.handle(a, { t: "k-drill-report", step: 0, quiz: 3, quizScore: 2 });
    room.handle(b, { t: "k-drill-report", step: 0, quiz: 5, quizScore: 5 });
    const reports = teacher.last("s-k-drill")!.reports;
    expect(reports.find((r) => r.name === "Ara")).toMatchObject({ quiz: 3, quizScore: 2 });
    expect(reports.find((r) => r.name === "Bo")).toMatchObject({ quiz: 5, quizScore: 5 });
    // a drill step reported later keeps the quiz's score beside it
    room.handle(a, { t: "k-drill-report", step: 2 });
    expect(teacher.last("s-k-drill")!.reports.find((r) => r.name === "Ara")).toMatchObject({ step: 2, quiz: 3, quizScore: 2 });
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    expect(teacher.last("s-k-drill")!.reports.every((r) => r.quiz === undefined)).toBe(true);
  });

  it("keeps what the drill earned, and never counts answers backwards (a refreshed page reports from 0 again)", () => {
    const { room, teacher, a } = quizClass();
    const ara = () => teacher.last("s-k-drill")!.reports.find((r) => r.name === "Ara")!;
    room.handle(a, { t: "k-drill-report", step: 6, stars: 3, seconds: 95 }); // the drill is done
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    room.handle(a, { t: "k-drill-report", step: 6, quiz: 4, quizScore: 3 });
    expect(ara()).toMatchObject({ step: 6, stars: 3, seconds: 95, quiz: 4, quizScore: 3 }); // the stars are still on the board
    room.handle(a, { t: "k-drill-report", step: 6, quiz: 0, quizScore: 0 }); // the page was refreshed
    expect(ara()).toMatchObject({ stars: 3, quiz: 4, quizScore: 3 });
    room.handle(a, { t: "k-drill-report", step: 6, quiz: 5, quizScore: 4 });
    expect(ara()).toMatchObject({ quiz: 5, quizScore: 4 });
    // a drill started again reports its step without stars: those do go
    room.handle(a, { t: "k-drill-report", step: 0 });
    expect(ara().stars).toBeUndefined();
    expect(ara()).toMatchObject({ step: 0, quiz: 5, quizScore: 4 });
  });

  it("is ended by the teacher (the scores stay on the board), and ends with a stop", () => {
    const { room, teacher, a } = quizClass();
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    room.handle(a, { t: "k-drill-report", step: 0, quiz: 5, quizScore: 4 });
    room.handle(teacher, { t: "k-drill", op: "quiz-stop" });
    expect(a.last("s-k-drill")!.quiz).toBeUndefined();
    expect(a.last("s-k-drill")!.reports.find((r) => r.name === "Ara")).toMatchObject({ quiz: 5, quizScore: 4 });
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    room.handle(teacher, { t: "k-drill", op: "stop" });
    expect(a.last("s-k-drill")).toMatchObject({ reports: [] });
    expect(a.last("s-k-drill")!.quiz).toBeUndefined();
  });

  it("a student who joins while it is asked gets it too", () => {
    const { room, teacher } = quizClass();
    room.handle(teacher, { t: "k-drill", op: "quiz" });
    const late = new Peer();
    room.joinStudent(late, "Cy");
    expect(late.last("s-k-drill")!.quiz).toBe(1);
  });
});
