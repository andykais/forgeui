/**
 * `forge` — the command line (§3.1, DESIGN-AGENT-LOOP §5).
 *
 * `serve` and `reindex` hand straight back to `src/main.ts`, which owns boot
 * order and its own flag parsing; this file adds the subcommand layer and
 * `forge mcp`, the bridge. Keeping the delegation dumb is deliberate — the
 * server's startup path is the one covered by the integration tests, and it
 * should not grow a second way in.
 */

import { Command } from "@cliffy/command";
import { main as runServer } from "./main.ts";
import { loadConfig, resolveDataDir } from "./config/config.ts";
import { ConfigError } from "./config/validate.ts";
import { CivitaiUrlError } from "./models/civitai.ts";
import {
  LookupError,
  type ModelsCommandOptions,
  runModels,
  UsageError,
} from "./cli/models.ts";
import type { LookupSource } from "./cli/civitai_client.ts";
import { ForgeUi } from "./mcp/forgeui.ts";
import { LlamaSwap } from "./mcp/llama.ts";
import { serveHttp, serveStdio } from "./mcp/serve.ts";
import { createBridgeServer } from "./mcp/tools.ts";
import { APP_VERSION } from "./version.ts";

/** Flags `serve` and `reindex` pass through to `src/main.ts` untouched. */
const PASSTHROUGH = [
  "data-dir",
  "host",
  "port",
  "comfy-mode",
  "comfy-path",
  "comfy-url",
] as const;

function passthrough(
  options: Record<string, unknown>,
  extra: string[],
): string[] {
  const argv: string[] = [];
  for (const flag of PASSTHROUGH) {
    const key = flag.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const value = options[key];
    if (value !== undefined) argv.push(`--${flag}`, String(value));
  }
  for (const dir of (options.modelsDir as string[] | undefined) ?? []) {
    argv.push("--models-dir", dir);
  }
  return [...argv, ...extra];
}

const serve = new Command()
  .description("Serve the UI and manage ComfyUI.")
  .option("--data-dir <path:string>", "Data directory.")
  .option("--host <host:string>", "Interface for the app's server.")
  .option("--port <port:number>", "Port for the app's server.")
  .option("--comfy-mode <mode:string>", "managed | local_url.")
  .option("--comfy-path <path:string>", "ComfyUI install directory.")
  .option("--comfy-url <url:string>", "Where ComfyUI listens.")
  .option("--models-dir <spec:string>", "kind=path; repeatable.", {
    collect: true,
  })
  .action(async (options) => {
    Deno.exit(await runServer(passthrough(options, [])));
  });

const reindex = new Command()
  .description("Rebuild app.db from the sidecars on disk.")
  .option("--data-dir <path:string>", "Data directory.")
  .action(async (options) => {
    Deno.exit(await runServer(passthrough(options, ["reindex"])));
  });

/**
 * `forge models` (DESIGN-MODEL-IMPORT §3). Unlike `serve` and `reindex`, this
 * does not hand back to `src/main.ts`: it never opens `app.db`, and keeping
 * it out of the server's code path is what makes that a property of the
 * command rather than a promise about it.
 */
const models = new Command()
  .description(
    "Fetch model metadata, samples and weights into ForgeUI's import " +
      "folder, for the app to ingest on its next rescan.",
  )
  .option("-d, --data-dir <path:string>", "Data directory.")
  .option(
    "--url <url:string>",
    "civitai.red, civitai.com or civitaiarchive.com link to a model, a " +
      "model version or an image. The site in the link is tried first.",
  )
  .option(
    "--filename <name:string>",
    "Filename of the model. Hashed in place when it is in a configured " +
      "folder; searched for by name when it is not.",
  )
  .option(
    "--sha256checksum <hex:string>",
    "SHA256 of the model file — the identity ForgeUI uses.",
  )
  .option(
    "--search <text:string>",
    "List what Civitai has under this name and write nothing. How you find " +
      "the --url for a model that is not on this machine yet.",
  )
  .option(
    "--source <name:string>",
    "Where to look when the input does not say: auto tries civitai.red, " +
      "then civitaiarchive.com. red | archive pin it to one.",
    { default: "auto" },
  )
  .option(
    "--download-samples [n:number]",
    "Download up to <n> images from the model's page as samples, newest " +
      "first. Without a number, config.yaml's import.samples.",
  )
  .option(
    "--download-model",
    "Download the model weights into the batch. The app files them under " +
      "<appdata>/models/<kind>/ on ingest. Public models need no login; a " +
      "gated one needs CIVITAI_TOKEN.",
  )
  .option(
    "--overwrite",
    "Rewrite what is already there. Without it an existing batch field is " +
      "left for the app to fill only where the model has nothing.",
  )
  .option(
    "--dry-run",
    "Print what would be fetched and written; touch nothing.",
  )
  .option("--json", "Print the resulting model.json instead of a summary.")
  .option(
    "--browsing-level <n:number>",
    "Civitai's visibility bitmask for what a lookup may return.",
  )
  .option("--timeout <ms:number>", "Per-request timeout.", { default: 30_000 })
  .action(async (options) => {
    Deno.exit(await runModelsCommand(options));
  });

const mcp = new Command()
  .description(
    "Run the MCP bridge: the tools an LLM drives ForgeUI with, and the GPU " +
      "handoff between ForgeUI and llama-swap.",
  )
  .option("--forgeui <url:string>", "ForgeUI's base URL.", {
    default: "http://127.0.0.1:7860",
  })
  .option(
    "--llama-swap <url:string>",
    "llama-swap's base URL. Without it the bridge never evicts anything, " +
      "which is right when the LLM is not on this GPU.",
  )
  .option(
    "--llm-model <id:string>",
    "The llama-swap model id to unload, and the name recorded as the " +
      "generation's source. Defaults to whatever is running.",
  )
  .option("--http <address:string>", "Serve Streamable HTTP on host:port.")
  .option("--stdio", "Serve on stdio instead (the harness launches us).")
  .option("--no-free-vram", "Do not ask ComfyUI to unload after a round.")
  .option(
    "--progress",
    "Relay per-job progress notifications. Only useful if your harness " +
      "renders them — the model is unloaded and never sees them.",
  )
  .option("--timeout <seconds:number>", "Default ceiling for one round.", {
    default: 900,
  })
  .action(async (options) => {
    const forge = new ForgeUi({ url: options.forgeui });
    const llama = options.llamaSwap === undefined ? null : new LlamaSwap({
      url: options.llamaSwap,
      model: options.llmModel ?? null,
    });

    const build = () =>
      createBridgeServer({
        forge,
        llama,
        freeVram: options.freeVram,
        progress: options.progress ?? false,
        defaultTimeoutMs: options.timeout * 1000,
      });

    if (options.stdio || options.http === undefined) {
      // stdout belongs to the protocol on stdio; anything chatty goes to
      // stderr or it corrupts the stream.
      console.error(`forge mcp: stdio, forgeui at ${forge.url}`);
      await serveStdio(build());
      return;
    }

    const [hostname, port] = splitAddress(options.http);
    serveHttp(build, {
      hostname,
      port,
      onListen: ({ hostname, port }) =>
        console.error(
          `forge mcp: http://${hostname}:${port}/mcp, forgeui at ${forge.url}` +
            (llama === null
              ? ", no llama-swap"
              : `, llama-swap at ${options.llamaSwap}`),
        ),
    });
    await new Promise<void>(() => {});
  });

/**
 * Exit codes are part of the interface (§3): 0 wrote a batch, 1 nothing was
 * found, 2 bad arguments, 3 a download failed or needs a login, 4 the import
 * folder is not writable.
 */
async function runModelsCommand(options: {
  dataDir?: string;
  url?: string;
  filename?: string;
  sha256checksum?: string;
  search?: string;
  source: string;
  downloadSamples?: number | boolean;
  downloadModel?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  json?: boolean;
  browsingLevel?: number;
  timeout: number;
}): Promise<number> {
  try {
    if (!["auto", "red", "archive"].includes(options.source)) {
      throw new UsageError(
        `--source: expected auto, red or archive, got "${options.source}"`,
      );
    }
    const { store } = await loadConfig({
      dataDir: options.dataDir ?? resolveDataDir(),
    });
    const settings = store.config.import;
    // `--download-samples` with no number means the configured default;
    // absent entirely it means none.
    const samples = options.downloadSamples === true
      ? settings.samples
      : typeof options.downloadSamples === "number"
      ? options.downloadSamples
      : 0;

    const command: ModelsCommandOptions = {
      url: options.url,
      filename: options.filename,
      sha256checksum: options.sha256checksum,
      search: options.search,
      source: options.source as LookupSource,
      downloadSamples: samples,
      downloadModel: options.downloadModel === true,
      overwrite: options.overwrite === true,
      dryRun: options.dryRun === true,
      browsingLevel: options.browsingLevel,
      timeoutMs: options.timeout,
    };
    const result = await runModels({
      ...command,
      config: store.config,
      paths: store.paths,
    });
    if (options.json && result.batch !== null) {
      console.log(JSON.stringify(result.batch, null, 2));
    }
    return 0;
  } catch (cause) {
    if (cause instanceof UsageError || cause instanceof CivitaiUrlError) {
      console.error(`forge models: ${cause.message}`);
      return cause instanceof UsageError &&
          /login|download|civitai_cli/.test(cause.message)
        ? 3
        : 2;
    }
    if (cause instanceof LookupError) {
      console.error(`forge models: ${cause.message}`);
      return 1;
    }
    if (cause instanceof ConfigError) {
      console.error(`forge models: ${cause.message}`);
      return 2;
    }
    if (
      cause instanceof Deno.errors.PermissionDenied ||
      cause instanceof Deno.errors.NotFound
    ) {
      console.error(`forge models: ${cause.message}`);
      return 4;
    }
    throw cause;
  }
}

function splitAddress(value: string): [string, number] {
  const at = value.lastIndexOf(":");
  if (at <= 0) throw new Error(`--http: expected host:port, got "${value}"`);
  const port = Number(value.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--http: "${value}" has no usable port`);
  }
  return [value.slice(0, at), port];
}

export const forge = new Command()
  .name("forge")
  .version(APP_VERSION)
  .description("ForgeUI — a workflow-first frontend for ComfyUI.")
  .default("serve")
  .command("serve", serve)
  .command("reindex", reindex)
  .command("models", models)
  .command("mcp", mcp);

if (import.meta.main) {
  await forge.parse(Deno.args);
}
