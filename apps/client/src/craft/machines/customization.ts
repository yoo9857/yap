import type { MachinePart, PartKind } from "./blueprint.js";
import { PHYSICS_RULES as RULES } from "./physicsRules.js";
import { AIR } from "./aero.js";

export const PART_COLORS = {
  cream: {name:"크림",hex:0xe4d6ac},mint:{name:"민트",hex:0xa8ddc8},honey:{name:"꿀빛",hex:0xe7b85d},
  coral:{name:"살구",hex:0xda7966},sky:{name:"하늘",hex:0x8bbfd8},lavender:{name:"연보라",hex:0xb5a1d6},slate:{name:"돌빛",hex:0x78888a},
} as const;
export const BASE_PART_COLOR:Record<PartKind,keyof typeof PART_COLORS>={frame:"cream",cockpit:"mint",ballast:"slate",wheel:"cream",thruster:"honey",gyro:"sky",wing:"cream",balloon:"coral"};
export interface PartCustom {
  color?:keyof typeof PART_COLORS;
  grade?:"light"|"standard"|"heavy";
  radius?:"small"|"standard"|"large";
  grip?:"smooth"|"standard"|"grippy";
  spring?:"soft"|"standard"|"firm";
  power?:"low"|"standard"|"high";
  area?:"small"|"standard"|"large";
  lift?:"low"|"standard"|"high";
}
export interface PartControl {key:keyof PartCustom;label:string;options:readonly {value:string;label:string}[];defaultValue:string;}
const options=(values:readonly string[],labels:readonly string[])=>values.map((value,i)=>({value,label:labels[i]!}));
const color:PartControl={key:"color",label:"블록 색",defaultValue:"cream",options:Object.entries(PART_COLORS).map(([value,c])=>({value,label:c.name}))};
const controls:Record<Exclude<keyof PartCustom,"color">,PartControl>={
  grade:{key:"grade",label:"재료의 무게",defaultValue:"standard",options:options(["light","standard","heavy"],["가볍게","기본","무겁게"])},
  radius:{key:"radius",label:"바퀴 크기",defaultValue:"standard",options:options(["small","standard","large"],["작게","기본","크게"])},
  grip:{key:"grip",label:"타이어 접지력",defaultValue:"standard",options:options(["smooth","standard","grippy"],["미끄럽게","기본","단단히 잡기"])},
  spring:{key:"spring",label:"서스펜션",defaultValue:"standard",options:options(["soft","standard","firm"],["푹신하게","기본","단단하게"])},
  power:{key:"power",label:"힘의 세기",defaultValue:"standard",options:options(["low","standard","high"],["약하게","기본","강하게"])},
  area:{key:"area",label:"날개 면적",defaultValue:"standard",options:options(["small","standard","large"],["작게","기본","넓게"])},
  lift:{key:"lift",label:"기구의 부력",defaultValue:"standard",options:options(["low","standard","high"],["적게","기본","많이"])},
};
const kinds:Record<PartKind,readonly (keyof typeof controls)[]>={frame:["grade"],cockpit:["grade"],ballast:["grade"],wheel:["radius","grip","spring"],thruster:["power"],gyro:["power"],wing:["area"],balloon:["lift"]};
export function partControls(kind:PartKind):readonly PartControl[]{return [{...color,defaultValue:BASE_PART_COLOR[kind]},...kinds[kind].map(k=>controls[k])];}
export function validPartCustom(value:unknown,kind:PartKind):value is PartCustom{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const allowed=partControls(kind);
  return Object.entries(value).every(([key,v])=>allowed.some(c=>c.key===key&&c.options.some(o=>o.value===v)));
}
export function changePartCustom(part:MachinePart,key:string,value:string):boolean{
  if(key==="reset"){if(!part.custom)return false;delete part.custom;return true;}
  const control=partControls(part.kind).find(c=>c.key===key);if(!control?.options.some(o=>o.value===value))return false;
  const custom:Record<string,string>={...part.custom};if(value===control.defaultValue)delete custom[key];else custom[key]=value;
  if(JSON.stringify(custom)===JSON.stringify(part.custom??{}))return false;
  if(Object.keys(custom).length)part.custom=custom;else delete part.custom;return true;
}
const factor=(v:string|undefined,low:string,high:string,a:number,b:number)=>v===low?a:v===high?b:1;
export function wheelRadius(p:MachinePart):number{return p.custom?.radius==="small"?.46:p.custom?.radius==="large"?.70:RULES.wheelRadius;}
export function wheelGrip(p:MachinePart):number{return RULES.tireFrictionSlip*factor(p.custom?.grip,"smooth","grippy",.5,1.45);}
export function springFactor(p:MachinePart):number{return factor(p.custom?.spring,"soft","firm",.65,1.45);}
export function thrustForce(p:MachinePart):number{return RULES.thrustPerEngine*factor(p.custom?.power,"low","high",.7,1.3);}
export function gyroFactor(p:MachinePart):number{return factor(p.custom?.power,"low","high",.65,1.35);}
export function wingArea(p:MachinePart):number{return AIR.wingArea*factor(p.custom?.area,"small","large",.7,1.3);}
export function balloonLift(p:MachinePart):number{return AIR.balloonLift*factor(p.custom?.lift,"low","high",.7,1.3);}
export function partMass(p:MachinePart,base:number):number{
  if(p.kind==="wheel")return base*(wheelRadius(p)/RULES.wheelRadius)**2;
  if(p.kind==="wing")return base*wingArea(p)/AIR.wingArea;
  return base*factor(p.custom?.grade,"light","heavy",p.kind==="ballast"?.5:.65,p.kind==="ballast"?1.75:1.5);
}
export function partLesson(p:MachinePart,baseMass:number):{question:string;hint:string;facts:string[]}{
  const facts=[`질량 ${partMass(p,baseMass).toFixed(1)} kg`];
  if(p.kind==="wheel"){facts.push(`반지름 ${wheelRadius(p).toFixed(2)} m`,`접지력 ${wheelGrip(p).toFixed(2)}`,`스프링 ${(RULES.suspensionStiffness*springFactor(p)).toFixed(1)}`);return{question:"큰 바퀴가 항상 출발도 빠를까요?",hint:"같은 모터 토크에서는 바퀴가 커지면 땅을 미는 힘이 줄어요. 크기나 접지력 하나만 바꾸고 같은 길에서 비교해 보세요.",facts};}
  if(p.kind==="thruster"){facts.push(`추력 ${thrustForce(p).toFixed(0)} N`);return{question:"추진기를 한쪽에만 달면 어떻게 될까요?",hint:"같은 힘도 무게중심에서 멀리 작용하면 기계를 더 크게 돌려요. 방향과 위치를 바꾸어 비교해 보세요.",facts};}
  if(p.kind==="wing"){facts.push(`면적 ${wingArea(p).toFixed(2)} m²`);return{question:"날개를 넓히면 천천히 가도 뜰까요?",hint:"날개 면적과 바람의 방향이 힘을 바꿔요. 넓은 날개는 질량과 공기저항도 늘어나요.",facts};}
  if(p.kind==="balloon"){facts.push(`부력 ${balloonLift(p).toFixed(0)} N`);return{question:"기구 하나로 이 기계가 뜰 수 있을까요?",hint:"위로 미는 부력과 아래로 당기는 무게를 비교해 보세요. 무게추를 더하면 결과가 달라져요.",facts};}
  if(p.kind==="gyro"){facts.push(`제어 세기 ×${gyroFactor(p).toFixed(2)}`);return{question:"기울어진 기계를 다잡는 힘을 바꾸면?",hint:"자이로의 회전 제어와 감쇠가 달라져요. 수동 조작과 조작 보조를 각각 비교해 보세요.",facts};}
  return{question:"같은 부품을 낮게 달면 더 안정적일까요?",hint:"무거운 부품의 위치가 무게중심을 바꿔요. 한 번에는 재료 무게나 위치 하나만 바꾸어 시험해 보세요.",facts};
}
