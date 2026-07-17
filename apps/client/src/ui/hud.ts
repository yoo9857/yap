export interface HudData {
  heightPercent: number;
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
  private readonly heightEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly fallsEl: HTMLElement;
  private readonly playersEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private lastText = "";

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-top">
        <span class="hud-chip" data-id="height">0%</span>
        <span class="hud-chip" data-id="time">0:00.00</span>
        <span class="hud-chip" data-id="stage">1/4</span>
        <span class="hud-chip" data-id="falls">Falls 0</span>
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
    this.heightEl = q("height");
    this.timeEl = q("time");
    this.stageEl = q("stage");
    this.fallsEl = q("falls");
    this.playersEl = q("players");
    this.bannerEl = q("banner");
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? "" : "none";
  }

  update(d: HudData): void {
    // skip DOM writes when nothing changed
    const text = `${Math.round(d.heightPercent)}|${Math.floor(d.runTimeMs / 10)}|${d.stage}|${d.falls}|${d.playerCount}|${d.connection}`;
    if (text === this.lastText) return;
    this.lastText = text;

    this.heightEl.textContent = `${Math.max(0, Math.min(100, Math.round(d.heightPercent)))}%`;
    this.timeEl.textContent = formatTime(d.runTimeMs);
    this.stageEl.textContent = `${d.stage}/${d.totalStages}`;
    this.fallsEl.textContent = `Falls ${d.falls}`;
    this.playersEl.textContent = `🙂 ${d.playerCount}`;

    if (d.connection === "connecting") {
      this.bannerEl.textContent = "Reconnecting to the server… (you can keep playing solo)";
      this.bannerEl.classList.remove("hidden");
    } else {
      this.bannerEl.classList.add("hidden");
    }
  }
}
