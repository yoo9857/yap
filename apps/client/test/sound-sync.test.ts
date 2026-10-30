/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- the harness drives private CraftGame members through an untyped handle */
import {describe,it,expect,vi} from "vitest";
import {CraftGame} from "../src/craft/craftGame.js";
import {ItemAttack} from "../src/craft/itemAttack.js";
import {PICKAXE,pickaxeCycle} from "../src/craft/toolDefinitions.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {blockByKey} from "../src/craft/blocks.js";
import {clipOf} from "../src/audio/sfx.js";

// The real game's per-tick code, without WebGL: which tick each sound fires on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;
function game(block="stone"):G {
    const world=new VoxelWorld();world.set(2,4,2,blockByKey(block)!.id);
    const g=Object.create(CraftGame.prototype);
    Object.assign(g,{state:{inventory:{[PICKAXE.id]:1},hotbar:[PICKAXE.id,"dirt","water"],world},selected:0,emptyHands:false,locked:true,mining:false,posture:"stand",seated:null,body:{grounded:true,wet:0},furniture:{active:false},rig:{postureBusy:false},toolOption:"balanced",toolElapsed:0,itemAttack:new ItemAttack(),workAction:"none",workSeq:0,workLoop:false,workLeft:0,emote:"none",emoteLeft:0,emoteSeq:0,actionHold:0,aim:{voxel:[2,4,2],dist:1},aimFurniture:null,miningTarget:null,miningIdentity:"",miningProgress:0,miningFrac:null,pickupTarget:null,sync:null,yaw:0,facing:0,miningEffects:{primeTarget:vi.fn(),burst:vi.fn()},view:{miningShape:vi.fn()},sfx:{play:vi.fn(),material:vi.fn(),swing:vi.fn(),step:vi.fn(),punch:vi.fn(),at:(_x:number,_y:number,_z:number,play:()=>void)=>play()},camera:{addShake:vi.fn()},writeCell:vi.fn()});
    g.state.world=world;
    return g;
}
const sounds=(g:G,name:string,arg?:string)=>(g.sfx[name].mock.calls as unknown[][]).filter((c)=>arg===undefined||c[0]===arg).length;

describe("sound follows the motion it belongs to",()=>{
    it("sounds a pickaxe hit once per blade impact, on the tick the block takes the damage", ()=>{
        // obsidian takes several blows (stone breaks in one)
        const g=game("obsidian");g.mining=true;const dt=1/60,cycle=pickaxeCycle();
        const damageTicks:number[]=[],hitTicks:number[]=[];let prev=0;
        for(let i=0;i<Math.round(cycle*2.5/dt);i++){
            const before=sounds(g,"material","hit");g.stepInteraction(dt);
            if(g.miningProgress>prev+1e-9)damageTicks.push(i);prev=g.miningProgress;
            if(sounds(g,"material","hit")>before)hitTicks.push(i);
        }
        expect(damageTicks.length).toBeGreaterThanOrEqual(2);
        expect(g.writeCell).not.toHaveBeenCalled();
        expect(hitTicks).toEqual(damageTicks);
    });

    it("plays the break alone on the breaking blow, never a hit stacked on it", ()=>{
        const g=game("dirt");g.mining=true;
        for(let i=0;i<Math.round(pickaxeCycle()/(1/60))+2;i++)g.stepInteraction(1/60);
        expect(g.writeCell).toHaveBeenCalledTimes(1);
        expect(sounds(g,"material","break")).toBe(1);
        expect(sounds(g,"material","hit")).toBe(0);
    });

    it("schedules each stroke's whoosh from its start, cresting just before that stroke's impact", ()=>{
        const g=game("stone");g.mining=true;const dt=1/60,cycle=pickaxeCycle();
        for(let i=0;i<Math.round(cycle*2.9/dt);i++)g.stepInteraction(dt);
        const calls=g.sfx.swing.mock.calls as number[][];
        expect(calls.length).toBe(3);
        for(const [impactIn] of calls){expect(impactIn).toBeGreaterThan(PICKAXE.swing.impactAt*cycle-dt-1e-6);expect(impactIn).toBeLessThanOrEqual(PICKAXE.swing.impactAt*cycle+1e-6);}
    });

    it("steps on the frames the drawn feet plant, and taps when the digging hand meets the block", ()=>{
        const g=game("stone");g.state.world.set(0,3,0,blockByKey("oak-planks")!.id);
        Object.assign(g.body,{x:.5,y:4,z:.5,vx:4,vz:0});g.isSwimming=()=>false;
        let cue:{gait:string|null;phase:number;digPhase:number|null}={gait:"walk",phase:0,digPhase:null};g.rig={postureBusy:false,get motionCue(){return cue;}};
        g.cuePhase=-1;g.cueDig=-1;g.stepQuietUntil=0;
        const steps:number[]=[];
        for(let i=0;i<=40;i++){cue={...cue,phase:(i*0.05)%1};const n=sounds(g,"step");g.cueSounds();if(sounds(g,"step")>n)steps.push(+cue.phase.toFixed(2));}
        // two plants per gait cycle (0 and 0.5), on the planks underfoot
        expect(steps).toEqual([0.5,0,0.5,0]);
        expect(g.sfx.step.mock.calls[0][0]).toBe("wood");
        g.mining=true;g.miningTarget=[2,4,2];cue={gait:null,phase:0,digPhase:0};g.cueSounds();
        const taps=()=>sounds(g,"material","hit");
        cue={...cue,digPhase:.45};g.cueSounds();expect(taps()).toBe(0);
        cue={...cue,digPhase:.55};g.cueSounds();expect(taps()).toBe(1);
        cue={...cue,digPhase:.95};g.cueSounds();cue={...cue,digPhase:.05};g.cueSounds();expect(taps()).toBe(1);
    });
});

describe("recordings start where their sound starts", ()=>{
    it("finds the attack after leading silence, and the loudest moment after it", ()=>{
        const sr=44100,data=new Float32Array(sr/2);
        for(let i=Math.round(.1*sr);i<Math.round(.12*sr);i++)data[i]=.3*Math.sin(i);
        for(let i=Math.round(.2*sr);i<Math.round(.21*sr);i++)data[i]=.9*Math.sin(i);
        const clip=clipOf({sampleRate:sr,length:data.length,getChannelData:()=>data} as unknown as AudioBuffer);
        expect(clip.onset).toBeGreaterThan(.095);expect(clip.onset).toBeLessThan(.101);
        expect(clip.peak).toBeGreaterThan(.199);expect(clip.peak).toBeLessThan(.211);
    });
});
