import { defineConfig } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One smoke test (§14.1), against the built app and the fake ComfyUI. It uses
 * the browser already on the machine rather than downloading one.
 */
const port = 7899;

/**
 * The browser to drive. `channel: "chrome"` uses the one already on the
 * machine, which is what a developer has and why nothing is downloaded here.
 * A container or a CI runner has Playwright's own chromium instead and no
 * Chrome at all, where that channel fails before the first test
 * (`Chromium distribution 'chrome' is not found`) — so it can say where its
 * browser is and the same suite runs unchanged:
 *
 *     FORGEUI_E2E_BROWSER=/opt/pw-browsers/chromium deno task test:e2e
 */
const browser = process.env.FORGEUI_E2E_BROWSER;

export default defineConfig({
  testDir: ".",
  /**
   * Only the smoke test. `comfy.spec.ts` needs a real ComfyUI
   * (`deno task test:e2e:comfy`); `shots.spec.ts` and `video.spec.ts` are the
   * documentation demos, run by name, and they leave state behind that the
   * smoke test would then trip over.
   */
  testIgnore: /(comfy|shots|shots-phase2|video)\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...(browser
      ? { launchOptions: { executablePath: browser } }
      : { channel: "chrome" as const }),
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // --config is explicit because this directory has its own package.json,
    // which otherwise stops Deno looking further up for deno.json.
    command:
      "deno run --config ../../deno.json --allow-env --allow-net " +
      "--allow-read --allow-run --allow-write serve.ts",
    cwd: here,
    url: `http://127.0.0.1:${port}/api/system/status`,
    timeout: 120_000,
    reuseExistingServer: true,
    stdout: "pipe",
    stderr: "pipe",
  },
});
