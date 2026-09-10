import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { isAbsolute, join, resolve } from "@std/path";
import { defaultConfig } from "./defaults.ts";
import { type DataPaths, dataPaths, ensureDataDirs } from "./paths.ts";
import { ConfigError, validatePartialConfig } from "./validate.ts";
import type { Config, PartialConfig, PartialUiConfig } from "./types.ts";

export const DATA_DIR_ENV = "FORGEUI_DATA_DIR";
const DEFAULT_DATA_DIR = ".forgeui";

const CONFIG_HEADER = `# ForgeUI configuration.
#
# Hand-edit this file, or let Settings write it. Model folders and the ComfyUI
# connection are read at launch: change them here and restart the app.
# CLI flags (--comfy-path, --comfy-url, --models-dir kind=path, --port) override
# these values for one run and are never written back.
`;

export interface EnvSource {
  get(key: string): string | undefined;
}

function homeDir(env: EnvSource): string {
  const home = env.get("HOME") ?? env.get("USERPROFILE");
  if (!home) {
    throw new ConfigError(
      `cannot find the home directory; pass --data-dir or set ${DATA_DIR_ENV}`,
    );
  }
  return home;
}

/** `--data-dir` beats `FORGEUI_DATA_DIR` beats `~/.forgeui` (§3.1). */
export function resolveDataDir(
  options: { flag?: string | null; env?: EnvSource } = {},
): string {
  const env = options.env ?? Deno.env;
  const fromEnv = env.get(DATA_DIR_ENV);
  const chosen = options.flag ??
    (fromEnv && fromEnv.length > 0 ? fromEnv : null);
  if (chosen) return resolve(chosen);
  return join(homeDir(env), DEFAULT_DATA_DIR);
}

function mergeSection<T extends object>(
  base: T | undefined,
  layer: T | undefined,
): T | undefined {
  if (!base) return layer ? { ...layer } : undefined;
  if (!layer) return { ...base };
  return { ...base, ...layer };
}

function mergeUi(
  base: PartialUiConfig | undefined,
  layer: PartialUiConfig | undefined,
): PartialUiConfig | undefined {
  if (!base) return layer ? { ...layer } : undefined;
  if (!layer) return { ...base };
  const ui: PartialUiConfig = { ...base, ...layer };
  const tile_size = mergeSection(base.tile_size, layer.tile_size);
  const sidebar = mergeSection(base.sidebar_collapsed, layer.sidebar_collapsed);
  const filmstrip = mergeSection(
    base.filmstrip_collapsed,
    layer.filmstrip_collapsed,
  );
  if (tile_size) ui.tile_size = tile_size;
  if (sidebar) ui.sidebar_collapsed = sidebar;
  if (filmstrip) ui.filmstrip_collapsed = filmstrip;
  return ui;
}

/** Layer `b` over `a`; only keys present in a layer take effect. */
export function mergePartialConfig(
  a: PartialConfig,
  b: PartialConfig,
): PartialConfig {
  const out: PartialConfig = {};
  const server = mergeSection(a.server, b.server);
  const comfy = mergeSection(a.comfy, b.comfy);
  const folders = mergeSection(a.model_folders, b.model_folders);
  const classes = mergeSection(a.model_classes, b.model_classes);
  const keys = mergeSection(a.keys, b.keys);
  const ui = mergeUi(a.ui, b.ui);
  if (server) out.server = server;
  if (comfy) out.comfy = comfy;
  if (folders) out.model_folders = folders;
  if (classes) out.model_classes = classes;
  if (keys) out.keys = keys;
  if (ui) out.ui = ui;
  return out;
}

/** Apply layers onto the defaults, producing a complete config. */
export function effectiveConfig(...layers: PartialConfig[]): Config {
  const base = defaultConfig();
  const layer = layers.reduce(mergePartialConfig, {} as PartialConfig);
  return {
    server: { ...base.server, ...layer.server },
    comfy: { ...base.comfy, ...layer.comfy },
    model_folders: { ...base.model_folders, ...layer.model_folders },
    model_classes: { ...base.model_classes, ...layer.model_classes },
    keys: { ...base.keys, ...layer.keys },
    ui: {
      ...base.ui,
      ...layer.ui,
      tile_size: { ...base.ui.tile_size, ...layer.ui?.tile_size },
      sidebar_collapsed: {
        ...base.ui.sidebar_collapsed,
        ...layer.ui?.sidebar_collapsed,
      },
      filmstrip_collapsed: {
        ...base.ui.filmstrip_collapsed,
        ...layer.ui?.filmstrip_collapsed,
      },
    },
  };
}

export function stringifyConfig(config: PartialConfig): string {
  return CONFIG_HEADER + stringifyYaml(config as Record<string, unknown>, {
    lineWidth: 78,
  });
}

export function parseConfigDocument(
  text: string,
  source: string,
): PartialConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    throw new ConfigError(
      `${source}: not valid YAML: ${
        cause instanceof Error ? cause.message : cause
      }`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  return validatePartialConfig(parsed, source);
}

export interface ConfigStoreInit {
  paths: DataPaths;
  onDisk: PartialConfig;
  overrides: PartialConfig;
}

/**
 * Holds the two layers separately so writes never persist a CLI override:
 * `config.yaml` is rewritten from `onDisk` alone, while readers see the
 * effective merge (§3.1).
 */
export class ConfigStore {
  readonly paths: DataPaths;
  #onDisk: PartialConfig;
  #overrides: PartialConfig;
  #effective: Config;

  constructor(init: ConfigStoreInit) {
    this.paths = init.paths;
    this.#onDisk = init.onDisk;
    this.#overrides = init.overrides;
    this.#effective = effectiveConfig(this.#onDisk, this.#overrides);
  }

  get config(): Config {
    return this.#effective;
  }

  get onDisk(): PartialConfig {
    return structuredClone(this.#onDisk);
  }

  get overrides(): PartialConfig {
    return structuredClone(this.#overrides);
  }

  /** Which sections a CLI flag is currently pinning; Settings shows them read-only. */
  get overriddenPaths(): string[] {
    const out: string[] = [];
    for (const [section, value] of Object.entries(this.#overrides)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        out.push(`${section}.${key}`);
      }
    }
    return out.sort();
  }

  /**
   * Merge a partial config into `config.yaml` and rewrite it. `model_folders`
   * is launch-time only and is refused here (§11.2).
   */
  async patch(patch: unknown): Promise<Config> {
    const validated = validatePartialConfig(patch, "patch");
    if (validated.model_folders) {
      throw new ConfigError(
        "patch.model_folders: model folders are read at launch; edit config.yaml and restart",
      );
    }
    this.#onDisk = mergePartialConfig(this.#onDisk, validated);
    await this.write();
    this.#effective = effectiveConfig(this.#onDisk, this.#overrides);
    return this.#effective;
  }

  async write(): Promise<void> {
    await Deno.writeTextFile(
      this.paths.configFile,
      stringifyConfig(this.#onDisk),
    );
  }
}

export interface LoadConfigOptions {
  dataDir: string;
  overrides?: PartialConfig;
}

export interface LoadedConfig {
  store: ConfigStore;
  /** True on first run, when `config.yaml` had to be created (§3.1). */
  created: boolean;
}

/**
 * Create `<appdata>` if needed, read `config.yaml` (writing a default one on
 * first run) and layer the CLI overrides on top.
 */
export async function loadConfig(
  options: LoadConfigOptions,
): Promise<LoadedConfig> {
  const paths = dataPaths(options.dataDir);
  await ensureDataDirs(paths);

  let onDisk: PartialConfig;
  let created = false;
  let text: string | null = null;
  try {
    text = await Deno.readTextFile(paths.configFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  if (text === null) {
    onDisk = defaultConfig();
    created = true;
  } else {
    onDisk = parseConfigDocument(text, "config.yaml");
  }

  const store = new ConfigStore({
    paths,
    onDisk,
    overrides: options.overrides ?? {},
  });
  if (created) await store.write();
  return { store, created };
}

/** Model folders must be absolute so ComfyUI resolves them the same way. */
export function assertAbsoluteModelFolders(config: Config): void {
  for (const [kind, folders] of Object.entries(config.model_folders)) {
    for (const folder of folders) {
      if (!isAbsolute(folder)) {
        throw new ConfigError(
          `model_folders.${kind}: "${folder}" must be an absolute path`,
        );
      }
    }
  }
}

export { ConfigError };
