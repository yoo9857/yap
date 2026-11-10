import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { PartSelection } from "../src/craft/machines/partSelection.js";

function blocks(transparent = false) {
  const geometry = new THREE.CylinderGeometry(.6, .6, .3, 16);
  const material = new THREE.MeshBasicMaterial({ color: 0x91bcab, transparent });
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.userData.partIndices = [4, 9];
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-2, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(2, 0, 0));
  mesh.position.set(10, 4, 3);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("garage block selection", () => {
  it("outlines both affected instances and hides the unused twin when symmetry ends", () => {
    const mesh = blocks(), selection = new PartSelection();
    selection.show([mesh], [4, 9, 9]);
    const visible = () => selection.object.children.filter(child => child.visible) as THREE.Mesh[];
    expect(visible()).toHaveLength(2);
    expect(visible().map(shell => new THREE.Vector3().setFromMatrixPosition(shell.matrix).x)).toEqual([8, 12]);
    selection.show([mesh], [9]);
    expect(visible()).toHaveLength(1);
    expect(new THREE.Vector3().setFromMatrixPosition(visible()[0]!.matrix).x).toBe(12);
    selection.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  });
  it("follows the chosen instance's shape and world position without repainting it", () => {
    const mesh = blocks(), selection = new PartSelection();
    const colour = mesh.material.color.clone();
    selection.show([mesh], 9);
    const shell = selection.object.children[0] as THREE.Mesh;
    expect(shell.geometry).toBe(mesh.geometry);
    expect(new THREE.Vector3().setFromMatrixPosition(shell.matrix).toArray()).toEqual([12, 4, 3]);
    expect(mesh.material.color.equals(colour)).toBe(true);
    selection.show([mesh], 4);
    expect(new THREE.Vector3().setFromMatrixPosition(shell.matrix).toArray()).toEqual([8, 4, 3]);
    selection.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  });

  it("keeps glass clear and removes the highlight when there is no selected block", () => {
    const glass = blocks(true), opaque = blocks(), selection = new PartSelection();
    selection.show([glass], 4);
    expect(selection.object.visible).toBe(false);
    selection.show([glass, opaque], 4);
    expect(selection.object.visible).toBe(true);
    selection.show([glass, opaque], -1);
    expect(selection.object.visible).toBe(false);
    selection.dispose();
    for (const mesh of [glass, opaque]) { mesh.geometry.dispose(); mesh.material.dispose(); }
  });

  it("releases its own material while preserving shared block resources", () => {
    const mesh = blocks(), selection = new PartSelection(), geometryDisposed = vi.fn();
    mesh.geometry.addEventListener("dispose", geometryDisposed);
    selection.show([mesh], 4);
    const ownMaterial = (selection.object.children[0] as THREE.Mesh).material as THREE.Material;
    const materialDisposed = vi.fn(); ownMaterial.addEventListener("dispose", materialDisposed);
    selection.dispose();
    expect(materialDisposed).toHaveBeenCalledOnce();
    expect(geometryDisposed).not.toHaveBeenCalled();
    expect(selection.object.children).toHaveLength(0);
    mesh.geometry.dispose(); mesh.material.dispose();
  });
});
