import { describe, expect, it, vi } from "vitest";
import { CLASS_MAX_PLANTS, type ClassPlant, type PlantSite } from "@robo/shared";
import { ScienceMode } from "../src/craft/science/scienceMode.js";

type Runtime = { site: PlantSite; owner: string };
type Probe = Pick<ScienceMode, "applyNet" | "debugLay"> & {
  sites: Runtime[];
  ver: number;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
};
const site = (id: number, x = id * 10): PlantSite => ({ id, kind: "wind", x, y: 4, z: 10, rot: 0, filled: 0, on: false });
const row = (value: PlantSite, owner = "Minji"): ClassPlant => [value.id, value.kind, value.x, value.y, value.z, value.rot, value.filled, value.on ? 1 : 0, owner];

function mode(count = 0, classroom = true) {
  const probe = Object.create(ScienceMode.prototype) as Probe;
  const send = vi.fn();
  Object.assign(probe, {
    sites: Array.from({length:count}, (_, i) => ({site:site(i + 1),owner:"Minji"})), ver:0, kind:"wind", nextId:count + 1,
    host: {
      net: classroom ? {send,canEditAt:()=>true,own:()=>true} : undefined,
      originX:()=>0, originZ:()=>0, world:{inBounds:()=>true,isSolid:(_x:number,y:number)=>y < 4},
      blockAt:(_x:number,y:number)=>y < 4 ? 1 : 0, playerIn:()=>false, furnitureIn:()=>false, toast:vi.fn(),
    },
    add:vi.fn((value:PlantSite,_born:number,owner:string="") => probe.sites.push({site:value,owner})),
    remove:vi.fn((runtime:Runtime) => { probe.sites = probe.sites.filter(value => value !== runtime); }),
    refresh:vi.fn(),
  });
  return {probe,send};
}

describe("classroom science reconciliation", () => {
  it("rebuilds a reused id at its authoritative position after a server restart", () => {
    const {probe} = mode(2), previous = probe.sites[1]!;
    const moved = {...previous.site,x:500,rot:2};
    probe.applyNet({full:true,plants:[row(moved,"Seojun")]});
    expect(probe.remove).toHaveBeenCalledWith(previous,true);
    expect(probe.add).toHaveBeenCalledWith(moved,0,"Seojun");
    expect(probe.sites).toEqual([{site:moved,owner:"Seojun"}]);
  });

  it("keeps an unchanged confirmation and applies a rejected optimistic change", () => {
    const {probe} = mode(1), runtime = probe.sites[0]!;
    probe.applyNet({plants:[row(runtime.site)]});
    expect(probe.remove).not.toHaveBeenCalled();
    expect(probe.refresh).not.toHaveBeenCalled();
    runtime.site = {...runtime.site,filled:1};
    probe.applyNet({plants:[row({...runtime.site,filled:0})],refused:"locked"});
    expect(probe.sites[0]!.site.filled).toBe(0);
    expect(probe.refresh).toHaveBeenCalledOnce();
  });

  it("lets a class continue past 64 plants and keeps the separate solo and class limits", () => {
    const {probe,send} = mode(64);
    expect(probe.debugLay(1000,4,1000,0)).toBeNull();
    expect(send).toHaveBeenCalledWith({op:"lay",kind:"wind",x:1000,y:4,z:1000,rot:0});
    expect(mode(64,false).probe.debugLay(1000,4,1000,0)).toBe("overlap");
    expect(mode(CLASS_MAX_PLANTS).probe.debugLay(3000,4,1000,0)).toBe("overlap");
  });
});
