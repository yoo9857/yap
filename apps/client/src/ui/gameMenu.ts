import { t } from "./i18n.js";
import { keyGlyphs } from "./inputGlyphs.js";
import { SENSITIVITY_RANGE, settings, updateSettings, type Lang } from "./settings.js";
import "./gameMenu.css";

/** One row of key help: the keys (each its own <kbd>) and what they do. */
export interface KeyHelp {
  keys: string[];
  label: string;
}

export interface HelpGroup {
  title: string;
  items: KeyHelp[];
}

export interface GameMenuOptions {
  /** Mode name shown above the title, e.g. "Craft Island". */
  mode: string;
  /** The handful of keys a first-time player needs; shown on the card. */
  essentials: KeyHelp[];
  /** Every control, grouped, for the help view. */
  help: HelpGroup[];
  /** Capture the mouse / start playing (called from a click, so pointer lock is allowed). */
  onResume: () => void;
  /** Title of the very first card, before the player has started. */
  startTitle?: string;
  /** Modes without pointer lock (the tower): the menu shows and hides itself —
   *  a menu button / H opens it, Play closes it. */
  selfManaged?: boolean;
}

type View = "main" | "help" | "settings";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const kbd = keyGlyphs;

/** The always-on key strip under the hotbar: a few essentials and the way to the rest. */
export function keyBarHtml(items: KeyHelp[]): string {
  const all = [...items, { keys: ["H"], label: t("전체 조작법", "All controls") }];
  return all.map((i) => `<span class="gm-kb">${kbd(i.keys)}<span>${esc(i.label)}</span></span>`).join("");
}

/**
 * The card a player sees whenever they are not in control: before the first
 * click, and every time Esc releases the mouse. It answers the three things a
 * new player cannot otherwise find out — how to start, what the keys are, and
 * how to leave — plus the settings (sensitivity, volume, language).
 *
 * The element keeps the `craft-hint` class and its `hidden` toggle, which is
 * what the E2E suites and screenshot tools already key on.
 */
export class GameMenu {
  readonly el: HTMLElement;
  private view: View = "main";
  private started = false;
  private visible = false;
  private readonly events = new AbortController();

  constructor(parent: HTMLElement, private readonly opts: GameMenuOptions) {
    this.el = document.createElement("div");
    this.el.className = "craft-hint game-menu hidden";
    this.el.dataset.id = "game-menu";
    this.el.innerHTML = this.html();
    parent.appendChild(this.el);
    this.bind();
    this.setView("main");
  }

  private html(): string {
    const o = this.opts;
    const groups = o.help.map((g) => `
      <div class="gm-group"><h3>${esc(g.title)}</h3>
        <dl>${g.items.map((i) => `<div><dt><span class="gm-pic">${kbd(i.keys)}</span></dt><dd>${esc(i.label)}</dd></div>`).join("")}</dl>
      </div>`).join("");
    const pct = (v: number) => Math.round(v * 100);
    const lang = (code: Lang, label: string) =>
      `<button type="button" class="gm-seg${settings.lang === code ? " on" : ""}" data-lang="${code}" aria-pressed="${settings.lang === code}">${label}</button>`;
    return `
      <div class="gm-card" role="dialog" aria-labelledby="gm-title">
        <section data-view="main">
          <p class="gm-kicker">${esc(o.mode)}</p>
          <h2 id="gm-title" data-id="gm-title"></h2>
          <ul class="gm-keys">${o.essentials.map((i) => `<li><span class="gm-pic">${kbd(i.keys)}</span><span class="gm-cap">${esc(i.label)}</span></li>`).join("")}</ul>
          <button type="button" class="gm-play" data-id="gm-play">▶ ${o.selfManaged ? t("계속하기", "Resume") : t("플레이", "Play")}</button>
          <div class="gm-row">
            <button type="button" data-go="help" data-id="gm-help">⌨️ ${t("조작법", "Controls")}</button>
            <button type="button" data-go="settings" data-id="gm-settings">⚙️ ${t("설정", "Settings")}</button>
            <a href="/" data-id="gm-home">🏠 ${t("처음으로", "Home")}</a>
          </div>
          <p class="gm-note">${o.selfManaged
            ? t("☰ 버튼이나 H 키로 언제든 이 메뉴를 열 수 있어요.", "Open this menu any time with ☰ or H.")
            : t("플레이 중에 Esc를 누르면 마우스가 풀리고 이 메뉴가 열려요.", "Press Esc while playing to free the mouse and open this menu.")}</p>
        </section>
        <section data-view="help" hidden>
          <h2>⌨️ ${t("조작법", "Controls")}</h2>
          <div class="gm-groups">${groups}</div>
          <button type="button" class="gm-back" data-go="main">← ${t("돌아가기", "Back")}</button>
        </section>
        <section data-view="settings" hidden>
          <h2>⚙️ ${t("설정", "Settings")}</h2>
          <label class="gm-slider"><span>${t("마우스 감도", "Mouse sensitivity")} <output data-out="sensitivity">${settings.sensitivity.toFixed(1)}</output></span>
            <input type="range" data-set="sensitivity" min="${SENSITIVITY_RANGE.min}" max="${SENSITIVITY_RANGE.max}" step="0.1" value="${settings.sensitivity}" /></label>
          <label class="gm-slider"><span>${t("배경 음악", "Music")} <output data-out="music">${pct(settings.music)}%</output></span>
            <input type="range" data-set="music" min="0" max="1" step="0.05" value="${settings.music}" /></label>
          <label class="gm-slider"><span>${t("효과음", "Sound effects")} <output data-out="sfx">${pct(settings.sfx)}%</output></span>
            <input type="range" data-set="sfx" min="0" max="1" step="0.05" value="${settings.sfx}" /></label>
          <div class="gm-lang"><span>${t("언어", "Language")}</span><div>${lang("ko", "한국어")}${lang("en", "English")}</div></div>
          <p class="gm-note">${t("M 키로 음악을 바로 켜고 끌 수 있어요.", "M toggles the music at any time.")}</p>
          <button type="button" class="gm-back" data-go="main">← ${t("돌아가기", "Back")}</button>
        </section>
      </div>`;
  }

  private bind(): void {
    const signal = this.events.signal;
    // The card sits over the game; nothing on it may reach the canvas. (The dim
    // layer around it passes clicks through, so clicking the scene still plays.)
    this.el.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const go = target.closest<HTMLElement>("[data-go]")?.dataset.go as View | undefined;
      if (go) return this.setView(go);
      const lang = target.closest<HTMLElement>("[data-lang]")?.dataset.lang as Lang | undefined;
      if (lang) {
        if (lang !== settings.lang) {
          updateSettings({ lang });
          location.reload();
        }
        return;
      }
      // "click to start": anywhere on the card that is not one of its controls plays
      if (target.closest("[data-id=gm-play]") || !target.closest("button, a, input, label, [data-view=help], [data-view=settings]")) {
        if (this.opts.selfManaged) this.close();
        this.opts.onResume();
      }
    }, { signal });
    for (const ev of ["mousedown", "mouseup", "pointerdown", "wheel", "contextmenu"] as const) {
      this.el.addEventListener(ev, (e) => e.stopPropagation(), { signal });
    }
    // the track fills up to the thumb (CSS reads --p)
    const fill = (input: HTMLInputElement) =>
      input.style.setProperty("--p", `${((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
    this.el.querySelectorAll<HTMLInputElement>("input[data-set]").forEach((input) => {
      fill(input);
      input.addEventListener("input", () => {
        fill(input);
        const key = input.dataset.set as "sensitivity" | "music" | "sfx";
        const value = Number(input.value);
        updateSettings({ [key]: value });
        const out = this.el.querySelector(`[data-out="${key}"]`);
        if (out) out.textContent = key === "sensitivity" ? value.toFixed(1) : `${Math.round(value * 100)}%`;
      }, { signal });
    });
    document.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
      if (tag === "TEXTAREA") return;
      if (e.key === "Escape" && this.visible && this.view !== "main") {
        this.setView("main");
      } else if (e.key === "Escape" && this.visible && this.opts.selfManaged) {
        this.close();
      } else if (e.key.toLowerCase() === "h" && !e.ctrlKey && !e.metaKey && !e.repeat) {
        if (this.visible && this.view === "help") this.setView("main");
        else this.openHelp();
      }
    }, { signal });
  }

  private setView(view: View): void {
    this.view = view;
    this.el.querySelectorAll<HTMLElement>("[data-view]").forEach((s) => (s.hidden = s.dataset.view !== view));
    const title = this.el.querySelector('[data-id="gm-title"]');
    const play = this.el.querySelector('[data-id="gm-play"]');
    if (play && this.started) play.textContent = `▶ ${t("계속하기", "Resume")}`;
    if (title) title.textContent = this.opts.selfManaged ? t("메뉴", "Menu") : this.started ? t("일시정지", "Paused") : (this.opts.startTitle ?? t("클릭해서 시작", "Click to start"));
  }

  /** Show the full control list, freeing the mouse if the player was in play. */
  openHelp(): void {
    this.setView("help");
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.opts.selfManaged) this.open("help");
  }

  /** Self-managed modes: show the card (on the main view unless told otherwise). */
  open(view: View = "main"): void {
    this.started = true;
    this.visible = true;
    this.el.classList.remove("hidden");
    this.setView(view);
  }

  close(): void {
    this.visible = false;
    this.el.classList.add("hidden");
    this.setView("main");
  }

  /** The game decides when the card may show (not in play, no other panel open). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.el.classList.toggle("hidden", !visible);
    if (!visible && document.pointerLockElement) {
      // back in play: the next pause opens on the main card, titled "paused"
      this.started = true;
      this.setView("main");
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    this.events.abort();
    this.el.remove();
  }
}
