import type { ClassEdit, ClassFurniture } from "./protocol/classroom.js";
export { FIRE_CAMPUS } from "./fireCampusGeometry.js";
// Legacy catalog ids retained for map migration and catalog checks. The school itself is Blender geometry.
export const FIRE_SCHOOL_BLOCKS = { OAK_PLANKS:12, STONE_BRICKS:13, GLASS:14, GLOWSTONE:15, WHITE_WOOL:29, YELLOW_WOOL:31, BLACK_WOOL:37, RED_BRICKS:40, SANDSTONE:41, GRAVEL:44, BIRCH_PLANKS:47 } as const;
export type FireStationKind = "alarm" | "phone" | "extinguisher" | "towel" | "sign";

export interface FireStation {
  kind: FireStationKind;
  /** The air cell the prop sits in. */
  cell: [number, number, number];
  /** Which way it faces, as a furniture `rot` (0 = +z south, 1 = +x east, 2 = north, 3 = west). */
  rot: number;
  /** What a look ray must cross to aim at it: [minX, minY, minZ, maxX, maxY, maxZ]. */
  box: [number, number, number, number, number, number];
}

export interface FireSpot {
  id: string;
  /** The fire's base (where an extinguisher is aimed). */
  at: [number, number, number];
  /** Flame size (1 = a waste-bin fire about a metre tall). */
  size: number;
  /** A small fire a child puts out; the others are too big and mean "leave". */
  small: boolean;
}

/** An axis-aligned zone: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type FireZone = [number, number, number, number, number, number];

export interface FireSchool {
  edits: ClassEdit[];
  furniture: ClassFurniture[];
  /** Feet positions to arrive at (the classroom's free floor), facing `spawnYaw`. */
  spawns: [number, number, number][];
  spawnYaw: number;
  stations: FireStation[];
  fires: FireSpot[];
  /** Where the waste bin stands (the small fire burns in it). */
  bin: [number, number, number];
  /** The burning room: too hot to enter. */
  heat: FireZone;
  fireDoor: FireZone;
  /** Our classroom: where a class waits through the teacher's briefing, and for its team's turn. */
  classroom: FireZone;
  /** The corridor: smoke gathers under its ceiling once the drill reaches the escape. */
  corridor: FireZone;
  /** Smoke hangs from here up (y): crawl under it. */
  smokeFloor: number;
  /** The west half of the corridor, past which the smoke is too thick: the other exit is the way out. */
  thickWest: number;
  /** The way out (east): crossing this x means outside. */
  exitX: number;
  /** Back here after breathing too much smoke (feet). */
  retry: [number, number, number];
  /** The gathering place on the schoolyard: centre x, z and radius. */
  assembly: { x: number; y?: number; z: number; r: number };
  exitZone: FireZone;
  escapeRoute: [number, number, number][];
  classroomDoor: [number, number, number];
  obstacles: {min:[number,number,number];max:[number,number,number];name:string}[];
  /** Exit signs (drawn only): position and the furniture `rot` they face; `hanging` ones are
   *  read from both sides. */
  signs: { at: [number, number, number]; rot: number; mount: {kind: "ceiling" | "post"; y: number} }[];
  /** The whole footprint with a margin, for "is this cell the school's?" */
  bounds: { x0: number; x1: number; z0: number; z1: number };
}

let cached:FireSchool|null=null;
/** One shared scenario for the web, Android and classroom server. Metres, absolute Y-up coordinates. */
export function fireSchool():FireSchool{return cached??=build();}
function build():FireSchool{
  const floor=8.4;
  // Remove the flat field's top only: the imported campus owns its visible ground and precise floors.
  const edits:ClassEdit[]=[];
  for(let x=-39;x<39;x++)for(let z=-35;z<35;z++)edits.push([x,3,z,0,0]);
  const spawns:[number,number,number][]=[];
  for(const z of [-7.4,-8.2,-9])for(let i=0;i<9;i++)spawns.push([-13+i*.95,floor,z]);
  const wall=(kind:FireStationKind,x:number):FireStation=>({kind,cell:[x-.5,floor+1,-6.57],rot:0,box:[x-.45,floor+.8,-6.5,x+.45,floor+2,-5.55]});
  const stations:FireStation[]=[wall("alarm",-11.8),wall("phone",-9.2),
    {kind:"extinguisher",cell:[-14.95,floor,-6.565],rot:0,box:[-14.9,floor,-6.5,-14,floor+1.25,-5.45]},
    {kind:"towel",cell:[5,floor+1.07,-3.22],rot:2,box:[4.8,floor,-3.4,6.2,floor+2,-2.1]},
    {kind:"sign",cell:[3.135,floor+2,-9.3],rot:3,box:[3.4,floor+2.1,-9.35,4.1,floor+2.9,-8.25]}];
  const propBounds={alarm:[-.23,.19,-.49,.23,1.08,-.34],phone:[-.18,.075,-.49,.21,.76,-.32],extinguisher:[-.26,0,-.51,.26,1.55,-.08],towel:[-.28,-.095,-.51,.28,1.335,.04],sign:[-.46,.32,-.48,.46,.68,-.4]} as const;
  const mounted=stations.map(s=>{
    const b=propBounds[s.kind],a=s.rot*Math.PI/2,co=Math.cos(a),si=Math.sin(a);
    const points=[b[0],b[3]].flatMap(x=>[b[2],b[5]].map(z=>[s.cell[0]+.5+x*co+z*si,s.cell[2]+.5-x*si+z*co]));
    return {name:"Fire station "+s.kind,min:[Math.min(...points.map(p=>p[0]!)),s.cell[1]+b[1],Math.min(...points.map(p=>p[1]!))] as [number,number,number],max:[Math.max(...points.map(p=>p[0]!)),s.cell[1]+b[4],Math.max(...points.map(p=>p[1]!))] as [number,number,number]};
  });
  const bin:[number,number,number]=[-20.7,floor,-4.8];
  return {edits,furniture:[],spawns,spawnYaw:0,stations,bin,
    fires:[{id:"bin",at:[-20.2,floor+.58,-4.3],size:1,small:true},
      {id:"bench-1",at:[-21.4,floor+.9,-13.2],size:2.4,small:false},
      {id:"bench-2",at:[-17.8,floor+.9,-16.2],size:2,small:false},
      {id:"corner",at:[-22.3,floor,-19.5],size:2.6,small:false},
      {id:"floor",at:[-19,floor,-9.4],size:1.6,small:false}],
    heat:[-23.85,floor,-21.85,-14.4,12.7,-6.85],
    fireDoor:[-16.99,floor,-6.84,-15.01,floor+2.96,-6.56],
    classroom:[-14.1,floor,-21.85,-4.35,12.52,-6.85],
    corridor:[-23.85,floor,-6.55,23.85,12.52,-2.15],smokeFloor:floor+1.25,thickWest:-22.8,
    exitX:4.1,exitZone:[-4.05,3.8,-1.5,4.05,7,2.5],retry:[-5,floor,-4.1],
    assembly:{x:0,y:4.15,z:17,r:2.5},
    classroomDoor:[-6.1,8.4,-6.25],
    escapeRoute:[[.4,8.4,-10.2],[.4,6.2,-16.4],[-2.4,6.2,-16.4],[-2.4,4,-10.2],[0,4,-.6]],
    obstacles:[...mounted,{name:"Drill sink",min:[4.8,floor,-3.25],max:[6.2,floor+.9,-2.1]},
      {name:"Fire bin",min:[-20.5,floor,-4.6],max:[-19.9,floor+.56,-4]}],
    signs:[{at:[.4,11.5,-9.2],rot:2,mount:{kind:"ceiling",y:12.76}},
      {at:[-1,8.65,-17.4],rot:0,mount:{kind:"post",y:6.2}},
      {at:[-2.4,6.7,-10],rot:0,mount:{kind:"ceiling",y:8.12}},
      {at:[0,6.8,-1.8],rot:0,mount:{kind:"ceiling",y:7.61}},
      {at:[-11,11.6,-4.2],rot:1,mount:{kind:"ceiling",y:12.76}},
      {at:[9,11.6,-4.2],rot:3,mount:{kind:"ceiling",y:12.76}}],
    bounds:{x0:-40,x1:40,z0:-36,z1:36}};
}
/** From the current floor to the next real stair landing (no arrow through a slab). */
export function fireEscapeTarget(x:number,y:number,z:number):readonly[number,number,number]{
  const r=fireSchool().escapeRoute;
  if(y>7.6)return z>-11.05?r[0]!:r[1]!;
  if(y>5.9)return z< -15.1&&x> -1.5?r[2]!:x> -1.0?r[1]!:r[3]!;
  return y>4.35?r[3]!:r[4]!;
}
export function inFireZone(zone:FireZone,x:number,y:number,z:number):boolean{return x>=zone[0]&&x<zone[3]&&y>=zone[1]&&y<zone[4]&&z>=zone[2]&&z<zone[5];}
