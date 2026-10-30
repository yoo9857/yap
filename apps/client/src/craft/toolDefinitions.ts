import definition from "../../../../assets/items/tools/pickaxe-basic/item.json";
export type HeldItemId="pickaxe-basic";
export const PICKAXE=definition;
export type PickaxeOption=typeof PICKAXE.options[number];
export function pickaxeOption(id=PICKAXE.defaultOption):PickaxeOption {return PICKAXE.options.find(o=>o.id===id)??PICKAXE.options[0]!;}
export function pickaxeCycle(option=PICKAXE.defaultOption):number {return PICKAXE.swing.seconds/pickaxeOption(option).speed;}
export function pickaxeFamily(key:string):keyof typeof PICKAXE.efficiency {
 return key.endsWith("-ore")?"ore":/planks|log|bookshelf|hay/.test(key)?"wood":/grass|dirt|sand|gravel|clay/.test(key)?"ground":/iron-block|gold-block/.test(key)?"metal":/diamond-block|obsidian/.test(key)?"gem":/stone|bricks|bedrock/.test(key)?"stone":"other";
}
export function pickaxeEfficiency(key:string,option=PICKAXE.defaultOption):number {
 const family=pickaxeFamily(key),o=pickaxeOption(option);
 return PICKAXE.efficiency[family]*(o.affinity.length===0||o.affinity.includes(family)?o.mining:1);
}
/** Count impact crossings, including a low-FPS frame crossing more than one stroke. */
export function pickaxeWork(from:number,to:number,key:string,option=PICKAXE.defaultOption):number {
 if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||from<0)return 0;
 const cycle=pickaxeCycle(option),impact=cycle*PICKAXE.swing.impactAt,count=(t:number)=>Math.max(0,Math.floor((t-impact+1e-9)/cycle)+1);
 return (count(to)-count(from))*PICKAXE.swing.seconds*pickaxeEfficiency(key,option);
}
/** Mining hits the aimed first solid only. The head radius is a contact/debug shape, never AoE. */
export function pickaxeInReach(distance:number,headingError=0,option=PICKAXE.defaultOption):boolean {return Number.isFinite(distance)&&Number.isFinite(headingError)&&distance>=0&&distance<=PICKAXE.targeting.reach&&Math.abs(Math.atan2(Math.sin(headingError),Math.cos(headingError)))<=PICKAXE.targeting.arcDegrees*pickaxeOption(option).arc*Math.PI/360;}
