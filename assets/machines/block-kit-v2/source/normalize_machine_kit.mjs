// Canonicalize Blender's hierarchy to immutable, origin-baked runtime parts.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const projectRequire=createRequire(path.join(process.env.CRAFTYAP_REPO??'C:/craftyap','apps/client/package.json'));
const module=async name=>import(pathToFileURL(projectRequire.resolve(name)).href);
const T=await import(pathToFileURL(projectRequire.resolve('three').replace(/three\.cjs$/,'three.module.js')).href),{GLTFLoader}=await module('three/addons/loaders/GLTFLoader.js'),{GLTFExporter}=await module('three/addons/exporters/GLTFExporter.js'),{mergeGeometries,mergeVertices}=await module('three/addons/utils/BufferGeometryUtils.js');
const require=createRequire(import.meta.url),assetModules=process.env.CRAFTYAP_ASSET_MODULES??path.join(process.env.USERPROFILE??process.env.HOME??'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const assetModule=name=>{try{return projectRequire(name);}catch{return require(path.join(assetModules,name));}};
const sharp=assetModule('sharp'),canvas=assetModule('@napi-rs/canvas');
class Reader{result=null;onloadend=null;readAsArrayBuffer(b){b.arrayBuffer().then(v=>{this.result=v;this.onloadend?.();});}readAsDataURL(b){b.arrayBuffer().then(v=>{this.result='data:'+b.type+';base64,'+Buffer.from(v).toString('base64');this.onloadend?.();});}}
globalThis.FileReader=Reader;globalThis.ImageData=canvas.ImageData;globalThis.OffscreenCanvas=class{constructor(w,h){const c=canvas.createCanvas(w,h);c.toBlob=(cb,mime)=>cb(new Blob([c.toBuffer(mime)],{type:mime}));return c;}};
const out=path.resolve(process.argv[2]??'outputs/CraftYap_vehicle_blocks_2026-11-03'),names=['frame','cockpit','ballast','wheel','thruster','gyro','wing','balloon'];
const manifest={version:2,kitVersion:'2.0.0',source:'assets/machines/block-kit-v2/source/CraftYap_MachineKit_v2.blend',builder:'assets/machines/block-kit-v2/source/build_machine_kit.py',provenance:'Original Blender geometry, UVs and packed material maps for CraftYap',units:'metres',up:'+Y',forward:'+Z',wheelAxis:'+X',cellSize:1,roles:['body','studs','wheel-fixed','wheel-strut','wheel-hub'],files:[]};
for(const low of [false,true]){
 const loader=new GLTFLoader();loader.register(parser=>({name:'NODE_TEXTURES',loadTexture:async i=>{const textureDef=parser.json.textures[i],image=parser.json.images[textureDef.source],bytes=await parser.getDependency('bufferView',image.bufferView),{data,info}=await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({resolveWithObject:true}),texture=new T.DataTexture(new Uint8Array(data),info.width,info.height,T.RGBAFormat);texture.flipY=false;texture.generateMipmaps=true;texture.minFilter=T.LinearMipmapLinearFilter;texture.magFilter=T.LinearFilter;texture.needsUpdate=true;return texture;}}));
 const raw=fs.readFileSync(out+'/runtime/machine-kit'+(low?'-lod1':'')+'-raw.glb'),g=await loader.parseAsync(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),'');g.scene.updateMatrixWorld(true);
 const roots=new Map();g.scene.traverse(o=>{if(o.userData.machinePart)roots.set(o.userData.machinePart,o);});const scene=new T.Scene(),reports=[];
 for(const name of names){
  const root=roots.get(name);if(!root)throw Error('Missing Blender module '+name);const group=new T.Group();group.name=name;group.userData.machinePart=name;group.userData.kitVersion='2.0.0';const buckets=new Map();
  root.traverse(o=>{if(!o.isMesh)return;if(Array.isArray(o.material))throw Error('Unexpected multi material source');const role=o.userData.machineRole??'body',key=role+'|'+o.material.name;
   const geo=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();geo.applyMatrix4(o.matrixWorld);geo.deleteAttribute('tangent');
   if(!geo.getAttribute('uv'))geo.setAttribute('uv',new T.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count*2),2));
   for(const a of Object.keys(geo.attributes))if(!['position','normal','uv'].includes(a))geo.deleteAttribute(a);
   let b=buckets.get(key);if(!b){b={role,material:o.material,geometries:[]};buckets.set(key,b);}b.geometries.push(geo);
  });
  let triangles=0;const roles={};
  for(const [key,b]of [...buckets].sort(([a],[b])=>a.localeCompare(b))){
   const merged=mergeGeometries(b.geometries,false);if(!merged)throw Error('Cannot merge '+key);const geometry=mergeVertices(merged,1e-5);geometry.computeBoundingBox();geometry.computeBoundingSphere();const m=new T.Mesh(geometry,b.material);m.name=name+'/'+key;m.userData.machineRole=b.role;group.add(m);const n=geometry.index.count/3;triangles+=n;roles[b.role]=(roles[b.role]??0)+n;
   if(b.material.transparent){b.material.depthWrite=false;b.material.forceSinglePass=true;}
   for(const geo of b.geometries)geo.dispose();merged.dispose();
  }
  group.updateMatrixWorld(true);const bounds=new T.Box3().setFromObject(group),size=bounds.getSize(new T.Vector3());
  if(triangles>16000||![...bounds.min,...bounds.max].every(Number.isFinite)||Math.max(...size)>1.45)throw Error('Module budget/bounds '+name+' '+JSON.stringify({triangles,size:size.toArray()}));
  if(name==='frame'&&(size.y<.9||size.x<.95))throw Error('Wrong up axis or missing complete chassis');
  reports.push({part:name,triangles,primitives:group.children.length,size:size.toArray().map(n=>+n.toFixed(4)),roles});scene.add(group);
 }
 const bytes=Buffer.from(await new GLTFExporter().parseAsync(scene,{binary:true,onlyVisible:true})),file='machine-kit'+(low?'-lod1':'')+'.glb';
 const json=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12))),rootNames=json.scenes[json.scene??0].nodes.map(i=>json.nodes[i].name).sort();
 if(JSON.stringify(rootNames)!==JSON.stringify([...names].sort()))throw Error('Runtime must expose eight direct module roots');
 fs.writeFileSync(out+'/runtime/'+file,bytes);manifest.files.push({file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),parts:reports});
 console.log(JSON.stringify({file,bytes:bytes.length,triangles:reports.reduce((n,p)=>n+p.triangles,0),parts:reports.map(p=>({part:p.part,primitives:p.primitives,size:p.size}))}));
}
fs.writeFileSync(out+'/runtime/manifest.json',JSON.stringify(manifest,null,2)+'\n');
