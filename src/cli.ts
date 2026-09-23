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
  .command("mcp", mcp);

if (import.meta.main) {
  await forge.parse(Deno.args);
}
