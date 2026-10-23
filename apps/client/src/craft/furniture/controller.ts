import type { ClassFurniture } from "@robo/shared";
import type * as THREE from "three";
import { withObjectParticle } from "../korean.js";
import { overlapsVoxel, unstick, type Body } from "../voxelBody.js";
import type { RayHit, VoxelWorld } from "../voxelWorld.js";
import { CATEGORIES, furnitureDef, inCategory, isFurnitureKind, variantCount } from "./catalog/index.js";
import { frontOf, rayPiece, rotFacing, rotFromNormal } from "./footprint.js";
import type { FurnitureLayout, PlaceVerdict, PlacementWorld } from "./layout.js";
import { FurnitureShop } from "./shop.js";
import type { PlacedFurniture } from "./types.js";
import { FurnitureView } from "./view.js";

/**
 * Furniture's whole runtime: mode, keys, aiming, placing, putting away, the
 * view and the panel. `CraftGame` stays the composition root and only calls
 * in at its existing seams (key/wheel, aim, place, mine, block removal,
 * render, save), so furniture can grow without growing the game class.
 *
 * Coordinates: the layout is ABSOLUTE; everything the game hands in is GRID.
 * `originX/Z` (the field window's offset, 0 on the island) is the only
 * conversion, and it lives here.
 */

/** What the controller needs from the game. Structural, so tests could fake it. */
export interface FurnitureHost {
  scene: THREE.Scene;
  world: VoxelWorld;
  layout: FurnitureLayout;
  /** Absolute coords of grid cell (0, 0); 0 on the island. */
  originX(): number;
  originZ(): number;
  player(): Body;
  pet(): Body;
  hud: {
    toast(text: string): void;
    setHotbarVisible(visible: boolean): void;
    setPiece(name: string, yaw: number, tilt: number, icon?: string): void;
  };
  sfx: { play(name: "place" | "pickup" | "doorOpen" | "doorClose" | "sit" | "undo" | "click"): void };
  canBuild(): boolean;
  changed?(placed: ClassFurniture[], removed: ClassFurniture[]): void;
  /** Re-capture the mouse; called from a click handler (a user gesture). */
  resumePlay(): void;
  /** Close the neighbouring panel when ours opens. */
  closeOtherPanels(): void;
}

/** Seconds of held left click that put a piece away — long enough that a
 *  click meant for the block behind a chair never takes it. */
export const PICKUP_TIME = 0.35;
/** The robot rig's hip height above its feet (player/rig.ts) — a seat at
 *  height h puts the feet at h − this. */
const SEAT_HIP = 0.42;

/** A candidate placement (absolute anchor) and whether it is allowed. */
interface Candidate {
  item: PlacedFurniture;
  /** Model lift above the anchor cell's floor (a surface piece's host top). */
  elevation: number;
  verdict: PlaceVerdict;
}

/** What a refused right click says. `invalid` never reaches a player. */
const REFUSAL: Record<Exclude<PlaceVerdict, "ok" | "invalid">, string> = {
  limit: "🛋️ 가구를 더 놓을 수 없어요 (최대 개수)",
  occupied: "🛋️ 이미 다른 가구가 있는 자리예요",
  blocked: "🧱 블록이 있는 자리에는 놓을 수 없어요",
  body: "🙂 내가 서 있는 자리예요 — 한 걸음 비켜 주세요",
  floating: "⬇️ 바닥(블록) 위에 놓아야 해요",
  "no-wall": "🖼️ 블록 벽에 대고 걸어야 해요",
  "no-top": "🍽️ 그 가구 위에는 올릴 수 없어요 — 탁자나 선반을 노려 보세요",
};

export class FurnitureController {
  private readonly view: FurnitureView;
  private readonly shop: FurnitureShop;
  private kind: string | null = null;
  /** Extra quarter turns (R) on top of facing the player. */
  private extraRot = 0;
  /** The colour last used per kind, so coming back to a piece keeps it. */
  private readonly variants = new Map<string, number>();
  /** What G brings back. */
  private lastKind: string = inCategory(CATEGORIES[0]!.key)[0]!.key;
  /** The piece last used in each category, for Q/E to land on. */
  private readonly lastInCategory = new Map<string, string>();
  private visible = true;

  constructor(
    private readonly host: FurnitureHost,
    /** Whether this game enables the furniture tools. */
    readonly enabled: boolean,
  ) {
    this.view = new FurnitureView(host.scene);
    this.shop = new FurnitureShop(document.body, {
      onPick: (kind, variant) => {
        this.select(kind, variant);
        host.resumePlay();
      },
      onOpen: () => host.closeOtherPanels(),
      onStepCategory: (dir) => this.stepCategory(dir),
    });
    if (!enabled) this.shop.setVisible(false);
    this.installCollision();
  }

  get active(): boolean {
    return this.kind !== null;
  }

  get panelOpen(): boolean {
    return this.shop.open;
  }

  closePanel(): void {
    this.shop.setOpen(false);
  }

  togglePanel(): void {
    this.shop.toggle();
  }

  private get variant(): number {
    return this.kind ? (this.variants.get(this.kind) ?? 0) : 0;
  }

  // ------------------------------------------------------------ selection

  /** Right click places this piece from now on (null = blocks again). */
  select(kind: string | null, variant?: number): void {
    if (!this.enabled) return;
    if (kind !== null && !isFurnitureKind(kind)) return;
    if (kind && variant !== undefined && variant >= 0 && variant < variantCount(furnitureDef(kind))) {
      this.variants.set(kind, variant);
    }
    const entering = kind !== null && this.kind === null;
    if (kind !== this.kind) this.extraRot = 0;
    this.kind = kind;
    if (kind) {
      this.lastKind = kind;
      this.lastInCategory.set(furnitureDef(kind).category, kind);
    }
    this.shop.setCurrent(kind, this.variant);
    this.host.hud.setHotbarVisible(kind === null);
    // Once on the way in; switching pieces is already shown by the bar.
    if (entering) this.host.hud.toast("🛋️ 가구 모드 — Q/E 종류 · 1~9 고르기 · X 색 · R 돌리기 · G 블록으로");
  }

  /**
   * Furniture's keys. Returns true when the key was furniture's, so the game
   * skips its own meaning for it (1‒9 pick a block slot otherwise).
   */
  handleKey(key: string, repeat: boolean): boolean {
    if (!this.enabled) return false;
    if (key === "g") {
      if (!repeat) this.select(this.kind ? null : this.lastKind);
      return true;
    }
    if (!this.kind) return false;
    const def = furnitureDef(this.kind);
    if (key >= "1" && key <= "9") {
      const pick = inCategory(def.category)[Number(key) - 1];
      if (pick) this.select(pick.key);
      return true;
    }
    if (key === "q" || key === "e") {
      if (!repeat) this.stepCategory(key === "e" ? 1 : -1);
      return true;
    }
    if (key === "x") {
      if (repeat) return true;
      const count = variantCount(def);
      if (count > 1) {
        this.variants.set(this.kind, (this.variant + 1) % count);
        this.shop.setCurrent(this.kind, this.variant);
        this.host.hud.toast(`🎨 ${def.name} · ${def.palettes![this.variant]!.name}`);
      }
      return true;
    }
    if (key === "r") {
      this.extraRot = (this.extraRot + 1) % 4;
      return true;
    }
    if (key === "f") {
      // back to blocks — and only that: also cycling the block shape on the
      // same press would quietly change what the player builds with next
      this.select(null);
      return true;
    }
    if (key === "t") return true; // tilt is a block thing; not a hidden change
    return false;
  }

  /** Q / E (or the bar's arrows): the neighbouring category, landing on the
   *  piece last used there, else its first. */
  stepCategory(dir: 1 | -1): void {
    if (!this.kind) return;
    const n = CATEGORIES.length;
    const i = CATEGORIES.findIndex((c) => c.key === furnitureDef(this.kind!).category);
    const next = CATEGORIES[(i + dir + n) % n]!;
    this.select(this.lastInCategory.get(next.key) ?? inCategory(next.key)[0]!.key);
  }

  /** The wheel cycles pieces within the category. True when consumed. */
  handleWheel(down: boolean): boolean {
    if (!this.kind) return false;
    const list = inCategory(furnitureDef(this.kind).category);
    const i = list.findIndex((d) => d.key === this.kind);
    this.select(list[(i + (down ? 1 : list.length - 1)) % list.length]!.key);
    return true;
  }

  // ------------------------------------------------------------ world

  private toAbs(x: number, z: number): [number, number] {
    return [x + this.host.originX(), z + this.host.originZ()];
  }

  /** Let bodies and the aim ray collide with solid furniture. */
  private installCollision(): void {
    const { layout, world } = this.host;
    world.propSolid = (x, y, z) => layout.occupied(x + this.host.originX(), y, z + this.host.originZ());
  }

  /** The layout's view of the world, in absolute cells. */
  private readonly placementWorld: PlacementWorld = {
    isBlock: (x, y, z) => this.host.world.isSolid(x - this.host.originX(), y, z - this.host.originZ()),
    hasBody: (x, y, z) => overlapsVoxel(this.host.player(), x - this.host.originX(), y, z - this.host.originZ()),
  };

  /** Would a block in this grid cell cut through furniture? */
  blocksCell(x: number, y: number, z: number): boolean {
    const [ax, az] = this.toAbs(x, z);
    return this.host.layout.blocksBlock(ax, y, az);
  }

  /**
   * The piece under the crosshair, if it is nearer than the block the ray hit.
   * Solid pieces are already in the voxel ray (`raycast(..., true)`); rugs,
   * surface and wall pieces are tested against their model's box.
   */
  aimAt(eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, hit: RayHit | null, reach: number): PlacedFurniture | null {
    const { layout } = this.host;
    if (layout.size === 0) return null;
    const ox = this.host.originX();
    const oz = this.host.originZ();
    let best: PlacedFurniture | null = null;
    let bestDist = hit ? hit.dist : reach;
    if (hit) {
      const [x, y, z] = hit.voxel;
      best = layout.at("solid", x + ox, y, z + oz) ?? null;
      if (best) bestDist = hit.dist + 1e-3; // a vase on the table wins over the table
    }
    const ex = eye.x + ox;
    const ez = eye.z + oz;
    for (const item of layout.all()) {
      const def = furnitureDef(item.kind);
      // Closed floor pieces are solid, so the voxel ray already found them.
      // An OPEN door is not — it has to be hit here, or once opened it could
      // never be clicked shut again.
      if (def.placement === "floor" && item.state !== 1) continue;
      // cheap reject first: farther than reach + the piece
      if (Math.abs(item.x - ex) > reach + 3 || Math.abs(item.z - ez) > reach + 3 || Math.abs(item.y - eye.y) > reach + 3) continue;
      const t = rayPiece(
        def, item.state === 1,
        item.x - ox, item.y, item.z - oz, item.rot, layout.elevation(item),
        eye.x, eye.y, eye.z, dir.x, dir.y, dir.z,
      );
      if (t !== null && t < bestDist) {
        bestDist = t;
        best = item;
      }
    }
    return best;
  }

  /** Where the current piece would go for this aim (grid anchor), or null. */
  private candidate(hit: RayHit, yaw: number): Candidate | null {
    if (!this.kind) return null;
    const def = furnitureDef(this.kind);
    const [vx, vy, vz] = hit.voxel;
    const [bx, by, bz] = hit.before;
    let anchor: [number, number, number] = [bx, by, bz];
    let rot = (rotFacing(yaw) + this.extraRot) % 4;
    let verdict: PlaceVerdict | null = null;
    if (def.placement === "wall") {
      // hung on the face the ray hit, facing out of it; aimed at a floor or a
      // ceiling there is nothing to hang on — still show the (red) ghost there,
      // facing the player, so the refusal is visible rather than a no-op
      const facing = rotFromNormal(bx - vx, by - vy, bz - vz);
      if (facing === null) verdict = "no-wall";
      else rot = facing;
    } else if (def.placement === "surface" && this.host.layout.at("solid", ...this.absCell(vx, vy, vz))) {
      anchor = [vx, vy, vz]; // aimed at a table: stand on it, not beside it
    }
    const [ax, az] = this.toAbs(anchor[0], anchor[2]);
    const item: PlacedFurniture = { kind: this.kind, x: ax, y: anchor[1], z: az, rot, variant: this.variant };
    verdict ??= this.host.layout.check(item, this.placementWorld);
    return { item, elevation: this.host.layout.elevation(item), verdict };
  }

  private absCell(x: number, y: number, z: number): [number, number, number] {
    const [ax, az] = this.toAbs(x, z);
    return [ax, y, az];
  }

  /** Right click in furniture mode. */
  place(hit: RayHit | null, yaw: number): boolean {
    if (!hit) return false;
    if (!this.host.canBuild()) {
      this.host.hud.toast("🧱 지금은 건축이 잠겨 있어요");
      return false;
    }
    const c = this.candidate(hit, yaw);
    if (!c) return false;
    if (c.verdict !== "ok") {
      if (c.verdict !== "invalid") this.host.hud.toast(REFUSAL[c.verdict]);
      return false;
    }
    if (!this.host.layout.add(c.item)) return false;
    unstick(this.host.world, this.host.pet()); // the pet is lifted clear, never refused
    this.record({ placed: [c.item], removed: [] });
    this.host.sfx.play("place");
    return true;
  }

  /**
   * Right click ON a piece that opens (door, gate, curtain): open or close it,
   * in any mode — a door you can only use after switching to furniture mode
   * is not a door. Returns true when the click was used up.
   */
  interact(item: PlacedFurniture): boolean {
    const def = furnitureDef(item.kind);
    if (!def.openParts) return false;
    if (!this.host.canBuild()) {
      this.host.hud.toast("🧱 지금은 건축이 잠겨 있어요");
      return true;
    }
    const before = { ...item };
    const result = this.host.layout.toggle(item, this.placementWorld);
    if (result === "body") {
      this.host.hud.toast(`🚪 ${def.name} 자리에 서 있어서 닫을 수 없어요`);
      return true;
    }
    if (result === "ok") this.changed([item], [before]);
    // closing on the pet lifts it clear rather than shutting it inside
    if (item.state !== 1) unstick(this.host.world, this.host.pet());
    this.host.sfx.play(item.state === 1 ? "doorOpen" : "doorClose");
    return true;
  }

  /**
   * Where to sit on a piece, if it has a seat: the centre of the cell you aimed
   * at (a sofa has two places), nudged toward its front, at seat height minus
   * the robot's hip height (its feet are its origin) — and the way it faces.
   * Grid coordinates.
   */
  seatAt(item: PlacedFurniture, aimed: [number, number, number] | null): { x: number; y: number; z: number; yaw: number } | null {
    const def = furnitureDef(item.kind);
    if (def.seat === undefined || item.state === 1) return null;
    const ox = this.host.originX();
    const oz = this.host.originZ();
    const cells = this.host.layout.cellsOf(item);
    const onPiece = aimed && cells.some(([x, y, z]) => x === aimed[0] + ox && y === aimed[1] && z === aimed[2] + oz);
    const [cx, , cz] = onPiece ? [aimed[0] + ox, aimed[1], aimed[2] + oz] : cells[0]!;
    const [fx, fz] = frontOf(item.rot);
    return {
      x: cx - ox + 0.5 + fx * 0.08,
      y: item.y + def.seat - SEAT_HIP + 0.04,
      z: cz - oz + 0.5 + fz * 0.08,
      yaw: Math.atan2(fx, fz),
    };
  }

  /** Is this exact piece still placed (the one being sat on, say)? */
  has(item: PlacedFurniture): boolean {
    return this.host.layout.all().includes(item);
  }

  /**
   * Middle click on a placed piece: make it the piece to place, in its colour —
   * "another one of those" without opening the panel. (Minecraft's pick-block.)
   */
  pickKind(item: PlacedFurniture): void {
    if (!this.enabled) return;
    this.select(item.kind, item.variant);
    const def = furnitureDef(item.kind);
    this.host.hud.toast(`${def.emoji} ${def.name} 골랐어요`);
  }

  // ------------------------------------------------------------ undo

  /**
   * What the player did, newest last: placements and put-aways (with whatever
   * went along with them). Ctrl+Z walks back, Ctrl+Y forward. Pieces dropped
   * because a block under them was mined are not here — that was a block
   * edit, and undoing it would put a sofa back on thin air.
   */
  private readonly undoStack: { placed: PlacedFurniture[]; removed: PlacedFurniture[] }[] = [];
  private readonly redoStack: { placed: PlacedFurniture[]; removed: PlacedFurniture[] }[] = [];

  private changed(placed: readonly PlacedFurniture[], removed: readonly PlacedFurniture[]): void {
    const tuple = (p: PlacedFurniture): ClassFurniture => [p.kind, p.x, p.y, p.z, p.rot, p.variant, p.state ?? 0];
    this.host.changed?.(placed.map(tuple), removed.map(tuple));
  }

  private record(step: { placed: PlacedFurniture[]; removed: PlacedFurniture[] }): void {
    this.changed(step.placed, step.removed);
    this.undoStack.push({ placed: step.placed.map((p) => ({ ...p })), removed: step.removed.map((p) => ({ ...p })) });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Apply a step backwards (undo) or forwards (redo). False if the world has
   *  since moved on (a block now fills the spot): nothing is half-applied. */
  private apply(step: { placed: PlacedFurniture[]; removed: PlacedFurniture[] }, backwards: boolean): boolean {
    const layout = this.host.layout;
    const before = layout.toJSON();
    const toRemove = backwards ? step.placed : step.removed;
    const toAdd = backwards ? step.removed : step.placed;
    const find = (p: PlacedFurniture) =>
      layout.all().find((q) => q.kind === p.kind && q.x === p.x && q.y === p.y && q.z === p.z && q.rot === p.rot);
    // hosts before what stands on them, so a vase finds its table
    const ordered = [...toAdd].sort((a, b) => (furnitureDef(a.kind).placement === "surface" ? 1 : 0) - (furnitureDef(b.kind).placement === "surface" ? 1 : 0));
    const live = toRemove.map(find);
    if (live.some((p) => !p)) return false;
    for (const p of live) if (p && layout.all().includes(p)) layout.remove(p);
    for (const p of ordered) {
      if (!layout.canPlace(p, this.placementWorld) || !layout.add(p)) {
        // Include cascaded pieces belonging to another participant in the rollback.
        layout.load(before, true);
        return false;
      }
    }
    this.changed(toAdd, toRemove);
    return true;
  }

  undo(): void {
    if (!this.host.canBuild()) return;
    if (!this.enabled) return;
    const step = this.undoStack.pop();
    if (!step) return this.host.hud.toast("↩️ 되돌릴 가구 작업이 없어요");
    if (!this.apply(step, true)) return this.host.hud.toast("↩️ 그 자리가 막혀 있어서 되돌릴 수 없어요");
    this.redoStack.push(step);
    this.host.sfx.play("undo");
    this.host.hud.toast("↩️ 되돌렸어요 (Ctrl+Y 다시)");
  }

  redo(): void {
    if (!this.host.canBuild()) return;
    if (!this.enabled) return;
    const step = this.redoStack.pop();
    if (!step) return;
    if (!this.apply(step, false)) return this.host.hud.toast("↪️ 그 자리가 막혀 있어서 다시 할 수 없어요");
    this.undoStack.push(step);
    this.host.sfx.play("undo");
    this.host.hud.toast("↪️ 다시 했어요");
  }

  /** Put a piece away (and whatever stood on it). It is free, so nothing is
   *  refunded — the toast is the feedback. */
  pickUp(item: PlacedFurniture): void {
    if (!this.host.canBuild()) return;
    const removed = this.host.layout.remove(item);
    if (removed.length === 0) return;
    this.record({ placed: [], removed });
    this.host.sfx.play("pickup");
    const def = furnitureDef(item.kind);
    const extra = removed.length > 1 ? ` (위에 있던 ${removed.length - 1}개도)` : "";
    this.host.hud.toast(`${def.emoji} ${withObjectParticle(def.name)} 치웠어요${extra}`);
  }

  /** A block was removed at this grid cell: put away what it was holding. */
  onBlockRemoved(x: number, y: number, z: number): void {
    const [ax, az] = this.toAbs(x, z);
    const removed = this.host.layout.afterBlockRemoved(ax, y, az, this.placementWorld);
    if (removed.length === 0) return;
    const def = furnitureDef(removed[0]!.kind);
    this.host.hud.toast(`${def.emoji} 받침이 없어져서 ${withObjectParticle(def.name)} 치웠어요`);
  }

  // ------------------------------------------------------------ frame

  /** Per frame: instances, ghost, HUD label, panel visibility. */
  render(hit: RayHit | null, yaw: number, showGhost: boolean, ok: THREE.Material, bad: THREE.Material): void {
    this.view.sync(this.host.layout, this.host.originX(), this.host.originZ());
    const c = showGhost && this.visible && hit ? this.candidate(hit, yaw) : null;
    if (c) {
      const ox = this.host.originX();
      const oz = this.host.originZ();
      this.view.showGhost(c.item, c.item.x - ox, c.item.y + c.elevation, c.item.z - oz, c.verdict === "ok" ? ok : bad);
    } else {
      this.view.hideGhost();
    }
    if (this.kind) {
      const def = furnitureDef(this.kind);
      const color = variantCount(def) > 1 ? ` · ${def.palettes![this.variant]!.name}` : "";
      // a wall piece always faces out of its wall, so R has nothing to show
      const turns = def.placement === "wall" ? 0 : this.extraRot;
      this.host.hud.setPiece(`${def.name}${color}`, turns, 0, def.emoji);
    }
  }

  /** Hidden while the machine lab owns the screen. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.shop.setVisible(visible && this.enabled);
    if (!visible) this.view.hideGhost();
  }

  /** Read-only state + test drivers for `__roboCraft` (dev builds only). */
  debug(): Record<string, unknown> {
    const grid = (x: number, y: number, z: number) => this.absCell(x, y, z);
    return {
      furniture: () => ({
        count: this.host.layout.size,
        items: this.host.layout.toJSON(),
        mode: this.kind,
        variant: this.variant,
        rot: this.extraRot,
      }),
      furnitureSelect: (kind: string | null, variant?: number) => {
        if (kind !== null && !isFurnitureKind(kind)) return false;
        this.select(kind, variant);
        return true;
      },
      /** Place at grid cell (x, y, z) under the same rules as a right click. */
      furniturePlace: (kind: string, x: number, y: number, z: number, rot = 0, variant = 0) => {
        if (!isFurnitureKind(kind)) return false;
        const [ax, ay, az] = grid(x, y, z);
        const item = { kind, x: ax, y: ay, z: az, rot, variant };
        if (!this.host.canBuild() || !this.host.layout.canPlace(item, this.placementWorld) || !this.host.layout.add(item)) return false;
        this.record({ placed: [item], removed: [] });
        return true;
      },
      furnitureAt: (x: number, y: number, z: number, layer: "solid" | "rug" | "surface" | "wall" = "solid") =>
        this.host.layout.at(layer, ...grid(x, y, z))?.kind ?? null,
      furnitureShopOpen: () => this.shop.open,
      furnitureClear: () => this.host.layout.clear(),
      /** Right-click a piece at a grid cell (any layer): opens/closes doors. */
      furnitureToggle: (x: number, y: number, z: number) => {
        const [ax, ay, az] = grid(x, y, z);
        const layout = this.host.layout;
        const item = layout.at("solid", ax, ay, az) ?? layout.at("wall", ax, ay, az);
        return item ? this.interact(item) : false;
      },
      furnitureState: (x: number, y: number, z: number) => {
        const [ax, ay, az] = grid(x, y, z);
        const item = this.host.layout.at("solid", ax, ay, az) ?? this.host.layout.at("wall", ax, ay, az);
        return item ? (item.state === 1 ? "open" : "closed") : null;
      },
    };
  }

  dispose(): void {
    this.host.world.propSolid = null;
    this.view.dispose();
    this.shop.dispose();
  }
}
