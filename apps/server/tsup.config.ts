import { cpSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: ["@robo/shared", "@robo/engine"],
  clean: true,
  sourcemap: true,
  // The Rust engine's .wasm ships next to the bundle (dist/engine-wasm/), where
  // @robo/engine/node looks for it; the Docker image copies dist/ whole.
  onSuccess: async () => {
    mkdirSync("dist/engine-wasm", { recursive: true });
    cpSync("../../packages/engine/wasm/craftyap_wasm_bg.wasm", "dist/engine-wasm/craftyap_wasm_bg.wasm");
  },
});
