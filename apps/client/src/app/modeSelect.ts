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
      el.dataset.step = step; // the board's CSS lays out each step
    };
    show("category");
    const choose = (mode: GameMode) => {
      el.remove();
      resolve(mode);
    };

    el.querySelector<HTMLButtonElement>('[data-pick="field"]')!.addEventListener("click", () => choose("field"));
    el.querySelector<HTMLButtonElement>('[data-pick="games"]')!.addEventListener("click", () => show("games"));
    el.querySelector<HTMLButtonElement>(".mode-back")!.addEventListener("click", () => show("category"));
    el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => choose(btn.dataset.mode as GameMode));
    });
    void pinLatestNote(el);
  });
}

/** Pins the newest dev note on the home board; the board simply has no pin if this fails. */
async function pinLatestNote(el: HTMLElement): Promise<void> {
  const pin = el.querySelector<HTMLAnchorElement>(".board-news");
  if (!pin) return;
  try {
    const res = await fetch("/note/latest.json", { cache: "no-cache" });
    if (!res.ok) return;
    const note = (await res.json()) as { title?: unknown; url?: unknown };
    if (typeof note.title !== "string" || typeof note.url !== "string" || !note.url.startsWith("/note/")) return;
    pin.href = note.url;
    pin.querySelector(".board-news-title")!.textContent = note.title;
    pin.hidden = false;
  } catch {
    /* offline or no notes yet */
  }
}
