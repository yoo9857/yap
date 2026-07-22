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

const SHOP_META: { item: ShopItem; icon: string; label: (s: BuilderState) => string }[] = [
  { item: "worker", icon: "/ui/icon-worker.png", label: (s) => `Workers ×${s.workers}` },
  { item: "speed", icon: "/ui/icon-speed.png", label: (s) => `Speed Lv${s.speedLevel}` },
  { item: "value", icon: "/ui/icon-value.png", label: (s) => `Value Lv${s.valueLevel}` },
  { item: "crane", icon: "/ui/icon-crane.png", label: (s) => (s.crane ? "Crane ready" : "Crane") },
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

  constructor(
    parent: HTMLElement,
    private readonly onBuy: (item: ShopItem) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "builder-hud";
    this.root.innerHTML = `
      <div class="b-top">
        <div class="b-gold"><img class="ui-icon" src="/ui/icon-gold.png" alt="" /><span data-id="gold">0</span> Gold</div>
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
    const tourLabel = `🌍 Tour${tour > 0 ? ` ${tour + 1},` : ""} stop ${stop}/${LANDMARKS.length} — ${lm.emoji} ${lm.name} (real ${lm.realHeightM}m)`;
    this.goldEl.textContent = fmt(state.gold);
    this.floorsEl.textContent = parade
      ? `${tourLabel} ✨ Complete! Admiring…`
      : `${tourLabel} ${state.placedBlocks.toLocaleString()}/${currentLandmarkTotal(state).toLocaleString()}`;
    this.rateEl.textContent = `${voxelsPerSecond(state).toFixed(1)} blocks/s`;

    this.goalTitleEl.textContent = `Goal: ${goal.title}`;
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
          btn.innerHTML = `<img class="ui-icon" src="${meta.icon}" alt="" /><b>Crane ready</b><small>2× loading speed!</small>`;
          continue;
        }
      }
      const cost = itemCost(state, meta.item);
      btn.disabled = state.gold < cost;
      const extra =
        meta.item === "worker" && state.workers >= MAX_VISUAL_WORKERS
          ? " (12 shown on screen)"
          : "";
      btn.innerHTML = `<img class="ui-icon" src="${meta.icon}" alt="" /><b>${meta.label(state)}</b><small>${fmt(cost)}G${extra}</small>`;
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
    el.textContent = `🎉 Goal complete! ${title} (+${fmt(reward)} gold)`;
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
    this.boostEl.textContent = `⚡ Crew ×${mult.toFixed(1)} · ${Math.ceil(remainingMs / 1000)}s`;
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
    who.textContent = name || "Someone";
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
      minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    const el = document.createElement("div");
    el.className = "screen";
    el.innerHTML = `
      <div class="screen-card">
        <h1>👷 Welcome back!</h1>
        <p class="subtitle">Your crew kept working for the ${timeText} you were away.</p>
        <div class="b-offline-stats">
          <div>🧱 Blocks <b>${fmt(gains.blocks)}</b></div>
          <div>🏛️ Landmarks <b>+${gains.landmarks}</b></div>
          <div>💰 Gold <b>+${fmt(gains.gold)}</b></div>
        </div>
        <button class="primary" data-id="ok">Nice!</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-id="ok"]')?.addEventListener("click", () => {
      el.remove();
      onClose();
    });
  }
}
