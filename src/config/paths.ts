import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type { ImportConfig, OutputsConfig } from "./types.ts";

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
  /** Saved ways to fill a workflow's panel (§4.8), as workflows are kept. */
  bundledTemplates: string;
  userTemplates: string;
  /**
   * Where generated media and their sidecars live. `<appdata>/outputs` unless
   * `outputs.dir` moves it. The database never records this folder: a stored
   * path starts with the word `outputs/`, which {@link diskPath} reads as
   * "wherever the outputs are" (§3).
   */
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
 * `imports`, `downloads` and `outputs` depend on the config rather than on
 * the root alone, which is why this takes more than the root. Without the
 * settings they fall where they would anyway.
 */
export function dataPaths(
  root: string,
  settings?: Pick<ImportConfig, "dir" | "model_dir"> | null,
  outputs?: Pick<OutputsConfig, "dir"> | null,
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
    bundledTemplates: join(abs, "templates", "bundled"),
    userTemplates: join(abs, "templates", "user"),
    outputs: under(outputs?.dir, "outputs"),
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
      paths.bundledTemplates,
      paths.userTemplates,
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

/**
 * The first segment of every media path the database stores. Each names a
 * folder in {@link DataPaths}, not a folder under the root: `outputs/` is
 * wherever the outputs are, so moving them never rewrites a row (§3).
 */
export const MEDIA_ROOTS = ["outputs", "inputs", "samples"] as const;
export type MediaRoot = typeof MEDIA_ROOTS[number];

/** A stored path that names no media folder, or climbs out of one. */
export class StoredPathError extends Error {
  override readonly name = "StoredPathError";
}

/**
 * A stored media path (`outputs/2026/09/05/01J-0.png`) → the file on disk.
 *
 * The one place that turns a row's path into a location: everything that
 * reads, serves or removes a file the database names goes through here, so
 * `outputs.dir` is honoured everywhere or nowhere. A path that names no media
 * folder, or that climbs out of the one it names, is refused.
 */
export function diskPath(paths: DataPaths, stored: string): string {
  const normalized = normalize(stored).replaceAll("\\", "/");
  const [root, ...rest] = normalized.split("/");
  if (!(MEDIA_ROOTS as readonly string[]).includes(root ?? "")) {
    throw new StoredPathError(
      `"${stored}" must start with ${MEDIA_ROOTS.join("/, ")}/`,
    );
  }
  const base = resolve(paths[root as MediaRoot]);
  const absolute = resolve(base, ...rest);
  if (absolute !== base && !absolute.startsWith(base + SEPARATOR)) {
    throw new StoredPathError(`"${stored}" escapes ${root}/`);
  }
  return absolute;
}

/**
 * A file inside `paths.outputs` → the path the database stores for it, the
 * inverse of {@link diskPath}: `outputs/` followed by its place in the
 * outputs folder, whatever that folder is called on disk.
 */
export function storedOutputPath(paths: DataPaths, absolute: string): string {
  const inside = relative(resolve(paths.outputs), resolve(absolute));
  if (
    inside === ".." || inside.startsWith(`..${SEPARATOR}`) ||
    isAbsolute(inside)
  ) {
    throw new StoredPathError(`${absolute} is not inside ${paths.outputs}`);
  }
  return ["outputs", ...inside.split(SEPARATOR)].join("/");
}
