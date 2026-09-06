import { api } from "../api.ts";
import type {
  ComfyStatus,
  Config,
  HashingProgress,
  Job,
  ModelEntry,
  Output,
  RescanProgress,
  TileSize,
  UiScreen,
  WorkflowSummary,
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
  checkpoints = $state<ModelEntry[]>([]);
  /** The model library's two background passes (§8.1), pushed on `/ws`. */
  rescan = $state<RescanProgress | null>(null);
  hashing = $state<HashingProgress | null>(null);

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
    const [loras, checkpoints] = await Promise.all([
      api.modelsOfKind("loras").catch(() => []),
      api.modelsOfKind("checkpoints").catch(() => []),
    ]);
    this.loras = loras;
    this.checkpoints = checkpoints;
  }

  /** Everything the pickers and the models filter name, by hash. */
  model(hash: string | null | undefined): ModelEntry | null {
    if (!hash) return null;
    return (
      [...this.checkpoints, ...this.loras].find(
        (model) => model.hash === hash || model.id === hash,
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
    if (job.status !== "running" && this.previews[job.id]) {
      const { [job.id]: done, ...rest } = this.previews;
      URL.revokeObjectURL(done);
      this.previews = rest;
    }
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
