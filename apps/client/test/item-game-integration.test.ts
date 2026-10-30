import {describe,it,expect,vi} from "vitest";
import {CraftGame} from "../src/craft/craftGame.js";
import {ItemAttack} from "../src/craft/itemAttack.js";
import {PICKAXE,pickaxeCycle} from "../src/craft/toolDefinitions.js";
import {VoxelWorld} from "../src/craft/voxelWorld.js";
import {blockByKey} from "../src/craft/blocks.js";

// Use the real game's interaction methods without constructing WebGL or the
// browser shell. World writes, ownership, aim limits and clock are real.
interface GameInteraction {
    state:{inventory:Record<string,number>;hotbar:string[];world:VoxelWorld};
    selected:number;emptyHands:boolean;locked:boolean;mining:boolean;
    posture:string;seated:null;body:{grounded:boolean;wet:number};
    furniture:{active:boolean};rig:{postureBusy:boolean};
    toolOption:string;toolElapsed:number;itemAttack:ItemAttack;
    workAction:string;workSeq:number;workLoop:boolean;workLeft:number;
    emote:string;emoteLeft:number;emoteSeq:number;actionHold:number;
    aim:null|{voxel:[number,number,number];dist:number};aimFurniture:null;
    miningTarget:[number,number,number]|null;miningIdentity:string;
    miningProgress:number;miningFrac:number|null;pickupTarget:null;
    sync:null;yaw:number;facing:number;
    miningEffects:{primeTarget:ReturnType<typeof vi.fn>;burst:ReturnType<typeof vi.fn>};
    view:{miningShape:ReturnType<typeof vi.fn>};
    sfx:{play:ReturnType<typeof vi.fn>};camera:{addShake:ReturnType<typeof vi.fn>};
    writeCell:ReturnType<typeof vi.fn>;
    stepInteraction(dt:number):void;heldTool():string|null;tryPlace():void;
}
function game():GameInteraction {
    const world=new VoxelWorld();world.set(2,4,2,blockByKey("stone")!.id);
    const g=Object.create(CraftGame.prototype) as GameInteraction;
    Object.assign(g,{state:{inventory:{[PICKAXE.id]:1},hotbar:[PICKAXE.id,"dirt","water"],world},selected:0,emptyHands:false,locked:true,mining:false,posture:"stand",seated:null,body:{grounded:true,wet:0},furniture:{active:false},rig:{postureBusy:false},toolOption:"balanced",toolElapsed:0,itemAttack:new ItemAttack(),workAction:"none",workSeq:0,workLoop:false,workLeft:0,emote:"none",emoteLeft:0,emoteSeq:0,actionHold:0,aim:{voxel:[2,4,2],dist:1},aimFurniture:null,miningTarget:null,miningIdentity:"",miningProgress:0,miningFrac:null,pickupTarget:null,sync:null,yaw:0,facing:0,miningEffects:{primeTarget:vi.fn(),burst:vi.fn()},view:{miningShape:vi.fn()},sfx:{play:vi.fn()},camera:{addShake:vi.fn()},writeCell:vi.fn()});
    return g;
}
describe("actual game item interaction",()=>{
    it("plays an equipped attack even when there is no aimed block",()=>{
        const g=game();g.aim=null;g.itemAttack.request(PICKAXE.id+"/balanced");g.stepInteraction(1/60);
        expect(g.itemAttack.active).toBe(true);expect(g.workAction).toBe("interact");expect(g.workLoop).toBe(true);expect(g.toolElapsed).toBeGreaterThan(0);expect(g.writeCell).not.toHaveBeenCalled();
    });
    it("holds damage until the actual swing impact, then breaks a targeted block once",()=>{
        const g=game();g.state.world.set(2,4,2,blockByKey("dirt")!.id);g.itemAttack.request(PICKAXE.id+"/balanced");
        const hit=pickaxeCycle()*PICKAXE.swing.impactAt;let time=0;while(time<hit-.03){g.stepInteraction(1/120);time+=1/120;expect(g.miningProgress).toBe(0);expect(g.writeCell).not.toHaveBeenCalled();}
        while(time<hit+.01){g.stepInteraction(1/120);time+=1/120;}expect(g.writeCell).toHaveBeenCalledTimes(1);expect(g.state.inventory.dirt).toBe(1);expect(g.state.inventory[PICKAXE.id]).toBe(1);
    });
    it("never mines a distant or backwards block while visibly attacking",()=>{
        for(const [distance,yaw] of [[3,0],[1,Math.PI]]){const g=game();g.aim!.dist=distance!;g.facing=yaw!;g.itemAttack.request(PICKAXE.id+"/balanced");for(let i=0;i<30;i++)g.stepInteraction(1/60);expect(g.itemAttack.active).toBe(true);expect(g.miningProgress).toBe(0);expect(g.writeCell).not.toHaveBeenCalled();}
    });
    it("stops the tool attack on a block switch, water selection, missing ownership or empty hands",()=>{
        for(const change of [(g:GameInteraction)=>{g.selected=1;},(g:GameInteraction)=>{g.selected=2;},(g:GameInteraction)=>{g.state.inventory[PICKAXE.id]=0;},(g:GameInteraction)=>{g.emptyHands=true;}]){const g=game();g.itemAttack.request(PICKAXE.id+"/balanced");g.stepInteraction(.1);change(g);g.stepInteraction(.1);expect(g.heldTool()).toBeNull();expect(g.itemAttack.active).toBe(false);expect(g.workAction).toBe("none");}
    });
    it("does not place a block with the pickaxe and preserves the regular building action",()=>{
        const g=game();g.tryPlace();expect(g.writeCell).not.toHaveBeenCalled();g.selected=1;g.state.inventory.dirt=1;expect(g.heldTool()).toBeNull();g.mining=true;g.stepInteraction(.1);expect(g.workAction).toBe("interact");expect(g.miningProgress).toBeCloseTo(.1);
    });
    it("retains teacher build locks even while swinging an owned tool",()=>{
        const g=game();Object.assign(g,{sync:{canBuild:()=>false}});g.mining=true;for(let i=0;i<50;i++)g.stepInteraction(1/60);expect(g.itemAttack.active).toBe(true);expect(g.writeCell).not.toHaveBeenCalled();expect(g.miningProgress).toBe(0);
    });
    it("leaves water untouched with tools, blocks and empty hands, and scoops only with the bucket",()=>{
        for(const mode of ["tool","block","empty","bucket"]){const g=game();g.state.world.set(2,4,2,blockByKey("water")!.id);g.selected=mode==="block"?1:mode==="bucket"?2:0;g.emptyHands=mode==="empty";g.mining=true;
            if(mode==="tool")g.itemAttack.request(PICKAXE.id+"/balanced");
            for(let i=0;i<60;i++)g.stepInteraction(1/120);
            if(mode==="bucket"){expect(g.writeCell).toHaveBeenCalledTimes(1);expect(g.sfx.play).toHaveBeenCalledWith("pour");}
            else{expect(g.writeCell).not.toHaveBeenCalled();expect(g.sfx.play).not.toHaveBeenCalled();if(mode==="tool")expect(g.itemAttack.active).toBe(true);}
        }
    });

});
