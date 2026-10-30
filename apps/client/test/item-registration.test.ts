import {describe,it,expect} from "vitest";
import {ItemAttack} from "../src/craft/itemAttack.js";
import {itemByKey,inventoryItems,selectedTool,toolByKey,withStarterTools} from "../src/craft/itemCatalog.js";
import {PICKAXE,pickaxeCycle,pickaxeWork} from "../src/craft/toolDefinitions.js";
import {addItem,assignHotbar,defaultHotbar,ensureFieldStacks,sanitizeCounts,sanitizeHotbar} from "../src/craft/inventory.js";
import {blockByKey} from "../src/craft/blocks.js";
import {freshState,serializeCraft,loadCraft} from "../src/craft/craftSave.js";

const identity=PICKAXE.id+"/"+PICKAXE.defaultOption;
describe("registered item and actual equipment",()=>{
 it("registers the pickaxe without inventing a terrain/voxel ID",()=>{expect(itemByKey(PICKAXE.id)).toMatchObject({kind:"tool",icon:PICKAXE.iconUrl,maxStack:1});expect(blockByKey(PICKAXE.id)).toBeUndefined();expect(inventoryItems().filter(x=>x.key===PICKAXE.id)).toHaveLength(1);expect(itemByKey("bedrock")).toBeUndefined();});
 it("adds one starter tool while preserving existing inventory and limiting duplicates",()=>{const counts=withStarterTools({stone:8});expect(counts).toEqual({stone:8,"pickaxe-basic":1});expect(withStarterTools(counts)).toEqual(counts);addItem(counts,PICKAXE.id,5);expect(counts[PICKAXE.id]).toBe(1);expect(ensureFieldStacks({})[PICKAXE.id]).toBe(1);expect(sanitizeCounts({[PICKAXE.id]:999,dirt:4,unknown:5})).toEqual({[PICKAXE.id]:1,dirt:4});});
 it("equips only the owned and selected tool, and drops attack mode on block, bucket or empty hands",()=>{const bar=defaultHotbar(),counts=withStarterTools({});expect(assignHotbar(bar,3,PICKAXE.id)).toBe(true);expect(selectedTool(counts,bar,3)).toBe(PICKAXE.id);expect(selectedTool({},bar,3)).toBeNull();expect(selectedTool(counts,bar,3,true)).toBeNull();expect(selectedTool(counts,bar,0)).toBeNull();expect(selectedTool(counts,bar,9)).toBeNull();expect(toolByKey("stone")).toBeNull();expect(assignHotbar(bar,9,PICKAXE.id)).toBe(false);expect(sanitizeHotbar(bar)[3]).toBe(PICKAXE.id);});
 it("round-trips the actual tool stack and hotbar through the existing island save",()=>{const state=freshState(42);state.inventory=withStarterTools({stone:4});assignHotbar(state.hotbar,2,PICKAXE.id);const raw=serializeCraft(state,1000),loaded=loadCraft({getItem:()=>raw,setItem:()=>{}},1);expect(loaded.inventory[PICKAXE.id]).toBe(1);expect(loaded.inventory.stone).toBe(4);expect(loaded.hotbar[2]).toBe(PICKAXE.id);expect(blockByKey(loaded.hotbar[2]!)).toBeUndefined();});
});

describe("real item attack clock",()=>{
 it("finishes one whole stroke after a quick click, even without a target",()=>{const attack=new ItemAttack(),cycle=pickaxeCycle();attack.request(identity);let hits=0,started=0;for(let i=0;i<100;i++){const step=attack.step(1/60,false,identity,cycle);if(step.started)started++;hits+=pickaxeWork(step.from,step.to,"stone");}expect(started).toBe(1);expect(hits).toBeCloseTo(PICKAXE.swing.seconds*PICKAXE.efficiency.stone,8);expect(attack.active).toBe(false);expect(attack.time).toBeCloseTo(cycle,8);});
 it("repeats while held and finishes the current cycle when released",()=>{const attack=new ItemAttack(),cycle=pickaxeCycle();for(let i=0;i<75;i++)attack.step(1/60,true,identity,cycle);const releaseAt=attack.time;expect(attack.active).toBe(true);for(let i=0;i<120;i++)attack.step(1/60,false,identity,cycle);expect(attack.active).toBe(false);expect(attack.time).toBeCloseTo(Math.ceil(releaseAt/cycle)*cycle,8);});
 it("cancels queued attacks on equipment loss, options change or an invalid attack posture",()=>{const attack=new ItemAttack(),cycle=pickaxeCycle();attack.request(identity);expect(attack.step(.1,true,identity,cycle).active).toBe(true);expect(attack.step(.1,false,null,cycle).active).toBe(false);expect(attack.step(.1,false,identity,cycle).started).toBe(false);attack.request(identity);expect(attack.step(.1,false,identity+"-changed",cycle).started).toBe(false);});
 it("retains a click queued for the newly selected equipment on its first tick",()=>{const attack=new ItemAttack();attack.step(1/60,false,null,pickaxeCycle());attack.request(identity);const step=attack.step(1/60,false,identity,pickaxeCycle());expect(step.changed).toBe(true);expect(step.started).toBe(true);expect(step.active).toBe(true);});
 it("applies no mining work during windup and has one work crossing per strike",()=>{const attack=new ItemAttack(),cycle=pickaxeCycle();attack.request(identity);const early=attack.step(cycle*.4,false,identity,cycle);expect(pickaxeWork(early.from,early.to,"stone")).toBe(0);const hit=attack.step(cycle*.2,false,identity,cycle);expect(pickaxeWork(hit.from,hit.to,"stone")).toBeGreaterThan(0);const recovery=attack.step(cycle*.4,false,identity,cycle);expect(pickaxeWork(recovery.from,recovery.to,"stone")).toBe(0);expect(recovery.completed).toBe(true);});
 it("keeps attack work independent of the frame rate",()=>{const totals=[30,60,144].map(fps=>{const attack=new ItemAttack();let time=0,total=0;while(time<3-1e-8){const dt=Math.min(1/fps,3-time),step=attack.step(dt,true,identity,pickaxeCycle());total+=pickaxeWork(step.from,step.to,"stone");time+=dt;}return total;});expect(totals[0]).toBeCloseTo(totals[1]!,8);expect(totals[1]).toBeCloseTo(totals[2]!,8);});
 it("keeps a second quick click during recovery as one following stroke",()=>{
  const a=new ItemAttack(),cycle=pickaxeCycle();a.request(identity);a.step(cycle*.3,true,identity,cycle);a.step(cycle*.1,false,identity,cycle);a.request(identity);a.step(cycle*.05,true,identity,cycle);
  let impacts=0;for(let i=0;i<240;i++){const step=a.step(cycle/100,false,identity,cycle);impacts+=pickaxeWork(step.from,step.to,"stone");}
  expect(impacts).toBeCloseTo(2*PICKAXE.swing.seconds*PICKAXE.efficiency.stone,8);expect(a.time).toBeCloseTo(cycle*2,8);expect(a.active).toBe(false);
 });
 it("bounds click spam to one upcoming stroke and cancels it on equipment loss",()=>{
  const a=new ItemAttack(),cycle=pickaxeCycle();a.request(identity);a.step(cycle*.1,false,identity,cycle);for(let i=0;i<8;i++){a.request(identity);a.step(cycle*.01,false,identity,cycle);}for(let i=0;i<220;i++)a.step(cycle/100,false,identity,cycle);
  expect(a.time).toBeCloseTo(cycle*2,8);a.request(identity);a.step(.05,true,identity,cycle);a.request(identity);a.step(.05,false,identity,cycle);a.step(.01,false,null,cycle);expect(a.step(.01,false,identity,cycle).active).toBe(false);
 });
 it("consumes queued clicks during a long hold without adding a release swing",()=>{
  const a=new ItemAttack(),cycle=pickaxeCycle();a.request(identity);a.step(cycle*.1,true,identity,cycle);a.request(identity);a.step(cycle*.1,true,identity,cycle);a.step(cycle*2.1,true,identity,cycle);for(let i=0;i<200;i++)a.step(cycle/100,false,identity,cycle);
  expect(a.time).toBeCloseTo(cycle*3,8);expect(a.active).toBe(false);
 });

});
