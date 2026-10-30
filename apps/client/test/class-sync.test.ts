import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassSync } from "../src/craft/classSync.js";
import { FieldWindow } from "../src/craft/fieldWorld.js";
import { FurnitureLayout } from "../src/craft/furniture/layout.js";
import type { ClassClient, ClassSession } from "../src/net/classClient.js";
import type { VoxelView } from "../src/craft/voxelView.js";
vi.mock("../src/craft/classHud.js", () => ({ ClassHud: class {
  setMembers() {} setSettings() {} setYou() {} setOnline() {} showEnded() {} chat() {} dispose() {}
} }));
vi.mock("../src/player/rig.js", async () => {
  const THREE = await import("three");
  return { CharacterRig: class { root = new THREE.Group(); update(_anim:string,_speed:number,_dt:number,context:unknown) {this.root.userData.motionContext=context;} setHeldItem(id:string|null,option:string){this.root.userData.heldItem=id;this.root.userData.toolOption=option;} flashHit() { this.root.userData.flashed = (Number(this.root.userData.flashed) || 0) + 1; } pop() { this.root.userData.popped = (Number(this.root.userData.popped) || 0) + 1; } performAction(id: string, seq: number) { this.root.userData.action = id; this.root.userData.actionSeq = seq; } setCharacter(id: string) { this.root.userData.characterId=id; } setEmote(id: string,seq: number) { this.root.userData.emote=id; this.root.userData.emoteSeq=seq; } }, disposeRig: (root: THREE.Object3D) => {
    root.traverse((o) => { if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); } });
  } };
});
afterEach(() => vi.unstubAllGlobals());
const member = (id: string, role: "teacher" | "student" = "student") => ({ id, role, name: id, online: true });
function setup() {
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 40 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }) }) });
  const client = { connected: true, send: () => true, close: vi.fn(), activate: vi.fn() } as unknown as ClassClient;
  const field = new FieldWindow(), scene = new THREE.Scene();
  const session: ClassSession = { you: "old", role: "teacher", room: "Test", teacher: "Teacher", members: [member("old", "teacher"), member("other")],
    settings: { buildLocked: false, chatLocked: false }, edits: [], furniture: [] };
  const changed = vi.fn();
  const bonked = vi.fn();
  const impact = vi.fn();
  const sync = new ClassSync(client, session, field, { markDirty() {}, markCellDirty() {}, markWaterDirty() {} } as unknown as VoxelView,
    scene, { teleport() {}, toast() {}, clearKeys() {}, worldChanged: changed, bonked, impact }, new FurnitureLayout());
  return { client, field, scene, session, sync, changed, bonked, impact };
}
const robots = (scene: THREE.Scene) => scene.children.filter((child) => child.name !== "CraftYap bonk");
describe("classroom player synchronisation", () => {
  it("replaces identity after server restore and never draws its own robot twice", () => {
    const { client, scene, session, sync, changed } = setup();
    client.onSnap!([{ id: "other", pos: [0, 4, 0], yaw: 0, anim: "idle" }]);
    expect(sync.debug().remotes).toHaveLength(1);
    client.onResync!({ ...session, you: "new", members: [member("new", "teacher"), member("fresh")] });
    expect(robots(scene)).toHaveLength(0); expect(changed).toHaveBeenCalledOnce();
    client.onSnap!([{ id: "new", pos: [0, 4, 0], yaw: 0, anim: "idle" }, { id: "fresh", pos: [1, 4, 0], yaw: 0, anim: "idle" }]);
    expect(sync.debug().you).toBe("new"); expect(sync.debug().remotes.map((r) => r.id)).toEqual(["fresh"]);
    sync.dispose(); expect(scene.children).toHaveLength(0);
  });
  it("uses the server's last accepted value when a repeated local edit is refused", () => {
    const { client, field, sync } = setup();
    field.applyRemote(0, 4, 0, 3, 0); sync.recordEdit(80, 4, 80, 0, 0, 3, 0);
    field.applyRemote(0, 4, 0, 17, 0); sync.recordEdit(80, 4, 80, 3, 0, 17, 0);
    client.onReject!([[0, 4, 0, 3, 0]], true);
    expect(field.cellAt(0, 4, 0)).toEqual([3, 0]); sync.dispose();
  });
  it("hides disconnected remotes immediately and frees them on class end", () => {
    const { client, scene, sync } = setup();
    client.onSnap!([{ id: "other", pos: [0, 4, 0], yaw: 0, anim: "idle" }]);
    client.onConnection!(false); sync.render(1 / 60); expect(robots(scene)[0]!.visible).toBe(false);
    client.onEnded!("closed"); expect(robots(scene)).toHaveLength(0); sync.dispose();
  });
  it("shoves the local player and flashes a classmate who was tapped", () => {
    const { client, scene, sync, bonked, impact } = setup();
    client.onSnap!([{ id: "other", pos: [2, 4, 0], yaw: 0, anim: "idle" }]);
    const friend = robots(scene)[0]!;
    client.onBonk!({ t: "s-k-bonk", by: "other", target: "old", seq: 3, vx: 4, vz: 0, vy: 3, at: [1, 5.05, 0] });
    expect(bonked).toHaveBeenCalledWith({ vx: 4, vz: 0, vy: 3 });
    expect(impact).toHaveBeenCalledOnce();
    client.onBonk!({ t: "s-k-bonk", by: "old", target: "other", seq: 4, vx: -4, vz: 1, vy: 3, at: [2, 5.05, 0] });
    expect(bonked).toHaveBeenCalledTimes(1);
    expect(friend.userData).toMatchObject({ flashed: 1, popped: 1, action: "hit", actionSeq: 3 });
    expect(scene.getObjectByName("CraftYap bonk")!.children.some((chip) => chip.visible)).toBe(true);
    sync.dispose();
  });
  it("shows a classmate's actual equipped item and removes it on a block switch",()=>{
    const {client,scene,sync}=setup();client.onSnap!([{id:"other",pos:[2,4,0],yaw:0,anim:"idle",heldItem:"pickaxe-basic",toolOption:"precise-tip",toolPhase:.58,action:"interact",actionSeq:7,actionLoop:true}]);sync.render(1/60);const friend=robots(scene)[0]!;expect(friend.userData).toMatchObject({heldItem:"pickaxe-basic",toolOption:"precise-tip",action:"interact"});expect((friend.userData.motionContext as {toolTime:number}).toolTime).toBeGreaterThan(0);
    client.onSnap!([{id:"other",pos:[2,4,0],yaw:0,anim:"idle",heldItem:null,action:"none"}]);sync.render(1/60);expect(friend.userData.heldItem).toBeNull();sync.dispose();
  });

});
