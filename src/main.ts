import type { Database } from "@db/sqlite";
import {
  assertAbsoluteModelFolders,
  ConfigError,
  type ConfigStore,
  type EnvSource,
  loadConfig,
  resolveDataDir,
} from "./config/config.ts";
import { type CliArgs, parseCliArgs, USAGE } from "./config/cli.ts";
import { writeExtraModelPaths } from "./config/extra_model_paths.ts";
import type { DataPaths } from "./config/paths.ts";
import { ComfyManager } from "./comfy/manager.ts";
import { openDatabase } from "./db/db.ts";
import { type HttpServer, startHttpServer } from "./http/server.ts";
import { WsHub } from "./http/ws.ts";
import { JobRunner } from "./jobs/pipeline.ts";
import { syncBundledWorkflows, WorkflowStore } from "./workflows/loader.ts";
import { APP_VERSION } from "./version.ts";

export interface StartAppOptions {
  argv?: string[];
  env?: EnvSource;
  /** Log the listening URL and first-run notes. Off in tests. */
  quiet?: boolean;
  /** Do not connect to (or spawn) ComfyUI; used by tests that do not need it. */
  skipComfy?: boolean;
}

export interface App {
  url: string;
  hostname: string;
  port: number;
  config: ConfigStore;
  db: Database;
  paths: DataPaths;
  workflows: WorkflowStore;
  comfy: ComfyManager;
  jobs: JobRunner;
  hub: WsHub;
  /** True when this boot created `config.yaml` (§3.1 first run). */
  createdConfig: boolean;
  shutdown(): Promise<void>;
}

/**
 * Boot order (§3.1, §2): resolve the data dir, read or create `config.yaml`,
 * regenerate `extra_model_paths.yaml`, open `app.db`, load the workflows,
 * start serving, then bring ComfyUI up in the background — the UI must come up
 * whether or not ComfyUI does (§11.3).
 */
export async function startApp(options: StartAppOptions = {}): Promise<App> {
  const args = parseCliArgs(options.argv ?? []);
  return await startAppWith(args, options);
}

async function startAppWith(
  args: CliArgs,
  options: StartAppOptions,
): Promise<App> {
  const { store, db, paths, created, workflows } = await bootstrap(
    args,
    options.env,
  );

  const hub = new WsHub();
  const comfy = new ComfyManager({
    config: store,
    paths,
    onEvent: (event) => jobs.handleEvent(event),
    onConnect: () => {
      jobs.reconcile().catch((error) => {
        console.error("could not reconcile jobs after connecting:", error);
      });
    },
    onStatus: (status) =>
      hub.broadcast({ type: "system_status", data: status }),
  });
  const jobs = new JobRunner({ db, paths, workflows, comfy, hub });
  hub.onHello(() => [{ type: "system_status", data: comfy.status() }]);

  const ctx = { config: store, db, paths, workflows, comfy, jobs, hub };
  let server: HttpServer;
  try {
    // Orphan staging dirs and jobs left running by the last process (§M2).
    await jobs.sweepAtStartup();
    server = await startHttpServer(ctx);
  } catch (cause) {
    db.close();
    throw cause;
  }
  if (!options.skipComfy) comfy.start();

  if (!options.quiet) {
    console.log(`ForgeUI ${APP_VERSION} — ${server.url}`);
    console.log(`data dir: ${paths.root}`);
    console.log(
      `comfyui : ${store.config.comfy.mode} at ${store.config.comfy.url}`,
    );
    if (created) {
      console.log(
        `wrote ${paths.configFile}; set the ComfyUI path and model folders there`,
      );
    }
  }

  return {
    url: server.url,
    hostname: server.hostname,
    port: server.port,
    config: store,
    db,
    paths,
    workflows,
    comfy,
    jobs,
    hub,
    createdConfig: created,
    async shutdown() {
      hub.close();
      await comfy.close();
      await server.shutdown();
      db.close();
    },
  };
}

async function bootstrap(args: CliArgs, env?: EnvSource) {
  const dataDir = resolveDataDir({ flag: args.dataDir, env });
  const { store, created } = await loadConfig({
    dataDir,
    overrides: args.overrides,
  });
  assertAbsoluteModelFolders(store.config);
  await writeExtraModelPaths(store.paths, store.config);
  // Bundled workflows are app-owned and refreshed on every launch (§4.6).
  await syncBundledWorkflows(store.paths.bundledWorkflows);
  const workflows = await WorkflowStore.load(store.paths);
  const db = openDatabase(store.paths.db);
  return { store, db, paths: store.paths, created, workflows };
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    console.error(`forgeui: ${cause.message}\n`);
    console.error(USAGE);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(APP_VERSION);
    return 0;
  }

  try {
    if (args.command === "reindex") {
      const { db } = await bootstrap(args);
      db.close();
      console.error("forgeui: reindex is not implemented yet (milestone M3)");
      return 3;
    }
    const app = await startAppWith(args, {});
    const stop = async () => {
      await app.shutdown();
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop);
    return await new Promise<number>(() => {});
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(`forgeui: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
