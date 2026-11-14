/**
 * Bootstrap. The mode selector shows immediately; each mode lazy-loads its
 * own bundle — the tower's Rapier WASM (~2 MB) is only fetched when the
 * tower is actually chosen, and the builder starts instantly. Failures land
 * on a fatal overlay with a retry button — a game never half-starts.
 */
import { selectMode } from "./app/modeSelect.js";
import { initMenuBackground } from "./app/menuBackground.js";
import { t } from "./ui/i18n.js";
import type { ClassEntry } from "./app/classLobby.js";
import type { ClassTheme } from "@robo/shared";

const overlay = document.getElementById("boot-overlay");
const messageEl = document.getElementById("boot-message");
const retryBtn = document.getElementById("boot-retry");
const fillEl = document.getElementById("boot-fill");
const tipEl = document.getElementById("boot-tip");
initMenuBackground();
if (retryBtn) retryBtn.textContent = t("다시 시도", "Retry");

/** Loading steps reported so far; the brick bar creeps toward full with each one. */
let bootSteps = 0;
function setBootMessage(text: string): void {
  if (messageEl) messageEl.textContent = text;
  bootSteps++;
  if (fillEl) fillEl.style.width = `${Math.round((1 - 0.62 ** bootSteps) * 100)}%`;
}

/** One random tip under the bar while a voxel mode loads. */
function showTip(): void {
  if (!tipEl) return;
  const tips = [
    t("💡 Q를 누르면 빈손이 돼요. 블록을 실수로 놓지 않고 캘 수 있어요.", "💡 Q empties your hands: mine without placing by accident."),
    t("💡 C로 감정표현을 고르고, Z로 기어갈 수 있어요.", "💡 C picks an emote; Z crawls."),
    t("💡 B를 누르면 기계 작업실에서 자동차와 비행기를 만들 수 있어요.", "💡 B opens the machine lab: build cars and planes."),
    t("💡 G를 누르면 가구를 놓을 수 있어요. 가구는 무료로 무제한!", "💡 G places furniture — free and unlimited."),
    t("💡 Y로 반려동물을 입양하고, P로 앉혀 둘 수 있어요.", "💡 Y adopts a pet; P tells it to sit."),
    t("💡 H를 누르면 언제든 전체 조작법을 볼 수 있어요.", "💡 H shows every control, any time."),
  ];
  tipEl.textContent = tips[Math.floor(Math.random() * tips.length)]!;
  tipEl.hidden = false;
}

function showFatal(text: string): void {
  setBootMessage(text);
  overlay?.classList.add("error");
  overlay?.classList.remove("hidden");
}

function hideOverlay(): void {
  if (fillEl && bootSteps > 0) fillEl.style.width = "100%";
  overlay?.classList.add("hidden");
}

retryBtn?.addEventListener("click", () => window.location.reload());

// A tab left open across a deploy still points at the old build's chunk names,
// which are gone: picking a mode then failed with "check your connection".
// Reload once onto the new build instead (at most once a minute, so a real
// network failure still reaches the retry card).
window.addEventListener("vite:preloadError", (event) => {
  if (document.body.classList.contains("in-game")) return;
  const key = "craftyap-chunk-reload";
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return; // no way to remember the attempt: never risk a reload loop
  }
  event.preventDefault();
  window.location.reload();
});

// A GPU reset takes the WebGL context away; three.js asks for it back and the
// browser usually restores it within a moment. When it never comes back the
// canvas just freezes, so after a grace period say so and offer the reload.
let contextLostTimer = 0;
document.addEventListener("webglcontextlost", () => {
  clearTimeout(contextLostTimer);
  contextLostTimer = window.setTimeout(() => {
    showFatal(t("그래픽 연결이 끊겼어요. 다시 시도하면 이어서 할 수 있어요.", "The graphics connection was lost. Try again to carry on."));
  }, 5000);
}, true);
document.addEventListener("webglcontextrestored", () => clearTimeout(contextLostTimer), true);

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
  setBootMessage(t("물리 엔진 불러오는 중…", "Loading physics engine…"));
  const rapier = await withTimeout(
    import("@dimforge/rapier3d-compat"),
    10_000,
    "physics module load",
  );
  await withTimeout(rapier.init(), 10_000, "physics init");

  setBootMessage(t("세상을 만드는 중…", "Building the world…"));
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

async function bootCraft(mount: HTMLElement, field = false, classroom: ClassEntry | null = null, theme: ClassTheme = "craft"): Promise<void> {
  overlay?.classList.remove("hidden");
  setBootMessage(t("세상을 만드는 중…", "Building the world…"));
  // the fire drill is its own download: only for the theme that plays it (fire/fireKit.ts)
  const [{ CraftGame }, fireKit, { primeMaterialMaps }] = await Promise.all([import("./craft/craftGame.js"), theme === "fire" ? import("./craft/fire/fireKit.js") : undefined, import("./craft/blockMaterials.js")]);
  // the blocks' surface maps, worked out a few at a time before the game is built (it asks for all of them at once)
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r));
  await primeMaterialMaps(pause);
  await fireKit?.primeFire(pause); // and what the drill works out once (its fire and smoke maps, its signs)
  // ?engine=rust: solo water runs in the Rust engine (docs/ENGINE.md). A browser that cannot load
  // it plays on the TypeScript rules — the same water — rather than not at all.
  let rust = null;
  if (!classroom && new URLSearchParams(location.search).get("engine") === "rust") {
    const { loadRustEngine } = await import("./engine/rustEngine.js");
    rust = await loadRustEngine().catch((err: unknown) => { console.warn("Rust engine unavailable, using TypeScript", err); return null; });
  }
  const game = new CraftGame(mount, { field, classroom: classroom ?? undefined, rust, theme, fireKit });
  // shaders and uploads behind the overlay, so play never opens slow and
  // catches up (see warmupGpuAsync); best-effort — never block play on it
  await withTimeout(game.prepare(setBootMessage), 20_000, "graphics warmup").catch(() => {});
  game.start();
  hideOverlay();
}

async function bootBattle(mount: HTMLElement): Promise<void> {
  overlay?.classList.remove("hidden");
  setBootMessage(t("섬을 만드는 중…", "Building the island…"));
  const { BattleGame } = await import("./battle/battleGame.js");
  const game = new BattleGame(mount);
  await withTimeout(game.prepare(setBootMessage), 20_000, "graphics warmup").catch(() => {});
  game.start();
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
  // Retired editorial URLs also open the games. They share the homepage's
  // canonical URL and must not serve unrelated income guides to crawlers.

  if (new URLSearchParams(location.search).get("preview") === "char") {
    document.getElementById("mode-select")?.remove();
    const { bootCharPreview } = await import("./app/charPreview.js");
    await bootCharPreview(mount);
    // like any mode: the menu art and video otherwise stay over the turntable
    document.body.classList.add("in-game");
    window.dispatchEvent(new Event("craftyap:playing")); // deferred downloads (the other character) may start
    return;
  }

  if (!params.has("mode")) {
    // fetch the education lobby while the picker is up, so choosing it is instant
    const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 1500));
    idle(() => void import("./app/classLobby.js").catch(() => {}));
  }
  const mode = await selectMode(document.body);
  // Start the HOME character download now, in the background: it overlaps the
  // class lobby instead of covering it. Every mode waits for it below, before
  // any rig is built (a failed download falls back to the built-in mascot).
  const characters = import("./player/rig.js")
    .then(({ preloadCharacter }) => withTimeout(preloadCharacter(), 12_000, "character assets"))
    .catch(() => {});
  let classroom: ClassEntry | null = null;
  // the learning theme: a class has its own; solo play picks one (deep link: &theme=fire)
  let theme: ClassTheme = "craft";
  if (mode === "field") {
    // a deep link plays solo unless it names a class (?host= / ?teacher=&student=);
    // from the menu, education mode asks: teacher, student or solo
    const { chooseClass, classFromUrl } = await import("./app/classLobby.js");
    if (params.get("mode") === "field") {
      classroom = await classFromUrl();
      theme = classroom?.session.theme ?? (params.get("theme") === "fire" ? "fire" : "craft");
    } else {
      const choice = await chooseClass(document.body);
      classroom = choice.classroom;
      theme = choice.theme;
    }
  }
  overlay?.classList.remove("hidden");
  if (mode === "craft" || mode === "field") showTip();
  setBootMessage(t("캐릭터 불러오는 중…", "Loading characters…"));
  await characters;
  if (mode === "tower") {
    await bootTower(mount);
  } else if (mode === "craft") {
    await bootCraft(mount);
  } else if (mode === "field") {
    await bootCraft(mount, true, classroom, theme);
  } else if (mode === "battle") {
    await bootBattle(mount);
  } else if (mode === "cinematic") {
    await bootCinematic(mount);
  } else {
    await bootBuilder(mount);
  }
  // the menu art and its video are released once a game is on screen
  document.body.classList.add("in-game");
  window.dispatchEvent(new Event("craftyap:playing")); // deferred downloads (the other character) may start
}

/** Can this browser draw 3D at all? (Hardware acceleration off, or a blocked old GPU, says no.) */
function hasWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

boot().catch((err: unknown) => {
  console.error("boot failed", err);
  // "check your connection" sent people hunting a network problem on PCs that simply cannot draw 3D
  showFatal(hasWebGl()
    ? t("게임을 시작하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.", "Couldn't start the game. Check your connection and try again.")
    : t("이 컴퓨터의 브라우저에서 3D 그래픽(WebGL)을 쓸 수 없어요. 브라우저 설정에서 '하드웨어 가속'을 켜거나 최신 Chrome·Edge로 열어 주세요.",
      "This browser can't draw 3D graphics (WebGL). Turn on hardware acceleration in the browser settings, or open the game in an up-to-date Chrome or Edge."));
});
