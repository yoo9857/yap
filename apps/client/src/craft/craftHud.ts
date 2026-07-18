import { blockByKey, textureUrl } from "./blocks.js";
import {
  CRAFT_RECIPES,
  HOTBAR,
  canCraftRecipe,
  countOf,
  type Counts,
  type CraftRecipe,
} from "./inventory.js";

/**
 * Craft-mode DOM UI: crosshair, 9-slot hotbar (1–9 / wheel), the recipe
 * panel (C), and the click-to-play pointer-lock hint. Pure rendering — all
 * rules live in inventory.ts.
 */
export class CraftHud {
  private readonly root: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly recipePanel: HTMLElement;
  private readonly recipeButtons = new Map<string, HTMLButtonElement>();
  private readonly hint: HTMLElement;
  private lastKey = "";

  constructor(
    parent: HTMLElement,
    private readonly onCraft: (recipe: CraftRecipe) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "craft-hud";
    const slots = HOTBAR.map(
      (key, i) => `
        <div class="craft-slot" data-id="slot-${key}">
          <span class="craft-slot-num">${i + 1}</span>
          <img src="${textureUrl(blockByKey(key)!)}" alt="${key}" />
          <b data-id="count-${key}">0</b>
        </div>`,
    ).join("");
    this.root.innerHTML = `
      <div class="craft-crosshair">+</div>
      <div class="craft-mine-bar hidden"><div class="craft-mine-fill" data-id="mine-fill"></div></div>
      <div class="craft-hotbar" data-id="hotbar">${slots}</div>
      <div class="craft-help">Move WASD · Jump Space · Mine hold LMB · Place RMB · Slots 1-9 / wheel · Recipes C · View V · Music M</div>
    `;
    parent.appendChild(this.root);
    this.root
      .querySelectorAll<HTMLElement>(".craft-slot")
      .forEach((el) => this.slots.push(el));

    this.recipePanel = document.createElement("div");
    this.recipePanel.className = "screen craft-screen hidden";
    const rows = CRAFT_RECIPES.map((r) => {
      const inputs = Object.entries(r.input)
        .map(
          ([key, n]) =>
            `<span class="craft-chip"><img src="${textureUrl(blockByKey(key)!)}" alt="${key}" />×${n}</span>`,
        )
        .join("");
      const outputs = Object.entries(r.output)
        .map(
          ([key, n]) =>
            `<span class="craft-chip"><img src="${textureUrl(blockByKey(key)!)}" alt="${key}" />×${n}</span>`,
        )
        .join("");
      return `
        <div class="craft-recipe">
          <span class="craft-recipe-name">${r.name}</span>
          <span class="craft-recipe-io">${inputs} → ${outputs}</span>
          <button class="craft-btn" data-id="recipe-${r.id}">Craft</button>
        </div>`;
    }).join("");
    this.recipePanel.innerHTML = `
      <div class="screen-card craft-card">
        <div class="craft-head">
          <h1>🛠️ Crafting</h1>
          <button class="craft-close" data-id="craft-close" aria-label="Close">✕</button>
        </div>
        <div class="craft-recipes">${rows}</div>
      </div>`;
    parent.appendChild(this.recipePanel);
    for (const recipe of CRAFT_RECIPES) {
      const btn = this.recipePanel.querySelector<HTMLButtonElement>(`[data-id="recipe-${recipe.id}"]`);
      if (!btn) continue;
      btn.addEventListener("click", () => this.onCraft(recipe));
      this.recipeButtons.set(recipe.id, btn);
    }
    this.recipePanel
      .querySelector('[data-id="craft-close"]')
      ?.addEventListener("click", () => this.hideRecipes());
    this.recipePanel.addEventListener("click", (e) => {
      if (e.target === this.recipePanel) this.hideRecipes();
    });

    this.hint = document.createElement("div");
    this.hint.className = "craft-hint";
    this.hint.textContent = "Click to play";
    parent.appendChild(this.hint);
  }

  get recipesOpen(): boolean {
    return !this.recipePanel.classList.contains("hidden");
  }

  toggleRecipes(): void {
    this.recipePanel.classList.toggle("hidden");
  }

  hideRecipes(): void {
    this.recipePanel.classList.add("hidden");
  }

  setPointerLocked(locked: boolean): void {
    this.hint.classList.toggle("hidden", locked);
  }

  /** Mining progress under the crosshair (null hides the gauge). */
  setMineProgress(frac: number | null): void {
    const bar = this.root.querySelector<HTMLElement>(".craft-mine-bar");
    const fill = this.root.querySelector<HTMLElement>('[data-id="mine-fill"]');
    if (!bar || !fill) return;
    bar.classList.toggle("hidden", frac === null);
    if (frac !== null) fill.style.width = `${Math.min(100, frac * 100).toFixed(0)}%`;
  }

  update(counts: Counts, selected: number): void {
    const key =
      HOTBAR.map((k) => countOf(counts, k)).join(",") +
      `|${selected}|${this.recipesOpen ? CRAFT_RECIPES.map((r) => canCraftRecipe(counts, r)).join("") : ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    HOTBAR.forEach((k, i) => {
      const el = this.slots[i]!;
      const n = countOf(counts, k);
      el.classList.toggle("selected", i === selected);
      el.classList.toggle("empty", n === 0);
      const count = el.querySelector<HTMLElement>(`[data-id="count-${k}"]`);
      if (count) count.textContent = String(n);
    });
    if (this.recipesOpen) {
      for (const recipe of CRAFT_RECIPES) {
        const btn = this.recipeButtons.get(recipe.id);
        if (btn) btn.disabled = !canCraftRecipe(counts, recipe);
      }
    }
  }

  toast(text: string): void {
    const el = document.createElement("div");
    el.className = "b-toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}
