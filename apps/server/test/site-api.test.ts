/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the API's answers are read field by field as loose JSON */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSiteApi } from "../src/site/siteApi.js";
import { MemorySiteStore } from "../src/site/siteStore.js";

/**
 * The site's API over real HTTP: teachers' accounts, schools' inquiries, the operator's admin.
 * What must hold: nobody reads or changes what is not theirs, guesses are limited, and an answer
 * tells no more than its page needs. (The PostgreSQL store's own SQL: test/site-store-pg.test.ts,
 * run when TEST_DATABASE_URL names a database.)
 */
let server: Server | null = null;
const stop = () => new Promise<void>((done) => (server ? server.close(() => { server = null; done(); }) : done()));
afterEach(stop);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers of many shapes, read field by field

async function start(adminPassword = "operator-secret", store: MemorySiteStore | null = new MemorySiteStore()) {
  let clock = 1_700_000_000_000;
  const api = createSiteApi(store, { adminPassword, pepper: "p".repeat(40), now: () => clock });
  server = createServer((req, res) => api(req, res));
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new Map<string, string>();
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0]!, at = pair.indexOf("=");
      if (pair.slice(at + 1)) jar.set(pair.slice(0, at), pair.slice(at + 1));
      else jar.delete(pair.slice(0, at));
    }
    return { status: res.status, cookies: res.headers.getSetCookie(), json: (await res.json()) as Json };
  };
  return { store: store!, call, jar, tick: (ms: number) => { clock += ms; } };
}
const teacher = { email: "Kim@School.kr", name: "김선생", school: "호원초등학교", password: "blocks-and-bricks" };
const inquiry = { school: "한빛초등학교", name: "박선생", contact: "010-0000-0000", message: "3학년 두 반에서 써 보고 싶습니다.", password: "1234" };

describe("teachers' accounts", () => {
  it("signs up, stays signed in by cookie, signs out", async () => {
    const s = await start();
    const made = await s.call("POST", "/api/teacher/signup", teacher);
    expect(made.status).toBe(201);
    expect(made.json.teacher).toMatchObject({ email: "kim@school.kr", name: "김선생", school: "호원초등학교" });
    expect(made.cookies[0]).toMatch(/^cy_teacher=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect((await s.call("GET", "/api/teacher/me")).json.teacher.name).toBe("김선생");
    await s.call("POST", "/api/teacher/logout", {});
    expect((await s.call("GET", "/api/teacher/me")).json.teacher).toBeNull();
  });

  it("stores no password and no cookie token", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    expect(JSON.stringify(await s.store.listTeachers())).not.toContain(teacher.password);
    expect(await s.store.session(s.jar.get("cy_teacher")!)).toBeNull(); // the token itself is not the key
  });

  it("a password hashed under one pepper is wrong under another (the database alone is not enough)", async () => {
    const store = new MemorySiteStore();
    const s = await start("operator-secret", store);
    await s.call("POST", "/api/teacher/signup", teacher);
    await stop();
    const other = createSiteApi(store, { pepper: "q".repeat(40) });
    server = createServer((req, res) => other(req, res));
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/teacher/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: teacher.email, password: teacher.password }) });
    expect(res.status).toBe(401);
  });

  it("refuses a second account for the same e-mail, whatever its case", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    expect((await s.call("POST", "/api/teacher/signup", { ...teacher, email: "KIM@school.kr" })).status).toBe(409);
  });

  it("refuses short passwords and bad e-mails, and says which", async () => {
    const s = await start();
    expect((await s.call("POST", "/api/teacher/signup", { ...teacher, password: "short" })).json.error).toBe("password");
    expect((await s.call("POST", "/api/teacher/signup", { ...teacher, email: "not-an-address" })).json.error).toBe("email");
  });

  it("answers a wrong password and an unknown e-mail alike", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    s.jar.clear();
    const wrong = await s.call("POST", "/api/teacher/login", { email: teacher.email, password: "not-the-password" });
    const unknown = await s.call("POST", "/api/teacher/login", { email: "nobody@school.kr", password: "not-the-password" });
    expect([wrong.status, wrong.json]).toEqual([unknown.status, unknown.json]);
    expect((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: teacher.password })).status).toBe(200);
  });

  it("limits guesses at one account, then lets the owner back in when the window has passed", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    const tries = [];
    for (let i = 0; i < 10; i++) tries.push((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: `guess-${i}` })).status);
    expect(tries.slice(0, 8).every((x) => x === 401)).toBe(true);
    expect(tries.slice(8)).toEqual([429, 429]);
    expect((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: teacher.password })).status).toBe(429); // even the right one, until the window passes
    s.tick(16 * 60_000);
    expect((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: teacher.password })).status).toBe(200);
  });

  it("ends a session when its time is up", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    s.tick(31 * 86_400_000);
    expect((await s.call("GET", "/api/teacher/me")).json.teacher).toBeNull();
  });

  it("deletes the account only with the password again, and then it is gone", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    expect((await s.call("POST", "/api/teacher/delete", { password: "not-it" })).status).toBe(401);
    expect((await s.call("POST", "/api/teacher/delete", { password: teacher.password })).status).toBe(200);
    expect(await s.store.listTeachers()).toHaveLength(0);
    expect((await s.call("GET", "/api/teacher/me")).json.teacher).toBeNull();
    expect((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: teacher.password })).status).toBe(401);
  });

  it("refuses a changing request sent from another site's page", async () => {
    const s = await start();
    expect((await s.call("POST", "/api/teacher/signup", teacher, { origin: "https://evil.example" })).status).toBe(403);
    expect(await s.store.listTeachers()).toHaveLength(0);
  });

  it("refuses a body that is not JSON or is too large", async () => {
    const s = await start();
    expect((await s.call("POST", "/api/teacher/login", undefined)).status).toBe(400);
    expect((await s.call("POST", "/api/teacher/signup", { ...teacher, name: "x".repeat(20_000) })).status).toBe(413);
  });

  it("keeps a record of sign-ups, sign-ins and refusals — without passwords", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    await s.call("POST", "/api/teacher/login", { email: teacher.email, password: "not-the-password" });
    const events = await s.store.listAudit(10);
    expect(events.map((e) => e.what)).toEqual(["login-refused", "signup"]);
    expect(JSON.stringify(events)).not.toMatch(/password|blocks-and-bricks/);
  });
});

describe("inquiries", () => {
  it("gives a code; the code and the sender's password open it, nothing else does", async () => {
    const s = await start();
    const sent = await s.call("POST", "/api/inquiry", inquiry);
    expect(sent.status).toBe(201);
    expect(sent.json.code).toMatch(/^[A-Z0-9]{8}$/);
    const seen = await s.call("POST", "/api/inquiry/view", { code: String(sent.json.code).toLowerCase(), password: "1234" });
    expect(seen.json.inquiry).toMatchObject({ school: "한빛초등학교", status: "received", reply: "" });
    expect(seen.json.inquiry.contact).toBeUndefined(); // not echoed back
    const wrong = await s.call("POST", "/api/inquiry/view", { code: sent.json.code, password: "0000" });
    const unknown = await s.call("POST", "/api/inquiry/view", { code: "ZZZZZZZZ", password: "1234" });
    expect([wrong.status, wrong.json]).toEqual([404, unknown.json]);
  });

  it("keeps nothing a script sent (the hidden field), but answers as if it had", async () => {
    const s = await start();
    expect((await s.call("POST", "/api/inquiry", { ...inquiry, website: "http://spam.example" })).status).toBe(201);
    expect(await s.store.listInquiries()).toHaveLength(0);
  });

  it("limits how many one address may send", async () => {
    const s = await start();
    const sent = [];
    for (let i = 0; i < 6; i++) sent.push((await s.call("POST", "/api/inquiry", inquiry)).status);
    expect(sent).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("the operator's admin", () => {
  it("is closed to everyone without the password", async () => {
    const s = await start();
    for (const path of ["/api/admin/inquiries", "/api/admin/teachers", "/api/admin/audit"]) expect((await s.call("GET", path)).status).toBe(401);
    expect((await s.call("POST", "/api/admin/inquiry", { id: 1, reply: "x" })).status).toBe(401);
    expect((await s.call("POST", "/api/admin/teacher", { id: 1, status: "disabled" })).status).toBe(401);
    expect((await s.call("POST", "/api/admin/login", { password: "guess" })).status).toBe(401);
  });

  it("is closed altogether when no password is set", async () => {
    const s = await start("");
    expect((await s.call("POST", "/api/admin/login", { password: "anything" })).status).toBe(503);
    expect((await s.call("GET", "/api/admin/me")).json).toEqual({ admin: false, open: false });
  });

  it("a teacher's session is not an admin's", async () => {
    const s = await start();
    await s.call("POST", "/api/teacher/signup", teacher);
    s.jar.set("cy_admin", s.jar.get("cy_teacher")!);
    expect((await s.call("GET", "/api/admin/inquiries")).status).toBe(401);
  });

  it("reads inquiries, answers one, and the sender sees the answer", async () => {
    const s = await start();
    const code = (await s.call("POST", "/api/inquiry", inquiry)).json.code as string;
    expect((await s.call("POST", "/api/admin/login", { password: "operator-secret" })).status).toBe(200);
    const list = (await s.call("GET", "/api/admin/inquiries")).json.inquiries as Json[];
    expect(list[0]).toMatchObject({ code, contact: "010-0000-0000", status: "new" });
    expect(JSON.stringify(list)).not.toMatch(/passHash|salt/);
    const answered = await s.call("POST", "/api/admin/inquiry", { id: list[0]!.id, reply: "다음 주에 연락드리겠습니다.", note: "전화 선호" });
    expect(answered.json.inquiry).toMatchObject({ status: "answered", reply: "다음 주에 연락드리겠습니다." });
    const seen = (await s.call("POST", "/api/inquiry/view", { code, password: "1234" })).json.inquiry as Json;
    expect(seen).toMatchObject({ status: "answered", reply: "다음 주에 연락드리겠습니다." });
    expect(JSON.stringify(seen)).not.toContain("전화 선호"); // the operator's note stays the operator's
  });

  it("limits password guesses", async () => {
    const s = await start();
    const tries = [];
    for (let i = 0; i < 7; i++) tries.push((await s.call("POST", "/api/admin/login", { password: `guess-${i}` })).status);
    expect(tries).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("a disabled teacher is signed out at once and cannot sign in", async () => {
    const s = await start();
    const id = (await s.call("POST", "/api/teacher/signup", teacher)).json.teacher.id as number;
    const teacherCookie = s.jar.get("cy_teacher")!;
    await s.call("POST", "/api/admin/login", { password: "operator-secret" });
    expect(((await s.call("GET", "/api/admin/teachers")).json.teachers as Json[])[0]).toMatchObject({ id, status: "active" });
    await s.call("POST", "/api/admin/teacher", { id, status: "disabled" });
    s.jar.set("cy_teacher", teacherCookie);
    expect((await s.call("GET", "/api/teacher/me")).json.teacher).toBeNull();
    expect((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: teacher.password })).status).toBe(403);
  });
});

describe("without its database", () => {
  it("answers 503 everywhere instead of pretending", async () => {
    const s = await start("operator-secret", null);
    expect((await s.call("GET", "/api/teacher/me")).status).toBe(503);
    expect((await s.call("POST", "/api/teacher/login", { email: teacher.email, password: teacher.password })).status).toBe(503);
  });
});
