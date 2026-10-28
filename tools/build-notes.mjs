// Turns notes/*.md into the public dev log at /note/ — static, crawlable pages.
// The output is committed (like the machine GLB), so the server needs nothing
// new and IndexNow sees each post as its own changed HTML file.
// Usage: node tools/build-notes.mjs [--check]   (--check: fail if output is stale)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const root = new URL("../", import.meta.url);
const SRC = new URL("notes/", root);
const PUBLIC = new URL("apps/client/public/", root);
const OUT = new URL("note/", PUBLIC);
const ORIGIN = "https://craftyap.com";
const MARKER = '<meta name="generator" content="tools/build-notes.mjs" />';
const check = process.argv.includes("--check");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const json = (v) => JSON.stringify(v, null, 2).replace(/</g, "\\u003c");
const dot = (date) => date.replaceAll("-", ".");
// Static files are cached; a content hash in the query keeps pages and styles in step.
// Hashed with LF endings so a Windows (autocrlf) checkout and CI agree.
const versioned = (path) => `${path}?v=${createHash("sha256").update(readFileSync(new URL(path.slice(1), PUBLIC), "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 10)}`;

// ---- read sources ------------------------------------------------------------
function parse(file) {
  const raw = readFileSync(new URL(file, SRC), "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${file}: missing front matter (--- title/date/summary ---)`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const slug = file.slice(0, -3);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`${file}: file name must be lowercase-kebab (it becomes the URL)`);
  for (const key of ["title", "date", "summary"]) if (!meta[key]) throw new Error(`${file}: front matter needs "${key}"`);
  for (const key of ["date", "updated"]) {
    if (meta[key] && !/^\d{4}-\d{2}-\d{2}$/.test(meta[key])) throw new Error(`${file}: ${key} must be YYYY-MM-DD`);
  }
  if (meta.draft === "true") return null;
  return {
    slug,
    title: meta.title,
    date: meta.date,
    updated: meta.updated ?? meta.date,
    summary: meta.summary,
    tags: meta.tags ? meta.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    html: marked.parse(m[2], { async: false }),
    url: `${ORIGIN}/note/${slug}/`,
  };
}

const notes = (existsSync(SRC) ? readdirSync(SRC) : [])
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map(parse)
  .filter(Boolean)
  .sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));
const newest = notes.reduce((d, n) => (n.updated > d ? n.updated : d), "2026-10-28");

// ---- page templates ------------------------------------------------------------
const assets = { guideCss: versioned("/guide/guide.css"), noteCss: versioned("/note/note.css"), guideJs: versioned("/guide/guide.js") };

function page({ title, description, canonical, type, jsonLd, body }) {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta name="theme-color" content="#ffd21c" />
    ${MARKER}
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" type="application/atom+xml" title="크래프트얍 개발 노트" href="/note/feed.xml" />
    <link rel="icon" type="image/png" href="/craftyap-logo.png" />
    <link rel="stylesheet" href="${assets.guideCss}" />
    <link rel="stylesheet" href="${assets.noteCss}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Jua&family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet" />
    <meta property="og:type" content="${type}" />
    <meta property="og:locale" content="ko_KR" />
    <meta property="og:site_name" content="크래프트얍(CraftYap)" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ORIGIN}/craftyap-banner.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="675" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${ORIGIN}/craftyap-banner.jpg" />
    <script type="application/ld+json">
${json(jsonLd)}
    </script>
    <script src="${assets.guideJs}" defer></script>
  </head>

  <body>
    <a class="skip-link" href="#content">본문으로 이동</a>
    <header class="site-header"><div class="header-inner">
      <a class="brand" href="/" aria-label="크래프트얍 게임 홈"><img src="/craftyap-logo.png" width="64" height="64" alt="" /><span>크래프트얍<small>CRAFTYAP</small></span></a>
      <nav class="header-nav" id="site-nav" aria-label="주요 메뉴"><a href="/note/">개발 노트</a><a href="/guide/">게임 안내</a><a href="/guide/#controls">조작법</a><a href="/guide/#faq">FAQ</a></nav>
      <a class="button button-dark header-play" href="/">지금 플레이 <span aria-hidden="true">↗</span></a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="메뉴 열기" hidden><span></span><span></span></button>
    </div></header>
    <main id="content" class="note-main section-shell">
${body}
    </main>
    <footer class="site-footer section-shell"><div><a class="footer-brand" href="/">크래프트얍 <span>CraftYap</span></a><p>블록 하나에서 시작되는, 네가 만드는 세상.</p></div><nav aria-label="하단 메뉴"><a href="/">게임 홈</a><a href="/note/">개발 노트</a><a href="/guide/">게임 안내</a><a href="/note/feed.xml">RSS</a><a href="#content">맨 위로 ↑</a></nav><small>크래프트얍 개발 노트 · <time datetime="${newest}">${dot(newest)} 업데이트</time></small></footer>
  </body>
</html>
`;
}

const tagList = (tags) => (tags.length ? `<ul class="note-tags" aria-label="태그">${tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "");
const dateLine = (n) => `<time datetime="${n.date}">${dot(n.date)}</time>${n.updated !== n.date ? ` · <span>${dot(n.updated)} 수정</span>` : ""}`;
const blogRef = { "@id": `${ORIGIN}/note/#blog` };

// Grouped by month, newest first, so the log reads as a timeline rather than one long column.
function indexPage() {
  const card = (n) => `          <li><article class="note-card"><a href="/note/${n.slug}/"><p class="note-date">${dateLine(n)}</p><h3>${esc(n.title)}</h3><p>${esc(n.summary)}</p>${tagList(n.tags)}<span class="note-more">읽어 보기 <span aria-hidden="true">→</span></span></a></article></li>`;
  const months = new Map();
  for (const n of notes) months.set(n.date.slice(0, 7), [...(months.get(n.date.slice(0, 7)) ?? []), n]);
  const items = notes.length
    ? [...months].map(([key, list]) => `      <section class="note-month" aria-labelledby="m-${key}">
        <h2 id="m-${key}">${key.slice(0, 4)}년 ${Number(key.slice(5))}월 <small>${list.length}편</small></h2>
        <ol class="note-list">
${list.map(card).join("\n")}
        </ol>
      </section>`).join("\n")
    : `      <p class="note-empty">아직 올라온 노트가 없어요.</p>`;
  return page({
    title: "개발 노트 | 크래프트얍 CraftYap",
    description: "크래프트얍(CraftYap)을 만들면서 무엇을 바꿨고 왜 그렇게 만들었는지 기록하는 개발 노트입니다.",
    canonical: `${ORIGIN}/note/`,
    type: "website",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Blog",
          ...blogRef,
          url: `${ORIGIN}/note/`,
          name: "크래프트얍 개발 노트",
          inLanguage: "ko",
          isPartOf: { "@id": `${ORIGIN}/#website` },
          about: { "@id": `${ORIGIN}/#game` },
          blogPost: notes.map((n) => ({ "@type": "BlogPosting", headline: n.title, url: n.url, datePublished: n.date, dateModified: n.updated })),
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "크래프트얍", item: `${ORIGIN}/` },
            { "@type": "ListItem", position: 2, name: "개발 노트", item: `${ORIGIN}/note/` },
          ],
        },
      ],
    },
    body: `      <section class="note-hero" aria-labelledby="note-title">
        <p class="eyebrow">DEV NOTES</p>
        <h1 id="note-title">개발 노트</h1>
        <p>크래프트얍의 날짜별 패치 노트와 개발 이야기. 무엇을 바꿨고, 왜 그렇게 만들었는지 적어 둡니다.</p>
      </section>
${items}`,
  });
}

function postPage(n, i) {
  const newer = notes[i - 1];
  const older = notes[i + 1];
  const pager = [
    older ? `<a class="note-prev" href="/note/${older.slug}/"><small>이전 노트</small>${esc(older.title)}</a>` : "<span></span>",
    newer ? `<a class="note-next" href="/note/${newer.slug}/"><small>다음 노트</small>${esc(newer.title)}</a>` : "<span></span>",
  ].join("");
  return page({
    title: `${n.title} | 크래프트얍 개발 노트`,
    description: n.summary,
    canonical: n.url,
    type: "article",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BlogPosting",
          "@id": `${n.url}#post`,
          url: n.url,
          headline: n.title,
          description: n.summary,
          datePublished: n.date,
          dateModified: n.updated,
          inLanguage: "ko",
          keywords: n.tags.join(", ") || undefined,
          image: `${ORIGIN}/craftyap-banner.jpg`,
          isPartOf: blogRef,
          author: { "@type": "Organization", name: "크래프트얍(CraftYap)", url: `${ORIGIN}/` },
          about: { "@id": `${ORIGIN}/#game` },
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "크래프트얍", item: `${ORIGIN}/` },
            { "@type": "ListItem", position: 2, name: "개발 노트", item: `${ORIGIN}/note/` },
            { "@type": "ListItem", position: 3, name: n.title, item: n.url },
          ],
        },
      ],
    },
    body: `      <article class="note-article" aria-labelledby="post-title">
        <nav class="note-crumb" aria-label="현재 위치"><a href="/note/">← 개발 노트</a></nav>
        <header class="note-head">
          <p class="note-date">${dateLine(n)}</p>
          <h1 id="post-title">${esc(n.title)}</h1>
          <p class="note-summary">${esc(n.summary)}</p>
          ${tagList(n.tags)}
        </header>
        <div class="note-body">
${n.html.trim()}
        </div>
      </article>
      <nav class="note-pager" aria-label="다른 노트">${pager}</nav>`,
  });
}

function feed() {
  const entries = notes.slice(0, 20).map((n) => `  <entry>
    <title>${esc(n.title)}</title>
    <link href="${n.url}" />
    <id>${n.url}</id>
    <published>${n.date}T00:00:00+09:00</published>
    <updated>${n.updated}T00:00:00+09:00</updated>
    <summary>${esc(n.summary)}</summary>
    <content type="html">${esc(n.html)}</content>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ko">
  <title>크래프트얍 개발 노트</title>
  <link href="${ORIGIN}/note/" />
  <link rel="self" href="${ORIGIN}/note/feed.xml" />
  <id>${ORIGIN}/note/</id>
  <updated>${newest}T00:00:00+09:00</updated>
  <author><name>크래프트얍(CraftYap)</name></author>
${entries}
</feed>
`;
}

function sitemap() {
  const path = new URL("sitemap.xml", PUBLIC);
  const xml = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const block = ["  <!-- notes:start (generated by tools/build-notes.mjs) -->",
    `  <url>\n    <loc>${ORIGIN}/note/</loc>\n    <lastmod>${newest}</lastmod>\n  </url>`,
    ...notes.map((n) => `  <url>\n    <loc>${n.url}</loc>\n    <lastmod>${n.updated}</lastmod>\n  </url>`),
    "  <!-- notes:end -->"].join("\n");
  const re = / {2}<!-- notes:start[\s\S]*?<!-- notes:end -->/;
  return re.test(xml) ? xml.replace(re, block) : xml.replace("</urlset>", `${block}\n</urlset>`);
}

// ---- write or compare -----------------------------------------------------------
const want = new Map([
  ["note/index.html", indexPage()],
  ["note/feed.xml", feed()],
  ["sitemap.xml", sitemap()],
  ...notes.map((n, i) => [`note/${n.slug}/index.html`, postPage(n, i)]),
]);
// Post folders this script made earlier whose source is gone.
const orphans = (existsSync(OUT) ? readdirSync(OUT, { withFileTypes: true }) : [])
  .filter((d) => d.isDirectory() && !want.has(`note/${d.name}/index.html`))
  .filter((d) => existsSync(new URL(`${d.name}/index.html`, OUT)) && readFileSync(new URL(`${d.name}/index.html`, OUT), "utf8").includes(MARKER))
  .map((d) => d.name);

const stale = [...want].filter(([rel, body]) => {
  const file = new URL(rel, PUBLIC);
  return !existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== body;
}).map(([rel]) => rel);

if (check) {
  const problems = [...stale, ...orphans.map((o) => `note/${o}/ (source removed)`)];
  if (problems.length) {
    console.error(`Dev notes are out of date — run \`pnpm notes\` and commit:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Dev notes up to date (${notes.length} posts).`);
} else {
  for (const rel of stale) {
    const file = new URL(rel, PUBLIC);
    mkdirSync(new URL(".", file), { recursive: true });
    writeFileSync(file, want.get(rel));
  }
  for (const o of orphans) rmSync(new URL(`${o}/`, OUT), { recursive: true });
  console.log(`Dev notes: ${notes.length} posts, ${stale.length} files written, ${orphans.length} removed.`);
}
