import type { Database } from "@db/sqlite";
import { basename, extname } from "@std/path";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { DataPaths } from "../config/paths.ts";
import type { ConfigStore } from "../config/config.ts";
import {
  getModel,
  getModelByPath,
  latestOutputPathByModel,
  listModelProbes,
  listModels,
  type ModelMetaPatch,
  type ModelProbeRow,
  type ModelRow,
  normalizeModelHash,
  refreshModelUsage,
  type SidecarModelRef,
  updateModelMeta,
  upsertModelProbe,
} from "../db/queries.ts";
import { mediaUrl } from "../outputs/store.ts";
import type { SampleStore, SampleView } from "../samples/store.ts";
import type { WsHub } from "../http/ws.ts";
import { classOf } from "../config/defaults.ts";
import type { ModelClass } from "../config/types.ts";
import { FAMILIES } from "../workflows/types.ts";
import { backfillOutputModels, SidecarModelIndex } from "./backfill.ts";
import { type HashingProgress, ModelHasher } from "./hasher.ts";
import { probeFamily } from "./probe.ts";
import { log, seconds } from "../log.ts";
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
  /** What the model is for, above the folder it came from (§3). */
  class: ModelClass;
  size: number;
  mtime: number | null;
  display_name: string;
  family: string;
  notes: string | null;
  tags: string[];
  thumb_path: string | null;
  /** The chosen sample, else the most recent output, else nothing (§8.1). */
  thumb_url: string | null;
  output_count: number;
  last_used_at: number | null;
  /** True until the hash lands; the UI shows the `hashing` badge (§8.1). */
  hashing: boolean;
  /** False when the row survives but the file is no longer on disk. */
  present: boolean;
}

/** The model page: the header, plus its Samples strip (§8.1, §8.3). */
export interface ModelDetail extends ModelView {
  samples: SampleView[];
}

export interface ModelListFilters {
  kind?: string;
  /** Every kind in the class; `diffusion` is the one picker's grab bag. */
  class?: ModelClass;
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

/** `thumb_sample_id` is resolved to a path here rather than by the caller. */
export interface ModelPatch extends ModelMetaPatch {
  thumb_sample_id?: string | null;
}

export interface ModelLibraryOptions {
  db: Database;
  paths: DataPaths;
  config: ConfigStore;
  hub: WsHub;
  /** The Samples strip and "Set as thumbnail" (§8.3). */
  samples?: SampleStore;
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
  #samples?: SampleStore;
  #index: SidecarModelIndex | null = null;
  #scanning: Promise<void> | null = null;
  #probes = new Map<string, ModelProbeRow>();
  #now: () => number;
  /** Whether the last progress said the hasher was still going. */
  #hashingWas = false;

  constructor(options: ModelLibraryOptions) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#config = options.config;
    this.#hub = options.hub;
    this.#samples = options.samples;
    this.#now = options.now ?? Date.now;
    this.#probes = listModelProbes(options.db);
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
      // Reading headers is cheap and its answer is what the pickers sort by,
      // so it happens before hashing rather than after it (§6).
      await this.#probe(result.models);
      // A pass over new files may find sidecars to link, so the index the
      // last pass built is stale.
      this.#index = null;
      const queued = this.hasher.enqueue(result.models);
      this.hasher.start();
      log(
        `models: ${result.models.length} files across ${result.folders} folders in ${
          seconds(result.elapsed_ms)
        }${queued > 0 ? ` — hashing ${queued}` : ""}`,
      );
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
    const thumbs = latestOutputPathByModel(this.#db);
    for (const model of this.scanner.registry.values()) {
      if (filters.kind && model.kind !== filters.kind) continue;
      views.push(
        this.#view(model, getModelByPath(this.#db, model.path), thumbs),
      );
    }
    // A hashed model whose file has gone still has a page and a history, so
    // it stays listed rather than disappearing from under its outputs.
    for (const row of listModels(this.#db, filters.kind)) {
      if (this.scanner.registry.has(row.path)) continue;
      views.push(this.#view(null, row, thumbs));
    }
    const filtered = views.filter((view) =>
      matchesClass(view, filters.class) &&
      matchesFamily(view, filters.family) &&
      matchesQuery(view, filters.q)
    );
    filtered.sort((a, b) =>
      a.display_name.localeCompare(b.display_name) ||
      a.name.localeCompare(b.name)
    );
    return filtered;
  }

  get(id: string): ModelDetail | null {
    const path = decodePathId(id);
    const row = path !== null
      ? getModelByPath(this.#db, path)
      : getModel(this.#db, normalizeModelHash(id));
    const scanned = path !== null
      ? this.scanner.registry.get(path) ?? null
      : row
      ? this.scanner.registry.get(row.path) ?? null
      : null;
    if (!scanned && !row) return null;
    const view = this.#view(scanned, row, latestOutputPathByModel(this.#db));
    return {
      ...view,
      samples: view.hash ? this.#samples?.list(view.hash) ?? [] : [],
    };
  }

  require(id: string): ModelDetail {
    const view = this.get(id);
    if (!view) throw new ModelNotFoundError(id);
    return view;
  }

  /** The edit-in-place header (§8.1); 409 until the file has been hashed. */
  patch(id: string, patch: ModelPatch): ModelDetail {
    const view = this.require(id);
    if (view.hash === null) throw new ModelUnhashedError(view.name);
    const { thumb_sample_id, ...meta } = patch;
    if (thumb_sample_id !== undefined) {
      meta.thumb_path = thumb_sample_id === null
        ? null
        : this.#thumbPathOf(view.hash, thumb_sample_id);
    }
    updateModelMeta(this.#db, view.hash, meta);
    return this.require(view.hash);
  }

  /** "Set as thumbnail" (§8.3): the sample has to be one of this model's. */
  #thumbPathOf(hash: string, sampleId: string): string {
    const sample = this.#samples?.get(sampleId);
    if (!sample || sample.model_hash !== hash) {
      throw new ModelNotFoundError(sampleId);
    }
    return sample.path;
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

  #view(
    scanned: ScannedModel | null,
    row: ModelRow | null,
    thumbs: Map<string, string>,
  ): ModelView {
    const path = scanned?.path ?? row!.path;
    const filename = scanned?.filename ?? basename(path);
    const name = scanned?.name ?? filename;
    const kind = scanned?.kind ?? row!.kind;
    return {
      id: row ? row.hash : pathId(path),
      hash: row?.hash ?? null,
      path,
      name,
      filename,
      kind,
      class: classOf(kind, this.#config.config.model_classes),
      size: scanned?.size ?? row!.size,
      mtime: scanned?.mtime ?? row?.mtime ?? null,
      // Unset, a display name falls back to the filename minus its extension.
      display_name: row?.display_name ?? basename(filename, extname(filename)),
      // What the user filed it as wins; the header is the fallback, so a
      // fresh library sorts sensibly without anyone tagging anything (§6).
      family: row?.family ?? this.#probes.get(path)?.arch ?? "unset",
      notes: row?.notes ?? null,
      tags: row?.tags ?? [],
      thumb_path: row?.thumb_path ?? null,
      thumb_url: thumbUrl(row, thumbs),
      output_count: row?.output_count ?? 0,
      last_used_at: row?.last_used_at ?? null,
      hashing: row === null,
      present: scanned !== null,
    };
  }

  /**
   * Read the header of every diffusion-class file whose size or mtime has
   * moved since the last pass, and remember what it says. A file that cannot
   * be read or is not recognised is recorded with a null arch, so a bad file
   * is attempted once per change rather than on every scan.
   */
  async #probe(models: readonly ScannedModel[]): Promise<void> {
    const overrides = this.#config.config.model_classes;
    for (const model of models) {
      if (classOf(model.kind, overrides) !== "diffusion") continue;
      const seen = this.#probes.get(model.path);
      if (
        seen && seen.size === model.size && seen.mtime === model.mtime
      ) {
        continue;
      }
      let arch: string | null = null;
      try {
        arch = await probeFamily(model.path);
      } catch {
        // Not a safetensors file, or unreadable. Neither is fatal: the model
        // stays listed and the user can still file it by hand (§8.1).
        arch = null;
      }
      const row: ModelProbeRow = {
        path: model.path,
        size: model.size,
        mtime: model.mtime,
        arch,
        probed_at: this.#now(),
      };
      this.#probes.set(model.path, row);
      try {
        upsertModelProbe(this.#db, row);
      } catch (error) {
        console.error(`could not record the probe of ${model.name}:`, error);
      }
    }
  }

  #broadcastRescan(progress: RescanProgress): void {
    this.#hub.broadcast({ type: "rescan_progress", data: progress });
  }

  #broadcastHashing(progress: HashingProgress): void {
    // One line at the end of the pass, never one per file: the per-file
    // detail is what `/ws` carries.
    if (this.#hashingWas && !progress.running) {
      log(`models: hashed ${progress.done} of ${progress.total}`);
    }
    this.#hashingWas = progress.running;
    this.#hub.broadcast({ type: "hashing_progress", data: progress });
  }

  /** Folders the requested kind or class is scanned from (Settings, the UI). */
  folders(filter: { kind?: string; class?: ModelClass } = {}): string[] {
    const configured = this.#config.config.model_folders;
    if (filter.kind) return configured[filter.kind] ?? [];
    if (filter.class) {
      const overrides = this.#config.config.model_classes;
      const found: string[] = [];
      for (const [kind, folders] of Object.entries(configured)) {
        if (classOf(kind, overrides) !== filter.class) continue;
        for (const folder of folders) {
          if (!found.includes(folder)) found.push(folder);
        }
      }
      return found;
    }
    return Object.values(configured).flat();
  }

  /**
   * Whether a file of this class is on disk under this name. A workflow binds
   * the folder-relative name ComfyUI resolves, so this is the same question
   * ComfyUI will ask when the graph is queued — asked early enough to say so
   * before anything is submitted.
   */
  hasModelNamed(name: string, modelClass: ModelClass): boolean {
    const overrides = this.#config.config.model_classes;
    let any = false;
    for (const model of this.scanner.registry.values()) {
      if (classOf(model.kind, overrides) !== modelClass) continue;
      any = true;
      if (model.name === name) return true;
    }
    // Nothing of this class has been scanned, so there is no difference here
    // between a name that is missing and a folder that was never configured.
    // Answering "yes" keeps the app usable for someone whose library the app
    // cannot see; the only cost is that ComfyUI reports the failure instead.
    return !any;
  }

  /** Kinds belonging to a class, for the scan a class-filtered list needs. */
  kindsOfClass(modelClass: ModelClass): string[] {
    const overrides = this.#config.config.model_classes;
    return this.scanner.kinds().filter((kind) =>
      classOf(kind, overrides) === modelClass
    );
  }
}

/** Usage figures after outputs changed under a set of models. */
export function refreshUsageFor(db: Database, hashes: string[]): void {
  if (hashes.length > 0) refreshModelUsage(db, hashes);
}

/** The chosen sample, else the most recent output, else an empty plate. */
function thumbUrl(row: ModelRow | null, thumbs: Map<string, string>):
  | string
  | null {
  if (!row) return null;
  const path = row.thumb_path ?? thumbs.get(row.hash) ?? null;
  return path === null ? null : mediaUrl(path);
}

function matchesClass(view: ModelView, modelClass?: ModelClass): boolean {
  if (!modelClass) return true;
  return view.class === modelClass;
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
