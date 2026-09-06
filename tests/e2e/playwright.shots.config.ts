import { defineConfig } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The documentation screenshots of `docs/screenshots/phase-2/`. Run with
 * `deno task shots:phase2`, which starts a ComfyUI and a data directory
 * nobody else has touched — a shot of somebody else's leftovers is worse
 * than no shot.
 */
const port = Number(process.env.FORGEUI_E2E_COMFY_APP_PORT ?? "7897");

export default defineConfig({
  testDir: ".",
  testMatch: /shots-phase2\.spec\.ts/,
  // A cold SD 1.5 load on a CPU, plus ComfyUI's own frontend booting.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "deno run --config ../../deno.json --allow-env --allow-ffi --allow-net " +
      "--allow-read --allow-run --allow-write serve-comfy.ts",
    cwd: here,
    url: `http://127.0.0.1:${port}/api/system/status`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
