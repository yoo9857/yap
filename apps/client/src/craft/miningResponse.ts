export type FracturePattern="stone"|"wood"|"metal"|"snow"|"granular"|"gem"|"glass"|"soft";
export interface MiningResponse {
 pattern:FracturePattern;grain:"x"|"y";grid:readonly [number,number,number];metric:readonly [number,number,number];
 opening:number;openAt:number;chipAt:readonly [number,number];gravity:number;scatter:number;spin:number;drag:number;bounce:number;life:number;stagger:number;compression:number;dent:number;
}
/** Artistic responses share geometry/collision infrastructure but have different failure mechanics. */
export function miningResponse(family:string,key=family):MiningResponse {
 const base:MiningResponse={pattern:"stone",grain:"y",grid:[3,2,2],metric:[1,1,1],opening:.022,openAt:0,chipAt:[.48,.76],gravity:10.5,scatter:.42,spin:.8,drag:.25,bounce:.12,life:1.05,stagger:.1,compression:0,dent:0};
 if(family==="wood"){
  const horizontal=/planks|bookshelf/.test(key);
  return {...base,pattern:"wood",grain:horizontal?"x":"y",grid:horizontal?[1,2,3]:[3,1,2],metric:horizontal?[.12,1,1]:[1,.12,1],opening:.023,openAt:.04,chipAt:[.7,.89],gravity:9,scatter:.3,spin:2.7,drag:1.3,life:1.45,stagger:.23};
 }
 if(family==="metal")return {...base,pattern:"metal",grid:[1,1,1],opening:.032,openAt:.64,chipAt:[1.1,1.1],gravity:16,scatter:.2,spin:.55,drag:.8,bounce:.07,life:1.3,stagger:.18,dent:.13};
 if(family==="snow")return {...base,pattern:"snow",grid:[3,2,3],opening:.014,openAt:.12,chipAt:[.35,.6],gravity:5.8,scatter:.22,spin:.45,drag:2.2,bounce:.02,life:1.05,stagger:.05,compression:.1};
 if(family==="sand"||family==="dirt"||family==="grass")return {...base,pattern:"granular",grid:family==="sand"?[3,3,3]:[3,2,2],opening:.021,chipAt:[.4,.68],scatter:.28,spin:.9,bounce:.035,life:.9,stagger:.07};
 if(family==="gem"||family==="ore")return {...base,pattern:"gem",grid:[3,2,3],opening:.024,openAt:.08,chipAt:[.62,.88],gravity:12,scatter:.54,spin:1.6,bounce:.22,stagger:.055};
 if(family==="glass")return {...base,pattern:"glass",grid:[2,4,2],metric:[1,1.8,1],opening:.017,openAt:.02,chipAt:[.56,.83],gravity:11,scatter:.5,spin:1.8,bounce:.04,life:.9,stagger:.035};
 if(family==="wool")return {...base,pattern:"soft",grid:[2,2,2],opening:.009,openAt:.32,chipAt:[.7,.88],gravity:4.5,scatter:.18,spin:.45,drag:2.5,bounce:.01,life:1.15,stagger:.16,compression:.14};
 return base;
}
