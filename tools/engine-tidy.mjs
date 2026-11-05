// After `wasm-pack build --target web` into packages/engine/wasm. That folder is COMMITTED
// (like the machine GLB), so the web build and deploy never need Rust.
// - wasm-pack writes its own .gitignore ("*"), a package.json and a README there: drop them, so git
//   keeps the files and pnpm ignores the folder.
// - SOURCE_HASH records which Rust sources it was built from; `--check` (CI, engine.yml) fails when
//   the committed wasm is stale (wasm binaries differ by machine paths, so the sources are compared).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "packages/engine/wasm");
const hashFile = join(out, "SOURCE_HASH");

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    // only what the wasm is built from: the native client, its network crate and the Android project are not in it
    if (name === "target" || name.startsWith("pkg") || name === "client" || name === "net" || name === "platform") return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(rs|toml|lock)$/.test(name) ? [p] : [];
  });
}
const hash = createHash("sha256");
// sorted by the "/" path, so Windows and Linux (CI) hash the files in the same order
const files = sources(join(root, "engine")).map((f) => [relative(root, f).replaceAll("\\", "/"), f]);
for (const [rel, f] of files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
  hash.update(rel);
  hash.update(readFileSync(f, "utf8").replaceAll("\r\n", "\n"));
}
const digest = hash.digest("hex");

if (process.argv.includes("--check")) {
  const committed = (() => { try { return readFileSync(hashFile, "utf8").trim(); } catch { return ""; } })();
  if (committed !== digest) {
    console.error("packages/engine/wasm is stale: run `pnpm engine:build` and commit it");
    process.exit(1);
  }
  console.log("engine wasm matches the Rust sources");
} else {
  for (const f of [".gitignore", "package.json", "README.md"]) rmSync(join(out, f), { force: true });
  writeFileSync(hashFile, digest + "\n");
  console.log("engine wasm ready in packages/engine/wasm");
}
