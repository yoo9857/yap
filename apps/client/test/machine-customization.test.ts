import {beforeAll,describe,expect,it,vi} from "vitest";
import * as RAPIER from "@dimforge/rapier3d-compat";
import {PARTS,PART_ORDER,preset,parseBlueprint,machineStats,mirrorDirection,type Blueprint} from "../src/craft/machines/blueprint.js";
import {partControls,changePartCustom,validPartCustom,partMass,wheelRadius,wheelGrip,springFactor,thrustForce,wingArea,balloonLift} from "../src/craft/machines/customization.js";
import {PHYSICS_RULES} from "../src/craft/machines/physicsRules.js";
import {AIR} from "../src/craft/machines/aero.js";
import {encodeShare,decodeShare} from "../src/craft/machines/library.js";
import {MachinePhysics,IDLE_INPUT} from "../src/craft/machines/machinePhysics.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {MachineWorkshop} from "../src/craft/machines/workshop.js";
import {partInspectorMarkup} from "../src/craft/machines/workshopUi.js";
beforeAll(async()=>{await RAPIER.init();});
const sim=(b:Blueprint)=>new MachinePhysics(RAPIER,new VoxelWorld(),b,{x:80,y:5,z:80});
describe("per-part learning and saved customizations",()=>{
 it("offers appearance and an applicable physical control for each of the eight parts",()=>{
  for(const kind of PART_ORDER){const controls=partControls(kind);expect(controls.find(c=>c.key==="color")).toBeDefined();expect(controls.length).toBeGreaterThan(1);for(const c of controls){expect(c.options.some(o=>o.value===c.defaultValue)).toBe(true);for(const option of c.options)expect(validPartCustom({[c.key]:option.value},kind)).toBe(true);}}
 });
 it("rejects corrupt or incompatible settings before they reach physics",()=>{
  const b=preset("rover"),wheel=b.parts.find(p=>p.kind==="wheel")!;
  for(const bad of [{radius:Infinity},{radius:"huge"},{color:"<script>"},{power:"high"},{radius:2},["large"],null]){(wheel as unknown as {custom:unknown}).custom=bad;expect(parseBlueprint(JSON.stringify(b))).toBeNull();}
 });
 it("round-trips each individual setting through the existing blueprint and share code",()=>{
  const b=preset("rover"),i=b.parts.findIndex(p=>p.kind==="wheel");changePartCustom(b.parts[i]!,"radius","large");changePartCustom(b.parts[i]!,"color","coral");changePartCustom(b.parts[i]!,"spring","soft");
  expect(parseBlueprint(JSON.stringify(b))).toEqual(b);expect(decodeShare(encodeShare(b))).toEqual(b);expect(b.parts.filter(p=>p.custom)).toHaveLength(1);
 });
 it("preserves default designs and restores a part without changing the other parts",()=>{
  const b=preset("rover"),original=structuredClone(b),p=b.parts.find(p=>p.kind==="wheel")!;expect(wheelRadius(p)).toBe(PHYSICS_RULES.wheelRadius);expect(wheelGrip(p)).toBe(PHYSICS_RULES.tireFrictionSlip);expect(springFactor(p)).toBe(1);
  changePartCustom(p,"radius","large");changePartCustom(p,"reset","");expect(b).toEqual(original);expect(changePartCustom(p,"power","high")).toBe(false);
 });
 it("moves the actual mass centre when a heavy part is placed to one side",()=>{
  const b=preset("rover"),before=machineStats(b),p=b.parts.find(p=>p.kind==="frame"&&p.cell[0]===1)!;changePartCustom(p,"grade","heavy");const after=machineStats(b);
  expect(after.mass).toBeGreaterThan(before.mass);expect(after.center[0]).toBeGreaterThan(before.center[0]);expect(partMass(p,PARTS.frame.mass)).toBe(12);
 });
 it("uses the real editor command with symmetry, undo and redo",()=>{
  interface Editor{blueprint:Blueprint;mirror:boolean;undoStack:Blueprint[];redoStack:Blueprint[];customizePart(i:number,k:string,v:string):void;undo():void;redo():void;}
  const editor=Object.create(MachineWorkshop.prototype) as Editor;const b=preset("rover");Object.assign(editor,{blueprint:b,mirror:true,physics:null,loading:false,undoStack:[],redoStack:[],commit:vi.fn()});const index=b.parts.findIndex(p=>p.kind==="wheel");
  editor.customizePart(index,"radius","large");expect(editor.blueprint.parts.filter(p=>p.custom?.radius==="large")).toHaveLength(2);expect(editor.undoStack).toHaveLength(1);
  editor.undo();expect(editor.blueprint).toEqual(b);editor.redo();expect(editor.blueprint.parts.filter(p=>p.custom?.radius==="large")).toHaveLength(2);
  editor.mirror=false;editor.customizePart(index,"color","coral");expect(editor.blueprint.parts.filter(p=>p.custom?.color==="coral")).toHaveLength(1);
 });
 it("shows settings, units and a learning prompt for the selected assembled part",()=>{
  const b=preset("rover"),index=b.parts.findIndex(p=>p.kind==="wheel");changePartCustom(b.parts[index]!,"radius","large");const html=partInspectorMarkup(b,index,true);
  expect(html).toContain('value="large" selected');expect(html).toContain('data-custom="spring"');expect(html).toContain("0.70 m");expect(html).toContain("같은 모터 토크");expect(html).toContain("반대쪽");expect(html).not.toContain("NaN");expect(partInspectorMarkup(b,index,false,true)).toContain("disabled");
 });
 it("rotates an assembled thruster and mirrors its force direction without dropping paint",()=>{
  interface Editor{blueprint:Blueprint;customizePart(i:number,k:string,v:string):void;}
  const editor=Object.create(MachineWorkshop.prototype) as Editor,b=preset("ship");const index=b.parts.findIndex(p=>p.kind==="thruster"&&p.cell[0]!==0),part=b.parts[index]!;part.custom={color:"coral"};
  Object.assign(editor,{blueprint:b,mirror:true,physics:null,loading:false,undoStack:[],redoStack:[],commit:vi.fn()});editor.customizePart(index,"direction","2");const next=editor.blueprint.parts[index]!,twin=editor.blueprint.parts.find(p=>p.kind===part.kind&&p.cell[0]===-part.cell[0]&&p.cell[1]===part.cell[1]&&p.cell[2]===part.cell[2])!;
  expect(next.direction).toBe(2);expect(twin.direction).toBe(mirrorDirection(2));expect(next.custom?.color).toBe("coral");expect(decodeShare(encodeShare(editor.blueprint))).toEqual(editor.blueprint);
 });
 it("keeps legacy share codes and rejects invalid customized share data",()=>{
  const b=preset("rover"),legacy=encodeShare(b);expect(legacy.startsWith("CYM1.")).toBe(true);expect(decodeShare(legacy)).toEqual(b);
  b.parts[0]!.custom={color:"mint"};expect(encodeShare(b).startsWith("CYM2.")).toBe(true);expect(decodeShare("CYM2.%not-json")).toBeNull();expect(decodeShare("CYM2."+encodeURIComponent(JSON.stringify({...b,parts:[{kind:"wheel",cell:[0,0,0],direction:0,custom:{radius:"huge"}}]})))).toBeNull();
 });
});
describe("custom settings in the actual rigid-body simulation",()=>{
 it("sets the actual wheel radius, grip and spring and keeps the displayed mass honest",()=>{
  const b=preset("rover"),p=b.parts.find(p=>p.kind==="wheel")!;p.custom={radius:"large",grip:"grippy",spring:"soft"};const s=sim(b);
  try{expect(s.wheels.wheelRadius(0)).toBeCloseTo(.70);expect(s.wheels.wheelFrictionSlip(0)).toBeCloseTo(wheelGrip(p));expect(s.wheels.wheelSuspensionStiffness(0)).toBeCloseTo(PHYSICS_RULES.suspensionStiffness*springFactor(p));expect(s.snapshot().mass).toBeCloseTo(machineStats(b).mass,3);}finally{s.dispose();}
 });
 it("makes thruster power change the real hover capability",()=>{
  const results=[];
  for(const power of ["low","high"] as const){const b=preset("ship");for(const p of b.parts)if(p.kind==="thruster")p.custom={power};const s=sim(b);try{results.push(s.snapshot());expect(machineStats(b).liftRatio).toBeGreaterThan(0);}finally{s.dispose();}}
  expect(results[0]!.canHover).toBe(false);expect(results[1]!.canHover).toBe(true);expect(results[0]!.hoverBias).toBeGreaterThan(results[1]!.hoverBias);
 });
 it("applies balloon buoyancy and wing area to the forces, not just their labels",()=>{
  const buoyancy=[];
  for(const lift of ["low","high"] as const){const b=preset("rover");b.parts.push({kind:"balloon",cell:[0,2,1],direction:0,custom:{lift}});const p=b.parts[b.parts.length-1]!,s=sim(b);try{s.step(IDLE_INPUT);buoyancy.push(s.snapshot().aeroLift);expect(s.snapshot().aeroLift).toBeCloseTo(balloonLift(p),3);}finally{s.dispose();}}
  expect(buoyancy[1]!).toBeGreaterThan(buoyancy[0]!);
  const wingLift=[];for(const area of ["small","large"] as const){const b=preset("plane");for(const p of b.parts)if(p.kind==="wing")p.custom={area};const s=sim(b);try{s.body.setLinvel({x:0,y:-3,z:10},true);s.step(IDLE_INPUT);wingLift.push(s.snapshot().aeroLift);expect(machineStats(b).wingArea).toBeCloseTo(b.parts.filter(p=>p.kind==="wing").reduce((n,p)=>n+wingArea(p),0));}finally{s.dispose();}}
  expect(wingLift[1]!).toBeGreaterThan(wingLift[0]!);
 });
 it("uses gyro strength in the actual torque response",()=>{
  const spins=[];for(const power of ["low","high"] as const){const b=preset("rover");b.parts.find(p=>p.kind==="gyro")!.custom={power};const s=sim(b);try{s.step({...IDLE_INPUT,pitch:1});spins.push(s.snapshot().spin);}finally{s.dispose();}}
  expect(spins[1]!).toBeGreaterThan(spins[0]!);
 });
 it("keeps base forces for untouched parts",()=>{
  expect(thrustForce({kind:"thruster",cell:[0,0,0],direction:0})).toBe(PHYSICS_RULES.thrustPerEngine);expect(balloonLift({kind:"balloon",cell:[0,0,0],direction:0})).toBe(AIR.balloonLift);
 });
});
