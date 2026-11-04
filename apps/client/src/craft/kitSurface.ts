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
/**
 * The catalog tiles are drawn as framed icons: a 3–7 px near-black border on every side (the
 * width differs per image). Repeated across joined blocks, that frame becomes a thick black grid
 * line every metre, so a wall the shell geometry merged into one piece still reads as separate
 * tiles. The world draws the tile without it; the hotbar/bag icons keep it.
 *
 * The frame is MEASURED per side (columns/rows much darker than the tile's inside), never
 * assumed, and cropped with one extra pixel for its anti-aliased edge. One cropped copy per
 * source texture; callers clone it for their own wrapping (clones share the upload).
 */
const frameless=new WeakMap<THREE.Texture,THREE.Texture>(),framelessInked=new WeakMap<THREE.Texture,THREE.Texture>();
export function framelessTile(source:THREE.Texture,keepInk=false):THREE.Texture {
  const cache=keepInk?framelessInked:frameless,cached=cache.get(source);if(cached)return cached;
  const result=buildFrameless(source,keepInk);cache.set(source,result);return result;
}
function buildFrameless(source:THREE.Texture,keepInk:boolean):THREE.Texture {
  const image=source.image as CanvasImageSource&{width:number;height:number}|undefined;
  const w=image?.width??0,h=image?.height??0;
  if(!image||w<16||h<16||typeof document==="undefined")return source;
  try{
    const probe=document.createElement("canvas");probe.width=w;probe.height=h;
    const g=probe.getContext("2d",{willReadFrequently:true});if(!g)return source;
    g.drawImage(image,0,0);const d=g.getImageData(0,0,w,h).data;
    const lum=(x:number,y:number)=>{const i=(y*w+x)*4;return .3*d[i]!+.59*d[i+1]!+.11*d[i+2]!;};
    const line=(i:number,vertical:boolean)=>{let sum=0,n=0;const len=vertical?h:w;for(let j=Math.floor(len/4);j<Math.ceil(len*3/4);j++){sum+=vertical?lum(i,j):lum(j,i);n++;}return sum/n;};
    let inside=0;for(let i=Math.floor(w/4);i<Math.ceil(w*3/4);i+=4)inside+=line(i,true);inside/=Math.ceil(w/8);
    const limit=Math.floor(Math.min(w,h)*.1),dark=Math.max(18,inside*.45);
    const depth=(at:(i:number)=>number)=>{let i=0;while(i<limit&&at(i)<dark)i++;return i===0?0:Math.min(limit,i+1);};
    const left=depth(i=>line(i,true)),right=depth(i=>line(w-1-i,true)),top=depth(i=>line(i,false)),bottom=depth(i=>line(h-1-i,false));
    if(left+right+top+bottom===0)return source;
    // the frameless inside, then made to wrap: a doodle tile was never drawn to repeat, and some carry
    // a second ring just inside the frame — cropping alone left a faint line at every tile boundary
    const cw=w-left-right,ch=h-top-bottom;
    const inner=document.createElement("canvas");inner.width=cw;inner.height=ch;
    const ig=inner.getContext("2d",{willReadFrequently:true})!;ig.drawImage(image,left,top,cw,ch,0,0,cw,ch);
    const seamless=wrapSeamless(ig.getImageData(0,0,cw,ch)),wrapped=keepInk?seamless:removeInk(seamless);
    const flat=document.createElement("canvas");flat.width=wrapped.width;flat.height=wrapped.height;flat.getContext("2d")!.putImageData(new ImageData(wrapped.data,wrapped.width,wrapped.height),0,0);
    const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
    const cg=canvas.getContext("2d")!;cg.imageSmoothingQuality="high";cg.drawImage(flat,0,0,w,h);
    const tile=new THREE.CanvasTexture(canvas);tile.name=`${source.name||"tile"} (frameless)`;tile.colorSpace=source.colorSpace;
    tile.wrapS=tile.wrapT=THREE.RepeatWrapping;tile.anisotropy=4;tile.needsUpdate=true;
    return tile;
  }catch{return source;} // a tainted/odd image keeps its frame rather than failing
}
/**
 * Make an image tile without a seam: a margin `m` at each edge is cross-faded with the matching strip
 * from the far side and the far strip dropped, so the last column sits next to its own original
 * neighbour when the texture wraps. (The classic offset-and-blend; output is `m` smaller per axis.)
 */
export interface Pixels {width:number;height:number;data:Uint8ClampedArray}
export function wrapSeamless(src:Pixels,fraction=.12):Pixels {
  const pass=(img:Pixels,horizontal:boolean):Pixels=>{
    const w=img.width,h=img.height,len=horizontal?w:h,m=Math.max(1,Math.round(len*fraction)),out=len-m;
    const ow=horizontal?out:w,oh=horizontal?h:out,dst={width:ow,height:oh,data:new Uint8ClampedArray(ow*oh*4)},a=img.data,b=dst.data;
    for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){
      const i=horizontal?x:y,o=(y*ow+x)*4,s1=(y*w+x)*4;
      if(i>=m){for(let c=0;c<4;c++)b[o+c]=a[s1+c]!;continue;}
      const t=i/m,s2=horizontal?(y*w+x+out)*4:((y+out)*w+x)*4;
      for(let c=0;c<4;c++)b[o+c]=Math.round(a[s2+c]!*(1-t)+a[s1+c]!*t);
    }
    return dst;
  };
  return pass(pass(src,true),false);
}
/**
 * Lift the tile art's own ink lines (stone outlines, mortar, plank gaps) into the colour around them,
 * so a wall reads as soft material rather than a drawing of one. Dark = under half the tile's mean
 * luminance; each dark pixel is replaced by the average of the NON-dark pixels within `radius`
 * (wrapping, so a repeated tile stays seamless), shaded a little so the shape still shows. Box sums
 * over a mask: O(pixels) per tile, cheap enough to run as each texture arrives.
 */
export function removeInk(src:Pixels,radius=7):Pixels {
  const {width:w,height:h,data:d}=src,n=w*h,lum=(i:number)=>.3*d[i*4]!+.59*d[i*4+1]!+.11*d[i*4+2]!;
  let total=0;for(let i=0;i<n;i++)total+=lum(i);const mean=total/n;
  // masked colour + count, box-summed separably with wrap
  const acc=new Float32Array(n*4);
  for(let i=0;i<n;i++){if(lum(i)<mean*.5)continue;acc[i*4]=d[i*4]!;acc[i*4+1]=d[i*4+1]!;acc[i*4+2]=d[i*4+2]!;acc[i*4+3]=1;}
  const blur=(a:Float32Array,horizontal:boolean):Float32Array=>{
    const out=new Float32Array(n*4),len=horizontal?w:h,lines=horizontal?h:w,run=new Float32Array(4);
    for(let line=0;line<lines;line++){
      const at=(k:number)=>(horizontal?line*w+((k%w)+w)%w:(((k%h)+h)%h)*w+line)*4;
      run.fill(0);for(let k=-radius;k<=radius;k++){const j=at(k);for(let c=0;c<4;c++)run[c]=run[c]!+a[j+c]!;}
      for(let k=0;k<len;k++){const o=at(k);for(let c=0;c<4;c++)out[o+c]=run[c]!;const add=at(k+radius+1),sub=at(k-radius);for(let c=0;c<4;c++)run[c]=run[c]!+a[add+c]!-a[sub+c]!;}
    }
    return out;
  };
  const sum=blur(blur(acc,true),false),out={width:w,height:h,data:new Uint8ClampedArray(d)},q=out.data;
  for(let i=0;i<n;i++){
    const t=Math.max(0,Math.min(1,(mean*.62-lum(i))/(mean*.5))),k=sum[i*4+3]!;if(t<=0||k<=0)continue;
    for(let c=0;c<3;c++)q[i*4+c]=d[i*4+c]!*(1-t)+(sum[i*4+c]!/k)*.9*t;
  }
  return out;
}
/** Tiles whose dark parts ARE the picture (coal, a face, a firebox, cracks): their ink stays. */
export const KEEP_INK=new Set(["coal-ore","question-block","pumpkin","furnace-front","cracked-stone-bricks","workbench-top","chest-front"]);
/** Do not mutate the registry texture: terrain and construction may use different wrapping. */
export function repeatingKitTexture(source:THREE.Texture,keepInk=false):THREE.Texture {const map=framelessTile(source,keepInk).clone();map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=4;map.needsUpdate=true;return map;}
export function disposeKitSurfaceMaps(maps:KitSurfaceMaps):void {maps.albedo.dispose();maps.normal.dispose();maps.roughness.dispose();}

