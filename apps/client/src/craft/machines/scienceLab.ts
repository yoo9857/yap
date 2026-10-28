import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { CharacterRig, disposeRig } from "../../player/rig.js";
import { MachineAssets, MachineVisual } from "./machineVisual.js";
import { preset } from "./blueprint.js";
import {
  ascentSequence,
  DustExperiment,
  ENERGY_PATHS,
  energyFlow,
  EXPERIMENT_REVISION,
  inclineSample,
  REFERENCE_INCLINE,
  validateIncline,
  type EnergySource,
  type InclineConditions,
} from "./experimentModels.js";
import "./scienceLab.css";
import { t } from "../../ui/i18n.js";

type Experiment = "incline" | "dust" | "energy" | "ascent";
const TITLES: Record<Experiment, string> = {
  incline: t("왜 언덕을 못 오를까?", "Why can't it climb the hill?"),
  dust: t("옮기는 것과 모으는 것", "Moving it vs. catching it"),
  energy: t("에너지는 어떤 길로 갈까?", "Which way does the energy go?"),
  ascent: t("내가 만든 우주선에 탑승", "Board the ship you built"),
};
const NOTES_KEY = "craftyap-science-notes-v1";
const CONNECTION_COLORS = {
  mechanical: 0xe9b95b,
  electrical: 0x75e8cf,
  gas: 0x8fb8fa,
  fuel: 0xe59263,
};

/** Four reproducible exhibits. UI, rendering and notes consume pure models;
 * the comparison cameras share exactly the same pose, lens and elapsed time. */
export class ScienceLab {
  active = false;
  private readonly root = document.createElement("section");
  private readonly stage = document.createElement("div");
  private readonly results = document.createElement("div");
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
  });
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 800);
  private readonly scenes: THREE.Scene[] = [];
  private readonly visuals: MachineVisual[] = [];
  private readonly resources = new Set<THREE.BufferGeometry | THREE.Material>();
  private readonly events = new AbortController();
  private readonly environment: THREE.WebGLRenderTarget;
  private mode: Experiment = "incline";
  private conditions: InclineConditions = { ...REFERENCE_INCLINE };
  private ratios: [number, number] = [1.5, 3];
  private fan = 1.5;
  private filter = true;
  private source: EnergySource = "hydrogen";
  private inputPower = 100;
  private elapsed = 0;
  private running = false;
  private dust: DustExperiment | null = null;
  private particles: THREE.InstancedMesh | null = null;
  private captured: THREE.InstancedMesh | null = null;
  private fanRotor: THREE.Group | null = null;
  private mascot: CharacterRig | null = null;
  private stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private planet: THREE.Mesh | null = null;
  private powerMarkers: THREE.Mesh[] = [];
  private links: THREE.Vector3[][] = [];
  private readonly matrix = new THREE.Matrix4();
  private notes: Partial<
    Record<Experiment, { prediction: string; explanation: string }>
  > = {};
  private width = 0;
  private height = 0;
  private readonly resize: ResizeObserver;

  constructor(
    private readonly assets: MachineAssets,
    private readonly onClose: () => void,
  ) {
    this.root.className = "science-lab";
    this.root.hidden = true;
    this.root.innerHTML = `<header class="lab-header"><div class="lab-brand">Craftyap <small>MAKE / OBSERVE / EXPLAIN</small></div>
      <nav class="lab-tabs" aria-label="${t("과학 실험 선택", "Pick an experiment")}">${(["incline", "dust", "energy", "ascent"] as Experiment[]).map((m, i) => `<button data-mode="${m}" aria-selected="false">0${i + 1} · ${[t("언덕과 기어", "Hills & gears"), t("팬과 필터", "Fans & filters"), t("에너지 경로", "Energy paths"), t("탑승과 상승", "Boarding & launch")][i]}</button>`).join("")}</nav><button data-id="close">${t("제작실로 돌아가기", "Back to the workshop")}</button></header>
      <div class="lab-body"><aside class="lab-side"></aside></div>
      <footer class="lab-footer"><label>${t("① 예상하기", "① Predict")}<textarea data-id="prediction" maxlength="1000" placeholder="${t("어떤 조건이 결과를 바꿀까요?", "Which condition will change the result?")}"></textarea></label>
      <label>${t("③ 설명하기", "③ Explain")}<textarea data-id="explanation" maxlength="1000" placeholder="${t("관찰한 결과와 이유를 연결해 보세요.", "Connect what you saw to why it happened.")}"></textarea></label>
      <div class="lab-actions"><button class="lab-run" data-id="run">${t("실험 시작", "Start experiment")}</button><button data-id="reset">${t("다시 준비", "Reset")}</button><button data-id="export">${t("기록 내려받기", "Download notes")}</button><span class="lab-error" role="status"></span></div></footer>`;
    this.stage.className = "lab-stage";
    this.results.className = "lab-results";
    this.stage.append(this.renderer.domElement, this.results);
    const stageLabel = document.createElement("div");
    stageLabel.className = "lab-stage-label";
    this.stage.append(stageLabel);
    this.root.querySelector(".lab-body")!.append(this.stage);
    document.body.append(this.root);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    const pmrem = new THREE.PMREMGenerator(this.renderer),
      room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    const options = { signal: this.events.signal };
    this.root.querySelector('[data-id="close"]')!.addEventListener(
      "click",
      () => {
        this.close();
        this.onClose();
      },
      options,
    );
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
      b.addEventListener(
        "click",
        () => {
          this.saveNotes();
          this.mode = b.dataset.mode as Experiment;
          this.prepare();
        },
        options,
      ),
    );
    this.root
      .querySelector('[data-id="run"]')!
      .addEventListener("click", () => this.run(), options);
    this.root
      .querySelector('[data-id="reset"]')!
      .addEventListener("click", () => this.prepare(), options);
    this.root
      .querySelector('[data-id="export"]')!
      .addEventListener("click", () => this.exportReport(), options);
    this.root
      .querySelectorAll("textarea")
      .forEach((el) =>
        el.addEventListener("change", () => this.saveNotes(), options),
      );
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(this.stage);
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object")
          for (const key of ["incline", "dust", "energy", "ascent"] as const) {
            const entry = (parsed as Record<string, unknown>)[key];
            if (entry && typeof entry === "object") {
              const value = entry as Record<string, unknown>;
              if (
                typeof value.prediction === "string" &&
                typeof value.explanation === "string"
              )
                this.notes[key] = {
                  prediction: value.prediction.slice(0, 1000),
                  explanation: value.explanation.slice(0, 1000),
                };
            }
          }
      }
    } catch {
      /* notes are optional */
    }
  }
  open(): void {
    this.active = true;
    this.root.hidden = false;
    this.prepare();
    this.measure();
  }
  close(): void {
    this.saveNotes();
    this.active = false;
    this.running = false;
    this.root.hidden = true;
  }
  private measure(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      this.width = Math.floor(r.width);
      this.height = Math.floor(r.height);
      this.renderer.setSize(this.width, this.height, false);
      if (this.active && this.scenes.length) this.render(0);
    }
  }
  private error(text: string): void {
    this.root.querySelector(".lab-error")!.textContent = text;
  }
  private field(id: string): HTMLInputElement {
    return this.root.querySelector(`[data-field="${id}"]`)!;
  }
  private readSettings(): void {
    if (this.mode === "incline") {
      const next = { ...this.conditions };
      for (const key of [
        "mass",
        "radius",
        "slopeDegrees",
        "torque",
        "resistance",
        "seconds",
      ] as const)
        next[key] = Number(this.field(key).value);
      validateIncline(next);
      const ratios: [number, number] = [
        Number(this.field("a").value),
        Number(this.field("b").value),
      ];
      for (const ratio of ratios) inclineSample(next, ratio, 0);
      this.conditions = next;
      this.ratios = ratios;
    } else if (this.mode === "dust") {
      this.fan = Number(this.field("fan").value);
      this.filter = this.field("filter").checked;
    } else if (this.mode === "energy") {
      this.source = this.field("source").value as EnergySource;
      this.inputPower = Number(this.field("power").value);
      energyFlow(this.source, this.inputPower);
    }
  }
  private controls(): void {
    const side = this.root.querySelector<HTMLElement>(".lab-side")!;
    let content = `<div class="lab-kicker">EXPERIMENT / ${this.mode.toUpperCase()}</div><h2>${TITLES[this.mode]}</h2>`;
    if (this.mode === "incline") {
      content += `<p>${t("같은 자동차, 같은 언덕, 같은 시간. 기어비만 바꾸어 비교합니다.", "Same car, same hill, same time. Only the gear ratio changes.")}</p>
      <label>A ${t("기어비", "gear ratio")}<input data-field="a" type="number" min="0.5" max="8" step="0.1" value="${this.ratios[0]}"></label><label>B ${t("기어비", "gear ratio")}<input data-field="b" type="number" min="0.5" max="8" step="0.1" value="${this.ratios[1]}"></label>
      <details open><summary>${t("두 실험에 공통인 조건", "Conditions shared by both runs")}</summary>${(
        [
          ["mass", t("질량 (kg)", "Mass (kg)"), 5, 500, 1],
          ["radius", t("반지름 (m)", "Wheel radius (m)"), 0.1, 2, 0.05],
          ["slopeDegrees", t("경사 (°)", "Slope (°)"), 0, 35, 1],
          ["torque", t("토크 (N·m)", "Torque (N·m)"), 0, 200, 1],
          ["resistance", t("주행 저항 (N)", "Rolling resistance (N)"), 0, 100, 0.1],
          ["seconds", t("시험 시간 (s)", "Test time (s)"), 1, 20, 1],
        ] as const
      )
        .map(
          ([key, label, min, max, step]) =>
            `<label>${label}<input data-field="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${this.conditions[key]}"></label>`,
        )
        .join("")}</details>
      <p class="equation">F = τ × ${t("기어비", "gear ratio")} / r<br>a = max(0, (F − mg sinθ − ${t("저항", "resistance")}) / m)<br>s = ½at²</p><p class="assumption">${t("단순 힘 모델 · 효율 100%, 일정 토크, 접지계수 0.9. 미끄럼 한계로 구동력을 제한하며 역주행 방지 브레이크를 가정합니다. 공기 저항·회전 관성은 생략합니다. PDF에 없는 저항은 6.9N으로 명시했습니다.", "Simple force model · 100% efficiency, constant torque, grip coefficient 0.9. Drive force is capped by the slip limit and a roll-back brake is assumed. Air drag and rotational inertia are left out. The resistance missing from the worksheet is set to 6.9 N.")}</p>`;
    } else if (this.mode === "dust")
      content += `<p>${t("바람은 먼지를 이동시킵니다. 필터가 없으면 이동한 먼지는 어디로 갈까요?", "Wind moves dust. Without a filter, where does the moved dust end up?")}</p><label>${t("팬 세기", "Fan strength")}<input data-field="fan" type="range" min="0" max="3" step="0.25" value="${this.fan}"></label><label>${t("필터 연결", "Filter on")}<input data-field="filter" type="checkbox" ${this.filter ? "checked" : ""}></label><p class="assumption">${t("고정 시드 42 · 모의 입자 240개 · 필터 포집 확률 85% · 관찰 10초. 실제 미세먼지·유체 해석이나 공기청정기 성능 인증 모델이 아닙니다. 팬이 0이면 먼지는 옆으로 이동하지 않습니다.", "Fixed seed 42 · 240 simulated particles · 85% filter capture chance · 10 s of observation. This is not a real fine-dust or fluid analysis, nor an air-purifier rating. With the fan at 0 the dust does not drift sideways.")}</p>`;
    else if (this.mode === "energy")
      content += `<p>${t("선택한 에너지원에 필요한 장치와 연결만 표시합니다.", "Shows only the devices and links the chosen energy source needs.")}</p><label>${t("에너지원", "Energy source")}<select data-field="source">${Object.entries(
        ENERGY_PATHS,
      )
        .map(
          ([key, p]) =>
            `<option value="${key}" ${key === this.source ? "selected" : ""}>${p.name}</option>`,
        )
        .join(
          "",
        )}</select></label><label>${t("입력 (W)", "Input (W)")}<input data-field="power" type="number" min="0" max="10000" step="10" value="${this.inputPower}"></label><div class="lab-path">${ENERGY_PATHS[this.source].stages.map((s) => `<span>${s}</span>`).join("")}</div><p>${ENERGY_PATHS[this.source].note}</p><p class="assumption">${t("민트: 전기 · 파랑: 수소 가스 · 황금: 기계적 전달 · 주황: 연료. 효율은 수업용 예시이며 실제 제품의 효율·친환경 순위를 나타내지 않습니다.", "Mint: electricity · blue: hydrogen gas · gold: mechanical drive · orange: fuel. Efficiencies are classroom examples, not real products' efficiency or green ranking.")}</p>`;
    else
      content += `<p>${t("지상에서 캐릭터가 탑승하고, 추진기 점화와 함께 상승합니다. 카메라가 따라가며 하늘이 바뀝니다.", "The character boards on the ground and rises as the thrusters fire. The camera follows and the sky changes.")}</p><p class="assumption">${t("이 장면은 10초 탑승·상승 시퀀스입니다. 표시 고도는 연출 좌표이며 실제 대기권 고도·중력·연료·궤도 해석이 아닙니다. 부품 배치에 따른 실제 강체 비행은 제작실의 비행체 시험에서 할 수 있습니다.", "This is a 10-second boarding and launch sequence. The altitude shown is a staging coordinate, not real atmosphere, gravity, fuel or orbit analysis. Real rigid-body flight from your part layout happens in the workshop's test drive.")}</p>`;
    side.innerHTML = content;
    side.querySelectorAll("input,select").forEach((el) =>
      el.addEventListener(
        "change",
        () => {
          try {
            this.readSettings();
            this.prepare();
          } catch (e) {
            this.error(e instanceof Error ? e.message : String(e));
          }
        },
        { signal: this.events.signal },
      ),
    );
    this.root
      .querySelectorAll<HTMLButtonElement>("[data-mode]")
      .forEach((b) =>
        b.setAttribute("aria-selected", String(b.dataset.mode === this.mode)),
      );
  }
  private saveNotes(): void {
    this.notes[this.mode] = {
      prediction: this.root.querySelector<HTMLTextAreaElement>(
        '[data-id="prediction"]',
      )!.value,
      explanation: this.root.querySelector<HTMLTextAreaElement>(
        '[data-id="explanation"]',
      )!.value,
    };
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(this.notes));
    } catch {
      this.error(
        t("학습 기록을 저장하지 못했습니다. 기록 내려받기를 사용하세요.", "Couldn't save your notes. Use Download notes instead."),
      );
    }
  }
  private prepare(): void {
    this.running = false;
    this.elapsed = 0;
    this.root.classList.remove("is-running", "has-result");
    this.error("");
    this.root.querySelector('[data-id="run"]')!.textContent =
      this.mode === "incline" ? t("같은 조건으로 동시 출발", "Start both together") : t("실험 시작", "Start experiment");
    this.controls();
    this.clearScene();
    this.root.querySelector<HTMLTextAreaElement>(
      '[data-id="prediction"]',
    )!.value = this.notes[this.mode]?.prediction ?? "";
    this.root.querySelector<HTMLTextAreaElement>(
      '[data-id="explanation"]',
    )!.value = this.notes[this.mode]?.explanation ?? "";
    this.results.classList.toggle("single", this.mode !== "incline");
    this.results.innerHTML =
      this.mode === "incline"
        ? '<article data-result="0"></article><article data-result="1"></article>'
        : '<article data-result="0"></article>';
    if (this.mode === "incline") this.buildIncline();
    else if (this.mode === "dust") this.buildDust();
    else if (this.mode === "energy") this.buildEnergy();
    else this.buildAscent();
    this.measure();
    this.updateScene(0);
  }
  private run(): void {
    if (this.running) {
      this.running = false;
      this.root.classList.remove("is-running");
      this.root.querySelector('[data-id="run"]')!.textContent =
        t("처음부터 다시 실험", "Run again from the start");
      return;
    }
    try {
      this.readSettings();
      this.saveNotes();
      this.prepare();
      this.running = true;
      this.root.classList.add("is-running");
      this.root.querySelector('[data-id="run"]')!.textContent =
        t("관찰 중 · 정지", "Observing · stop");
      this.measure();
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }
  }
  private mesh(
    geometry: THREE.BufferGeometry,
    color: number,
    metalness = 0.2,
    roughness = 0.5,
  ): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
    });
    this.resources.add(geometry);
    this.resources.add(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }
  private box(
    scene: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    color: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const m = this.mesh(new THREE.BoxGeometry(w, h, d), color);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  }
  private base(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc4d8d5);
    scene.fog = new THREE.Fog(0xc4d8d5, 50, 130);
    scene.environment = this.environment.texture;
    const hemi = new THREE.HemisphereLight(0xecf7ee, 0x344b52, 1.4);
    hemi.layers.enableAll(); // every camera, the ink mask's too (see inkOutline.ts)
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0da, 2.5);
    sun.layers.enableAll();
    sun.position.set(12, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -22;
    sun.shadow.camera.right = sun.shadow.camera.top = 22;
    sun.shadow.bias = -0.001;
    scene.add(sun);
    this.box(scene, 70, 0.3, 70, 0x42575c, 0, -0.3, 0);
    const grid = new THREE.GridHelper(60, 60, 0x899e94, 0x586e70);
    grid.position.y = -0.14;
    scene.add(grid);
    this.resources.add(grid.geometry);
    for (const m of (Array.isArray(grid.material)
      ? grid.material
      : [grid.material]) as THREE.Material[])
      this.resources.add(m);
    this.scenes.push(scene);
    return scene;
  }
  private machine(
    scene: THREE.Object3D,
    kind: "rover" | "ship",
  ): MachineVisual {
    const visual = new MachineVisual(this.assets);
    visual.rebuild(preset(kind));
    scene.add(visual.root);
    this.visuals.push(visual);
    return visual;
  }
  private setCamera(
    x: number,
    y: number,
    z: number,
    tx = 0,
    ty = 1,
    tz = 0,
  ): void {
    this.camera.position.set(x, y, z);
    this.camera.lookAt(tx, ty, tz);
  }
  private buildIncline(): void {
    const angle = (this.conditions.slopeDegrees * Math.PI) / 180;
    for (let i = 0; i < 2; i++) {
      const scene = this.base(),
        ramp = new THREE.Group();
      ramp.rotation.x = -angle;
      scene.add(ramp);
      this.box(ramp, 7, 0.35, 22, 0x64757a, 0, 0, 5);
      for (const x of [-3.3, 3.3])
        this.box(ramp, 0.12, 0.05, 22, 0xe6b65a, x, 0.21, 5);
      for (let z = -3; z <= 15; z++)
        this.box(
          ramp,
          6,
          0.018,
          0.035,
          z % 5 === 0 ? 0xf7ead1 : 0x9caeaa,
          0,
          0.19,
          z,
        );
      const visual = this.machine(scene, "rover");
      visual.root.rotation.x = -angle;
    }
    this.setCamera(17, 12, -15, 0, 2.8, 5);
  }
  private buildDust(): void {
    const scene = this.base();
    this.dust = new DustExperiment(this.fan, this.filter);
    this.box(scene, 13, 0.3, 5, 0x263d47, 0, 0.15, 0);
    const housing = this.mesh(
      new THREE.TorusGeometry(1.1, 0.12, 12, 32),
      0xe4b34c,
    );
    housing.rotation.y = Math.PI / 2;
    housing.position.set(-4.6, 1.6, 0);
    scene.add(housing);
    this.fanRotor = new THREE.Group();
    this.fanRotor.position.copy(housing.position);
    scene.add(this.fanRotor);
    for (let i = 0; i < 5; i++) {
      const blade = this.box(
        this.fanRotor,
        0.12,
        0.24,
        1,
        0xb9c9c7,
        0,
        0,
        0.48,
      );
      const pivot = new THREE.Group();
      this.fanRotor.remove(blade);
      pivot.rotation.x = (i * Math.PI * 2) / 5;
      this.fanRotor.add(pivot);
      pivot.add(blade);
      blade.rotation.y = 0.25;
    }
    this.box(scene, 0.3, 1.4, 0.3, 0xe3b65b, -4.6, 0.8, 0);
    if (this.filter) {
      for (const y of [0.45, 2.75])
        this.box(scene, 0.35, 0.2, 2.2, 0xe0b559, 1.6, y, 0);
      for (const z of [-1.1, 1.1])
        this.box(scene, 0.35, 2.4, 0.18, 0xe0b559, 1.6, 1.6, z);
      for (let z = -1; z <= 1.01; z += 0.2)
        this.box(scene, 0.05, 2.2, 0.024, 0x88c6b5, 1.62, 1.6, z);
      for (let y = 0.55; y <= 2.65; y += 0.2)
        this.box(scene, 0.05, 0.024, 2.1, 0x88c6b5, 1.62, y, 0);
    }
    const geometry = new THREE.IcosahedronGeometry(0.045, 0),
      material = new THREE.MeshStandardMaterial({
        color: 0xf4c064,
        emissive: 0x60431e,
        roughness: 1,
      });
    this.resources.add(geometry);
    this.resources.add(material);
    this.particles = new THREE.InstancedMesh(geometry, material, 240);
    this.captured = new THREE.InstancedMesh(geometry, material, 240);
    scene.add(this.particles, this.captured);
    this.setCamera(10, 6, 10, 0, 1.4, 0);
  }
  private buildEnergy(): void {
    const scene = this.base(),
      path = ENERGY_PATHS[this.source];
    const count = path.stages.length,
      step = 4,
      start = (-(count - 1) * step) / 2;
    for (let i = 0; i < count; i++) {
      const x = start + i * step;
      this.box(scene, 2.8, 0.35, 3, 0x263f49, x, 0.2, 0);
      if (i === count - 1) {
        const car = this.machine(scene, "rover");
        car.root.scale.setScalar(0.45);
        car.root.position.set(x, 1, 0);
      } else if (
        i === 0 &&
        (this.source === "hydrogen" || this.source === "fuel")
      ) {
        const tank = this.mesh(
          new THREE.CapsuleGeometry(0.6, 1.6, 6, 16),
          this.source === "hydrogen" ? 0x9fbace : 0xc88957,
        );
        tank.position.set(x, 1.8, 0);
        scene.add(tank);
        this.box(scene, 0.7, 0.2, 0.7, 0x293e49, x, 3, 0);
      } else if (this.source === "wind" && i < 2) {
        this.box(scene, 0.14, 2.3, 0.14, 0xd3ddd4, x, 1.5, 0);
        const rotor = new THREE.Group();
        rotor.position.set(x, 2.7, 0.2);
        scene.add(rotor);
        this.fanRotor = rotor;
        for (let k = 0; k < 3; k++) {
          const arm = new THREE.Group();
          arm.rotation.z = (k * Math.PI * 2) / 3;
          rotor.add(arm);
          this.box(arm, 0.14, 1.4, 0.08, 0xe6e7d4, 0, 0.65, 0);
        }
      } else {
        this.box(scene, 1.6, 1.7, 1.3, 0xd6dfd3, x, 1.2, 0);
        this.box(scene, 1.1, 0.75, 0.06, 0x284d5a, x, 1.4, 0.69);
        for (let k = 0; k < 3; k++)
          this.box(scene, 0.75, 0.08, 0.04, 0x85dac8, x, 1.2 + k * 0.2, 0.73);
      }
      if (i < count - 1) {
        const points = [
          new THREE.Vector3(x + 1, 0.6, 1.1),
          new THREE.Vector3(x + 1.5, 0.45, 1.4),
          new THREE.Vector3(x + step - 1.5, 0.45, 1.4),
          new THREE.Vector3(x + step - 1, 0.6, 1.1),
        ];
        const curve = new THREE.CatmullRomCurve3(points),
          color = CONNECTION_COLORS[path.kinds[i]!];
        const tube = this.mesh(
          new THREE.TubeGeometry(curve, 16, 0.06, 8, false),
          color,
        );
        scene.add(tube);
        this.links.push(points);
        const marker = this.mesh(new THREE.SphereGeometry(0.13, 8, 8), color);
        scene.add(marker);
        this.powerMarkers.push(marker);
      }
    }
    this.setCamera(12, 9, 15, 0, 1, 0);
  }
  private buildAscent(): void {
    const scene = this.base();
    this.box(scene, 11, 0.5, 11, 0xd7d9c4, 0, 0.15, 0);
    for (const x of [-4.8, 4.8])
      this.box(scene, 0.18, 0.08, 10, 0xe3aa43, x, 0.44, 0);
    const ship = this.machine(scene, "ship");
    ship.root.position.set(0, 2.5, 0);
    this.mascot = new CharacterRig();
    this.mascot.root.scale.setScalar(0.55);
    scene.add(this.mascot.root);
    const positions = new Float32Array(600 * 3);
    let s = 92;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < positions.length; i++)
      positions[i] = (rand() - 0.5) * 450;
    const geometry = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3),
    );
    const material = new THREE.PointsMaterial({
      color: 0xe6f5ff,
      size: 0.5,
      transparent: true,
      opacity: 0,
    });
    this.resources.add(geometry);
    this.resources.add(material);
    this.stars = new THREE.Points(geometry, material);
    scene.add(this.stars);
    this.planet = this.mesh(
      new THREE.SphereGeometry(85, 32, 20),
      0x326d8b,
      0,
      1,
    );
    this.planet.position.set(0, -85, 0);
    this.planet.visible = false;
    scene.add(this.planet);
    this.setCamera(12, 8, 14, 0, 2, 0);
  }
  fixedUpdate(dt: number): void {
    if (!this.active || !this.running) return;
    const duration = this.mode === "incline" ? this.conditions.seconds : 10;
    const delta = Math.min(dt, duration - this.elapsed);
    this.elapsed = Math.min(duration, this.elapsed + delta);
    if (this.dust) this.dust.step(delta);
    if (this.elapsed >= duration) {
      this.running = false;
      this.root.classList.remove("is-running");
      this.root.classList.add("has-result");
      this.root.querySelector('[data-id="run"]')!.textContent =
        t("같은 조건으로 다시 실험", "Run again with the same conditions");
      this.measure();
    }
  }
  private updateScene(dt: number): void {
    const label = this.stage.querySelector(".lab-stage-label")!;
    if (this.mode === "incline") {
      const angle = (this.conditions.slopeDegrees * Math.PI) / 180;
      this.visuals.forEach((v, i) => {
        const sample = inclineSample(
          this.conditions,
          this.ratios[i]!,
          this.elapsed,
        );
        const clearance = 0.2 + 0.65 + this.conditions.radius;
        v.root.position.set(
          0,
          clearance * Math.cos(angle) + sample.distance * Math.sin(angle),
          sample.distance * Math.cos(angle) - clearance * Math.sin(angle),
        );
        const b = preset("rover");
        b.parts.forEach((p, index) => {
          if (p.kind === "wheel")
            v.wheel(
              index,
              0.65,
              sample.distance / this.conditions.radius,
              0,
              this.conditions.radius / 0.58,
            );
        });
        v.flushWheels();
        this.results.querySelector(`[data-result="${i}"]`)!.innerHTML =
          `${i === 0 ? "A" : "B"} · ${t("기어비", "gear ratio")} ${this.ratios[i]!.toFixed(1)} : 1<b>${sample.distance.toFixed(2)} m</b><small>${t("바퀴 구동력", "Wheel force")} ${sample.wheelForce.toFixed(2)} N · ${sample.speed.toFixed(2)} m/s</small><small>${sample.slipping ? t("접지 한계 · 미끄럼 발생", "Grip limit · wheels slipping") : `${t("경사 저항", "Slope resistance")} ${(sample.gravityForce + sample.resistance).toFixed(2)} N`}</small>`;
      });
      label.textContent = t(`동일 카메라 · 동시점 ${this.elapsed.toFixed(2)} / ${this.conditions.seconds.toFixed(2)}초 · 실제 계산 결과 / 단순 힘 모델`, `Same camera · same moment ${this.elapsed.toFixed(2)} / ${this.conditions.seconds.toFixed(2)} s · computed result / simple force model`);
    } else if (this.mode === "dust" && this.dust) {
      let moving = 0,
        collected = 0;
      for (const p of this.dust.particles) {
        if (p.status === "escaped") continue;
        this.matrix.makeTranslation(p.x, p.y + 1.6, p.z);
        if (p.status === "captured")
          this.captured!.setMatrixAt(collected++, this.matrix);
        else this.particles!.setMatrixAt(moving++, this.matrix);
      }
      this.particles!.count = moving;
      this.captured!.count = collected;
      this.particles!.instanceMatrix.needsUpdate = true;
      this.captured!.instanceMatrix.needsUpdate = true;
      this.particles!.computeBoundingSphere();
      this.captured!.computeBoundingSphere();
      if (this.fanRotor)
        this.fanRotor.rotation.x = this.elapsed * this.fan * 10;
      const c = this.dust.counts();
      this.results.innerHTML = `<article>${t("팬", "Fan")} ${this.fan.toFixed(2)} · ${t("필터", "filter")} ${this.filter ? t("연결", "on") : t("해제", "off")}<b>${c.captured} / ${c.total}</b><small>${t("포집된 입자", "particles caught")}</small><small>${t("이동", "moving")} ${c.moving} · ${t("유출", "escaped")} ${c.escaped} · ${t("침강", "settled")} ${c.settled}</small></article>`;
      label.textContent = t(`고정 시드 · ${this.elapsed.toFixed(1)} / 10초 · 모의 입자 이동과 포집`, `Fixed seed · ${this.elapsed.toFixed(1)} / 10 s · simulated particle drift and capture`);
    } else if (this.mode === "energy") {
      const flow = energyFlow(this.source, this.inputPower);
      this.powerMarkers.forEach((m, i) => {
        const curve = new THREE.CatmullRomCurve3(this.links[i]);
        m.position.copy(curve.getPoint((this.elapsed * 0.55 + i * 0.17) % 1));
        m.visible = this.inputPower > 0;
      });
      if (this.fanRotor) this.fanRotor.rotation.z = this.elapsed * 2;
      this.visuals.forEach((v) => {
        preset("rover").parts.forEach((p, i) => {
          if (p.kind === "wheel")
            v.wheel(i, 0.65, (this.elapsed * flow.outputWatts) / 40, 0);
        });
        v.flushWheels();
      });
      this.results.innerHTML = `<article>${ENERGY_PATHS[this.source].name} ${t("전환 경로", "conversion path")}<b>${flow.outputWatts.toFixed(1)} W</b><small>${t("바퀴에 전달되는 기계적 출력", "mechanical power reaching the wheels")}</small><small>${t("입력", "input")} ${flow.inputWatts.toFixed(1)} W = ${t("출력", "output")} ${flow.outputWatts.toFixed(1)} + ${t("손실", "loss")} ${flow.lossWatts.toFixed(1)} W</small></article>`;
      label.textContent = `${ENERGY_PATHS[this.source].stages.join(" → ")} · ${t("설명용 효율 가정", "illustrative efficiencies")}`;
    } else if (this.mode === "ascent") {
      const state = ascentSequence(this.elapsed),
        ship = this.visuals[0]!;
      ship.root.position.y = 2.5 + state.altitude;
      ship.thrust(state.phase === "ascent" ? 1 : 0, false, this.elapsed);
      const seat = new THREE.Vector3(0, 4.15 + state.altitude, 1);
      if (this.mascot) {
        this.mascot.root.position.copy(
          new THREE.Vector3(-4, 0.45, 2).lerp(seat, state.boarding),
        );
        this.mascot.root.rotation.y =
          state.phase === "boarding" ? Math.PI / 2 : 0;
        this.mascot.update(
          state.phase === "boarding" ? "run" : "idle",
          state.phase === "boarding" ? 2 : 0,
          dt,
        );
      }
      const scene = this.scenes[0]!;
      scene.background = new THREE.Color(0xc4d8d5).lerp(
        new THREE.Color(0x050d23),
        state.spaceBlend,
      );
      scene.fog = null;
      if (this.stars) {
        this.stars.material.opacity = state.spaceBlend;
        this.stars.position.y = state.altitude;
      }
      if (this.planet) this.planet.visible = state.altitude > 15;
      this.setCamera(12, 8 + state.altitude, 14, 0, 2 + state.altitude, 0);
      this.results.innerHTML = `<article>${state.phase === "boarding" ? t("탑승 중", "Boarding") : t("추진기 점화 · 상승", "Thrusters lit · rising")}<b>${state.altitude.toFixed(1)} m</b><small>${t("연출상 상승 높이", "staged height")} · ${this.elapsed.toFixed(1)} / 10${t("초", " s")}</small><small>${t("캐릭터 동반 · 카메라 추적 · 하늘 전환", "character aboard · camera follows · sky changes")}</small></article>`;
      label.textContent =
        t("실제 실행 화면 · 탑승·상승 시퀀스 / 궤도·연료 시뮬레이션 아님", "Live view · boarding and launch sequence / not an orbit or fuel simulation");
    }
  }
  render(dt: number): void {
    if (!this.active) return;
    this.updateScene(dt);
    if (!this.width || !this.height) return;
    this.renderer.setScissorTest(true);
    const count = this.scenes.length,
      viewWidth = Math.floor(this.width / count);
    this.camera.aspect = viewWidth / this.height;
    this.camera.updateProjectionMatrix();
    this.scenes.forEach((scene, i) => {
      this.renderer.setViewport(i * viewWidth, 0, viewWidth, this.height);
      this.renderer.setScissor(i * viewWidth, 0, viewWidth, this.height);
      this.renderer.render(scene, this.camera);
    });
    this.renderer.setScissorTest(false);
  }
  snapshot() {
    return {
      revision: EXPERIMENT_REVISION,
      active: this.active,
      experiment: this.mode,
      elapsed: this.elapsed,
      running: this.running,
      conditions: { ...this.conditions },
      ratios: [...this.ratios],
      incline: this.ratios.map((r) =>
        inclineSample(this.conditions, r, this.elapsed),
      ),
      dust: this.dust?.counts() ?? null,
      energy:
        this.mode === "energy"
          ? energyFlow(this.source, this.inputPower)
          : null,
      ascent: this.mode === "ascent" ? ascentSequence(this.elapsed) : null,
      camera: this.camera.position.toArray(),
      notes: this.notes[this.mode] ?? { prediction: "", explanation: "" },
    };
  }
  private exportReport(): void {
    this.saveNotes();
    const report = {
      ...this.snapshot(),
      createdAt: new Date().toISOString(),
      model:
        "Educational simplified model; not measured student learning outcomes",
      assumptions: {
        incline:
          "Constant torque, ideal gearbox, holding brake, 6.9 N reference resistance, traction coefficient 0.9; no aerodynamic drag or rotating inertia",
        dust: {
          seed: 42,
          particles: 240,
          efficiency: 0.85,
          fan: this.fan,
          filter: this.filter,
        },
        energy: {
          source: this.source,
          efficiencies: ENERGY_PATHS[this.source].efficiencies,
        },
        ascent:
          "Time-based boarding and ascent presentation, not orbital physics",
      },
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `craftyap-${this.mode}-experiment.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private clearScene(): void {
    for (const v of this.visuals) v.dispose();
    this.visuals.length = 0;
    if (this.mascot) {
      disposeRig(this.mascot.root);
      this.mascot = null;
    }
    this.particles?.dispose();
    this.captured?.dispose();
    this.particles = this.captured = null;
    for (const r of this.resources) r.dispose();
    this.resources.clear();
    for (const scene of this.scenes) {
      scene.traverse((o) => {
        if (o instanceof THREE.DirectionalLight) o.shadow.map?.dispose();
      });
      scene.clear();
    }
    this.scenes.length = 0;
    this.fanRotor = null;
    this.planet = null;
    this.stars = null;
    this.powerMarkers = [];
    this.links = [];
    this.dust = null;
  }
  dispose(): void {
    this.saveNotes();
    this.events.abort();
    this.resize.disconnect();
    this.clearScene();
    this.environment.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}
