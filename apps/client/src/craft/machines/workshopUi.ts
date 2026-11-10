import { balanceAdvice, guideHint, scalePose, thrustGuides } from "./balance.js";
import {partControls,partLesson} from "./customization.js";
import { customizationScope } from "./editScope.js";
import {
  DIRECTIONS,
  PARTS,
  PART_ORDER,
  PRESETS,
  usesSkylarkModel,
  type Blueprint,
  type MachineStats,
  type PartGroup,
  type PartKind,
  type PresetKind,
} from "./blueprint.js";
import { SKYLARK_PART_ORDER, SKYLARK_PARTS, type SkylarkInspection, type SkylarkPart } from "./skylarkParts.js";
import { LIBRARY_SLOTS, type LibraryEntry, type MissionRecord } from "./library.js";
import { MISSIONS, type MissionProgress } from "./missions.js";
import { t } from "../../ui/i18n.js";

/**
 * All machine-lab DOM. The workshop owns state and 3D; this file owns pixels,
 * so neither one grows a second job. The garage presents one task at a time,
 * using images of the actual blocks and keeping the live preview unobstructed.
 */

export type MessageTone = "info" | "bad" | "good";
export type BuildScreen = "model" | "parts" | "tune" | "missions" | "library" | "help";
export type PreviewView = "front" | "side" | "top" | "fit";
type TuneSection = "appearance" | "performance";

const SCREEN_LABELS: Record<BuildScreen, string> = {
  model: t("모델 부품", "Model components"),
  parts: t("블록 조립", "Build blocks"),
  tune: t("블록 커스텀", "Customize blocks"),
  missions: t("시험 운전", "Test drive"),
  library: t("설계도 보관함", "Blueprint library"),
  help: t("조작법", "Controls"),
};

/** Palette group headings (the group values themselves are keys). */
const GROUP_EN: Record<string, string> = { 구조: "Structure", 구동: "Drive", 비행: "Flight" };
export type CameraMode = "chase" | "orbit" | "cockpit";
export const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: t("추적 시점", "Chase view"),
  orbit: t("자유 시점", "Orbit view"),
  cockpit: t("조종석 시점", "Cockpit view"),
};

export interface BuildView {
  blueprint: Blueprint;
  stats: MachineStats;
  selected: PartKind;
  direction: number;
  mirror: boolean;
  centerVisible: boolean;
  erase: boolean;
  assist: boolean;
  inspectMode:boolean;
  inspected:number;
  canUndo: boolean;
  canRedo: boolean;
  running: boolean;
  loading: boolean;
  assetsReady: boolean;
  skylark: SkylarkInspection | null;
  message: string;
  tone: MessageTone;
  entries: LibraryEntry[];
  recovery: LibraryEntry[];
  record: MissionRecord;
}

export interface BuildHandlers {
  navigate(screen: BuildScreen): void;
  explodeSkylark(): void;
  selectSkylarkPart(part: SkylarkPart): void;
  preview(view: PreviewView): void;
  selectPart(kind: PartKind): void;
  inspectPart(index:number):void;
  customizePart(index:number,key:string,value:string):void;
  quickStart(kind: PresetKind): void;
  toggleAssist(): void;
  setDirection(direction: number): void;
  usePreset(kind: PresetKind): void;
  rename(name: string): void;
  undo(): void;
  redo(): void;
  toggleMirror(): void;
  toggleCenter(): void;
  toggleErase(): void;
  frame(): void;
  clearAll(): void;
  run(): void;
  close(): void;
  science(): void;
  saveSlot(): void;
  thumbnail(blueprint: Blueprint, index?: number): string | null;
  replaceSlot(id: string): boolean;
  loadSlot(id: string): void;
  deleteSlot(id: string): void;
  restoreSlot(id: string): void;
  importShare(code: string): boolean;
}

const ICONS = {
  home: '<path d="m3 11 9-8 9 8v10H3zM9 21v-8h6v8" stroke-width="1.7" stroke-linejoin="round"/>',
  parts: '<path d="m12 3 9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9" stroke-width="1.7" stroke-linejoin="round"/>',
  tune: '<path d="M5 3v18M12 3v18M19 3v18M2 8h6M9 16h6M16 8h6" stroke-width="2" stroke-linecap="round"/>',
  missions: '<path d="M5 22V3h15l-3 5 3 5H5M5 3v10M10 3v5h7M10 8v5M15 3v5" stroke-width="1.7" stroke-linejoin="round"/>',
  library: '<path d="M3 6h7l2 3h9v12H3zM3 6V3h7l2 3h7v3" stroke-width="1.7" stroke-linejoin="round"/>',
  science: '<path d="M9 3h6M10 3v7L4 20h16l-6-10V3M7 15h10" stroke-width="1.7" stroke-linejoin="round"/>',
  help: '<circle cx="12" cy="12" r="9" stroke-width="1.7"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01" stroke-width="1.7" stroke-linecap="round"/>',
  undo: '<path d="M9 7H16a5 5 0 0 1 0 10h-5" fill="none" stroke-width="2.4" stroke-linecap="round"/><path d="M12 3 7.5 7 12 11" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  redo: '<path d="M15 7H8a5 5 0 0 0 0 10h5" fill="none" stroke-width="2.4" stroke-linecap="round"/><path d="M12 3l4.5 4L12 11" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  mirror:
    '<path d="M12 2v20" stroke-width="2.2" stroke-dasharray="3 3" fill="none"/><path d="M10 6 4 12l6 6zM14 6l6 6-6 6z" fill="none" stroke-width="2.2" stroke-linejoin="round"/>',
  erase:
    '<path d="m4 16 8-8 7 7-5 5H7z" fill="none" stroke-width="2.2" stroke-linejoin="round"/><path d="M3 21h18" stroke-width="2.2"/>',
  frame:
    '<path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4" fill="none" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="3.2" fill="none" stroke-width="2.2"/>',
  trash:
    '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke-width="2.2" stroke-linejoin="round"/>',
};
const strokeIcon = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" aria-hidden="true">${body}</svg>`;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

export function partInspectorMarkup(blueprint:Blueprint,index:number,mirror:boolean,disabled=false,garage=false,section:TuneSection="appearance"):string {
  const part=blueprint.parts[index],options=blueprint.parts.map((p,i)=>`<option value="${i}" ${i===index?"selected":""}>#${i+1} · ${escapeHtml(PARTS[p.kind].name)}${garage?"":` (${p.cell.join(", ")})`}</option>`).join("");
  const select=`<label class="mw-custom-field">${garage?t("커스텀할 블록","Block to customize"):t("조립한 부품","Assembled part")}<select data-inspect-index aria-label="${t("조정할 부품 선택","Choose a part to tune")}" ${disabled?"disabled":""}><option value="-1">${t("화면의 부품을 누르거나 여기서 선택","Click a part or choose here")}</option>${options}</select></label>`;
  if(!part)return `<section class="mw-custom">${select}<p>${t("바꿀 부품을 고른 뒤 한 가지 설정만 바꾸고 시험 운전해 보세요.","Choose a part, change one setting, then test drive.")}</p></section>`;
  const scope = customizationScope(blueprint, index, mirror);
  const scopeNote = scope.mode === "paired"
    ? t(`좌우 2개 함께 적용 · #${scope.indices.map(i => i + 1).join(" + #")}`, `Applies to both sides · #${scope.indices.map(i => i + 1).join(" + #")}`)
    : scope.mode === "center"
      ? t("중앙 블록 1개에 적용", "Applies to one centre block")
      : scope.mode === "missing"
        ? t("반대쪽에 같은 블록이 없어 이 블록만 변경됩니다", "No matching opposite block; only this block changes")
        : t("선택한 블록 1개에 적용", "Applies to the selected block only");
  const lesson=partLesson(part,PARTS[part.kind].mass);
  if (garage) {
    const fields = partControls(part.kind).filter(control => (control.key === "color") === (section === "appearance")).map(control => {
      const value = part.custom?.[control.key] ?? control.defaultValue;
      const optionLabel = (option: { value: string; label: string }) => control.key === "grip"
        ? option.value === "smooth" ? t("낮음", "Low") : option.value === "grippy" ? t("높음", "High") : t("기본", "Standard")
        : option.label;
      const choices = control.options.map(option => {
        const swatch = control.key === "color";
        const block = swatch ? `<img src="/ui/machines/color-${option.value}.webp" alt="" width="42" height="42" draggable="false">` : "";
        return `<button class="mw-btn ${swatch ? "mw-swatch" : "mw-option"}" data-custom-option="${control.key}" data-index="${index}" data-value="${option.value}" aria-pressed="${value === option.value}" title="${escapeHtml(option.label)}" ${disabled ? "disabled" : ""}>${block}<span>${escapeHtml(optionLabel(option))}</span></button>`;
      }).join("");
      const current = control.options.find(option => option.value === value)!;
      return `<div class="mw-tuning-group"><h4>${escapeHtml(control.label)}<span class="mw-setting-value">${escapeHtml(optionLabel(current))}</span></h4><div class="${control.key === "color" ? "mw-swatches" : "mw-options"}" role="group" aria-label="${escapeHtml(control.label)}">${choices}</div></div>`;
    }).join("");
    const direction = section === "performance" && PARTS[part.kind].directional ? `<label class="mw-custom-field">${t("작용 방향", "Force direction")} · R<select data-custom="direction" data-index="${index}" ${disabled ? "disabled" : ""}>${DIRECTIONS.map((d,i)=>`<option value="${i}" ${part.direction===i?"selected":""}>${escapeHtml(d.name)}</option>`).join("")}</select></label>` : "";
    const tabs = `<div class="mw-tune-tabs" role="group" aria-label="${t("블록 커스텀 항목", "Block customization category")}"><button class="mw-btn" data-tune-section="appearance" aria-pressed="${section === "appearance"}" ${disabled?"disabled":""}>${t("컬러", "Colour")}</button><button class="mw-btn" data-tune-section="performance" aria-pressed="${section === "performance"}" ${disabled?"disabled":""}>${t("성능", "Performance")}</button></div>`;
    const details = section === "performance" ? `<p class="mw-custom-facts">${lesson.facts.map(escapeHtml).join(" · ")}</p><details class="mw-custom-lesson"><summary>${escapeHtml(lesson.question)}</summary><p>${escapeHtml(lesson.hint)}</p></details>` : "";
    const reset = section === "appearance" ? `<button class="mw-btn mw-textlink" data-custom-option="color" data-index="${index}" data-value="${partControls(part.kind)[0]!.defaultValue}" ${disabled?"disabled":""}>↺ ${t("컬러 초기화", "Reset colour")}</button>` : `<button class="mw-btn mw-textlink" data-custom-reset="${index}" ${disabled?"disabled":""}>↺ ${t("블록 설정 전체 초기화", "Reset all block settings")}</button>`;
    return `<section class="mw-custom mw-garage-custom"><div class="mw-custom-target">${select}<div class="mw-inspected-heading"><img src="/ui/machines/${part.kind}.webp" alt="" width="64" height="64"><div><small>BLOCK ${String(index + 1).padStart(2,"0")}</small><h3>${escapeHtml(PARTS[part.kind].name)}</h3></div></div></div><div class="mw-custom-editor"><div class="mw-custom-topline">${tabs}${reset}</div><div class="mw-custom-settings">${fields}${direction}</div><div class="mw-custom-notes"><small class="mw-mirror-note" data-scope="${scope.mode}">${escapeHtml(scopeNote)}</small>${details}</div></div></section>`;
  }
  let fields=partControls(part.kind).map(c=>`<label class="mw-custom-field">${escapeHtml(c.label)}<select data-custom="${c.key}" data-index="${index}" aria-label="${escapeHtml(c.label)}" ${disabled?"disabled":""}>${c.options.map(o=>`<option value="${o.value}" ${(part.custom?.[c.key]??c.defaultValue)===o.value?"selected":""}>${escapeHtml(o.label)}</option>`).join("")}</select></label>`).join("");
  if(PARTS[part.kind].directional)fields+=`<label class="mw-custom-field">작용 방향 · R<select data-custom="direction" data-index="${index}" aria-label="작용 방향" ${disabled?"disabled":""}>${DIRECTIONS.map((d,i)=>`<option value="${i}" ${part.direction===i?"selected":""}>${escapeHtml(d.name)}</option>`).join("")}</select></label>`;
  return `<section class="mw-custom">${select}<h3>#${index+1} · ${escapeHtml(PARTS[part.kind].name)}</h3><div class="mw-custom-fields">${fields}</div><p class="mw-custom-facts">${lesson.facts.map(escapeHtml).join(" · ")}</p><div class="mw-custom-lesson"><b>${escapeHtml(lesson.question)}</b><p>${escapeHtml(lesson.hint)}</p></div><small>${mirror?t("대칭 켜짐: 반대쪽 같은 부품도 함께 바뀝니다.","Mirror on: the matching opposite part changes too."):t("이 부품 하나만 바뀝니다.","Only this part changes.")}</small><button class="mw-btn" data-custom-reset="${index}" ${disabled?"disabled":""}>${t("이 부품 기본값","Reset this part")}</button></section>`;
}

/** A task picker opens one focused workshop screen at a time. */
export class BuildPanel {
  readonly element = document.createElement("div");
  previewOffsetY = 0;
  previewZoom = 1;
  previewWidth = 0;
  previewHeight = 0;
  /** Pixels kept clear on the right so the centre-of-mass card does not cover the machine. */
  balanceLane = 0;
  private screen: BuildScreen = "parts";
  private partFilter: PartGroup | "all" = "all";
  private lastSelected: PartKind | null = null;
  private tuneSection: TuneSection = "appearance";
  private currentView: BuildView | null = null;
  private shareCode = "";
  private replacementId: string | null = null;
  private readonly nameField: HTMLInputElement;
  private readonly shareField: HTMLTextAreaElement;
  private readonly runButton: HTMLButtonElement;
  // Not "" — an empty shelf must still render its empty-state copy once.
  private lastEntries = "\u0000";
  private lastCustom="";

  constructor(
    private readonly handlers: BuildHandlers,
    signal: AbortSignal,
  ) {
    this.element.className = "machine-ui machine-panel mw-card";
    this.element.hidden = true;
    this.element.innerHTML = this.markup();
    this.nameField = this.q<HTMLInputElement>('[data-id="name"]');
    this.shareField = this.q<HTMLTextAreaElement>('[data-id="share"]');
    this.runButton = this.q<HTMLButtonElement>('[data-id="run"]');
    const on = <K extends keyof HTMLElementEventMap>(
      target: Element,
      type: K,
      run: (event: HTMLElementEventMap[K]) => void,
    ) => target.addEventListener(type, run as EventListener, { signal });

    this.element.querySelectorAll<HTMLElement>("[data-screen]").forEach((button) =>
      on(button, "click", () => {
        handlers.navigate(button.dataset.screen as BuildScreen);
      }),
    );
    on(this.q('[data-id="skylark-explode"]'), "click", () => handlers.explodeSkylark());
    this.element.querySelectorAll<HTMLButtonElement>("[data-skylark-part]").forEach(button =>
      on(button, "click", () => handlers.selectSkylarkPart(button.dataset.skylarkPart as SkylarkPart)),
    );
    this.element.querySelectorAll<HTMLElement>("[data-preview]").forEach(button =>
      on(button, "click", () => handlers.preview(button.dataset.preview as PreviewView)),
    );
    this.element.querySelectorAll<HTMLElement>("[data-filter]").forEach(button =>
      on(button, "click", () => this.filterParts(button.dataset.filter as PartGroup | "all")),
    );
    this.element
      .querySelectorAll<HTMLButtonElement>("[data-part]")
      .forEach((button) =>
        on(button, "click", () =>
          handlers.selectPart(button.dataset.part as PartKind),
        ),
      );
    this.element
      .querySelectorAll<HTMLButtonElement>("[data-dir]")
      .forEach((button) =>
        on(button, "click", () =>
          handlers.setDirection(Number(button.dataset.dir)),
        ),
      );
    this.element
      .querySelectorAll<HTMLButtonElement>("[data-quick]")
      .forEach((button) =>
        on(button, "click", () =>
          handlers.quickStart(button.dataset.quick as PresetKind),
        ),
      );
    this.element
      .querySelectorAll<HTMLButtonElement>("[data-preset]")
      .forEach((button) =>
        on(button, "click", () =>
          handlers.usePreset(button.dataset.preset as PresetKind),
        ),
      );
    const act: Record<string, () => void> = {
      undo: () => handlers.undo(),
      redo: () => handlers.redo(),
      mirror: () => handlers.toggleMirror(),
      center: () => handlers.toggleCenter(),
      erase: () => handlers.toggleErase(),
      frame: () => handlers.frame(),
      clear: () => handlers.clearAll(),
      run: () => handlers.run(),
      close: () => handlers.close(),
      science: () => handlers.science(),
      save: () => handlers.saveSlot(),
      assist: () => handlers.toggleAssist(),
      import: () => {
        if (handlers.importShare(this.shareField.value)) {
          this.q<HTMLDetailsElement>('[data-id="share-import"]').open = false;
          this.shareField.value = "";
        }
      },
      copy: () => void this.copyShare(),
    };
    for (const [id, run] of Object.entries(act))
      on(this.q(`[data-id="${id}"]`), "click", () => run());
    on(this.nameField, "change", () => handlers.rename(this.nameField.value));
    on(this.q('[data-id="slots"]'), "click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-slot]",
      );
      if (!button) return;
      const id = button.dataset.slot!;
      if (button.dataset.action === "delete") handlers.deleteSlot(id);
      else if (button.dataset.action === "replace") this.reviewReplacement(id);
      else handlers.loadSlot(id);
    });
    on(this.q('[data-id="recovery-list"]'), "click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-restore]");
      if (button && !button.disabled) handlers.restoreSlot(button.dataset.restore!);
    });
    const replacement = this.q<HTMLDialogElement>('[data-id="replace-dialog"]');
    on(this.q('[data-id="replace-cancel"]'), "click", () => replacement.close());
    on(this.q('[data-id="replace-confirm"]'), "click", () => {
      if (!this.replacementId) return;
      if (handlers.replaceSlot(this.replacementId)) replacement.close();
      else this.text("replace-error", this.currentView?.message ?? "");
    });
    on(replacement, "close", () => { this.replacementId = null; });
    on(replacement, "keydown", event => event.stopPropagation());
    on(this.q('[data-id="custom"]'),"change",event=>{
      const field=event.target as HTMLSelectElement;
      if(field.dataset.inspectIndex!==undefined)handlers.inspectPart(Number(field.value));
      else if(field.dataset.custom&&field.dataset.index!==undefined)handlers.customizePart(Number(field.dataset.index),field.dataset.custom,field.value);
    });
    on(this.q('[data-id="custom"]'),"click",event=>{
      const section=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-tune-section]');
      if (section && !section.disabled) {
        this.tuneSection = section.dataset.tuneSection as TuneSection;
        if (this.currentView) this.update(this.currentView);
        return;
      }
      const option=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-custom-option]');
      if(option && !option.disabled)handlers.customizePart(Number(option.dataset.index),option.dataset.customOption!,option.dataset.value!);
      const button=(event.target as HTMLElement).closest<HTMLElement>('[data-custom-reset]');
      if(button)handlers.customizePart(Number(button.dataset.customReset),"reset","");
    });
    this.element.querySelectorAll<HTMLButtonElement>("[data-scroll]").forEach(button => {
      on(button, "click", () => {
        const rail = this.q(`[data-rail="${button.dataset.scroll}"]`);
        rail.scrollBy({ left: Number(button.dataset.step) * rail.clientWidth * .75, behavior: "smooth" });
      });
    });
    const stage = this.q('[data-id="preview-stage"]');
    const observer = new ResizeObserver(() => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.height) {
        this.previewWidth = bounds.width;
        this.previewHeight = bounds.height;
        this.previewOffsetY = Math.round(window.innerHeight / 2 - (bounds.top + bounds.height * .47));
        this.previewZoom = Math.max(1, Math.min(1.65, window.innerHeight * .48 / bounds.height));
      }
      this.syncBalanceLane();
      this.syncRails();
    });
    observer.observe(stage);
    this.element.querySelectorAll<HTMLElement>("[data-rail]").forEach(rail => observer.observe(rail));
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    document.addEventListener("pointerdown", event => {
      if (!(event.target instanceof Node)) return;
      this.element.querySelectorAll<HTMLDetailsElement>(".mw-advanced[open], .mw-share-import[open], .mw-recovery[open]").forEach(details => {
        if (!details.contains(event.target as Node)) details.open = false;
      });
    }, { signal });
    this.element.addEventListener("keydown", event => {
      if (event.code !== "Escape") return;
      this.element.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(details => { details.open = false; });
    }, { signal });
    this.showScreen("parts");
  }

  private q<T extends Element = HTMLElement>(selector: string): T {
    return this.element.querySelector<T>(selector)!;
  }

  get hasModal(): boolean {
    return this.q<HTMLDialogElement>('[data-id="replace-dialog"]').open;
  }

  dismissOverlays(): void {
    this.element.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(details => { details.open = false; });
    this.q<HTMLDialogElement>('[data-id="replace-dialog"]').close();
  }

  private reviewReplacement(id: string): void {
    const entry = this.currentView?.entries.find(entry => entry.id === id);
    if (!entry || !this.currentView) return;
    this.replacementId = id;
    this.text("replace-target", entry.blueprint.name);
    this.text("replace-source", this.currentView.blueprint.name);
    this.text("replace-error", "");
    this.q<HTMLDialogElement>('[data-id="replace-dialog"]').showModal();
  }

  private markup(): string {
    const groups: PartGroup[] = ["구조", "구동", "비행"];
    const tiles = PART_ORDER
          .map((kind) => {
            const part = PARTS[kind];
            const slot = PART_ORDER.indexOf(kind) + 1;
            return `<button class="mw-btn mw-part" data-part="${kind}" data-part-group="${part.group}" aria-pressed="false" title="${escapeHtml(`${part.name} · ${part.blurb}
${part.detail}`)}">
              <span class="mw-hot">${slot}</span><img src="/ui/machines/${kind}.webp" alt="" width="88" height="88" draggable="false">
              <b>${part.name}</b></button>`;
          })
          .join("");
    const filters = `<div class="mw-block-filters" role="group" aria-label="${t("블록 종류", "Block category")}"><button class="mw-btn" data-filter="all" aria-pressed="true">${t("전체", "All")} <small>8</small></button>${groups.map(group => `<button class="mw-btn" data-filter="${group}" aria-pressed="false">${t(group, GROUP_EN[group] ?? group)}</button>`).join("")}</div>`;
    const railControls = (name: string) => `<div class="mw-rail-controls"><button class="mw-btn" data-scroll="${name}" data-step="-1" aria-label="${t("이전 항목", "Previous items")}" hidden>←</button><button class="mw-btn" data-scroll="${name}" data-step="1" aria-label="${t("다음 항목", "Next items")}" hidden>→</button></div>`;
    const dirs = DIRECTIONS.map(
      (d, i) =>
        `<button class="mw-btn" data-dir="${i}" aria-pressed="false">${d.short}</button>`,
    ).join("");
    const presets = PRESETS.map(
      (p) =>
        `<button class="mw-btn mw-example" data-preset="${p.kind}"><img src="/ui/machines/${p.kind}.webp" alt="" width="96" height="76" draggable="false"><span>${p.label}</span></button>`,
    ).join("");
    const missions = MISSIONS.map(
      (m) => `<div class="mw-mission" data-mission="${m.id}">
        <span class="mw-check">${String(MISSIONS.indexOf(m) + 1).padStart(2, "0")}</span>
        <div><b>${t(m.name, m.en.name)}</b> <em>${t(m.target, m.en.target)}</em><small>${t(m.hint, m.en.hint)}</small>
        <div class="mw-track"><div class="mw-fill" data-fill="${m.id}"></div></div></div></div>`,
    ).join("");
    const keys = [
      [t("부품 붙이기 / 떼기", "Attach / remove a part"), t("클릭 / 우클릭", "Click / right click")],
      [t("부품 고르기", "Pick a part"), "1 ~ 8"],
      [t("조립한 부품 조정", "Tune an assembled part"), "V"],
      [t("방향 돌리기", "Turn direction"), "R"],
      [t("좌우 대칭", "Mirror left/right"), "M"],
      [t("지우개", "Eraser"), "X"],
      [t("실행 취소 / 다시", "Undo / redo"), "Ctrl+Z / Ctrl+Y"],
      [t("무게", "Weight"), t("오른쪽 접시", "Dish on the right")],
      [t("화면에 맞추기", "Fit to screen"), "F"],
      [t("시점 회전 / 확대", "Orbit / zoom"), t("드래그 / 휠", "Drag / wheel")],
      [t("주행 · 조향", "Drive · steer"), "W S · A D"],
      [t("상승 · 하강", "Climb · descend"), "Space · Z"],
      [t("방향 추진", "Directional thrust"), "Shift"],
      [t("조작 보조 켜고 끄기", "Pilot assist on/off"), "G"],
      [t("기울기 · 롤", "Pitch · roll"), "↑ ↓ · Q E"],
      [t("브레이크 · 제자리로", "Brake · respawn"), "X · R"],
      [t("카메라 바꾸기", "Switch camera"), "C"],
      [t("시험 운전 / 정지", "Test drive / stop"), "Enter"],
    ]
      .map(([label, key]) => `<div><span>${label}</span><kbd>${key}</kbd></div>`)
      .join("");
    const sections: BuildScreen[] = ["model", "parts", "tune", "missions", "library", "help"];
    return `
      <div class="mw-preview-stage" data-id="preview-stage" aria-hidden="true"></div>
      <header class="mw-head">
        <div class="mw-brand"><img class="mw-brand-block" src="/ui/machines/frame.webp" alt="" width="54" height="54"><div><small>CRAFTYAP GARAGE</small><h1>${t("기계 작업실", "Machine workshop")}</h1></div></div>
        <div class="mw-headtext"><div class="mw-eyebrow">${t("내 기계 · 이름 변경", "My machine · rename")}</div><input class="mw-name" data-id="name" maxlength="48" aria-label="${t("설계도 이름", "Blueprint name")}" /></div>
      </header>
      <nav class="mw-sections" aria-label="${t("작업실 메뉴", "Workshop menu")}">
        ${sections.map(screen=>`<button class="mw-btn mw-section" data-screen="${screen}"${screen === "model" ? " hidden" : ""}>${strokeIcon(ICONS[screen === "model" ? "parts" : screen])}<span>${SCREEN_LABELS[screen]}</span></button>`).join("")}
        <button class="mw-btn mw-science-entry" data-id="science">${strokeIcon(ICONS.science)} ${t("과학 실험실", "Science lab")} ↗</button>
      </nav>
      <div class="mw-navigation">
        <h2 data-id="screen-title" tabindex="-1"></h2>
        <div class="mw-tools" data-id="toolrow" data-screen-only="parts tune">
          <button class="mw-btn" data-id="undo" title="Ctrl+Z">${strokeIcon(ICONS.undo)}${t("실행취소", "Undo")}</button>
          <button class="mw-btn" data-id="redo" title="Ctrl+Y">${strokeIcon(ICONS.redo)}${t("다시실행", "Redo")}</button>
          <button class="mw-btn" data-id="erase" data-screen-only="parts" aria-pressed="false" title="X">${strokeIcon(ICONS.erase)}${t("지우개", "Eraser")}</button>
          <details class="mw-advanced" data-id="advanced"><summary>${t("추가 도구", "More tools")} ⋯</summary><div class="mw-advanced-menu">
            <button class="mw-btn" data-id="mirror" aria-pressed="true">${strokeIcon(ICONS.mirror)}${t("좌우 함께 편집", "Edit both sides")}</button>
            <small>${t("기본은 대칭 편집입니다. 개별 블록을 바꿀 때만 꺼 주세요.", "Symmetry is the default. Turn it off only to edit a single block.")}</small>
            <button class="mw-btn" data-id="frame">${strokeIcon(ICONS.frame)}${t("기계 전체 보기", "Fit the machine")}</button>
            <button class="mw-btn" data-id="center" aria-pressed="true">${t("무게중심 보기", "Show centre of mass")}</button>
            <button class="mw-btn mw-textlink" data-id="clear">${t("조종석만 남기고 비우기", "Clear all but the cockpit")}</button>
            <div class="mw-dirpad" data-id="dirpad"><div class="mw-group">${t("블록 방향 · R", "Block direction · R")}</div><div class="mw-dirgrid">${dirs}</div></div>
          </div></details>
        </div>
      </div>
      <aside class="mw-overview" aria-label="${t("기계 정보", "Machine overview")}">
        <div class="mw-figures">
          <div class="mw-figure"><span data-id="fig-parts-label">${t("블록", "Blocks")}</span><b data-id="fig-parts">0</b></div>
          <div class="mw-figure"><b data-id="fig-mass">0</b><span>kg</span></div>
          <div class="mw-figure" data-screen-only="missions"><span>${t("바퀴", "Wheels")}</span><b data-id="fig-wheels">0</b></div>
          <div class="mw-figure mw-wing-figure" data-screen-only="missions"><span>${t("날개", "Wings")}</span><b data-id="fig-wing">0</b><span>m²</span></div>
        </div>
        <div class="mw-meterrow" data-screen-only="missions">
          <div class="mw-meter"><span>${t("상승력", "Lift")}</span><div class="mw-track"><div class="mw-fill" data-id="lift-fill"></div></div><b data-id="lift-text">0.00</b></div>
          <div class="mw-meter"><span>${t("안정성", "Stability")}</span><div class="mw-track"><div class="mw-fill" data-id="stance-fill"></div></div><b data-id="stance-text">–</b></div>
        </div>
      </aside>
      <aside class="mw-balance" data-id="balance" data-tone="good">
        <div class="mw-scale" data-id="face" role="img">
          <span class="mw-scale-front">${t("앞", "Front")}</span>
          <i class="mw-scale-shadow" data-id="shadow"></i>
          <div class="mw-scale-rig" data-id="tilt">
            <div class="mw-scale-plate">
              <i class="mw-scale-nose"></i>
              <b class="mw-scale-ball" data-id="ball"></b>
            </div>
          </div>
          <i class="mw-scale-level"></i>
          <span class="mw-scale-name">${t("무게", "Weight")}</span>
        </div>
      </aside>
      <div class="mw-preview-heading"><span class="mw-live-dot"></span><span data-id="preview-state">LIVE PREVIEW</span><span>360°</span></div>
      <div class="mw-preview-hint"><span class="mw-orbit-note">${t("드래그 · 회전 / 휠 · 확대", "Drag · rotate / Scroll · zoom")}</span><div class="mw-preview-views" role="group" aria-label="${t("미리보기 시점", "Preview camera")}"><button class="mw-btn" data-preview="front">${t("정면", "Front")}</button><button class="mw-btn" data-preview="side">${t("측면", "Side")}</button><button class="mw-btn" data-preview="top">${t("위", "Top")}</button><button class="mw-btn" data-preview="fit">${t("전체", "Fit")}</button></div></div>
      <div class="mw-body">
        <section class="mw-pane" data-pane="parts">
          <div class="mw-pane-head">${filters}<p class="mw-screen-hint">${t("블록을 고른 뒤, 붙일 면을 클릭하세요.", "Choose a block, then click a face to attach it.")}</p>${railControls("parts")}</div>
          <div class="mw-parts" data-rail="parts">${tiles}</div>
          <div class="mw-block-description"><b data-id="selected-name"></b><p class="mw-detail" data-id="detail"></p></div>
        </section>
        <section class="mw-pane" data-pane="tune" hidden><div data-id="custom"></div></section>
        <section class="mw-pane mw-model-parts" data-pane="model" hidden>
          <div class="mw-model-head"><strong data-id="skylark-summary"></strong><button class="mw-btn" data-id="skylark-explode" aria-pressed="false">${t("분해 보기", "Explode model")}</button></div>
          <div class="mw-model-list" role="group" aria-label="${t("Skylark 모델 부품", "Skylark model components")}">
            ${SKYLARK_PART_ORDER.map(key => `<button class="mw-btn" data-skylark-part="${key}" aria-pressed="false">${t(SKYLARK_PARTS[key][0], SKYLARK_PARTS[key][1])}</button>`).join("")}
          </div>
          <p class="mw-screen-hint" data-id="skylark-connection" aria-live="polite"></p>
        </section>
        <section class="mw-pane mw-library-layout" data-pane="library" hidden>
          <section><div class="mw-group">${t("예제로 시작", "Start from an example")}</div><div class="mw-examples">${presets}</div><p class="mw-screen-hint" data-id="skylark-note" hidden></p></section>
          <section><div class="mw-library-heading"><span class="mw-group">${t("내 설계도", "My blueprints")} <small data-id="slot-count">0 / ${LIBRARY_SLOTS}</small></span><button class="mw-btn" data-id="save">＋ ${t("새로 저장", "Save new")}</button></div><div class="mw-slots" data-id="slots"></div><details class="mw-recovery" data-id="recovery"><summary>${strokeIcon(ICONS.undo)} ${t("복구함", "Recovery")} <span data-id="recovery-count">0</span></summary><div class="mw-recovery-sheet"><h3>${t("설계도 복구함", "Blueprint recovery")}</h3><p>${t("최근 12개 삭제본과 교체 전 버전을 보관합니다. 복구하려면 보관함에 빈칸이 필요해요.", "Keeps the last 12 deleted or replaced blueprints. Restoring needs a free library slot.")}</p><div data-id="recovery-list"></div></div></details></section>
          <section class="mw-share-section"><div class="mw-group">${t("친구와 공유", "Share with friends")}</div><p class="mw-share-explain">${t("내 기계를 보내거나, 친구의 설계도를 가져오세요.", "Send your machine or load a friend's blueprint.")}</p><button class="mw-btn" data-id="copy">${t("코드 복사", "Copy code")}</button><details class="mw-share-import" data-id="share-import"><summary>${t("코드로 불러오기", "Load a share code")} ↗</summary><div class="mw-import-sheet"><label>${t("공유 코드를 붙여넣으세요", "Paste a share code")}<textarea class="mw-share" data-id="share" spellcheck="false" aria-label="${t("공유 코드", "Share code")}"></textarea></label><button class="mw-btn" data-id="import">${t("이 설계도 불러오기", "Load this blueprint")}</button></div></details></section>
        </section>
        <section class="mw-pane mw-drive-layout" data-pane="missions" hidden>
          <div class="mw-drive-settings"><button class="mw-btn mw-assist" data-id="assist" aria-pressed="true"><span class="mw-dot"></span><b>${t("조작 보조", "Pilot assist")}</b><small data-id="assist-note"></small></button><p class="mw-drive-basics">${t("W S 주행 · A D 조향 · Space 상승", "W S drive · A D steer · Space climb")}</p><div class="mw-quickrow"><button class="mw-btn" data-quick="rover"><img src="/ui/machines/rover.webp" alt="" width="80" height="54"><b>${t("자동차 타기", "Drive a car")}</b></button><button class="mw-btn" data-quick="plane"><img src="/ui/machines/plane.webp" alt="" width="80" height="54"><b>${t("비행기 타기", "Fly a plane")}</b></button><button class="mw-btn" data-quick="skylark"><img src="/ui/machines/skylark.webp" alt="" width="80" height="54"><b data-id="skylark-quick-label">${t("Skylark 타기", "Fly Skylark")}</b></button></div></div>
          <div class="mw-missions-section"><div class="mw-pane-head"><div class="mw-group">${t("주행 목표", "Driving goals")}</div><div class="mw-records"><span>${t("나의 기록", "Personal best")}</span><div class="mw-figure"><b data-id="rec-speed">0</b><span>km/h</span></div><div class="mw-figure"><b data-id="rec-alt">0</b><span>${t("고도 m", "alt. m")}</span></div><div class="mw-figure"><b data-id="rec-dist">0</b><span>${t("거리 m", "dist. m")}</span></div></div>${railControls("missions")}</div><div class="mw-mission-list" data-rail="missions">${missions}</div></div>
        </section>
        <section class="mw-pane" data-pane="help" hidden><div class="mw-keys">${keys}</div></section>
      </div>
      <p class="mw-message" data-id="message" aria-live="polite"></p>
      <div class="mw-runline" data-id="runline"><span data-id="run-time">0.0${t("초", "s")}</span><span data-id="run-dist">0 m</span><span data-id="run-top">0 km/h</span></div>
      <footer class="mw-foot">
        <button class="mw-btn mw-ghost" data-id="close">↩ ${t("작업실 나가기", "Leave the workshop")} · B</button>
        <span class="mw-mirror-status" data-id="mirror-status"></span>
        <span class="mw-foot-hint"><kbd>1–8</kbd> ${t("블록", "Blocks")} <kbd>V</kbd> ${t("커스텀", "Customize")}</span>
        <button class="mw-btn mw-start-build" data-screen="parts" data-screen-only="library help">${t("블록 조립", "Build blocks")} →</button>
        <button class="mw-btn mw-go" data-id="run"><span data-id="run-label">${t("시험 운전", "Test drive")}</span><kbd>Enter</kbd><span aria-hidden="true">→</span></button>
      </footer>
      <dialog class="mw-replace-dialog" data-id="replace-dialog" aria-labelledby="mw-replace-title" aria-describedby="mw-replace-description">
        <h2 id="mw-replace-title">${t("이 설계도를 교체할까요?", "Replace this blueprint?")}</h2>
        <dl><dt>${t("교체할 설계도", "Saved blueprint")}</dt><dd data-id="replace-target"></dd><dt>${t("현재 편집 중인 기계", "Current machine")}</dt><dd data-id="replace-source"></dd></dl>
        <p id="mw-replace-description">${t("교체 전 버전은 복구함에 보관됩니다.", "The previous version will stay in recovery.")}</p>
        <p class="mw-replace-error" data-id="replace-error" role="alert"></p>
        <div class="mw-dialog-actions"><button class="mw-btn" data-id="replace-cancel" autofocus>${t("취소", "Cancel")}</button><button class="mw-btn mw-confirm" data-id="replace-confirm">${t("현재 기계로 교체 저장", "Replace with current machine")}</button></div>
      </dialog>`;
  }

  showScreen(screen: BuildScreen, focus = false): void {
    this.screen = screen;
    this.element.dataset.screen = screen;
    this.element
      .querySelectorAll<HTMLElement>("[data-pane]")
      .forEach((pane) => (pane.hidden = pane.dataset.pane !== screen));
    this.element.querySelectorAll<HTMLElement>("[data-screen-only]").forEach((item) => {
      item.hidden = !item.dataset.screenOnly!.split(" ").includes(screen);
    });
    this.dismissOverlays();
    this.element.querySelectorAll<HTMLElement>(".mw-section").forEach(button => {
      if (button.dataset.screen === screen) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const title = this.q('[data-id="screen-title"]');
    title.textContent = SCREEN_LABELS[screen];
    this.syncRunButton();
    if (focus) title.focus({ preventScroll: true });
    this.q(".mw-body").scrollTop = 0;
    this.text("copy", t("코드 복사", "Copy code"));
    this.syncRails();
  }

  get showingModel(): boolean {
    return this.screen === "model";
  }

  get canEdit(): boolean {
    return this.screen === "parts" || this.screen === "tune";
  }

  private filterParts(group: PartGroup | "all"): void {
    this.partFilter = group;
    this.element.querySelectorAll<HTMLElement>("[data-part-group]").forEach(button => {
      button.hidden = group !== "all" && button.dataset.partGroup !== group;
    });
    this.element.querySelectorAll<HTMLElement>("[data-filter]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.filter === group));
    });
    this.syncRails();
  }

  private syncBalanceLane(): void {
    this.balanceLane =
      window.innerWidth > 720 && !this.showingModel && !this.element.classList.contains("driving") ? 272 : 0;
  }

  private syncRails(): void {
    this.element.querySelectorAll<HTMLElement>("[data-rail]").forEach(rail => {
      const overflow = rail.clientWidth > 0 && rail.scrollWidth > rail.clientWidth + 2;
      this.element.querySelectorAll<HTMLButtonElement>(`[data-scroll="${rail.dataset.rail}"]`).forEach(button => {
        button.hidden = !overflow;
      });
    });
  }

  private syncRunButton(): void {
    this.runButton.hidden = !this.element.classList.contains("driving") &&
      !["model", "parts", "tune", "missions"].includes(this.screen);
  }

  update(view: BuildView): void {
    this.currentView = view;
    const { stats, blueprint } = view;
    const running = view.running || view.loading;
    const signature=JSON.stringify([this.tuneSection,view.inspectMode,view.inspected,view.mirror,running,view.blueprint.parts]);
    if (signature !== this.lastCustom) {
      this.lastCustom = signature;
      const custom = this.q('[data-id="custom"]');
      const focused = document.activeElement instanceof HTMLElement && custom.contains(document.activeElement) ? document.activeElement : null;
      const focusAttribute = ["data-tune-section", "data-custom-option", "data-custom", "data-inspect-index", "data-custom-reset"].find(attribute => focused?.hasAttribute(attribute));
      const focusSelector = focusAttribute ? `[${focusAttribute}="${CSS.escape(focused!.getAttribute(focusAttribute)!)}"]${focused?.dataset.value ? `[data-value="${CSS.escape(focused.dataset.value)}"]` : ""}` : null;
      custom.innerHTML = partInspectorMarkup(view.blueprint, view.inspected, view.mirror, running, true, this.tuneSection);
      if (focusSelector && !running) custom.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    }
    this.element.classList.toggle("driving", view.running);
    if (this.screen === "tune" && view.assetsReady && view.inspected >= 0) {
      const image = this.handlers.thumbnail(blueprint, view.inspected);
      if (image) this.q<HTMLImageElement>(".mw-inspected-heading img").src = image;
    }
    this.syncRunButton();
    if (document.activeElement !== this.nameField)
      this.nameField.value = blueprint.name;
    const skylarkNote = this.q('[data-id="skylark-note"]');
    skylarkNote.hidden = blueprint.design !== "skylark";
    if (!skylarkNote.hidden) skylarkNote.textContent = usesSkylarkModel(blueprint)
      ? t("Skylark를 열면 HOME이 탑승한 모델과 실제 결합 부품을 볼 수 있어요.", "Open Skylark to see HOME and the modeled components.")
      : t("배치나 블록 색을 바꾼 Skylark 설계는 공용 블록으로 표시합니다.", "A Skylark layout or paint edit uses the standard blocks.");
    this.updateSkylark(view.skylark, running);
    const modelCount = this.canEdit ? undefined : view.skylark?.components.length;
    this.text("fig-parts-label", modelCount !== undefined ? t("모델 부품", "Components") : t("블록", "Blocks"));
    this.text("fig-parts", modelCount === undefined ? String(blueprint.parts.length) : String(modelCount || "–"));
    this.text("skylark-quick-label", blueprint.design === "skylark"
      ? t("현재 Skylark 타기", "Fly current Skylark") : t("Skylark 타기", "Fly Skylark"));
    this.text("fig-mass", `${Math.round(stats.mass*10)/10}`);
    const advice = balanceAdvice(blueprint);
    const thrust = thrustGuides(blueprint);
    const balance = this.q(".mw-balance");
    balance.dataset.tone = advice.tone;
    const face = this.q<HTMLElement>('[data-id="face"]');
    face.setAttribute("aria-label", guideHint(advice, thrust, view.centerVisible));
    this.applyScale(advice);
    this.syncBalanceLane();
    this.text("fig-wheels", `${stats.counts.wheel}`);
    this.text("fig-wing", stats.wingArea.toFixed(1));
    this.text("preview-state", view.skylark && !this.canEdit
      ? view.skylark.components.length ? t("Skylark 모델 미리보기", "Skylark model preview") : t("Skylark 모델 준비 중…", "Loading Skylark…")
      : view.assetsReady ? t("기계 미리보기", "Machine preview") : t("블록 모델 준비 중…", "Loading blocks…"));
    if (view.selected !== this.lastSelected) {
      this.lastSelected = view.selected;
      if (this.partFilter !== "all" && PARTS[view.selected].group !== this.partFilter) this.filterParts("all");
      const rail = this.q('[data-rail="parts"]');
      const tile = this.q<HTMLElement>(`[data-part="${view.selected}"]`);
      if (rail.clientWidth && (tile.offsetLeft < rail.scrollLeft || tile.offsetLeft + tile.offsetWidth > rail.scrollLeft + rail.clientWidth)) {
        rail.scrollTo({ left: Math.max(0, tile.offsetLeft - (rail.clientWidth - tile.offsetWidth) / 2) });
      }
    }
    this.text("selected-name", PARTS[view.selected].name);
    this.text("mirror-status", view.mirror ? t("좌우 함께 편집", "Editing both sides") : t("개별 블록 편집", "Editing a single block"));
    this.meter("lift", Math.min(1, stats.liftRatio / 1.6), stats.liftRatio >= 1);
    this.text("lift-text", stats.liftRatio.toFixed(2));
    const stance = stats.counts.wheel >= 3;
    this.meter(
      "stance",
      stance ? Math.min(1, (stats.stanceMargin + 0.5) / 2.5) : 0,
      stance && stats.stanceMargin > 0.4,
    );
    this.text(
      "stance-text",
      stance ? `${stats.stanceMargin.toFixed(1)}${t("칸", " cells")}` : "–",
    );
    this.text(
      "detail",
      `${PARTS[view.selected].blurb} — ${PARTS[view.selected].detail}`,
    );
    this.element
      .querySelectorAll<HTMLElement>("[data-part]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.part === view.selected),
        ),
      );
    const directional = PARTS[view.selected].directional;
    this.q('[data-id="dirpad"]').hidden = !directional;
    this.element
      .querySelectorAll<HTMLElement>("[data-dir]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(Number(button.dataset.dir) === view.direction),
        ),
      );
    this.q('[data-id="mirror"]').setAttribute(
      "aria-pressed",
      String(view.mirror),
    );
    this.q('[data-id="center"]').setAttribute("aria-pressed", String(view.centerVisible));
    this.q('[data-id="erase"]').setAttribute("aria-pressed", String(view.erase));
    this.q('[data-id="assist"]').setAttribute("aria-pressed", String(view.assist));
    this.text(
      "assist-note",
      view.assist ? t("자동 수평 · 고도 유지", "Auto-level · hold altitude") : t("꺼짐 · 물리 그대로", "Off · raw physics"),
    );
    this.q<HTMLButtonElement>('[data-id="undo"]').disabled =
      running || !view.canUndo;
    this.q<HTMLButtonElement>('[data-id="redo"]').disabled =
      running || !view.canRedo;
    for (const selector of [
      '[data-screen]',
      '[data-preview]',
      '[data-filter]',
      "[data-part]",
      "[data-dir]",
      "[data-preset]",
      "[data-quick]",
      '[data-id="mirror"]',
      '[data-id="center"]',
      '[data-id="erase"]',
      '[data-id="save"]',
      '[data-id="clear"]',
      '[data-id="import"]',
      '[data-id="science"]',
    ])
      this.element
        .querySelectorAll<HTMLButtonElement>(selector)
        .forEach((button) => (button.disabled = running));
    this.runButton.disabled = view.loading;
    this.text("run-label", view.loading
      ? t("물리 엔진 준비 중…", "Loading physics…")
      : view.running
        ? t("정지하고 수정", "Stop and edit")
        : t("시험 운전", "Test drive"));
    this.runButton.classList.toggle("mw-stop", view.running);
    this.runButton.classList.toggle("mw-go", !view.running);
    const message = this.q('[data-id="message"]');
    message.textContent = view.message;
    message.hidden = !view.message;
    message.className = `mw-message ${view.tone === "info" ? "" : view.tone}`;
    this.renderSlots(view.entries, view.recovery, view.assetsReady && this.screen === "library");
    this.renderMissions(view.record);
    if (!this.shareField.matches(":focus"))
      this.shareField.placeholder = t("CYM으로 시작하는 공유 코드 전체", "The full share code starting with CYM");
  }

  private updateSkylark(view: SkylarkInspection | null, busy: boolean): void {
    this.q('.mw-section[data-screen="model"]').hidden = view === null;
    if (!view || !this.showingModel) return;
    const count = view.components.length;
    const connected = view.components.filter(part => part.connection).length;
    this.text("skylark-summary", count
      ? t(`모델 부품 ${count}개 · 연결부 ${connected}개`, `${count} components · ${connected} connections`)
      : t("Skylark 모델 준비 중…", "Loading Skylark…"));
    const explode = this.q<HTMLButtonElement>('[data-id="skylark-explode"]');
    explode.disabled = busy || !count;
    explode.setAttribute("aria-pressed", String(view.exploded));
    explode.textContent = view.exploded ? t("조립 보기", "Show assembled") : t("분해 보기", "Explode model");
    this.element.querySelectorAll<HTMLButtonElement>("[data-skylark-part]").forEach(button => {
      button.disabled = busy || !count;
      button.setAttribute("aria-pressed", String(button.dataset.skylarkPart === view.selected));
    });
    const part = view.components.find(component => component.key === view.selected);
    const connection = part?.connection;
    this.text("skylark-connection", !part
      ? t("목록이나 3D 모델에서 부품을 선택하면 연결 규격을 볼 수 있어요.", "Select a component in the list or model to see its connector.")
      : connection
        ? `${t(SKYLARK_PARTS[connection.host][0], SKYLARK_PARTS[connection.host][1])} → ${t(SKYLARK_PARTS[part.key][0], SKYLARK_PARTS[part.key][1])} · ${connection.profile} · ${connection.socket}`
        : t("차체는 다른 모델 부품이 연결되는 기준 부품입니다.", "The airframe is the root of the model assembly."));
  }

  private renderSlots(entries: LibraryEntry[], recovery: LibraryEntry[], thumbnailsReady: boolean): void {
    const signature = JSON.stringify([entries, recovery, thumbnailsReady]);
    if (signature === this.lastEntries) return;
    this.lastEntries = signature;
    const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    const slotFocus = focused?.dataset.slot;
    const restoreFocus = focused?.dataset.restore;
    const actionFocus = focused?.dataset.action;
    this.text("slot-count", `${entries.length} / ${LIBRARY_SLOTS}`);
    this.text("recovery-count", String(recovery.length));
    const slots = this.q('[data-id="slots"]');
    slots.innerHTML = entries.length
      ? entries
          .map(
            (e) => `<div class="mw-slot">
              <button class="mw-btn" data-slot="${escapeHtml(e.id)}" data-action="load">${thumbnailsReady ? `<img src="${this.handlers.thumbnail(e.blueprint) ?? "/ui/machines/frame.webp"}" alt="" width="64" height="48">` : ""}<span><b>${escapeHtml(e.blueprint.name)}</b><small>${usesSkylarkModel(e.blueprint) ? t(`모델 부품 ${SKYLARK_PART_ORDER.length}개`, `${SKYLARK_PART_ORDER.length} components`) : `${e.blueprint.parts.length} ${t("블록", "blocks")}`}</small></span></button>
              <button class="mw-btn mw-slot-replace" data-slot="${escapeHtml(e.id)}" data-action="replace" aria-label="${escapeHtml(t(`${e.blueprint.name} 교체 저장`, `Replace ${e.blueprint.name}`))}">${t("교체…", "Replace…")}</button>
              <button class="mw-btn mw-icon" data-slot="${escapeHtml(e.id)}" data-action="delete" aria-label="${escapeHtml(t(`${e.blueprint.name} 복구함으로 이동`, `Move ${e.blueprint.name} to recovery`))}">${strokeIcon(ICONS.trash)}</button>
            </div>`,
          )
          .join("")
      : `<div class="mw-library-empty">${strokeIcon(ICONS.library)}<p>${t("아직 저장한 설계도가 없어요.", "No saved blueprints yet.")}<small>${t("마음에 드는 기계를 만들면 위 버튼으로 저장하세요.", "Save a machine you like with the button above.")}</small></p></div>`;
    this.q('[data-id="recovery-list"]').innerHTML = recovery.length
      ? recovery.map(entry => `<div class="mw-recovery-row"><div><b>${escapeHtml(entry.blueprint.name)}</b><small>${entry.blueprint.parts.length} ${t("블록", "blocks")}</small></div><button class="mw-btn" data-restore="${escapeHtml(entry.id)}">${t("복구", "Restore")}</button></div>`).join("")
      : `<p>${t("복구할 설계도가 없습니다.", "No blueprints to recover.")}</p>`;
    if (slotFocus || restoreFocus) {
      const selector = slotFocus
        ? `[data-slot="${CSS.escape(slotFocus)}"][data-action="${CSS.escape(actionFocus!)}"]`
        : `[data-restore="${CSS.escape(restoreFocus!)}"]`;
      (this.element.querySelector<HTMLElement>(selector) ?? this.q<HTMLElement>('[data-id="recovery"] > summary')).focus({ preventScroll: true });
    }
  }

  private renderMissions(record: MissionRecord): void {
    for (const mission of MISSIONS) {
      const row = this.element.querySelector<HTMLElement>(
        `[data-mission="${mission.id}"]`,
      )!;
      const done = record.cleared.includes(mission.id);
      row.classList.toggle("done", done);
      row.querySelector(".mw-check")!.textContent = done ? "✓" : String(MISSIONS.indexOf(mission) + 1).padStart(2, "0");
      if (done)
        row.querySelector<HTMLElement>(
          `[data-fill="${mission.id}"]`,
        )!.style.width = "100%";
    }
    this.text("rec-speed", (record.topSpeed * 3.6).toFixed(0));
    this.text("rec-alt", record.peakAltitude.toFixed(0));
    this.text("rec-dist", record.distance.toFixed(0));
  }

  /** Live counters shown on the collapsed card during a test drive. */
  setRunLine(seconds: number, distance: number, topSpeed: number): void {
    this.text("run-time", `${seconds.toFixed(1)}${t("초", "s")}`);
    this.text("run-dist", `${distance.toFixed(0)} m`);
    this.text("run-top", `${(topSpeed * 3.6).toFixed(0)} km/h`);
  }

  setShare(code: string): void {
    this.shareCode = code;
  }

  focusName(): void {
    this.nameField.focus();
    this.nameField.select();
  }

  private async copyShare(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.shareCode);
      this.text("copy", t("복사 완료 ✓", "Copied ✓"));
      return true;
    } catch {
      this.q<HTMLDetailsElement>('[data-id="share-import"]').open = true;
      this.shareField.value = this.shareCode;
      this.shareField.focus();
      this.shareField.select();
      const copied = document.execCommand?.("copy") ?? false;
      this.text("copy", copied ? t("복사 완료 ✓", "Copied ✓") : t("코드 선택됨 · Ctrl+C", "Code selected · Ctrl+C"));
      return copied;
    }
  }

  /** Gold ball on a dish. The ball sits on the heavy side, and the plate leans that way. */
  private applyScale(advice: ReturnType<typeof balanceAdvice>): void {
    const pose = scalePose(advice);
    const face = this.q<HTMLElement>('[data-id="face"]');
    face.dataset.high = String(pose.lift > 0.2);
    this.q<HTMLElement>('[data-id="tilt"]').style.transform =
      `rotateX(${(54 - pose.pitch).toFixed(2)}deg) rotateZ(${(-pose.roll).toFixed(2)}deg)`;
    const ball = this.q<HTMLElement>('[data-id="ball"]');
    const rise = Math.round(pose.lift * 26);
    const slideX = pose.slideX * 32;
    const slideZ = pose.slideZ * 22;
    ball.style.transform =
      `translate(calc(-50% + ${slideX.toFixed(1)}px), calc(-50% - ${rise}px - ${slideZ.toFixed(1)}px))`;
    ball.style.setProperty("--stem", `${rise}px`);
    this.q<HTMLElement>('[data-id="shadow"]').style.transform =
      `translate(${(slideX * 0.9).toFixed(1)}px, 0)`;
  }

  private text(id: string, value: string): void {
    const node = this.q(`[data-id="${id}"]`);
    if (node.textContent !== value) node.textContent = value;
  }
  private meter(id: string, ratio: number, good: boolean): void {
    const fill = this.q<HTMLElement>(`[data-id="${id}-fill"]`);
    fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    fill.className = `mw-fill${good ? "" : ratio > 0.5 ? " warn" : " bad"}`;
  }
}

export interface DriveReadout {
  speed: number;
  altitude: number;
  contacts: number;
  wheels: number;
  pitch: number;
  roll: number;
  throttle: number;
  lift: number;
  boost: boolean;
  camera: CameraMode;
  assist: boolean;
  /** Capability flags, so the HUD only shows gauges this machine can move. */
  canHover: boolean;
  hasWings: boolean;
  hasBoost: boolean;
}

/** Bottom dial cluster + attitude ball + live mission list during a drive. */
export class DriveHud {
  readonly element = document.createElement("div");
  readonly chips = document.createElement("div");
  private readonly arc: SVGPathElement;
  private readonly pips: HTMLElement;
  private readonly horizonBar: HTMLElement;
  private lastPips = -1;
  private lastSpeed = "";
  private lastHint = "";
  private static readonly ARC = 195;
  private static readonly MAX_KMH = 130;

  constructor() {
    this.element.className = "machine-ui machine-hud";
    this.element.hidden = true;
    this.element.innerHTML = `
      <div class="mw-card mw-bars">
        <div class="mw-bar" data-row="throttle"><span>${t("추진", "Thrust")}</span><div class="mw-track"><div class="mw-fill" data-id="throttle"></div></div></div>
        <div class="mw-bar" data-row="lift"><span>${t("상승", "Lift")}</span><div class="mw-track"><div class="mw-fill" data-id="lift"></div></div></div>
        <div class="mw-bar" data-row="boost"><span>${t("부스터", "Boost")}</span><div class="mw-track"><div class="mw-fill" data-id="boost"></div></div></div>
      </div>
      <div class="mw-card mw-dial">
        <svg viewBox="0 0 144 86" aria-hidden="true">
          <path d="M10 76 A62 62 0 0 1 134 76" fill="none" stroke="#e4e0d4" stroke-width="11" stroke-linecap="round"/>
          <path data-id="arc" d="M10 76 A62 62 0 0 1 134 76" fill="none" stroke="#52b84d" stroke-width="11"
                stroke-linecap="round" stroke-dasharray="195" stroke-dashoffset="195"/>
        </svg>
        <div class="mw-speed" data-id="speed">0</div>
        <div class="mw-unit">KM / H</div>
      </div>
      <div class="mw-card mw-gauges">
        <div class="mw-gauge"><b data-id="alt">0</b><span>${t("고도 m", "Alt m")}</span></div>
        <div class="mw-gauge"><b data-id="pitchtext">0°</b><span>${t("기울기", "Pitch")}</span></div>
        <div class="mw-gauge"><b data-id="camera">${t("추적", "Chase")}</b><span>${t("시점", "View")} · C</span></div>
        <div class="mw-gauge" data-row="grip" style="grid-column:1/-1"><div class="mw-pips" data-id="pips"></div><span>${t("바퀴 접지", "Wheels down")}</span></div>
      </div>
      <div class="mw-horizon"><i data-id="horizon"></i><u>✛</u></div>`;
    this.chips.className = "machine-ui machine-chips";
    this.chips.hidden = true;
    this.chips.innerHTML = `
      <div class="mw-chip" data-id="hint"></div>
      <div class="mw-chip mw-assistchip" data-id="assistchip"></div>
      <div class="mw-card mw-live" data-id="live"></div>`;
    this.arc = this.element.querySelector('[data-id="arc"]')!;
    this.pips = this.element.querySelector('[data-id="pips"]')!;
    this.horizonBar = this.element.querySelector('[data-id="horizon"]')!;
    this.chips.querySelector('[data-id="live"]')!.innerHTML = MISSIONS.map(
      (m) => `<div class="mw-row" data-live="${m.id}"><span>${t(m.name, m.en.name)}</span>
        <b data-live-value="${m.id}">0%</b>
        <div class="mw-track"><div class="mw-fill" data-live-fill="${m.id}"></div></div></div>`,
    ).join("");
  }

  setVisible(visible: boolean): void {
    this.element.hidden = this.chips.hidden = !visible;
  }

  update(readout: DriveReadout): void {
    const kmh = readout.speed * 3.6;
    const text = kmh.toFixed(0);
    if (text !== this.lastSpeed) {
      this.element.querySelector('[data-id="speed"]')!.textContent = text;
      this.lastSpeed = text;
    }
    const ratio = Math.min(1, kmh / DriveHud.MAX_KMH);
    this.arc.style.strokeDashoffset = `${DriveHud.ARC * (1 - ratio)}`;
    this.arc.style.stroke =
      ratio > 0.82 ? "#ef3a5d" : ratio > 0.55 ? "#f5802b" : "#52b84d";
    this.element.querySelector('[data-id="alt"]')!.textContent =
      readout.altitude.toFixed(0);
    this.element.querySelector('[data-id="pitchtext"]')!.textContent =
      `${((readout.pitch * 180) / Math.PI).toFixed(0)}°`;
    this.element.querySelector('[data-id="camera"]')!.textContent =
      CAMERA_LABEL[readout.camera].replace(" 시점", "").replace(" view", "");
    this.horizonBar.style.transform = `translateY(${Math.max(-60, Math.min(60, (readout.pitch * 180) / Math.PI)) * 0.7}px) rotate(${(-readout.roll * 180) / Math.PI}deg)`;
    const hint = [
      readout.wheels ? t("W/S 주행 · A/D 조향", "W/S drive · A/D steer") : null,
      readout.canHover
        ? readout.assist
          ? t("Space 상승 · Z 하강", "Space climb · Z descend")
          : t("Space 상승 추진", "Space lift thrust")
        : null,
      readout.hasWings ? t("속도가 붙으면 날개가 떠받칩니다", "Wings carry you once you have speed") : null,
      t("C 시점 · R 제자리 · Enter 정지", "C view · R respawn · Enter stop"),
    ]
      .filter(Boolean)
      .join("  ·  ");
    if (hint !== this.lastHint) {
      this.lastHint = hint;
      // A gauge a machine cannot move is noise, not information.
      this.row("throttle", readout.wheels > 0);
      this.row("lift", readout.canHover);
      this.row("boost", readout.hasBoost);
      this.row("grip", readout.wheels > 0);
      this.chips.querySelector('[data-id="hint"]')!.textContent = hint;
      const chip = this.chips.querySelector('[data-id="assistchip"]')!;
      chip.textContent = readout.assist
        ? t("🛟 조작 보조 켜짐 · G로 끄기", "🛟 Pilot assist on · G to turn off")
        : t("🎛️ 조작 보조 꺼짐 · G로 켜기", "🎛️ Pilot assist off · G to turn on");
      chip.classList.toggle("off", !readout.assist);
    }
    this.bar("throttle", Math.abs(readout.throttle));
    this.bar("lift", readout.lift);
    this.bar("boost", readout.boost ? 1 : 0);
    if (readout.contacts * 100 + readout.wheels !== this.lastPips) {
      this.lastPips = readout.contacts * 100 + readout.wheels;
      this.pips.innerHTML = Array.from(
        { length: Math.min(8, readout.wheels) },
        (_, i) => `<span class="mw-pip${i < readout.contacts ? " on" : ""}"></span>`,
      ).join("");
    }
  }

  updateMissions(progress: MissionProgress): void {
    for (const mission of MISSIONS) {
      const done = progress.completed.includes(mission.id);
      const ratio = done ? 1 : (progress.ratio[mission.id] ?? 0);
      const row = this.chips.querySelector<HTMLElement>(
        `[data-live="${mission.id}"]`,
      )!;
      row.classList.toggle("done", done);
      this.chips.querySelector<HTMLElement>(
        `[data-live-fill="${mission.id}"]`,
      )!.style.width = `${ratio * 100}%`;
      this.chips.querySelector<HTMLElement>(
        `[data-live-value="${mission.id}"]`,
      )!.textContent = done ? t("완료", "Done") : `${Math.round(ratio * 100)}%`;
    }
  }

  private row(name: string, shown: boolean): void {
    const node = this.element.querySelector<HTMLElement>(`[data-row="${name}"]`);
    if (node) node.hidden = !shown;
  }

  private bar(id: string, ratio: number): void {
    this.element.querySelector<HTMLElement>(
      `[data-id="${id}"]`,
    )!.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }
}

/** Short-lived sticker notifications: mission clears, aborts, copy results. */
export class Toasts {
  readonly element = document.createElement("div");
  private readonly timers = new Set<number>();

  constructor() {
    this.element.className = "machine-ui machine-toasts";
  }

  show(text: string, kind: "good" | "bad" = "good", emoji = "🏅"): void {
    const toast = document.createElement("div");
    toast.className = `mw-toast${kind === "bad" ? " bad" : ""}`;
    toast.innerHTML = `<span>${kind === "bad" ? "⚠️" : emoji}</span><span></span>`;
    toast.lastElementChild!.textContent = text;
    this.element.append(toast);
    while (this.element.childElementCount > 3)
      this.element.firstElementChild!.remove();
    const fade: number = window.setTimeout(() => {
      this.timers.delete(fade);
      toast.classList.add("fade");
      const gone: number = window.setTimeout(() => { this.timers.delete(gone); toast.remove(); }, 500);
      this.timers.add(gone);
    }, 2600);
    this.timers.add(fade);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.element.remove();
  }
}

/** Three-step coach strip shown the first time a player opens the lab. */
export class Coach {
  readonly element = document.createElement("div");
  private step = 0;
  private readonly steps = [
    t("아래에서 <b>블록</b>을 고르고 기계의 면을 눌러 보세요. 위 메뉴로 조립·커스텀·시험 운전을 바꿀 수 있어요.", "Choose a <b>block</b> below and click a machine face. Switch between building, customizing and driving with the top menu."),
    t("기본은 <b>좌우 함께 편집</b>입니다. 한쪽에 블록을 붙이면 반대쪽에도 함께 붙습니다.", "<b>Editing both sides</b> is the default. Attach a block on one side and its opposite appears too."),
    t("개별 블록을 바꿔야 할 때만 <b>추가 도구</b>에서 대칭을 꺼 주세요.", "Only turn off symmetry in <b>More tools</b> when you need to edit an individual block."),
    t("<b>조작 보조</b>가 켜져 있으면 저절로 수평을 잡고 고도를 유지해요. 앞을 길게 눌러도 조금만 기울여 곧게 나갑니다. <b>G</b>로 끄면 원래 물리 그대로입니다.", "With <b>pilot assist</b> on, the machine levels itself and holds altitude. Holding forward only tips it a little, so it flies straight. Press <b>G</b> for raw physics."),
    t("준비되면 <b>Enter</b>로 시험 운전! <b>시험 운전</b> 화면의 목표를 하나씩 깨 보세요.", "Ready? <b>Enter</b> starts a test drive! Try the goals on the <b>Test drive</b> screen."),
  ];

  constructor(
    private readonly onDone: () => void,
    signal: AbortSignal,
  ) {
    this.element.className = "machine-ui machine-coach mw-card";
    this.element.hidden = true;
    this.element.innerHTML = `<div><div class="mw-step"></div><p></p></div>
      <button class="mw-btn" data-id="next">${t("다음", "Next")}</button>
      <button class="mw-btn mw-ghost" data-id="skip">${t("건너뛰기", "Skip")}</button>`;
    this.element
      .querySelector('[data-id="next"]')!
      .addEventListener("click", () => this.advance(), { signal });
    this.element
      .querySelector('[data-id="skip"]')!
      .addEventListener("click", () => this.finish(), { signal });
  }

  start(): void {
    this.step = 0;
    this.element.hidden = false;
    this.render();
  }
  private advance(): void {
    if (++this.step >= this.steps.length) this.finish();
    else this.render();
  }
  private finish(): void {
    this.element.hidden = true;
    this.onDone();
  }
  private render(): void {
    this.element.querySelector(".mw-step")!.textContent =
      `${this.step + 1} / ${this.steps.length}`;
    this.element.querySelector("p")!.innerHTML = this.steps[this.step]!;
    this.element.querySelector('[data-id="next"]')!.textContent =
      this.step === this.steps.length - 1 ? t("시작하기", "Let's go") : t("다음", "Next");
  }
}
