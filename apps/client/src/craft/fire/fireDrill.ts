import {ExtinguisherPowder} from "./extinguisherPowder.js";
import * as THREE from "three";
import { classKey, fireSchool, fireEscapeTarget, type ClassClientMessage, type ClassServerMessage, type FireSchool, type FireStation, type FireStationKind } from "@robo/shared";
import { FireSchoolView } from "./fireSchoolView.js";
import { t } from "../../ui/i18n.js";
import { DRILL_STEPS, STATION_STEP, binSize, blaze, burnAt, burnField, drillStars, smokeFloorAt, thickFrontAt, newDrill, panelDone, rayBox, smokeOn, tickDrill, useStation, type Drill, type DrillEvent, type DrillStep } from "./drillRules.js";
import { FireFx } from "./fireFx.js";
import {FireCarryHands,FireFirstPersonArms,positionViewGrips,positionViewNozzleGrip} from "./fireCarryHands.js";
import { FireLighting } from "./fireLighting.js";
import { assemblyFlag, binProp, disposeFireProps, exitSign, extinguisherModel, extinguisherInstance, firePropsReady, stationProp, type FireProp } from "./fireProps.js";
import { drillLessons, openCallPanel, openPassPanel, openResultCard, type FirePanel } from "./firePanels.js";
import { openQuizPanel, type QuizPanel } from "./fireQuiz.js";
import { quizRounds } from "./quizRules.js";
import { QuizBoard } from "./quizBoard.js";
import { drillBoardContent, openDrillBoard, type DrillBoard, type DrillClassState } from "./fireBoard.js";
import "./fire.css";

/**
 * The fire drill (화재 체험) in the world: the school's props with a "you can use this" badge over
 * each, the prompt when one is under the crosshair, the guide bar, flames / smoke / spray, the two
 * lesson cards and the result. The rules are pure (drillRules.ts); the school is shared with the
 * server (fireSchool.ts). `CraftGame` owns one of these when the field's theme is "fire".
 *
 * Each player runs their OWN drill: fires and smoke are local, so a whole class can practise at
 * once without one child putting out everybody's fire.
 *
 * In a class the TEACHER runs it (`FireNet`, protocol `k-drill` / `s-k-drill`): everyone starts in
 * the briefing — no fire yet, students kept in the classroom — and a student's drill begins when
 * the teacher sets everyone, or their team, off. Tab opens the board (teams and progress; the
 * teacher's has the buttons).
 */

/** The lobby leaves the teacher's team choice here; the drill sends it once the class is open. */
export const TEAMS_PRESET_KEY = "craftyap-fire-teams";
/** The quiz a student is in the middle of (this tab): a refresh must not start it again or wipe its score. */
const QUIZ_KEY = "craftyap-fire-quiz";
interface StoredQuiz { quiz: number; name: string; results: boolean[] }
function storedQuiz(): StoredQuiz | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(QUIZ_KEY) ?? "null") as Partial<StoredQuiz> | null;
    return v && typeof v.quiz === "number" && typeof v.name === "string" && Array.isArray(v.results) && v.results.every((r) => typeof r === "boolean") ? (v as StoredQuiz) : null;
  } catch { return null; }
}
function storeQuiz(v: StoredQuiz | null): void {
  try { if (v) sessionStorage.setItem(QUIZ_KEY, JSON.stringify(v)); else sessionStorage.removeItem(QUIZ_KEY); } catch { /* no storage: a refresh starts the quiz again */ }
}

export type FireSound = "alarm" | "spray" | "cough" | "good" | "step" | "oof" | "click" | "pickup" | "crackle" | "roar" | "hiss";

/** The class's side of the drill: null when playing alone. */
export interface FireNet {
  role: "teacher" | "student";
  myName(): string;
  /** Students online right now, by name. */
  students(): string[];
  /** The teacher's teams / start / stop. */
  drill(op: Omit<Extract<ClassClientMessage, { t: "k-drill" }>, "t">): void;
  /** Our own progress, for the board. */
  report(step: number, stars?: number, seconds?: number): void;
  /** Our quiz so far (answered, right), with the drill step we are on. */
  quizReport(step: number, answered: number, score: number): void;
  /** Put the teacher's drill controls into the F2 class tools (the one place for a teacher's actions). */
  mountTools?(title: string, content: HTMLElement | null): void;
}

export interface FireHost {
  /** A class: the teacher runs the drill. Absent: solo, it starts at once. */
  net?: FireNet;
  scene: THREE.Scene;
  characterRoot?():THREE.Object3D|null;
  firstPerson?():boolean;
  characterVariant?():string;
  /** The rendered scenery clips the muzzle and its spray even beside thin trim. */
  obstacle?(from:THREE.Vector3,direction:THREE.Vector3,distance:number):number;
  shadowsEnabled?():boolean;
  /** The frame's pipeline, once the game has one: it gives the smoke the scene's depth (a volume instead of puffs). */
  pipeline?(): import("../../render/waterPipeline.js").WaterPipeline | null;
  /** Absolute coordinate of grid cell (0, 0): the field scrolls under the player. */
  originX(): number;
  originZ(): number;
  toast(text: string): void;
  sound(name: FireSound): void;
  /** …heard from a place (absolute coordinates). */
  soundAt(name: FireSound, x: number, y: number, z: number): void;
  /** A card is going up: let go of the mouse and the keys. */
  openPanel(): void;
  /** The card is gone: back to play. */
  resumePlay(): void;
  /** Put the player at absolute (x, y, z) feet, optionally looking along `yaw`. */
  teleport(x: number, y: number, z: number, yaw?: number): void;
  /** Touch play: prompts name the on-screen buttons instead of keys. */
  touch: boolean;
  /** Get low / stand up (touch has no Z key: the drill adds a button for it). */
  toggleLow(): void;
}

export interface FireTick {
  /** In play (the mouse is captured / touch play is on): the drill's clock runs. */
  playing: boolean;
  /** Feet, absolute. */
  x: number; y: number; z: number;
  eyeY: number;
  /** The look ray from the eye, absolute. */
  dx: number; dy: number; dz: number;
  /** How far along that ray the first block or furniture is (Infinity: nothing in reach). */
  blockDist: number;
  /** The primary button is held. */
  spraying: boolean;
}

/** How near a station must be to use it (m, from the eye). */
const USE_REACH = 4.5;
const BADGE_RANGE = 26;

const ICON: Record<FireStationKind, string> = { alarm: "🔔", phone: "📞", extinguisher: "🧯", towel: "💧", sign: "🏃" };

function stationName(kind: FireStationKind): string {
  switch (kind) {
    case "alarm": return t("화재경보기 누르기", "Press the fire alarm");
    case "phone": return t("119 신고하기", "Call 119");
    case "extinguisher": return t("소화기 들기", "Take the extinguisher");
    case "towel": return t("젖은 수건으로 코와 입 막기", "Cover nose and mouth with a wet towel");
    case "sign": return t("비상구 유도등 살펴보기", "Look at the exit sign");
  }
}

/** What a thing is, for a class looking round during the briefing. */
function stationInfo(kind: FireStationKind): string {
  switch (kind) {
    case "alarm": return t("화재경보기 — 불이 나면 눌러서 모두에게 알려요", "The fire alarm — press it to warn everyone");
    case "phone": return t("전화기 — 불이 나면 119에 신고해요", "The phone — call 119 when there is a fire");
    case "extinguisher": return t("소화기 — 작은 불을 끌 때 써요", "The extinguisher — for a small fire");
    case "towel": return t("젖은 수건 — 연기를 마시지 않게 코와 입을 막아요", "A wet towel — over nose and mouth, against the smoke");
    case "sign": return t("비상구 유도등 — 이 표시를 따라 밖으로 나가요", "The exit sign — follow it out");
  }
}

function guideText(d: Drill, touch: boolean): string {
  switch (d.step) {
    case "alarm": return t("<b>불이야!</b> 복도의 <b>화재경보기</b>를 눌러 모두에게 알려요", "<b>Fire!</b> Press the <b>fire alarm</b> in the corridor to warn everyone");
    case "call": return t("복도의 전화기로 <b>119</b>에 신고해요", "Call <b>119</b> on the corridor phone");
    case "grab": return t("<b>소화기</b>를 찾아 사용법을 배워요", "Find the <b>extinguisher</b> and learn to use it");
    case "spray":
      if (!d.extinguisher) return t("소화기를 다 썼어요 — <b>새 소화기</b>를 가져와요", "It ran out — fetch a <b>fresh extinguisher</b>");
      return touch
        ? t("쓰레기통의 작은 불: <b>불의 아래쪽</b>을 겨냥하고 <b>⛏ 버튼</b>을 꾹!", "The bin fire: aim at its <b>base</b> and hold <b>⛏</b>!")
        : t("쓰레기통의 작은 불: <b>불의 아래쪽</b>을 겨냥하고 <b>왼쪽 클릭</b>을 꾹!", "The bin fire: aim at its <b>base</b> and hold <b>left click</b>!");
    case "towel": return t("과학실 불은 너무 커요! 세면대에서 <b>젖은 수건</b>으로 코와 입을 막아요", "The science-room fire is too big! Cover your nose and mouth with a <b>wet towel</b> at the sink");
    case "escape":
      return touch
        ? t("<b>⬇️ 낮추기</b>로 몸을 낮추고, 초록 <b>비상구</b> 표시를 따라 밖으로!", "Get low with <b>⬇️</b> and follow the green <b>exit</b> signs out!")
        : t("<b>Z</b>로 몸을 낮추고, 초록 <b>비상구</b> 표시를 따라 밖으로!", "Get low with <b>Z</b> and follow the green <b>exit</b> signs out!");
    case "assemble": return t("다시 들어가지 않아요 — 운동장 <b>모이는 곳</b>으로!", "Never go back in — head for the <b>gathering place</b>!");
    case "done": return t("훈련 완료! 학교를 자유롭게 둘러봐요", "Drill complete! Look around the school");
  }
}

/** A round badge with an emoji: "this can be used". */
function badgeTexture(icon: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(31,31,31,0.9)";
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#ffffff";
  g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.fill();
  g.font = '64px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(icon, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The "go here" beacon: a yellow ring with a downward arrow. */
function beaconTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 176;
  const g = c.getContext("2d")!;
  g.lineWidth = 12;
  g.strokeStyle = "#1f1f1f";
  g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 7;
  g.strokeStyle = "#ffd21c";
  g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#ffd21c"; g.strokeStyle = "#1f1f1f"; g.lineWidth = 5;
  g.beginPath(); g.moveTo(40, 130); g.lineTo(88, 130); g.lineTo(64, 170); g.closePath(); g.fill(); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface StationRuntime {
  def: FireStation;
  prop: FireProp;
  badge: THREE.Sprite;
  /** Where the badge floats (absolute). */
  top: THREE.Vector3;
}

export class FireDrill {
  private readonly campus=new FireSchoolView();
  private readonly fxState = { clock: 0, smokeClock: 0, bin: 0, level: 0, centreX: 0, centreZ: 0, smoke: 0, smokeFloor: 0, thickFront: 0 };
  /** The whole fire, re-measured twice a second (how much burns, and its middle). */
  private readonly blazeNow = { level: 0, x: 0, z: 0 };
  readonly ready:Promise<void>;
  private readonly absolutePlayer={x:0,y:8.4,z:0};
  private readonly school: FireSchool = fireSchool();
  private drill: Drill = newDrill();
  private readonly root = new THREE.Group();
  private readonly fx: FireFx;
  private readonly powder=new ExtinguisherPowder();
  private readonly lighting:FireLighting;
  private readonly stations: StationRuntime[] = [];
  private readonly beacon: THREE.Sprite;
  private readonly held: THREE.Group;
  private readonly hands=new FireCarryHands();
  private readonly firstPersonArms=new FireFirstPersonArms();
  private carryBlend=0;
  private aimBlend=0;
  private tuck=0;
  private worldTuck=0;
  private closeCarry=false;
  private sway=0;
  private readonly cameraRotation=new THREE.Quaternion();
  private readonly viewForward=new THREE.Vector3();
  private readonly reachProbe=new THREE.Vector3();
  private readonly nozzleGrid=new THREE.Vector3();
  private readonly hoseForward=new THREE.Vector3();
  private readonly handleAxis=new THREE.Vector3();
  private readonly nozzleAxis=new THREE.Vector3();
  private readonly rightHand=new THREE.Vector3();
  private readonly leftHand=new THREE.Vector3();
  private readonly aimWorld=new THREE.Vector3();
  private readonly gripOffset=new THREE.Vector3();
  private readonly owned: { dispose(): void }[] = [];
  private readonly guide: HTMLElement;
  /** A class only: the lesson's six points, shown while waiting through the briefing. */
  private briefing: HTMLElement | null = null;
  private readonly guideStep: HTMLElement;
  private readonly guideText: HTMLElement;
  private readonly guideWhere: HTMLElement;
  /** Breath, the extinguisher's charge and the towel: bottom centre, where the hotbar is elsewhere. */
  private readonly gauges: HTMLElement;
  private readonly airGauge: HTMLElement;
  private readonly airFill: HTMLElement;
  private readonly chargeGauge: HTMLElement;
  private readonly chargeFill: HTMLElement;
  private readonly towelChip: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly veil: HTMLElement;
  private panel: FirePanel | null = null;
  private board: DrillBoard | null = null;
  /** The teacher's quiz on our screen (students), and which quiz it is (so the same one is not opened twice). */
  private quiz: QuizPanel | null = null;
  /** The quiz board on the classroom wall (playing alone only), and whether the crosshair is on it. */
  private quizBoard: QuizBoard | null = null;
  private quizBadge: THREE.Sprite | null = null;
  private aimedQuiz = false;
  private quizSeen = 0;
  /** The teacher's controls (teams, start, stop) and everyone's progress, as a section of the F2 class tools. */
  private toolsBoard: ReturnType<typeof drillBoardContent> | null = null;
  /** The drill as the teacher runs it (a class only; null until the server has said). */
  private cls: DrillClassState | null = null;
  private run = -1;
  private result: { close(): void } | null = null;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;
  /** Index of the station under the crosshair, or -1. */
  private aimed = -1;
  private shownPrompt = "";
  private shownGuide = "";
  private shownWhere = "";
  private started = false;
  private spraying = false;
  private drain = 0;
  private heat = false;
  private clock = 0;
  private alarmIn = 0;
  private readonly quiet = new Map<string, number>();
  private readonly sprayFrom = new THREE.Vector3();
  private readonly sprayDir = new THREE.Vector3(0, 0, 1);
  private readonly sprayRay = { from: this.sprayFrom, dir: this.sprayDir, len: 4 };
  private muzzleReady=false;
  private readonly target = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private disposed = false;

  constructor(private readonly host: FireHost) {
    this.root.add(this.campus.root);
    const school = this.school;
    this.fx = new FireFx(school, () => host.pipeline?.() ?? null);
    this.root.add(this.fx.root,this.powder.root);
    this.lighting=new FireLighting(this.fx.root,school);
    void this.campus.ready.then(()=>{if(!this.disposed)this.lighting.invalidate();});

    for (const def of school.stations) {
      const prop = stationProp(def.kind);
      prop.root.position.set(def.cell[0] + 0.5, def.cell[1], def.cell[2] + 0.5);
      prop.root.rotation.y = (def.rot * Math.PI) / 2;
      this.root.add(prop.root);
      const tex = badgeTexture(ICON[def.kind]);
      const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: false });
      const badge = new THREE.Sprite(material);
      badge.scale.set(0.05, 0.05, 1);
      badge.renderOrder = 40;
      badge.raycast = () => {};
      const top = new THREE.Vector3((def.box[0] + def.box[3]) / 2, def.box[4] + 0.22, (def.box[2] + def.box[5]) / 2);
      // wall props: the badge floats a little out from the wall
      const [fx, fz] = [[0, 1], [1, 0], [0, -1], [-1, 0]][def.rot & 3]!;
      top.x = def.cell[0] + 0.5 + fx! * -0.15;
      top.z = def.cell[2] + 0.5 + fz! * -0.15;
      this.root.add(badge);
      this.stations.push({ def, prop, badge, top });
      this.owned.push(tex, material);
    }
    if (!host.net) {
      // alone, the quiz is taken at a board in the classroom (in a class it is the teacher's to give)
      this.quizBoard = new QuizBoard(school, host.touch === true);
      this.root.add(this.quizBoard.root);
      const tex = badgeTexture("📝");
      const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: false });
      this.quizBadge = new THREE.Sprite(material);
      this.quizBadge.scale.set(0.05, 0.05, 1);
      this.quizBadge.renderOrder = 40;
      this.quizBadge.raycast = () => {};
      this.root.add(this.quizBadge);
      this.owned.push(tex, material);
    }
    for (const sign of school.signs) {
      const g = new THREE.Group();
      exitSign(g, 0, 0, 0, true, {kind:sign.mount.kind,y:sign.mount.y-sign.at[1]});
      g.position.set(sign.at[0], sign.at[1], sign.at[2]);
      g.rotation.y = (sign.rot * Math.PI) / 2;
      this.root.add(g);
    }
    const bin = binProp();
    bin.position.set(school.bin[0] + 0.5, school.bin[1], school.bin[2] + 0.5);
    this.root.add(bin);
    const flag = assemblyFlag();
    flag.position.set(school.assembly.x, school.assembly.y??school.bin[1], school.assembly.z);
    this.root.add(flag);

    const beaconTex = beaconTexture();
    const beaconMat = new THREE.SpriteMaterial({ map: beaconTex, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, sizeAttenuation: false });
    this.beacon = new THREE.Sprite(beaconMat);
    this.beacon.center.set(0.5, 0);
    this.beacon.renderOrder = 41;
    this.beacon.raycast = () => {};
    this.root.add(this.beacon);
    this.owned.push(beaconTex, beaconMat);

    this.held = extinguisherModel();
    this.held.visible = false;
    this.root.add(this.held,this.firstPersonArms.root);
    this.ready=Promise.all([this.campus.ready,firePropsReady()]).then(()=>{});

    host.scene.add(this.root);

    document.body.classList.add("theme-fire");
    this.guide = document.createElement("div");
    this.guide.className = "fire-guide";
    this.guide.innerHTML = `
      <div class="fire-guide-card"><span class="fire-guide-step"></span><span class="fire-guide-text"></span><span class="fire-guide-where"></span></div>`;
    this.gauges = document.createElement("div");
    this.gauges.className = "fire-gauges";
    this.gauges.innerHTML = `
      <div class="fire-gauges-row">
        <div class="fire-gauge air" data-id="air" hidden>🫁 ${t("숨", "Breath")} <span class="bar"><i></i></span></div>
        <div class="fire-gauge charge" data-id="charge" hidden>🧯 <span class="bar"><i></i></span></div>
        <div class="fire-gauge towel" data-id="towel" hidden>💧 ${t("젖은 수건", "Wet towel")}</div>
      </div>`;
    if (host.net?.role === "teacher") {
      // the master controls live in F2 (class tools): the one place a teacher is told to look
      const net = host.net;
      this.toolsBoard = drillBoardContent({ teacher: true, me: net.myName(), students: () => net.students(), send: (op) => net.drill(op), preview: () => this.localQuiz() });
      this.toolsBoard.render({ size: 0, teams: [], go: [], run: 0, reports: [] });
      net.mountTools?.(t("🔥 화재 훈련", "🔥 Fire drill"), this.toolsBoard.root);
    }
    if (host.touch && host.net?.role === "student") {
      const board = document.createElement("button");
      board.type = "button";
      board.className = "fire-low";
      board.textContent = t("📋 진행판", "📋 Board");
      board.addEventListener("click", () => this.toggleBoard());
      this.gauges.querySelector(".fire-gauges-row")!.appendChild(board);
    }
    if (host.touch) {
      const low = document.createElement("button");
      low.type = "button";
      low.className = "fire-low";
      low.textContent = t("⬇️ 낮추기", "⬇️ Get low");
      low.addEventListener("click", () => host.toggleLow());
      this.gauges.querySelector(".fire-gauges-row")!.appendChild(low);
    }
    document.body.appendChild(this.guide);
    if (host.net) {
      // the briefing: while a class waits, everyone has the lesson in front of them — it is what
      // the teacher explains from, and what a child reads while waiting for their team's turn
      const teacher = host.net.role === "teacher";
      this.briefing = document.createElement("aside");
      this.briefing.className = "fire-briefing";
      this.briefing.hidden = true;
      this.briefing.innerHTML = `
        <h3>${t("📋 오늘 배울 것", "📋 Today's lesson")}</h3>
        <ol>${drillLessons().map((l) => `<li>${l}</li>`).join("")}</ol>
        <p class="fire-briefing-foot">${teacher
          ? (host.touch
            ? t("설명이 끝나면 <b>🧑‍🏫 수업 도구</b> → <b>🔥 모두 출발</b>", "When you have explained it: <b>🧑‍🏫 class tools</b> → <b>🔥 Everyone go</b>")
            : t("설명이 끝나면 <b>F2</b> → <b>🔥 모두 출발</b>", "When you have explained it: <b>F2</b> → <b>🔥 Everyone go</b>"))
          : t("선생님이 출발시키면 훈련이 시작돼요", "The drill starts when your teacher sets you off")}</p>`;
      document.body.appendChild(this.briefing);
    }
    document.body.appendChild(this.gauges);
    this.guideStep = this.guide.querySelector<HTMLElement>(".fire-guide-step")!;
    this.guideText = this.guide.querySelector<HTMLElement>(".fire-guide-text")!;
    this.guideWhere = this.guide.querySelector<HTMLElement>(".fire-guide-where")!;
    this.airGauge = this.gauges.querySelector<HTMLElement>('[data-id="air"]')!;
    this.airFill = this.airGauge.querySelector<HTMLElement>("i")!;
    this.chargeGauge = this.gauges.querySelector<HTMLElement>('[data-id="charge"]')!;
    this.chargeFill = this.chargeGauge.querySelector<HTMLElement>("i")!;
    this.towelChip = this.gauges.querySelector<HTMLElement>('[data-id="towel"]')!;
    this.prompt = document.createElement("div");
    this.prompt.className = "fire-prompt";
    this.prompt.hidden = true;
    // touch: the prompt itself is the button
    this.prompt.addEventListener("click", () => { this.interact(); });
    document.body.appendChild(this.prompt);
    this.veil = document.createElement("div");
    this.veil.className = "fire-veil";
    document.body.appendChild(this.veil);
    this.showGuide();
  }

  /** A lesson card, the board or the result is up: it owns the screen and the keys. */
  get panelOpen(): boolean {
    return this.panel !== null || this.result !== null || this.board !== null || this.quiz !== null;
  }

  get boardOpen(): boolean {
    return this.board !== null;
  }

  // ------------------------------------------------------------------ the class's drill

  /** Our team (from 1), or 0 without teams. */
  private myTeam(): number {
    const net = this.host.net;
    if (!net || !this.cls) return 0;
    const me = classKey(net.myName());
    return this.cls.teams.find(([name]) => classKey(name) === me)?.[1] ?? 0;
  }

  /** In a class: has the teacher set us off? (The teacher's own drill runs once anyone's does.) */
  private setOff(): boolean {
    const net = this.host.net;
    if (!net) return true;
    if (!this.cls) return false;
    if (net.role === "teacher") return this.cls.go.length > 0;
    return this.cls.go.includes(0) || this.cls.go.includes(this.myTeam());
  }

  /** Waiting through the briefing, or for our team's turn: no fire yet, nothing to do but listen. */
  get waiting(): boolean {
    return !this.setOff();
  }

  /** While a student waits they stay in the classroom: [minX, maxX, minZ, maxZ] absolute, or null. */
  confineBox(): readonly [number, number, number, number] | null {
    if (this.host.net?.role !== "student" || !this.waiting) return null;
    return this.roomBox;
  }
  private readonly roomBox: readonly [number, number, number, number] = [this.school.classroom[0], this.school.classroom[3], this.school.classroom[2], this.school.classroom[5]];

  /** The server's word on the drill: teams, who is set off, the run, everyone's progress. */
  applyClass(msg: Extract<ClassServerMessage, { t: "s-k-drill" }>): void {
    const was = this.waiting, first = this.run === -1;
    this.cls = { size: msg.size, teams: msg.teams, go: msg.go, run: msg.run, reports: msg.reports, ...(msg.quiz ? { quiz: msg.quiz } : {}) };
    this.followQuiz(msg.quiz ?? 0);
    if (first) this.presetTeams(msg);
    if (msg.run !== this.run) {
      this.run = msg.run;
      // put back to the start (new teams, or the teacher stopped it): students return to the
      // classroom; the teacher stays where they stand
      if (!first) this.restart(this.host.net?.role === "student");
    }
    if (was && !this.waiting) {
      // set off: the fire starts NOW
      this.drill = newDrill();
      this.started = false;
      this.quiet.clear();
      this.host.sound("step");
      this.host.net?.report(0);
    }
    this.shownGuide = "";
    this.showGuide();
    this.board?.render(this.cls);
    this.toolsBoard?.render(this.cls);
  }

  /** The teams the teacher asked for when making the class (the lobby's choice), given once to a class that has none. */
  private presetTeams(msg: Extract<ClassServerMessage, { t: "s-k-drill" }>): void {
    const net = this.host.net;
    if (net?.role !== "teacher") return;
    let size = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(TEAMS_PRESET_KEY) ?? "null") as { size?: unknown; at?: unknown } | null;
      sessionStorage.removeItem(TEAMS_PRESET_KEY);
      if (saved && (saved.size === 4 || saved.size === 5) && typeof saved.at === "number" && Date.now() - saved.at < 5 * 60_000) size = saved.size;
    } catch { /* no storage: no preset */ }
    if (size > 0 && msg.size === 0 && msg.go.length === 0) net.drill({ op: "teams", size });
  }

  /** The teacher started a quiz (or ended it): students get it on their screen, once per quiz. */
  private followQuiz(quiz: number): void {
    if (this.host.net?.role !== "student") return;
    if (quiz === 0) {
      // (a server that restarted numbers its quizzes from 1 again: nothing of the old one may be remembered)
      this.quizSeen = 0;
      storeQuiz(null);
      // ended by the teacher: a quiz still being answered is taken away; a finished one may be read on
      if (this.quiz && !this.quiz.done) { this.closeQuiz(true); this.host.toast(t("📝 선생님이 퀴즈를 끝냈어요", "📝 The teacher ended the quiz")); }
      return;
    }
    if (quiz === this.quizSeen) return;
    this.quizSeen = quiz;
    const net = this.host.net, rounds = quizRounds(quiz);
    const step = (): number => Math.max(0, DRILL_STEPS.indexOf(this.drill.step));
    // a page refreshed mid-quiz goes on where it was (and a finished one is not asked again)
    const kept = storedQuiz(), resume = kept && kept.quiz === quiz && kept.name === net.myName() ? kept.results.slice(0, rounds.length) : [];
    net.quizReport(step(), resume.length, resume.filter(Boolean).length);
    if (resume.length >= rounds.length) return;
    this.closePanels(); // a lesson card or the result card gives way: the quiz is the teacher's call
    this.quiz?.close();
    this.host.openPanel();
    this.quiz = openQuizPanel(rounds, {
      resume,
      progress: (answered, score, results) => {
        storeQuiz({ quiz, name: net.myName(), results: [...results] });
        net.quizReport(step(), answered, score);
      },
      close: () => this.closeQuiz(true),
      sound: (name) => this.host.sound(name),
    });
  }
  /**
   * A quiz on this screen only, nothing sent: the teacher's preview (from the F2 tools), the quiz
   * someone playing alone takes at the classroom's quiz board (`resume`: play goes on when it is
   * closed) or from the result card (it lies OVER the card, which is there again after it).
   */
  private localQuiz(resume = false): void {
    if (this.quiz) return;
    const done = (): void => this.closeQuiz(resume);
    this.quiz = openQuizPanel(quizRounds(1 + Math.floor(Math.random() * 9999)), { progress: () => {}, close: done, dismiss: done, sound: (name) => this.host.sound(name) });
  }
  private closeQuiz(resume: boolean): void {
    this.quiz?.close();
    this.quiz = null;
    if (resume) this.host.resumePlay();
  }
  /** Dev / E2E: answer the quiz question that is up. */
  debugQuiz(right: boolean): boolean {
    if (!this.quiz) return false;
    this.quiz.answer(right);
    return true;
  }

  /** Tab: the board (teams and progress, to read). A class only. The teacher's controls are in F2. */
  toggleBoard(): void {
    const net = this.host.net;
    if (!net) return;
    if (this.board) { this.closePanels(true); return; }
    if (this.panelOpen) return;
    this.host.openPanel();
    this.board = openDrillBoard({
      teacher: false, // the controls are in the F2 class tools
      me: net.myName(),
      students: () => net.students(),
      send: (op) => net.drill(op),
      close: () => this.closePanels(true),
    });
    this.board.render(this.cls ?? { size: 0, teams: [], go: [], run: 0, reports: [] });
  }

  /** An extinguisher is in hand: the primary button sprays. */
  get holding(): boolean {
    return this.drill.extinguisher;
  }

  /** Is the spray going right now? (The body should face where it is aimed.) */
  get sprayingNow(): boolean {
    return this.spraying;
  }

  /** Where to arrive: a free spot in the classroom, absolute feet, and the way to face. */
  spawn(index = Math.floor(Math.random() * this.school.spawns.length)): { x: number; y: number; z: number; yaw: number } {
    const s = this.school.spawns[index % this.school.spawns.length]!;
    return { x: s[0], y: s[1], z: s[2], yaw: this.school.spawnYaw };
  }

  // ------------------------------------------------------------------ rules

  /** One physics tick. */
  tick(dt: number, env: FireTick): void {
    this.spraying = false;
    if (!env.playing || this.panelOpen) { this.aimed = -1; this.aimedQuiz = false; this.drain = 0; return; }
    if (this.waiting) {
      // the briefing: things can be looked at (and say what they are), nothing burns yet
      this.aimed = this.aimAt(env);
      this.drain = 0;
      return;
    }
    if (!this.started) {
      this.started = true;
      this.host.toast(t("🔥 과학실에서 불이 났어요! 위쪽 안내를 따라 차례대로 해 봐요", "🔥 A fire has started in the science room! Follow the guide at the top, step by step"));
    }
    this.clock += dt;
    this.aimed = this.aimAt(env);

    const step = this.drill.step;
    const spraying = env.spraying && this.drill.extinguisher;
    const muzzle = this.muzzleReady && this.drill.extinguisher ? this.sprayRay : null;
    const { events, drain } = tickDrill(this.drill, dt, {
      x: env.x, y: env.y, z: env.z, eyeY: env.eyeY, spraying,
      ox: muzzle?.from.x ?? env.x, oy: muzzle?.from.y ?? env.eyeY, oz: muzzle?.from.z ?? env.z,
      dx: muzzle?.dir.x ?? env.dx, dy: muzzle?.dir.y ?? env.dy, dz: muzzle?.dir.z ?? env.dz,
      sprayLimit: muzzle?.len ?? env.blockDist,
    });
    this.spraying = spraying && this.drill.extinguisher;
    this.drain = drain;
    this.heat = events.includes("heat");
    for (const e of events) this.onEvent(e);
    if (this.drill.step !== step) this.stepChanged();

    // the bell keeps ringing until everyone is out
    if (this.drill.alarm && this.drill.step !== "done" && (this.alarmIn -= dt) <= 0) {
      this.alarmIn = 1.5;
      this.host.sound("alarm");
    }
  }

  /** What is under the crosshair: the nearest station box the ray crosses, unless a wall is nearer. */
  private aimAt(env: FireTick): number {
    let best = -1, bestT = Infinity;
    for (let i = 0; i < this.stations.length; i++) {
      const hit = rayBox(env.x, env.eyeY, env.z, env.dx, env.dy, env.dz, this.stations[i]!.def.box, USE_REACH);
      // (a hand's width of slack for a prop standing against what it is mounted on — NOT a wall's
      // thickness: with 0.4 the corridor's alarm could be rung from inside the classroom, through the wall)
      if (hit !== null && hit < bestT && hit <= env.blockDist + 0.12) { best = i; bestT = hit; }
    }
    // the quiz board, unless a station is nearer along the ray (it hangs on the wall: a little more slack)
    this.aimedQuiz = false;
    if (this.quizBoard) {
      const hit = rayBox(env.x, env.eyeY, env.z, env.dx, env.dy, env.dz, this.quizBoard.place.box, USE_REACH);
      if (hit !== null && hit < bestT && hit <= env.blockDist + 0.35) { this.aimedQuiz = true; return -1; }
    }
    return best;
  }

  /** At most one `key` every `seconds`. */
  /**
   * What the fire sounds like from here: the burning area crackles from wherever it burns (the
   * more of it burns, the more often), its middle roars, and the small fire has its own voice.
   */
  private fireSounds(px: number, py: number, pz: number, silent: boolean): void {
    if (silent) return;
    const d = this.drill, now = this.blazeNow, f = burnField(), floor = this.school.heat[1];
    const near = (x: number, z: number): boolean => Math.hypot(x - px, floor - py, z - pz) < 28;
    // a pop from a random spot of the room, if that spot burns
    if (now.level > 0.004 && this.every("crackle", (0.05 + Math.random() * 0.22) / (0.35 + now.level * 1.6))) {
      for (let tries = 0; tries < 4; tries++) {
        const x = f.x0 + Math.random() * f.w * f.cell, z = f.z0 + Math.random() * f.h * f.cell;
        if (burnAt(x, z, d.time) < 0.2) continue;
        if (near(x, z)) this.host.soundAt("crackle", x, floor + 0.2 + Math.random() * 1.2, z);
        break;
      }
    }
    if (now.level > 0.02 && near(now.x, now.z) && this.every("roar", 0.55)) this.host.soundAt("roar", now.x, floor + 1, now.z);
    // the waste-bin fire
    const bin = this.fx.bin;
    if (d.fire > 0.1 && near(bin[0], bin[2])) {
      if (this.every("crackle-bin", (0.18 + Math.random() * 0.5) / d.fire)) this.host.soundAt("crackle", bin[0], bin[1] + Math.random() * 0.8, bin[2]);
      if (now.level < 0.02 && this.every("roar", 0.55)) this.host.soundAt("roar", bin[0], bin[1] + 0.5, bin[2]);
    }
  }

  private every(key: string, seconds: number): boolean {
    if ((this.quiet.get(key) ?? -Infinity) > this.clock) return false;
    this.quiet.set(key, this.clock + seconds);
    return true;
  }

  private onEvent(e: DrillEvent): void {
    const { host } = this;
    switch (e) {
      case "spray":
        if (this.every("spray", 0.1)) host.sound("spray");
        break;
      case "hit": // powder on the flames, heard from the fire
        if (this.every("hiss", 0.22)) { const f = this.fx.bin; host.soundAt("hiss", f[0], f[1], f[2]); }
        break;
      case "aim-low":
        if (this.every("aim", 3)) host.toast(t("🔥 불꽃 말고 불의 아래쪽을 겨냥해요", "🔥 Aim at the base of the fire, not the flames"));
        break;
      case "too-far":
        if (this.every("aim", 3)) host.toast(t("조금 더 가까이! 2~3 m 앞에서 뿌려요", "A little closer! Spray from 2–3 m away"));
        break;
      case "empty":
        host.toast(t("🧯 소화기를 다 썼어요. 새 소화기를 가져와요", "🧯 The extinguisher is empty. Fetch a fresh one"));
        break;
      case "fire-out":
        host.sound("good");
        host.toast(t("✅ 작은 불을 껐어요! 하지만 과학실 불은 너무 커요 — 큰 불은 끄려 하지 말고 대피해요", "✅ The small fire is out! But the science-room fire is too big — never fight a big fire, get out"));
        break;
      case "smoke":
        if (this.every("cough", 1.6)) host.sound("cough");
        if (this.every("smoke", 4)) host.toast(this.host.touch
          ? t("💨 연기예요! 몸을 낮춰요 — ⬇️ 낮추기 버튼", "💨 Smoke! Get low — the ⬇️ button")
          : t("💨 연기예요! 몸을 낮춰요 — Z 키로 기어가요", "💨 Smoke! Get low — press Z to crawl"));
        break;
      case "need-towel":
        if (this.every("towel", 5)) host.toast(t("💧 젖은 수건으로 코와 입을 막아야 해요 — 세면대로!", "💧 Cover your nose and mouth with a wet towel — to the sink!"));
        break;
      case "thick":
        if (this.every("cough", 1.6)) host.sound("cough");
        if (this.every("thick", 4)) host.toast(t("🚫 이쪽은 연기가 가득해요! 반대쪽 비상구로 가요", "🚫 This way is full of smoke! Use the other exit"));
        break;
      case "heat":
        if (this.every("heat", 3)) host.toast(t("🔥 너무 뜨거워요! 큰 불에는 가까이 가지 않아요", "🔥 Too hot! Keep away from a big fire"));
        break;
      case "fainted":
        host.sound("oof");
        host.toast(t("콜록콜록! 연기를 너무 많이 마셨어요. 다시 해 봐요 — 낮은 자세로!", "Cough, cough! Too much smoke. Try again — stay low!"));
        host.teleport(this.school.retry[0], this.school.retry[1], this.school.retry[2]);
        break;
      case "early":
        if (this.every("early", 6)) host.toast(t("아직 훈련 중이에요! 위쪽 안내를 따라 차례대로 해 봐요", "The drill isn't over! Follow the guide at the top, step by step"));
        break;
      case "outside":
        host.toast(t("🌤️ 밖으로 나왔어요! 다시 들어가지 않아요", "🌤️ You're out! Never go back inside"));
        break;
      case "done":
        host.sound("good");
        // a beat to arrive, then the card
        this.resultTimer = setTimeout(() => { this.resultTimer = null; this.showResult(); }, 700);
        break;
    }
  }

  private stepChanged(): void {
    this.showGuide();
    this.guide.classList.remove("pulse");
    void this.guide.offsetWidth; // restart the pop
    this.guide.classList.add("pulse");
    if (this.drill.step !== "done" && this.drill.step !== "towel") this.host.sound("step");
    // the class's board follows everyone's progress
    const d = this.drill, done = d.step === "done";
    this.host.net?.report(DRILL_STEPS.indexOf(d.step), done ? drillStars(d) : undefined, done ? Math.round(d.time) : undefined);
  }

  /** E / right click / the prompt: use the station under the crosshair. True when there was one. */
  interact(): boolean {
    if (this.panelOpen) return false;
    if (this.aimedQuiz) { this.host.sound("click"); this.host.openPanel(); this.localQuiz(true); return true; }
    if (this.aimed < 0) return false;
    this.use(this.stations[this.aimed]!.def.kind);
    return true;
  }

  private use(kind: FireStationKind): void {
    const { host } = this;
    if (this.waiting) {
      host.sound("click");
      host.toast(`${ICON[kind]} ${stationInfo(kind)}`);
      return;
    }
    const step = this.drill.step;
    const used = useStation(this.drill, kind);
    switch (used) {
      case "alarm":
        this.alarmIn = 0;
        host.toast(t("🔔 따르르릉! “불이야!” 하고 크게 외쳐 모두에게 알려요", "🔔 Rrring! Shout “Fire!” so everyone knows"));
        break;
      case "panel-call":
        host.openPanel();
        this.panel = openCallPanel(() => this.finishPanel("call"), () => this.closePanels(true));
        break;
      case "panel-pass":
        host.openPanel();
        this.panel = openPassPanel(() => this.finishPanel("pass"), () => this.closePanels(true));
        break;
      case "grab":
        host.sound("pickup");
        host.toast(t("🧯 소화기를 들었어요. 불의 아래쪽을 겨냥해요", "🧯 Extinguisher in hand. Aim at the base of the fire"));
        break;
      case "towel":
        host.sound("pickup");
        host.toast(t("💧 젖은 수건으로 코와 입을 막았어요. 이제 몸을 낮춰요", "💧 Wet towel over your nose and mouth. Now get low"));
        break;
      case "info":
        host.sound("click");
        host.toast(kind === "sign"
          ? t("🏃 초록색 비상구 유도등 — 불이 나면 이 표시를 따라 밖으로 나가요", "🏃 The green exit sign — in a fire, follow it out")
          : stationName(kind));
        break;
      case "later":
        host.sound("click");
        host.toast(t("아직이에요 — 위쪽 안내의 순서대로 해 봐요", "Not yet — follow the guide at the top, in order"));
        break;
      case "already":
        host.sound("click");
        host.toast(kind === "extinguisher" && !this.drill.extinguisher
          ? t("🧯 큰 불은 소화기로 끌 수 없어요. 대피해요!", "🧯 An extinguisher can't beat a big fire. Get out!")
          : t("이미 했어요 👍", "Already done 👍"));
        break;
    }
    if (this.drill.step !== step) this.stepChanged();
  }

  private finishPanel(kind: "call" | "pass"): void {
    const step = this.drill.step;
    this.panel?.close();
    this.panel = null;
    panelDone(this.drill, kind);
    if (kind === "pass") this.host.sound("pickup");
    if (this.drill.step !== step) this.stepChanged();
    this.host.resumePlay();
  }

  /** Take any card down. `resume`: the player closed it (back to play); otherwise play is
   *  already resuming (the mouse was captured again). */
  closePanels(resume = false): void {
    if (!this.panelOpen) return;
    this.panel?.close();
    this.panel = null;
    this.result?.close();
    this.result = null;
    this.board?.close();
    this.board = null;
    this.quiz?.close();
    this.quiz = null;
    if (resume) this.host.resumePlay();
  }

  private showResult(): void {
    if (this.disposed || this.result) return;
    this.host.openPanel();
    this.result = openResultCard(
      { stars: drillStars(this.drill), seconds: this.drill.time, mistakes: this.drill.mistakes, smokeSeconds: this.drill.smokeTime },
      () => this.restart(),
      () => this.closePanels(true),
      this.host.net ? undefined : () => this.localQuiz(), // in a class the quiz is the teacher's to give
    );
  }

  /** From the top: fires lit, back in the classroom (`move` false: stay where we stand). */
  restart(move = true): void {
    if (this.resultTimer) { clearTimeout(this.resultTimer); this.resultTimer = null; }
    const resume = this.panel !== null || this.result !== null; // the board stays up (the teacher is using it)
    this.panel?.close(); this.panel = null;
    this.result?.close(); this.result = null;
    this.drill = newDrill();
    this.started = false;
    this.muzzleReady=false;
    this.quiet.clear();
    if (move) {
      const s = this.spawn();
      this.host.teleport(s.x, s.y, s.z, s.yaw);
    }
    this.shownGuide = "";
    this.showGuide();
    if (!this.waiting) this.host.net?.report(0);
    if (resume && !this.board) this.host.resumePlay();
  }

  private showGuide(): void {
    const d = this.drill;
    const waiting = this.waiting, team = this.myTeam();
    const key = waiting ? `wait|${team}` : `${d.step}|${d.extinguisher}`;
    if (key === this.shownGuide) return;
    this.shownGuide = key;
    this.guide.classList.toggle("waiting", waiting);
    if (this.briefing) this.briefing.hidden = !waiting;
    if (waiting) {
      this.guideStep.textContent = team > 0 ? t(`${team}조`, `Team ${team}`) : "🧑‍🏫";
      this.guideText.innerHTML = this.host.net?.role === "teacher"
        ? (this.host.touch
          ? t("상황을 설명한 뒤 <b>🧑‍🏫 수업 도구</b>에서 출발시켜요", "Brief the class, then set them off from the <b>🧑‍🏫 class tools</b>")
          : t("상황을 설명한 뒤 <b>F2</b>(수업 도구)에서 <b>🔥 모두 출발</b>을 눌러요", "Brief the class, then press <b>F2</b> (class tools) and <b>🔥 Everyone go</b>"))
        : team > 0
          ? t("선생님 설명을 듣고, <b>우리 조 차례</b>를 기다려요", "Listen to the teacher and wait for <b>your team's turn</b>")
          : t("선생님의 설명을 들어요 — 곧 훈련이 시작돼요", "Listen to the teacher — the drill starts soon");
      return;
    }
    const n = DRILL_STEPS.indexOf(d.step);
    this.guideStep.textContent = d.step === "done" ? "✅" : `${n + 1} / ${DRILL_STEPS.length - 1}`;
    this.guideText.innerHTML = guideText(d, this.host.touch);
  }

  /** Where the current step sends the player (absolute), or false when there is nowhere to go. */
  private targetOf(step: DrillStep, out: THREE.Vector3): boolean {
    const school = this.school;
    const station = (kind: FireStationKind) => {
      const s = this.stations.find((r) => r.def.kind === kind)!;
      out.copy(s.top);
      return true;
    };
    switch (step) {
      case "alarm": {
        const p=this.absolutePlayer,b=school.classroom;
        if(p.y>7.6&&p.x>=b[0]&&p.x<b[3]&&p.z<b[5]){const q=school.classroomDoor;out.set(q[0],q[1]+1.7,q[2]);return true;}
        return station("alarm");
      }
      case "call": return station("phone");
      case "grab": return station("extinguisher");
      case "spray": {
        if (!this.drill.extinguisher) return station("extinguisher");
        const fire = school.fires.find((f) => f.small)!;
        out.set(fire.at[0], fire.at[1] + 1.5, fire.at[2]);
        return true;
      }
      case "towel": return station("towel");
      case "escape": {const p=this.absolutePlayer,q=fireEscapeTarget(p.x,p.y,p.z);out.set(q[0],q[1]+1.7,q[2]);return true;}
      case "assemble": out.set(school.assembly.x, (school.assembly.y??4) + 2, school.assembly.z); return true;
      case "done": return false;
    }
  }

  // ------------------------------------------------------------------ drawing

  /**
   * Once a frame. `player`: the drawn body (GRID feet) and the way it faces; `look`: the view
   * direction (unit), for the spray and the "which way" arrow.
   */
  render(dt: number, camera: THREE.Camera, player: { x: number; y: number; z: number; facing: number; speed: number; eye: number; opacity: number }, look: { yaw: number; pitch: number }): void {
    const ox = this.host.originX(), oz = this.host.originZ();
    this.root.position.set(-ox, 0, -oz);
    const d = this.drill;
    const px = player.x + ox, pz = player.z + oz; // absolute
    this.absolutePlayer.x=px;this.absolutePlayer.y=player.y;this.absolutePlayer.z=pz;
    const time = performance.now() / 1000;
    const bob = Math.sin(time * 3) * 0.04;

    // badges: "you can use this" over every station in sight range
    const waiting = this.waiting;
    const step = d.step;
    for (const s of this.stations) {
      const dist = Math.hypot(s.top.x - px, s.top.z - pz);
      const current = !waiting && (STATION_STEP[s.def.kind] === step || (step === "spray" && !d.extinguisher && s.def.kind === "extinguisher"));
      s.badge.visible = dist < BADGE_RANGE && !current; // the current one wears the beacon instead
      s.badge.position.set(s.top.x, s.top.y + bob, s.top.z);
      if (s.prop.lamp) s.prop.lamp.emissiveIntensity = !waiting && d.alarm && step !== "done" ? (Math.sin(time * 9) > 0 ? 2.4 : 0.3) : 0.15;
      if (s.def.kind === "extinguisher") {
        const body = s.prop.root.getObjectByName("extinguisher");
        if (body) body.visible = !d.extinguisher;
      }
    }

    if (this.quizBoard && this.quizBadge) {
      const [bx, by, bz] = this.quizBoard.place.at;
      this.quizBadge.visible = Math.hypot(bx - px, bz - pz) < BADGE_RANGE;
      this.quizBadge.position.set(bx, by + 1.25 + bob, bz - 0.2);
    }

    // the beacon over where this step sends you, and which way that is
    const has = !waiting && this.targetOf(step, this.target);
    this.beacon.visible = has;
    let where = "";
    if (has) {
      const pulse = 1 + Math.sin(time * 5) * 0.12;
      this.beacon.scale.set(0.05 * pulse, 0.05 * pulse * (176 / 128), 1);
      this.beacon.position.set(this.target.x, this.target.y + 0.1 + bob, this.target.z);
      const dx = this.target.x - px, dz = this.target.z - pz, dist = Math.hypot(dx, dz);
      if (dist > 2.5) {
        // the view looks along (sin yaw, cos yaw); its right hand is (-cos yaw, sin yaw)
        const ahead = dx * Math.sin(look.yaw) + dz * Math.cos(look.yaw);
        const right = -dx * Math.cos(look.yaw) + dz * Math.sin(look.yaw);
        const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
        const index = ((Math.round(Math.atan2(right, ahead) / (Math.PI / 4)) % 8) + 8) % 8;
        where = `${arrows[index]} ${Math.round(dist)} m`;
      }
    }
    if (where !== this.shownWhere) { this.shownWhere = where; this.guideWhere.textContent = where; }
    this.showGuide();

    const holding = d.extinguisher && !waiting;
    this.held.visible = false;
    this.firstPersonArms.root.visible = false;
    this.carryBlend = THREE.MathUtils.damp(this.carryBlend, holding ? 1 : 0, 13, dt);
    this.aimBlend = THREE.MathUtils.damp(this.aimBlend, holding && this.spraying ? 1 : 0, 16, dt);
    this.closeCarry = player.opacity < (this.closeCarry ? .27 : .08);
    const firstPerson = (this.host.firstPerson?.() ?? false) || this.closeCarry;
    this.hoseForward.set(Math.sin(firstPerson?look.yaw:player.facing),0,Math.cos(firstPerson?look.yaw:player.facing));
    const model = extinguisherInstance(this.held);
    const speed = Math.min(player.speed / 4.6, 1);
    this.sway += dt * (4 + speed * 7);
    const gait = Math.sin(this.sway) * (.003 + speed * (firstPerson ? .005 : .012)) * (1 - this.aimBlend * .65);
    let spray: typeof this.sprayRay | null = null;
    this.muzzleReady=false;

    if (holding && model) {
      camera.updateWorldMatrix(true, false);
      camera.getWorldDirection(this.viewForward);
      const cameraReach = this.host.obstacle?.(camera.position,this.viewForward,12) ?? 12;
      this.aimWorld.copy(camera.position).addScaledVector(this.viewForward, cameraReach);
      let hoseClearance=.27;
      if (!firstPerson) {
        this.reachProbe.set(player.x,player.eye-.52,player.z);
        const room=this.host.obstacle?.(this.reachProbe,this.hoseForward,.66)??.66;
        this.worldTuck=THREE.MathUtils.damp(this.worldTuck,1-THREE.MathUtils.smoothstep(room,.24,.66),17,dt);
        hoseClearance-=this.worldTuck*.11;
      }
      const hasHands = !firstPerson && this.hands.pose(this.host.characterRoot?.() ?? null,
        this.rightHand,this.leftHand,this.carryBlend,this.aimBlend,look.pitch,gait,this.worldTuck);
      if (firstPerson) {
        camera.getWorldQuaternion(this.cameraRotation);
        positionViewGrips(camera,this.cameraRotation,this.rightHand,this.leftHand,this.aimBlend,0,gait);
        this.reachProbe.copy(this.rightHand).sub(camera.position);
        const rightReach=this.reachProbe.length()+.08;this.reachProbe.normalize();
        const rightClearance=this.host.obstacle?.(camera.position,this.reachProbe,rightReach)??rightReach;
        positionViewNozzleGrip(this.cameraRotation,this.leftHand,this.reachProbe).sub(camera.position);
        const leftReach=this.reachProbe.length()+.08;this.reachProbe.normalize();
        const leftClearance=this.host.obstacle?.(camera.position,this.reachProbe,leftReach)??leftReach;
        const near=Math.min(rightClearance,leftClearance,cameraReach,.82);
        hoseClearance=.17;
        this.hoseForward.negate();
        this.hoseForward.y=-.9;
        this.tuck = THREE.MathUtils.damp(this.tuck, 1 - THREE.MathUtils.smoothstep(near,.24,.82), 16, dt);
        positionViewGrips(camera,this.cameraRotation,this.rightHand,this.leftHand,this.aimBlend,this.tuck,gait);
        this.held.quaternion.copy(this.cameraRotation);
        this.held.rotateZ(gait);
        // Pull the equipment down and in when there is no room ahead of the hands.
        if (near < .34) {
          this.reachProbe.set(0,-(.34-near)*1.45,.18).applyQuaternion(this.cameraRotation);
          this.rightHand.add(this.reachProbe);
          this.leftHand.add(this.reachProbe);
          hoseClearance=.065;
        }
      } else {
        const sin = Math.sin(player.facing), cos = Math.cos(player.facing);
        if (!hasHands) {
          this.rightHand.set(player.x - cos*.61 + sin*.26, player.eye-.60, player.z + sin*.61 + cos*.26);
          this.leftHand.set(player.x + cos*.53 + sin*.34, player.eye-.55, player.z - sin*.53 + cos*.34);
        }
        this.held.rotation.set(-.06*this.aimBlend,player.facing-.55,-.10+gait,'YXZ');
      }
      // At a wall the aim point can be behind the nozzle. Keep the muzzle forward
      // and stop the spray at the first solid surface instead of flipping it back.
      this.reachProbe.copy(this.aimWorld).sub(this.leftHand);
      if (this.reachProbe.dot(this.viewForward) < .18) this.aimWorld.copy(this.leftHand).addScaledVector(this.viewForward,.18);
      this.gripOffset.copy(firstPerson?model.viewGrip:model.grip).applyQuaternion(this.held.quaternion);
      this.held.position.copy(this.rightHand).sub(this.gripOffset);
      this.held.position.x += ox;
      this.held.position.z += oz;
      this.held.updateWorldMatrix(true, false);
      this.held.visible = firstPerson || this.carryBlend > .72;
      this.nozzleGrid.copy(this.leftHand);
      if(firstPerson)positionViewNozzleGrip(this.cameraRotation,this.leftHand,this.nozzleGrid);
      model.carry(this.aimBlend,this.nozzleGrid,this.aimWorld,this.hoseForward,hoseClearance);
      if (firstPerson && model.nozzleRay(this.nozzleGrid,this.nozzleAxis)) {
        this.handleAxis.set(0,0,1).applyQuaternion(this.held.quaternion);
        this.firstPersonArms.root.visible = true;
        this.firstPersonArms.pose(camera,this.rightHand,this.leftHand,ox,oz,this.host.characterVariant?.() ?? 'mascot',this.handleAxis,this.nozzleAxis,THREE.MathUtils.smoothstep(this.carryBlend,.18,.98));
      }
      if (this.held.visible && model.nozzleRay(this.sprayFrom,this.sprayDir)) {
        this.muzzleReady=true;
        const length = Math.min(5,this.aimWorld.distanceTo(this.sprayFrom));
        this.nozzleGrid.copy(this.sprayFrom);
        this.reachProbe.copy(this.nozzleGrid).sub(this.leftHand);
        const barrelLength=this.reachProbe.length();
        this.reachProbe.normalize();
        const barrelClear=this.host.obstacle?.(this.leftHand,this.reachProbe,barrelLength)??barrelLength;
        const open=barrelClear<barrelLength-.008 ? 0 : this.host.obstacle?.(this.nozzleGrid,this.sprayDir,length)??length;
        this.sprayRay.len = Math.min(length,open);
        this.sprayFrom.x += ox;
        this.sprayFrom.z += oz;
        if(this.spraying && this.sprayRay.len > .055) spray = this.sprayRay;
      }
    }
    if (!holding && !firstPerson && this.carryBlend > .002) {
      this.hands.pose(this.host.characterRoot?.() ?? null,this.rightHand,this.leftHand,this.carryBlend,this.aimBlend,look.pitch,gait);
    }
    // what burns now: the small fire (bigger the longer it is left) and the burning area by the drill's clock
    const fx = this.fxState, now = this.blazeNow;
    if (this.every("blaze", 0.5)) blaze(d.time, now);
    fx.clock = d.time;
    fx.smokeClock = d.smokeClock;
    fx.bin = d.fire * binSize(d.time);
    fx.level = now.level; fx.centreX = now.x; fx.centreZ = now.z;
    this.fireSounds(px, player.y, pz, waiting || step === "done");
    // the smoke fills cell by cell by the clock. Outside the burning room it hangs as a layer:
    // before the escape only a band under the ceiling (over everyone's head), then down to the
    // rules' smoke floor — what is seen is what is breathed
    fx.smoke = waiting || step === "done" ? 0 : 1;
    fx.smokeFloor = smokeOn(d) ? smokeFloorAt(d) : this.school.corridor[4] - 0.35 - 0.75 * now.level;
    fx.thickFront = thickFrontAt(d);
    this.tmp.copy(camera.position);this.tmp.x+=ox;this.tmp.z+=oz;
    this.powder.update(dt,spray,!waiting,this.tmp);
    this.fx.update(dt, time, fx, null, !waiting);

    this.lighting.update(ox,oz,this.host.shadowsEnabled?.()??true);

    // the prompt under the crosshair
    const aimed = this.aimed >= 0 && !this.panelOpen ? this.stations[this.aimed]!.def.kind : null;
    const promptKey = aimed ? `${aimed}|${!waiting && STATION_STEP[aimed] === step}` : this.aimedQuiz && !this.panelOpen ? "quiz" : "";
    if (promptKey !== this.shownPrompt) {
      this.shownPrompt = promptKey;
      this.prompt.hidden = promptKey === "";
      if (promptKey === "quiz") {
        this.prompt.classList.remove("quiet");
        this.prompt.innerHTML = `${this.host.touch ? "👆" : "<kbd>E</kbd>"} 📝 ${t("퀴즈 풀기", "Play the quiz")}`;
      } else if (aimed) {
        this.prompt.classList.toggle("quiet", waiting || STATION_STEP[aimed] !== step);
        this.prompt.innerHTML = `${this.host.touch ? "👆" : "<kbd>E</kbd>"} ${ICON[aimed]} ${waiting ? t("살펴보기", "Look") : stationName(aimed)}`;
      }
    }

    // gauges and the smoke over the screen
    const breathing = !waiting && (smokeOn(d) || d.air < 0.995);
    this.airGauge.hidden = !breathing;
    if (breathing) {
      this.airFill.style.width = `${Math.round(d.air * 100)}%`;
      this.airGauge.classList.toggle("low", d.air < 0.4);
    }
    this.chargeGauge.hidden = !d.extinguisher || waiting;
    if (d.extinguisher) this.chargeFill.style.width = `${Math.round(d.charge * 100)}%`;
    this.towelChip.hidden = !d.towel || step === "done" || waiting;
    this.veil.classList.toggle("heat", this.heat);
    // enough to feel it, never so much that the way out cannot be seen
    this.veil.style.opacity = this.drain > 0 ? String(Math.min(0.62, 0.2 + this.drain * 1.1)) : "0";
    void camera;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resultTimer) clearTimeout(this.resultTimer);
    if (this.toolsBoard) this.host.net?.mountTools?.("", null);
    this.panel?.close();
    this.result?.close();
    this.board?.close();
    this.host.scene.remove(this.root);
    this.lighting.dispose();
    this.fx.dispose();
    this.powder.dispose();
    this.firstPersonArms.dispose();
    this.campus.dispose();
    for (const o of this.owned) o.dispose();
    this.quizBoard?.dispose();
    disposeFireProps();
    this.guide.remove();
    this.briefing?.remove();
    this.gauges.remove();
    this.prompt.remove();
    this.veil.remove();
    document.body.classList.remove("theme-fire");
  }

  // ------------------------------------------------------------------ dev / E2E

  debug(): Record<string, unknown> {
    const d = this.drill;
    return {
      step: d.step, time: d.time, alarm: d.alarm, extinguisher: d.extinguisher, trained: d.trained, charge: d.charge,
      fire: d.fire, blaze: blaze(d.time).level, smokeFloor: smokeFloorAt(d), thickFront: thickFrontAt(d), towel: d.towel, air: d.air, mistakes: d.mistakes, smokeTime: d.smokeTime,
      panel: this.panel?.kind ?? (this.quiz ? "quiz" : this.result ? "result" : this.board ? "board" : null),
      waiting: this.waiting, team: this.myTeam(), class: this.cls,
      aimed: this.aimed >= 0 ? this.stations[this.aimed]!.def.kind : null,
      stations: this.stations.map((s) => ({ kind: s.def.kind, cell: s.def.cell, box: s.def.box })),
      fx: this.fx.debug(),
      nozzle: this.muzzleReady ? { from: this.sprayFrom.toArray(), dir: this.sprayDir.toArray(), distance: this.sprayRay.len } : null,
      guide: this.guideText.textContent,
      prompt: this.prompt.hidden ? null : this.prompt.textContent,
      quizBoard: this.quizBoard ? { ...this.quizBoard.place, aimed: this.aimedQuiz } : null,
    };
  }

  /** Use a station without aiming at it. */
  debugUse(kind: FireStationKind): void {
    if (!this.panelOpen) this.use(kind);
  }

  /** Dev: put the drill somewhere else in its story (its clock, its step, the smoke's age). */
  debugSet(patch: Partial<Drill>): void {
    Object.assign(this.drill, patch);
  }

  /** Finish the open lesson card as if every step had been done. */
  debugSolve(): boolean {
    if (!this.panel) return false;
    this.panel.solve();
    return true;
  }
}
