import { blockByKey, textureUrl, type BlockDef } from "./blocks.js";
import {
  BLOCK_GROUPS,
  CRAFT_RECIPES,
  WATER_SLOT,
  blockBagOrder,
  blockGroup,
  canCraftRecipe,
  countOf,
  placeableBlocks,
  type BlockGroup,
  type Counts,
  type CraftRecipe,
} from "./inventory.js";
import { isEnglish, t } from "../ui/i18n.js";
import "./bag.css";

export type BagTab = "blocks" | "craft";

const blockLabel = (def: BlockDef): string => (isEnglish() ? def.name : def.ko);
const groupLabel = (id: string): string => {
  const meta = BLOCK_GROUPS.find((entry) => entry.id === id);
  return meta ? (isEnglish() ? meta.en : meta.ko) : id;
};
const outputKey = (recipe: CraftRecipe): string => Object.keys(recipe.output)[0] ?? "";
/** How many times the recipe can run with what is in the bag. */
const craftableTimes = (counts: Counts, recipe: CraftRecipe): number =>
  Math.min(...Object.entries(recipe.input).map(([key, n]) => Math.floor(countOf(counts, key) / n)));
const formatCount = (n: number): string => (n > 9999 ? "9999+" : n.toLocaleString());
/** A craft button batches at most this many (craftBatch's cap). */
const BATCH = 16;

/**
 * The bag. Blocks tab: a grid of everything you own, a detail column for the
 * block under the mouse (or the last one clicked), and the hotbar as its
 * footer. Crafting tab: one card per recipe showing have/need per ingredient,
 * what is missing and how many crafts fit. Counts stay one pile per block kind.
 *
 * Loading a slot: click a hotbar slot to pick it, then a block; drag a block
 * onto any slot; or hover a block and press 1–9.
 */
export class BagPanel {
  private readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly recipes: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly hotbar: HTMLElement;
  private readonly title: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly armedLabel: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly searchClear: HTMLButtonElement;
  private readonly onlyToggle: HTMLElement;
  private readonly onlyBox: HTMLInputElement;
  private readonly tabs: HTMLButtonElement[];
  private readonly cats: HTMLButtonElement[];
  private open = false;
  private tab: BagTab = "blocks";
  private armed = 0;
  private query = "";
  private group: BlockGroup | "all" = "all";
  private onlyCraftable = false;
  private sig = "";
  private detailSig = "";
  /** Last category + search. A change scrolls to that block instead of dropping slots. */
  private navKey = "";
  private counts: Counts = {};
  private slots: readonly string[] = [];
  /** What the detail column describes: the hovered block/recipe, else the last one clicked. */
  private hoverKey = "";
  private focusKey = "";
  private hoverRecipe = "";
  private focusRecipe = "";
  private flashSlot = -1;
  private worldBar: HTMLElement | null = null;
  private suppressClick = false;
  private drag: { pointerId: number; x: number; y: number; key: string; fromSlot: number | null; active: boolean } | null = null;
  private ghost: HTMLElement | null = null;
  private readonly onDragMove = (event: PointerEvent): void => this.moveDrag(event);
  private readonly onDragEnd = (event: PointerEvent): void => this.endDrag(event);
  private readonly onKey = (event: KeyboardEvent): void => this.quickLoad(event);

  constructor(
    parent: HTMLElement,
    private readonly creative: boolean,
    private readonly onCraft: (recipe: CraftRecipe, many: boolean) => void,
    private readonly onAssign: (slot: number, key: string, move: boolean, hold?: boolean) => void,
    private readonly onClear: (slot: number) => void,
    private readonly onArm: (slot: number) => void,
    private readonly onClose: () => void,
    worldBar: HTMLElement,
  ) {
    this.root = document.createElement("div");
    this.root.className = "screen bag-screen hidden";
    this.root.dataset.id = "bag";
    this.root.innerHTML = `
      <div class="screen-card bag-card" role="dialog" aria-modal="true" aria-labelledby="bag-title">
        <header class="bag-head">
          <h1 id="bag-title" class="bag-title"><span class="bag-title-mark" aria-hidden="true"></span><span data-id="bag-title">${t("가방", "Bag")}</span></h1>
          <div class="bag-tabs" role="tablist">
            <button type="button" role="tab" class="bag-tab on" data-tab="blocks">${t("블록", "Blocks")}<kbd>E</kbd></button>
            <button type="button" role="tab" class="bag-tab" data-tab="craft">${t("조합", "Crafting")}<kbd>I</kbd></button>
          </div>
          <p class="bag-summary" data-id="bag-summary"></p>
          <button type="button" class="bag-close" data-id="bag-close" aria-label="${t("닫기", "Close")}">✕</button>
        </header>
        <div class="bag-tools">
          <label class="bag-find">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>
            <input class="bag-search" data-id="bag-search" type="text" autocomplete="off" spellcheck="false" placeholder="${t("블록 이름으로 찾기", "Find a block by name")}" aria-label="${t("블록 이름으로 찾기", "Find a block by name")}" />
            <button type="button" class="bag-find-clear" data-id="bag-search-clear" aria-label="${t("검색 지우기", "Clear search")}" hidden>✕</button>
          </label>
          <label class="bag-only" data-id="bag-only" hidden><input type="checkbox" /><span>${t("만들 수 있는 것만", "Craftable only")}</span></label>
        </div>
        <nav class="bag-cats" data-id="bag-cats" aria-label="${t("종류", "Categories")}"></nav>
        <div class="bag-body">
          <div class="bag-main">
            <div class="bag-grid" data-id="bag-blocks"></div>
            <div class="bag-recipes hidden" data-id="bag-craft"></div>
          </div>
          <aside class="bag-detail" data-id="bag-detail" aria-live="polite"></aside>
        </div>
        <footer class="bag-foot">
          <div class="bag-foot-text">
            <b data-id="bag-armed"></b>
            <p class="bag-tip" data-id="bag-tip"></p>
          </div>
          <div class="bag-hotbar" data-id="bag-hotbar"></div>
          <button type="button" class="bag-clear" data-id="bag-clear">${t("이 칸 비우기", "Clear this slot")}</button>
        </footer>
      </div>`;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>(`[data-id="${id}"]`)!;
    this.grid = q("bag-blocks");
    this.recipes = q("bag-craft");
    this.detail = q("bag-detail");
    this.tip = q("bag-tip");
    this.hotbar = q("bag-hotbar");
    this.title = q("bag-title");
    this.summary = q("bag-summary");
    this.armedLabel = q("bag-armed");
    this.search = q<HTMLInputElement>("bag-search");
    this.searchClear = q<HTMLButtonElement>("bag-search-clear");
    this.onlyToggle = q("bag-only");
    this.onlyBox = this.onlyToggle.querySelector("input")!;
    this.tabs = [...this.root.querySelectorAll<HTMLButtonElement>(".bag-tab")];
    const cats = q("bag-cats");
    for (const group of BLOCK_GROUPS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bag-cat" + (group.id === "all" ? " on" : "");
      button.dataset.group = group.id;
      button.innerHTML = `<span>${isEnglish() ? group.en : group.ko}</span><em></em>`;
      cats.appendChild(button);
    }
    this.cats = [...cats.querySelectorAll<HTMLButtonElement>(".bag-cat")];

    this.root.addEventListener("click", (event) => {
      if (this.consumeDragClick()) return;
      if (event.target === this.root) this.requestClose();
    });
    q("bag-close").addEventListener("click", () => this.requestClose());
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => this.setTab((tab.dataset.tab as BagTab) ?? "blocks"));
    }
    for (const cat of this.cats) {
      cat.addEventListener("click", () => {
        this.group = (cat.dataset.group as BlockGroup | "all") ?? "all";
        this.repaint();
      });
    }
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.repaint();
    });
    this.search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (this.search.value) {
        this.search.value = "";
        this.query = "";
        this.repaint();
      } else this.requestClose();
    });
    this.searchClear.addEventListener("click", () => {
      this.search.value = "";
      this.query = "";
      this.search.focus();
      this.repaint();
    });
    this.onlyBox.addEventListener("change", () => {
      this.onlyCraftable = this.onlyBox.checked;
      this.repaint();
    });
    this.grid.addEventListener("click", (event) => {
      if (this.consumeDragClick()) return;
      const key = (event.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
      if (!key) return;
      this.focusKey = key;
      this.onAssign(this.armed, key, event.shiftKey);
      this.paintDetail();
    });
    this.grid.addEventListener("pointerover", (event) => {
      const key = (event.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key ?? "";
      if (key === this.hoverKey) return;
      this.hoverKey = key;
      this.paintDetail();
    });
    this.grid.addEventListener("pointerleave", () => {
      this.hoverKey = "";
      this.paintDetail();
    });
    this.grid.addEventListener("focusin", (event) => {
      const key = (event.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
      if (key) { this.focusKey = key; this.paintDetail(); }
    });
    this.recipes.addEventListener("click", (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>("[data-recipe-card]");
      if (card?.dataset.recipeCard) { this.focusRecipe = card.dataset.recipeCard; this.paintDetail(); }
      this.craftFrom(event);
    });
    this.recipes.addEventListener("pointerover", (event) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-recipe-card]")?.dataset.recipeCard ?? "";
      if (id === this.hoverRecipe) return;
      this.hoverRecipe = id;
      this.paintDetail();
    });
    this.recipes.addEventListener("pointerleave", () => {
      this.hoverRecipe = "";
      this.paintDetail();
    });
    this.detail.addEventListener("click", (event) => {
      const load = (event.target as HTMLElement).closest<HTMLElement>("[data-load]")?.dataset.load;
      if (load) {
        this.onAssign(this.armed, load, false);
        return;
      }
      const jump = (event.target as HTMLElement).closest<HTMLElement>("[data-jump]")?.dataset.jump;
      if (jump) {
        this.focusRecipe = jump;
        this.group = "all";
        this.query = "";
        this.search.value = "";
        this.setTab("craft");
        this.recipes.querySelector<HTMLElement>(`[data-recipe-card="${jump}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      this.craftFrom(event);
    });
    this.hotbar.addEventListener("click", (event) => {
      if (this.consumeDragClick()) return;
      const slotEl = (event.target as HTMLElement).closest<HTMLElement>("[data-slot]");
      if (!slotEl) return;
      const slot = Number(slotEl.dataset.slot);
      if (slot === WATER_SLOT) return;
      this.armed = slot;
      this.sig = "";
      this.onArm(slot);
      this.paint();
    });
    this.grid.addEventListener("pointerdown", (event) => this.beginDrag(event));
    this.hotbar.addEventListener("pointerdown", (event) => this.beginDrag(event));
    worldBar.addEventListener("pointerdown", (event) => this.beginDrag(event));
    this.worldBar = worldBar;
    this.hotbar.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const slotEl = (event.target as HTMLElement).closest<HTMLElement>("[data-slot]");
      if (!slotEl) return;
      const slot = Number(slotEl.dataset.slot);
      if (slot === WATER_SLOT) return;
      this.armed = slot;
      this.onArm(slot);
      this.onClear(slot);
    });
    q("bag-clear").addEventListener("click", () => this.onClear(this.armed));
  }

  get isOpen(): boolean {
    return this.open;
  }

  get currentTab(): BagTab {
    return this.tab;
  }

  /** Open this tab, or close when it is already showing. */
  toggle(tab: BagTab, selected: number): boolean {
    if (this.open && this.tab === tab) {
      this.hide();
      return false;
    }
    this.show(tab, selected);
    return true;
  }

  show(tab: BagTab, selected: number): void {
    if (!this.open) window.addEventListener("keydown", this.onKey);
    this.open = true;
    this.tab = tab;
    if (selected >= 0 && selected < WATER_SLOT) this.armed = selected;
    this.root.classList.remove("hidden");
    // the bag's footer IS the hotbar while it is open; the one under the dim would read as a second copy
    this.worldBar?.classList.add("bag-covered");
    document.body.classList.add("bag-open");
    this.repaint();
  }

  hide(): void {
    if (this.open) window.removeEventListener("keydown", this.onKey);
    this.open = false;
    this.hoverKey = this.hoverRecipe = "";
    this.root.classList.add("hidden");
    this.worldBar?.classList.remove("bag-covered");
    document.body.classList.remove("bag-open");
  }

  arm(slot: number): void {
    if (slot < 0 || slot >= WATER_SLOT) return;
    this.armed = slot;
    this.sig = "";
    if (this.open) this.paint();
  }

  update(counts: Counts, hotbar: readonly string[]): void {
    this.counts = counts;
    this.slots = hotbar;
    if (!this.open) return;
    this.paint();
  }

  /** A finished drag must not also count as a click. */
  consumeDragClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  dispose(): void {
    this.endDrag();
    window.removeEventListener("keydown", this.onKey);
    this.worldBar?.classList.remove("bag-covered");
    document.body.classList.remove("bag-open");
    this.ghost?.remove();
    this.ghost = null;
    this.root.remove();
  }

  /** Hover a block and press 1–9: it goes straight into that slot. The game's own key handler then holds the slot. */
  private quickLoad(event: KeyboardEvent): void {
    if (!this.open || this.tab !== "blocks" || !this.hoverKey) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if (event.key < "1" || event.key > "9") return;
    const slot = Number(event.key) - 1;
    this.flashSlot = slot;
    this.onAssign(slot, this.hoverKey, true, true);
  }

  private craftFrom(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-recipe]");
    const id = button?.dataset.recipe;
    if (!id || button.disabled) return;
    const recipe = CRAFT_RECIPES.find((entry) => entry.id === id);
    if (recipe) this.onCraft(recipe, event.shiftKey || button.dataset.many === "1");
  }

  private beginDrag(event: PointerEvent): void {
    if (this.drag || event.button !== 0) return;
    // A new press is not the click left over from the previous drag.
    this.suppressClick = false;
    const payload = this.dragPayload(event.target);
    if (!payload) return;
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, ...payload };
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragEnd);
  }

  private dragPayload(target: EventTarget | null): { key: string; fromSlot: number | null } | null {
    if (!(target instanceof Element)) return null;
    const slotEl = target.closest<HTMLElement>("[data-slot]");
    if (slotEl && slotEl.closest(".bag-hotbar, .craft-hotbar")) {
      const fromSlot = Number(slotEl.dataset.slot);
      if (!Number.isInteger(fromSlot) || fromSlot < 0 || fromSlot >= WATER_SLOT) return null;
      const key = this.slots[fromSlot] ?? "";
      if (!key) return null;
      return { key, fromSlot };
    }
    const tile = target.closest<HTMLElement>(".bag-tile[data-key]");
    if (!tile || !this.grid.contains(tile) || this.grid.classList.contains("hidden")) return null;
    const key = tile.dataset.key ?? "";
    return key ? { key, fromSlot: null } : null;
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if (!this.drag.active) {
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (dx * dx + dy * dy < 64) return;
      this.drag.active = true;
      this.showGhost(this.drag.key);
      document.body.classList.add("bag-dragging");
    }
    event.preventDefault();
    if (this.ghost) {
      this.ghost.style.left = `${event.clientX}px`;
      this.ghost.style.top = `${event.clientY}px`;
    }
    this.setDropHover(this.slotAt(event.clientX, event.clientY));
  }

  private endDrag(event?: PointerEvent): void {
    if (!this.drag) return;
    if (event && event.pointerId !== this.drag.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    window.removeEventListener("pointercancel", this.onDragEnd);
    this.setDropHover(null);
    if (this.ghost) this.ghost.hidden = true;
    document.body.classList.remove("bag-dragging");
    if (!drag.active || !event) return;
    this.suppressClick = true;
    const target = this.slotAt(event.clientX, event.clientY);
    if (target == null || target === drag.fromSlot) return;
    this.flashSlot = target;
    this.onAssign(target, drag.key, true, true);
  }

  private slotAt(x: number, y: number): number | null {
    const top = document.elementFromPoint(x, y);
    const direct = this.readSlot(top);
    if (direct != null) return direct;
    // The bag dim covers the playing hotbar. A drop on that strip still lands.
    if (top !== this.root || !this.worldBar) return null;
    for (const el of this.worldBar.querySelectorAll<HTMLElement>("[data-slot]")) {
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      return this.readSlot(el);
    }
    return null;
  }

  private readSlot(el: Element | null): number | null {
    const slotEl = el?.closest<HTMLElement>("[data-slot]");
    if (!slotEl?.closest(".bag-hotbar, .craft-hotbar")) return null;
    const slot = Number(slotEl.dataset.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= WATER_SLOT) return null;
    return slot;
  }

  private setDropHover(slot: number | null): void {
    for (const el of document.querySelectorAll(".drop")) el.classList.remove("drop");
    if (slot == null) return;
    for (const el of document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)) {
      if (el.closest(".bag-hotbar, .craft-hotbar")) el.classList.add("drop");
    }
  }

  private showGhost(key: string): void {
    const def = blockByKey(key);
    if (!def) return;
    if (!this.ghost) {
      this.ghost = document.createElement("div");
      this.ghost.className = "bag-ghost";
      this.ghost.innerHTML = `<img alt="" />`;
      document.body.appendChild(this.ghost);
    }
    const img = this.ghost.querySelector("img");
    if (img) img.src = textureUrl(def);
    this.ghost.hidden = false;
  }

  private requestClose(): void {
    this.hide();
    this.onClose();
  }

  private setTab(tab: BagTab): void {
    this.tab = tab;
    this.repaint();
  }

  private repaint(): void {
    this.sig = "";
    this.paint();
  }

  /** Blocks this bag lists: everything in creative, only what you own otherwise. */
  private pool(): BlockDef[] {
    return placeableBlocks()
      .filter((def) => this.creative || countOf(this.counts, def.key) > 0)
      .sort((a, b) => blockBagOrder(a.key) - blockBagOrder(b.key));
  }

  private paint(): void {
    let countSig = "";
    for (const key of Object.keys(this.counts).sort()) countSig += `${key}:${this.counts[key]},`;
    const next = `${this.tab}|${this.group}|${this.query}|${this.onlyCraftable}|${this.armed}|${this.slots.join(",")}|${countSig}`;
    if (next === this.sig) return;
    this.sig = next;

    const craft = this.tab === "craft";
    this.title.textContent = craft ? t("조합", "Crafting") : t("가방", "Bag");
    this.root.classList.toggle("bag-crafting", craft);
    for (const tab of this.tabs) {
      const on = tab.dataset.tab === this.tab;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", String(on));
    }
    this.searchClear.hidden = !this.query;
    this.onlyToggle.hidden = !craft;
    this.onlyBox.checked = this.onlyCraftable;
    this.grid.classList.toggle("hidden", craft);
    this.recipes.classList.toggle("hidden", !craft);
    this.search.placeholder = craft ? t("만들 블록이나 재료로 찾기", "Find by result or ingredient") : t("블록 이름으로 찾기", "Find a block by name");
    this.tip.innerHTML = craft
      ? t("<kbd>Shift</kbd>+클릭은 한꺼번에 · 만든 블록은 고른 칸으로 와요",
        "<kbd>Shift</kbd>+click crafts a batch · new blocks land in the picked slot")
      : t("클릭: 고른 칸에 넣기 · 끌기: 아무 칸에 · 올리고 <kbd>1</kbd>–<kbd>9</kbd>: 그 칸에",
        "Click: load picked slot · drag: any slot · hover + <kbd>1</kbd>–<kbd>9</kbd>: that slot");

    if (craft) this.paintRecipes();
    else this.paintBlocks();
    this.paintHotbar();
    this.detailSig = "";
    this.paintDetail();
  }

  private matches(def: BlockDef): boolean {
    if (this.group !== "all" && blockGroup(def.key) !== this.group) return false;
    if (!this.query) return true;
    return `${def.ko} ${def.name} ${def.key}`.toLowerCase().includes(this.query);
  }

  private paintCats(perGroup: Map<string, number>, total: number): void {
    for (const cat of this.cats) {
      const id = cat.dataset.group ?? "all";
      const n = id === "all" ? total : perGroup.get(id) ?? 0;
      cat.classList.toggle("on", id === this.group);
      cat.classList.toggle("none", n === 0);
      cat.querySelector("em")!.textContent = String(n);
    }
  }

  private paintBlocks(): void {
    const pool = this.pool();
    const perGroup = new Map<string, number>();
    let owned = 0;
    for (const def of pool) {
      const group = blockGroup(def.key) ?? "special";
      perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
      owned += countOf(this.counts, def.key);
    }
    this.paintCats(perGroup, pool.length);
    this.summary.innerHTML = this.creative
      ? t(`<b>${pool.length}</b>종 · 블록마다 <b>${formatCount(999)}</b>개`, `<b>${pool.length}</b> kinds · <b>${formatCount(999)}</b> of each`)
      : t(`<b>${pool.length}</b>종 · 모두 <b>${formatCount(owned)}</b>개`, `<b>${pool.length}</b> kinds · <b>${formatCount(owned)}</b> blocks`);

    const nav = `${this.group}|${this.query}`;
    const jump = nav !== this.navKey;
    this.navKey = nav;
    const kept = this.grid.scrollTop;
    if (pool.length === 0) {
      this.grid.innerHTML = `<div class="bag-empty"><b>${t("가방이 비어 있어요", "Your bag is empty")}</b>${t("블록을 캐거나 조합 탭에서 만들어 보세요.", "Mine a block, or make one in the Crafting tab.")}</div>`;
      return;
    }
    const shown = pool.filter((def) => this.matches(def)).length;
    const note = shown === 0
      ? `<div class="bag-empty"><b>${t("찾는 블록이 없어요", "No block matches")}</b>${t("다른 이름이나 종류로 찾아보세요.", "Try another name or category.")}</div>`
      : "";
    let lastGroup = "";
    const cells = pool.map((def) => {
      const group = blockGroup(def.key) ?? "special";
      let head = "";
      if (group !== lastGroup) {
        lastGroup = group;
        const sectionDim = this.group !== "all" && this.group !== group ? " bag-dim" : "";
        head = `<div class="bag-section${sectionDim}" data-group-head="${group}"><span>${groupLabel(group)}</span><em>${perGroup.get(group) ?? 0}</em></div>`;
      }
      const n = countOf(this.counts, def.key);
      const slot = this.slots.indexOf(def.key);
      const held = slot >= 0 && slot < WATER_SLOT;
      const label = blockLabel(def);
      const aria = held ? t(`${label}, ${n}개, 핫바 ${slot + 1}번`, `${label}, ${n}, hotbar ${slot + 1}`) : t(`${label}, ${n}개`, `${label}, ${n}`);
      const dim = this.matches(def) ? "" : " bag-dim";
      return `${head}<button type="button" class="bag-tile${dim}${held ? " held" : ""}" data-key="${def.key}" aria-label="${aria}">
        <span class="bag-tile-art"><img src="${textureUrl(def)}" alt="" draggable="false" />${held ? `<i class="bag-equipped">${slot + 1}</i>` : ""}<b class="bag-count">${formatCount(n)}</b></span>
        <span class="bag-tile-name">${label}</span>
      </button>`;
    }).join("");
    this.grid.innerHTML = note + cells;
    if (!jump) {
      this.grid.scrollTop = kept;
      return;
    }
    // Land on the section label, so "전체" keeps 땅 at the top and a chip
    // brings that label — not the tile under it — to the top of the grid.
    const head = this.group === "all"
      ? null
      : this.grid.querySelector<HTMLElement>(`[data-group-head="${this.group}"]`);
    let anchor = head ?? this.grid.querySelector<HTMLElement>(".bag-tile:not(.bag-dim)");
    if (anchor && !head) {
      let prev = anchor.previousElementSibling;
      while (prev && !prev.classList.contains("bag-section")) prev = prev.previousElementSibling;
      if (prev instanceof HTMLElement) anchor = prev;
    }
    // the grid is its tiles' offsetParent; leave its top padding showing
    this.grid.scrollTop = anchor ? Math.max(0, anchor.offsetTop - 12) : 0;
  }

  private recipeMatches(recipe: CraftRecipe, def: BlockDef): boolean {
    if (this.group !== "all" && blockGroup(def.key) !== this.group) return false;
    if (this.onlyCraftable && !canCraftRecipe(this.counts, recipe)) return false;
    if (!this.query) return true;
    const hay = [blockLabel(def), def.name, def.ko, ...Object.keys(recipe.input).map((item) => {
      const input = blockByKey(item);
      return input ? `${input.ko} ${input.name}` : item;
    })].join(" ").toLowerCase();
    return hay.includes(this.query);
  }

  /** Ingredient chips: have/need, red where short. */
  private needChips(recipe: CraftRecipe): string {
    return Object.entries(recipe.input).map(([key, need]) => {
      const def = blockByKey(key);
      if (!def) return "";
      const have = countOf(this.counts, key);
      const ok = have >= need;
      return `<span class="bag-need ${ok ? "ok" : "short"}" title="${blockLabel(def)}">
        <img src="${textureUrl(def)}" alt="" /><b>${blockLabel(def)}</b><small>${formatCount(have)}/${need}</small>
      </span>`;
    }).join("");
  }

  /** "모래 2개가 더 필요해요" — the first thing that stops this craft. */
  private missing(recipe: CraftRecipe): string {
    const short = Object.entries(recipe.input)
      .map(([key, need]) => ({ def: blockByKey(key), more: need - countOf(this.counts, key) }))
      .filter((entry) => entry.def && entry.more > 0);
    return short.map(({ def, more }) => t(`${blockLabel(def!)} ${more}개`, `${more} ${blockLabel(def!)}`)).join(", ");
  }

  private makeButtons(recipe: CraftRecipe, times: number): string {
    const batch = Math.min(times, BATCH);
    return `<button type="button" class="bag-make" data-recipe="${recipe.id}" ${times > 0 ? "" : "disabled"}>${t("만들기", "Craft")}</button>
      ${batch > 1 ? `<button type="button" class="bag-make bag-make-many" data-recipe="${recipe.id}" data-many="1" title="${t("한꺼번에 만들기", "Craft a batch")}">×${batch}</button>` : ""}`;
  }

  private paintRecipes(): void {
    const all = CRAFT_RECIPES
      .map((recipe) => ({ recipe, def: blockByKey(outputKey(recipe)) }))
      .filter((entry): entry is { recipe: CraftRecipe; def: BlockDef } => !!entry.def)
      .sort((a, b) => blockBagOrder(a.def.key) - blockBagOrder(b.def.key));
    const perGroup = new Map<string, number>();
    let ready = 0;
    for (const { recipe, def } of all) {
      const group = blockGroup(def.key) ?? "special";
      perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
      if (canCraftRecipe(this.counts, recipe)) ready++;
    }
    this.paintCats(perGroup, all.length);
    this.summary.innerHTML = t(`지금 만들 수 있는 조합 <b>${ready}</b> / ${all.length}`, `<b>${ready}</b> of ${all.length} recipes ready`);
    const rows = all.filter(({ recipe, def }) => this.recipeMatches(recipe, def));
    const kept = this.recipes.scrollTop;
    if (rows.length === 0) {
      this.recipes.innerHTML = `<div class="bag-empty"><b>${this.onlyCraftable ? t("지금 만들 수 있는 조합이 없어요", "Nothing is craftable yet") : t("찾는 조합이 없어요", "No recipe matches")}</b>${this.onlyCraftable ? t("재료를 더 캐 오면 여기에 나타나요.", "Mine more ingredients and they will show up here.") : t("다른 이름이나 종류로 찾아보세요.", "Try another name or category.")}</div>`;
      return;
    }
    this.recipes.innerHTML = rows.map(({ recipe, def }) => {
      const times = craftableTimes(this.counts, recipe);
      const amount = recipe.output[def.key] ?? 1;
      const state = times > 0
        ? `<small class="bag-state ok">${t(`만들 수 있어요 · 최대 ${times}번`, `Ready · up to ${times}×`)}</small>`
        : `<small class="bag-state short">${t(`${this.missing(recipe)}가 더 필요해요`, `Need ${this.missing(recipe)} more`)}</small>`;
      return `<article class="bag-recipe ${times > 0 ? "ready" : "blocked"}${recipe.id === this.focusRecipe ? " focus" : ""}" data-recipe-card="${recipe.id}">
        <div class="bag-recipe-out"><img src="${textureUrl(def)}" alt="" /><b>×${amount}</b></div>
        <strong class="bag-recipe-name">${blockLabel(def)}</strong>
        <div class="bag-recipe-act">${this.makeButtons(recipe, times)}</div>
        <div class="bag-recipe-in">${this.needChips(recipe)}</div>
        ${state}
      </article>`;
    }).join("");
    this.recipes.scrollTop = kept;
  }

  /** With nothing hovered yet, describe the first recipe on screen (a ready one when there is one). */
  private firstRecipe(): string {
    const cards = [...this.recipes.querySelectorAll<HTMLElement>("[data-recipe-card]")];
    return (cards.find((card) => card.classList.contains("ready")) ?? cards[0])?.dataset.recipeCard ?? "";
  }

  /** The column on the right: what the hovered (or last clicked) thing is and what you can do with it. */
  private paintDetail(): void {
    const craft = this.tab === "craft";
    const key = craft ? "" : this.hoverKey || this.focusKey || this.slots[this.armed] || this.pool()[0]?.key || "";
    const recipeId = craft ? this.hoverRecipe || this.focusRecipe || this.firstRecipe() : "";
    const sig = `${this.sig}|${key}|${recipeId}`;
    if (sig === this.detailSig) return;
    this.detailSig = sig;
    if (craft) {
      const recipe = CRAFT_RECIPES.find((entry) => entry.id === recipeId);
      const def = recipe ? blockByKey(outputKey(recipe)) : undefined;
      if (!recipe || !def) {
        this.detail.innerHTML = `<div class="bag-detail-empty">${t("조합에 마우스를 올리면<br>재료와 만들 수 있는 수를 자세히 보여 줘요.", "Hover a recipe to see<br>its ingredients in detail.")}</div>`;
        return;
      }
      const times = craftableTimes(this.counts, recipe);
      const amount = recipe.output[def.key] ?? 1;
      this.detail.innerHTML = `
        <div class="bag-detail-art"><img src="${textureUrl(def)}" alt="" /></div>
        <h2>${blockLabel(def)}</h2>
        <p class="bag-detail-group">${groupLabel(blockGroup(def.key) ?? "special")} · ${t(`한 번에 ${amount}개`, `${amount} per craft`)}</p>
        <h3>${t("재료", "Ingredients")}</h3>
        <div class="bag-detail-needs">${this.needChips(recipe)}</div>
        <p class="bag-detail-note ${times > 0 ? "ok" : "short"}">${times > 0
          ? t(`지금 재료로 <b>${times}번</b>, 모두 <b>${times * amount}개</b>를 만들 수 있어요.`, `You can craft this <b>${times}×</b> — <b>${times * amount}</b> blocks.`)
          : t(`${this.missing(recipe)}가 더 필요해요.`, `You need ${this.missing(recipe)} more.`)}</p>
        <div class="bag-detail-acts">${this.makeButtons(recipe, times)}</div>`;
      return;
    }
    const def = key ? blockByKey(key) : undefined;
    if (!def) {
      this.detail.innerHTML = `<div class="bag-detail-empty">${t("블록에 마우스를 올리면<br>자세히 보여 줘요.", "Hover a block<br>to see it in detail.")}</div>`;
      return;
    }
    const n = countOf(this.counts, def.key);
    const slot = this.slots.indexOf(def.key);
    const held = slot >= 0 && slot < WATER_SLOT;
    const makes = CRAFT_RECIPES.filter((recipe) => recipe.output[def.key]);
    const uses = CRAFT_RECIPES.filter((recipe) => recipe.input[def.key]);
    const recipeLink = (recipe: CraftRecipe, ofKey: string): string => {
      const out = blockByKey(ofKey);
      return out ? `<button type="button" class="bag-link" data-jump="${recipe.id}"><img src="${textureUrl(out)}" alt="" />${blockLabel(out)}</button>` : "";
    };
    this.detail.innerHTML = `
      <div class="bag-detail-art"><img src="${textureUrl(def)}" alt="" />${held ? `<i class="bag-equipped">${slot + 1}</i>` : ""}</div>
      <h2>${blockLabel(def)}</h2>
      <p class="bag-detail-group">${groupLabel(blockGroup(def.key) ?? "special")}</p>
      <dl class="bag-detail-stats">
        <div><dt>${t("가진 수", "Owned")}</dt><dd>${formatCount(n)}</dd></div>
        <div><dt>${t("핫바", "Hotbar")}</dt><dd>${held ? t(`${slot + 1}번`, `#${slot + 1}`) : "—"}</dd></div>
      </dl>
      <button type="button" class="bag-cta" data-load="${def.key}" ${n > 0 || this.creative ? "" : "disabled"}>${held
        ? t(`${slot + 1}번 칸 들기`, `Hold slot ${slot + 1}`)
        : t(`${this.armed + 1}번 칸에 넣기`, `Load into slot ${this.armed + 1}`)}</button>
      ${makes.length ? `<h3>${t("만드는 법", "Made from")}</h3><div class="bag-links">${makes.map((recipe) => `<button type="button" class="bag-link" data-jump="${recipe.id}">${Object.entries(recipe.input).map(([k, need]) => { const d = blockByKey(k); return d ? `<img src="${textureUrl(d)}" alt="" />${blockLabel(d)} ×${need}` : ""; }).join(" + ")}</button>`).join("")}</div>` : ""}
      ${uses.length ? `<h3>${t("재료로 쓰여요", "Used to make")}</h3><div class="bag-links">${uses.map((recipe) => recipeLink(recipe, outputKey(recipe))).join("")}</div>` : ""}`;
  }

  private paintHotbar(): void {
    const armedKey = this.slots[this.armed];
    const armedDef = armedKey ? blockByKey(armedKey) : undefined;
    this.armedLabel.textContent = armedDef
      ? t(`고른 칸 ${this.armed + 1}번 · ${blockLabel(armedDef)}`, `Picked slot ${this.armed + 1} · ${blockLabel(armedDef)}`)
      : t(`고른 칸 ${this.armed + 1}번 · 비어 있어요`, `Picked slot ${this.armed + 1} · empty`);
    this.hotbar.innerHTML = this.slots.map((key, index) => {
      const def = key ? blockByKey(key) : undefined;
      const endless = def?.fluid === true;
      const n = def && !endless ? countOf(this.counts, key) : 0;
      const img = def ? `<img src="${textureUrl(def)}" alt="${blockLabel(def)}" draggable="false" />` : "";
      const classes = [
        "bag-slot",
        index === this.armed ? "armed" : "",
        index === this.flashSlot ? "pop" : "",
        !def ? "blank" : "",
        def && !endless && n <= 0 ? "empty" : "",
        index === WATER_SLOT ? "locked" : "",
      ].filter(Boolean).join(" ");
      const count = def ? `<b>${endless ? "∞" : formatCount(n)}</b>` : "";
      return `<button type="button" class="${classes}" data-slot="${index}" ${index === WATER_SLOT ? "disabled" : ""} title="${def ? blockLabel(def) : t("빈 칸", "Empty slot")}">
        <span>${(index + 1) % 10}</span>
        ${img}${count}
      </button>`;
    }).join("");
    this.flashSlot = -1;
  }
}
