import type { Database } from "@db/sqlite";
import { basename, extname } from "@std/path";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { DataPaths } from "../config/paths.ts";
import type { ConfigStore } from "../config/config.ts";
import {
  getModel,
  getModelByPath,
  listModels,
  type ModelMetaPatch,
  type ModelRow,
  refreshModelUsage,
  type SidecarModelRef,
  updateModelMeta,
} from "../db/queries.ts";
import type { WsHub } from "../http/ws.ts";
import { FAMILIES } from "../workflows/types.ts";
import { backfillOutputModels, SidecarModelIndex } from "./backfill.ts";
import { type HashingProgress, ModelHasher } from "./hasher.ts";
import {
  ModelScanner,
  type RescanProgress,
  type ScannedModel,
} from "./scan.ts";

/**
 * The model library (§8.1): what is on disk, what has been hashed, and the
 * metadata the user hung off it. A model appears here as soon as it is
 * scanned — identified by `path` — and gains a hash, and with it an editable
 * identity, once the background hasher gets to it.
 */

export class ModelNotFoundError extends Error {
  override readonly name = "ModelNotFoundError";
  constructor(id: string) {
    super(`no model "${id}"`);
  }
}

/** Editing needs a hash, and the hash is not there yet (§8.1). */
export class ModelUnhashedError extends Error {
  override readonly name = "ModelUnhashedError";
  constructor(name: string) {
    super(`"${name}" is still being hashed; its metadata cannot be edited yet`);
  }
}

export interface ModelView {
  /** The hash, or `path:<base64url>` while the file has none. */
  id: string;
  hash: string | null;
  path: string;
  /** What a workflow binds to: the path relative to its model folder. */
  name: string;
  filename: string;
  kind: string;
  size: number;
  mtime: number | null;
  display_name: string;
  family: string;
  notes: string | null;
  tags: string[];
  thumb_path: string | null;
  output_count: number;
  last_used_at: number | null;
  /** True until the hash lands; the UI shows the `hashing` badge (§8.1). */
  hashing: boolean;
  /** False when the row survives but the file is no longer on disk. */
  present: boolean;
}

export interface ModelListFilters {
  kind?: string;
  family?: string;
  q?: string;
}

export interface FamilyCount {
  family: string;
  models: number;
}

/** Which folder kinds a sidecar's role is likely to have come from. */
const ROLE_KINDS: Record<string, string[]> = {
  checkpoint: ["checkpoints"],
  unet: ["unet", "diffusion_models", "checkpoints"],
  lora: ["loras"],
  vae: ["vae"],
  clip: ["clip", "text_encoders"],
};

export function pathId(path: string): string {
  return `path:${encodeBase64Url(new TextEncoder().encode(path))}`;
}

export function decodePathId(id: string): string | null {
  if (!id.startsWith("path:")) return null;
  try {
    return new TextDecoder().decode(decodeBase64Url(id.slice("path:".length)));
  } catch {
    return null;
  }
}

export interface ModelLibraryOptions {
  db: Database;
  paths: DataPaths;
  config: ConfigStore;
  hub: WsHub;
  scanner?: ModelScanner;
  now?: () => number;
}

export class ModelLibrary {
  readonly scanner: ModelScanner;
  readonly hasher: ModelHasher;
  #db: Database;
  #paths: DataPaths;
  #config: ConfigStore;
  #hub: WsHub;
  #index: SidecarModelIndex | null = null;
  #scanning: Promise<void> | null = null;

  constructor(options: ModelLibraryOptions) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#config = options.config;
    this.#hub = options.hub;
    this.scanner = options.scanner ??
      new ModelScanner(() => options.config.config);
    this.hasher = new ModelHasher({
      db: options.db,
      now: options.now,
      onProgress: (progress) => this.#broadcastHashing(progress),
      onHashed: async ({ model, hash, fresh }) => {
        if (!fresh) return;
        await this.#backfill(model, hash);
      },
    });
  }

  /** Startup and Rescan: walk the folders, then hash what is new. */
  async rescan(): Promise<{ models: number; queued: number }> {
    if (this.#scanning) await this.#scanning;
    let finish = () => {};
    this.#scanning = new Promise((resolve) => {
      finish = resolve;
    });
    try {
      const result = await this.scanner.rescan((progress) =>
        this.#broadcastRescan(progress)
      );
      // A pass over new files may find sidecars to link, so the index the
      // last pass built is stale.
      this.#index = null;
      const queued = this.hasher.enqueue(result.models);
      this.hasher.start();
      return { models: result.models.length, queued };
    } finally {
      finish();
      this.#scanning = null;
    }
  }

  /** Kick the first scan off without making the boot wait for it (§11.3). */
  startBackground(): void {
    this.rescan().catch((error) => {
      console.error("the model scan failed:", error);
    });
  }

  stop(): void {
    this.hasher.stop();
  }

  /** Tests: resolves once the scan and the hashing queue have both drained. */
  async idle(): Promise<void> {
    if (this.#scanning) await this.#scanning;
    await this.hasher.idle();
  }

  get progress(): { rescan: RescanProgress; hashing: HashingProgress } {
    return { rescan: this.scanner.progress, hashing: this.hasher.progress };
  }

  // ------------------------------------------------------------------ views

  list(filters: ModelListFilters = {}): ModelView[] {
    const views: ModelView[] = [];
    for (const model of this.scanner.registry.values()) {
      if (filters.kind && model.kind !== filters.kind) continue;
      views.push(this.#view(model, getModelByPath(this.#db, model.path)));
    }
    // A hashed model whose file has gone still has a page and a history, so
    // it stays listed rather than disappearing from under its outputs.
    for (const row of listModels(this.#db, filters.kind)) {
      if (this.scanner.registry.has(row.path)) continue;
      views.push(this.#view(null, row));
    }
    const filtered = views.filter((view) =>
      matchesFamily(view, filters.family) && matchesQuery(view, filters.q)
    );
    filtered.sort((a, b) =>
      a.display_name.localeCompare(b.display_name) ||
      a.name.localeCompare(b.name)
    );
    return filtered;
  }

  get(id: string): ModelView | null {
    const path = decodePathId(id);
    if (path !== null) {
      const scanned = this.scanner.registry.get(path) ?? null;
      const row = getModelByPath(this.#db, path);
      if (!scanned && !row) return null;
      return this.#view(scanned, row);
    }
    const row = getModel(this.#db, id);
    if (!row) return null;
    return this.#view(this.scanner.registry.get(row.path) ?? null, row);
  }

  require(id: string): ModelView {
    const view = this.get(id);
    if (!view) throw new ModelNotFoundError(id);
    return view;
  }

  /** The edit-in-place header (§8.1); 409 until the file has been hashed. */
  patch(id: string, patch: ModelMetaPatch): ModelView {
    const view = this.require(id);
    if (view.hash === null) throw new ModelUnhashedError(view.name);
    updateModelMeta(this.#db, view.hash, patch);
    return this.require(view.hash);
  }

  familyCounts(): FamilyCount[] {
    const counts = new Map<string, number>([["unset", 0]]);
    for (const family of FAMILIES) counts.set(family, 0);
    for (const view of this.list()) {
      counts.set(view.family, (counts.get(view.family) ?? 0) + 1);
    }
    return [...counts].map(([family, models]) => ({ family, models }));
  }

  // ------------------------------------------------------------- resolution

  /**
   * Fill in the hashes a sidecar could not know, by the name the graph used.
   * Job completion and `reindex` both go through this, so they agree (§8.1).
   */
  resolveModels(models: readonly SidecarModelRef[]): SidecarModelRef[] {
    return models.map((model) => {
      if (model.hash) return model;
      const scanned = this.#byName(model.name, model.role);
      if (!scanned) return model;
      const row = getModelByPath(this.#db, scanned.path);
      return row ? { ...model, hash: row.hash } : model;
    });
  }

  #byName(name: string, role: string): ScannedModel | null {
    const kinds = ROLE_KINDS[role] ?? [];
    let fallback: ScannedModel | null = null;
    for (const model of this.scanner.registry.values()) {
      if (model.name !== name) continue;
      if (kinds.includes(model.kind)) return model;
      fallback ??= model;
    }
    return fallback;
  }

  // ------------------------------------------------------------------ inner

  async #backfill(model: ScannedModel, hash: string): Promise<void> {
    try {
      if (
        this.#index === null ||
        this.#index.stamp !== SidecarModelIndex.stampOf(this.#db)
      ) {
        this.#index = await SidecarModelIndex.build(this.#db, this.#paths);
      }
      backfillOutputModels(this.#db, this.#index, { name: model.name, hash });
    } catch (error) {
      console.error(`could not backfill ${model.name}:`, error);
    }
  }

  #view(scanned: ScannedModel | null, row: ModelRow | null): ModelView {
    const path = scanned?.path ?? row!.path;
    const filename = scanned?.filename ?? basename(path);
    const name = scanned?.name ?? filename;
    return {
      id: row ? row.hash : pathId(path),
      hash: row?.hash ?? null,
      path,
      name,
      filename,
      kind: scanned?.kind ?? row!.kind,
      size: scanned?.size ?? row!.size,
      mtime: scanned?.mtime ?? row?.mtime ?? null,
      // Unset, a display name falls back to the filename minus its extension.
      display_name: row?.display_name ?? basename(filename, extname(filename)),
      family: row?.family ?? "unset",
      notes: row?.notes ?? null,
      tags: row?.tags ?? [],
      thumb_path: row?.thumb_path ?? null,
      output_count: row?.output_count ?? 0,
      last_used_at: row?.last_used_at ?? null,
      hashing: row === null,
      present: scanned !== null,
    };
  }

  #broadcastRescan(progress: RescanProgress): void {
    this.#hub.broadcast({ type: "rescan_progress", data: progress });
  }

  #broadcastHashing(progress: HashingProgress): void {
    this.#hub.broadcast({ type: "hashing_progress", data: progress });
  }

  /** Folders the requested kind is scanned from, for Settings and the UI. */
  folders(kind?: string): string[] {
    const configured = this.#config.config.model_folders;
    if (kind) return configured[kind] ?? [];
    return Object.values(configured).flat();
  }
}

/** Usage figures after outputs changed under a set of models. */
export function refreshUsageFor(db: Database, hashes: string[]): void {
  if (hashes.length > 0) refreshModelUsage(db, hashes);
}

function matchesFamily(view: ModelView, family?: string): boolean {
  if (!family) return true;
  return view.family === family;
}

/** §12's `q`: substring, case-insensitive, over display name, file and tags. */
function matchesQuery(view: ModelView, q?: string): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (needle.length === 0) return true;
  return view.display_name.toLowerCase().includes(needle) ||
    view.name.toLowerCase().includes(needle) ||
    view.filename.toLowerCase().includes(needle) ||
    view.tags.some((tag) => tag.toLowerCase().includes(needle));
}
