import { t } from "../ui/i18n.js";

const BASE = "/backgrounds/craftyap-sunny-village-alive-v1-";
const PAUSE_KEY = "craftyap-menu-motion-paused";

/** One shared decoder for the picker, classroom and loader; none during play. */
export function initMenuBackground(): void {
  const layer = document.getElementById("menu-backdrop");
  const video = document.querySelector<HTMLVideoElement>("#menu-background-video");
  const toggle = document.querySelector<HTMLButtonElement>("#menu-motion-toggle");
  const overlay = document.getElementById("boot-overlay");
  if (!layer || !video || !toggle) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const mobile = matchMedia("(max-width: 767px), (max-height: 480px)");
  const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
  let userPaused = false;
  try { userPaused = localStorage.getItem(PAUSE_KEY) === "1"; } catch { /* storage is optional */ }
  let ready = false;
  let failed = false;
  let gestureNeeded = false;
  let pendingPlay = false;
  let revision = 0;
  let size = "";
  let format = "";
  let frame = 0;
  let releaseTimer = 0;
  // the game never goes back to the menu without a reload, so once play has
  // begun every listener and the body observer below are dropped for good
  const events = new AbortController();
  const signal = events.signal;

  video.muted = video.defaultMuted = true;
  // The whole way from the picker to the first game frame counts as "menu": the
  // picker, lobby and loader replace each other with a gap while a chunk loads,
  // and dropping the video in that gap flashed the plain sky colour.
  const menuVisible = () => !document.body.classList.contains("in-game") || (!!overlay && !overlay.classList.contains("hidden"));
  const allowed = () => !reduced.matches && !connection?.saveData;

  function release(): void {
    revision++;
    video!.pause();
    if (video!.hasAttribute("src")) {
      video!.removeAttribute("src");
      video!.load();
    }
    size = format = "";
    ready = pendingPlay = false;
    document.body.classList.remove("menu-video-ready");
  }

  function play(): void {
    if (pendingPlay || !video!.paused || userPaused || gestureNeeded) return;
    pendingPlay = true;
    const attempt = revision;
    void video!.play().catch((error: unknown) => {
      if (attempt !== revision) return;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        gestureNeeded = true;
        schedule();
      }
      // Source changes can abort play; media errors are handled by `error`.
    }).finally(() => { if (attempt === revision) pendingPlay = false; });
  }

  function load(nextSize: string, nextFormat: string): void {
    revision++;
    ready = pendingPlay = false;
    size = nextSize;
    format = nextFormat;
    video!.src = `${BASE}${size}.${format}`;
    document.body.classList.remove("menu-video-ready");
    play();
  }

  function update(): void {
    frame = 0;
    const visible = menuVisible();
    const active = visible && allowed() && !document.hidden && !failed;
    layer!.hidden = !active;
    toggle!.hidden = !active;
    const paused = userPaused || gestureNeeded;
    toggle!.textContent = paused ? t("배경 재생", "Play background") : t("배경 멈추기", "Pause background");
    toggle!.setAttribute("aria-pressed", String(userPaused));
    toggle!.setAttribute("aria-label", paused ? t("배경 애니메이션 재생", "Play background animation") : t("배경 애니메이션 멈추기", "Pause background animation"));
    document.body.classList.toggle("menu-video-ready", active && ready);
    if (!active) {
      video!.pause();
      if (!allowed() || failed) {
        release();
        if (!visible) retire();
      } else if (!visible && !releaseTimer) releaseTimer = window.setTimeout(() => {
        releaseTimer = 0;
        if (!menuVisible()) {
          release();
          retire();
        }
      }, 250);
      return;
    }
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    if (userPaused) { video!.pause(); return; }
    const nextSize = mobile.matches ? "mobile" : "desktop";
    if (!video!.hasAttribute("src") || nextSize !== size) {
      load(nextSize, video!.canPlayType('video/webm; codecs="vp9"') ? "webm" : "mp4");
    } else play();
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function retire(): void {
    events.abort();
    observer.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
  }

  video.addEventListener("playing", () => { ready = true; schedule(); }, { signal });
  video.addEventListener("error", () => {
    if (!video.hasAttribute("src")) return;
    if (format === "webm" && allowed() && menuVisible()) load(size, "mp4");
    else { failed = true; schedule(); }
  }, { signal });
  toggle.addEventListener("click", () => {
    userPaused = gestureNeeded ? false : !userPaused;
    gestureNeeded = false;
    try { localStorage.setItem(PAUSE_KEY, userPaused ? "1" : "0"); } catch { /* optional */ }
    // Stay in the click's activation context on browsers that require a gesture.
    update();
  }, { signal });
  const retryGesture = (event: Event) => {
    if (event.target instanceof Node && toggle.contains(event.target)) return;
    if (gestureNeeded && !userPaused && allowed() && menuVisible()) {
      gestureNeeded = false;
      play();
      schedule();
    }
  };
  document.addEventListener("pointerdown", retryGesture, { passive: true, signal });
  document.addEventListener("keydown", retryGesture, { signal });
  // Hidden tabs suspend animation frames; pause synchronously on this event.
  document.addEventListener("visibilitychange", () => { cancelAnimationFrame(frame); update(); }, { signal });
  reduced.addEventListener("change", schedule, { signal });
  mobile.addEventListener("change", schedule, { signal });
  connection?.addEventListener("change", schedule, { signal });
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, attributes: true, attributeFilter: ["class"] });
  if (overlay) observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
  schedule();
}
