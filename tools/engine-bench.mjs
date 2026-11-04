// pnpm engine:bench — TypeScript vs Rust (WASM) speed on identical inputs: water
// (packages/shared/test/rust-bench.test.ts) and brick shells (apps/client/test/rust-kit-bench.test.ts).
import { spawnSync } from "node:child_process";
const env = { ...process.env, RUST_BENCH: "1" };
for (const [pkg, file] of [["@robo/shared", "test/rust-bench.test.ts"], ["@robo/client", "test/rust-kit-bench.test.ts"]]) {
  const r = spawnSync("pnpm", ["--filter", pkg, "exec", "vitest", "run", file], { stdio: "inherit", shell: true, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
