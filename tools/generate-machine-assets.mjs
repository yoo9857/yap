// Blender source lives in assets/machines/block-kit-v2/source/.
// CI syncs/checks the reviewed canonical exports without requiring Blender.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),source=path.join(root,"assets/machines/block-kit-v2/runtime"),target=path.join(root,"apps/client/public/models/machines"),check=process.argv.includes("--check");
const manifest=JSON.parse(fs.readFileSync(path.join(source,"manifest.json"),"utf8"));
const hash=b=>createHash("sha256").update(b).digest("hex");
for(const entry of manifest.files){
 const bytes=fs.readFileSync(path.join(source,entry.file));
 if(bytes.toString("utf8",0,4)!=="glTF"||bytes.readUInt32LE(8)!==bytes.length||hash(bytes)!==entry.sha256)throw Error("Invalid canonical export: "+entry.file);
 const json=JSON.parse(bytes.toString("utf8",20,20+bytes.readUInt32LE(12)));
 if(json.images?.some(image=>image.uri))throw Error("Machine textures must be embedded");
 if(entry.parts.length!==8||entry.parts.some(p=>!p.triangles||p.triangles>16000))throw Error("Machine module budget invalid");
 if(check){if(!fs.readFileSync(path.join(target,entry.file)).equals(bytes))throw Error("Stale runtime export "+entry.file);}
 else{fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,entry.file),bytes);}
 console.log(`${check?"Verified":"Synced"} ${entry.file}: ${(bytes.length/1024).toFixed(0)} KB, ${entry.parts.reduce((n,p)=>n+p.triangles,0)} triangles`);
}
const manifestBytes=JSON.stringify(manifest,null,2)+"\n";
if(check){if(fs.readFileSync(path.join(target,"manifest.json"),"utf8")!==manifestBytes)throw Error("Stale machine manifest");}
else fs.writeFileSync(path.join(target,"manifest.json"),manifestBytes);
