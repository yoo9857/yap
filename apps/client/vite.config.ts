import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["@robo/shared"],
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8081",
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
    // no public sourcemaps in production: the rapier/bgm maps are multi-MB and
    // would ship the full source to every visitor
    sourcemap: false,
  },
});
