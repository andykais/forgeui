import type { Database } from "@db/sqlite";
import { basename, extname } from "@std/path";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { DataPaths } from "../config/paths.ts";
import type { ConfigStore } from "../config/config.ts";
import {
  firstSamplePathByModel,
  getModel,
  getModelByPath,
  latestOutputPathByModel,
  listModelFiles,
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
import type { TelemetryStore } from "../telemetry/store.ts";
import { classOf } from "../config/defaults.ts";
import type { ModelClass, ModelThumbnail } from "../config/types.ts";
import { FAMILIES } from "../workflows/types.ts";
import { backfillOutputModels, SidecarModelIndex } from "./backfill.ts";
import { type HashingProgress, ModelHasher } from "./hasher.ts";
import { DETECTOR_VERSION, probeFamily } from "./probe.ts";
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
  /**
   * When this file appeared here (§8.1): its creation time where the
   * filesystem reports one, its mtime otherwise. What the newest-first sort
   * reads; null only for a model whose file is gone and whose row never
   * recorded one.
   */
  added_at: number | null;
  display_name: string;
  family: string;
  notes: string | null;
  tags: string[];
  thumb_path: string | null;
  /**
   * The ends of this model's strength sliders (§8.1). Always a number: what
   * the row holds is what the owner typed, and this is that or the default.
   */
  strength_min: number;
  strength_max: number;
  /** The chosen sample, else the most recent output, else nothing (§8.1). */
  thumb_url: string | null;
  output_count: number;
  last_used_at: number | null;
  /**
   * Kept out of the Generate pickers (§8.1). The Models screen still lists
   * it, behind its own filter: something you cannot identify and might want
   * to delete later should be out of the way, not gone.
   */
  hidden: boolean;
  /** True until the hash lands; the UI shows the `hashing` badge (§8.1). */
  hashing: boolean;
  /**
   * Why the hasher could not read this file, when it could not. A failed
   * read leaves no `models` row, and a model with no row is "hashing" — so
   * without this a file the hasher will never get through wears the badge
   * for ever and says nothing about why (§8.1).
   */
  hash_error: string | null;
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
  /**
   * Tags, all of which a model must carry. `q` reaches tags too, but only
   * mixed in with names — asking for a tag and meaning it is a different
   * question, and one a name that happens to contain the word cannot answer.
   */
  tags?: string[];
  /**
   * Hidden models: `false` or absent lists only the visible ones, `true`
   * lists only the hidden. There is no "both" — the point of the filter is
   * to look at the pile you have set aside, or not to (§8.1).
   */
  hidden?: boolean;
  /**
   * How the list comes back (§8.1). `added` is newest first, which is what a
   * library you are still filling wants: the thing you just downloaded is the
   * thing you are looking for. `name` is the alphabetical order this screen
   * used to have and nothing else offers.
   */
  sort?: ModelSort;
}

/** §8.1's sort dropdown, spelled as the Gallery's is (§11.2). */
export type ModelSort = "added" | "oldest" | "name";

export interface FamilyCount {
  family: string;
  models: number;
}

/**
 * How far a LoRA's strength sliders reach when nobody has said otherwise.
 * Wide enough for the ones that want to be pushed, and every LoRA that is
 * happy at 1 is unbothered by the room either side (§8.1).
 */
export const DEFAULT_STRENGTH_MIN = -2;
export const DEFAULT_STRENGTH_MAX = 2;

/**
 * Whether a file's header has to be read again. The file must be unchanged
 * *and* the cached answer must have come from the detector running now: a
 * family added since is a different answer to the same question, and a cache
 * that cannot tell those apart is why adding one changed nothing for models
 * already on disk — no rescan would ever look at them again (§6).
 */
export function needsProbe(
  seen: ModelProbeRow | undefined,
  model: Pick<ScannedModel, "size" | "mtime">,
): boolean {
  if (!seen) return true;
  if (seen.size !== model.size || seen.mtime !== model.mtime) return true;
  return seen.detector !== DETECTOR_VERSION;
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
  /** The model-size report, written once per scan pass (§7.1). */
  telemetry?: TelemetryStore;
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
  #telemetry?: TelemetryStore;
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
    this.#telemetry = options.telemetry;
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
      // What this pass added or lost, against what the last one saw (§7.1).
      // Probing first means the entries carry the family the headers named.
      this.#recordModelSizes();
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
    const thumbs = this.#thumbs();
    const files = listModelFiles(this.#db);
    for (const model of this.scanner.registry.values()) {
      if (filters.kind && model.kind !== filters.kind) continue;
      views.push(this.#view(model, this.#rowFor(model.path, files), thumbs));
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
      view.hidden === (filters.hidden ?? false) &&
      matchesTags(view, filters.tags) &&
      matchesQuery(view, filters.q)
    );
    const byName = (a: ModelView, b: ModelView) =>
      a.display_name.localeCompare(b.display_name) ||
      a.name.localeCompare(b.name);
    const sort = filters.sort ?? "added";
    if (sort === "name") filtered.sort(byName);
    else {
      // A model with no date at all sorts as oldest either way round, rather
      // than jumping to the top of "newest first" on a zero.
      const newest = sort === "added";
      filtered.sort((a, b) => {
        const left = a.added_at;
        const right = b.added_at;
        if (left === right) return byName(a, b);
        if (left === null) return 1;
        if (right === null) return -1;
        return newest ? right - left : left - right;
      });
    }
    return filtered;
  }

  get(id: string): ModelDetail | null {
    const path = decodePathId(id);
    const row = path !== null
      ? this.#rowFor(path, listModelFiles(this.#db))
      : getModel(this.#db, normalizeModelHash(id));
    const scanned = path !== null
      ? this.scanner.registry.get(path) ?? null
      : row
      ? this.scanner.registry.get(row.path) ?? null
      : null;
    if (!scanned && !row) return null;
    const view = this.#view(scanned, row, this.#thumbs());
    return {
      ...view,
      samples: view.hash ? this.#samples?.list(view.hash) ?? [] : [],
    };
  }

  /**
   * Read one model's file again from scratch: the header and the hash, both
   * of them, ignoring every cache that would otherwise say "nothing has
   * changed here". That is the point — it exists for when a cached answer is
   * wrong, which no amount of re-running the ordinary scan would fix, since
   * the ordinary scan's whole job is to skip files that have not moved.
   *
   * The hash can come back different (the file really was edited), so the
   * model is resolved by path afterwards rather than by the id it came in
   * as, which may no longer name anything.
   */
  async rescanOne(id: string): Promise<ModelDetail> {
    const view = this.require(id);
    const scanned = this.scanner.registry.get(view.path);
    if (!scanned) throw new ModelNotFoundError(id);

    await this.#probe([scanned], true);
    this.hasher.forget(scanned.path);
    this.hasher.enqueue([scanned]);
    this.hasher.start();
    await this.hasher.idle();

    const after = this.get(pathId(scanned.path));
    if (!after) throw new ModelNotFoundError(id);
    log(`models: re-read ${scanned.name} — ${after.family}`);
    return after;
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
    const hidden = this.#hiddenFamilies();
    const counts = new Map<string, number>([["unset", 0]]);
    for (const family of FAMILIES) {
      if (!hidden.has(family)) counts.set(family, 0);
    }
    // `list()` leaves out the hidden ones, and a hidden family's models are
    // hidden, so they are already gone from these counts.
    for (const view of this.list()) {
      if (hidden.has(view.family)) continue;
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
      const row = this.#rowFor(scanned.path, listModelFiles(this.#db));
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

  /** The families `config.yaml` keeps out of sight entirely (§8.1). */
  #hiddenFamilies(): Set<string> {
    return new Set(this.#config.config.ui.hidden_families);
  }

  /**
   * Every family worth offering: the hardcoded list minus the ones the
   * config hides. A family nobody can see is not one to file a model as.
   */
  familyIsHidden(family: string): boolean {
    return this.#hiddenFamilies().has(family);
  }

  /** Both candidate pictures, plus which the user asked for (§8.1). */
  #thumbs(): ModelThumbs {
    return {
      prefer: this.#config.config.ui.model_thumbnail,
      samples: firstSamplePathByModel(this.#db),
      outputs: latestOutputPathByModel(this.#db),
    };
  }

  /**
   * The `models` row a path belongs to. `models` is keyed by content, so two
   * identical files at two paths share one row and only one of them is named
   * on it; going through the per-file hash finds it for both, rather than
   * leaving the other one looking like it had never been hashed (§8.1).
   */
  #rowFor(path: string, files: Map<string, { hash: string }>): ModelRow | null {
    const byPath = getModelByPath(this.#db, path);
    if (byPath) return byPath;
    const hash = files.get(path)?.hash;
    return hash ? getModel(this.#db, hash) : null;
  }

  #view(
    scanned: ScannedModel | null,
    row: ModelRow | null,
    thumbs: ModelThumbs,
  ): ModelView {
    const path = scanned?.path ?? row!.path;
    const filename = scanned?.filename ?? basename(path);
    const name = scanned?.name ?? filename;
    const failure = this.hasher.failures.get(path);
    // What the user filed it as wins; the header is the fallback, so a fresh
    // library sorts sensibly without anyone tagging anything (§6).
    const family = row?.family ?? this.#probes.get(path)?.arch ?? "unset";
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
      // A row whose file has gone has only the mtime the hasher recorded.
      added_at: scanned?.added_at ?? row?.mtime ?? null,
      // Unset, a display name falls back to the filename minus its extension.
      display_name: row?.display_name ?? basename(filename, extname(filename)),
      family,
      notes: row?.notes ?? null,
      tags: row?.tags ?? [],
      strength_min: row?.strength_min ?? DEFAULT_STRENGTH_MIN,
      strength_max: row?.strength_max ?? DEFAULT_STRENGTH_MAX,
      thumb_path: row?.thumb_path ?? null,
      thumb_url: thumbUrl(row, thumbs),
      output_count: row?.output_count ?? 0,
      last_used_at: row?.last_used_at ?? null,
      // A family the config hides makes every model in it hidden, without
      // touching the per-model flag: turning the family back on brings them
      // all back exactly as they were (§8.1).
      hidden: (row?.hidden ?? false) || this.#hiddenFamilies().has(family),
      // Still waiting only while nothing has gone wrong: a file that failed
      // to read is not on its way, it is stopped.
      hashing: row === null && !failure,
      hash_error: row === null ? failure ?? null : null,
      present: scanned !== null,
    };
  }

  /**
   * Read the header of every file whose size or mtime has moved since the
   * last pass, and remember what it says. A file that cannot be read or is
   * not recognised is recorded with a null arch, so a bad file is attempted
   * once per change rather than on every scan.
   *
   * LoRAs are read as well as the models themselves. A LoRA's family is the
   * one thing that decides whether a workflow can use it, and without this
   * every one of them sat at `unset` forever — there is nothing else to
   * infer it from, and nobody is going to file a hundred of them by hand.
   */
  async #probe(
    models: readonly ScannedModel[],
    force = false,
  ): Promise<void> {
    const overrides = this.#config.config.model_classes;
    for (const model of models) {
      const modelClass = classOf(model.kind, overrides);
      if (modelClass !== "diffusion" && modelClass !== "lora") continue;
      if (!force && !needsProbe(this.#probes.get(model.path), model)) continue;
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
        detector: DETECTOR_VERSION,
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

  /**
   * The model-size report (§7.1): the models on disk now, as this library
   * sees them — display name, class and family included — handed to the
   * telemetry store, which writes one entry per difference. A row whose file
   * has gone is not on disk, so it counts as a deletion.
   */
  #recordModelSizes(): void {
    if (!this.#telemetry) return;
    // Both piles: hiding a model is a decision about the pickers (§8.1), not
    // about the disk, and a report of what the folders hold that lost a
    // model the moment it was hidden would be reporting the wrong thing.
    const models = [...this.list(), ...this.list({ hidden: true })]
      .filter((model) => model.present)
      .map((model) => ({
        path: model.path,
        size: model.size,
        model_class: model.class,
        family: model.family === "unset" ? null : model.family,
        kind: model.kind,
        display_name: model.display_name,
      }));
    this.#telemetry.recordModelPass(models);
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

  /**
   * The class of every configured folder kind, in `config.yaml` order. The
   * Models screen groups its tabs by class — `checkpoints`, `unet`,
   * `diffusion_models` and `Stable-Diffusion` are one tab, because they hold
   * one kind of thing (§8.2) — and only the server knows the mapping, so it
   * is served rather than copied into the UI.
   */
  classes(): Record<string, ModelClass> {
    const overrides = this.#config.config.model_classes;
    return Object.fromEntries(
      this.scanner.kinds().map((kind) => [kind, classOf(kind, overrides)]),
    );
  }
}

/** Usage figures after outputs changed under a set of models. */
export function refreshUsageFor(db: Database, hashes: string[]): void {
  if (hashes.length > 0) refreshModelUsage(db, hashes);
}

/**
 * What a model is pictured by, everywhere it is pictured (§8.1). A thumbnail
 * chosen by hand always wins — "Set as thumbnail" is a decision, not a
 * preference. Failing that it is whatever `ui.model_thumbnail` asks for, and
 * the other one is the fallback, so a model with only one of the two is
 * still not an empty plate.
 */
function thumbUrl(
  row: ModelRow | null,
  thumbs: ModelThumbs,
): string | null {
  if (!row) return null;
  const [first, second] = thumbs.prefer === "first_sample"
    ? [thumbs.samples, thumbs.outputs]
    : [thumbs.outputs, thumbs.samples];
  const path = row.thumb_path ?? first.get(row.hash) ?? second.get(row.hash) ??
    null;
  return path === null ? null : mediaUrl(path);
}

/** Both candidate pictures for every model, and which one is wanted. */
interface ModelThumbs {
  prefer: ModelThumbnail;
  samples: Map<string, string>;
  outputs: Map<string, string>;
}

function matchesClass(view: ModelView, modelClass?: ModelClass): boolean {
  if (!modelClass) return true;
  return view.class === modelClass;
}

function matchesFamily(view: ModelView, family?: string): boolean {
  if (!family) return true;
  return view.family === family;
}

/**
 * Every asked-for tag, matched as a case-insensitive substring of one of the
 * model's own. Several narrow rather than widen: a model has to carry all of
 * them, the way the tag chips over the pickers already behave (§11.3).
 */
function matchesTags(view: ModelView, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  const mine = view.tags.map((tag) => tag.toLowerCase());
  return tags.every((tag) => {
    const needle = tag.trim().toLowerCase();
    return needle.length === 0 || mine.some((own) => own.includes(needle));
  });
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
