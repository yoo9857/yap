export type GameMode = "tower" | "builder" | "craft" | "battle" | "cinematic";

/**
 * First screen: pick a game. `?mode=tower|builder` deep-links straight in
 * (also used by the E2E harnesses). Resolves once with the chosen mode.
 */
export function selectMode(parent: HTMLElement): Promise<GameMode> {
  const param = new URLSearchParams(location.search).get("mode");
  if (
    param === "tower" ||
    param === "builder" ||
    param === "craft" ||
    param === "battle" ||
    param === "cinematic"
  ) {
    return Promise.resolve(param);
  }

  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "screen mode-screen";
    el.innerHTML = `
      <div class="screen-card">
        <img class="brand-logo" src="/craftyap-logo.png" alt="CraftYap" />
        <h1 class="creator-title">Build income. Work smarter.</h1>
        <p class="subtitle">CraftYap breaks down practical online income ideas, side hustles, and AI tools into steps you can actually try.</p>
        <div class="topic-pills" aria-label="CraftYap topics">
          <span>Side Hustles 2026</span><span>Make Money Online</span><span>AI Income</span><span>Creator Monetization</span>
        </div>
        <p class="play-kicker">Take a quick break with a CraftYap game</p>
        <button class="mode-btn" data-mode="tower">
          <img class="mode-icon" src="/ui/icon-tower.png" alt="" />
          <span class="mode-text"><b>Daily Tower</b><small>A fresh multiplayer obby to climb every day</small></span>
        </button>
        <button class="mode-btn" data-mode="builder">
          <img class="mode-icon" src="/ui/icon-builder.png" alt="" />
          <span class="mode-text"><b>Robo Builder</b><small>Idle construction — watch your crew raise landmarks</small></span>
        </button>
        <button class="mode-btn" data-mode="craft">
          <img class="mode-icon" src="/textures/blocks/workbench-top.png" alt="" />
          <span class="mode-text"><b>Craft Island</b><small>Mine, craft and build on your own voxel island</small></span>
        </button>
        <button class="mode-btn" data-mode="battle">
          <img class="mode-icon" src="/textures/blocks/ruby-ore.png" alt="" />
          <span class="mode-text"><b>Blast Royale</b><small>Arcade battle royale — last robot standing wins</small></span>
        </button>
      </div>`;
    parent.appendChild(el);

    el.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode as GameMode;
        el.remove();
        resolve(mode);
      });
    });
  });
}
