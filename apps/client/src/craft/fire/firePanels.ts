import * as THREE from "three";
import {FireLessonView} from "./fireLessonView.js";
import { t } from "../../ui/i18n.js";

/**
 * The fire drill's two lessons, each a card over the game (the mouse is free while one is up):
 *
 *  - 119: dial the number, then say WHERE and WHAT — the two things a dispatcher needs.
 *  - The extinguisher: pin → aim → squeeze → sweep, each step done by hand on a drawn one.
 *
 * A panel calls `done` only when its lesson was completed; ✕ / Esc close it with nothing learnt.
 */

export type FirePanelKind = "call" | "pass";

export interface FirePanel {
  readonly kind: FirePanelKind;
  /** Take it off the screen (no callback). */
  close(): void;
  /** Dev / E2E: finish the lesson as if every step had been done. */
  solve(): void;
}

function shell(kind: FirePanelKind, title: string, onClose: () => void): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement("div");
  root.className = "fire-panel";
  root.dataset.panel = kind;
  root.innerHTML = `
    <div class="fire-card" role="dialog" aria-label="${title}">
      <button class="fire-x" type="button" aria-label="${t("닫기", "Close")}">✕</button>
      <h2>${title}</h2>
      <div class="fire-body"></div>
    </div>`;
  root.querySelector<HTMLButtonElement>(".fire-x")!.addEventListener("click", onClose);
  document.body.appendChild(root);
  return { root, body: root.querySelector<HTMLElement>(".fire-body")! };
}

// ------------------------------------------------------------------ 119

export function openCallPanel(done: () => void, cancel: () => void): FirePanel {
  const { root, body } = shell("call", t("📞 119에 신고해요", "📞 Call 119"), cancel);
  let dialled = "";
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    body.innerHTML = `
      <p class="fire-big">🚒</p>
      <p class="fire-say">${t("잘했어요! <b>어디에서</b>, <b>무슨 일이</b> 났는지 또박또박 말했어요.<br />소방차가 출발했어요.", "Well done! You said <b>where</b> and <b>what</b>, clearly.<br />The fire engine is on its way.")}</p>
      <button class="fire-cta" type="button" data-id="ok">${t("확인", "OK")}</button>`;
    body.querySelector<HTMLButtonElement>('[data-id="ok"]')!.addEventListener("click", done);
  };

  const ask = () => {
    const choices: { text: string; ok: boolean; why: string }[] = [
      { text: t("“크래프트초등학교 2층 과학실에 불이 났어요!”", "“There's a fire in the science room, second floor of Craft Elementary!”"), ok: true, why: "" },
      { text: t("“불이야!!” 하고 바로 끊어요", "Shout “Fire!!” and hang up"), ok: false, why: t("어디인지 말하지 않으면 소방차가 올 수 없어요. 장소를 꼭 말해요.", "Without the place, the fire engine can't find you. Always say where.") },
      { text: t("“나중에 다시 걸게요”", "“I'll call back later”"), ok: false, why: t("불은 금방 커져요. 지금 바로, 어디에서 불이 났는지 말해요.", "Fire grows fast. Say right now where it is burning.") },
    ];
    // never the right answer first every time
    const order = [1, 0, 2];
    body.innerHTML = `
      <p class="fire-say">${t("“119입니다. 무슨 일이세요?”<br /><b>무엇을 말해야 할까요?</b>", "“119, what's your emergency?”<br /><b>What should you say?</b>")}</p>
      <div class="fire-choices">${order.map((i) => `<button class="fire-choice" type="button" data-i="${i}">${choices[i]!.text}</button>`).join("")}</div>
      <p class="fire-hint" data-id="hint"></p>`;
    const hint = body.querySelector<HTMLElement>('[data-id="hint"]')!;
    body.querySelectorAll<HTMLButtonElement>(".fire-choice").forEach((btn) => btn.addEventListener("click", () => {
      const choice = choices[Number(btn.dataset.i)]!;
      if (choice.ok) { finish(); return; }
      btn.classList.add("wrong");
      btn.disabled = true;
      hint.textContent = choice.why;
    }));
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "📞"];
  body.innerHTML = `
    <p class="fire-say">${t("불이 났을 때 신고하는 번호는 몇 번일까요?<br />번호를 누르고 <b>📞</b>를 눌러요.", "Which number do you call when there is a fire?<br />Dial it, then press <b>📞</b>.")}</p>
    <div class="fire-phone">
      <div class="fire-dial" data-id="dial" aria-live="polite"></div>
      <div class="fire-keys">${keys.map((k) => `<button class="fire-key${k === "📞" ? " call" : ""}" type="button" data-k="${k}">${k}</button>`).join("")}</div>
    </div>
    <p class="fire-hint" data-id="hint"></p>`;
  const dial = body.querySelector<HTMLElement>('[data-id="dial"]')!;
  const hint = body.querySelector<HTMLElement>('[data-id="hint"]')!;
  const press = (k: string) => {
    if (finished || !dial.isConnected) return;
    if (k === "⌫") dialled = dialled.slice(0, -1);
    else if (k === "📞") {
      if (dialled === "119") { ask(); return; }
      hint.textContent = dialled === "112"
        ? t("112는 경찰이에요. 불이 났을 때는 119!", "112 is the police. For a fire, it's 119!")
        : t("화재 신고는 119예요. 다시 눌러 봐요.", "The fire number is 119. Try again.");
      dialled = "";
    } else if (dialled.length < 4) dialled += k;
    dial.textContent = dialled;
  };
  body.querySelectorAll<HTMLButtonElement>(".fire-key").forEach((btn) => btn.addEventListener("click", () => press(btn.dataset.k!)));
  const onKey = (e: KeyboardEvent) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("⌫");
    else if (e.key === "Enter") press("📞");
  };
  document.addEventListener("keydown", onKey);

  return {
    kind: "call",
    close: () => { document.removeEventListener("keydown", onKey); root.remove(); },
    solve: () => { finish(); done(); },
  };
}

// ------------------------------------------------------------------ the extinguisher

export function openPassPanel(done: () => void, cancel: () => void): FirePanel {
 const {root,body}=shell('pass',t('🧯 소화기 연습','🧯 Try the extinguisher'),cancel);
 let step=0,finished=false,holding=false,held=0,last=0,side=0,passes=0,raf=0;
 let squeezeComplete=false;
 const controller=new AbortController(),{signal}=controller;
 const names=[t('확인','Check'),t('핀','Pin'),t('겨냥','Aim'),t('누르기','Squeeze'),t('쓸기','Sweep')];
 const instructions=[t('바늘이 초록색에 있나요?','Is the needle in the green zone?'),t('노란 고리를 옆으로 끌어요','Drag the yellow ring sideways'),t('호스 끝을 불 아래로 끌어요','Drag the nozzle toward the base of the fire'),t('위 손잡이를 꾹 눌러요','Hold the upper handle down'),t('불 아래를 좌우로 쓸어요','Sweep across the base of the fire')];
 const labels=[t('초록색이에요 ✓','It is green ✓'),t('고리를 잡고 옆으로 →','Drag the ring sideways →'),t('호스를 불 쪽으로 끌어요 →','Drag the hose toward the fire →'),t('여기를 꾹 누르세요','Press and hold here'),t('좌우로 움직여요','Move left and right')];
 body.classList.add('fire-child-lesson');
 body.innerHTML=`<div class="fire-child-progress" aria-label="${t('연습 순서','Practice steps')}">${names.map((n,i)=>`<span><b>${i+1}</b>${n}</span>`).join('')}</div>
  <div class="fire-stage fire-model-stage"><div class="fire-model-view"></div><button type="button" class="fire-model-zoom" aria-label="${t('전체 모습과 확대 모습 바꾸기','Switch full and close-up views')}">${t('전체 보기','Full view')}</button></div>
  <div class="fire-child-prompt"><span data-id="count"></span><strong data-id="say" aria-live="polite"></strong><small data-id="hint"></small></div>
  <button type="button" class="fire-child-action" data-id="action"><i></i><span></span><b>☝</b></button>
  <button type="button" class="fire-child-action complete" data-id="continue-sweep" hidden><span>${t('좌우로 뿌려 보기 →','Practise sweeping →')}</span></button>
  <div class="fire-sweep fire-child-sweep" data-id="sweep" tabindex="0" role="slider" aria-label="${t('노즐을 좌우로 움직여요','Move the nozzle side to side')}" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0"><div class="fire-sweep-track"><b>←</b><span>🖐</span><b>→</b></div><small data-id="passes"></small></div>
  <button type="button" class="fire-gesture-help" data-id="help">${t('어려워요 · 천천히 보여 주세요','Help · show me slowly')}</button><p class="fire-child-safety">${t('큰 불이나 많은 연기는 바로 대피해요.','Leave immediately if fire or smoke grows.')}</p>`;
 const action=body.querySelector<HTMLButtonElement>('[data-id="action"]')!,actionText=action.querySelector('span')!,fill=action.querySelector<HTMLElement>('i')!,sweep=body.querySelector<HTMLElement>('[data-id="sweep"]')!;
 const continueSweep=body.querySelector<HTMLButtonElement>('[data-id="continue-sweep"]')!;
 const say=body.querySelector<HTMLElement>('[data-id="say"]')!,hint=body.querySelector<HTMLElement>('[data-id="hint"]')!,count=body.querySelector<HTMLElement>('[data-id="count"]')!,progress=[...body.querySelectorAll<HTMLElement>('.fire-child-progress>span')];
 const view=new FireLessonView(body.querySelector<HTMLElement>('.fire-model-view')!,(part,down,value)=>{
  if(part==='pin-drag'||part==='hose-drag'){const expected=part==='pin-drag'?1:2;if(step!==expected)return;fill.style.width=`${(value??0)*100}%`;if(!down&&(value??0)>=.72)advance();return;}
  if(!down){holding=false;return;}
  const expected=['gauge','pin','hose','handle','sweep'][step];
  if(part===expected){if(step===3&&!squeezeComplete)holding=true;else if(step===0)advance();}
 });
 let zoom=true;const zoomButton=body.querySelector<HTMLButtonElement>('.fire-model-zoom')!;
 zoomButton.onclick=()=>{zoom=!zoom;view.closeup(zoom);zoomButton.textContent=zoom?t('전체 보기','Full view'):t('부품 확대','Enlarge part');};
 const show=()=>{
  view.step=Math.max(0,step-1);view.gauge=step>0;view.focus=['gauge','pin','hose','handle','sweep'][step]!;
  body.querySelector<HTMLButtonElement>('[data-id="help"]')!.hidden=step===0||step===4;
  count.textContent=`${step+1} / 5`;say.textContent=instructions[step]!;actionText.textContent=labels[step]!;
  hint.textContent=step===1?t('위 손잡이는 누르지 않아요. 조금씩 끌어도 괜찮아요.','Do not squeeze the upper handle. Pull slowly, a little at a time.'):step===3?t('분말이 나올 때까지 잠깐만 누르고 있어요.','Hold briefly until the powder comes out.'):step===4?t('천천히 한 번 왕복해요. 양쪽을 번갈아 눌러도 돼요.','One slow trip there and back. You can also tap each side.'):step===2?t('반짝이는 호스 끝을 잡고 ‘불 아래’ 표시로 끌어요.','Drag the glowing nozzle toward the base marker.'):t('반짝이는 부품이나 아래 큰 버튼을 눌러요.','Tap the glowing part or the big button below.');
  progress.forEach((p,i)=>{p.className=i<step?'done':i===step?'now':'';p.querySelector('b')!.textContent=i<step?'✓':String(i+1);});
  action.hidden=step===4;sweep.hidden=step!==4;continueSweep.hidden=true;fill.style.width='0%';
  body.querySelector<HTMLElement>('[data-id="passes"]')!.textContent=t('← 왼쪽부터 해 볼까요?','← Start on the left');
 };
 const finish=()=>{
  if(finished)return;finished=true;holding=false;view.squeezing=false;view.focus='done';
  progress.forEach(p=>{p.className='done';p.querySelector('b')!.textContent='✓';});
  count.textContent='✓';say.textContent=t('잘했어요! 이제 작은 불을 꺼 봐요','Well done! Try the small fire now');hint.textContent=t('핀 뽑기 → 불 아래 겨냥 → 꾹 누르기 → 좌우로 쓸기','Pull → aim at the base → squeeze → sweep');
  sweep.hidden=true;body.querySelector<HTMLButtonElement>('[data-id="help"]')!.hidden=true;action.hidden=false;action.classList.add('complete');actionText.textContent=t('소화기 들고 출발!','Take the extinguisher!');action.querySelector('b')!.textContent='✓';fill.style.width='0%';
 };
 const advance=()=>{if(finished)return;step++;held=0;holding=false;squeezeComplete=false;if(step>4)finish();else show();};
 continueSweep.addEventListener('click',advance,{signal});
 const showSweepChoice=()=>{
  action.hidden=true;continueSweep.hidden=false;helpButton.hidden=true;
  say.textContent=t('분말이 나왔어요!','The powder came out!');
  hint.textContent=t('이제 불 아래를 좌우로 뿌려 봐요.','Next, sweep across the base of the fire.');
 };
 let gestureX:number|null=null,gestureStart=0,help=false;
 action.addEventListener('click',()=>{if(finished)done();else if(step===0)advance();},{signal});
 action.addEventListener('pointerdown',e=>{if(step!==1&&step!==2)return;e.preventDefault();action.setPointerCapture(e.pointerId);gestureX=e.clientX;gestureStart=step===1?view.pinProgress:view.aimProgress;},{signal});
 action.addEventListener('pointermove',e=>{if(gestureX===null)return;const value=THREE.MathUtils.clamp(gestureStart+(e.clientX-gestureX)/Math.min(100,action.clientWidth*.4),0,1);if(step===1)view.pinProgress=value;else if(step===2)view.aimProgress=value;fill.style.width=`${value*100}%`;},{signal});
 action.addEventListener('pointerup',()=>{if(gestureX===null)return;gestureX=null;if((step===1?view.pinProgress:view.aimProgress)>=.72)advance();},{signal});
 action.addEventListener('pointercancel',()=>{gestureX=null;},{signal});
 action.addEventListener('keydown',e=>{if((step===1||step===2)&&e.key==='ArrowRight'){e.preventDefault();if(step===1)view.pinProgress=Math.min(1,view.pinProgress+.2);else view.aimProgress=Math.min(1,view.aimProgress+.2);if((step===1?view.pinProgress:view.aimProgress)>=.9)advance();}},{signal});
 const helpButton=body.querySelector<HTMLButtonElement>('[data-id="help"]')!;
 helpButton.addEventListener('click',()=>{if(step===1||step===2){help=true;helpButton.disabled=true;}else if(step===3&&!squeezeComplete){help=true;holding=true;helpButton.disabled=true;}},{signal});
 const press=()=>{if(step===3&&!finished&&!squeezeComplete)holding=true;};
 action.addEventListener('pointerdown',e=>{if(step!==3)return;e.preventDefault();action.setPointerCapture(e.pointerId);press();},{signal});
 action.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&step===3){e.preventDefault();press();}},{signal});
 for(const name of ['pointerup','pointercancel','keyup','blur'] as const)window.addEventListener(name,()=>{if(!help)holding=false;},{signal});
 const frame=(now:number)=>{
  const dt=Math.min(.1,(now-last)/1000);last=now;
  if(help&&(step===1||step===2)){if(step===1)view.pinProgress=Math.min(1,view.pinProgress+dt*.65);else view.aimProgress=Math.min(1,view.aimProgress+dt*.65);if((step===1?view.pinProgress:view.aimProgress)>=1){help=false;helpButton.disabled=false;advance();}}
  // Once squeezing has been learnt, keep it held in the demonstration. The next task needs one gesture.
  view.squeezing=!finished&&(step===4||step===3&&holding);
  if(step===3&&!finished){
   if(holding){
    held+=dt;
    fill.style.width=`${Math.min(100,held/.7*100)}%`;
    if(held>=.7&&!squeezeComplete){
     squeezeComplete=true;hint.textContent=t('잘했어요. 이제 손을 떼세요.','Good. Let go now.');
    }
    if(help&&held>=1){help=false;holding=false;showSweepChoice();}
   }else if(squeezeComplete){
    if(continueSweep.hidden)showSweepChoice();
   }else{held=0;fill.style.width='0%';}
  }
  raf=requestAnimationFrame(frame);
 };raf=requestAnimationFrame(frame);
 const cross=(x:number)=>{
  if(step!==4||finished)return;view.sweep=x;sweep.style.setProperty('--x',`${x*100}%`);
  const current=x<.35?-1:x>.65?1:0;
  if(current&&current!==side){if(side)passes++;side=current;view.passes=passes*2;sweep.setAttribute('aria-valuenow',String(passes));body.querySelector<HTMLElement>('[data-id="passes"]')!.textContent=passes>=2?'✓':t(`${passes} / 2  ${current<0?'오른쪽으로 →':'← 왼쪽으로'}`,`${passes} / 2  ${current<0?'right →':'← left'}`);if(passes>=2)finish();}
 };
 sweep.addEventListener('pointerdown',e=>{if(step!==4)return;e.preventDefault();sweep.setPointerCapture(e.pointerId);const b=sweep.getBoundingClientRect();cross(THREE.MathUtils.clamp((e.clientX-b.left)/b.width,0,1));},{signal});
 sweep.addEventListener('pointermove',e=>{if(!(e.buttons&1)&&e.pointerType!=='touch')return;const b=sweep.getBoundingClientRect();cross(THREE.MathUtils.clamp((e.clientX-b.left)/b.width,0,1));},{signal});
 sweep.addEventListener('click',e=>{const b=sweep.getBoundingClientRect();cross((e.clientX-b.left)/b.width<.5?0:1);},{signal});
 sweep.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();cross(e.key==='ArrowLeft'?0:1);}},{signal});
 show();return{kind:'pass',close:()=>{controller.abort();cancelAnimationFrame(raf);view.dispose();root.remove();},solve:()=>{finish();done();}};
}

/** What the drill teaches, in order: told before it (the briefing card) and after it (the result card). */
export function drillLessons(): string[] {
  return [
    t("🔔 “불이야!” 크게 알리고 화재경보기 누르기", "🔔 Shout “Fire!” and press the alarm"),
    t("📞 119에 <b>어디에서 · 무슨 일이</b> 났는지 말하기", "📞 Tell 119 <b>where</b> and <b>what</b>"),
    t("🧯 소화기: 핀 뽑고 → 불 쪽으로 → 꽉 쥐고 → 쓸듯이", "🧯 Extinguisher: pin → aim → squeeze → sweep"),
    t("🔥 작은 불만 끄고, 큰 불은 바로 대피하기", "🔥 Fight only a small fire; leave a big one"),
    t("💧 젖은 수건으로 코와 입 막고 <b>낮은 자세</b>로", "💧 Wet towel over nose and mouth, and <b>stay low</b>"),
    t("🏃 초록 비상구 유도등을 따라 밖으로, 모이는 곳으로", "🏃 Follow the green exit signs out to the gathering place"),
  ];
}

// ------------------------------------------------------------------ the result

export interface DrillResult {
  stars: 1 | 2 | 3;
  seconds: number;
  mistakes: number;
  /** Seconds spent breathing smoke (it costs a star before it costs a faint: the card says so). */
  smokeSeconds: number;
}

/** The card at the end: stars, the time, what was learnt — and again, or stay and look around. */
export function openResultCard(result: DrillResult, again: () => void, stay: () => void, quiz?: () => void): { close(): void } {
  const root = document.createElement("div");
  root.className = "fire-panel fire-result";
  root.dataset.panel = "result";
  const min = Math.floor(result.seconds / 60), sec = Math.floor(result.seconds % 60);
  const learnt = drillLessons();
  root.innerHTML = `
    <div class="fire-card" role="dialog">
      <h2>${t("🎉 화재 대피 훈련 완료!", "🎉 Fire drill complete!")}</h2>
      <p class="fire-stars" data-stars="${result.stars}">${"★".repeat(result.stars)}<i>${"★".repeat(3 - result.stars)}</i></p>
      <p class="fire-score">⏱️ ${min > 0 ? t(`${min}분 ${sec}초`, `${min} min ${sec} s`) : t(`${sec}초`, `${sec} s`)}
        · ${result.mistakes > 0 ? t(`연기에 ${result.mistakes}번 쓰러질 뻔했어요`, `nearly overcome by smoke ${result.mistakes}×`)
          : result.stars === 3 ? t("연기를 잘 피했어요", "kept clear of the smoke")
          : t(`연기를 ${Math.round(result.smokeSeconds)}초 마셨어요`, `breathed smoke for ${Math.round(result.smokeSeconds)} s`)}</p>
      ${result.stars < 3 ? `<p class="fire-tip">${t("⭐ 별 3개 비결: 연기가 보이면 바로 <b>Z로 몸을 낮추고</b>, 젖은 수건으로 코와 입을 막아요", "⭐ For 3 stars: the moment you see smoke, <b>get low (Z)</b> and cover your nose and mouth with the wet towel")}</p>` : ""}
      <ul class="fire-learnt">${learnt.map((l) => `<li>${l}</li>`).join("")}</ul>
      <div class="fire-row">
        <button class="fire-cta" type="button" data-id="again">${t("🔁 다시 하기", "🔁 Again")}</button>
        ${quiz ? `<button class="fire-cta" type="button" data-id="quiz">${t("📝 퀴즈 풀기", "📝 Take the quiz")}</button>` : ""}
        <button class="fire-cta ghost" type="button" data-id="stay">${t("둘러보기", "Look around")}</button>
      </div>
    </div>`;
  root.querySelector<HTMLButtonElement>('[data-id="again"]')!.addEventListener("click", again);
  root.querySelector<HTMLButtonElement>('[data-id="stay"]')!.addEventListener("click", stay);
  root.querySelector<HTMLButtonElement>('[data-id="quiz"]')?.addEventListener("click", () => quiz?.());
  document.body.appendChild(root);
  return { close: () => root.remove() };
}
