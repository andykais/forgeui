import { basename, extname, join } from "@std/path";
import type { Config } from "../config/types.ts";

/**
 * The read-only walk of the configured model folders (§3, §8.1). Nothing here
 * writes anywhere near a model folder, and nothing here hashes: a scan is
 * what makes a model appear in the pickers, identified by its path, and
 * `src/models/hasher.ts` gives it an identity afterwards.
 */

export interface ScannedModel {
  /** Absolute path on disk. */
  path: string;
  /** What a workflow binds to: the path relative to its model folder. */
  name: string;
  filename: string;
  /** Falls back to the filename minus its extension (§8.1). */
  display_name: string;
  /** Always `unset` until Phase 2 can infer or record one. */
  family: string;
  kind: string;
  size: number;
  mtime: number | null;
}

const MODEL_EXTENSIONS = new Set([
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".sft",
  ".gguf",
  ".bin",
]);

async function walk(
  root: string,
  kind: string,
  prefix = "",
  depth = 0,
): Promise<ScannedModel[]> {
  if (depth > 4) return [];
  const found: ScannedModel[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch {
    // A folder that is missing or unreadable is reported as empty; Settings
    // marks missing folders rather than dropping them (§11.2).
    return found;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      found.push(...await walk(path, kind, name, depth + 1));
      continue;
    }
    if (!MODEL_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    let stat: Deno.FileInfo | null = null;
    try {
      stat = await Deno.stat(path);
    } catch {
      continue;
    }
    found.push({
      path,
      // ComfyUI names a model by its path inside the folder it was found in.
      name,
      filename: basename(entry.name),
      display_name: basename(entry.name, extname(entry.name)),
      family: "unset",
      kind,
      size: stat.size,
      mtime: stat.mtime?.getTime() ?? null,
    });
  }
  return found;
}

/** What a scan reports while it runs (§8.1's `rescan_progress`). */
export interface RescanProgress {
  running: boolean;
  folders_done: number;
  folders_total: number;
  models: number;
}

export interface RescanResult {
  models: ScannedModel[];
  kinds: string[];
  folders: number;
  elapsed_ms: number;
}

/**
 * Cached per kind so a picker opening does not re-walk the disk, and kept in
 * a registry keyed by path so the rest of the library can resolve a model
 * that has no hash yet.
 */
export class ModelScanner {
  #config: () => Config;
  #cache = new Map<string, { at: number; models: ScannedModel[] }>();
  #registry = new Map<string, ScannedModel>();
  #ttlMs: number;
  #progress: RescanProgress = {
    running: false,
    folders_done: 0,
    folders_total: 0,
    models: 0,
  };

  constructor(config: () => Config, ttlMs = 30_000) {
    this.#config = config;
    this.#ttlMs = ttlMs;
  }

  /** Every model seen by the last scan of each kind, keyed by absolute path. */
  get registry(): ReadonlyMap<string, ScannedModel> {
    return this.#registry;
  }

  get progress(): RescanProgress {
    return { ...this.#progress };
  }

  /** The kinds `config.yaml` names; a folder list may be empty. */
  kinds(): string[] {
    return Object.keys(this.#config().model_folders);
  }

  async list(kind: string, options: { refresh?: boolean } = {}): Promise<
    ScannedModel[]
  > {
    const cached = this.#cache.get(kind);
    if (!options.refresh && cached && Date.now() - cached.at < this.#ttlMs) {
      return cached.models;
    }
    const folders = this.#config().model_folders[kind] ?? [];
    const models: ScannedModel[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
      for (const model of await walk(folder, kind)) {
        if (seen.has(model.name)) continue; // The first folder wins, as ComfyUI does.
        seen.add(model.name);
        models.push(model);
      }
    }
    models.sort((a, b) => a.display_name.localeCompare(b.display_name));
    this.#cache.set(kind, { at: Date.now(), models });
    this.#remember(kind, models);
    return models;
  }

  /**
   * Walk every configured kind and replace the registry with what is on disk
   * now. Called at startup and by Rescan; the caller pushes the progress it
   * reports on `/ws`.
   */
  async rescan(
    onProgress?: (progress: RescanProgress) => void,
  ): Promise<RescanResult> {
    const startedAt = Date.now();
    const folders = this.kinds().flatMap((kind) =>
      (this.#config().model_folders[kind] ?? []).map((folder) => ({
        kind,
        folder,
      }))
    );
    this.#progress = {
      running: true,
      folders_done: 0,
      folders_total: folders.length,
      models: 0,
    };
    onProgress?.(this.progress);

    const byKind = new Map<string, ScannedModel[]>();
    for (const kind of this.kinds()) byKind.set(kind, []);
    for (const { kind, folder } of folders) {
      const found = byKind.get(kind)!;
      const seen = new Set(found.map((model) => model.name));
      for (const model of await walk(folder, kind)) {
        if (seen.has(model.name)) continue;
        seen.add(model.name);
        found.push(model);
      }
      this.#progress = {
        running: true,
        folders_done: this.#progress.folders_done + 1,
        folders_total: folders.length,
        models: [...byKind.values()].reduce(
          (total, models) => total + models.length,
          0,
        ),
      };
      onProgress?.(this.progress);
    }

    this.#registry.clear();
    const all: ScannedModel[] = [];
    for (const [kind, models] of byKind) {
      models.sort((a, b) => a.display_name.localeCompare(b.display_name));
      this.#cache.set(kind, { at: Date.now(), models });
      this.#remember(kind, models);
      all.push(...models);
    }
    this.#progress = {
      running: false,
      folders_done: folders.length,
      folders_total: folders.length,
      models: all.length,
    };
    onProgress?.(this.progress);
    return {
      models: all,
      kinds: [...byKind.keys()],
      folders: folders.length,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  #remember(kind: string, models: ScannedModel[]): void {
    for (const [path, model] of [...this.#registry]) {
      if (model.kind === kind) this.#registry.delete(path);
    }
    for (const model of models) this.#registry.set(model.path, model);
  }

  /** The same matcher §12 describes for `q`: substring, case-insensitive. */
  static matches(model: ScannedModel, q: string): boolean {
    const needle = q.trim().toLowerCase();
    if (needle.length === 0) return true;
    return model.display_name.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle);
  }
}
