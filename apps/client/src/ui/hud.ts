import { GameMenu, type KeyHelp } from "./gameMenu.js";
import { t } from "./i18n.js";

const TOWER_KEYS = (): KeyHelp[] => [
  { keys: ["W A S D"], label: t("이동", "Move") },
  { keys: ["Space"], label: t("점프", "Jump") },
  { keys: [t("드래그", "Drag")], label: t("카메라", "Camera") },
  { keys: ["R"], label: t("다시 시작", "Respawn") },
];

export interface HudData {
  heightPercent: number;
  /** Feet height in meters — shown with the altitude-zone chip. */
  altitudeM: number;
  /** Current atmosphere band (Ground / Sky / Ozone Layer / Space). */
  zoneLabel: string;
  runTimeMs: number;
  stage: number;
  totalStages: number;
  falls: number;
  playerCount: number;
  connection: "offline" | "connecting" | "online";
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** DOM HUD — cheap text updates, no canvas involvement. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly zoneEl: HTMLElement;
  private readonly heightEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly fallsEl: HTMLElement;
  private readonly playersEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly menuBtn: HTMLButtonElement;
  readonly menu: GameMenu;
  private lastText = "";

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-top">
        <span class="hud-chip" data-id="zone">🌱 0m</span>
        <span class="hud-chip" data-id="height">0%</span>
        <span class="hud-chip" data-id="time">0:00.00</span>
        <span class="hud-chip" data-id="stage">1/4</span>
        <span class="hud-chip" data-id="falls" title="${t("떨어진 횟수", "Falls")}">💥 0</span>
        <span class="hud-chip" data-id="players">🙂 1</span>
      </div>
      <div class="hud-banner hidden" data-id="banner"></div>
    `;
    parent.appendChild(this.root);
    const q = (id: string) => {
      const el = this.root.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (!el) throw new Error(`hud element ${id} missing`);
      return el;
    };
    this.zoneEl = q("zone");
    this.heightEl = q("height");
    this.timeEl = q("time");
    this.stageEl = q("stage");
    this.fallsEl = q("falls");
    this.playersEl = q("players");
    this.bannerEl = q("banner");

    // the tower turns the camera by dragging, never captures the mouse — so
    // the menu (controls, settings, home) opens from a button or H
    this.menu = new GameMenu(parent, {
      mode: "Daily Tower",
      selfManaged: true,
      essentials: TOWER_KEYS(),
      help: [
        { title: t("움직이기", "Moving"), items: [
          { keys: ["W A S D"], label: t("이동 (모바일: 왼쪽 조이스틱)", "Move (mobile: left joystick)") },
          { keys: ["Space"], label: t("점프 (모바일: 점프 버튼)", "Jump (mobile: jump button)") },
          { keys: [t("드래그", "Drag")], label: t("카메라 돌리기", "Turn the camera") },
          { keys: ["R"], label: t("체크포인트에서 다시 시작", "Respawn at checkpoint") },
        ] },
        { title: t("규칙", "Rules"), items: [
          { keys: ["🚩"], label: t("체크포인트를 차례로 지나가요", "Pass the checkpoints in order") },
          { keys: ["🏆"], label: t("꼭대기 금색 발판에 닿으면 완주", "Touch the gold pad at the top to finish") },
          { keys: ["⏰"], label: t("한국 시간 자정마다 새 타워", "A new tower every midnight (KST)") },
        ] },
        { title: t("기타", "Other"), items: [
          { keys: ["M"], label: t("음악 켜기 / 끄기", "Music on / off") },
          { keys: ["H"], label: t("조작법 열기", "Open controls") },
          { keys: ["Esc"], label: t("메뉴 닫기", "Close the menu") },
        ] },
      ],
      onResume: () => {},
    });
    this.menuBtn = document.createElement("button");
    this.menuBtn.type = "button";
    this.menuBtn.className = "gm-menu-btn";
    this.menuBtn.dataset.id = "menu-button";
    this.menuBtn.setAttribute("aria-label", t("메뉴 열기", "Open menu"));
    this.menuBtn.textContent = "☰";
    this.menuBtn.addEventListener("click", () => this.menu.open());
    parent.appendChild(this.menuBtn);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? "" : "none";
    this.menuBtn.style.display = v ? "" : "none";
  }

  update(d: HudData): void {
    // skip DOM writes when nothing changed
    const altitude = Math.max(0, Math.round(d.altitudeM));
    const text = `${Math.round(d.heightPercent)}|${altitude}|${d.zoneLabel}|${Math.floor(d.runTimeMs / 10)}|${d.stage}|${d.falls}|${d.playerCount}|${d.connection}`;
    if (text === this.lastText) return;
    this.lastText = text;

    this.zoneEl.textContent = `${d.zoneLabel} ${altitude}m`;
    this.heightEl.textContent = `${Math.max(0, Math.min(100, Math.round(d.heightPercent)))}%`;
    this.timeEl.textContent = formatTime(d.runTimeMs);
    this.stageEl.textContent = `${d.stage}/${d.totalStages}`;
    this.fallsEl.textContent = `💥 ${d.falls}`;
    this.playersEl.textContent = `🙂 ${d.playerCount}`;

    if (d.connection === "connecting") {
      this.bannerEl.textContent = t("서버에 다시 연결하는 중… (혼자서 계속 할 수 있어요)", "Reconnecting to the server… (you can keep playing solo)");
      this.bannerEl.classList.remove("hidden");
    } else {
      this.bannerEl.classList.add("hidden");
    }
  }
}
