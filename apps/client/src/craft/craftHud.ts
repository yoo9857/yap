import {itemByKey, itemIcon, type InventoryItem} from "./itemCatalog.js";
import {
  HOTBAR_SLOTS,
  countOf,
  type Counts,
  type CraftRecipe,
} from "./inventory.js";
import { BagPanel, type BagTab } from "./bag.js";
import { GameMenu, keyBarHtml, type HelpGroup, type KeyHelp } from "../ui/gameMenu.js";
import { isEnglish, t } from "../ui/i18n.js";
import { KEY_WASD, MOUSE_LEFT, MOUSE_MIDDLE, MOUSE_MOVE, MOUSE_RIGHT, MOUSE_WHEEL } from "../ui/inputGlyphs.js";

const blockName = (def: InventoryItem | undefined): string => (def ? (isEnglish() ? def.name : def.ko) : "");

const ESSENTIALS = (): KeyHelp[] => [
  { keys: [KEY_WASD], label: t("걷기", "Walk") },
  { keys: ["Shift"], label: t("달리기", "Run") },
  { keys: ["Space"], label: t("점프", "Jump") },
  { keys: [MOUSE_LEFT], label: t("도구 공격 / 꾹 눌러 캐기", "Attack / hold to mine") },
  { keys: [MOUSE_RIGHT], label: t("블록 놓기", "Place block") },
];

function helpGroups(furniture: boolean): HelpGroup[] {
  return [
    {
      title: t("움직이기", "Moving"),
      items: [
        { keys: [KEY_WASD], label: t("걷기", "Walk") },
        { keys: ["Shift"], label: t("달리기", "Run") },
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
        { keys: ["E"], label: t("가방 — 넣기 · 끌어다 옮기기", "Bag — load a block, or drag it to a slot") },
        { keys: ["R"], label: t("곡괭이를 들었을 때 옵션 바꾸기", "Cycle options while holding a pickaxe") },
        { keys: ["I"], label: t("조합 · Shift+클릭은 여러 개", "Crafting · Shift+click makes a batch") },
        { keys: ["1–9", MOUSE_WHEEL], label: t("핫바에서 고르기", "Pick from the hotbar") },
        { keys: ["0"], label: t("물 양동이", "Water bucket") },
        { keys: [MOUSE_MIDDLE], label: t("보고 있는 블록을 핫바에 넣기", "Put the aimed block on the hotbar") },
        { keys: ["F"], label: t("블록 모양 바꾸기", "Change brick shape") },
        { keys: ["R", "T"], label: t("돌리기 · 기울이기", "Rotate · tilt") },
        { keys: ["Q"], label: t("빈손 ↔ 블록 쌓기 (빈손은 캐기만, 놓지 않아요)", "Empty hands ↔ building (empty hands mine but never place)") },
      ],
    },
    {
      title: t("꾸미기와 친구들", "Decorate & friends"),
      items: [
        ...(furniture ? [{ keys: ["G"], label: t("가구 모드", "Furniture mode") }] : []),
        { keys: ["B"], label: t("기계 작업실 (자동차·비행기)", "Machine lab (cars, planes)") },
        { keys: ["Y"], label: t("반려동물 입양하기", "Adopt a pet") },
        { keys: [MOUSE_LEFT], label: t("교실에서 가까운 친구를 바라보고 가볍게 톡", "In class, look at a nearby friend and give them a light tap") },
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
 * Craft-mode DOM UI: crosshair, 10-slot hotbar, the bag (E blocks / I crafting)
 * and the start/pause menu. Rules live in inventory.ts.
 */
export class CraftHud {
  private readonly root: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly slotKeys: string[] = [];
  private readonly bag: BagPanel;
  private readonly pieceChip: HTMLElement;
  private readonly slotLabel: HTMLElement;
  readonly menu: GameMenu;
  private lastKey = "";
  private lastPiece = "";
  private lastSelected = -2;
  private lastLabel = "";
  private labelTimer: ReturnType<typeof setTimeout> | undefined;
  private locked = false;

  constructor(
    parent: HTMLElement,
    private readonly onCraft: (recipe: CraftRecipe, many: boolean) => void,
    opts: {
      furniture?: boolean;
      creative?: boolean;
      mode?: string;
      onResume: () => void;
      onRecipesClose?: () => void;
      onAssign: (slot: number, key: string, move: boolean, hold?: boolean) => void;
      onClearSlot: (slot: number) => void;
      onArm: (slot: number) => void;
      onSelect: (slot: number) => void;
    },
  ) {
    this.root = document.createElement("div");
    this.root.className = "craft-hud";
    const slots = Array.from({ length: HOTBAR_SLOTS }, (_, i) => `
        <div class="craft-slot blank" data-slot="${i}">
          <span class="craft-slot-num">${(i + 1) % 10}</span>
          <img alt="" hidden />
          <b></b>
        </div>`).join("");
    this.root.innerHTML = `
      <div class="craft-crosshair">+</div>
      <div class="craft-mine-bar hidden"><div class="craft-mine-fill" data-id="mine-fill"></div></div>
      <div class="craft-slot-label" data-id="slot-label"></div>
      <div class="craft-hotbar" data-id="hotbar">${slots}</div>
      <div class="craft-help gm-keybar">${keyBarHtml([...ESSENTIALS(), { keys: ["E"], label: t("가방", "Bag") }, { keys: ["C"], label: t("감정표현", "Emotes") }, { keys: ["Z"], label: t("기어가기", "Crawl") }, { keys: ["Q"], label: t("빈손", "Empty hands") }])}</div>
    `;
    parent.appendChild(this.root);
    this.slotLabel = this.root.querySelector<HTMLElement>('[data-id="slot-label"]')!;

    this.pieceChip = document.createElement("div");
    this.pieceChip.className = "craft-piece";
    parent.appendChild(this.pieceChip);
    const worldBar = this.root.querySelector<HTMLElement>('[data-id="hotbar"]')!;
    this.root.querySelectorAll<HTMLElement>(".craft-slot").forEach((el, index) => {
      this.slots.push(el);
      el.addEventListener("click", () => {
        if (this.bag.consumeDragClick()) return;
        opts.onSelect(index);
      });
    });

    this.bag = new BagPanel(
      parent,
      opts.creative === true,
      (recipe, many) => this.onCraft(recipe, many),
      opts.onAssign,
      opts.onClearSlot,
      opts.onArm,
      () => {
        this.bag.hide();
        opts.onRecipesClose?.();
      },
      worldBar,
    );

    this.menu = new GameMenu(parent, {
      mode: opts.mode ?? "Craft Island",
      essentials: ESSENTIALS(),
      help: helpGroups(opts.furniture !== false),
      onResume: opts.onResume,
    });
  }

  get recipesOpen(): boolean {
    return this.bag.isOpen;
  }

  get bagTab(): BagTab {
    return this.bag.currentTab;
  }

  setWorkshopOpen(open: boolean): void {
    this.root.style.display = open ? "none" : "";
    this.pieceChip.style.display = open ? "none" : "";
    if (open) this.hideRecipes();
  }

  /** Open one bag tab, or close it when that tab is already open. */
  toggleBag(tab: BagTab, selected: number): boolean {
    return this.bag.toggle(tab, selected);
  }

  armBag(slot: number): void {
    this.bag.arm(slot);
  }

  hideRecipes(): void {
    this.bag.hide();
  }

  setPointerLocked(locked: boolean): void {
    this.locked = locked;
  }

  /** The start/pause card shows whenever the player is out of play and no
   *  other panel (bag, furniture, pets, the machine lab, chat) has the screen. */
  syncMenu(panelOpen: boolean): void {
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "range";
    this.menu.setVisible(!this.locked && !panelOpen && !this.recipesOpen && !typing);
  }

  /** Show the active building piece + its yaw / tilt rotation. */
  setPiece(piece: string | { name: string; ko: string }, yaw: number, tilt: number, icon = "🧱"): void {
    const spin = yaw ? ` · ↻${yaw * 90}°` : "";
    const tip = tilt ? ` · ⤢${tilt * 90}°` : "";
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

  update(counts: Counts, selected: number, hotbar: readonly string[]): void {
    this.bag.update(counts, hotbar);
    const key = hotbar.map((slot, index) => `${slot}:${countOf(counts, slot)}:${index === selected ? 1 : 0}`).join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;

    hotbar.forEach((slotKey, index) => {
      const el = this.slots[index];
      if (!el) return;
      const def = slotKey ? itemByKey(slotKey) : undefined;
      const endless = def?.fluid === true;
      const n = def && !endless ? countOf(counts, slotKey) : 0;
      el.classList.toggle("selected", index === selected);
      el.classList.toggle("blank", !def);
      el.classList.toggle("empty", !!def && !endless && n === 0);
      const img = el.querySelector("img");
      if (img && this.slotKeys[index] !== slotKey) {
        this.slotKeys[index] = slotKey;
        if (def) {
          img.src = itemIcon(def);
          img.alt = blockName(def);
          img.hidden = false;
          el.title = blockName(def);
        } else {
          img.removeAttribute("src");
          img.alt = "";
          img.hidden = true;
          el.title = "";
        }
      }
      const count = el.querySelector("b");
      if (count) count.textContent = !def ? "" : endless ? "∞" : String(n);
    });
    this.root.classList.toggle("empty-hands", selected < 0);
    const labelKey = selected < 0 ? "\0" : (hotbar[selected] ?? "");
    if (selected !== this.lastSelected || labelKey !== this.lastLabel) {
      this.lastSelected = selected;
      this.lastLabel = labelKey;
      if (selected < 0) this.flashSlotLabel(t("✋ 빈손 · Q로 다시 블록 들기", "✋ Empty hands · Q to hold blocks again"));
      else this.showSlotLabel(labelKey, counts);
    }
  }

  /** The selected block's name over the hotbar, briefly, each time it changes. */
  private showSlotLabel(key: string, counts: Counts): void {
    const def = key ? itemByKey(key) : undefined;
    if (!def) {
      this.flashSlotLabel(t("빈 칸 · E로 가방에서 넣어요", "Empty slot · E opens the bag"));
      return;
    }
    const n = countOf(counts, key);
    const extra = def.fluid ? t("무한 양동이", "endless bucket") : n === 0 ? t("없음 — 캐거나 조합해요", "none yet — mine or craft some") : `${n}${t("개", "")}`;
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
    this.root.remove(); this.bag.dispose(); this.pieceChip.remove(); this.menu.dispose();
    this.slots.length = 0;
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
