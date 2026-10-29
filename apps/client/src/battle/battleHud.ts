import { MAX_HP } from "./combat.js";
import { GameMenu, keyBarHtml, type KeyHelp } from "../ui/gameMenu.js";
import { t } from "../ui/i18n.js";
import { KEY_WASD, MOUSE_LEFT, MOUSE_MOVE } from "../ui/inputGlyphs.js";

const ESSENTIALS = (): KeyHelp[] => [
  { keys: [KEY_WASD], label: t("걷기", "Walk") },
  { keys: ["Shift"], label: t("달리기", "Run") },
  { keys: ["Space"], label: t("점프", "Jump") },
  { keys: [MOUSE_LEFT], label: t("꾹 눌러 발사", "Hold to fire") },
  { keys: ["V"], label: t("시점 전환", "Switch view") },
];

/**
 * Battle-mode DOM UI: crosshair + hit marker, hearts, alive counter, storm
 * timer, kill feed, damage/storm vignettes, the start/pause menu and the
 * end-of-match card.
 */
export class BattleHud {
  private readonly root: HTMLElement;
  private readonly hearts: HTMLElement;
  private readonly aliveEl: HTMLElement;
  private readonly zoneEl: HTMLElement;
  private readonly warnEl: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly damageFx: HTMLElement;
  private readonly stormFx: HTMLElement;
  private readonly endCard: HTMLElement;
  readonly menu: GameMenu;
  private lastKey = "";
  private markerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, onResume: () => void) {
    this.root = document.createElement("div");
    this.root.className = "battle-hud";
    this.root.innerHTML = `
      <div class="craft-crosshair" data-id="crosshair">+</div>
      <div class="battle-marker hidden" data-id="marker">✕</div>
      <div class="battle-top">
        <span class="hud-chip" data-id="alive" title="${t("남은 로봇", "Robots left")}">🤖 8</span>
        <span class="hud-chip" data-id="zone">☁️</span>
      </div>
      <div class="battle-warn hidden" data-id="warn">⚠️ ${t("폭풍 밖이에요! 안전 구역 안으로 들어가요", "Outside the storm! Get back inside the safe zone")}</div>
      <div class="battle-hearts" data-id="hearts"></div>
      <div class="battle-feed" data-id="feed"></div>
      <div class="craft-help gm-keybar">${keyBarHtml(ESSENTIALS())}</div>
    `;
    parent.appendChild(this.root);
    const q = (id: string) => this.root.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    this.hearts = q("hearts");
    this.aliveEl = q("alive");
    this.zoneEl = q("zone");
    this.warnEl = q("warn");
    this.feed = q("feed");
    this.marker = q("marker");

    this.damageFx = document.createElement("div");
    this.damageFx.className = "battle-damage-fx";
    parent.appendChild(this.damageFx);
    this.stormFx = document.createElement("div");
    this.stormFx.className = "battle-storm-fx";
    parent.appendChild(this.stormFx);

    this.endCard = document.createElement("div");
    this.endCard.className = "screen battle-end hidden";
    parent.appendChild(this.endCard);

    this.menu = new GameMenu(parent, {
      mode: "Blast Royale",
      startTitle: t("클릭해서 전투 시작", "Click to fight"),
      essentials: ESSENTIALS(),
      help: [
        {
          title: t("움직이기", "Moving"),
          items: [
            { keys: [KEY_WASD], label: t("걷기", "Walk") },
            { keys: ["Shift"], label: t("달리기", "Run") },
            { keys: ["Space"], label: t("점프", "Jump") },
            { keys: [MOUSE_MOVE], label: t("조준하기", "Aim") },
            { keys: ["V"], label: t("1인칭 / 3인칭 시점", "First / third person") },
          ],
        },
        {
          title: t("전투", "Fighting"),
          items: [
            { keys: [MOUSE_LEFT], label: t("꾹 눌러 블래스터 발사", "Hold to fire the blaster") },
            { keys: ["❤️"], label: t("세 번 맞으면 탈락", "Three hits and you're out") },
            { keys: ["🌀"], label: t("폭풍 밖에 있으면 체력이 줄어요", "The storm hurts outside the safe zone") },
          ],
        },
        {
          title: t("규칙", "Rules"),
          items: [
            { keys: ["🤖"], label: t("로봇 7대와 겨뤄 마지막까지 살아남기", "Outlast the 7 robots") },
            { keys: ["⏱"], label: t("시작 후 4초 동안은 아무도 쏠 수 없어요", "Nobody can fire for the first 4 seconds") },
          ],
        },
        {
          title: t("기타", "Other"),
          items: [
            { keys: ["M"], label: t("음악 켜기 / 끄기", "Music on / off") },
            { keys: ["H"], label: t("조작법 열기", "Open controls") },
            { keys: ["Esc"], label: t("마우스 풀기 · 메뉴", "Free mouse · menu") },
          ],
        },
      ],
      onResume,
    });
  }

  /** Out of play and the match still running: the start/pause card shows. */
  syncMenu(locked: boolean, live: boolean): void {
    this.menu.setVisible(!locked && live);
  }

  update(hp: number, aliveBots: number, zoneLabel: string, outside: boolean): void {
    const key = `${hp}|${aliveBots}|${zoneLabel}|${outside}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.hearts.textContent = "❤️".repeat(Math.max(0, hp)) + "🤍".repeat(Math.max(0, MAX_HP - hp));
    this.aliveEl.textContent = `🤖 ${aliveBots + (hp > 0 ? 1 : 0)}`;
    this.zoneEl.textContent = zoneLabel;
    const danger = outside && hp > 0;
    this.zoneEl.classList.toggle("danger", danger);
    this.warnEl.classList.toggle("hidden", !danger);
    this.stormFx.classList.toggle("active", danger);
  }

  hitMarker(kill: boolean): void {
    this.marker.classList.remove("hidden");
    this.marker.classList.toggle("kill", kill);
    if (this.markerTimer) clearTimeout(this.markerTimer);
    this.markerTimer = setTimeout(() => this.marker.classList.add("hidden"), 140);
  }

  damageFlash(): void {
    this.damageFx.classList.remove("active");
    void this.damageFx.offsetWidth; // restart the CSS animation
    this.damageFx.classList.add("active");
  }

  addFeed(text: string): void {
    const row = document.createElement("div");
    row.textContent = text;
    this.feed.prepend(row);
    while (this.feed.children.length > 4) this.feed.lastChild?.remove();
    setTimeout(() => row.remove(), 5000);
  }

  showEnd(won: boolean, aliveBots: number): void {
    this.endCard.classList.remove("hidden");
    this.endCard.innerHTML = `
      <div class="screen-card">
        <h1>${won ? "🏆 VICTORY ROYALE!" : `💥 ${t("탈락!", "ELIMINATED")}`}</h1>
        <p class="subtitle">${won
          ? t("마지막까지 살아남은 로봇이 됐어요!", "Last robot standing.")
          : t(`아직 로봇 ${aliveBots}대가 남아 있어요.`, `${aliveBots} robot${aliveBots === 1 ? "" : "s"} remaining.`)}</p>
        <button class="primary" data-id="again">${t("다시 하기", "Play again")}</button>
        <p><a class="desk-link" href="/">${t("← 처음 화면으로", "← Home")}</a></p>
      </div>`;
    this.endCard.querySelector('[data-id="again"]')?.addEventListener("click", () => {
      location.href = "/?mode=battle";
    });
    document.exitPointerLock();
  }
}
