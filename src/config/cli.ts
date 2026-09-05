import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";
import type { ModelFolders, PartialConfig } from "./types.ts";
import { ConfigError, validatePartialConfig } from "./validate.ts";

export type Command = "start" | "reindex";

export interface CliArgs {
  command: Command;
  /** `--data-dir`, or null to fall back to env/`~/.forgeui`. */
  dataDir: string | null;
  /** Per-run config layer; never written back to `config.yaml` (§3.1). */
  overrides: PartialConfig;
  help: boolean;
  version: boolean;
}

export const USAGE = `ForgeUI — a workflow-first frontend for ComfyUI.

Usage: forgeui [command] [options]

Commands:
  start                    Serve the UI and manage ComfyUI (default).
  reindex                  Rebuild app.db from the sidecars on disk.

Options:
  --data-dir <path>        Data directory (default: $FORGEUI_DATA_DIR or ~/.forgeui).
  --host <host>            Interface for the app's server.
  --port <port>            Port for the app's server.
  --comfy-mode <mode>      managed | local_url.
  --comfy-path <path>      ComfyUI install directory.
  --comfy-url <url>        Where ComfyUI listens.
  --models-dir <kind=path> Model folder for one kind; repeatable.
  -h, --help               Show this help.
  -V, --version            Print the version.

Options other than --data-dir override config.yaml for this run only.
`;

const COMMANDS: readonly string[] = ["start", "reindex"];

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`--port: expected an integer between 0 and 65535`);
  }
  return port;
}

function parseModelDirs(values: string[]): ModelFolders {
  const folders: ModelFolders = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq <= 0 || eq === value.length - 1) {
      throw new ConfigError(`--models-dir: expected kind=path, got "${value}"`);
    }
    const kind = value.slice(0, eq);
    const path = resolve(value.slice(eq + 1));
    (folders[kind] ??= []).push(path);
  }
  return folders;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const flags = parseArgs(argv, {
    string: [
      "data-dir",
      "host",
      "port",
      "comfy-mode",
      "comfy-path",
      "comfy-url",
    ],
    boolean: ["help", "version"],
    collect: ["models-dir"],
    alias: { h: "help", V: "version" },
    unknown: (arg) => {
      if (arg.startsWith("-")) throw new ConfigError(`unknown option: ${arg}`);
      return true;
    },
  }) as Record<string, unknown> & { _: (string | number)[] };

  const positional = flags._.map(String);
  if (positional.length > 1) {
    throw new ConfigError(`unexpected argument: ${positional[1]}`);
  }
  const command = positional[0] ?? "start";
  if (!COMMANDS.includes(command)) {
    throw new ConfigError(
      `unknown command: ${command} (expected ${COMMANDS.join(" or ")})`,
    );
  }

  const layer: Record<string, unknown> = {};
  const server: Record<string, unknown> = {};
  if (typeof flags.host === "string") server.host = flags.host;
  if (typeof flags.port === "string") server.port = parsePort(flags.port);
  if (Object.keys(server).length > 0) layer.server = server;

  const comfy: Record<string, unknown> = {};
  if (typeof flags["comfy-mode"] === "string") {
    comfy.mode = flags["comfy-mode"];
  }
  if (typeof flags["comfy-path"] === "string") {
    comfy.path = resolve(flags["comfy-path"]);
  }
  if (typeof flags["comfy-url"] === "string") comfy.url = flags["comfy-url"];
  if (Object.keys(comfy).length > 0) layer.comfy = comfy;

  const modelDirs = (flags["models-dir"] ?? []) as string[];
  if (modelDirs.length > 0) layer.model_folders = parseModelDirs(modelDirs);

  return {
    command: command as Command,
    dataDir: typeof flags["data-dir"] === "string"
      ? resolve(flags["data-dir"])
      : null,
    overrides: validatePartialConfig(layer, "cli"),
    help: flags.help === true,
    version: flags.version === true,
  };
}
