import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/** Component tests for the param panel (§14.1) run against jsdom. */
export default defineConfig({
  plugins: [svelte({ hot: false })],
  // Without this, Svelte's server build is resolved and mount() is missing.
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
