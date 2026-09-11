import { api } from "../api.ts";
import {
  type ComfyStatus,
  type Config,
  FAMILIES,
  type HashingProgress,
  type Job,
  type ModelEntry,
  type Output,
  type RescanProgress,
  type TileSize,
  type UiScreen,
  type WorkflowSummary,
} from "../types.ts";
import { decodePreviewFrame } from "../lib/preview.ts";
import { plain } from "../lib/state.svelte.ts";

/**
 * Everything the screens share, in one place: the config (including the UI
 * preferences that live in `config.yaml`), ComfyUI's state, the workflow list,
 * and the jobs and outputs of this session. All of it is fed by `/ws`, so a
 * refresh rebuilds the same view (§5 step 6, §7).
 */

class AppState {
  config = $state<Config | null>(null);
  comfy = $state<ComfyStatus | null>(null);
  dataDir = $state<string>("");
  workflows = $state<WorkflowSummary[]>([]);
  loras = $state<ModelEntry[]>([]);
  /** Everything that can drive a generation, from every diffusion folder. */
  checkpoints = $state<ModelEntry[]>([]);
  /**
   * The other classes a `model` param can pick from — a workflow names its
   * text encoder and VAE as well as its base model (§5), and each picker asks
   * for its own class.
   */
  clips = $state<ModelEntry[]>([]);
  vaes = $state<ModelEntry[]>([]);
  /** The model library's two background passes (§8.1), pushed on `/ws`. */
  rescan = $state<RescanProgress | null>(null);
  hashing = $state<HashingProgress | null>(null);
  /**
   * The families the server knows, from `/api/families`. The constant is only
   * a fallback: the filters and the family pickers must not go stale when the
   * server's list grows (§8.1).
   */
  serverFamilies = $state<string[]>([]);

  /** Recent jobs, newest first: the session grid and the queue strip (§11.1). */
  jobs = $state<Job[]>([]);
  /** Output rows by id, and the ids each job produced. */
  outputs = $state<Record<string, Output>>({});
  /** Blob URLs of ComfyUI's preview frames, by job id (§5 step 6). */
  previews = $state<Record<string, string>>({});
  connected = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);

  #socket: WebSocket | null = null;
  #reconnect: ReturnType<typeof setTimeout> | null = null;

  get comfyReady(): boolean {
    return this.comfy?.state === "running";
  }

  get activeJobs(): Job[] {
    return this.jobs.filter((job) => job.status === "queued" || job.status === "running");
  }

  get runningJob(): Job | null {
    return this.jobs.find((job) => job.status === "running") ?? null;
  }

  workflow(id: string | null | undefined): WorkflowSummary | null {
    if (!id) return null;
    return this.workflows.find((workflow) => workflow.id === id) ?? null;
  }

  jobOutputs(job: Job): Output[] {
    return job.outputs
      .map((id) => this.outputs[id])
      .filter(
        (output): output is Output => output !== undefined && output.deleted_at === null,
      );
  }

  async load(): Promise<void> {
    try {
      const [config, status, workflows, jobs, outputs] = await Promise.all([
        api.config(),
        api.systemStatus(),
        api.workflows(),
        api.jobs({ status: "all", limit: 40 }),
        api.outputs({ limit: 120 }),
      ]);
      this.config = config;
      this.comfy = status.comfy;
      this.dataDir = status.data_dir;
      this.workflows = workflows;
      this.jobs = jobs;
      this.outputs = Object.fromEntries(
        outputs.outputs.map((output) => [output.id, output]),
      );
      this.loaded = true;
      this.connect();
      this.refreshModels();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async refreshModels(): Promise<void> {
    const [loras, checkpoints, clips, vaes, families] = await Promise.all([
      api.modelsOfKind("loras").catch(() => []),
      api.modelsOfClass("diffusion").catch(() => []),
      api.modelsOfClass("clip").catch(() => []),
      api.modelsOfClass("vae").catch(() => []),
      api.families().catch(() => []),
    ]);
    this.loras = loras;
    this.checkpoints = checkpoints;
    this.clips = clips;
    this.vaes = vaes;
    this.serverFamilies = families
      .map((count) => count.family)
      .filter((family) => family !== "unset");
  }

  /**
   * Every family a chip or a picker should offer: what the server validates
   * against, plus anything the models on disk are already filed as, so a
   * family that only exists in the library is still selectable. `unset` is
   * not one of these — it is how the UI spells "no family".
   */
  get families(): string[] {
    const names = new Set<string>([...this.serverFamilies, ...FAMILIES]);
    for (const model of [
      ...this.checkpoints,
      ...this.loras,
      ...this.clips,
      ...this.vaes,
    ]) {
      if (model.family && model.family !== "unset") names.add(model.family);
    }
    return [...names];
  }

  /** The list a `model` param of this class picks from. */
  modelsOfClass(modelClass: string | undefined): ModelEntry[] {
    switch (modelClass) {
      case "clip":
        return this.clips;
      case "vae":
        return this.vaes;
      case "lora":
        return this.loras;
      default:
        return this.checkpoints;
    }
  }

  /** Everything the pickers and the models filter name, by hash. */
  model(hash: string | null | undefined): ModelEntry | null {
    if (!hash) return null;
    return (
      [...this.checkpoints, ...this.loras, ...this.clips, ...this.vaes].find(
        (model) => model.hash === hash || model.id === hash,
      ) ?? null
    );
  }

  /**
   * The model a workflow's filename refers to — `name` is the path under the
   * model folder, which is exactly what a graph binds and what a sidecar
   * records, so it identifies a file where a role does not.
   */
  modelByName(name: string | null | undefined): ModelEntry | null {
    if (!name) return null;
    return (
      [...this.checkpoints, ...this.loras, ...this.clips, ...this.vaes].find(
        (model) => model.name === name,
      ) ?? null
    );
  }

  /** A model's display name, wherever one is named (§8.1). */
  modelName(hash: string | null | undefined): string {
    const model = this.model(hash);
    if (model) return model.display_name;
    return hash ? `${hash.slice(0, 8)}…` : "unknown";
  }

  async refreshWorkflows(): Promise<void> {
    this.workflows = await api.workflows();
  }

  // ------------------------------------------------------------------ events

  connect(): void {
    if (this.#socket) return;
    const url = `${location.origin.replace("http", "ws")}/ws`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.onopen = () => {
      this.connected = true;
    };
    socket.onmessage = (event) => this.#onMessage(event);
    socket.onclose = () => {
      this.connected = false;
      this.#socket = null;
      // The app is local; a dropped socket means the server restarted.
      if (this.#reconnect === null) {
        this.#reconnect = setTimeout(() => {
          this.#reconnect = null;
          this.connect();
        }, 1000);
      }
    };
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      const frame = decodePreviewFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!frame) return;
      const url = URL.createObjectURL(
        new Blob([frame.image as BlobPart], {
          type: frame.format === 1 ? "image/jpeg" : "image/png",
        }),
      );
      const previous = this.previews[frame.jobId];
      this.previews = { ...this.previews, [frame.jobId]: url };
      if (previous) URL.revokeObjectURL(previous);
      return;
    }
    const message = JSON.parse(event.data) as { type: string; data: unknown };
    switch (message.type) {
      case "system_status":
        this.comfy = message.data as ComfyStatus;
        break;
      case "rescan_progress":
        this.rescan = message.data as RescanProgress;
        break;
      case "hashing_progress": {
        const progress = message.data as HashingProgress;
        const finished = this.hashing?.running === true && !progress.running;
        this.hashing = progress;
        // New hashes mean new identities, counts and thumbnails.
        if (finished) void this.refreshModels();
        break;
      }
      case "job":
        this.#mergeJob(message.data as Job);
        break;
      case "output":
      case "output_deleted": {
        const output = message.data as Output;
        this.outputs = {
          ...this.outputs,
          [output.id]: {
            ...output,
            media_url: output.media_url ?? `/api/media/${output.path}`,
          },
        };
        if (message.type === "output" && output.deleted_at === null) {
          this.#touchWorkflow(output.workflow_id, {
            lastJobAt: output.created_at,
            lastOutputId: output.id,
          });
        }
        break;
      }
    }
  }

  #mergeJob(job: Job): void {
    const index = this.jobs.findIndex((existing) => existing.id === job.id);
    if (index < 0) {
      this.jobs = [job, ...this.jobs];
    } else {
      const next = [...this.jobs];
      next[index] = job;
      this.jobs = next;
    }
    // `last run` is on the workflow summary, which `/ws` does not resend; a
    // job is the news that it moved, so patch it here rather than making the
    // panel wait for a reload (§11.2).
    this.#touchWorkflow(job.workflow_id, { lastJobAt: job.created_at });
    if (job.status !== "running" && this.previews[job.id]) {
      const { [job.id]: done, ...rest } = this.previews;
      URL.revokeObjectURL(done);
      this.previews = rest;
    }
  }

  /** Move a workflow summary forward in place; never backward in time. */
  #touchWorkflow(
    id: string | null,
    at: { lastJobAt?: number; lastOutputId?: string },
  ): void {
    if (!id) return;
    const index = this.workflows.findIndex((workflow) => workflow.id === id);
    if (index < 0) return;
    const current = this.workflows[index]!;
    const lastJobAt = Math.max(current.last_job_at ?? 0, at.lastJobAt ?? 0);
    const lastOutputId = at.lastOutputId ?? current.last_output_id;
    if (
      lastJobAt === (current.last_job_at ?? 0) &&
      lastOutputId === current.last_output_id
    ) {
      return;
    }
    const next = [...this.workflows];
    next[index] = {
      ...current,
      last_job_at: lastJobAt === 0 ? null : lastJobAt,
      last_output_id: lastOutputId,
    };
    this.workflows = next;
  }

  // ------------------------------------------------- ui preferences (§3.1)

  tileSize(screen: UiScreen): TileSize {
    return this.config?.ui.tile_size[screen] ?? "small";
  }

  setTileSize(screen: UiScreen, size: TileSize): void {
    this.#patchUi({ tile_size: { [screen]: size } }, (ui) => {
      ui.tile_size[screen] = size;
    });
  }

  sidebarCollapsed(screen: UiScreen): boolean {
    return this.config?.ui.sidebar_collapsed[screen] ?? false;
  }

  setSidebarCollapsed(screen: UiScreen, collapsed: boolean): void {
    this.#patchUi({ sidebar_collapsed: { [screen]: collapsed } }, (ui) => {
      ui.sidebar_collapsed[screen] = collapsed;
    });
  }

  filmstripCollapsed(screen: UiScreen): boolean {
    return this.config?.ui.filmstrip_collapsed[screen] ?? false;
  }

  setFilmstripCollapsed(screen: UiScreen, collapsed: boolean): void {
    this.#patchUi({ filmstrip_collapsed: { [screen]: collapsed } }, (ui) => {
      ui.filmstrip_collapsed[screen] = collapsed;
    });
  }

  get railExpanded(): boolean {
    return this.config?.ui.rail_expanded ?? false;
  }

  setRailExpanded(expanded: boolean): void {
    this.#patchUi({ rail_expanded: expanded }, (ui) => {
      ui.rail_expanded = expanded;
    });
  }

  /**
   * The order the Workflows screen was dragged into (§4.6). Applied to the
   * list held here as well as saved, so the Generate picker follows on the
   * same frame rather than after the next fetch.
   */
  reorderWorkflows(ids: string[]): void {
    const at = new Map(ids.map((id, index) => [id, index]));
    this.workflows = [...this.workflows].sort((a, b) =>
      (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity)
    );
    this.#patchUi({ workflow_order: ids }, (ui) => {
      ui.workflow_order = ids;
    });
  }

  /** Optimistic locally, then persisted: Settings has no save button (§11.2). */
  #patchUi(patch: unknown, apply: (ui: Config["ui"]) => void): void {
    if (!this.config) return;
    const next = plain(this.config);
    apply(next.ui);
    this.config = next;
    api.patchConfig({ ui: patch }).catch((cause) => {
      this.error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  /** The two keyboard behaviours, read from `config.yaml` only (§11.4). */
  keyAction(event: KeyboardEvent): string | null {
    const keys = this.config?.keys;
    if (!keys) return null;
    for (const [action, bindings] of Object.entries(keys)) {
      if (bindings.includes(event.key)) return action;
    }
    return null;
  }
}

export const app = new AppState();
