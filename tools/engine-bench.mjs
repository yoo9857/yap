// pnpm engine:bench — TypeScript vs Rust (WASM) water speed on identical worlds (packages/shared/test/rust-bench.test.ts).
import { spawnSync } from "node:child_process";
const r = spawnSync("pnpm", ["--filter", "@robo/shared", "exec", "vitest", "run", "test/rust-bench.test.ts"], { stdio: "inherit", shell: true, env: { ...process.env, RUST_BENCH: "1" } });
process.exit(r.status ?? 1);
