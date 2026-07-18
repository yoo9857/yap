import { MAX_HP } from "./combat.js";

/**
 * Battle-mode DOM UI: crosshair + hit marker, hearts, alive counter, storm
 * timer, kill feed, damage/storm vignettes and the end-of-match card.
 */
export class BattleHud {
  private readonly root: HTMLElement;
  private readonly hearts: HTMLElement;
  private readonly aliveEl: HTMLElement;
  private readonly zoneEl: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly damageFx: HTMLElement;
  private readonly stormFx: HTMLElement;
  private readonly endCard: HTMLElement;
  private readonly hint: HTMLElement;
  private lastKey = "";
  private markerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "battle-hud";
    this.root.innerHTML = `
      <div class="craft-crosshair" data-id="crosshair">+</div>
      <div class="battle-marker hidden" data-id="marker">✕</div>
      <div class="battle-top">
        <span class="hud-chip" data-id="alive">🤖 8</span>
        <span class="hud-chip" data-id="zone">☁️</span>
      </div>
      <div class="battle-hearts" data-id="hearts"></div>
      <div class="battle-feed" data-id="feed"></div>
      <div class="craft-help">Move WASD · Jump Space · Fire LMB (hold) · View V · Music M</div>
    `;
    parent.appendChild(this.root);
    const q = (id: string) => this.root.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    this.hearts = q("hearts");
    this.aliveEl = q("alive");
    this.zoneEl = q("zone");
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

    this.hint = document.createElement("div");
    this.hint.className = "craft-hint";
    this.hint.textContent = "Click to fight";
    parent.appendChild(this.hint);
  }

  setPointerLocked(locked: boolean): void {
    this.hint.classList.toggle("hidden", locked);
  }

  update(hp: number, aliveBots: number, zoneLabel: string, outside: boolean): void {
    const key = `${hp}|${aliveBots}|${zoneLabel}|${outside}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.hearts.textContent = "❤️".repeat(Math.max(0, hp)) + "🤍".repeat(Math.max(0, MAX_HP - hp));
    this.aliveEl.textContent = `🤖 ${aliveBots + (hp > 0 ? 1 : 0)}`;
    this.zoneEl.textContent = zoneLabel;
    this.stormFx.classList.toggle("active", outside && hp > 0);
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
        <h1>${won ? "🏆 VICTORY ROYALE!" : "💥 ELIMINATED"}</h1>
        <p class="subtitle">${won ? "Last robot standing." : `${aliveBots} robot${aliveBots === 1 ? "" : "s"} remaining.`}</p>
        <button class="primary" data-id="again">Play again</button>
      </div>`;
    this.endCard.querySelector('[data-id="again"]')?.addEventListener("click", () => {
      location.href = "/?mode=battle";
    });
    document.exitPointerLock();
  }
}
