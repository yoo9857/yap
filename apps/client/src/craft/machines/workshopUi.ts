import {
  DIRECTIONS,
  PARTS,
  PART_ORDER,
  PRESETS,
  type Blueprint,
  type MachineStats,
  type PartGroup,
  type PartKind,
  type PresetKind,
} from "./blueprint.js";
import type { LibraryEntry, MissionRecord } from "./library.js";
import { MISSIONS, type MissionProgress } from "./missions.js";
import { t } from "../../ui/i18n.js";

/**
 * All machine-lab DOM. The workshop owns state and 3D; this file owns pixels,
 * so neither one grows a second job. Everything is a CraftYap paper sticker —
 * see workshop.css — and every control carries its keyboard shortcut, because
 * a build game is played with the left hand on the keyboard.
 */

export type MessageTone = "info" | "bad" | "good";

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
  erase: boolean;
  assist: boolean;
  canUndo: boolean;
  canRedo: boolean;
  running: boolean;
  loading: boolean;
  message: string;
  tone: MessageTone;
  entries: LibraryEntry[];
  record: MissionRecord;
}

export interface BuildHandlers {
  selectPart(kind: PartKind): void;
  quickStart(kind: PresetKind): void;
  toggleAssist(): void;
  setDirection(direction: number): void;
  usePreset(kind: PresetKind): void;
  rename(name: string): void;
  undo(): void;
  redo(): void;
  toggleMirror(): void;
  toggleErase(): void;
  frame(): void;
  clearAll(): void;
  run(): void;
  close(): void;
  science(): void;
  saveSlot(): void;
  loadSlot(id: string): void;
  deleteSlot(id: string): void;
  importShare(code: string): void;
}

const ICONS = {
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
/** Part icons are crayon line art: outline only, round joins, no fills. */
const partIcon = (body: string) =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const strokeIcon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">${body}</svg>`;
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

/** Left console: palette, blueprint library, mission checklist, run button. */
export class BuildPanel {
  readonly element = document.createElement("div");
  private tab: "parts" | "library" | "missions" = "parts";
  private readonly nameField: HTMLInputElement;
  private readonly shareField: HTMLTextAreaElement;
  private readonly runButton: HTMLButtonElement;
  // Not "" — an empty shelf must still render its empty-state copy once.
  private lastEntries = "\u0000";

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

    this.element.querySelectorAll("[data-tab]").forEach((button) =>
      on(button, "click", () => {
        this.tab = (button as HTMLElement).dataset.tab as typeof this.tab;
        this.syncTabs();
      }),
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
      erase: () => handlers.toggleErase(),
      frame: () => handlers.frame(),
      clear: () => handlers.clearAll(),
      run: () => handlers.run(),
      close: () => handlers.close(),
      science: () => handlers.science(),
      save: () => handlers.saveSlot(),
      assist: () => handlers.toggleAssist(),
      import: () => handlers.importShare(this.shareField.value),
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
      else handlers.loadSlot(id);
    });
    this.syncTabs();
  }

  private q<T extends Element = HTMLElement>(selector: string): T {
    return this.element.querySelector<T>(selector)!;
  }

  private markup(): string {
    const groups: PartGroup[] = ["구조", "구동", "비행"];
    const palette = groups
      .map((group) => {
        const tiles = PART_ORDER.filter((kind) => PARTS[kind].group === group)
          .map((kind) => {
            const part = PARTS[kind];
            const slot = PART_ORDER.indexOf(kind) + 1;
            return `<button class="mw-btn mw-part" data-part="${kind}" aria-pressed="false" title="${escapeHtml(`${part.name} · ${part.blurb}
${part.detail}`)}">
              <span class="mw-hot">${slot}</span>${partIcon(part.icon)}
              <b>${part.name}</b></button>`;
          })
          .join("");
        return `<div class="mw-group">${t(group, GROUP_EN[group] ?? group)}</div><div class="mw-parts">${tiles}</div>`;
      })
      .join("");
    const dirs = DIRECTIONS.map(
      (d, i) =>
        `<button class="mw-btn" data-dir="${i}" aria-pressed="false">${d.short}</button>`,
    ).join("");
    const presets = PRESETS.map(
      (p) =>
        `<button class="mw-btn" data-preset="${p.kind}">${p.label}</button>`,
    ).join("");
    const missions = MISSIONS.map(
      (m) => `<div class="mw-mission" data-mission="${m.id}">
        <span class="mw-check">·</span>
        <div><b>${t(m.name, m.en.name)}</b> <em>${t(m.target, m.en.target)}</em><small>${t(m.hint, m.en.hint)}</small>
        <div class="mw-track"><div class="mw-fill" data-fill="${m.id}"></div></div></div></div>`,
    ).join("");
    const keys = [
      [t("부품 붙이기 / 떼기", "Attach / remove a part"), t("클릭 / 우클릭", "Click / right click")],
      [t("부품 고르기", "Pick a part"), "1 ~ 8"],
      [t("방향 돌리기", "Turn direction"), "R"],
      [t("좌우 대칭", "Mirror left/right"), "M"],
      [t("지우개", "Eraser"), "X"],
      [t("실행 취소 / 다시", "Undo / redo"), "Ctrl+Z / Ctrl+Y"],
      [t("화면에 맞추기", "Fit to screen"), "F"],
      [t("시점 회전 / 확대", "Orbit / zoom"), t("드래그 / 휠", "Drag / wheel")],
      [t("주행 · 조향", "Drive · steer"), "W S · A D"],
      [t("상승 · 하강", "Climb · descend"), "Space · Ctrl"],
      [t("방향 추진", "Directional thrust"), "Shift"],
      [t("조작 보조 켜고 끄기", "Pilot assist on/off"), "G"],
      [t("기울기 · 롤", "Pitch · roll"), "↑ ↓ · Q E"],
      [t("브레이크 · 제자리로", "Brake · respawn"), "X · R"],
      [t("카메라 바꾸기", "Switch camera"), "C"],
      [t("시험 운전 / 정지", "Test drive / stop"), "Enter"],
    ]
      .map(([label, key]) => `<div><span>${label}</span><kbd>${key}</kbd></div>`)
      .join("");
    return `
      <div class="mw-head">
        <div class="mw-mark">🔧</div>
        <div class="mw-headtext">
          <div class="mw-eyebrow">${t("기계 작업실", "Machine lab")}</div>
          <input class="mw-name" data-id="name" maxlength="48" aria-label="${t("설계도 이름", "Blueprint name")}" />
        </div>
      </div>
      <div class="mw-quick">
        <div class="mw-quickrow">
          <button class="mw-btn" data-quick="rover" title="${t("예제 자동차를 바로 몰아봅니다", "Drive the example car right away")}"><span>🚗</span><b>${t("자동차 타기", "Drive a car")}</b></button>
          <button class="mw-btn" data-quick="plane" title="${t("예제 비행기를 바로 띄워봅니다", "Fly the example plane right away")}"><span>✈️</span><b>${t("비행기 타기", "Fly a plane")}</b></button>
        </div>
      </div>
      <div class="mw-tabs">
        <button class="mw-btn" data-tab="parts" aria-pressed="true">${t("부품", "Parts")}</button>
        <button class="mw-btn" data-tab="library" aria-pressed="false">${t("설계도", "Blueprints")}</button>
        <button class="mw-btn" data-tab="missions" aria-pressed="false">${t("임무", "Missions")}</button>
      </div>
      <div class="mw-body">
        <div class="mw-pane" data-pane="parts">${palette}</div>
        <div class="mw-pane" data-pane="library" hidden>
          <div class="mw-group">${t("예제로 시작하기", "Start from an example")}</div>
          <div class="mw-tools">${presets}</div>
          <div class="mw-group">${t("내 설계도 보관함", "My blueprints")}</div>
          <button class="mw-btn mw-ghost" data-id="save" style="width:100%">＋ ${t("지금 설계도를 보관함에 넣기", "Save this blueprint")}</button>
          <div class="mw-slots" data-id="slots"></div>
          <div class="mw-group">${t("공유 코드", "Share code")}</div>
          <textarea class="mw-share" data-id="share" spellcheck="false" aria-label="${t("공유 코드", "Share code")}"></textarea>
          <div class="mw-tools" style="margin-top:6px">
            <button class="mw-btn" data-id="copy">${t("코드 복사", "Copy code")}</button>
            <button class="mw-btn" data-id="import">${t("코드 불러오기", "Load code")}</button>
          </div>
          <div class="mw-group">${t("정리", "Tidy up")}</div>
          <button class="mw-btn mw-ghost" data-id="clear" style="width:100%">${t("조종석만 남기고 비우기", "Clear all but the cockpit")}</button>
        </div>
        <div class="mw-pane" data-pane="missions" hidden>
          <div class="mw-group">${t("시험 운전 임무", "Test-drive missions")}</div>
          ${missions}
          <div class="mw-records">
            <div class="mw-figure"><b data-id="rec-speed">0</b><span>${t("최고 km/h", "Top km/h")}</span></div>
            <div class="mw-figure"><b data-id="rec-alt">0</b><span>${t("최고 고도 m", "Best altitude m")}</span></div>
            <div class="mw-figure"><b data-id="rec-dist">0</b><span>${t("최장 거리 m", "Longest run m")}</span></div>
          </div>
          <div class="mw-group">${t("조작법", "Controls")}</div>
          <div class="mw-keys">${keys}</div>
        </div>
      </div>
      <div class="mw-pinned" data-id="pinned">
        <p class="mw-detail" data-id="detail"></p>
        <div class="mw-dirpad" data-id="dirpad">
          <div class="mw-group"><span>${t("향하는 방향", "Facing")}</span><kbd class="mw-kbd">R</kbd></div>
          <div class="mw-dirgrid">${dirs}</div>
        </div>
      </div>
      <div class="mw-tools" data-id="toolrow">
        <button class="mw-btn" data-id="undo">${strokeIcon(ICONS.undo)}${t("실행취소", "Undo")}</button>
        <button class="mw-btn" data-id="redo">${strokeIcon(ICONS.redo)}${t("다시실행", "Redo")}</button>
        <button class="mw-btn" data-id="mirror" aria-pressed="false">${strokeIcon(ICONS.mirror)}${t("대칭", "Mirror")}</button>
        <button class="mw-btn" data-id="erase" aria-pressed="false">${strokeIcon(ICONS.erase)}${t("지우개", "Eraser")}</button>
        <button class="mw-btn" data-id="frame">${strokeIcon(ICONS.frame)}${t("맞추기", "Fit")}</button>
      </div>
      <div class="mw-stats">
        <div class="mw-figures">
          <div class="mw-figure"><b data-id="fig-parts">0</b><span>${t("부품", "Parts")}</span></div>
          <div class="mw-figure"><b data-id="fig-mass">0</b><span>kg</span></div>
          <div class="mw-figure"><b data-id="fig-wheels">0</b><span>${t("바퀴", "Wheels")}</span></div>
          <div class="mw-figure"><b data-id="fig-wing">0</b><span>${t("날개 m²", "Wing m²")}</span></div>
        </div>
        <div class="mw-meterrow">
          <div class="mw-meter"><span>${t("상승력", "Lift")}</span><div class="mw-track"><div class="mw-fill" data-id="lift-fill"></div></div><b data-id="lift-text">0.00</b></div>
          <div class="mw-meter"><span>${t("안정성", "Stability")}</span><div class="mw-track"><div class="mw-fill" data-id="stance-fill"></div></div><b data-id="stance-text">–</b></div>
        </div>
      </div>
      <p class="mw-message" data-id="message" aria-live="polite"></p>
      <div class="mw-runline" data-id="runline"><span data-id="run-time">0.0${t("초", "s")}</span><span data-id="run-dist">0 m</span><span data-id="run-top">0 km/h</span></div>
      <div class="mw-foot">
        <button class="mw-btn mw-assist" data-id="assist" aria-pressed="true">
          <span class="mw-dot"></span><b>${t("조작 보조", "Pilot assist")}</b><small data-id="assist-note">${t("자동 수평 · 고도 유지", "Auto-level · hold altitude")}</small>
        </button>
        <button class="mw-btn mw-go" data-id="run">▶ ${t("시험 운전", "Test drive")} · Enter</button>
        <div class="mw-tools">
          <button class="mw-btn" data-id="science">🧪 ${t("과학 실험실", "Science lab")}</button>
          <button class="mw-btn" data-id="close">↩ ${t("아일랜드로", "Back to the world")}</button>
        </div>
      </div>`;
  }

  private syncTabs(): void {
    this.element
      .querySelectorAll<HTMLElement>("[data-tab]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.tab === this.tab),
        ),
      );
    this.element
      .querySelectorAll<HTMLElement>("[data-pane]")
      .forEach((pane) => (pane.hidden = pane.dataset.pane !== this.tab));
    this.q('[data-id="pinned"]').hidden = this.tab !== "parts";
  }

  /** Jump to a tab from a keyboard shortcut elsewhere in the workshop. */
  showTab(tab: "parts" | "library" | "missions"): void {
    this.tab = tab;
    this.syncTabs();
  }

  update(view: BuildView): void {
    const { stats, blueprint } = view;
    const running = view.running || view.loading;
    this.element.classList.toggle("driving", view.running);
    if (document.activeElement !== this.nameField)
      this.nameField.value = blueprint.name;
    this.text("fig-parts", `${blueprint.parts.length}`);
    this.text("fig-mass", `${stats.mass}`);
    this.text("fig-wheels", `${stats.counts.wheel}`);
    this.text("fig-wing", stats.wingArea.toFixed(1));
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
      "[data-part]",
      "[data-dir]",
      "[data-preset]",
      "[data-quick]",
      '[data-id="mirror"]',
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
    this.runButton.textContent = view.loading
      ? t("물리 엔진 준비 중…", "Loading physics…")
      : view.running
        ? t("■ 정지하고 수정 · Enter", "■ Stop and edit · Enter")
        : t("▶ 시험 운전 · Enter", "▶ Test drive · Enter");
    this.runButton.classList.toggle("mw-stop", view.running);
    this.runButton.classList.toggle("mw-go", !view.running);
    const message = this.q('[data-id="message"]');
    message.textContent = view.message;
    message.hidden = !view.message;
    message.className = `mw-message ${view.tone === "info" ? "" : view.tone}`;
    this.renderSlots(view.entries);
    this.renderMissions(view.record);
    if (!this.shareField.matches(":focus"))
      this.shareField.placeholder = t("CYM1… 코드를 붙여넣고 불러오기", "Paste a CYM1… code and load it");
  }

  private renderSlots(entries: LibraryEntry[]): void {
    const signature = entries
      .map((e) => `${e.id}:${e.blueprint.name}:${e.blueprint.parts.length}`)
      .join("|");
    if (signature === this.lastEntries) return;
    this.lastEntries = signature;
    const slots = this.q('[data-id="slots"]');
    slots.innerHTML = entries.length
      ? entries
          .map(
            (e) => `<div class="mw-slot">
              <button class="mw-btn" data-slot="${escapeHtml(e.id)}" data-action="load">${escapeHtml(e.blueprint.name)}<br><small>${e.blueprint.parts.length} ${t("부품", "parts")}</small></button>
              <button class="mw-btn mw-icon" data-slot="${escapeHtml(e.id)}" data-action="delete" aria-label="${t("삭제", "Delete")}">${strokeIcon(ICONS.trash)}</button>
            </div>`,
          )
          .join("")
      : `<p class="mw-detail">${t("아직 보관한 설계도가 없습니다. 마음에 드는 기계를 만들면 위 버튼으로 넣어 두세요.", "No saved blueprints yet. Build a machine you like and save it with the button above.")}</p>`;
  }

  private renderMissions(record: MissionRecord): void {
    for (const mission of MISSIONS) {
      const row = this.element.querySelector<HTMLElement>(
        `[data-mission="${mission.id}"]`,
      )!;
      const done = record.cleared.includes(mission.id);
      row.classList.toggle("done", done);
      row.querySelector(".mw-check")!.textContent = done ? "✓" : "·";
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
    if (!this.shareField.matches(":focus")) this.shareField.value = code;
  }

  focusName(): void {
    this.nameField.focus();
    this.nameField.select();
  }

  private async copyShare(): Promise<boolean> {
    this.shareField.focus();
    this.shareField.select();
    try {
      await navigator.clipboard.writeText(this.shareField.value);
      return true;
    } catch {
      return document.execCommand?.("copy") ?? false;
    }
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
      (m) => `<div class="mw-row" data-live="${m.id}"><span>${m.name}</span>
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
          ? t("Space 상승 · Ctrl 하강", "Space climb · Ctrl descend")
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
    this.timers.add(
      window.setTimeout(() => {
        toast.classList.add("fade");
        this.timers.add(window.setTimeout(() => toast.remove(), 500));
      }, 2600),
    );
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
    t("먼저 <b>바로 타기</b>로 자동차나 비행기를 몰아보세요. 만들지 않아도 바로 탈 수 있어요.", "Start with the <b>quick-play</b> buttons to drive a car or fly a plane — no building needed."),
    t("부품을 고르고 기계의 <b>면을 클릭</b>하면 그 자리에 붙습니다. 우클릭은 떼어내기예요.", "Pick a part and <b>click a face</b> of the machine to attach it there. Right click removes one."),
    t("<b>M</b>을 누르면 좌우 대칭으로 한 번에 두 개씩 붙습니다. 차를 만들 때 훨씬 편해요.", "Press <b>M</b> to mirror: parts go on in pairs, left and right. Much easier for cars."),
    t("<b>조작 보조</b>가 켜져 있으면 저절로 수평을 잡고 고도를 유지해요. <b>G</b>로 끄면 원래 물리 그대로입니다.", "With <b>pilot assist</b> on, the machine levels itself and holds altitude. Press <b>G</b> for raw physics."),
    t("준비되면 <b>Enter</b>로 시험 운전! 임무 탭의 목표를 하나씩 깨 보세요.", "Ready? <b>Enter</b> starts a test drive! Then try the goals on the Missions tab."),
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
