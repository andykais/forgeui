import { basename, extname, join } from "@std/path";
import type { Config } from "../config/types.ts";

/**
 * The minimal read-only model scan Phase 1 needs: enough for the LoRA picker
 * and the checkpoint picker to list something. No hashing, no metadata, no
 * writing anywhere near a model folder (§3, §8.1) — the model library proper
 * is Phase 2.
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

/** Cached per kind: a picker opening should not re-walk the disk each time. */
export class ModelScanner {
  #config: () => Config;
  #cache = new Map<string, { at: number; models: ScannedModel[] }>();
  #ttlMs: number;

  constructor(config: () => Config, ttlMs = 30_000) {
    this.#config = config;
    this.#ttlMs = ttlMs;
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
    return models;
  }

  /** The same matcher §12 describes for `q`: substring, case-insensitive. */
  static matches(model: ScannedModel, q: string): boolean {
    const needle = q.trim().toLowerCase();
    if (needle.length === 0) return true;
    return model.display_name.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle);
  }
}
