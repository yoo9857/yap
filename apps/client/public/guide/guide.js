// Progressive enhancements; game information remains readable without JS.
document.documentElement.classList.add("js");
const header = document.querySelector(".site-header");
const toggle = document.querySelector(".nav-toggle");
if (header && toggle) {
  toggle.hidden = false;
  const closeNav = () => { header.classList.remove("nav-open"); toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-label", "메뉴 열기"); };
  toggle.addEventListener("click", () => { const open = header.classList.toggle("nav-open"); toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기"); });
  document.querySelectorAll(".header-nav a").forEach((link) => link.addEventListener("click", closeNav));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeNav(); });
}
const scenes = {
  island: { caption: "나만의 섬, 나만의 모험.", alt: "블록 마을을 탐험하는 로봇과 반려동물, 크래프트얍 실제 게임 화면", count: "01 / 03" },
  workshop: { caption: "내가 조립한 기계가 하늘을 날 때.", alt: "기계 작업실에서 조립한 비행체가 블록 섬 위를 날아가는 실제 게임 화면", count: "02 / 03" },
  tower: { caption: "한 번 더 점프. 오늘의 꼭대기를 향해!", alt: "알록달록한 블록 발판을 오르는 Daily Tower의 실제 게임 화면", count: "03 / 03" },
};
const switcher = document.querySelector(".scene-switcher");
const sceneImage = document.querySelector("#hero-scene");
if (switcher && sceneImage) {
  switcher.hidden = false;
  switcher.querySelectorAll("button[data-scene]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.scene;
    const scene = scenes[key];
    if (!scene) return;
    const path = `/guide/assets/${key}.webp`;
    sceneImage.src = path; sceneImage.alt = scene.alt; sceneImage.closest("a").href = path;
    document.querySelector("#scene-caption").textContent = scene.caption;
    document.querySelector(".scene-count").textContent = scene.count;
    switcher.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  }));
}
const dialog = document.querySelector(".image-dialog");
if (dialog && typeof dialog.showModal === "function") {
  let trigger;
  document.querySelectorAll("a[data-lightbox]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault(); trigger = link;
    const image = dialog.querySelector("img");
    image.src = link.href; image.alt = link.querySelector("img")?.alt ?? "크래프트얍 실제 게임 플레이 화면";
    dialog.showModal(); document.body.classList.add("dialog-open");
  }));
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { document.body.classList.remove("dialog-open"); trigger?.focus(); });
}
