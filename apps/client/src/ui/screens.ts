import type { DailyBoardEntry } from "@robo/shared";
import { formatTime } from "./hud.js";
import { keyBarHtml } from "./gameMenu.js";
import { t } from "./i18n.js";

/**
 * Title & clear overlays (DOM). The game supplies callbacks; screens never
 * reach into game state themselves.
 */
export class Screens {
  private readonly titleEl: HTMLElement;
  private readonly clearEl: HTMLElement;
  private readonly clearStats: HTMLElement;
  private readonly titleBoard: HTMLElement;
  private readonly clearBoard: HTMLElement;
  private readonly dayEl: HTMLElement;
  private readonly countdownEls: HTMLElement[];
  private readonly nameInput: HTMLInputElement;
  private lastCountdownText = "";

  constructor(
    parent: HTMLElement,
    callbacks: { onStart(name: string): void; onRestart(): void },
  ) {
    this.titleEl = document.createElement("div");
    this.titleEl.className = "screen title-screen";
    this.titleEl.innerHTML = `
      <div class="screen-card">
        <img class="brand-logo small" src="/craftyap-logo.png" alt="CraftYap" />
        <h1>Daily Tower</h1>
        <p class="daily-label"><span data-id="day">Daily Tower</span> · ${t("새 타워까지", "new tower in")} <span data-id="countdown">--:--:--</span></p>
        <p class="subtitle">${t("꼭대기의 금색 발판까지 올라가요!", "Climb to the gold pad at the top of the tower!")}</p>
        <input type="text" maxlength="16" placeholder="${t("닉네임", "Nickname")}" aria-label="${t("닉네임", "Nickname")}" data-id="name" />
        <button class="primary" data-id="start">▶ ${t("플레이", "Play")}</button>
        <div class="board" data-id="board"></div>
        <p class="help gm-keybar">${keyBarHtml([
          { keys: ["W A S D"], label: t("이동", "Move") },
          { keys: ["Space"], label: t("점프", "Jump") },
          { keys: [t("드래그", "Drag")], label: t("카메라", "Camera") },
          { keys: ["R"], label: t("다시 시작", "Respawn") },
        ])}</p>
        <p><a class="desk-link" href="/">${t("← 다른 게임 고르기", "← Choose another game")}</a></p>
      </div>`;
    parent.appendChild(this.titleEl);

    this.clearEl = document.createElement("div");
    this.clearEl.className = "screen clear-screen hidden";
    this.clearEl.innerHTML = `
      <div class="screen-card">
        <h1>🏆 ${t("완주!", "Clear!")}</h1>
        <p class="subtitle" data-id="stats"></p>
        <p class="daily-label">${t("오늘의 순위", "Today's ranking")} · ${t("새 타워까지", "new tower in")} <span data-id="countdown2">--:--:--</span></p>
        <div class="board" data-id="board"></div>
        <button class="primary" data-id="restart">↻ ${t("다시 도전", "Try again")}</button>
      </div>`;
    parent.appendChild(this.clearEl);

    const q = (root: HTMLElement, id: string) => {
      const el = root.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (!el) throw new Error(`screen element ${id} missing`);
      return el;
    };
    this.nameInput = q(this.titleEl, "name") as HTMLInputElement;
    this.clearStats = q(this.clearEl, "stats");
    this.titleBoard = q(this.titleEl, "board");
    this.clearBoard = q(this.clearEl, "board");
    this.dayEl = q(this.titleEl, "day");
    this.countdownEls = [q(this.titleEl, "countdown"), q(this.clearEl, "countdown2")];

    // remember the last nickname locally (never trust it beyond a label)
    try {
      this.nameInput.value = localStorage.getItem("robo-name") ?? "";
    } catch {
      /* storage may be unavailable — fine */
    }

    this.titleEl.querySelector('[data-id="start"]')?.addEventListener("click", () => {
      const name = this.nameInput.value.trim() || t("플레이어", "Player");
      try {
        localStorage.setItem("robo-name", name);
      } catch {
        /* ignore */
      }
      callbacks.onStart(name);
    });
    this.clearEl.querySelector('[data-id="restart"]')?.addEventListener("click", () => {
      callbacks.onRestart();
    });
  }

  setDay(dayNumber: number): void {
    this.dayEl.textContent = `Daily Tower #${dayNumber}`;
  }

  /** Cheap per-frame call — only touches the DOM when the second changes. */
  updateCountdown(msLeft: number): void {
    const total = Math.max(0, Math.floor(msLeft / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const text = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (text === this.lastCountdownText) return;
    this.lastCountdownText = text;
    for (const el of this.countdownEls) el.textContent = text;
  }

  setBoard(entries: DailyBoardEntry[]): void {
    const html =
      entries.length === 0
        ? `<div class="board-row board-empty">${t("오늘은 아직 기록이 없어요 — 1등을 차지해 봐요!", "No records yet today — go claim first place!")}</div>`
        : entries
            .slice(0, 8)
            .map(
              (e) =>
                `<div class="board-row"><span>#${e.rank}</span><span>${escapeHtml(e.name)}</span><span>${formatTime(e.timeMs)}</span></div>`,
            )
            .join("");
    this.titleBoard.innerHTML = html;
    this.clearBoard.innerHTML = html;
  }

  showTitle(): void {
    this.titleEl.classList.remove("hidden");
    this.clearEl.classList.add("hidden");
  }

  showClear(timeMs: number, falls: number, rank: number | null): void {
    this.renderClearStats(timeMs, falls, rank);
    this.titleEl.classList.add("hidden");
    this.clearEl.classList.remove("hidden");
  }

  /** The server's verdict arrived — replace the provisional stats line. */
  updateClearResult(timeMs: number, falls: number, rank: number): void {
    if (!this.clearEl.classList.contains("hidden")) {
      this.renderClearStats(timeMs, falls, rank);
    }
  }

  private renderClearStats(timeMs: number, falls: number, rank: number | null): void {
    this.clearStats.textContent =
      t(`기록 ${formatTime(timeMs)} · ${falls}번 떨어짐`, `Time ${formatTime(timeMs)} · ${falls} falls`) +
      (rank ? t(` · 오늘 ${rank}등!`, ` · #${rank} today!`) : "");
  }

  hideAll(): void {
    this.titleEl.classList.add("hidden");
    this.clearEl.classList.add("hidden");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
