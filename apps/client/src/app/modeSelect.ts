export type GameMode = "tower" | "builder" | "craft" | "battle" | "cinematic" | "field";

const MODES: readonly GameMode[] = ["tower", "builder", "craft", "battle", "cinematic", "field"];

/**
 * First screen: pick education or games, then (for games) which game.
 * `?mode=tower|builder|field|…` deep-links straight in (also used by the E2E
 * harnesses). Resolves once with the chosen mode.
 */
export function selectMode(parent: HTMLElement): Promise<GameMode> {
  const param = new URLSearchParams(location.search).get("mode");
  if (MODES.includes(param as GameMode)) return Promise.resolve(param as GameMode);

  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "screen mode-screen";
    el.innerHTML = `
      <div class="screen-card">
        <img class="brand-logo" src="/craftyap-logo.png" alt="CraftYap" />
        <div class="mode-step" data-step="category">
          <h1>어떤 모드로 할까요?</h1>
          <button class="mode-btn" data-pick="field">
            <img class="mode-icon" src="/textures/blocks/grass-top.png" alt="" />
            <span class="mode-text"><b>교육 모드</b><small>끝없이 펼쳐진 빈 들판 &mdash; 마음껏 만들고 실험해요</small></span>
          </button>
          <button class="mode-btn" data-pick="games">
            <img class="mode-icon" src="/ui/icon-tower.png" alt="" />
            <span class="mode-text"><b>게임 모드</b><small>Craft Island, Daily Tower, Robo Builder, Blast Royale</small></span>
          </button>
          <a class="desk-link" href="/?read=1">Read the CraftYap desk &rarr;</a>
        </div>
        <div class="mode-step" data-step="games" hidden>
          <h1>Which game shall we play?</h1>
          <p class="play-kicker">NEW &middot; Craft Island has a machine workshop &mdash; build cars and aircraft that really drive and fly</p>
          <button class="mode-btn" data-mode="craft">
            <img class="mode-icon" src="/textures/blocks/workbench-top.png" alt="" />
            <span class="mode-text"><b>Craft Island <em class="mode-new">NEW</em></b><small>Mine and build &mdash; then bolt parts into machines and test drive them</small></span>
          </button>
          <button class="mode-btn" data-mode="tower">
            <img class="mode-icon" src="/ui/icon-tower.png" alt="" />
            <span class="mode-text"><b>Daily Tower</b><small>A fresh multiplayer obby to climb every day</small></span>
          </button>
          <button class="mode-btn" data-mode="builder">
            <img class="mode-icon" src="/ui/icon-builder.png" alt="" />
            <span class="mode-text"><b>Robo Builder</b><small>Idle construction &mdash; watch your crew raise landmarks</small></span>
          </button>
          <button class="mode-btn" data-mode="battle">
            <img class="mode-icon" src="/textures/blocks/ruby-ore.png" alt="" />
            <span class="mode-text"><b>Blast Royale</b><small>Arcade battle royale &mdash; last robot standing wins</small></span>
          </button>
          <button class="desk-link mode-back" type="button">&larr; 모드 선택으로</button>
        </div>
      </div>`;
    parent.appendChild(el);

    const steps = el.querySelectorAll<HTMLElement>(".mode-step");
    const show = (step: string) => steps.forEach((s) => (s.hidden = s.dataset.step !== step));
    const choose = (mode: GameMode) => {
      el.remove();
      resolve(mode);
    };

    el.querySelector<HTMLButtonElement>('[data-pick="field"]')!.addEventListener("click", () => choose("field"));
    el.querySelector<HTMLButtonElement>('[data-pick="games"]')!.addEventListener("click", () => show("games"));
    el.querySelector<HTMLButtonElement>(".mode-back")!.addEventListener("click", () => show("category"));
    el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => choose(btn.dataset.mode as GameMode));
    });
  });
}
