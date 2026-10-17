import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The visual QA walk (`qa.spec.ts`), run by `deno task qa` — which builds the
 * UI first and turns the shots into one contact sheet. It has a port and a
 * data directory of its own, so it never shoots another suite's leftovers.
 */
const port = 7896;
const comfyPort = 8296;
const browser = process.env.FORGEUI_E2E_BROWSER;

export default defineConfig({
  testDir: ".",
  testMatch: /qa\.spec\.ts/,
  timeout: 600_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...(browser
      ? { launchOptions: { executablePath: browser } }
      : { channel: "chrome" as const }),
    viewport: { width: 1440, height: 900 },
    // Unbounded by default, which turns one missing button into a walk that
    // waits out the whole test instead of photographing the screen and going on.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command:
      "deno run --config ../../deno.json --allow-env --allow-net " +
      "--allow-read --allow-run --allow-write serve.ts",
    cwd: here,
    env: {
      FORGEUI_E2E_PORT: String(port),
      FORGEUI_E2E_COMFY_PORT: String(comfyPort),
      FORGEUI_E2E_DATA_DIR: join(here, ".tmp-qa-data"),
      // Slow enough that a running job and one queued behind it hold still
      // for the camera; fast enough that the whole walk is a few minutes.
      FORGEUI_E2E_STEP_DELAY: "250",
    },
    url: `http://127.0.0.1:${port}/api/system/status`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
