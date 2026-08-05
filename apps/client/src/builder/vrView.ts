import * as THREE from "three";
import type { VrFrame } from "./vrDirector.js";

/** What the in-world plaque reads out. */
export interface VrPanelInfo {
  landmarkName: string;
  country: string;
  placedBlocks: number;
  totalBlocks: number;
  gold: number;
  workers: number;
}

const PANEL_W = 512;
const PANEL_H = 256;
/** Railing: a fixed 4 cm tube at hand height, whatever the balcony's radius. */
const RAIL_R0 = 4;
const RAIL_TUBE = 0.04;
const RAIL_H = 0.98;
/** How far back the deck sits, as a fraction of its radius (0 = centred). */
const DECK_SETBACK = 0.75;

/**
 * The three things a comfortable VR viewpoint needs that a monitor never does:
 *
 *  1. a **blinder** — a black sphere on the head, faded up to hide every cut;
 *  2. a **platform** — something solid underfoot at the aerial viewpoints, or
 *     height vertigo makes an otherwise great view unwatchable;
 *  3. an in-world **plaque** — the DOM HUD does not exist inside a headset, so
 *     gold/progress have to be geometry.
 */
export class VrView {
  private readonly blinder: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly platform: THREE.Group;
  private readonly platformDisc: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  private readonly rail: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  private readonly plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D | null;
  private readonly texture: THREE.CanvasTexture;
  private lastPanelKey = "";
  private railRadius = RAIL_R0;

  constructor(
    private readonly rig: THREE.Group,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    // --- blinder: BackSide sphere parented to the camera so it tracks the head
    // exactly (room-scale walking must not let anyone peek around it), and with
    // depth testing off so it paints over the world regardless of what is near.
    this.blinder = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    );
    this.blinder.renderOrder = 9999;
    this.blinder.frustumCulled = false;
    this.blinder.visible = false;
    camera.add(this.blinder);

    // --- platform: a railed balcony for the mid-air viewpoints.
    // The viewer stands near its FRONT edge with the deck cantilevered behind
    // them (+Z is backwards; the monument is at −Z). Centring the deck under the
    // viewer instead would occlude everything steeper than atan(eye / radius) —
    // about 22° down on a 4 m deck — and the monument's base sits below that, so
    // a centred deck literally hides the thing you came to look at.
    this.platform = new THREE.Group();
    this.platformDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 0.3, 24),
      new THREE.MeshStandardMaterial({ color: 0xcfc6b2, roughness: 0.85 }),
    );
    this.platformDisc.position.y = -0.15;
    this.platformDisc.receiveShadow = true;
    this.platform.add(this.platformDisc);
    this.rail = new THREE.Mesh(
      new THREE.TorusGeometry(RAIL_R0, RAIL_TUBE, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0x1f2933, roughness: 0.6 }),
    );
    this.rail.rotation.x = Math.PI / 2;
    this.rail.position.y = RAIL_H;
    this.platform.add(this.rail);
    this.platform.visible = false;
    rig.add(this.platform);

    // --- plaque: a lectern below the eye line, parented to the rig so it stays
    // put in the room while the head is free to look anywhere
    this.canvas = document.createElement("canvas");
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;
    this.ctx2d = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.plaque = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.25),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false, // readable text must not go through tone mapping
        fog: false,
        depthWrite: false,
      }),
    );
    // Down and to the LEFT, angled back at the face: dead centre would sit right
    // on top of the monument's base, which is the one part of the forward view
    // that must stay clear. You glance at it, you don't look through it.
    this.plaque.position.set(-0.42, 0.98, -0.55);
    this.plaque.rotation.set(-0.45, 0.6, 0);
    rig.add(this.plaque);
  }

  /**
   * Hide the info plaque when the shop panel has taken the rig slot: the panel
   * already carries the landmark, progress, gold and crew, so showing both is
   * the same numbers twice in the same corner of the eye.
   */
  setPlaqueVisible(visible: boolean): void {
    this.plaque.visible = visible;
  }

  /** Place the rig for this frame and drive the blinder / platform / plaque. */
  update(frame: VrFrame, info: VrPanelInfo): void {
    const { pose } = frame;
    this.rig.position.set(pose.x, pose.y, pose.z);
    this.rig.rotation.set(0, pose.yaw, 0); // yaw ONLY — never tilt the horizon

    const blind = frame.blind;
    this.blinder.visible = blind > 0.002;
    this.blinder.material.opacity = blind;

    if (pose.platformR > 0) {
      this.platform.visible = true;
      this.platformDisc.scale.set(pose.platformR, 1, pose.platformR);
      // slide the whole deck backwards so the viewer stands a short step from
      // its front edge, looking out over the rail rather than over their toes
      this.platform.position.z = pose.platformR * DECK_SETBACK;
      // rebuild rather than scale: a uniform scale would fatten the handrail's
      // tube along with its radius, and a 20 cm rail at hand height reads as a
      // wall across the view
      if (pose.platformR !== this.railRadius) {
        this.railRadius = pose.platformR;
        this.rail.geometry.dispose();
        this.rail.geometry = new THREE.TorusGeometry(pose.platformR, RAIL_TUBE, 8, 32);
      }
    } else {
      this.platform.visible = false;
    }

    this.drawPlaque(info);
  }

  private drawPlaque(info: VrPanelInfo): void {
    const c = this.ctx2d;
    if (!c) return;
    const pct = info.totalBlocks > 0 ? (info.placedBlocks / info.totalBlocks) * 100 : 0;
    const key = `${info.landmarkName}|${info.placedBlocks}|${Math.floor(info.gold)}|${info.workers}`;
    if (key === this.lastPanelKey) return;
    this.lastPanelKey = key;

    c.clearRect(0, 0, PANEL_W, PANEL_H);
    // paper card with the crayon outline
    c.fillStyle = "#fdf6e3";
    c.strokeStyle = "#1f2933";
    c.lineWidth = 8;
    c.beginPath();
    c.roundRect(6, 6, PANEL_W - 12, PANEL_H - 12, 22);
    c.fill();
    c.stroke();

    c.fillStyle = "#1f2933";
    c.textBaseline = "top";
    c.font = '700 42px "Jua", system-ui, sans-serif';
    c.fillText(info.landmarkName, 30, 26);
    c.font = '400 24px "Jua", system-ui, sans-serif';
    c.fillStyle = "#5b6670";
    c.fillText(info.country, 30, 76);

    // progress bar
    const barY = 122;
    const barW = PANEL_W - 60;
    c.fillStyle = "#e3dcc8";
    c.beginPath();
    c.roundRect(30, barY, barW, 26, 13);
    c.fill();
    c.fillStyle = "#f5802b";
    c.beginPath();
    c.roundRect(30, barY, Math.max(6, (barW * pct) / 100), 26, 13);
    c.fill();
    c.strokeStyle = "#1f2933";
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(30, barY, barW, 26, 13);
    c.stroke();

    c.fillStyle = "#1f2933";
    c.font = '700 26px "Jua", system-ui, sans-serif';
    c.fillText(
      `${info.placedBlocks.toLocaleString()} / ${info.totalBlocks.toLocaleString()}  (${pct.toFixed(1)}%)`,
      30,
      164,
    );
    c.font = '700 26px "Jua", system-ui, sans-serif';
    c.fillStyle = "#b8860b";
    c.fillText(`${Math.floor(info.gold).toLocaleString()} G`, 30, 202);
    c.fillStyle = "#3d6b3d";
    c.fillText(`${info.workers} crew`, 250, 202);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.camera.remove(this.blinder);
    this.blinder.geometry.dispose();
    this.blinder.material.dispose();

    this.rig.remove(this.platform);
    this.platformDisc.geometry.dispose();
    this.platformDisc.material.dispose();
    this.rail.geometry.dispose();
    this.rail.material.dispose();

    this.rig.remove(this.plaque);
    this.plaque.geometry.dispose();
    this.plaque.material.dispose();
    this.texture.dispose();
  }
}
