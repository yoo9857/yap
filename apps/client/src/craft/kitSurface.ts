import * as THREE from "three";
/** Seamless pigment and mould grain, in linear technical maps and sRGB colour. */
export interface KitSurfaceMaps {albedo:THREE.DataTexture;normal:THREE.DataTexture;roughness:THREE.DataTexture}
const hash=(x:number,y:number):number=>{let h=Math.imul(x+19,374761393)^Math.imul(y+47,668265263);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967295;};
export function createKitSurfaceMaps(size=256):KitSurfaceMaps {
  const albedo=new Uint8Array(size*size*4),normal=new Uint8Array(size*size*4),roughness=new Uint8Array(size*size*4),height=new Float32Array(size*size);
  const smooth=(x:number,y:number):number=>{
    const g=16,px=x/size*g,py=y/size*g,ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy;
    const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy),h=(a:number,b:number)=>hash((a+g)%g,(b+g)%g);
    return (h(ix,iy)*(1-sx)+h(ix+1,iy)*sx)*(1-sy)+(h(ix,iy+1)*(1-sx)+h(ix+1,iy+1)*sx)*sy;
  };
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=y*size+x,h=hash(x,y),fine=hash(x%32,y%32),line=Math.sin(x*Math.PI/8)*Math.sin(y*Math.PI/8);
    height[i]=.5+(h-.5)*.17+(fine-.5)*.055+line*.02+(smooth(x,y)-.5)*.13;
    const pigment=Math.round(236+(h-.5)*12+(smooth(x,y)-.5)*28+(fine-.5)*4);
    albedo.set([pigment,pigment,pigment,255],i*4);
    roughness.set([255,Math.round(185+(h-.5)*35+(smooth(x,y)-.5)*42+line*8),0,255],i*4);
  }
  const at=(x:number,y:number)=>height[((y+size)%size)*size+(x+size)%size]!;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const dx=(at(x-1,y)-at(x+1,y))*.7,dy=(at(x,y-1)-at(x,y+1))*.7,l=Math.hypot(dx,dy,1);
    normal.set([Math.round((dx/l*.5+.5)*255),Math.round((dy/l*.5+.5)*255),Math.round((1/l*.5+.5)*255),255],(y*size+x)*4);
  }
  const texture=(data:Uint8Array,name:string,srgb=false)=>{const t=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);t.name=name;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.needsUpdate=true;return t;};
  return {albedo:texture(albedo,"CraftYap coat colour",true),normal:texture(normal,"CraftYap mould grain normal"),roughness:texture(roughness,"CraftYap packed roughness metalness")};
}
/** Do not mutate the registry texture: terrain and construction may use different wrapping. */
export function repeatingKitTexture(source:THREE.Texture):THREE.Texture {const map=source.clone();map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=4;map.needsUpdate=true;return map;}
export function disposeKitSurfaceMaps(maps:KitSurfaceMaps):void {maps.albedo.dispose();maps.normal.dispose();maps.roughness.dispose();}

