import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: ["@robo/shared"],
  clean: true,
  sourcemap: true,
});
