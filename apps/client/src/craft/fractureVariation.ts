/** A fixed seed keeps one block's damage stable across frames, cancellation and template eviction. */
export const FRACTURE_VARIANTS=32;
const mix=(value:number):number=>{value=Math.imul(value^(value>>>16),0x7feb352d);value=Math.imul(value^(value>>>15),0x846ca68b);return (value^(value>>>16))>>>0;};
export function fractureVariant(cell:readonly [number,number,number],block:number,shape:number,salt=0):{variant:number;seed:number} {
 let hash=mix(block^Math.imul(shape,0x9e3779b1));
 for(const coordinate of cell)hash=mix(hash^mix(coordinate|0));
 const variant=(hash%FRACTURE_VARIANTS+(salt>>>0)%FRACTURE_VARIANTS)%FRACTURE_VARIANTS;
 return {variant,seed:mix(7249^Math.imul(variant+1,0x9e3779b1))};
}
/** Independent streams are used for topology and motion, so timing edits do not reshuffle the mesh. */
export function fractureRandom(seed:number):()=>number {
 return ()=>{seed=(seed+0x6d2b79f5)|0;let value=Math.imul(seed^(seed>>>15),1|seed);value^=value+Math.imul(value^(value>>>7),61|value);return ((value^(value>>>14))>>>0)/4294967296;};
}
