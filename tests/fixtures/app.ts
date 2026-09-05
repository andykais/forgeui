import { dirname, join } from "@std/path";
import { type App, startApp } from "../../src/main.ts";
import type { EnvSource } from "../../src/config/config.ts";
import { dataPaths } from "../../src/config/paths.ts";
import { TestSocket } from "../fake-comfy/client.ts";
import {
  type FakeComfy,
  type FakeComfyOptions,
  startFakeComfy,
} from "../fake-comfy/server.ts";

/**
 * Boots the real server in-process against a throwaway `<appdata>` dir, on a
 * port the OS picks. The environment is stubbed out so a developer's
 * `FORGEUI_DATA_DIR` can never leak into a test (§14.2).
 */
const EMPTY_ENV: EnvSource = { get: () => undefined };

export interface TestApp extends App {
  dataDir: string;
  /** The fake ComfyUI this app is connected to, when one was asked for. */
  fake: FakeComfy | null;
  /** `GET`/`PATCH`/… against the app, with paths relative to its origin. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  /** A client on the app's own `/ws`. */
  socket(): Promise<TestSocket>;
  /** Shut the server down and remove the data dir. */
  dispose(): Promise<void>;
}

export interface TestAppOptions {
  /** Extra CLI arguments, e.g. `["--comfy-mode", "managed"]`. */
  argv?: string[];
  /** Files to drop into the data dir before boot, e.g. `config.yaml`. */
  files?: Record<string, string>;
  dataDir?: string;
  /**
   * Start an in-process fake ComfyUI and connect the app to it in
   * `local_url` mode. Without this the app boots with no ComfyUI at all.
   */
  comfy?: boolean | Partial<FakeComfyOptions>;
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

  const paths = dataPaths(dataDir);
  let fake: FakeComfy | null = null;
  const argv = ["--data-dir", dataDir, "--port", "0", ...(options.argv ?? [])];
  if (options.comfy) {
    fake = await startFakeComfy({
      stagingDir: paths.staging,
      inputDir: paths.comfyInput,
      ...(typeof options.comfy === "object" ? options.comfy : {}),
    });
    argv.push("--comfy-mode", "local_url", "--comfy-url", fake.url);
  }

  const app = await startApp({
    argv,
    env: EMPTY_ENV,
    quiet: true,
    skipComfy: !options.comfy && !options.argv?.includes("managed"),
  });
  if (fake) await app.comfy.waitForState("running", 5000);

  const sockets: TestSocket[] = [];
  return Object.assign(app, {
    dataDir,
    fake,
    fetch(path: string, init?: RequestInit) {
      return fetch(new URL(path, app.url), init);
    },
    async json<T>(path: string, init?: RequestInit) {
      const response = await fetch(new URL(path, app.url), init);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          `${init?.method ?? "GET"} ${path} → ${response.status}: ${
            JSON.stringify(body)
          }`,
        );
      }
      return body as T;
    },
    async socket() {
      const socket = await TestSocket.connect(
        `${app.url.replace("http", "ws")}/ws`,
      );
      sockets.push(socket);
      return socket;
    },
    async dispose() {
      for (const socket of sockets) socket.close();
      // Let the pipeline finish what it started before the files go away.
      await app.jobs.idle();
      await app.shutdown();
      await fake?.close();
      await app.jobs.idle();
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
