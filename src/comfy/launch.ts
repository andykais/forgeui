import { join } from "@std/path";
import type { Config } from "../config/types.ts";
import type { DataPaths } from "../config/paths.ts";

/**
 * How the managed child is started (§2). Settings shows these flags read-only
 * so a user running ComfyUI themselves can copy them, which is why building
 * the command is a pure function.
 */
export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  /** The flags only, for display. */
  flags: string[];
  hostname: string;
  port: number;
}

export class LaunchError extends Error {
  override readonly name = "LaunchError";
}

/** `python`, a venv inside the install dir, or whatever the config names. */
export function pythonFor(config: Config): string {
  if (config.comfy.python) return config.comfy.python;
  const path = config.comfy.path;
  if (path) {
    for (const candidate of ["venv", ".venv"]) {
      const bin = join(
        path,
        candidate,
        Deno.build.os === "windows" ? "Scripts/python.exe" : "bin/python",
      );
      try {
        if (Deno.statSync(bin).isFile) return bin;
      } catch {
        // Not there; try the next one.
      }
    }
  }
  return Deno.build.os === "windows" ? "python" : "python3";
}

/**
 * ComfyUI sends no preview frames at all unless it is asked to: its
 * `--preview-method` defaults to `none`, so a sampler reports progress and
 * nothing else, and the running card sat on its own dark background waiting
 * for a frame that was never coming (§5 step 6). `auto` takes the model's
 * own TAESD decoder where there is one and falls back to latent2rgb, which
 * is what every frontend that shows live previews does.
 *
 * Last in the list but for `extra_args`, so a user who wants a different
 * method — or none — can still say so and have the last flag win.
 */
const PREVIEW_FLAGS = ["--preview-method", "auto"];

export function comfyLaunchCommand(
  config: Config,
  paths: DataPaths,
): LaunchCommand {
  if (!config.comfy.path) {
    throw new LaunchError(
      "no ComfyUI install path: set comfy.path in config.yaml or pass --comfy-path",
    );
  }
  const url = new URL(config.comfy.url);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const flags = [
    "--port",
    String(port),
    "--listen",
    url.hostname,
    "--output-directory",
    paths.staging,
    "--input-directory",
    paths.comfyInput,
    "--extra-model-paths-config",
    paths.extraModelPaths,
    ...PREVIEW_FLAGS,
    ...config.comfy.extra_args,
  ];
  return {
    command: pythonFor(config),
    args: ["main.py", ...flags],
    cwd: config.comfy.path,
    flags,
    hostname: url.hostname,
    port,
  };
}

/** The read-only block Settings shows for the connection card (§11.2). */
export function launchFlagsForDisplay(
  config: Config,
  paths: DataPaths,
): string[] {
  const url = new URL(config.comfy.url);
  return [
    `--port ${url.port}`,
    `--listen ${url.hostname}`,
    `--output-directory ${paths.staging}`,
    `--input-directory ${paths.comfyInput}`,
    `--extra-model-paths-config ${paths.extraModelPaths}`,
    PREVIEW_FLAGS.join(" "),
    ...config.comfy.extra_args,
  ];
}
