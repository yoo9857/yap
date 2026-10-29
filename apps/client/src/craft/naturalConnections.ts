import type {NaturalWorldCell} from "./connectedNaturalGeometry.js";
import type {NaturalBlockKey} from "./naturalBlockGeometry.js";
export const NATURAL_CONNECTION_CASES=[
 {key:"vertical",name:"위·아래 연결"},{key:"horizontal",name:"좌·우 연결"},{key:"depth",name:"앞·뒤 연결"},
 {key:"stairs",name:"계단 단차"},{key:"inside",name:"안쪽 모서리"},{key:"six-way",name:"6방향 교차"},
 {key:"arch",name:"아치·아랫면"},{key:"courtyard",name:"속이 빈 안쪽 코너"},{key:"mixed",name:"서로 다른 재료"}
] as const;
export function connectionCase(key:string,material:NaturalBlockKey="grass"):NaturalWorldCell[] {
 let points:readonly (readonly [number,number,number])[]=[];
 if(key==="vertical")points=[[0,0,0],[0,1,0],[0,2,0]];
 if(key==="horizontal")points=[[0,0,0],[1,0,0],[2,0,0]];
 if(key==="depth")points=[[0,0,0],[0,0,1],[0,0,2]];
 if(key==="stairs")points=[[0,0,0],[1,0,0],[2,0,0],[1,1,0],[2,1,0],[2,2,0]];
 if(key==="inside")points=[[0,0,0],[1,0,0],[0,0,1],[1,0,1],[0,1,1],[1,1,0],[1,1,1]];
 if(key==="six-way")points=[[0,1,0],[-1,1,0],[1,1,0],[0,0,0],[0,2,0],[0,1,-1],[0,1,1]];
 if(key==="arch")points=[[0,0,0],[2,0,0],[0,1,0],[2,1,0],[0,2,0],[1,2,0],[2,2,0]];
 if(key==="courtyard")points=[[0,0,0],[1,0,0],[2,0,0],[0,0,1],[2,0,1],[0,0,2],[1,0,2],[2,0,2]];
 if(key==="mixed"){
  const cells:NaturalWorldCell[]=[];for(let x=0;x<3;x++)for(let z=0;z<2;z++){cells.push({x,y:0,z,key:"dirt"},{x,y:1,z,key:x===2?"snow":"grass"});}cells.push({x:1,y:2,z:0,key:"diamond-block"});return cells;
 }
 return points.map(([x,y,z])=>({x,y,z,key:material}));
}

