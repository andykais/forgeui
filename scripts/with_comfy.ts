/**
 * Start the ComfyUI that `scripts/setup-comfy.sh` provisioned, wait until it
 * answers, run a command against it, and shut it down again.
 *
 * ```sh
 * deno run -A scripts/with_comfy.ts deno test tests/contract/   # test:comfy
 * deno run -A scripts/with_comfy.ts --serve                     # comfy:serve
 * ```
 *
 * The child is spawned through the app's own `comfyLaunchCommand()` and
 * `ComfyProcess`, so the flags under test are the flags Settings shows and
 * managed mode uses — a mistake in them fails here rather than silently.
 *
 * It hands the command a data directory laid out like `<appdata>` (§3) whose
 * `staging/` is ComfyUI's `--output-directory`, which is what lets a test
 * boot the app on it and watch a real generation land.
 */

import { join } from "@std/path";
import { defaultConfig } from "../src/config/defaults.ts";
import { writeExtraModelPaths } from "../src/config/extra_model_paths.ts";
import { dataPaths, ensureDataDirs } from "../src/config/paths.ts";
import { comfyLaunchCommand } from "../src/comfy/launch.ts";
import { ComfyProcess } from "../src/comfy/process.ts";

/** ComfyUI imports torch before it listens; on a CPU that is not quick. */
const READY_TIMEOUT_MS = 300_000;

function comfyHome(): string {
  const home = Deno.env.get("FORGEUI_COMFY_HOME");
  if (home) return home;
  const user = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return join(user, ".forgeui-comfy");
}

function pythonIn(home: string): string {
  return Deno.build.os === "windows"
    ? join(home, "venv", "Scripts", "python.exe")
    : join(home, "venv", "bin", "python");
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The checkpoints ComfyUI can see, so the tests need no filename told to them. */
function checkpoints(comfyDir: string): string[] {
  const dir = join(comfyDir, "models", "checkpoints");
  const names: string[] = [];
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && /\.(safetensors|ckpt)$/i.test(entry.name)) {
        names.push(entry.name);
      }
    }
  } catch {
    // No checkpoints; the sampler tests will be skipped.
  }
  return names.sort();
}

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return await Promise.resolve(port);
}

async function waitUntilReady(
  url: string,
  deadline: number,
  alive: () => boolean,
): Promise<void> {
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("ComfyUI exited before it started listening");
    try {
      const response = await fetch(`${url}/system_stats`, {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`ComfyUI did not answer within ${READY_TIMEOUT_MS}ms`);
}

async function run(command: string[], env: Record<string, string>) {
  const child = new Deno.Command(command[0]!, {
    args: command.slice(1),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return await child.status;
}

async function main(): Promise<number> {
  const argv = [...Deno.args];
  const serve = argv[0] === "--serve";
  if (serve) argv.shift();
  const keep = argv[0] === "--keep";
  if (keep) argv.shift();
  if (!serve && argv.length === 0) {
    console.error(
      "usage: with_comfy.ts [--serve] [--keep] <command> [args...]",
    );
    return 2;
  }

  // Someone else's ComfyUI: nothing to start, nothing to stop.
  const existing = Deno.env.get("FORGEUI_COMFY_URL");
  if (existing) {
    console.log(`using the ComfyUI already at ${existing}`);
    if (serve) return 0;
    return (await run(argv, Deno.env.toObject())).code;
  }

  const home = comfyHome();
  const comfyDir = join(home, "ComfyUI");
  const python = pythonIn(home);
  if (!exists(join(comfyDir, "main.py")) || !exists(python)) {
    console.error(
      `no ComfyUI in ${home}.\n` +
        "Run `deno task comfy:setup` to provision one (or set " +
        "FORGEUI_COMFY_HOME, or FORGEUI_COMFY_URL to use your own).",
    );
    return 1;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-comfy-" });
  const paths = dataPaths(dataDir);
  await ensureDataDirs(paths);

  const port = await freePort();
  const config = defaultConfig();
  config.comfy.path = comfyDir;
  config.comfy.python = python;
  config.comfy.url = `http://127.0.0.1:${port}`;
  // --cpu so this runs anywhere; previews so the binary frame layout is
  // exercised, which is not on by default.
  config.comfy.extra_args = ["--cpu", "--preview-method", "auto"];
  config.model_folders = {
    checkpoints: [join(comfyDir, "models", "checkpoints")],
    loras: [join(comfyDir, "models", "loras")],
  };
  await writeExtraModelPaths(paths, config);

  const launch = comfyLaunchCommand(config, paths);
  const logPath = join(dataDir, "comfy.log");
  const log = await Deno.open(logPath, { create: true, write: true });
  const encoder = new TextEncoder();
  const tail: string[] = [];
  const comfy = ComfyProcess.start({
    launch,
    onLine: (line) => {
      log.writeSync(encoder.encode(`${line}\n`));
      tail.push(line);
      if (tail.length > 40) tail.shift();
    },
  });

  console.log(
    `ComfyUI ${launch.command} (pid ${comfy.pid}) → ${config.comfy.url}`,
  );
  console.log(`  data dir ${dataDir}`);
  console.log(`  log      ${logPath}`);

  let code = 1;
  try {
    await waitUntilReady(
      config.comfy.url,
      Date.now() + READY_TIMEOUT_MS,
      () => comfy.running,
    );
    const found = checkpoints(comfyDir);
    console.log(
      `  ready, ${found.length} checkpoint${found.length === 1 ? "" : "s"}${
        found.length > 0 ? `: ${found.join(", ")}` : ""
      }`,
    );

    const env = {
      ...Deno.env.toObject(),
      FORGEUI_COMFY_URL: config.comfy.url,
      FORGEUI_COMFY_OUTPUT_DIR: paths.staging,
      FORGEUI_COMFY_INPUT_DIR: paths.comfyInput,
      FORGEUI_COMFY_DATA_DIR: dataDir,
      FORGEUI_COMFY_DIR: comfyDir,
      ...(found[0] ? { FORGEUI_COMFY_CKPT: found[0] } : {}),
    };

    if (serve) {
      console.log("\nserving; press Ctrl-C to stop");
      for (const [key, value] of Object.entries(env)) {
        if (key.startsWith("FORGEUI_COMFY")) console.log(`  ${key}=${value}`);
      }
      await new Promise<void>((resolve) => {
        Deno.addSignalListener("SIGINT", resolve);
      });
      code = 0;
    } else {
      code = (await run(argv, env)).code;
    }
  } catch (cause) {
    console.error(`\n${cause instanceof Error ? cause.message : cause}`);
    console.error(`last lines of ${logPath}:`);
    for (const line of tail) console.error(`  ${line}`);
  } finally {
    await comfy.stop();
    log.close();
    if (keep) {
      console.log(`kept ${dataDir}`);
    } else {
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    }
  }
  return code;
}

Deno.exit(await main());
