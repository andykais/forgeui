import { isAbsolute, join, resolve } from "@std/path";
import type { ImportConfig } from "./types.ts";

/** Every path the app owns inside `<appdata>` (DESIGN.md §3). */
export interface DataPaths {
  root: string;
  db: string;
  /** The telemetry log of §7.1; a separate file from `app.db` on purpose. */
  telemetryDb: string;
  configFile: string;
  extraModelPaths: string;
  workflows: string;
  bundledWorkflows: string;
  userWorkflows: string;
  outputs: string;
  inputs: string;
  samples: string;
  /**
   * Where `forge models` drops batches and the app picks them up
   * (DESIGN-MODEL-IMPORT §5.1). Moved by `import.dir`.
   */
  imports: string;
  /**
   * Where ingest files weights fetched with `--download-model`. An ordinary
   * model folder as far as the scan and `extra_model_paths.yaml` are
   * concerned; the only thing special about it is that the app may write
   * there, because it is inside the data directory the app has always owned
   * (§5.1). Moved by `import.model_dir`.
   */
  downloads: string;
  modelsMeta: string;
  staging: string;
  comfyInput: string;
}

/**
 * `imports` and `downloads` are the first paths here that depend on the
 * config rather than on the root alone, which is why this takes a second
 * argument at all. Without one they fall where they would anyway.
 */
export function dataPaths(
  root: string,
  settings?: Pick<ImportConfig, "dir" | "model_dir"> | null,
): DataPaths {
  const abs = resolve(root);
  const under = (configured: string | null | undefined, fallback: string) => {
    if (!configured || configured.length === 0) return join(abs, fallback);
    return isAbsolute(configured) ? configured : join(abs, configured);
  };
  return {
    root: abs,
    db: join(abs, "app.db"),
    telemetryDb: join(abs, "telemetry.db"),
    configFile: join(abs, "config.yaml"),
    extraModelPaths: join(abs, "extra_model_paths.yaml"),
    workflows: join(abs, "workflows"),
    bundledWorkflows: join(abs, "workflows", "bundled"),
    userWorkflows: join(abs, "workflows", "user"),
    outputs: join(abs, "outputs"),
    inputs: join(abs, "inputs"),
    samples: join(abs, "samples"),
    imports: under(settings?.dir, "import"),
    downloads: under(settings?.model_dir, "models"),
    modelsMeta: join(abs, "models-meta"),
    staging: join(abs, "staging"),
    comfyInput: join(abs, "comfy-input"),
  };
}

export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  for (
    const dir of [
      paths.root,
      paths.bundledWorkflows,
      paths.userWorkflows,
      paths.outputs,
      paths.inputs,
      paths.samples,
      paths.imports,
      paths.downloads,
      paths.modelsMeta,
      paths.staging,
      paths.comfyInput,
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true });
  }
}
