# Accounts, inquiries and the admin

Decided by the owner on 2026-11-16: **teachers sign up** (students never do), **schools' inquiries
are answered from an admin page on our own server** (not by a published e-mail address), and
**members are managed in PostgreSQL, with care for security**.

This file is the design, what is built, what is not yet, and the runbook. Keep it true.

## Status

| Part | State |
|---|---|
| Server store (`apps/server/src/site/siteStore.ts`): teachers, sessions, inquiries, audit — PostgreSQL, memory for dev/tests | built, tested (`test/site-store.test.ts`, real SQL on an in-process PostgreSQL) |
| Server API (`siteApi.ts`, `/api/…`) | built, tested over real HTTP (`test/site-api.test.ts`) |
| Wiring: `/api/` in the HTTP handler (single server and cluster primary), `DATABASE_URL` / `ADMIN_PASSWORD` / `AUTH_PEPPER`, dev proxy, `pg` in the image | built |
| `docker-compose.db.yml` (the database's own compose project), started by `scripts/ensure-site-db.sh` at every deploy's preflight | built; the script is tested against a stand-in docker (`tools/test-zero-downtime-deploy.sh`) |
| App containers on the `craftyap-data` network (`docker-compose.yml`); the deploy prepares the database first; `scripts/backup-site-db.sh` dumps it before every deploy and daily | built; the deploy's control-flow test covers the new step |
| Pages: teacher sign-up / sign-in (`/teacher/`), the inquiry form on `/cases/#inquiry` (it replaced the published e-mail address), the admin (`/admin/`); shared script `/site/api.js`, forms styled by `.cy-form` in `guide.css` | built; `tools/e2e-site.mjs` drives all of it in a browser (sign up → inquiry → admin answers → the school reads the answer) |
| The home's 선생님 로그인 (signed out → `/teacher/?next=class`, which comes back to the lesson select; signed in → the lesson select) and the class lobby (it names the signed-in teacher, needs no class password, and sends the host ticket) | built (`net/teacherAccount.ts`, `classLobby.ts`, `modeSelect.ts`; `tools/e2e-site.mjs` opens a class without a password) |
| A class belongs to a teacher's account — the **optional** stage: the account adds a way in and takes none away | built and tested (`site/ticket.ts`, `ClassManager.host`, `ClassRoom.ownerId`, `SavedClass.owner`; `test/classroom-accounts.test.ts`) |
| Making sign-in **required** to open a class (`TEACHER_ACCOUNTS=required`) | **not done**, on purpose: first the database must run in production and teachers must have accounts |
| First run against a real PostgreSQL server | **not done** (no PostgreSQL on the development PC) |

Until the pages exist nothing visible changes; without `DATABASE_URL` the API keeps everything in
memory (dev) and says so in the log.

## What is kept, and what never is

- **teachers**: e-mail (lower-cased; the account's name — nothing is mailed to it, there is no
  mail service), name, school, password hash + salt, status (`active` / `disabled`), created and
  last sign-in times.
- **site_sessions**: sha256 of the cookie's token, kind (`teacher` / `admin`), expiry.
- **inquiries**: school, name, contact, message, the sender's look-up password (hash + salt), the
  8-character code, status, the operator's reply and private note.
- **site_audit**: time, event, account id, client address. Never a password, a token or a message.
- **Never stored**: passwords, cookie tokens, anything about students. Students do not sign up.

The collection notice and the retention period shown to users are the owner's to write; the form
pages leave a place for them.

## Security rules (each has a test)

1. **Parameterised SQL only.** Nothing a visitor typed is part of SQL text.
2. **Passwords**: `scrypt(N=32768)` over the password keyed with `AUTH_PEPPER` (HMAC-SHA256), a
   salt per password, constant-time comparison, computed off the event loop. The pepper is in the
   server's environment, not in the database: a stolen copy of the database cannot be searched
   for passwords. **Never change `AUTH_PEPPER` once accounts exist** — every password becomes wrong.
3. **Sessions**: a random 256-bit token in an `HttpOnly; SameSite=Lax; Secure` cookie; the database
   holds only its sha256. Teachers 30 days, admin 12 hours. Disabling or deleting an account ends
   its sessions at once.
4. **CSRF**: bodies must be `application/json`; a request that changes something and carries an
   `Origin` naming another host is refused; cookies are `SameSite=Lax`.
5. **Guessing is limited** per client address AND, for signing in, per account (a school shares one
   address; an attacker has many): sign-in 10 / 10 min per address and 8 / 15 min per account,
   sign-up 5 / hour, inquiries 5 / hour, inquiry look-ups 20 / 10 min, admin 5 / 15 min.
6. **Answers tell no more than the page needs**: a wrong password and an unknown e-mail are one
   answer and take the same time; an unknown inquiry code and a wrong inquiry password are one answer.
7. **The admin** is one password from the environment (`ADMIN_PASSWORD`, ≥ 10 characters; unset =
   the admin is closed, 503). A teacher's session is never an admin's.
8. **The database** is not reachable from outside: no published port, only the `craftyap-data`
   docker network; scram-sha-256; its own user and database, apart from the games' SQLite.
9. **Leaving**: a teacher can delete their account (password asked again); the account and its
   sessions go, the audit keeps only the event.
10. **A database that cannot be reached** closes the API (503) and never stops the games from starting.
11. **The schema is only added to** (new tables, new nullable/defaulted columns): during a deploy the
    new and the old server run on the same database, and a rollback must find what it knows.

## API

`POST /api/teacher/signup {email, name, school, password≥8}` · `POST /api/teacher/login` ·
`POST /api/teacher/logout` · `GET /api/teacher/me` · `POST /api/teacher/delete {password}` ·
`POST /api/inquiry {school, name, contact, message, password≥4}` → `{code}` ·
`POST /api/inquiry/view {code, password}` · `POST /api/admin/login {password}` ·
`POST /api/admin/logout` · `GET /api/admin/me` · `GET /api/admin/inquiries` ·
`POST /api/admin/inquiry {id, status?, reply?, note?}` · `GET /api/admin/teachers` ·
`POST /api/admin/teacher {id, status}` · `GET /api/admin/audit`.

Errors are `{error}` with a short code (`wrong`, `taken`, `password`, `email`, `fields`,
`slow-down`, `disabled`, `closed`, `unavailable`, …); the pages turn them into sentences.

## Classes and accounts (the optional stage — built)

"Keys, not accounts" (CLAUDE.md → Classroom) still holds for everyone without an account. With one:

- **The ticket.** A class's socket goes to a shard, which has no sessions. The lobby asks
  `POST /api/teacher/ticket` when 반 열기 is pressed and sends the answer in `k-host.ticket` (an
  optional field: no protocol bump; the app sends none). A ticket is `id.expiry.signature`, HMAC
  with a key every process derives from `AUTH_PEPPER` (`site/ticket.ts`), good for two minutes
  and for nothing else. Without `AUTH_PEPPER` a single process uses a key of its own (dev); a
  cluster then has no tickets, and classes open by password as before.
- **What the account adds** (`ClassManager.host`): a new class needs no class password (it gets a
  random one nobody knows — the account is its key); the OWNER re-opens their class from any
  computer by the account alone, and comes back into it live.
- **What it never takes away**: the host key in the browser and the class password open a class
  exactly as before. A class with no owner (made before accounts, or signed out) becomes the
  account's that opens it WITH its password or host key — never by a ticket alone. An owned class
  is not re-assigned to someone else who knows its password.
- **Reconnects** send the ticket fetched at 반 열기; once it has expired the server ignores it and
  the host key re-takes the seat, as it always did (so a deploy mid-lesson needs no sign-in).
- **Not yet**: `TEACHER_ACCOUNTS=required` (a class may only be opened signed in). It is a switch
  for after the database runs in production and teachers have accounts — a lesson in progress
  must never be locked out by a deploy.

## 수업 관리 and 반 설정 (built 2026-11-16)

A signed-in teacher's `/teacher/` is their class list, and each class has a settings view.

- `GET /api/teacher/classes` → the account's classes (name, teacher name, last lesson, students, last
  saved). Read from the games' SQLite by the process that answers the API (`createClassIndex`,
  read-only): `classes` has the added columns `owner` (indexed) and `summary` (written at every save).
- `POST /api/teacher/class {room, op, …}` → `ClassManager.admin` in the process that OWNS the class
  (cluster: the primary places the class's route and sends `class-admin` to that shard). Ops (pure in
  `classroom/classAdmin.ts`): `get`, `add-students {names}`, `remove-student {name}`, `password`,
  `settings` (the five locks), `reset-field`, `clear-seats`, `delete` (takes the account's password).
- Rules: only the owner's account (anything else is 404, the same as no class); with people in the
  class it is only shown and every change is 409 `busy`; loaded with nobody in it, it is put away
  first; 150 requests per 10 minutes per account; every change is in the audit record (`class-<op>`).
- What the page is given: names and counts. Never a seat key, a host key, a hash or the field.
- Deleting an ACCOUNT does not delete its classes (they stay openable by host key or class password
  and are purged after 180 days unopened); the page says so.
- Not built: renaming a class, lesson history, "in lesson now" in the list.

## Runbook

**Nothing is done by hand for the database.** `scripts/zero-downtime-deploy.sh` runs
`scripts/ensure-site-db.sh` before it starts the new container, every deploy:

1. the docker network `craftyap-data` exists (the only step that can fail a deploy — the app
   could not start without it; the old container then simply keeps serving);
2. first time only: `.env.db` gets a random database password, and the app's `.env` gets
   `DATABASE_URL` and `AUTH_PEPPER` (written once, never changed);
3. the database (`docker compose -f docker-compose.db.yml`) is up and healthy — if it is not, that
   is a WARNING: the games deploy as usual and `/api` answers 503 (the smoke test reports it).

**The one thing the operator does:** choose the admin password — add `ADMIN_PASSWORD=…` (at
least 10 characters) to `/srv/craftyap/app/.env` and deploy (or restart the app). Until then
`/admin/` is closed.

**Keep a copy of `AUTH_PEPPER` off the server.** Every teacher's password is keyed with it: a
database restored without it is a database of accounts nobody can sign in to.

Backups: `scripts/backup-site-db.sh` (`pg_dump` inside the database's container, checked for
completeness) writes `site-…sql.gz` beside the SQLite snapshots — before every deploy
(`pre-deploy/`, newest 10, a failed dump aborts the deploy) and daily (`backups/`). To restore:
`gunzip -c site-….sql.gz | docker exec -i craftyap-db psql -U craftyap craftyap` into an empty
database.

First-run check against the real server: sign up, sign out, sign in, send an inquiry, answer it
in the admin, look it up — and `SELECT count(*) FROM site_audit`.
