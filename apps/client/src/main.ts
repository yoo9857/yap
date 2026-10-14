/**
 * Bootstrap. The mode selector shows immediately; each mode lazy-loads its
 * own bundle — the tower's Rapier WASM (~2 MB) is only fetched when the
 * tower is actually chosen, and the builder starts instantly. Failures land
 * on a fatal overlay with a retry button — a game never half-starts.
 */
import { selectMode } from "./app/modeSelect.js";
import { showHome } from "./home/home.js";
import { showArticle } from "./home/article.js";
import { showTeam } from "./home/team.js";
import "./styles/tokens.css";
import "./styles/editorial.css";

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
  const game = new Game(rapier, mount);
  // asset preload + GPU warmup happen behind the overlay so gameplay never
  // pays a first-sight shader-compile or texture-upload hitch mid-jump
  await withTimeout(game.prepare(setBootMessage), 20_000, "asset warmup").catch(() => {
    /* warmup is best-effort — a stuck asset must not block play */
  });
  game.start();
  hideOverlay();
}

async function bootBuilder(mount: HTMLElement): Promise<void> {
  const { BuilderGame } = await import("./builder/builderGame.js");
  new BuilderGame(mount).start();
  hideOverlay();
}

async function bootCraft(mount: HTMLElement): Promise<void> {
  const { CraftGame } = await import("./craft/craftGame.js");
  new CraftGame(mount).start();
  hideOverlay();
}

async function bootBattle(mount: HTMLElement): Promise<void> {
  const { BattleGame } = await import("./battle/battleGame.js");
  new BattleGame(mount).start();
  hideOverlay();
}

async function bootCinematic(mount: HTMLElement): Promise<void> {
  const { CinematicGame } = await import("./cinematic/cinematicGame.js");
  new CinematicGame(mount).start();
  hideOverlay();
}

async function boot(): Promise<void> {
  const mount = document.getElementById("app");
  if (!mount) throw new Error("missing #app mount point");

  hideOverlay();

  const params = new URLSearchParams(location.search);
  if (params.get("article") === "ai-automation") {
    showArticle(mount);
    return;
  }
  if (params.get("about") === "team") {
    showTeam(mount);
    return;
  }
  // The games are the front door. The editorial desk is still published and
  // still indexed, it just lives one click away at ?read=1 instead of taking
  // the first screen from the thing people come here to play.
  if (params.get("read") === "1") {
    showHome(mount);
    return;
  }

  if (new URLSearchParams(location.search).get("preview") === "char") {
    const { bootCharPreview } = await import("./app/charPreview.js");
    await bootCharPreview(mount);
    return;
  }

  const mode = await selectMode(document.body);
  if (mode === "tower") {
    await bootTower(mount);
  } else if (mode === "craft") {
    await bootCraft(mount);
  } else if (mode === "battle") {
    await bootBattle(mount);
  } else if (mode === "cinematic") {
    await bootCinematic(mount);
  } else {
    await bootBuilder(mount);
  }
}

boot().catch((err: unknown) => {
  console.error("boot failed", err);
  showFatal("Couldn't start the game. Check your connection and try again.");
});
