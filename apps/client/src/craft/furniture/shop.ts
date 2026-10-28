import { CATEGORIES, furnitureDef, inCategory, searchCatalog, variantCount } from "./catalog/index.js";
import type { CategoryKey, FurnitureDef } from "./types.js";
import "./shop.css";
import { t } from "../../ui/i18n.js";
import { keyBarHtml, type KeyHelp } from "../../ui/gameMenu.js";

/** The keys that work while a piece is in hand — shown on the bar and in the panel. */
const FURNITURE_KEYS = (): KeyHelp[] => [
  { keys: [t("우클릭", "Right click")], label: t("놓기", "Place") },
  { keys: [t("좌클릭 꾹", "Hold left")], label: t("치우기", "Put away") },
  { keys: ["R"], label: t("돌리기", "Turn") },
  { keys: ["X"], label: t("색 바꾸기", "Colour") },
  { keys: ["G"], label: t("블록으로", "Blocks") },
];

/**
 * The furniture DOM: a crayon chip (under the adoption chip) that opens the
 * catalog panel, and the furniture BAR that stands in for the block hotbar
 * while a piece is chosen. Pure DOM over the catalog — it reports choices
 * through `onPick` and is told what is current through `setCurrent`; the
 * controller owns the state.
 *
 * - The panel browses by category tab or by search, and every card carries
 *   its colour swatches, so choosing "the green sofa" is one click.
 * - Opening the panel releases pointer lock (cards cannot be clicked while the
 *   mouse is captured); a pick re-captures it in the same click, through the
 *   controller.
 * - The bar is the keyboard route and never needs the mouse at all: G, Q/E,
 *   1‒9, X.
 */
export interface ShopEvents {
  /** A card or swatch was clicked (kind null = back to blocks). */
  onPick(kind: string | null, variant?: number): void;
  /** The panel opened, so a neighbouring panel can close. */
  onOpen(): void;
  /** A category arrow on the bar was clicked (same as Q / E). */
  onStepCategory(dir: 1 | -1): void;
}

const swatchColor = (def: FurnitureDef, variant: number): string => {
  const colors = def.palettes?.[variant]?.colors;
  const first = colors ? Object.values(colors)[0] : undefined;
  return first === undefined ? "transparent" : `#${first.toString(16).padStart(6, "0")}`;
};

export class FurnitureShop {
  private readonly chip: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly tabs = new Map<CategoryKey, HTMLButtonElement>();
  private readonly grid: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly barLabel: HTMLElement;
  private readonly barSlots: HTMLElement;
  private tab: CategoryKey = CATEGORIES[0]!.key;
  private current: string | null = null;
  private variant = 0;
  private visible = true;
  private barCategory: CategoryKey | null = null;

  constructor(
    parent: HTMLElement,
    private readonly events: ShopEvents,
  ) {
    this.chip = document.createElement("button");
    this.chip.className = "furn-chip";
    this.chip.type = "button";
    this.chip.dataset.id = "furniture-chip";
    this.chip.innerHTML = `<span class="furn-chip-emoji">🛋️</span><span data-id="furniture-chip-label">${t("가구", "Furniture")}</span><kbd class="furn-kbd">G</kbd>`;
    this.chip.addEventListener("click", () => this.toggle());
    parent.appendChild(this.chip);

    this.panel = document.createElement("div");
    this.panel.className = "furn-panel hidden";
    this.panel.dataset.id = "furniture-panel";
    this.panel.innerHTML = `
      <div class="furn-panel-head">
        <span class="furn-panel-title">🛋️ ${t("가구 꾸미기", "Furnish")}</span>
        <span class="furn-panel-sub">${t("무료 · 몇 개든", "Free · unlimited")}</span>
        <button type="button" class="furn-close" data-id="furniture-close" aria-label="${t("닫기", "Close")}">✕</button>
      </div>`;
    this.panel.querySelector('[data-id="furniture-close"]')?.addEventListener("click", () => this.setOpen(false));

    this.search = document.createElement("input");
    this.search.className = "furn-search";
    this.search.type = "search";
    this.search.placeholder = t("🔍 가구 찾기 (예: 의자)", "🔍 Find furniture (e.g. 의자 = chair)");
    this.search.dataset.id = "furniture-search";
    this.search.addEventListener("input", () => this.renderGrid());
    this.panel.appendChild(this.search);

    const tabRow = document.createElement("div");
    tabRow.className = "furn-tabs";
    for (const cat of CATEGORIES) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "furn-tab";
      tab.dataset.id = `furniture-tab-${cat.key}`;
      tab.innerHTML = `<span>${cat.emoji}</span><span>${cat.name}</span>`;
      tab.addEventListener("click", () => {
        this.search.value = "";
        this.tab = cat.key;
        this.renderGrid();
      });
      tabRow.appendChild(tab);
      this.tabs.set(cat.key, tab);
    }
    this.panel.appendChild(tabRow);

    this.grid = document.createElement("div");
    this.grid.className = "furn-grid";
    this.grid.dataset.id = "furniture-grid";
    this.panel.appendChild(this.grid);

    // the bar under the crosshair already shows the keys; the full list is behind H
    const help = document.createElement("p");
    help.className = "furn-panel-help";
    help.textContent = t("가구를 고르면 아래에 키 안내가 나와요 · H 전체 조작법", "Pick a piece and its keys appear at the bottom · H for all controls");
    this.panel.appendChild(help);

    this.backButton = document.createElement("button");
    this.backButton.className = "furn-back";
    this.backButton.type = "button";
    this.backButton.dataset.id = "furniture-back";
    this.backButton.textContent = t("🧱 블록 쌓기로 돌아가기", "🧱 Back to building blocks");
    this.backButton.addEventListener("click", () => {
      this.events.onPick(null);
      this.setOpen(false);
    });
    this.panel.appendChild(this.backButton);
    parent.appendChild(this.panel);

    this.bar = document.createElement("div");
    this.bar.className = "furn-bar hidden";
    this.bar.dataset.id = "furniture-bar";
    // The category switcher: where you are, where Q and E go. It is the one
    // control a keyboard-only player has to discover on their own, so it is
    // big, names both neighbours, and pulses when it moves.
    this.barLabel = document.createElement("div");
    this.barLabel.className = "furn-cat";
    this.barLabel.dataset.id = "furniture-bar-label";
    this.barLabel.addEventListener("click", (e) => {
      const arrow = (e.target as HTMLElement).closest<HTMLElement>("[data-dir]");
      if (arrow) this.events.onStepCategory(arrow.dataset.dir === "1" ? 1 : -1);
    });
    this.barSlots = document.createElement("div");
    // Same slot styling as the block hotbar, so the swap reads as "the hotbar
    // changed", not as a new widget appearing.
    this.barSlots.className = "craft-hotbar furn-bar-slots";
    const keys = document.createElement("div");
    keys.className = "craft-help gm-keybar furn-keys";
    keys.innerHTML = keyBarHtml(FURNITURE_KEYS());
    this.bar.append(keys, this.barLabel, this.barSlots);
    parent.appendChild(this.bar);

    this.renderGrid();
    this.refresh();
  }

  get open(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    this.panel.classList.toggle("hidden", !open);
    if (open) {
      document.exitPointerLock();
      this.events.onOpen();
    }
  }

  /** Reflect the controller's state: the piece being placed and its colour. */
  setCurrent(kind: string | null, variant = 0): void {
    if (kind === this.current && variant === this.variant) return;
    this.current = kind;
    this.variant = variant;
    if (kind && !this.search.value) this.tab = furnitureDef(kind).category;
    this.renderGrid();
    this.refresh();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.chip.style.display = visible ? "" : "none";
    if (!visible) this.panel.classList.add("hidden");
    this.refresh();
  }

  /** The cards for the active tab, or the search results. */
  private renderGrid(): void {
    for (const [key, tab] of this.tabs) tab.classList.toggle("active", key === this.tab && !this.search.value);
    const query = this.search.value.trim();
    const defs = query ? searchCatalog(query) : inCategory(this.tab);
    this.grid.replaceChildren(...defs.map((def) => this.card(def)));
    if (defs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "furn-empty";
      empty.textContent = t("찾는 가구가 없어요", "No furniture matches that");
      this.grid.appendChild(empty);
    }
  }

  /** A pick goes straight back to the world: the next thing a child wants is
   *  to see the piece under the crosshair, not the panel it came from. */
  private choose(kind: string, variant?: number): void {
    this.events.onPick(kind, variant);
    this.setOpen(false);
  }

  private card(def: FurnitureDef): HTMLElement {
    const active = def.key === this.current;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `furn-card${active ? " active" : ""}`;
    card.dataset.id = `furniture-card-${def.key}`;
    card.dataset.furniture = def.key;
    const { w, d, h } = def.size;
    const where = { floor: "", rug: t(" · 바닥에 깔기", " · lies on the floor"), surface: t(" · 위에 올리기", " · goes on top"), wall: t(" · 벽에 걸기", " · hangs on a wall") }[def.placement];
    card.innerHTML = `
      <span class="furn-card-emoji">${def.emoji}</span>
      <span class="furn-card-name">${def.name}</span>
      <span class="furn-card-size">${w}×${d}${t("칸", "")}${h > 1 ? ` · ${t("높이", "height")} ${h}` : ""}${where}</span>`;
    card.addEventListener("click", () => this.choose(def.key));
    const variants = variantCount(def);
    if (variants > 1) {
      const row = document.createElement("span");
      row.className = "furn-swatches";
      for (let i = 0; i < variants; i++) {
        const swatch = document.createElement("span");
        swatch.className = `furn-swatch${active && i === this.variant ? " active" : ""}`;
        swatch.dataset.id = `furniture-swatch-${def.key}-${i}`;
        swatch.title = def.palettes![i]!.name;
        swatch.style.background = swatchColor(def, i);
        swatch.addEventListener("click", (e) => {
          e.stopPropagation(); // the card's own click would pick the remembered colour
          this.choose(def.key, i);
        });
        row.appendChild(swatch);
      }
      card.appendChild(row);
    }
    return card;
  }

  private refresh(): void {
    this.backButton.style.display = this.current ? "" : "none";
    const label = this.chip.querySelector<HTMLElement>('[data-id="furniture-chip-label"]');
    if (label) label.textContent = this.current ? `${t("가구", "Furniture")} · ${furnitureDef(this.current).name}` : t("가구", "Furniture");
    this.bar.classList.toggle("hidden", !this.current || !this.visible);
    if (!this.current) return;

    const def = furnitureDef(this.current);
    if (def.category !== this.barCategory) {
      const from = this.barCategory;
      this.barCategory = def.category;
      this.renderSwitcher(def.category, from);
      this.barSlots.replaceChildren(
        ...inCategory(def.category).map((d, i) => {
          const slot = document.createElement("div");
          slot.className = "craft-slot furn-slot";
          slot.dataset.id = `furniture-slot-${d.key}`;
          slot.innerHTML = `
            <span class="craft-slot-num">${i + 1}</span>
            <span class="furn-slot-emoji">${d.emoji}</span>
            <span class="furn-slot-name">${d.name}</span>
            <span class="furn-slot-dot"></span>`;
          return slot;
        }),
      );
    }
    for (const slot of this.barSlots.children as HTMLCollectionOf<HTMLElement>) {
      const selected = slot.dataset.id === `furniture-slot-${def.key}`;
      slot.classList.toggle("selected", selected);
      const dot = slot.querySelector<HTMLElement>(".furn-slot-dot");
      if (!dot) continue;
      const colored = selected && variantCount(def) > 1;
      dot.classList.toggle("none", !colored);
      if (colored) dot.style.background = swatchColor(def, this.variant);
    }
  }

  private renderSwitcher(category: CategoryKey, from: CategoryKey | null): void {
    const n = CATEGORIES.length;
    const i = CATEGORIES.findIndex((c) => c.key === category);
    const cat = CATEGORIES[i]!;
    const prev = CATEGORIES[(i + n - 1) % n]!;
    const next = CATEGORIES[(i + 1) % n]!;
    const dots = CATEGORIES.map((c) => `<i class="${c.key === category ? "on" : ""}"></i>`).join("");
    this.barLabel.innerHTML = `
      <button type="button" class="furn-cat-arrow prev" data-dir="-1" data-id="furniture-cat-prev">
        <kbd class="furn-cat-key">Q</kbd><span class="furn-cat-chevron">◀</span>
        <span class="furn-cat-side">${prev.emoji} ${prev.name}</span>
      </button>
      <div class="furn-cat-current">
        <span class="furn-cat-name" data-id="furniture-cat-name">${cat.emoji} ${cat.name}</span>
        <span class="furn-cat-dots">${dots}</span>
      </div>
      <button type="button" class="furn-cat-arrow next" data-dir="1" data-id="furniture-cat-next">
        <span class="furn-cat-side">${next.emoji} ${next.name}</span>
        <span class="furn-cat-chevron">▶</span><kbd class="furn-cat-key">E</kbd>
      </button>`;
    if (from === null) return;
    // Which way did we move? The shorter way round the ring of categories.
    const j = CATEGORIES.findIndex((c) => c.key === from);
    const forward = (i - j + n) % n <= n / 2;
    // Pulse the arrow that was "pressed" and slide the new name in. The markup
    // is fresh, so the animation always starts from its first frame.
    this.barLabel.querySelector(forward ? ".next" : ".prev")?.classList.add("pulse");
    this.barLabel.querySelector(".furn-cat-current")?.classList.add(forward ? "in-next" : "in-prev");
  }

  dispose(): void {
    this.chip.remove();
    this.panel.remove();
    this.bar.remove();
  }
}
