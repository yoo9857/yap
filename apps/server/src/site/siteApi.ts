import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { log } from "../log.js";
import { clientAddress } from "../net/wsServer.js";
import type { Inquiry, InquiryPatch, Session, SiteStore, Teacher } from "./siteStore.js";
import { makeTicket, ticketKey } from "./ticket.js";

/**
 * The site's JSON API (`/api/…`), answered by the process that answers HTTP (the single server or
 * the cluster's primary — never a shard): teachers' accounts, schools' inquiries, the operator's
 * admin. Design, threats and the runbook: docs/ACCOUNTS.md.
 *
 * Rules that hold for every route:
 *  - a body is JSON, at most 16 KB, and a request that changes something must come from our own
 *    pages (the Origin header, when the browser sends one, names this host) — with SameSite=Lax
 *    cookies that is the CSRF defence;
 *  - passwords are never stored: scrypt of (password keyed with the server's PEPPER) with a salt
 *    of its own, compared in constant time, computed OFF the event loop (the primary also hands
 *    sockets to the shards). The pepper is in the environment, not in the database: a copy of the
 *    database alone cannot be searched for passwords;
 *  - the cookie holds a random token (HttpOnly, SameSite=Lax, Secure); the database only its sha256;
 *  - every way to guess is limited — per client address, and for signing in per ACCOUNT as well
 *    (a school shares one address; an attacker has many);
 *  - an answer never says more than the page needs: a wrong e-mail and a wrong password are one
 *    answer, an unknown inquiry code and a wrong inquiry password are one answer;
 *  - what changes an account or is refused is written to the record (site_audit): who, what, when,
 *    from where — never a password or a token.
 */
export interface SiteApiOptions {
  /** The operator's password (env ADMIN_PASSWORD). Unset or too short: the admin routes answer 503. */
  adminPassword?: string;
  /** Keyed into every password before hashing (env AUTH_PEPPER). Changing it makes every password wrong. */
  pepper?: string;
  /** How many game processes run (the cluster's shards): host tickets need AUTH_PEPPER when there are several. */
  processes?: number;
  now?: () => number;
}

const TEACHER_DAYS = 30, ADMIN_HOURS = 12, BODY_MAX = 16 * 1024;
const COOKIE = { teacher: "cy_teacher", admin: "cy_admin" } as const;

/** No control characters (a tab and a line break are text; a NUL or an escape is not). */
const printable = (s: string) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return false; } return true; };
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine(printable, "control characters");
const Signup = z.object({ email: z.string().trim().toLowerCase().max(120).email(), name: text(1, 30), school: text(1, 60), password: z.string().min(8).max(200) });
const Login = z.object({ email: z.string().trim().toLowerCase().max(120), password: z.string().min(1).max(200) });
const Password = z.object({ password: z.string().min(1).max(200) });
const NewInquiry = z.object({ school: text(1, 60), name: text(1, 30), contact: text(3, 80), message: text(5, 2000), password: z.string().min(4).max(100), website: z.string().max(200).optional() });
const ViewInquiry = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/), password: z.string().min(1).max(100) });
const AdminInquiry = z.object({ id: z.number().int().positive(), status: z.enum(["new", "read", "answered", "closed"]).optional(), reply: z.string().trim().max(4000).optional(), note: z.string().trim().max(2000).optional() });
const AdminTeacher = z.object({ id: z.number().int().positive(), status: z.enum(["active", "disabled"]) });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** A code a person can read back over the phone: no 0/O, 1/I/L. */
const newCode = () => Array.from(randomBytes(8), (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join("");

/** At most `max` tries per `windowMs` for one key; old keys are swept so the map cannot grow without end. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    return true;
  }
  forget(key: string): void { this.hits.delete(key); }
}

const publicTeacher = (t: Teacher) => ({ id: t.id, email: t.email, name: t.name, school: t.school });
const publicInquiry = (i: Inquiry) => ({ code: i.code, school: i.school, name: i.name, message: i.message, status: i.status === "closed" || i.status === "answered" ? i.status : "received", reply: i.reply, createdAt: i.createdAt, repliedAt: i.repliedAt });
const adminInquiry = ({ passHash: _h, salt: _s, ...rest }: Inquiry) => rest;

export type SiteApi = (req: IncomingMessage, res: ServerResponse) => void;

/** `store` null: the database could not be reached at boot — every route answers 503 instead of pretending. */
export function createSiteApi(store: SiteStore | null, options: SiteApiOptions = {}): SiteApi {
  const now = options.now ?? Date.now;
  const adminPassword = options.adminPassword && options.adminPassword.length >= 10 ? options.adminPassword : null;
  if (!adminPassword) log.warn("ADMIN_PASSWORD is unset or shorter than 10 characters: /admin/ is closed");
  const pepper = options.pepper ?? "";
  if (store?.durable && pepper.length < 32) log.warn("AUTH_PEPPER is unset or shorter than 32 characters: passwords are hashed without a pepper");
  const tickets = ticketKey(options.pepper, options.processes ?? 1);
  const limits = {
    login: new Limiter(10, 10 * 60_000), account: new Limiter(8, 15 * 60_000), signup: new Limiter(5, 60 * 60_000),
    inquiry: new Limiter(5, 60 * 60_000), view: new Limiter(20, 10 * 60_000), admin: new Limiter(5, 15 * 60_000),
  };

  const keyed = (password: string) => (pepper ? createHmac("sha256", pepper).update(password).digest("hex") : password);
  const hashOf = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(keyed(password), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
  const makeHash = async (password: string) => { const salt = randomBytes(16).toString("hex"); return { passHash: (await hashOf(password, salt)).toString("hex"), salt }; };
  const matches = async (password: string, saved: { passHash: string; salt: string }) => {
    const a = await hashOf(password, saved.salt), b = Buffer.from(saved.passHash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  /** What a missing account is compared against, so its answer takes as long as a real one's. */
  const NOBODY = { passHash: "00".repeat(32), salt: "nobody" };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff", ...headers }).end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { error });

  const cookieOf = (req: IncomingMessage, name: string): string | null => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim().slice(0, 128);
    }
    return null;
  };
  /** Secure unless plainly local (dev); nginx tells us the outer scheme. */
  const secure = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https" || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "");
  const setCookie = (req: IncomingMessage, name: string, value: string, maxAgeS: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure(req) ? "; Secure" : ""}`;

  const body = (req: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return reject(new Error("type"));
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > BODY_MAX) { reject(new Error("large")); req.resume(); } else chunks.push(c); });
    req.on("end", () => { if (size > BODY_MAX) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("json")); } });
    req.on("error", reject);
  });
  /** A changing request named by another site's page is refused (browsers always send Origin on such a POST). */
  const ours = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };

  let swept = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse, db: SiteStore): Promise<void> => {
    const path = (req.url ?? "").split("?")[0]!, ip = clientAddress(req), at = now();
    if (at - swept > 3_600_000) { swept = at; await db.purgeSessions(at); }
    const note = (what: string, teacherId = 0) => db.audit({ at, what, teacherId, ip }).catch((err) => log.error({ err, what }, "audit write failed"));

    const open = async (kind: Session["kind"], teacherId: number): Promise<string> => {
      const token = randomBytes(32).toString("hex");
      const life = kind === "admin" ? ADMIN_HOURS * 3600 : TEACHER_DAYS * 86400;
      await db.addSession({ tokenHash: sha(token), kind, teacherId, createdAt: at, expiresAt: at + life * 1000 });
      return setCookie(req, COOKIE[kind], token, life);
    };
    const sessionOf = async (kind: Session["kind"]): Promise<Session | null> => {
      const token = cookieOf(req, COOKIE[kind]);
      if (!token) return null;
      const s = await db.session(sha(token));
      if (!s || s.kind !== kind) return null;
      if (s.expiresAt <= at) { await db.dropSession(s.tokenHash); return null; }
      return s;
    };
    const teacherOf = async (): Promise<Teacher | null> => {
      const s = await sessionOf("teacher");
      const t = s ? await db.teacherById(s.teacherId) : null;
      return t && t.status === "active" ? t : null;
    };
    const close = async (kind: Session["kind"]): Promise<string> => {
      const token = cookieOf(req, COOKIE[kind]);
      if (token) await db.dropSession(sha(token));
      return setCookie(req, COOKIE[kind], "", 0);
    };

    const route = `${req.method} ${path}`;
    if (route === "GET /api/teacher/me") { const t = await teacherOf(); return send(res, 200, { teacher: t ? publicTeacher(t) : null }); }
    if (route === "GET /api/admin/me") return send(res, 200, { admin: !!(await sessionOf("admin")), open: !!adminPassword });
    if (route === "GET /api/admin/inquiries" || route === "GET /api/admin/teachers" || route === "GET /api/admin/audit") {
      if (!(await sessionOf("admin"))) return fail(res, 401, "admin");
      if (route.endsWith("inquiries")) return send(res, 200, { inquiries: (await db.listInquiries()).map(adminInquiry) });
      if (route.endsWith("audit")) return send(res, 200, { events: await db.listAudit(300) });
      return send(res, 200, { teachers: (await db.listTeachers()).map((t) => ({ ...publicTeacher(t), status: t.status, createdAt: t.createdAt, lastLoginAt: t.lastLoginAt })) });
    }
    if (req.method !== "POST") return fail(res, 404, "not-found");
    if (!ours(req)) return fail(res, 403, "origin");
    let raw: unknown;
    try { raw = await body(req); } catch (err) { return fail(res, (err as Error).message === "large" ? 413 : 400, "body"); }

    switch (path) {
      case "/api/teacher/signup": {
        if (!limits.signup.allow(ip, at)) return fail(res, 429, "slow-down");
        const p = Signup.safeParse(raw);
        if (!p.success) return fail(res, 400, p.error.issues[0]?.path[0] === "password" ? "password" : p.error.issues[0]?.path[0] === "email" ? "email" : "fields");
        const made = await db.addTeacher({ email: p.data.email, name: p.data.name, school: p.data.school, ...(await makeHash(p.data.password)), status: "active", createdAt: at, lastLoginAt: at });
        if (!made) return fail(res, 409, "taken");
        await note("signup", made.id);
        return send(res, 201, { teacher: publicTeacher(made) }, { "set-cookie": await open("teacher", made.id) });
      }
      case "/api/teacher/login": {
        const p = Login.safeParse(raw);
        // both limits are charged on every try, before the answer is known: a refused guess must cost the guesser
        const allowed = limits.login.allow(ip, at) && (!p.success || limits.account.allow(p.data.email, at));
        if (!allowed) return fail(res, 429, "slow-down");
        if (!p.success) return fail(res, 401, "wrong");
        const t = await db.teacherByEmail(p.data.email);
        const ok = await matches(p.data.password, t ?? NOBODY);
        if (!t || !ok) { await note("login-refused", t?.id ?? 0); return fail(res, 401, "wrong"); }
        if (t.status !== "active") return fail(res, 403, "disabled");
        limits.account.forget(t.email);
        await db.touchTeacher(t.id, at);
        await note("login", t.id);
        return send(res, 200, { teacher: publicTeacher(t) }, { "set-cookie": await open("teacher", t.id) });
      }
      case "/api/teacher/ticket": {
        // what the class lobby sends in k-host: this account opens the class (site/ticket.ts)
        const t = await teacherOf();
        if (!t) return fail(res, 401, "signed-out");
        if (!tickets) return fail(res, 503, "unavailable");
        return send(res, 200, { ticket: makeTicket(tickets, t.id, at), teacher: publicTeacher(t) });
      }
      case "/api/teacher/logout": {
        const t = await teacherOf();
        if (t) await note("logout", t.id);
        return send(res, 200, { ok: true }, { "set-cookie": await close("teacher") });
      }
      case "/api/teacher/delete": {
        // leaving is the teacher's right, and takes the password again (a borrowed, signed-in browser is not enough)
        const t = await teacherOf();
        if (!t) return fail(res, 401, "signed-out");
        if (!limits.account.allow(t.email, at)) return fail(res, 429, "slow-down");
        const p = Password.safeParse(raw);
        if (!p.success || !(await matches(p.data.password, t))) return fail(res, 401, "wrong");
        await db.deleteTeacher(t.id);
        await note("account-deleted", t.id);
        return send(res, 200, { ok: true }, { "set-cookie": setCookie(req, COOKIE.teacher, "", 0) });
      }
      case "/api/inquiry": {
        if (!limits.inquiry.allow(ip, at)) return fail(res, 429, "slow-down");
        const p = NewInquiry.safeParse(raw);
        if (!p.success) return fail(res, 400, p.error.issues[0]?.path[0] === "password" ? "password" : "fields");
        // the hidden field only a script fills: answer as if it worked, keep nothing
        if (p.data.website) return send(res, 201, { code: newCode() });
        const made = await db.addInquiry({ code: newCode(), school: p.data.school, name: p.data.name, contact: p.data.contact, message: p.data.message, ...(await makeHash(p.data.password)), status: "new", reply: "", note: "", createdAt: at, repliedAt: 0 });
        log.info({ inquiry: made.id }, "inquiry received");
        return send(res, 201, { code: made.code });
      }
      case "/api/inquiry/view": {
        if (!limits.view.allow(ip, at)) return fail(res, 429, "slow-down");
        const p = ViewInquiry.safeParse(raw);
        const found = p.success ? await db.inquiryByCode(p.data.code) : null;
        const ok = await matches(p.success ? p.data.password : "", found ?? NOBODY);
        if (!found || !ok) return fail(res, 404, "not-found");
        return send(res, 200, { inquiry: publicInquiry(found) });
      }
      case "/api/admin/login": {
        if (!adminPassword) return fail(res, 503, "closed");
        if (!limits.admin.allow(ip, at)) return fail(res, 429, "slow-down");
        const p = Password.safeParse(raw);
        const a = createHash("sha256").update(p.success ? p.data.password : "").digest(), b = createHash("sha256").update(adminPassword).digest();
        if (!p.success || !timingSafeEqual(a, b)) { log.warn({ ip }, "admin login refused"); await note("admin-refused"); return fail(res, 401, "wrong"); }
        await note("admin-login");
        return send(res, 200, { ok: true }, { "set-cookie": await open("admin", 0) });
      }
      case "/api/admin/logout": return send(res, 200, { ok: true }, { "set-cookie": await close("admin") });
      case "/api/admin/inquiry": {
        if (!(await sessionOf("admin"))) return fail(res, 401, "admin");
        const p = AdminInquiry.safeParse(raw);
        if (!p.success) return fail(res, 400, "fields");
        const patch: InquiryPatch = {};
        if (p.data.note !== undefined) patch.note = p.data.note;
        if (p.data.reply !== undefined) { patch.reply = p.data.reply; patch.repliedAt = p.data.reply ? at : 0; if (p.data.reply && p.data.status === undefined) patch.status = "answered"; }
        if (p.data.status !== undefined) patch.status = p.data.status;
        const next = await db.updateInquiry(p.data.id, patch);
        if (!next) return fail(res, 404, "not-found");
        if (p.data.reply) await note("inquiry-answered");
        return send(res, 200, { inquiry: adminInquiry(next) });
      }
      case "/api/admin/teacher": {
        if (!(await sessionOf("admin"))) return fail(res, 401, "admin");
        const p = AdminTeacher.safeParse(raw);
        if (!p.success || !(await db.setTeacherStatus(p.data.id, p.data.status))) return fail(res, 404, "not-found");
        if (p.data.status === "disabled") await db.dropTeacherSessions(p.data.id); // signed out everywhere at once
        await note(p.data.status === "disabled" ? "teacher-disabled" : "teacher-enabled", p.data.id);
        return send(res, 200, { ok: true });
      }
      default: return fail(res, 404, "not-found");
    }
  };

  return (req, res) => {
    if (!store) { fail(res, 503, "unavailable"); return; }
    handle(req, res, store).catch((err) => {
      log.error({ err, url: req.url }, "site api failed");
      if (!res.headersSent) fail(res, 500, "server");
      else res.end();
    });
  };
}
