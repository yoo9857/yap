import { t } from "./i18n.js";

/**
 * Keys and mouse buttons drawn the way they look, not spelled out: WASD laid
 * out like the keyboard (W above A S D, each with its direction) and a mouse
 * with the button in question coloured in. A child who has never read
 * "좌클릭" still recognises the left half of a mouse.
 *
 * Help lists put these tokens in a `keys` array; anything else renders as a
 * plain key cap.
 */
export const KEY_WASD = "§wasd";
export const MOUSE_LEFT = "§lmb";
export const MOUSE_RIGHT = "§rmb";
export const MOUSE_WHEEL = "§wheel";
export const MOUSE_MIDDLE = "§mmb";
export const MOUSE_MOVE = "§move";
export const MOUSE_DRAG = "§drag";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Part = "left" | "right" | "wheel" | "none";

/** A mouse seen from above (24×34), the named part filled in. Arrows either side mean "move it". */
function mouseSvg(part: Part, opts: { arrows?: boolean; click?: boolean } = {}): string {
  const on = (p: Part) => (p === part ? "gm-m-on" : "gm-m-off");
  const arrows = opts.arrows
    ? `<path class="gm-m-arrow" d="M-3 17h-5m0 0l3-3m-3 3l3 3M27 17h5m0 0l-3-3m3 3l-3 3"/>`
    : "";
  const click = opts.click ? `<path class="gm-m-arrow" d="M12 -1v-4M6.5 0.5l-2-3M17.5 0.5l2-3"/>` : "";
  const box = opts.arrows ? "-10 -6 44 42" : "-2 -6 28 42";
  return `<svg class="gm-mouse" viewBox="${box}" aria-hidden="true" focusable="false">
    ${arrows}${click}
    <rect class="gm-m-body" x="1.5" y="1.5" width="21" height="31" rx="10.5"/>
    <path class="${on("left")}" d="M12 1.5A10.5 10.5 0 0 0 1.5 12v3H12z"/>
    <path class="${on("right")}" d="M12 1.5A10.5 10.5 0 0 1 22.5 12v3H12z"/>
    <path class="gm-m-line" d="M1.5 15h21M12 1.5V15"/>
    <rect class="${on("wheel")} gm-m-wheel" x="9.75" y="5" width="4.5" height="7" rx="2.25"/>
    <rect class="gm-m-outline" x="1.5" y="1.5" width="21" height="31" rx="10.5"/>
  </svg>`;
}

/** The picture plus a one-word caption under it (hidden in the compact key strip). */
function glyph(label: string, svg: string, caption: string): string {
  return `<span class="gm-glyph" role="img" aria-label="${esc(label)}" title="${esc(label)}">${svg}<small aria-hidden="true">${esc(caption)}</small></span>`;
}

/** W on top, A S D underneath — the shape of the keys under the fingers. */
function wasd(): string {
  const k = (key: string, arrow: string, cls: string) => `<kbd class="${cls}">${key}<i aria-hidden="true">${arrow}</i></kbd>`;
  return `<span class="gm-wasd" role="img" aria-label="${esc(t("W 앞 · A 왼쪽 · S 뒤 · D 오른쪽", "W forward · A left · S back · D right"))}">${k("W", "↑", "k-w")}${k("A", "←", "k-a")}${k("S", "↓", "k-s")}${k("D", "→", "k-d")}</span>`;
}

/** One entry of a help `keys` array → its picture (or a plain key cap). */
export function keyGlyph(key: string): string {
  switch (key) {
    case KEY_WASD: return wasd();
    case MOUSE_LEFT: return glyph(t("마우스 왼쪽 버튼", "Left mouse button"), mouseSvg("left"), t("왼쪽", "Left"));
    case MOUSE_RIGHT: return glyph(t("마우스 오른쪽 버튼", "Right mouse button"), mouseSvg("right"), t("오른쪽", "Right"));
    case MOUSE_WHEEL: return glyph(t("마우스 휠 굴리기", "Scroll the mouse wheel"), mouseSvg("wheel"), t("휠", "Wheel"));
    case MOUSE_MIDDLE: return glyph(t("마우스 휠 누르기", "Press the mouse wheel"), mouseSvg("wheel", { click: true }), t("휠 클릭", "Wheel click"));
    case MOUSE_MOVE: return glyph(t("마우스 움직이기", "Move the mouse"), mouseSvg("none", { arrows: true }), t("움직이기", "Move"));
    case MOUSE_DRAG: return glyph(t("왼쪽 버튼 누른 채 끌기", "Drag with the left button"), mouseSvg("left", { arrows: true }), t("드래그", "Drag"));
    default: return `<kbd>${esc(key)}</kbd>`;
  }
}

export const keyGlyphs = (keys: string[]): string => keys.map(keyGlyph).join("");
