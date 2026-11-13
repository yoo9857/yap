// The teacher's quiz as a student sees it (fireQuiz.ts), photographed round by round: one round of
// every kind (pick, press the place, dial, put in order, do / don't) fresh, half played and judged,
// then the result — at 1600×900 and again as a phone on its side (844×390). This is how the quiz's
// look gets judged. Needs `pnpm dev`.
//
//   node tools/shot-fire-quiz.mjs [outdir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? "shots-quiz";
const URL = process.env.URL ?? "http://localhost:5173/?mode=field&theme=fire&reset=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1600,900"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(tag, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on("pageerror", (e) => console.log(`[${tag}] page error: ${e.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__roboCraft?.fire?.(), { timeout: 120000 });
  await sleep(1500);
  // one round of every kind, in a fixed order, over the game as it is
  const kinds = await page.evaluate(async () => {
    const rules = await import("/src/craft/fire/quizRules.ts");
    const { openQuizPanel } = await import("/src/craft/fire/fireQuiz.ts");
    const pool = rules.quizPool();
    const rounds = ["pick", "spot", "dial", "order", "sort"].map((k) => pool.find((r) => r.kind === k)).filter(Boolean)
      // (a quiz deals a sort round four cards: two to do, two not to)
      .map((r) => (r.kind === "sort" ? { ...r, cards: [...r.cards.filter((c) => c.good).slice(0, 2), ...r.cards.filter((c) => !c.good).slice(0, 2)].sort((a, b) => a.label.localeCompare(b.label)) } : r));
    globalThis.__quizRounds = rounds;
    globalThis.__quiz = openQuizPanel(rounds, { progress() {}, close() { globalThis.__quiz.close(); } });
    return rounds.map((r) => r.kind);
  });
  let n = 0;
  const shot = async (name) => {
    await sleep(650);
    const file = join(OUT, `${tag}-${String(++n).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };
  // (the aiming rings are zero-size buttons with drawn children: clicked from the page, not by position)
  const click = async (sel, i = 0) => { await page.$$eval(sel, (els, i) => els[i].click(), i); await sleep(120); };
  const round = (i) => page.evaluate((i) => globalThis.__quizRounds[i], i);
  const next = () => click('.fz-foot [data-id="next"]');

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i], r = await round(i);
    await shot(kind);
    if (kind === "pick") {
      await click(".fz-tile", r.answer === 0 ? 1 : 0); // a wrong one: the right one is shown
      await shot("pick-wrong");
    } else if (kind === "spot") {
      await click(".fz-ring", r.answer);
      await shot("spot-right");
    } else if (kind === "dial") {
      for (const k of ["1", "1"]) await click(`.fz-key[data-k="${k}"]`);
      await shot("dial-typing");
      await click('.fz-key[data-k="9"]');
      await click('.fz-key[data-k="call"]');
      await shot("dial-right");
    } else if (kind === "order") {
      await click(`.fz-tray .fz-tile[data-k="${r.order[0]}"]`);
      await click(`.fz-tray .fz-tile[data-k="${r.order[1]}"]`);
      await shot("order-half");
      await click(`.fz-tray .fz-tile[data-k="${r.order[3]}"]`); // the last two the wrong way round
      await click(`.fz-tray .fz-tile[data-k="${r.order[2]}"]`);
      await sleep(500);
      await shot("order-fixed");
    } else {
      for (let k = 0; k < r.cards.length; k++) {
        await click(r.cards[k].good ? ".fz-o" : ".fz-x");
        await sleep(260);
        if (k === 1) await shot("sort-half");
      }
      await shot("sort-right");
    }
    await next();
  }
  await sleep(900);
  await shot("result");
  await page.close();
}

// (a dev server that reloads the page mid-run — someone saved a file — takes the quiz away: again)
async function steady(tag, viewport) {
  for (let attempt = 1; ; attempt++) {
    try { return await run(tag, viewport); } catch (e) {
      if (attempt === 3) throw e;
      console.log(`[${tag}] interrupted (${e.message}); again`);
      for (const p of (await browser.pages()).slice(1)) await p.close();
    }
  }
}
await steady("pc", { width: 1600, height: 900 });
await steady("phone", { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await browser.close();
