import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

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
    rollupOptions: {
      input: {
        game: fileURLToPath(new URL("./index.html", import.meta.url)),
        homeReview: fileURLToPath(new URL("./home-preview.html", import.meta.url)),
      },
    },
    // no public sourcemaps in production: the rapier/bgm maps are multi-MB and
    // would ship the full source to every visitor
    sourcemap: false,
  },
});
