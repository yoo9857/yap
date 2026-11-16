import { teacherAccount } from "../net/teacherAccount.js";
import type { PartyLobby } from "./partyLobby.js";

/** A seat in a hub room survives the trip into a game (per tab). Read without loading the lobby. */
const hasSeat = (): boolean => {
  try { return !!sessionStorage.getItem("craftyap-party-seat"); } catch { return false; }
};

export type GameMode = "tower" | "builder" | "craft" | "battle" | "cinematic" | "field";

const MODES: readonly GameMode[] = ["tower", "builder", "craft", "battle", "cinematic", "field"];

/**
 * First screen: the web home (접속하기, 선생님 로그인), then education or games, then (for
 * games) which game.
 * `?mode=tower|builder|field|…` deep-links straight in (also used by the E2E
 * harnesses). Resolves once with the chosen mode.
 */
/** Where the education lobby opens: its three choices, or (선생님 로그인 on the home) straight at 반 만들기. */
export let lobbyStart: "pick" | "teacher" = "pick";

export function selectMode(parent: HTMLElement): Promise<GameMode> {
  // The real menu is in the HTML response so search engines, AI crawlers and
  // visitors without JavaScript read the same Korean game introduction.
  const el = document.getElementById("mode-select");
  if (!el) throw new Error("missing #mode-select menu");
  const param = new URLSearchParams(location.search).get("mode");
  // Guide buttons can open classroom choices directly without a second menu.
  if (param === "education") {
    // (&as=teacher: back from signing in on /teacher/ — straight at the lesson select)
    if (new URLSearchParams(location.search).get("as") === "teacher") lobbyStart = "teacher";
    el.remove();
    return Promise.resolve("field");
  }
  if (MODES.includes(param as GameMode)) {
    el.remove();
    return Promise.resolve(param as GameMode);
  }

  return new Promise((resolve) => {
    parent.appendChild(el);

    const steps = el.querySelectorAll<HTMLElement>(".mode-step");
    const show = (step: string) => {
      steps.forEach((s) => (s.hidden = s.dataset.step !== step));
      el.dataset.board = step; // the hub's CSS lays out each step
      if (step === "games") el.querySelector<HTMLElement>('[data-step="games"] [data-mode]')?.focus({ preventScroll: true });
    };
    // "/?pick=1": back from a mode's own lobby to the 교육 / 게임 choice, not all the way to the first page
    if (new URLSearchParams(location.search).has("pick")) {
      history.replaceState(null, "", location.pathname);
      show("category");
    } else show("home");
    const choose = (mode: GameMode) => {
      lobby?.dispose();
      removeEventListener("resize", fit);
      document.removeEventListener("keydown", onKey);
      el.remove();
      resolve(mode);
    };
    let pickGames = () => show("games");
    const pick = (which: string) => {
      if (which === "field") choose("field");
      else pickGames();
    };

    el.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((btn) => btn.addEventListener("click", () => pick(btn.dataset.pick!)));
    // the home's two ways in, and the way back to it
    el.querySelectorAll<HTMLButtonElement>("[data-enter]").forEach((btn) => btn.addEventListener("click", () => {
      const to = btn.dataset.enter;
      if (to === "teacher") {
        // 선생님 로그인 / 수업 관리: the account page — signed out it is the sign-in, signed in the
        // teacher's own classes (docs/ACCOUNTS.md). No account service: the lobby as it always was.
        btn.disabled = true;
        void accountsOpen.then((open) => {
          btn.disabled = false;
          if (open) location.href = "/teacher/";
          else { lobbyStart = "teacher"; choose("field"); }
        });
      }
      else if (to === "home") show("home");
      else {
        show("category"); // nothing focused: a focused half would start "chosen" (the arrow keys choose)
        el.scrollTop = 0;
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }));
    el.querySelector<HTMLButtonElement>(".mode-back")!.addEventListener("click", () => show("category"));
    el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => choose(btn.dataset.mode as GameMode));
    });
    const onKey = (e: KeyboardEvent) => {
      // Enter on the first page, nothing focused: 접속하기 (focusing the button on load drew its ring)
      if (e.key === "Enter" && el.dataset.board === "home" && (document.activeElement === document.body || !document.activeElement)) {
        el.querySelector<HTMLElement>('[data-enter="play"]')?.click();
        return;
      }
      // the two worlds of the choice: the arrow keys point at one (Enter then picks it)
      if (el.dataset.board === "category" && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const first = e.key === "ArrowLeft" || e.key === "ArrowUp";
        el.querySelector<HTMLElement>(`[data-pick="${first ? "field" : "games"}"]`)?.focus({ preventScroll: true });
        e.preventDefault();
        return;
      }
      if (e.key !== "Escape") return;
      if (el.dataset.board === "category") { show("home"); return; }
      if (el.dataset.board !== "games") return;
      if (lobby?.escape()) return; // a dialog or the waiting room is open
      show("category");
    };
    document.addEventListener("keydown", onKey);

    // the hub's rooms: connected the first time the hub is shown
    let lobby: PartyLobby | null = null;
    const openHub = () => {
      show("games");
      if (lobby) return;
      void import("./partyLobby.js").then(({ PartyLobby }) => {
        lobby = new PartyLobby(el);
        lobby.start();
      });
    };
    pickGames = openHub;
    // back from a party game ("처음으로"): straight onto the rooms, into the seat
    if (hasSeat()) openHub();

    // the hub is drawn in px for a 1536 x 900 window: --zoom scales its shell with the window, as the
    // other menu screens' --u does (a tall or narrow window keeps its own stacked layout, unscaled)
    const fit = () => {
      const wide = innerWidth > 980 && innerWidth > innerHeight;
      el.style.setProperty("--zoom", wide ? String(Math.max(0.7, menuScale(Math.min(innerWidth / 1536, innerHeight / 900)))) : "1");
    };
    fit();
    addEventListener("resize", fit);
    // the two worlds of the mode choice are its whole screen: fetched while the first page idles
    // (after it has painted), so 접속하기 does not open onto two plain colours
    const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 2500));
    idle(() => { for (const world of ["education", "games"]) new Image().src = `/home/world-${world}.webp`; });
    wireSoon(el);
    showName(el);
    void pinLatestNote(el);
  });
}

const SEEN_NOTE_KEY = "craftyap-seen-note";

/** Places kept for features that are not built yet answer with a short "coming soon". */
function wireSoon(el: HTMLElement): void {
  const toast = el.querySelector<HTMLElement>(".hub-toast");
  let timer = 0;
  el.querySelectorAll<HTMLElement>("[data-soon]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!toast) return;
      toast.textContent = `${btn.dataset.soon} — 곧 열려요!`;
      toast.classList.add("show");
      clearTimeout(timer);
      timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
    });
  });
}

/** The profile card shows the nickname used in Daily Tower, if there is one. */
function showName(el: HTMLElement): void {
  const slot = el.querySelector<HTMLElement>('[data-id="hub-name"]');
  if (!slot) return;
  try {
    const name = localStorage.getItem("robo-name")?.trim();
    if (name) slot.textContent = name.slice(0, 16);
  } catch {
    /* storage is optional */
  }
}

/** The home's 새로운 소식: the newest notes, each a kind, its headline and its day. */
function listNews(el: HTMLElement, recent: unknown): void {
  const list = el.querySelector<HTMLElement>('[data-id="web-news"]');
  if (!list || !Array.isArray(recent)) return;
  const rows: HTMLElement[] = [];
  for (const row of recent.slice(0, 3) as { title?: unknown; url?: unknown; date?: unknown; tags?: unknown }[]) {
    if (typeof row?.title !== "string" || typeof row.url !== "string" || !row.url.startsWith("/note/")) continue;
    const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const li = document.createElement("li"), a = document.createElement("a");
    const kind = document.createElement("i"), head = document.createElement("b"), day = document.createElement("time");
    a.href = row.url;
    const what = tags.includes("새로 추가") ? "new" : tags.includes("버그 수정") && !tags.includes("개선") ? "fix" : "update";
    li.dataset.kind = what; // the chip's colour (index.html .web-news)
    kind.textContent = what === "new" ? "새 콘텐츠" : what === "fix" ? "수정" : "업데이트";
    // "11월 14일 패치 노트 — 화재 체험이 가벼워졌어요": the day has its own column
    head.textContent = row.title.split(" — ").slice(1).join(" — ") || row.title;
    if (typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      day.dateTime = row.date;
      day.textContent = row.date.replaceAll("-", ".");
    }
    a.append(kind, head, day);
    li.append(a);
    rows.push(li);
  }
  if (rows.length) list.replaceChildren(...rows);
}

/** The newest dev note fills the event banner; the bell gets a dot until it has been opened. */
async function pinLatestNote(el: HTMLElement): Promise<void> {
  const banner = el.querySelector<HTMLAnchorElement>('[data-id="hub-event"]');
  const bell = el.querySelector<HTMLAnchorElement>('[data-id="hub-bell"]');
  try {
    const res = await fetch("/note/latest.json", { cache: "no-cache" });
    if (!res.ok) return;
    const note = (await res.json()) as { title?: unknown; url?: unknown; recent?: unknown };
    listNews(el, note.recent);
    if (typeof note.title !== "string" || typeof note.url !== "string" || !note.url.startsWith("/note/")) return;
    const url = note.url;
    for (const link of [banner, bell]) if (link) link.href = url;
    const title = el.querySelector('[data-id="hub-event-title"]');
    if (title) title.textContent = note.title;
    let seen = "";
    try { seen = localStorage.getItem(SEEN_NOTE_KEY) ?? ""; } catch { /* optional */ }
    const dot = bell?.querySelector<HTMLElement>(".hub-dot");
    if (dot) dot.hidden = seen === url;
    const markSeen = () => { try { localStorage.setItem(SEEN_NOTE_KEY, url); } catch { /* optional */ } };
    banner?.addEventListener("click", markSeen);
    bell?.addEventListener("click", markSeen);
  } catch {
    /* offline or no notes yet: the banner keeps pointing at the notes index */
  }
}

/** The menu's scale for a window `fit` times the design size: index.html's --menu-u, as a number. */
function menuScale(fit: number): number {
  return Math.min(fit, 0.62 + 0.38 * fit);
}

/** Is there an account service to sign in to? (asked once; a server without one keeps 선생님 로그인 as it was) */
const accountsOpen: Promise<boolean> = fetch("/api/teacher/me", { credentials: "same-origin" }).then((r) => r.ok).catch(() => false);
// a signed-in teacher's button on the first page says where it goes
void teacherAccount().then((account) => {
  const label = document.querySelector<HTMLElement>('[data-enter="teacher"] [data-id="teacher-label"]');
  if (account && label) label.textContent = "수업 관리";
});
