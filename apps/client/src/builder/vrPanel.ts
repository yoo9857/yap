import * as THREE from "three";

/**
 * The wrist shop panel: the one piece of VR that is INPUT, not just view.
 *
 * Without it the headset gets a static-rate diorama — Robo Builder's whole loop
 * is earn gold → hire crew → build faster, and a viewer who cannot spend watches
 * the same rate forever while gold piles up.
 *
 * Layout and hit-testing are pure so they can be unit-tested; a headless browser
 * has no controller poses, so this is the only way to know the buttons line up
 * with what a ray would actually hit.
 */

export type VrPanelAction = "worker" | "speed" | "value" | "crane" | "next";

export interface PanelButton {
  id: VrPanelAction;
  label: string;
  /** Canvas-space rect, y measured DOWN from the top like a 2D context. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PANEL_W = 640;
export const PANEL_H = 384;

/** Player-facing names, shared by the buttons and the confirmation toasts. */
export const VR_ACTION_LABELS: Record<VrPanelAction, string> = {
  worker: "Crew",
  speed: "Speed",
  value: "Value",
  crane: "Crane",
  next: "Next view",
};

const BTN_TOP = 250;
const BTN_H = 112;
const BTN_GAP = 8;
const BTN_MARGIN = 18;

/** Five buttons across the bottom, laid out once so the hit test can't drift. */
export const PANEL_BUTTONS: readonly PanelButton[] = (
  ["worker", "speed", "value", "crane", "next"] as const
).map((id, i, all) => {
  const w = (PANEL_W - BTN_MARGIN * 2 - BTN_GAP * (all.length - 1)) / all.length;
  return {
    id,
    label: VR_ACTION_LABELS[id],
    x: BTN_MARGIN + i * (w + BTN_GAP),
    y: BTN_TOP,
    w,
    h: BTN_H,
  };
});

/**
 * Which button is at this UV, or null. `u`/`v` come straight from a three
 * raycast hit: u is left→right, v is BOTTOM→top, so v flips to canvas space.
 */
export function hitTestPanel(u: number, v: number): VrPanelAction | null {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const x = u * PANEL_W;
  const y = (1 - v) * PANEL_H;
  for (const b of PANEL_BUTTONS) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
  }
  return null;
}

export interface VrPanelInfo {
  landmarkName: string;
  country: string;
  placedBlocks: number;
  totalBlocks: number;
  gold: number;
  workers: number;
  goalTitle: string;
  /** Cost per purchasable action; `next` is free and has no entry. */
  costs: Record<Exclude<VrPanelAction, "next">, number>;
  craneOwned: boolean;
  /** Transient line — goal completed, donation, landmark finished. */
  toast: string | null;
}

/** Panel width in meters; the height follows the canvas aspect. */
const PANEL_METERS_W = 0.34;

export class VrShopPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: THREE.CanvasTexture;
  private lastKey = "";

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;
    this.ctx = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_METERS_W, (PANEL_METERS_W * PANEL_H) / PANEL_W),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
        fog: false,
        depthWrite: false,
      }),
    );
    this.mesh.visible = false;
  }

  /**
   * Park the panel on the left hand, tilted up like a wristwatch. Attaching it
   * to the rig instead would leave it hanging in the forward view, right where
   * the monument's base sits.
   */
  attachToWrist(controller: THREE.Object3D): void {
    controller.add(this.mesh);
    this.mesh.position.set(0.02, 0.06, -0.06);
    this.mesh.rotation.set(-1.0, 0, 0);
    this.mesh.visible = true;
  }

  /**
   * Fallback when the runtime reports no left hand: float it in the lower-LEFT
   * quadrant. The height is load-bearing — parked at eye-height minus 0.68 m and
   * 0.42 m out it sits 58° below the horizon, which is outside even a 100° field
   * of view, so the panel is simply never seen. ~34° down keeps it comfortably
   * in frame, and the sideways offset keeps it off the monument's centreline.
   */
  attachToRig(rig: THREE.Object3D): void {
    rig.add(this.mesh);
    this.mesh.position.set(-0.3, 1.3, -0.56);
    this.mesh.rotation.set(-0.45, 0.4, 0);
    this.mesh.visible = true;
  }

  draw(info: VrPanelInfo, hovered: VrPanelAction | null): void {
    const c = this.ctx;
    if (!c) return;
    const key = `${info.landmarkName}|${info.placedBlocks}|${Math.floor(info.gold)}|${info.workers}|${info.goalTitle}|${info.craneOwned}|${info.toast ?? ""}|${hovered ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    c.clearRect(0, 0, PANEL_W, PANEL_H);
    c.fillStyle = "#fdf6e3";
    c.strokeStyle = "#1f2933";
    c.lineWidth = 8;
    c.beginPath();
    c.roundRect(5, 5, PANEL_W - 10, PANEL_H - 10, 26);
    c.fill();
    c.stroke();

    c.textBaseline = "top";
    c.fillStyle = "#1f2933";
    c.font = '700 40px "Jua", system-ui, sans-serif';
    c.fillText(info.landmarkName, 24, 20, PANEL_W - 48);

    const pct = info.totalBlocks > 0 ? (info.placedBlocks / info.totalBlocks) * 100 : 0;
    const barW = PANEL_W - 48;
    c.fillStyle = "#e3dcc8";
    c.beginPath();
    c.roundRect(24, 74, barW, 22, 11);
    c.fill();
    c.fillStyle = "#f5802b";
    c.beginPath();
    c.roundRect(24, 74, Math.max(6, (barW * pct) / 100), 22, 11);
    c.fill();

    c.font = '700 26px "Jua", system-ui, sans-serif';
    c.fillStyle = "#b8860b";
    c.fillText(`${Math.floor(info.gold).toLocaleString()} G`, 24, 108);
    c.fillStyle = "#3d6b3d";
    c.fillText(`${info.workers} crew`, 210, 108);
    c.fillStyle = "#5b6670";
    c.fillText(`${pct.toFixed(1)}%`, 360, 108);

    // the toast takes the goal line's slot when present — it is the louder news
    c.font = '400 24px "Jua", system-ui, sans-serif';
    if (info.toast) {
      c.fillStyle = "#c2410c";
      c.fillText(info.toast, 24, 150, PANEL_W - 48);
    } else {
      c.fillStyle = "#5b6670";
      c.fillText(`Goal: ${info.goalTitle}`, 24, 150, PANEL_W - 48);
    }

    for (const b of PANEL_BUTTONS) {
      const owned = b.id === "crane" && info.craneOwned;
      const cost = b.id === "next" ? 0 : info.costs[b.id];
      const affordable = b.id === "next" || (!owned && info.gold >= cost);
      const isHovered = hovered === b.id;

      c.fillStyle = owned
        ? "#cfcfcf"
        : !affordable
          ? "#e6e0d0"
          : b.id === "next"
            ? "#0f6cbd"
            : isHovered
              ? "#7dc46a"
              : "#4fa83d";
      c.strokeStyle = isHovered ? "#f9d71c" : "#1f2933";
      c.lineWidth = isHovered ? 7 : 4;
      c.beginPath();
      c.roundRect(b.x, b.y, b.w, b.h, 16);
      c.fill();
      c.stroke();

      c.fillStyle = affordable ? "#ffffff" : "#8b8676";
      c.textAlign = "center";
      c.font = '700 26px "Jua", system-ui, sans-serif';
      c.fillText(b.label, b.x + b.w / 2, b.y + 22, b.w - 12);
      c.font = '700 22px "Jua", system-ui, sans-serif';
      const sub = b.id === "next" ? "free" : owned ? "owned" : `${Math.round(cost)}G`;
      c.fillText(sub, b.x + b.w / 2, b.y + 62, b.w - 12);
      c.textAlign = "left";
    }

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
