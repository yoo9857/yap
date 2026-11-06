/**
 * 건설 현황판 (Tab): every power plant at a glance — the village's light at the top, a card per
 * plant (state, build %, parts, distance) in the middle, and where the energy goes at the bottom.
 * Clicking a card closes the board and lights a beacon over that plant. DOM only; ScienceMode
 * feeds it plain data each frame while it is open and it re-renders only what changed.
 */
import { t, isEnglish } from "../../ui/i18n.js";
import { BLUEPRINTS, type PlantKind, type PlantStatus } from "./plants.js";
import { PARTS, type PartKey } from "./parts.js";
import { energyChain, efficiency, type VillagePower } from "./energy.js";

export interface BoardPlant {
  id: number;
  kind: PlantKind;
  status: PlantStatus;
  pct: number;
  parts: ReadonlyArray<{ part: PartKey; filled: boolean }>;
  /** Metres from the player. */
  distance: number;
}

const STATUS: Record<PlantStatus, { ko: string; en: string; cls: string }> = {
  building: { ko: "건설 중", en: "Building", cls: "building" },
  parts: { ko: "부품 대기", en: "Needs parts", cls: "parts" },
  ready: { ko: "가동 준비", en: "Ready", cls: "ready" },
  running: { ko: "가동 중", en: "Running", cls: "running" },
  inspection: { ko: "점검 중", en: "Check", cls: "inspection" },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class StatusBoard {
  private readonly root: HTMLElement;
  private readonly villageEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly flowEl: HTMLElement;
  private isOpen = false;
  private lastVillage = "";
  private lastList = "";

  constructor(parent: HTMLElement, private readonly on: { pick(id: number): void; close(): void }) {
    this.root = document.createElement("aside");
    this.root.className = "sci-board";
    this.root.setAttribute("aria-label", t("건설 현황판", "Build status"));
    this.root.innerHTML = `
      <header class="sci-board-head">
        <h2>${t("건설 현황", "Build status")}</h2>
        <span class="sci-board-key"><kbd>Tab</kbd></span>
        <button type="button" class="sci-board-close" aria-label="${t("닫기", "Close")}">✕</button>
      </header>
      <section class="sci-village" data-id="village"></section>
      <h3 class="sci-board-sub">${t("내 발전소", "My power plants")}</h3>
      <div class="sci-plants" data-id="list"></div>
      <section class="sci-flow" data-id="flow"></section>`;
    this.villageEl = this.root.querySelector('[data-id="village"]')!;
    this.listEl = this.root.querySelector('[data-id="list"]')!;
    this.flowEl = this.root.querySelector('[data-id="flow"]')!;
    this.root.querySelector(".sci-board-close")!.addEventListener("click", () => this.on.close());
    this.listEl.addEventListener("click", (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-plant]");
      if (card) this.on.pick(Number(card.dataset.plant));
    });
    // keys typed while the board is open must not walk the robot or open other panels
    this.root.addEventListener("keydown", (e) => e.stopPropagation());
    parent.appendChild(this.root);
    this.flowEl.innerHTML = flowHtml("wind");
  }

  get open(): boolean {
    return this.isOpen;
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    this.root.classList.toggle("open", open);
    if (!open) return;
    this.lastVillage = "";
    this.lastList = "";
  }

  update(plants: readonly BoardPlant[], village: VillagePower): void {
    if (!this.isOpen) return;
    const v = `${village.supply}/${village.demand}/${village.lit}/${village.running}`;
    if (v !== this.lastVillage) {
      this.lastVillage = v;
      this.villageEl.innerHTML = villageHtml(village);
    }
    // distances move every frame while walking: round them so the list does not churn
    const sig = plants.map((p) => `${p.id}:${p.status}:${p.pct}:${p.parts.map((x) => +x.filled).join("")}:${Math.round(p.distance / 5)}`).join("|");
    if (sig !== this.lastList) {
      this.lastList = sig;
      this.listEl.innerHTML = plants.length ? plants.map(cardHtml).join("") : emptyHtml();
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function villageHtml(v: VillagePower): string {
  const houses = Array.from({ length: v.demand }, (_, i) => `<i class="sci-house${i < v.lit ? " lit" : ""}" style="--d:${i * 40}ms"></i>`).join("");
  const pct = Math.round((Math.min(v.supply, v.demand) / v.demand) * 100);
  const msg = v.lit === 0
    ? t("아직 불이 꺼져 있어요 — 발전소를 가동해 보세요", "The village is dark — get a plant running")
    : v.lit < v.demand
      ? t(`집 ${v.demand - v.lit}채가 아직 어두워요 — 발전소가 더 필요해요`, `${v.demand - v.lit} houses are still dark — more plants needed`)
      : t("마을 전체에 불이 켜졌어요! 🎉", "The whole village is lit! 🎉");
  return `
    <div class="sci-village-top">
      <b>${t("마을 전기", "Village power")}</b>
      <span class="sci-village-num"><em>⚡ ${v.supply}</em> / ${v.demand}</span>
    </div>
    <div class="sci-houses" role="img" aria-label="${t(`집 ${v.demand}채 중 ${v.lit}채에 불`, `${v.lit} of ${v.demand} houses lit`)}">${houses}</div>
    <div class="sci-meter"><span style="width:${pct}%"></span></div>
    <p class="sci-village-msg">${msg}</p>`;
}

function cardHtml(p: BoardPlant): string {
  const bp = BLUEPRINTS[p.kind];
  const st = STATUS[p.status];
  const name = isEnglish() ? bp.name : bp.ko;
  const parts = p.parts
    .map(({ part, filled }) => `<span class="sci-part${filled ? " in" : ""}" title="${esc(isEnglish() ? PARTS[part].name : PARTS[part].ko)}"><img src="${PARTS[part].icon}" alt="" /></span>`)
    .join("");
  const done = p.parts.filter((x) => x.filled).length;
  return `
    <button type="button" class="sci-card ${st.cls}" data-plant="${p.id}">
      <span class="sci-card-icon">${bp.icon}</span>
      <span class="sci-card-main">
        <span class="sci-card-row"><b>${esc(name)} <small>#${p.id}</small></b><span class="sci-badge">${isEnglish() ? st.en : st.ko}</span></span>
        <span class="sci-card-bar"><span style="width:${p.pct}%"></span></span>
        <span class="sci-card-row sci-card-foot"><span class="sci-parts">${parts}<small>${done}/${p.parts.length}</small></span><span class="sci-card-pct">${p.pct}%</span></span>
      </span>
      <span class="sci-card-go">${Math.round(p.distance)} m<br /><small>${t("찾아가기", "Find")}</small></span>
    </button>`;
}

function emptyHtml(): string {
  return `<div class="sci-empty"><b>${t("아직 발전소가 없어요", "No power plants yet")}</b><span>${t("T를 누르고 땅을 바라본 뒤 오른쪽 클릭으로 설계도를 펼쳐 보세요", "Press T, look at the ground and right click to lay a blueprint")}</span></div>`;
}

function flowHtml(kind: PlantKind): string {
  const en = isEnglish();
  const chain = energyChain(kind, 100);
  const steps = chain
    .map((s, i) => `${i ? '<span class="sci-flow-arrow">→</span>' : ""}<span class="sci-flow-step"><b>${Math.round(s.out)}</b><small>${en ? s.nameEn : s.name}</small></span>`)
    .join("");
  const losses = chain.filter((s) => s.loss).map((s) => `<li><b>${en ? s.nameEn : s.name}</b> −${Math.round(s.in - s.out)} · ${en ? s.lossEn : s.loss}</li>`).join("");
  return `
    <h3 class="sci-board-sub">${t("에너지는 어디로 갈까? (풍력, 대략)", "Where does the energy go? (wind, roughly)")}</h3>
    <div class="sci-flow-steps">${steps}<span class="sci-flow-arrow">→</span><span class="sci-flow-step house"><b>🏠</b><small>${t("마을", "Village")}</small></span></div>
    <ul class="sci-flow-loss">${losses}</ul>
    <p class="sci-flow-note">${t(`바람 100 중 약 ${Math.round(efficiency(kind) * 100)}만큼이 전기가 되어 마을에 닿아요.`, `About ${Math.round(efficiency(kind) * 100)} of every 100 of wind reaches the village as electricity.`)}</p>`;
}
