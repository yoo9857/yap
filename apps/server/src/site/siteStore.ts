import { log } from "../log.js";

/**
 * What the SITE keeps (as opposed to the games): teachers' accounts, their sessions, the inquiries
 * schools send, and a record of who did what. It lives in PostgreSQL (owner's call 2026-11-16:
 * members are managed in PostgreSQL, with care) — NOT in the games' SQLite file: personal data has
 * its own database, its own user and its own backups. Design, threats and the runbook:
 * docs/ACCOUNTS.md. Every query is parameterised; nothing a visitor typed is ever part of SQL text.
 */
export interface Teacher {
  id: number;
  /** Lower-cased; the account's name. Nothing is ever mailed to it (there is no mail service). */
  email: string;
  name: string;
  school: string;
  passHash: string;
  salt: string;
  status: "active" | "disabled";
  createdAt: number;
  lastLoginAt: number;
}

export interface Session {
  /** sha256 of the cookie's token: a stolen database gives no usable cookie. */
  tokenHash: string;
  kind: "teacher" | "admin";
  teacherId: number;
  createdAt: number;
  expiresAt: number;
}

export type InquiryStatus = "new" | "read" | "answered" | "closed";

export interface Inquiry {
  id: number;
  /** What the sender looks the answer up by, with the password they chose. */
  code: string;
  school: string;
  name: string;
  contact: string;
  message: string;
  passHash: string;
  salt: string;
  status: InquiryStatus;
  reply: string;
  /** The operator's own note; never shown to the sender. */
  note: string;
  createdAt: number;
  repliedAt: number;
}

/** One line of the record: what happened, to which account, from where. Never a password or a token. */
export interface AuditEvent {
  at: number;
  /** signup · login · login-refused · logout · account-deleted · admin-login · admin-refused · teacher-disabled · teacher-enabled · inquiry-answered */
  what: string;
  teacherId: number;
  ip: string;
}

export type InquiryPatch = Partial<Pick<Inquiry, "status" | "reply" | "note" | "repliedAt">>;

export interface SiteStore {
  /** Is this the database (true), or memory that a restart empties (false)? */
  readonly durable: boolean;
  teacherByEmail(email: string): Promise<Teacher | null>;
  teacherById(id: number): Promise<Teacher | null>;
  /** Null when the e-mail is taken. */
  addTeacher(t: Omit<Teacher, "id">): Promise<Teacher | null>;
  touchTeacher(id: number, now: number): Promise<void>;
  setTeacherStatus(id: number, status: Teacher["status"]): Promise<boolean>;
  /** The account and everything of it (sessions) is gone; the record keeps only the event. */
  deleteTeacher(id: number): Promise<void>;
  listTeachers(): Promise<Teacher[]>;
  addSession(s: Session): Promise<void>;
  session(tokenHash: string): Promise<Session | null>;
  dropSession(tokenHash: string): Promise<void>;
  dropTeacherSessions(teacherId: number): Promise<void>;
  purgeSessions(now: number): Promise<void>;
  addInquiry(i: Omit<Inquiry, "id">): Promise<Inquiry>;
  inquiryByCode(code: string): Promise<Inquiry | null>;
  updateInquiry(id: number, patch: InquiryPatch): Promise<Inquiry | null>;
  listInquiries(): Promise<Inquiry[]>;
  audit(e: AuditEvent): Promise<void>;
  listAudit(limit: number): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

/** In memory: the unit tests' store, and what dev runs on without a database (nothing survives a restart). */
/* eslint-disable @typescript-eslint/require-await -- the interface is asynchronous (the real store is a database); memory has nothing to wait for */
export class MemorySiteStore implements SiteStore {
  readonly durable = false;
  private teachers: Teacher[] = [];
  private nextTeacher = 1;
  private readonly sessions = new Map<string, Session>();
  private readonly inquiries: Inquiry[] = [];
  private readonly events: AuditEvent[] = [];
  async teacherByEmail(email: string) { return this.teachers.find((t) => t.email === email) ?? null; }
  async teacherById(id: number) { return this.teachers.find((t) => t.id === id) ?? null; }
  async addTeacher(t: Omit<Teacher, "id">) {
    if (this.teachers.some((x) => x.email === t.email)) return null;
    const made = { ...t, id: this.nextTeacher++ };
    this.teachers.push(made);
    return made;
  }
  async touchTeacher(id: number, now: number) { const t = this.teachers.find((x) => x.id === id); if (t) t.lastLoginAt = now; }
  async setTeacherStatus(id: number, status: Teacher["status"]) { const t = this.teachers.find((x) => x.id === id); if (t) t.status = status; return !!t; }
  async deleteTeacher(id: number) { this.teachers = this.teachers.filter((t) => t.id !== id); await this.dropTeacherSessions(id); }
  async listTeachers() { return [...this.teachers].reverse(); }
  async addSession(s: Session) { this.sessions.set(s.tokenHash, s); }
  async session(tokenHash: string) { return this.sessions.get(tokenHash) ?? null; }
  async dropSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async dropTeacherSessions(teacherId: number) { for (const [k, s] of this.sessions) if (s.kind === "teacher" && s.teacherId === teacherId) this.sessions.delete(k); }
  async purgeSessions(now: number) { for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k); }
  async addInquiry(i: Omit<Inquiry, "id">) { const made = { ...i, id: this.inquiries.length + 1 }; this.inquiries.push(made); return made; }
  async inquiryByCode(code: string) { return this.inquiries.find((i) => i.code === code) ?? null; }
  async updateInquiry(id: number, patch: InquiryPatch) {
    const i = this.inquiries.find((q) => q.id === id);
    if (!i) return null;
    Object.assign(i, patch);
    return i;
  }
  async listInquiries() { return [...this.inquiries].reverse(); }
  async audit(e: AuditEvent) { this.events.push(e); }
  async listAudit(limit: number) { return this.events.slice(-limit).reverse(); }
  async close() { /* nothing to release */ }
}
/* eslint-enable @typescript-eslint/require-await */

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v); // BIGINT arrives as a string
const teacherOf = (r: Row): Teacher => ({
  id: num(r.id), email: r.email as string, name: r.name as string, school: r.school as string, passHash: r.pass_hash as string, salt: r.salt as string,
  status: r.status === "disabled" ? "disabled" : "active", createdAt: num(r.created_at), lastLoginAt: num(r.last_login_at),
});
const inquiryOf = (r: Row): Inquiry => ({
  id: num(r.id), code: r.code as string, school: r.school as string, name: r.name as string, contact: r.contact as string, message: r.message as string,
  passHash: r.pass_hash as string, salt: r.salt as string, status: (["new", "read", "answered", "closed"] as const).find((s) => s === r.status) ?? "new",
  reply: r.reply as string, note: r.note as string, createdAt: num(r.created_at), repliedAt: num(r.replied_at),
});

/**
 * The schema. Only ever ADDED to (new tables, new nullable or defaulted columns): the deploy starts
 * the new server beside the old one on the same database, and a rollback must find what it knows.
 * Times are epoch milliseconds (BIGINT), as everywhere else in the server.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS teachers (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 120),
    name TEXT NOT NULL CHECK (length(name) <= 30),
    school TEXT NOT NULL CHECK (length(school) <= 60),
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at BIGINT NOT NULL,
    last_login_at BIGINT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS site_sessions (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('teacher', 'admin')),
    teacher_id BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS site_sessions_teacher ON site_sessions (teacher_id);
  CREATE TABLE IF NOT EXISTS inquiries (
    id BIGSERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    school TEXT NOT NULL, name TEXT NOT NULL, contact TEXT NOT NULL, message TEXT NOT NULL,
    pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'answered', 'closed')),
    reply TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL, replied_at BIGINT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS site_audit (
    id BIGSERIAL PRIMARY KEY,
    at BIGINT NOT NULL, what TEXT NOT NULL, teacher_id BIGINT NOT NULL DEFAULT 0, ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS site_audit_at ON site_audit (at);
`;

type Pool = import("pg").Pool;

class PgSiteStore implements SiteStore {
  readonly durable = true;
  constructor(private readonly pool: Pool) {}
  private async rows(sql: string, args: unknown[] = []): Promise<Row[]> { return (await this.pool.query(sql, args)).rows as Row[]; }
  private async one(sql: string, args: unknown[]): Promise<Row | null> { return (await this.rows(sql, args))[0] ?? null; }

  async teacherByEmail(email: string) { const r = await this.one(`SELECT * FROM teachers WHERE email = $1`, [email]); return r ? teacherOf(r) : null; }
  async teacherById(id: number) { const r = await this.one(`SELECT * FROM teachers WHERE id = $1`, [id]); return r ? teacherOf(r) : null; }
  async addTeacher(t: Omit<Teacher, "id">) {
    // The UNIQUE constraint decides, not a "look, then insert": two sign-ups for one e-mail in the
    // same instant make one account, and the other gets the constraint's error (23505).
    try {
      const r = await this.one(
        `INSERT INTO teachers (email, name, school, pass_hash, salt, status, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [t.email, t.name, t.school, t.passHash, t.salt, t.status, t.createdAt, t.lastLoginAt]);
      return r ? teacherOf(r) : null;
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      if (e.code === "23505" || /unique|duplicate key/i.test(String(e.message))) return null;
      throw err;
    }
  }
  async touchTeacher(id: number, now: number) { await this.pool.query(`UPDATE teachers SET last_login_at = $1 WHERE id = $2`, [now, id]); }
  async setTeacherStatus(id: number, status: Teacher["status"]) { return ((await this.pool.query(`UPDATE teachers SET status = $1 WHERE id = $2`, [status, id])).rowCount ?? 0) > 0; }
  async deleteTeacher(id: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM site_sessions WHERE kind = 'teacher' AND teacher_id = $1`, [id]);
      await client.query(`DELETE FROM teachers WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async listTeachers() { return (await this.rows(`SELECT * FROM teachers ORDER BY id DESC LIMIT 2000`)).map(teacherOf); }
  async addSession(s: Session) {
    await this.pool.query(`INSERT INTO site_sessions (token_hash, kind, teacher_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token_hash) DO NOTHING`,
      [s.tokenHash, s.kind, s.teacherId, s.createdAt, s.expiresAt]);
  }
  async session(tokenHash: string) {
    const r = await this.one(`SELECT * FROM site_sessions WHERE token_hash = $1`, [tokenHash]);
    return r ? { tokenHash, kind: r.kind === "admin" ? "admin" as const : "teacher" as const, teacherId: num(r.teacher_id), createdAt: num(r.created_at), expiresAt: num(r.expires_at) } : null;
  }
  async dropSession(tokenHash: string) { await this.pool.query(`DELETE FROM site_sessions WHERE token_hash = $1`, [tokenHash]); }
  async dropTeacherSessions(teacherId: number) { await this.pool.query(`DELETE FROM site_sessions WHERE kind = 'teacher' AND teacher_id = $1`, [teacherId]); }
  async purgeSessions(now: number) { await this.pool.query(`DELETE FROM site_sessions WHERE expires_at <= $1`, [now]); }
  async addInquiry(i: Omit<Inquiry, "id">) {
    const r = await this.one(
      `INSERT INTO inquiries (code, school, name, contact, message, pass_hash, salt, status, reply, note, created_at, replied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [i.code, i.school, i.name, i.contact, i.message, i.passHash, i.salt, i.status, i.reply, i.note, i.createdAt, i.repliedAt]);
    return inquiryOf(r!);
  }
  async inquiryByCode(code: string) { const r = await this.one(`SELECT * FROM inquiries WHERE code = $1`, [code]); return r ? inquiryOf(r) : null; }
  async updateInquiry(id: number, patch: InquiryPatch) {
    // COALESCE keeps what the patch does not name; one statement, so two operators cannot interleave halves
    const r = await this.one(
      `UPDATE inquiries SET status = COALESCE($2, status), reply = COALESCE($3, reply), note = COALESCE($4, note), replied_at = COALESCE($5, replied_at) WHERE id = $1 RETURNING *`,
      [id, patch.status ?? null, patch.reply ?? null, patch.note ?? null, patch.repliedAt ?? null]);
    return r ? inquiryOf(r) : null;
  }
  async listInquiries() { return (await this.rows(`SELECT * FROM inquiries ORDER BY id DESC LIMIT 2000`)).map(inquiryOf); }
  async audit(e: AuditEvent) { await this.pool.query(`INSERT INTO site_audit (at, what, teacher_id, ip) VALUES ($1, $2, $3, $4)`, [e.at, e.what, e.teacherId, e.ip]); }
  async listAudit(limit: number) {
    return (await this.rows(`SELECT * FROM site_audit ORDER BY id DESC LIMIT $1`, [limit])).map((r) => ({ at: num(r.at), what: r.what as string, teacherId: num(r.teacher_id), ip: r.ip as string }));
  }
  async close() { await this.pool.end(); }
}

/**
 * The site's store. With a DATABASE_URL it is PostgreSQL, and a database that cannot be reached is
 * an ERROR the caller sees (the API then answers 503: accounts kept in memory would vanish at the
 * next deploy, and people would be told their password is wrong). Without one it is memory — dev
 * and the tests — and says so.
 */
export async function createSiteStore(databaseUrl: string | undefined): Promise<SiteStore> {
  if (!databaseUrl) {
    log.warn("DATABASE_URL is unset: teachers' accounts and inquiries are kept in MEMORY and lost at restart (dev only)");
    return new MemorySiteStore();
  }
  const { Pool } = (await import("pg")).default;
  // a small pool: this is a handful of requests a minute, and two app containers share the database during a deploy
  const pool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, application_name: "craftyap-site" });
  pool.on("error", (err) => log.error({ err: err.message }, "site database connection error")); // an idle client dropped: never crash the server for it
  const store = await siteStoreOn(pool);
  log.info("site store: postgresql");
  return store;
}

/** The store on a pool that already exists (the tests hand it an in-process PostgreSQL): makes the schema, returns the store. */
export async function siteStoreOn(pool: Pool): Promise<SiteStore> {
  await pool.query(SCHEMA);
  return new PgSiteStore(pool);
}
