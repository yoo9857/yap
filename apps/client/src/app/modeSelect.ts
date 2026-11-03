import type { PartyLobby } from "./partyLobby.js";

/** A seat in a hub room survives the trip into a game (per tab). Read without loading the lobby. */
const hasSeat = (): boolean => {
  try { return !!sessionStorage.getItem("craftyap-party-seat"); } catch { return false; }
};

export type GameMode = "tower" | "builder" | "craft" | "battle" | "cinematic" | "field";

const MODES: readonly GameMode[] = ["tower", "builder", "craft", "battle", "cinematic", "field"];

/**
 * First screen: pick education or games, then (for games) which game.
 * `?mode=tower|builder|field|…` deep-links straight in (also used by the E2E
 * harnesses). Resolves once with the chosen mode.
 */
export function selectMode(parent: HTMLElement): Promise<GameMode> {
  // The real menu is in the HTML response so search engines, AI crawlers and
  // visitors without JavaScript read the same Korean game introduction.
  const el = document.getElementById("mode-select");
  if (!el) throw new Error("missing #mode-select menu");
  const param = new URLSearchParams(location.search).get("mode");
  // Guide buttons can open classroom choices directly without a second menu.
  if (param === "education") {
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
      if (step === "games") el.querySelector<HTMLElement>("[data-mode]")?.focus({ preventScroll: true });
    };
    show("category");
    const choose = (mode: GameMode) => {
      lobby?.dispose();
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
    el.querySelector<HTMLButtonElement>(".mode-back")!.addEventListener("click", () => show("category"));
    el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => choose(btn.dataset.mode as GameMode));
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || el.dataset.board !== "games") return;
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

/** The newest dev note fills the event banner; the bell gets a dot until it has been opened. */
async function pinLatestNote(el: HTMLElement): Promise<void> {
  const banner = el.querySelector<HTMLAnchorElement>('[data-id="hub-event"]');
  const bell = el.querySelector<HTMLAnchorElement>('[data-id="hub-bell"]');
  try {
    const res = await fetch("/note/latest.json", { cache: "no-cache" });
    if (!res.ok) return;
    const note = (await res.json()) as { title?: unknown; url?: unknown };
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
