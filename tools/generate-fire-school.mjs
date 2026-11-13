// Run with tsx: one scenario shared with the Android training client.
import {writeFileSync,readFileSync} from 'node:fs';
import {fireSchool} from '../packages/shared/src/fireSchool.ts';
const path=new URL('../engine/assets/fire-school/scenario.json',import.meta.url);
const text=JSON.stringify(fireSchool());
if(process.argv.includes('--check')){
 if(readFileSync(path,'utf8')!==text)throw Error('Android fire scenario is stale; run engine:fire-school');
}else writeFileSync(path,text);
console.log('Fire scenario:',fireSchool().spawns.length,'spawns; 2F → stairs → assembly.');
