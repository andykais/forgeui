import { dirname, join } from "@std/path";
import { type App, startApp } from "../../src/main.ts";
import type { EnvSource } from "../../src/config/config.ts";

/**
 * Boots the real server in-process against a throwaway `<appdata>` dir, on a
 * port the OS picks. The environment is stubbed out so a developer's
 * `FORGEUI_DATA_DIR` can never leak into a test (§14.2).
 */
const EMPTY_ENV: EnvSource = { get: () => undefined };

export interface TestApp extends App {
  dataDir: string;
  /** `GET`/`PATCH`/… against the app, with paths relative to its origin. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Shut the server down and remove the data dir. */
  dispose(): Promise<void>;
}

export interface TestAppOptions {
  /** Extra CLI arguments, e.g. `["--comfy-url", fake.url]`. */
  argv?: string[];
  /** Files to drop into the data dir before boot, e.g. `config.yaml`. */
  files?: Record<string, string>;
  dataDir?: string;
}

export async function startTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const dataDir = options.dataDir ??
    await Deno.makeTempDir({ prefix: "forgeui-test-" });
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    const path = join(dataDir, name);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, contents);
  }

  const app = await startApp({
    argv: ["--data-dir", dataDir, "--port", "0", ...(options.argv ?? [])],
    env: EMPTY_ENV,
    quiet: true,
  });

  return Object.assign(app, {
    dataDir,
    fetch(path: string, init?: RequestInit) {
      return fetch(new URL(path, app.url), init);
    },
    async dispose() {
      await app.shutdown();
      await Deno.remove(dataDir, { recursive: true });
    },
  });
}

/** Run `body` against a fresh app and always clean up afterwards. */
export async function withTestApp(
  body: (app: TestApp) => Promise<void>,
  options: TestAppOptions = {},
): Promise<void> {
  const app = await startTestApp(options);
  try {
    await body(app);
  } finally {
    await app.dispose();
  }
}
