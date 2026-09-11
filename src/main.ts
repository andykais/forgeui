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
import { seedNodeTimings, seedNodeTimingsIfEmpty } from "./jobs/timings.ts";
import { reindex } from "./outputs/reindex.ts";
import { OutputStore } from "./outputs/store.ts";
import { ModelLibrary } from "./models/library.ts";
import { SampleStore } from "./samples/store.ts";
import { openTelemetryDatabase } from "./telemetry/db.ts";
import { TelemetryStore } from "./telemetry/store.ts";
import { VramMonitor } from "./telemetry/vram.ts";
import { syncBundledWorkflows, WorkflowStore } from "./workflows/loader.ts";
import { APP_VERSION } from "./version.ts";

export interface StartAppOptions {
  argv?: string[];
  env?: EnvSource;
  /** Log the listening URL and first-run notes. Off in tests. */
  quiet?: boolean;
  /** Do not connect to (or spawn) ComfyUI; used by tests that do not need it. */
  skipComfy?: boolean;
  /** Do not scan or hash the model folders on boot; tests drive it by hand. */
  skipModels?: boolean;
}

export interface App {
  url: string;
  hostname: string;
  port: number;
  config: ConfigStore;
  db: Database;
  /** `telemetry.db` (§7.1), opened beside `app.db` and closed with it. */
  telemetry: TelemetryStore;
  /** The sampler behind the VRAM report (§7.1). */
  vram: VramMonitor;
  paths: DataPaths;
  workflows: WorkflowStore;
  comfy: ComfyManager;
  jobs: JobRunner;
  outputs: OutputStore;
  models: ModelLibrary;
  samples: SampleStore;
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
  const { store, db, telemetryDb, paths, created, workflows } = await bootstrap(
    args,
    options.env,
  );

  const hub = new WsHub();
  const telemetry = new TelemetryStore({ db: telemetryDb });
  // Reads ComfyUI's own numbers; nothing is sampled while the app is idle.
  const vram = new VramMonitor({
    store: telemetry,
    read: async () => {
      const stats = await comfy.refreshStats(0);
      if (!stats) return null;
      return {
        free: stats.vram_free,
        total: stats.vram_total,
        device: stats.device ?? null,
      };
    },
  });
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
  const outputs = new OutputStore({ db, paths, hub });
  const samples = new SampleStore({ db, paths });
  const models = new ModelLibrary({
    db,
    paths,
    config: store,
    hub,
    samples,
    telemetry,
  });
  const jobs = new JobRunner({
    db,
    paths,
    workflows,
    comfy,
    hub,
    outputs,
    resolveModels: (refs) => models.resolveModels(refs),
    modelExists: (name, cls) => models.hasModelNamed(name, cls),
    telemetry,
    vram,
  });
  hub.onHello(() => [
    { type: "system_status", data: comfy.status() },
    { type: "rescan_progress", data: models.progress.rescan },
    { type: "hashing_progress", data: models.progress.hashing },
  ]);

  const ctx = {
    config: store,
    db,
    paths,
    workflows,
    comfy,
    jobs,
    outputs,
    models,
    samples,
    hub,
    telemetry,
  };
  let server: HttpServer;
  try {
    // Orphan staging dirs and jobs left running by the last process (§M2).
    await jobs.sweepAtStartup();
    // Deletions whose undo window closed while the app was down (§11.2).
    await outputs.resumeDeletions();
    server = await startHttpServer(ctx);
  } catch (cause) {
    db.close();
    telemetryDb.close();
    throw cause;
  }
  if (!options.skipComfy) comfy.start();
  // The library scans and hashes in the background: the UI must come up
  // whether or not somebody pointed it at a terabyte of models (§8.1).
  if (!options.skipModels) models.startBackground();
  // First launch after §5.1: every sidecar already carries the per-node
  // durations the ETA wants, so read them rather than start from nothing.
  seedNodeTimingsIfEmpty({ db, paths }).catch((error) => {
    console.error("could not seed the node timings:", error);
  });

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
    telemetry,
    vram,
    paths,
    workflows,
    comfy,
    jobs,
    outputs,
    models,
    samples,
    hub,
    createdConfig: created,
    async shutdown() {
      models.stop();
      outputs.close();
      vram.stop();
      hub.close();
      await comfy.close();
      await models.idle();
      // A sample already in flight still has a database to write to.
      await vram.idle();
      await server.shutdown();
      db.close();
      telemetryDb.close();
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
  const telemetryDb = openTelemetryDatabase(store.paths.telemetryDb);
  return { store, db, telemetryDb, paths: store.paths, created, workflows };
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
      const { store, db, paths } = await bootstrap(args);
      try {
        // Scan (but do not hash) so sidecars that name a model the library
        // has already hashed get their `output_models` rows back (§8.1).
        const models = new ModelLibrary({
          db,
          paths,
          config: store,
          hub: new WsHub(),
        });
        await models.scanner.rescan();
        const result = await reindex({
          db,
          paths,
          resolveModels: (refs) => models.resolveModels(refs),
        });
        // Node timings are derived from the same sidecars (§5.1).
        const timings = await seedNodeTimings({ db, paths });
        console.log(
          `reindexed ${result.outputs} outputs from ${result.sidecars} sidecars`,
        );
        if (timings.nodes > 0) {
          console.log(
            `seeded ${timings.nodes} node timings from ${timings.sidecars} sidecars`,
          );
        }
        if (result.jobs_created > 0) {
          console.log(`recreated ${result.jobs_created} job rows`);
        }
        if (result.removed.length > 0) {
          console.log(
            `dropped ${result.removed.length} rows whose files are gone`,
          );
        }
        for (const error of result.errors) {
          console.error(`  ! ${error.path}: ${error.message}`);
        }
        return result.errors.length > 0 ? 1 : 0;
      } finally {
        db.close();
      }
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
