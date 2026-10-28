// Notify IndexNow only after a successful deploy and public-site smoke check.
// The domain-verification token is intentionally hosted in a public text file.
// Usage: node tools/notify-indexnow.mjs [--dry-run] [--changed-only]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const origin = "https://craftyap.com";
const key = readFileSync(new URL("apps/client/public/indexnow-key.txt", root), "utf8").trim();
if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) throw new Error("invalid IndexNow verification key");
const sitemap = readFileSync(new URL("apps/client/public/sitemap.xml", root), "utf8");
let urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
for (const value of urlList) {
  const url = new URL(value);
  if (url.origin !== origin || url.search || url.hash || url.username || url.password) {
    throw new Error("IndexNow accepts only public canonical URLs on craftyap.com");
  }
}
urlList = [...new Set(urlList)];
if (!urlList.length || urlList.length > 10000) throw new Error("invalid IndexNow URL count");

const baseSha = process.env.INDEXNOW_BASE_SHA;
if (process.argv.includes("--changed-only") && baseSha && !/^0+$/.test(baseSha)) {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("invalid base commit");
  const changed = new Set(execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/));
  const allChanged = changed.has("apps/client/public/indexnow-key.txt") || changed.has("apps/client/public/sitemap.xml");
  urlList = urlList.filter((value) => {
    if (allChanged) return true;
    const pathname = new URL(value).pathname;
    const html = pathname === "/" ? "apps/client/index.html" : `apps/client/public${pathname}index.html`;
    return changed.has(html);
  });
}

if (!urlList.length) {
  console.log("No public search pages changed; IndexNow notification skipped.");
} else if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ host: "craftyap.com", keyLocation: `${origin}/indexnow-key.txt`, urlList }, null, 2));
} else {
  const keyLocation = `${origin}/indexnow-key.txt`;
  const verification = await fetch(keyLocation, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!verification.ok || verification.headers.get("content-type")?.split(";")[0] !== "text/plain" || (await verification.text()).trim() !== key) {
    throw new Error("deployed IndexNow verification file is missing or mismatched");
  }
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: "craftyap.com", key, keyLocation, urlList }),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  await response.body?.cancel();
  if (![200, 202].includes(response.status)) throw new Error(`IndexNow notification failed: HTTP ${response.status}`);
  console.log(`IndexNow received ${urlList.length} URL(s): HTTP ${response.status}${response.status === 202 ? " (key validation pending)" : ""}. Indexing is not guaranteed.`);
  for (const url of urlList) console.log(url);
}
