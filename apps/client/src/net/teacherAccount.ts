/**
 * The signed-in teacher, as the game knows them (docs/ACCOUNTS.md). The account lives on the
 * site's pages (/teacher/) and in an HttpOnly cookie the game never sees: all the game does is
 * ask who is signed in, and ask for a HOST TICKET to send in `k-host` — the server then knows
 * which account opens the class, and the owner needs no class password.
 *
 * Everything here fails soft: a server without accounts, a signed-out teacher or a slow answer
 * all mean "no account", and the class opens by its password as it always has.
 */
export interface TeacherAccount {
  id: number;
  name: string;
  school: string;
  email: string;
}

const TIMEOUT_MS = 2500;

async function ask<T>(path: string, post: boolean): Promise<T | null> {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, post
      ? { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}", signal: stop.signal }
      : { credentials: "same-origin", signal: stop.signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let me: Promise<TeacherAccount | null> | null = null;
/** Who is signed in (asked once a page view). */
export function teacherAccount(): Promise<TeacherAccount | null> {
  return (me ??= ask<{ teacher: TeacherAccount | null }>("/api/teacher/me", false).then((r) => r?.teacher ?? null));
}

/** A fresh ticket for `k-host` (good for two minutes), or undefined when nobody is signed in. */
export async function hostTicket(): Promise<string | undefined> {
  if (!(await teacherAccount())) return undefined;
  return (await ask<{ ticket: string }>("/api/teacher/ticket", true))?.ticket;
}
