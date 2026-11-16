import { DataType, newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { MemorySiteStore, siteStoreOn, type SiteStore, type Teacher } from "../src/site/siteStore.js";

/**
 * The site's store kept to one contract by two implementations: memory (dev, the API's tests) and
 * PostgreSQL. The PostgreSQL one runs its REAL SQL here, on an in-process PostgreSQL (pg-mem) —
 * a wrong column, a bad ON CONFLICT or a broken COALESCE fails this file, not production.
 * (pg-mem is an emulator: the first run against a real server is still worth a look; the deploy's
 * runbook in docs/ACCOUNTS.md has that check.)
 */
const pg = async (): Promise<SiteStore> => {
  const db = newDb();
  // the emulator has few built-in functions; the schema's CHECKs use length()
  db.public.registerFunction({ name: "length", args: [DataType.text], returns: DataType.integer, implementation: (v: string) => v.length });
  const { Pool } = db.adapters.createPg() as { Pool: new () => import("pg").Pool };
  return siteStoreOn(new Pool());
};
const teacher = (email: string): Omit<Teacher, "id"> => ({ email, name: "김선생", school: "호원초등학교", passHash: "ab".repeat(32), salt: "s1", status: "active", createdAt: 1000, lastLoginAt: 1000 });

for (const [name, make] of [["memory", () => Promise.resolve<SiteStore>(new MemorySiteStore())], ["postgresql", pg]] as const) {
  describe(`the site store (${name})`, () => {
    it("keeps a teacher, finds them by e-mail and id, and refuses the e-mail twice", async () => {
      const s = await make();
      const made = (await s.addTeacher(teacher("kim@school.kr")))!;
      expect(made.id).toBeGreaterThan(0);
      expect(await s.teacherByEmail("kim@school.kr")).toMatchObject({ id: made.id, name: "김선생", status: "active", createdAt: 1000 });
      expect((await s.teacherById(made.id))?.email).toBe("kim@school.kr");
      expect(await s.addTeacher(teacher("kim@school.kr"))).toBeNull();
      expect(await s.teacherByEmail("nobody@school.kr")).toBeNull();
      expect(await s.listTeachers()).toHaveLength(1);
    });

    it("records a sign-in, disables and enables", async () => {
      const s = await make();
      const t = (await s.addTeacher(teacher("lee@school.kr")))!;
      await s.touchTeacher(t.id, 5000);
      expect((await s.teacherById(t.id))?.lastLoginAt).toBe(5000);
      expect(await s.setTeacherStatus(t.id, "disabled")).toBe(true);
      expect((await s.teacherById(t.id))?.status).toBe("disabled");
      expect(await s.setTeacherStatus(9999, "disabled")).toBe(false);
    });

    it("keeps sessions by their hash, drops one, a teacher's, and the expired", async () => {
      const s = await make();
      await s.addSession({ tokenHash: "h1", kind: "teacher", teacherId: 7, createdAt: 1, expiresAt: 100 });
      await s.addSession({ tokenHash: "h2", kind: "teacher", teacherId: 7, createdAt: 1, expiresAt: 900 });
      await s.addSession({ tokenHash: "h3", kind: "admin", teacherId: 0, createdAt: 1, expiresAt: 900 });
      expect(await s.session("h1")).toMatchObject({ kind: "teacher", teacherId: 7, expiresAt: 100 });
      expect((await s.session("h3"))?.kind).toBe("admin");
      await s.purgeSessions(500);
      expect(await s.session("h1")).toBeNull();
      await s.dropTeacherSessions(7);
      expect(await s.session("h2")).toBeNull();
      expect(await s.session("h3")).not.toBeNull(); // the operator's is not a teacher's
      await s.dropSession("h3");
      expect(await s.session("h3")).toBeNull();
    });

    it("deleting a teacher takes the account and its sessions", async () => {
      const s = await make();
      const t = (await s.addTeacher(teacher("park@school.kr")))!;
      await s.addSession({ tokenHash: "hx", kind: "teacher", teacherId: t.id, createdAt: 1, expiresAt: 900 });
      await s.deleteTeacher(t.id);
      expect(await s.teacherById(t.id)).toBeNull();
      expect(await s.session("hx")).toBeNull();
      expect(await s.addTeacher(teacher("park@school.kr"))).not.toBeNull(); // the e-mail is free again
    });

    it("keeps an inquiry and changes only what a patch names", async () => {
      const s = await make();
      const made = await s.addInquiry({ code: "ABCD2345", school: "한빛초", name: "박선생", contact: "010", message: "문의합니다", passHash: "cd".repeat(32), salt: "s2", status: "new", reply: "", note: "", createdAt: 2000, repliedAt: 0 });
      expect(await s.inquiryByCode("ABCD2345")).toMatchObject({ id: made.id, status: "new", message: "문의합니다" });
      expect(await s.updateInquiry(made.id, { note: "전화 선호" })).toMatchObject({ note: "전화 선호", status: "new", reply: "" });
      expect(await s.updateInquiry(made.id, { reply: "연락드리겠습니다", status: "answered", repliedAt: 3000 })).toMatchObject({ note: "전화 선호", status: "answered", reply: "연락드리겠습니다", repliedAt: 3000 });
      expect(await s.updateInquiry(9999, { note: "x" })).toBeNull();
      expect(await s.inquiryByCode("ZZZZZZZZ")).toBeNull();
      expect((await s.listInquiries())[0]?.code).toBe("ABCD2345");
    });

    it("keeps the record, newest first", async () => {
      const s = await make();
      await s.audit({ at: 1, what: "signup", teacherId: 3, ip: "10.0.0.1" });
      await s.audit({ at: 2, what: "login", teacherId: 3, ip: "10.0.0.1" });
      expect((await s.listAudit(10)).map((e) => e.what)).toEqual(["login", "signup"]);
      expect(await s.listAudit(1)).toHaveLength(1);
    });
  });
}
