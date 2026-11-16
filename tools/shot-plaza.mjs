import puppeteer from "puppeteer-core";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
const output=resolve(process.argv[2]??"output/plaza-review");mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true,args:["--no-sandbox","--enable-unsafe-swiftshader","--disable-background-timer-throttling"]});
const errors=[];const page=await browser.newPage();page.on("pageerror",e=>errors.push(e.message));
await page.setViewport({width:1440,height:900});
await page.evaluateOnNewDocument(()=>{localStorage.setItem("robo-name","별빛친구");localStorage.setItem("craftyap.settings",JSON.stringify({graphics:"low",music:0,sfx:0}));});
try {
  await page.goto("http://localhost:5173/",{waitUntil:"networkidle2",timeout:45000});
  await page.click('[data-enter="play"]');await page.click('[data-pick="games"]');
  await new Promise(r=>setTimeout(r,700));await page.screenshot({path:resolve(output,"menu.png")});
  await page.click('[data-mode="plaza"]');
  await page.waitForFunction(()=>window.__roboPlaza?.state().online,{timeout:120000});
  await new Promise(r=>setTimeout(r,1500));
  await page.screenshot({path:resolve(output,"plaza.png")});
  const initial=await page.evaluate(()=>window.__roboPlaza.state());
  await page.mouse.click(700,450);await page.keyboard.down("KeyW");await new Promise(r=>setTimeout(r,1200));await page.keyboard.up("KeyW");
  const moved=await page.evaluate(()=>window.__roboPlaza.state());
  await page.click('[data-id="party-create"]');await page.waitForSelector(".party-dialog");
  await page.screenshot({path:resolve(output,"create-room.png")});
  writeFileSync(resolve(output,"initial-review.json"),JSON.stringify({initial,moved,errors},null,2));
  console.log(JSON.stringify({initial,moved,errors}));
} catch(e) {
  await page.screenshot({path:resolve(output,"failure.png")}).catch(()=>{});
  console.log("BROWSER_ERRORS",JSON.stringify(errors));console.log("BODY",(await page.$eval("body",e=>e.innerText)).slice(-2200));throw e;
} finally {await browser.close();}
