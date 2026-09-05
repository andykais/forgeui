import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * The SPA is built into `dist/` and served by the Deno process (§2). In dev
 * the API, the websocket and the ComfyUI proxy are forwarded to that process,
 * so the app behaves the same either way.
 */
const backend = process.env.FORGEUI_URL ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/comfy": { target: backend, changeOrigin: true, ws: true },
      "/ws": { target: backend, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One file each keeps the embedded build easy to reason about.
    assetsInlineLimit: 0,
  },
});
