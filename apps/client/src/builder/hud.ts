import {
  MAX_VISUAL_WORKERS,
  currentLandmarkTotal,
  itemCost,
  voxelsPerSecond,
  type BuilderState,
  type ShopItem,
} from "./state.js";
import { goalAt, goalProgress } from "./goals.js";
import { LANDMARKS, landmarkAt, tourOf } from "./landmarks.js";
import type { OfflineGains } from "./sim.js";
import type { Goal } from "./goals.js";
import type { Landmark } from "./landmarks.js";
import { GameMenu } from "../ui/gameMenu.js";
import { isEnglish, t } from "../ui/i18n.js";

/** Korean landmark names and countries, by landmark id (the data stays English). */
const LANDMARK_KO: Record<string, [string, string]> = {
  pyramid: ["기자의 대피라미드", "이집트"],
  bigben: ["빅 벤", "영국"],
  pisa: ["피사의 사탑", "이탈리아"],
  eiffel: ["에펠탑", "프랑스"],
  colosseum: ["콜로세움", "이탈리아"],
  namsan: ["N서울타워", "대한민국"],
  liberty: ["자유의 여신상", "미국"],
};
export const landmarkName = (lm: Landmark): string => (isEnglish() ? lm.name : (LANDMARK_KO[lm.id]?.[0] ?? lm.name));

/** A goal's line in the player's language. Goals are data (and unit-tested in
 *  English), so Korean is derived from the kind and target, not stored. */
export function goalTitle(goal: Goal): string {
  if (isEnglish()) return goal.title;
  switch (goal.kind) {
    case "blocks": return `블록 ${goal.target}개 놓기`;
    case "workers": return `일꾼 ${goal.target}명 모으기`;
    case "valueLevel": return `블록 가치 Lv ${goal.target}까지 올리기`;
    case "speedLevel": return `신발 Lv ${goal.target}까지 올리기`;
    case "crane": return "🏗️ 크레인 설치하기";
    case "landmark": {
      const index = goal.target - 1;
      const lm = landmarkAt(index);
      const tour = tourOf(index);
      return `${lm.emoji} ${landmarkName(lm)} 완성하기${tour > 0 ? ` (${tour + 1}바퀴째)` : ` (${LANDMARK_KO[lm.id]?.[1] ?? lm.country})`}`;
    }
  }
}

/** What the camera is actually showing (lags the sim during the parade). */
export interface HudView {
  landmarkIndex: number;
  /** True while the completed monument is being admired. */
  parade: boolean;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.floor(n));
}

const SHOP_META: { item: ShopItem; icon: string; label: (s: BuilderState) => string; tip: () => string }[] = [
  { item: "worker", icon: "/ui/icon-worker.png", label: (s) => t(`일꾼 ×${s.workers}`, `Workers ×${s.workers}`), tip: () => t("일꾼을 한 명 더 고용해요", "Hire one more worker") },
  { item: "speed", icon: "/ui/icon-speed.png", label: (s) => t(`신발 Lv${s.speedLevel}`, `Speed Lv${s.speedLevel}`), tip: () => t("일꾼이 더 빨리 걸어요", "Workers walk faster") },
  { item: "value", icon: "/ui/icon-value.png", label: (s) => t(`블록 가치 Lv${s.valueLevel}`, `Value Lv${s.valueLevel}`), tip: () => t("블록 하나당 골드가 늘어요", "More gold per block") },
  { item: "crane", icon: "/ui/icon-crane.png", label: (s) => (s.crane ? t("크레인 준비 완료", "Crane ready") : t("크레인", "Crane")), tip: () => t("짐 싣는 속도 2배", "2× loading speed") },
];

/** Crane appears in the shop once the quest chain introduces it. */
const CRANE_GOAL_INDEX = 6;

/**
 * Builder-mode DOM UI: gold counter (with gain pulse), the always-visible
 * goal card + progress bar, the shop bar, and the welcome-back modal.
 */
export class BuilderHud {
  private readonly root: HTMLElement;
  private readonly goldEl: HTMLElement;
  private readonly rateEl: HTMLElement;
  private readonly goalTitleEl: HTMLElement;
  private readonly goalBarEl: HTMLElement;
  private readonly goalCountEl: HTMLElement;
  private readonly goalRewardEl: HTMLElement;
  private readonly floorsEl: HTMLElement;
  private readonly boostEl: HTMLElement;
  private readonly shopButtons = new Map<ShopItem, HTMLButtonElement>();
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRender = "";
  readonly menu: GameMenu;

  constructor(
    parent: HTMLElement,
    private readonly onBuy: (item: ShopItem) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "builder-hud";
    this.root.innerHTML = `
      <div class="b-top">
        <div class="b-gold"><img class="ui-icon" src="/ui/icon-gold.png" alt="" /><span data-id="gold">0</span> ${t("골드", "Gold")}</div>
        <div class="b-sub"><span data-id="floors"></span></div>
        <div class="b-sub"><span data-id="rate"></span></div>
      </div>
      <div class="b-goal">
        <div class="b-goal-head">
          <span><img class="ui-icon" src="/ui/icon-goal.png" alt="" /><span data-id="goal-title"></span></span>
          <span class="b-goal-reward" data-id="goal-reward"></span>
        </div>
        <div class="b-goal-bar"><div class="b-goal-fill" data-id="goal-fill"></div></div>
        <div class="b-goal-count" data-id="goal-count"></div>
      </div>
      <div class="b-shop" data-id="shop"></div>
      <div class="b-boost" data-id="boost" hidden></div>
    `;
    parent.appendChild(this.root);

    const q = (id: string) => {
      const el = this.root.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (!el) throw new Error(`builder hud element ${id} missing`);
      return el;
    };
    this.goldEl = q("gold");
    this.rateEl = q("rate");
    this.floorsEl = q("floors");
    this.goalTitleEl = q("goal-title");
    this.goalBarEl = q("goal-fill");
    this.goalCountEl = q("goal-count");
    this.goalRewardEl = q("goal-reward");
    this.boostEl = q("boost");

    const shop = q("shop");
    for (const meta of SHOP_META) {
      const btn = document.createElement("button");
      btn.className = "b-shop-btn";
      btn.addEventListener("click", () => this.onBuy(meta.item));
      shop.appendChild(btn);
      this.shopButtons.set(meta.item, btn);
    }

    // an idle game has no pointer lock: the menu opens from a button or H
    this.menu = new GameMenu(parent, {
      mode: "Robo Builder",
      selfManaged: true,
      essentials: [
        { keys: ["💰"], label: t("골드가 저절로 모여요", "Gold comes in by itself") },
        { keys: ["👷"], label: t("일꾼을 고용해요", "Hire workers") },
        { keys: ["⬆️"], label: t("업그레이드로 더 빨리", "Upgrade to build faster") },
        { keys: ["🏛️"], label: t("랜드마크를 완성해요", "Finish each landmark") },
      ],
      help: [
        { title: t("어떻게 하나요?", "How it works"), items: [
          { keys: ["💰"], label: t("로봇 일꾼이 블록을 나르면 골드가 들어와요", "Gold arrives as the robots carry blocks") },
          { keys: ["👷"], label: t("일꾼이 많을수록 빨리 지어요", "More workers build faster") },
          { keys: ["👟"], label: t("신발: 일꾼이 더 빨리 걸어요", "Shoes: workers walk faster") },
          { keys: ["💎"], label: t("블록 가치: 블록마다 골드가 늘어요", "Value: more gold per block") },
          { keys: ["🏗️"], label: t("크레인: 짐 싣는 속도 2배", "Crane: 2× loading speed") },
        ] },
        { title: t("알아 두면 좋아요", "Good to know"), items: [
          { keys: ["🎯"], label: t("위쪽 목표를 끝내면 보너스 골드", "Finish the goal at the top for bonus gold") },
          { keys: ["💤"], label: t("게임을 꺼 둔 동안에도 일꾼은 계속 지어요", "Your crew keeps building while you're away") },
          { keys: ["💾"], label: t("진행은 이 브라우저에 자동 저장돼요", "Progress saves in this browser") },
        ] },
        { title: t("기타", "Other"), items: [
          { keys: ["M"], label: t("음악 켜기 / 끄기", "Music on / off") },
          { keys: ["H"], label: t("도움말 열기", "Open help") },
          { keys: ["Esc"], label: t("메뉴 닫기", "Close the menu") },
        ] },
      ],
      onResume: () => {},
    });
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "gm-menu-btn b-menu-btn";
    menuBtn.dataset.id = "menu-button";
    menuBtn.setAttribute("aria-label", t("메뉴 열기", "Open menu"));
    menuBtn.textContent = "☰";
    menuBtn.addEventListener("click", () => this.menu.open());
    this.root.appendChild(menuBtn);
  }

  /** Cheap per-frame refresh — writes DOM only when the summary changes.
   *  `view` is what the CAMERA shows; during the completion parade the HUD
   *  describes the finished monument, never the not-yet-visible next one. */
  update(state: BuilderState, view?: HudView): void {
    const goal = goalAt(state.goalIndex);
    const progress = goalProgress(state, goal);
    const parade = view?.parade ?? false;
    const shownIndex = view?.landmarkIndex ?? state.landmarkIndex;
    const key = `${Math.floor(state.gold)}|${state.landmarkIndex}|${state.placedBlocks}|${state.goalIndex}|${progress}|${state.workers}|${state.speedLevel}|${state.valueLevel}|${state.crane}|${shownIndex}|${parade}`;
    if (key === this.lastRender) return;
    this.lastRender = key;

    const lm = landmarkAt(shownIndex);
    const tour = tourOf(shownIndex);
    const stop = (shownIndex % LANDMARKS.length) + 1;
    const tourLabel = t(
      `🌍 세계 여행${tour > 0 ? ` ${tour + 1}바퀴째` : ""} ${stop}/${LANDMARKS.length} — ${lm.emoji} ${landmarkName(lm)} (실제 높이 ${lm.realHeightM}m)`,
      `🌍 Tour${tour > 0 ? ` ${tour + 1},` : ""} stop ${stop}/${LANDMARKS.length} — ${lm.emoji} ${lm.name} (real ${lm.realHeightM}m)`,
    );
    this.goldEl.textContent = fmt(state.gold);
    this.floorsEl.textContent = parade
      ? `${tourLabel} ${t("✨ 완성! 감상하는 중…", "✨ Complete! Admiring…")}`
      : `${tourLabel} ${state.placedBlocks.toLocaleString()}/${currentLandmarkTotal(state).toLocaleString()}`;
    this.rateEl.textContent = t(`초당 블록 ${voxelsPerSecond(state).toFixed(1)}개`, `${voxelsPerSecond(state).toFixed(1)} blocks/s`);

    this.goalTitleEl.textContent = `${t("목표", "Goal")}: ${goalTitle(goal)}`;
    this.goalRewardEl.textContent = `+${fmt(goal.reward)}G`;
    this.goalBarEl.style.width = `${Math.min(100, (progress / goal.target) * 100)}%`;
    this.goalCountEl.textContent = `${Math.min(progress, goal.target)} / ${goal.target}`;

    for (const meta of SHOP_META) {
      const btn = this.shopButtons.get(meta.item);
      if (!btn) continue;
      if (meta.item === "crane") {
        const visible = state.goalIndex >= CRANE_GOAL_INDEX || state.crane;
        btn.style.display = visible ? "" : "none";
        if (state.crane) {
          btn.disabled = true;
          btn.innerHTML = `<img class="ui-icon" src="${meta.icon}" alt="" /><b>${t("크레인 준비 완료", "Crane ready")}</b><small>${t("짐 싣기 2배!", "2× loading speed!")}</small>`;
          continue;
        }
      }
      const cost = itemCost(state, meta.item);
      const short = cost - state.gold;
      btn.disabled = short > 0;
      btn.title = meta.tip();
      const extra =
        meta.item === "worker" && state.workers >= MAX_VISUAL_WORKERS
          ? t(" (화면엔 12명까지)", " (12 shown on screen)")
          : "";
      // a greyed-out button says what it is waiting for, so it never looks broken
      const price = short > 0 ? t(`💰 ${fmt(short)}G 더 필요`, `💰 ${fmt(short)}G more`) : `${fmt(cost)}G${extra}`;
      btn.innerHTML = `<img class="ui-icon" src="${meta.icon}" alt="" /><b>${meta.label(state)}</b><small>${price}</small>`;
    }
  }

  /** Gold gain pulse — juicy but cheap. */
  pulseGold(): void {
    this.goldEl.parentElement?.classList.add("pulse");
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => {
      this.goldEl.parentElement?.classList.remove("pulse");
    }, 180);
  }

  goalToast(title: string, reward: number): void {
    const el = document.createElement("div");
    el.className = "b-toast";
    el.textContent = t(`🎉 목표 달성! ${title} (+${fmt(reward)} 골드)`, `🎉 Goal complete! ${title} (+${fmt(reward)} gold)`);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /** Persistent badge for the live-stream crew boost (hidden at ×1). */
  setBoost(mult: number, remainingMs: number): void {
    if (mult <= 1.001 || remainingMs <= 0) {
      if (!this.boostEl.hidden) this.boostEl.hidden = true;
      return;
    }
    this.boostEl.hidden = false;
    this.boostEl.textContent = t(`⚡ 일꾼(Crew) ×${mult.toFixed(1)} · ${Math.ceil(remainingMs / 1000)}초`, `⚡ Crew ×${mult.toFixed(1)} · ${Math.ceil(remainingMs / 1000)}s`);
  }

  /** A donation / cheer just arrived — celebrate it on screen. All viewer
   *  text is set via textContent (untrusted chat must never become markup). */
  donorToast(name: string, message: string, tier: string, display: string): void {
    const el = document.createElement("div");
    el.className = "b-toast b-donor";
    const head = document.createElement("b");
    head.textContent = display ? `⚡ ${tier} · ${display}` : `⚡ ${tier}`;
    const who = document.createElement("div");
    who.className = "b-donor-who";
    who.textContent = name || t("누군가", "Someone");
    el.append(head, who);
    if (message) {
      const msg = document.createElement("div");
      msg.className = "b-donor-msg";
      msg.textContent = message;
      el.append(msg);
    }
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5200);
  }

  showOfflineModal(gains: OfflineGains, onClose: () => void): void {
    const minutes = Math.round(gains.seconds / 60);
    const timeText =
      minutes >= 60
        ? t(`${Math.floor(minutes / 60)}시간 ${minutes % 60}분`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`)
        : t(`${minutes}분`, `${minutes}m`);
    const el = document.createElement("div");
    el.className = "screen";
    el.innerHTML = `
      <div class="screen-card">
        <h1>👷 ${t("다시 왔군요!", "Welcome back!")}</h1>
        <p class="subtitle">${t(`자리를 비운 ${timeText} 동안 일꾼들이 계속 일했어요.`, `Your crew kept working for the ${timeText} you were away.`)}</p>
        <div class="b-offline-stats">
          <div>🧱 ${t("블록", "Blocks")} <b>${fmt(gains.blocks)}</b></div>
          <div>🏛️ ${t("랜드마크", "Landmarks")} <b>+${gains.landmarks}</b></div>
          <div>💰 ${t("골드", "Gold")} <b>+${fmt(gains.gold)}</b></div>
        </div>
        <button class="primary" data-id="ok">${t("좋아요!", "Nice!")}</button>
      </div>`;
    document.body.appendChild(el);
    const close = (): void => {
      el.remove();
      this.offlineModal = null;
      onClose();
    };
    this.offlineModal = close;
    el.querySelector('[data-id="ok"]')?.addEventListener("click", close);
  }

  private offlineModal: (() => void) | null = null;

  /**
   * Dismiss the welcome-back modal from code, running its normal close path.
   * Needed when entering VR: the modal is DOM-only, so in a headset it is
   * invisible while the sim stays paused behind it — the player would be sealed
   * inside a frozen world with nothing to click.
   */
  dismissOfflineModal(): void {
    this.offlineModal?.();
  }
}
