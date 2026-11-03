// Hub rooms E2E: two players in separate browsers. Host creates a public room,
// the guest finds it in the list, joins, says ready, the host starts "build"
// and both land in the same shared field. A third player joins mid-game by
// code and goes straight in. Back from the game, the hub re-opens the seat.
// A Daily Tower room hands its code to the tower client. Needs `pnpm dev`.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function player(name) {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1440,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("robo-name", n); } catch { /* storage off: the hub asks for a name */ } }, name);
  await page.goto(`${BASE}/?play=1`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.click('[data-pick="games"]');
  await wait(800);
  // an idle hub holds no room socket (a deploy waits for live sockets to finish)
  const idle = await page.evaluate(() => !document.querySelector('[data-id="party-status"]')?.dataset.state);
  return { browser, page, errors, idle };
}

const host = await player("호스트");
const guest = await player("게스트1");
try {
  check("an idle hub opens no room connection", host.idle && guest.idle);
  // 1) create a public room
  await host.page.click('[data-id="party-create"]');
  await host.page.waitForSelector(".party-dialog form");
  await host.page.$eval('[data-id="pd-title"]', (el) => { el.value = "E2E 방"; });
  await host.page.click(".party-dialog .party-go");
  await host.page.waitForSelector(".party-wait", { timeout: 5000 });
  const code = await host.page.$eval(".party-code-chip b", (el) => el.textContent);
  check("host creates a room and lands in its waiting room", /^[A-Z2-9]{6}$/.test(code), code);

  // 2) the guest sees it in the list and joins
  await guest.page.click('[data-id="party-browse"]');
  await guest.page.waitForSelector(`[data-code="${code}"]`, { visible: true, timeout: 5000 });
  check("the public room appears in another player's list", true);
  await guest.page.$eval(`[data-code="${code}"]`, (el) => el.click());
  await guest.page.waitForSelector(".party-wait", { timeout: 5000 }).catch(async () => {
    const toast = await guest.page.$eval(".hub-toast", (el) => el.textContent).catch(() => "");
    const dialog = await guest.page.$eval(".party-dialog", (el) => el.textContent.trim().slice(0, 80)).catch(() => "");
    throw new Error(`guest never reached the waiting room (toast: ${toast} | dialog: ${dialog})`);
  });
  await host.page.waitForFunction(() => document.querySelectorAll(".party-slot:not(.open):not(.closed), .party-roster li").length === 2, { timeout: 5000 });
  check("both players are seated in the host's waiting room", true);

  // 3) start needs the guest ready
  const disabled = await host.page.$eval('[data-act="start"]', (b) => b.disabled);
  check("start is disabled until the guest is ready", disabled);
  await guest.page.click('[data-act="ready"]');
  await host.page.waitForFunction(() => !document.querySelector('[data-act="start"]')?.disabled, { timeout: 5000 });
  check("the guest's ready enables start", true);

  // chat
  await guest.page.type('[data-id="pw-chat"] input', "안녕하세요");
  await guest.page.keyboard.press("Enter");
  await host.page.waitForFunction(() => document.querySelector('[data-id="pw-log"]')?.textContent.includes("안녕하세요"), { timeout: 5000 });
  check("waiting-room chat reaches the host", true);

  // 4) start → both in the same party field
  await Promise.all([
    host.page.waitForNavigation({ timeout: 15000 }),
    guest.page.waitForNavigation({ timeout: 15000 }),
    host.page.click('[data-act="start"]'),
  ]);
  check("start moves both into the game", host.page.url().includes(`party=${code}`) && guest.page.url().includes("mode=field"), guest.page.url());
  for (const p of [host, guest]) await p.page.waitForFunction(() => !!globalThis.__roboCraft?.classroom?.(), { timeout: 30000 });
  await guest.page.bringToFront();
  await wait(1500);
  const hostClass = JSON.stringify(await host.page.evaluate(() => globalThis.__roboCraft.classroom()));
  check("the host's field lists both players", hostClass.includes("호스트") && hostClass.includes("게스트1"), hostClass.slice(0, 160));
  const sees = await guest.page.waitForFunction(
    () => JSON.stringify(globalThis.__roboCraft.classroom()).includes("호스트"),
    { timeout: 10000 },
  ).then(() => true, () => false);
  check("the guest sees the host in the same field", sees);

  // 5) a third player joins mid-game by code and goes straight in
  const late = await player("늦은친구");
  await late.page.click('[data-id="party-browse"]');
  await late.page.waitForSelector('[data-id="party-codebar-input"]', { visible: true });
  await late.page.type('[data-id="party-codebar-input"]', code.toLowerCase());
  await Promise.all([late.page.waitForNavigation({ timeout: 15000 }), late.page.click('[data-id="party-codebar"] button')]);
  check("joining a playing room by code goes straight into its game", late.page.url().includes(`party%3A${code}`) || late.page.url().includes(`party:${code}`), late.page.url());
  await late.browser.close();

  // 6) back to the hub: the seat re-opens the waiting room (game still running)
  await guest.page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await guest.page.waitForSelector(".party-wait", { timeout: 10000 });
  const playing = await guest.page.$eval(".party-wait-foot", (el) => el.textContent);
  check("home from the game lands back in the room, which shows it is playing", playing.includes("진행 중"), playing.trim().slice(0, 40));

  // 7) leaving gives up the seat
  await guest.page.click('[data-id="pw-leave"]');
  await guest.page.waitForFunction(() => !document.querySelector(".party-wait"), { timeout: 5000 });
  const seat = await guest.page.evaluate(() => sessionStorage.getItem("craftyap-party-seat"));
  check("나가기 leaves the room and forgets the seat", seat === null);

  // 8) a Daily Tower room hands its code to the tower
  await guest.page.click('[data-id="party-create"]');
  await guest.page.waitForSelector(".party-dialog form");
  await guest.page.click('.party-dialog input[value="tower"]');
  await guest.page.click(".party-dialog .party-go");
  await guest.page.waitForSelector('[data-act="start"]', { timeout: 5000 });
  await Promise.all([guest.page.waitForNavigation({ timeout: 15000 }), guest.page.click('[data-act="start"]')]);
  check("a tower room starts the tower with the room code", /mode=tower/.test(guest.page.url()) && /party=[A-Z2-9]{6}/.test(guest.page.url()), guest.page.url());
  // a second player in the same tower party shares the tower room; a stranger does not
  const towerCode = new URL(guest.page.url()).searchParams.get("party");
  const enterTower = async (page) => {
    await page.waitForSelector('[data-id="start"]', { timeout: 30000 });
    await page.click('[data-id="start"]');
    await page.waitForFunction(() => globalThis.__robo?.net?.()?.connected !== false && !!globalThis.__robo?.net?.(), { timeout: 15000 });
  };
  await enterTower(guest.page);
  await host.page.goto(`${BASE}/?mode=tower&party=${towerCode}`, { waitUntil: "networkidle2" });
  await enterTower(host.page);
  const stranger = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
  const sp = await stranger.newPage();
  await sp.evaluateOnNewDocument(() => { try { localStorage.setItem("robo-name", "남남"); } catch { /* storage off */ } });
  await sp.goto(`${BASE}/?mode=tower`, { waitUntil: "networkidle2" });
  await enterTower(sp);
  await guest.page.bringToFront();
  const together = await guest.page.waitForFunction(
    () => globalThis.__robo.net().remotes.some((r) => r.name === "호스트"),
    { timeout: 10000 },
  ).then(() => true, () => false);
  await wait(1500);
  const names = await guest.page.evaluate(() => globalThis.__robo.net().remotes.map((r) => r.name));
  check("tower party members share one tower room, strangers are kept out", together && !names.includes("남남"), JSON.stringify(names));
  await stranger.close();

  const errs = [...host.errors, ...guest.errors].filter((e) => !/WebGL|context/i.test(e));
  check("no browser errors", errs.length === 0, errs.join(" | "));
} catch (err) {
  check("party flow ran to the end", false, err.message);
} finally {
  await host.browser.close();
  await guest.browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
