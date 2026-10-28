import { blockByKey, textureUrl, type BlockDef } from "./blocks.js";
import {
  CRAFT_RECIPES,
  HOTBAR,
  canCraftRecipe,
  countOf,
  type Counts,
  type CraftRecipe,
} from "./inventory.js";
import { GameMenu, keyBarHtml, type HelpGroup, type KeyHelp } from "../ui/gameMenu.js";
import { isEnglish, t } from "../ui/i18n.js";
import { KEY_WASD, MOUSE_LEFT, MOUSE_MIDDLE, MOUSE_MOVE, MOUSE_RIGHT, MOUSE_WHEEL } from "../ui/inputGlyphs.js";

const blockName = (def: BlockDef | undefined): string => (def ? (isEnglish() ? def.name : def.ko) : "");

const ESSENTIALS = (): KeyHelp[] => [
  { keys: [KEY_WASD], label: t("이동", "Move") },
  { keys: ["Space"], label: t("점프", "Jump") },
  { keys: [MOUSE_LEFT], label: t("꾹 눌러 캐기", "Hold to mine") },
  { keys: [MOUSE_RIGHT], label: t("블록 놓기", "Place block") },
];

function helpGroups(furniture: boolean): HelpGroup[] {
  return [
    {
      title: t("움직이기", "Moving"),
      items: [
        { keys: [KEY_WASD], label: t("이동", "Move") },
        { keys: ["Space"], label: t("점프 · 물속에서 위로", "Jump · swim up") },
        { keys: [MOUSE_MOVE], label: t("둘러보기", "Look around") },
        { keys: ["V"], label: t("1인칭 / 3인칭 시점", "First / third person") },
        { keys: ["O"], label: t("시야 거리 바꾸기", "View distance") },
        { keys: ["C"], label: t("감정표현 · 캐릭터 · 눕기", "Emotes · character · lie down") },
        { keys: ["Z"], label: t("기어가기 / 일어나기", "Crawl / stand up") },
      ],
    },
    {
      title: t("블록 쌓기", "Building"),
      items: [
        { keys: [MOUSE_LEFT], label: t("꾹 눌러 블록 캐기", "Hold to mine a block") },
        { keys: [MOUSE_RIGHT], label: t("블록 놓기", "Place a block") },
        { keys: ["1–9", MOUSE_WHEEL], label: t("블록 고르기", "Pick a block") },
        { keys: ["0"], label: t("물 양동이", "Water bucket") },
        { keys: ["F"], label: t("블록 모양 바꾸기", "Change brick shape") },
        { keys: ["R", "T"], label: t("돌리기 · 기울이기", "Rotate · tilt") },
        { keys: ["I"], label: t("재료로 블록 만들기(조합)", "Crafting recipes") },
        { keys: ["Q"], label: t("빈손 ↔ 블록 쌓기 (빈손은 캐기만, 놓지 않아요)", "Empty hands ↔ building (empty hands mine but never place)") },
      ],
    },
    {
      title: t("꾸미기와 친구들", "Decorate & friends"),
      items: [
        ...(furniture ? [{ keys: ["G"], label: t("가구 모드", "Furniture mode") }] : []),
        { keys: ["B"], label: t("기계 작업실 (자동차·비행기)", "Machine lab (cars, planes)") },
        { keys: ["Y"], label: t("반려동물 입양하기", "Adopt a pet") },
        { keys: ["P"], label: t("반려동물 앉아 / 따라와", "Pet: stay / follow") },
        { keys: ["Ctrl", "Z"], label: t("되돌리기 (가구)", "Undo (furniture)") },
      ],
    },
    ...(furniture ? [{
      title: t("가구 모드 (G)", "Furniture mode (G)"),
      items: [
        { keys: ["Q", "E"], label: t("가구 종류 바꾸기", "Change category") },
        { keys: ["1–9", MOUSE_WHEEL], label: t("가구 고르기", "Pick a piece") },
        { keys: [MOUSE_RIGHT], label: t("놓기 · 문 열기 · 앉기", "Place · open doors · sit") },
        { keys: [MOUSE_LEFT], label: t("꾹 눌러 가구 치우기", "Hold to put a piece away") },
        { keys: ["R"], label: t("돌리기", "Turn") },
        { keys: ["X"], label: t("색 바꾸기", "Change colour") },
        { keys: [MOUSE_MIDDLE], label: t("보고 있는 가구 그대로 고르기", "Pick the piece you aim at") },
        { keys: ["Ctrl", "Y"], label: t("다시 하기", "Redo") },
      ],
    }] : []),
    {
      title: t("기타", "Other"),
      items: [
        { keys: ["M"], label: t("음악 켜기 / 끄기", "Music on / off") },
        { keys: ["H"], label: t("조작법 열기", "Open controls") },
        { keys: ["Esc"], label: t("마우스 풀기 · 메뉴", "Free mouse · menu") },
      ],
    },
  ];
}

/**
 * Craft-mode DOM UI: crosshair, 10-slot hotbar with the selected block's name,
 * a short key strip, the recipe panel (I) and the start/pause menu. Pure
 * rendering — all rules live in inventory.ts.
 */
export class CraftHud {
  private readonly root: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly recipePanel: HTMLElement;
  private readonly recipeButtons = new Map<string, HTMLButtonElement>();
  private readonly pieceChip: HTMLElement;
  private readonly slotLabel: HTMLElement;
  readonly menu: GameMenu;
  private lastKey = "";
  private lastPiece = "";
  private lastSelected = -1;
  private labelTimer: ReturnType<typeof setTimeout> | undefined;
  private locked = false;

  constructor(
    parent: HTMLElement,
    private readonly onCraft: (recipe: CraftRecipe) => void,
    opts: { furniture?: boolean; mode?: string; onResume: () => void; onRecipesClose?: () => void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "craft-hud";
    const slots = HOTBAR.map(
      (key, i) => `
        <div class="craft-slot" data-id="slot-${key}" title="${blockName(blockByKey(key))}">
          <span class="craft-slot-num">${(i + 1) % 10}</span>
          <img src="${textureUrl(blockByKey(key)!)}" alt="${blockName(blockByKey(key))}" />
          <b data-id="count-${key}">0</b>
        </div>`,
    ).join("");
    this.root.innerHTML = `
      <div class="craft-crosshair">+</div>
      <div class="craft-mine-bar hidden"><div class="craft-mine-fill" data-id="mine-fill"></div></div>
      <div class="craft-slot-label" data-id="slot-label"></div>
      <div class="craft-hotbar" data-id="hotbar">${slots}</div>
      <div class="craft-help gm-keybar">${keyBarHtml([...ESSENTIALS(), { keys: ["C"], label: t("감정표현", "Emotes") }, { keys: ["Z"], label: t("기어가기", "Crawl") }, { keys: ["Q"], label: t("빈손", "Empty hands") }])}</div>
    `;
    parent.appendChild(this.root);
    this.slotLabel = this.root.querySelector<HTMLElement>('[data-id="slot-label"]')!;

    // current LEGO piece indicator (top-center)
    this.pieceChip = document.createElement("div");
    this.pieceChip.className = "craft-piece";
    parent.appendChild(this.pieceChip);
    this.root
      .querySelectorAll<HTMLElement>(".craft-slot")
      .forEach((el) => this.slots.push(el));

    this.recipePanel = document.createElement("div");
    this.recipePanel.className = "screen craft-screen hidden";
    const chips = (io: Record<string, number>) =>
      Object.entries(io)
        .map(([key, n]) => {
          const def = blockByKey(key)!;
          return `<span class="craft-chip" title="${blockName(def)}"><img src="${textureUrl(def)}" alt="${blockName(def)}" />×${n}</span>`;
        })
        .join("");
    const rows = CRAFT_RECIPES.map((r) => {
      const out = blockByKey(Object.keys(r.output)[0]!);
      return `
        <div class="craft-recipe">
          <span class="craft-recipe-name">${out ? blockName(out) : r.name}</span>
          <span class="craft-recipe-io">${chips(r.input)} → ${chips(r.output)}</span>
          <button class="craft-btn" data-id="recipe-${r.id}">${t("만들기", "Craft")}</button>
        </div>`;
    }).join("");
    this.recipePanel.innerHTML = `
      <div class="screen-card craft-card">
        <div class="craft-head">
          <h1>🛠️ ${t("조합", "Crafting")}</h1>
          <button class="craft-close" data-id="craft-close" aria-label="${t("닫기", "Close")}">✕</button>
        </div>
        <p class="craft-recipe-tip">${t("캐서 모은 재료로 새 블록을 만들어요. 재료가 모자라면 버튼이 꺼져 있어요.", "Turn mined materials into new blocks. A button stays off until you have enough.")}</p>
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
      ?.addEventListener("click", () => {
        this.hideRecipes();
        opts.onRecipesClose?.();
      });
    this.recipePanel.addEventListener("click", (e) => {
      if (e.target !== this.recipePanel) return;
      this.hideRecipes();
      opts.onRecipesClose?.();
    });

    this.menu = new GameMenu(parent, {
      mode: opts.mode ?? "Craft Island",
      essentials: ESSENTIALS(),
      help: helpGroups(opts.furniture !== false),
      onResume: opts.onResume,
    });
  }

  get recipesOpen(): boolean {
    return !this.recipePanel.classList.contains("hidden");
  }

  setWorkshopOpen(open: boolean): void {
    this.root.style.display = open ? "none" : "";
    this.pieceChip.style.display = open ? "none" : "";
    if (open) this.hideRecipes();
  }

  toggleRecipes(): void {
    this.recipePanel.classList.toggle("hidden");
  }

  hideRecipes(): void {
    this.recipePanel.classList.add("hidden");
  }

  setPointerLocked(locked: boolean): void {
    this.locked = locked;
  }

  /** The start/pause card shows whenever the player is out of play and no
   *  other panel (recipes, furniture, pets, the machine lab, chat) has the screen. */
  syncMenu(panelOpen: boolean): void {
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "range";
    this.menu.setVisible(!this.locked && !panelOpen && !this.recipesOpen && !typing);
  }

  /** Show the active building piece + its yaw / tilt rotation. */
  setPiece(piece: string | { name: string; ko: string }, yaw: number, tilt: number, icon = "🧱"): void {
    const spin = yaw ? ` · ↻${yaw * 90}°` : "";
    const tip = tilt ? ` · ⤢${tilt * 90}°` : "";
    // a brick shape gets the key that cycles it; furniture names its own keys elsewhere
    const label = typeof piece === "string"
      ? `${icon} ${piece}${spin}${tip}`
      : `${icon} ${isEnglish() ? piece.name : piece.ko}${spin}${tip}  ·  ${t("F 모양 바꾸기", "F change shape")}`;
    if (label === this.lastPiece) return;
    this.lastPiece = label;
    this.pieceChip.textContent = label;
  }

  /** The block hotbar (and its key help, which the furniture bar's switcher
   *  would sit on) step aside while the furniture bar is up. */
  setHotbarVisible(visible: boolean): void {
    for (const sel of ['[data-id="hotbar"]', ".craft-help", '[data-id="slot-label"]']) {
      const el = this.root.querySelector<HTMLElement>(sel);
      if (el) el.style.display = visible ? "" : "none";
    }
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
      const endless = blockByKey(k)?.fluid === true;
      const n = countOf(counts, k);
      el.classList.toggle("selected", i === selected);
      el.classList.toggle("empty", !endless && n === 0);
      const count = el.querySelector<HTMLElement>(`[data-id="count-${k}"]`);
      if (count) count.textContent = endless ? "∞" : String(n);
    });
    this.root.classList.toggle("empty-hands", selected < 0);
    if (selected !== this.lastSelected) {
      this.lastSelected = selected;
      if (selected < 0) this.flashSlotLabel(t("✋ 빈손 · Q로 다시 블록 들기", "✋ Empty hands · Q to hold blocks again"));
      else this.showSlotLabel(HOTBAR[selected]!, counts);
    }
    if (this.recipesOpen) {
      for (const recipe of CRAFT_RECIPES) {
        const btn = this.recipeButtons.get(recipe.id);
        if (btn) btn.disabled = !canCraftRecipe(counts, recipe);
      }
    }
  }

  /** The selected block's name over the hotbar, briefly, each time it changes. */
  private showSlotLabel(key: string, counts: Counts): void {
    const def = blockByKey(key);
    if (!def) return;
    const n = countOf(counts, key);
    const extra = def.fluid ? t("무한 양동이", "endless bucket") : n === 0 ? t("없음 — 캐서 모아요", "none yet — mine some") : `${n}${t("개", "")}`;
    this.flashSlotLabel(`${blockName(def)} · ${extra}`);
  }

  private flashSlotLabel(text: string): void {
    this.slotLabel.textContent = text;
    this.slotLabel.classList.add("show");
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(() => this.slotLabel.classList.remove("show"), 1800);
  }

  private toastEl: HTMLElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  dispose(): void {
    clearTimeout(this.toastTimer); clearTimeout(this.labelTimer);
    this.toastEl?.remove(); this.toastEl = null;
    this.root.remove(); this.recipePanel.remove(); this.pieceChip.remove(); this.menu.dispose();
    this.slots.length = 0; this.recipeButtons.clear();
  }

  /** One toast at a time: a new message replaces the old one instead of
   *  stacking on top of it (cycling a setting fires several in a row). */
  toast(text: string): void {
    clearTimeout(this.toastTimer);
    this.toastEl?.remove();
    const el = document.createElement("div");
    el.className = "b-toast";
    el.textContent = text;
    document.body.appendChild(el);
    this.toastEl = el;
    this.toastTimer = setTimeout(() => {
      el.remove();
      if (this.toastEl === el) this.toastEl = null;
    }, 3200);
  }
}
