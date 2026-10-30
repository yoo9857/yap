// Verify the registered source/runtime assets without changing them.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const catalog=JSON.parse(fs.readFileSync(path.join(root,'assets/catalog.json'),'utf8'));
const ids=new Set(),problems=[];let paths=0,mirrors=0;
const resolve=relative=>{const absolute=path.resolve(root,relative);if(!absolute.startsWith(root+path.sep))throw new Error('Asset path escapes project: '+relative);return absolute;};
const hash=p=>createHash('sha256').update(fs.readFileSync(resolve(p))).digest('hex');
for(const entry of catalog.entries){
 if(ids.has(entry.id))problems.push('Duplicate id: '+entry.id);ids.add(entry.id);
 for(const file of entry.files){paths++;if(!fs.existsSync(resolve(file.path)))problems.push('Missing '+entry.id+': '+file.path);}
 for(const pair of entry.mirrors??[]){mirrors++;if(hash(pair.source)!==hash(pair.runtime))problems.push('Export/runtime differ: '+entry.id);}
}
const itemPath='assets/items/tools/pickaxe-basic/item.json',item=JSON.parse(fs.readFileSync(resolve(itemPath),'utf8'));
const glb=fs.readFileSync(resolve('apps/client/public'+item.modelUrl));
if(glb.toString('utf8',0,4)!=='glTF'||glb.readUInt32LE(8)!==glb.length)problems.push('Invalid item GLB header');
const json=JSON.parse(glb.toString('utf8',20,20+glb.readUInt32LE(12)));
for(const node of [item.grip.node,'Impact_Left','Impact_Right'])if(!json.nodes.some(n=>n.name===node))problems.push('Missing item node: '+node);
const meshes=json.meshes.flatMap(m=>m.primitives);if(meshes.length!==1)problems.push('Pickaxe should use one primitive');
if(json.images.some(i=>i.uri))problems.push('Runtime pickaxe has external images');
for(const primitive of meshes)if(primitive.attributes.TEXCOORD_0===undefined)problems.push('Pickaxe UV missing');
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log('Asset catalog OK: '+ids.size+' groups, '+paths+' paths, '+mirrors+' identical export/runtime mirror, embedded item textures and grip nodes.');
