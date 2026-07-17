/**
 * Bootstrap. The mode selector shows immediately; each mode lazy-loads its
 * own bundle — the tower's Rapier WASM (~2 MB) is only fetched when the
 * tower is actually chosen, and the builder starts instantly. Failures land
 * on a fatal overlay with a retry button — a game never half-starts.
 */
import { selectMode } from "./app/modeSelect.js";

const overlay = document.getElementById("boot-overlay");
const messageEl = document.getElementById("boot-message");
const retryBtn = document.getElementById("boot-retry");

function setBootMessage(text: string): void {
  if (messageEl) messageEl.textContent = text;
}

function showFatal(text: string): void {
  setBootMessage(text);
  overlay?.classList.add("error");
  overlay?.classList.remove("hidden");
}

function hideOverlay(): void {
  overlay?.classList.add("hidden");
}

retryBtn?.addEventListener("click", () => window.location.reload());

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function bootTower(mount: HTMLElement): Promise<void> {
  overlay?.classList.remove("hidden");
  setBootMessage("Loading physics engine…");
  const rapier = await withTimeout(
    import("@dimforge/rapier3d-compat"),
    10_000,
    "physics module load",
  );
  await withTimeout(rapier.init(), 10_000, "physics init");

  setBootMessage("Building the world…");
  const { Game } = await import("./app/game.js");
  new Game(rapier, mount).start();
  hideOverlay();
}

async function bootBuilder(mount: HTMLElement): Promise<void> {
  const { BuilderGame } = await import("./builder/builderGame.js");
  new BuilderGame(mount).start();
  hideOverlay();
}

async function boot(): Promise<void> {
  const mount = document.getElementById("app");
  if (!mount) throw new Error("missing #app mount point");

  hideOverlay(); // the mode selector is instant — no spinner needed yet
  const mode = await selectMode(document.body);
  if (mode === "tower") {
    await bootTower(mount);
  } else {
    await bootBuilder(mount);
  }
}

boot().catch((err: unknown) => {
  console.error("boot failed", err);
  showFatal("Couldn't start the game. Check your connection and try again.");
});
