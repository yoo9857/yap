import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seatLayout } from "@robo/shared";
import { SeatingView, type SeatSign } from "../src/craft/seatingView.js";

afterEach(() => vi.unstubAllGlobals());

/** The name signs draw on a 2D canvas: a stand-in that records nothing and never fails. */
function stubCanvas(): void {
  const ctx = { fillRect() {}, fillText() {}, measureText: () => ({ width: 120 }), font: "", fillStyle: "", textAlign: "", textBaseline: "" };
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
}

const seats = (n: number, teacher: [number, number, number] = [500.2, 4, -30.7]): SeatSign[] =>
  seatLayout(n, teacher, 0).map((s, i) => ({ name: `학생${i + 1}`, pos: s.pos, yaw: s.yaw }));

/** Every material/texture/geometry under an object, to check what dispose() releases. */
const resources = (root: THREE.Object3D) => {
  const out = new Set<{ dispose(): void }>();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const mesh = o as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      out.add(mesh.geometry);
      for (const m of [mesh.material].flat()) {
        out.add(m);
        if ((m as THREE.MeshStandardMaterial).map) out.add((m as THREE.MeshStandardMaterial).map!);
      }
    }
  });
  return [...out];
};

describe("classroom plots in the world (SeatingView)", () => {
  it("joins the scene only while plots stand, and leaves it when they are cleared", () => {
    stubCanvas();
    const scene = new THREE.Scene();
    const view = new SeatingView(scene);
    expect(scene.children).toHaveLength(0); // nothing in the scene before a seating
    expect(view.count).toBe(0);
    view.set(seats(7));
    expect(scene.children).toHaveLength(1);
    expect(view.count).toBe(7);
    view.set([]);
    expect(scene.children).toHaveLength(0);
    expect(view.count).toBe(0);
  });

  it("draws a name sign per student and shares the fence between neighbours", () => {
    stubCanvas();
    const scene = new THREE.Scene();
    const view = new SeatingView(scene);
    view.set(seats(2));
    const group = scene.children[0]!;
    const signs = group.children.filter((c) => c instanceof THREE.Mesh && !(c instanceof THREE.InstancedMesh) && Array.isArray(c.material));
    expect(signs).toHaveLength(2);
    // fence boards: two plots side by side have 7 distinct edges (4 + 4 − 1 shared)
    const boards = group.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
    expect(boards[0]!.count).toBe(7);
  });

  it("places the plots under the field window from ABSOLUTE positions (a scroll never moves them)", () => {
    stubCanvas();
    const scene = new THREE.Scene();
    const view = new SeatingView(scene);
    const list = seats(3);
    view.set(list);
    const group = scene.children[0]!;
    // the window's origin at 480,-60: grid = absolute − origin
    view.update((ax, az) => [ax - 480, az + 60]);
    expect(group.position.x).toBeCloseTo(list[0]!.pos[0] - 480);
    expect(group.position.z).toBeCloseTo(list[0]!.pos[2] + 60);
    // the window scrolls 16 cells: the plots shift with the grid, staying on the same absolute cells
    view.update((ax, az) => [ax - 496, az + 60]);
    expect(group.position.x).toBeCloseTo(list[0]!.pos[0] - 496);
  });

  it("releases what it built when replaced or disposed", () => {
    stubCanvas();
    const scene = new THREE.Scene();
    const view = new SeatingView(scene);
    view.set(seats(4));
    const first = resources(scene.children[0]!);
    const spies = first.map((r) => vi.spyOn(r, "dispose"));
    view.dispose();
    // every per-seating material and texture (names, tints) is disposed; the shared ones too on dispose()
    expect(spies.every((s) => s.mock.calls.length > 0)).toBe(true);
    expect(scene.children).toHaveLength(0);
  });
});
