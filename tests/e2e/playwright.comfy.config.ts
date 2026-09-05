import { defineConfig } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The browser half of the contract check: the same app, against the real
 * ComfyUI `scripts/with_comfy.ts` started. Run it with
 * `deno task test:e2e:comfy`, which provides the environment.
 */
const port = Number(process.env.FORGEUI_E2E_COMFY_APP_PORT ?? "7898");

export default defineConfig({
  testDir: ".",
  testMatch: /comfy\.spec\.ts/,
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
