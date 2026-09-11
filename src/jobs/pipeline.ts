import type { Database } from "@db/sqlite";
import { join } from "@std/path";
import { ulid } from "@std/ulid";
import type { DataPaths } from "../config/paths.ts";
import { ComfyHttpError } from "../comfy/client.ts";
import type { ComfyEvent, ComfyImageRef } from "../comfy/events.ts";
import type { ComfyManager } from "../comfy/manager.ts";
import {
  failInterruptedJobs,
  getJob,
  getJobByPromptId,
  getOutput,
  insertJob,
  type JobError,
  type JobRow,
  jobsInFlight,
  listOutputsForJob,
  nodeTimingsFor,
  type OutputRow,
  type Progress,
  setJobPromptId,
  type SidecarModelRef,
  updateJobProgress,
  updateJobStatus,
} from "../db/queries.ts";
import type { WsHub } from "../http/ws.ts";
import type { OutputStore } from "../outputs/store.ts";
import type { TelemetryStore } from "../telemetry/store.ts";
import type { VramMonitor } from "../telemetry/vram.ts";
import { isOutputNodeType } from "../workflows/nodes.ts";
import { coerceParams } from "../workflows/coerce.ts";
import { rewriteGraph } from "../workflows/rewrite.ts";
import {
  WorkflowNotFoundError,
  type WorkflowStore,
} from "../workflows/loader.ts";
import type { ApiGraph, Manifest } from "../workflows/types.ts";
import { isRunnable, MODEL_PARAM_CLASS } from "../workflows/types.ts";
import type { ModelClass } from "../config/types.ts";
import {
  completeJob,
  type JobOutputImages,
  removeStagingDir,
} from "./completion.ts";
import { completedProgress, ProgressTracker } from "./progress.ts";
import { parseSidecar } from "./sidecar.ts";
import { log, logError, oneLine, seconds } from "../log.ts";

/**
 * The job pipeline (§5): validate, rewrite, persist, submit, follow the
 * websocket, and move the results out of staging. Every state a job can be in
 * is on its row, so a browser refresh or an app restart loses nothing (§5
 * step 4, §7).
 */

/** A bad request: the route maps this to 400. */
export class JobRequestError extends Error {
  override readonly name = "JobRequestError";
}

export class ComfyOfflineError extends Error {
  override readonly name = "ComfyOfflineError";
  constructor(state: string) {
    super(`ComfyUI is not connected (${state})`);
  }
}

export class JobNotFoundError extends Error {
  override readonly name = "JobNotFoundError";
  constructor(id: string) {
    super(`no job "${id}"`);
  }
}

export class JobSubmitError extends Error {
  override readonly name = "JobSubmitError";
  readonly nodeErrors: Record<string, unknown>;
  /** The job row exists: a rejected submission is still a recorded attempt. */
  readonly job: JobRow;

  constructor(
    message: string,
    job: JobRow,
    nodeErrors: Record<string, unknown>,
  ) {
    super(message);
    this.job = job;
    this.nodeErrors = nodeErrors;
  }
}

/** How often a job's progress is written to the database while it runs. */
const PROGRESS_WRITE_INTERVAL_MS = 250;

interface LiveJob {
  jobId: string;
  promptId: string | null;
  tracker: ProgressTracker;
  images: Map<string, ComfyImageRef[]>;
  lastWriteAt: number;
  finalized: boolean;
}

export interface SubmitJobBody {
  workflow_id?: unknown;
  params?: unknown;
}

export interface RerunJobBody {
  output_id?: unknown;
  job_id?: unknown;
}

export interface JobRunnerOptions {
  db: Database;
  paths: DataPaths;
  workflows: WorkflowStore;
  comfy: ComfyManager;
  hub: WsHub;
  /** Used to broadcast outputs in the shape the API returns them. */
  outputs: OutputStore;
  /** Fills in the hashes of models the library has already hashed (§8.1). */
  resolveModels?: (models: SidecarModelRef[]) => SidecarModelRef[];
  /** Whether a model of this class is on disk under this name (§5.1). */
  modelExists?: (name: string, modelClass: ModelClass) => boolean;
  /** The output-size report; absent in tests that do not care (§7.1). */
  telemetry?: TelemetryStore;
  /** Opens and closes the VRAM report's sampling window (§7.1). */
  vram?: VramMonitor;
  now?: () => number;
}

export class JobRunner {
  #db: Database;
  #paths: DataPaths;
  #workflows: WorkflowStore;
  #comfy: ComfyManager;
  #hub: WsHub;
  #outputs: OutputStore;
  #resolveModels?: (models: SidecarModelRef[]) => SidecarModelRef[];
  #modelExists?: (name: string, modelClass: ModelClass) => boolean;
  #telemetry?: TelemetryStore;
  #vram?: VramMonitor;
  #now: () => number;
  #live = new Map<string, LiveJob>();
  #byPrompt = new Map<string, string>();
  /** The job whose node last reported executing; preview frames belong to it. */
  #currentJobId: string | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: JobRunnerOptions) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#workflows = options.workflows;
    this.#comfy = options.comfy;
    this.#hub = options.hub;
    this.#outputs = options.outputs;
    this.#resolveModels = options.resolveModels;
    this.#modelExists = options.modelExists;
    this.#telemetry = options.telemetry;
    this.#vram = options.vram;
    this.#now = options.now ?? Date.now;
  }

  /** Resolves once every event handled so far has finished its work. */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const chain = this.#chain;
      await chain;
      if (chain === this.#chain) return;
    }
  }

  // --------------------------------------------------------------- submitting

  async submit(body: SubmitJobBody): Promise<JobRow> {
    const workflowId = typeof body.workflow_id === "string"
      ? body.workflow_id
      : "";
    if (workflowId.length === 0) {
      throw new JobRequestError("workflow_id is required");
    }
    const workflow = this.#workflows.get(workflowId);
    if (!workflow) throw new WorkflowNotFoundError(workflowId);
    if (workflow.error !== null || !workflow.manifest) {
      throw new JobRequestError(
        `workflow "${workflowId}" cannot run: ${
          workflow.error ?? "no manifest"
        }`,
      );
    }
    if (!isRunnable(workflow)) {
      throw new JobRequestError(
        `workflow "${workflowId}" has no output node yet; open it in ComfyUI and save`,
      );
    }
    const params = typeof body.params === "object" && body.params !== null
      ? body.params as Record<string, unknown>
      : {};
    // Params are checked before the connection: what is wrong with the panel
    // is wrong whether or not ComfyUI happens to be up, and saying so is more
    // use than "not connected".
    const { values } = coerceParams(workflow.manifest, params);
    try {
      this.#assertModelsPresent(workflow.manifest, values);
      this.#assertConnected();
    } catch (cause) {
      // A refusal never reaches a job row, so this is the only record of it.
      logError(
        `generate refused for ${workflowId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      throw cause;
    }
    const jobId = ulid();
    const { graph } = rewriteGraph({
      manifest: workflow.manifest,
      graph: workflow.apiGraph,
      params: values,
      jobId,
    });

    return await this.#persistAndSubmit({
      jobId,
      workflowId,
      workflowHash: workflow.hash,
      params: values,
      graph,
    });
  }

  /** `Rerun now ⟳`: the frozen graph, verbatim apart from where it writes. */
  async rerun(body: RerunJobBody): Promise<JobRow> {
    this.#assertConnected();
    const source = await this.#frozenGraph(body);
    const jobId = ulid();
    const graph = restampOutputs(source.graph, jobId);
    return await this.#persistAndSubmit({
      jobId,
      workflowId: source.workflowId,
      workflowHash: source.workflowHash,
      params: source.params,
      graph,
    });
  }

  async #frozenGraph(body: RerunJobBody): Promise<{
    graph: ApiGraph;
    params: Record<string, unknown>;
    workflowId: string | null;
    workflowHash: string | null;
  }> {
    if (typeof body.job_id === "string" && body.job_id.length > 0) {
      const job = getJob(this.#db, body.job_id);
      if (!job) throw new JobNotFoundError(body.job_id);
      if (Object.keys(job.api_graph).length === 0) {
        throw new JobRequestError(`job "${job.id}" has no graph to rerun`);
      }
      return {
        graph: job.api_graph,
        params: job.params,
        workflowId: job.workflow_id,
        workflowHash: job.workflow_hash,
      };
    }
    if (typeof body.output_id === "string" && body.output_id.length > 0) {
      const output = getOutput(this.#db, body.output_id);
      if (!output) throw new JobNotFoundError(body.output_id);
      // The sidecar is the source of truth, and it works even if the
      // workflow has been deleted since (§6.1).
      const sidecar = parseSidecar(
        await Deno.readTextFile(join(this.#paths.root, output.sidecar_path)),
        output.sidecar_path,
      );
      if (!sidecar.api_graph || Object.keys(sidecar.api_graph).length === 0) {
        throw new JobRequestError(
          `output "${output.id}" has no api_graph in its sidecar`,
        );
      }
      return {
        graph: sidecar.api_graph as ApiGraph,
        params: sidecar.params,
        workflowId: sidecar.workflow?.id ?? output.workflow_id,
        workflowHash: sidecar.workflow?.hash ?? output.workflow_hash,
      };
    }
    throw new JobRequestError("rerun needs an output_id or a job_id");
  }

  async #persistAndSubmit(input: {
    jobId: string;
    workflowId: string | null;
    workflowHash: string | null;
    params: Record<string, unknown>;
    graph: ApiGraph;
  }): Promise<JobRow> {
    // Truncated to the second because the sidecar is the source of truth and
    // §6.2 records `created_at` to the second: this keeps the row, the sidecar
    // and the `outputs/YYYY/MM/DD` directory in exact agreement, so `reindex`
    // reproduces the row rather than approximating it. Durations come from
    // started_at/finished_at, which stay at millisecond precision.
    const createdAt = Math.floor(this.#now() / 1000) * 1000;
    insertJob(this.#db, {
      id: input.jobId,
      workflow_id: input.workflowId,
      workflow_hash: input.workflowHash,
      params: input.params,
      api_graph: input.graph,
      created_at: createdAt,
    });
    // The prompt id is ours and is recorded first, so events that arrive
    // while `/prompt` is still in flight already have a job to belong to.
    const promptId = crypto.randomUUID();
    setJobPromptId(this.#db, input.jobId, promptId);
    this.#byPrompt.set(promptId, input.jobId);
    this.#live.set(input.jobId, {
      jobId: input.jobId,
      promptId,
      tracker: new ProgressTracker(input.graph, {
        now: this.#now,
        weights: nodeTimingsFor(this.#db, input.workflowHash),
      }),
      images: new Map(),
      lastWriteAt: 0,
      finalized: false,
    });
    this.#broadcastJob(input.jobId);
    // Before the POST, because the row is what makes it a queued job and
    // ComfyUI can answer `execution_start` before `/prompt` returns.
    log(
      `job ${input.jobId} queued — ${this.#labelFor(input.workflowId)}${
        this.#promptOf(input.workflowId, input.params)
      }`,
    );

    try {
      const { prompt_id } = await this.#comfy.client.prompt(
        input.graph,
        promptId,
      );
      if (prompt_id !== promptId) {
        // An older ComfyUI ignored our id; go with the one it chose.
        setJobPromptId(this.#db, input.jobId, prompt_id);
        this.#byPrompt.set(prompt_id, input.jobId);
        const live = this.#live.get(input.jobId);
        if (live) live.promptId = prompt_id;
      }
      this.#broadcastJob(input.jobId);
      return this.#requireJob(input.jobId);
    } catch (cause) {
      const error: JobError = {
        type: "submit_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        node_errors: cause instanceof ComfyHttpError ? cause.nodeErrors : {},
      };
      this.#fail(input.jobId, error);
      throw new JobSubmitError(
        error.message,
        this.#requireJob(input.jobId),
        error.node_errors ?? {},
      );
    }
  }

  // -------------------------------------------------------------- cancelling

  /** `POST /api/jobs/:id/cancel`: interrupt if running, dequeue if queued. */
  async cancel(id: string): Promise<JobRow> {
    const job = getJob(this.#db, id);
    if (!job) throw new JobNotFoundError(id);
    if (job.status !== "queued" && job.status !== "running") return job;

    if (job.prompt_id && job.status === "running") {
      await this.#comfy.client.interrupt().catch(() => {});
      // ComfyUI answers with execution_interrupted; if the socket is down the
      // next reconcile settles it from /history.
      return this.#requireJob(id);
    }
    if (job.prompt_id) {
      await this.#comfy.client.deleteQueued([job.prompt_id]).catch(() => {});
    }
    await this.#markCancelled(id);
    return this.#requireJob(id);
  }

  /** `POST /api/jobs/clear`: cancel every queued job, leave the running one. */
  async clearQueue(): Promise<JobRow[]> {
    const queued = jobsInFlight(this.#db).filter((job) =>
      job.status === "queued"
    );
    if (queued.length === 0) return [];
    await this.#comfy.client.clearQueue().catch(() => {});
    for (const job of queued) await this.#markCancelled(job.id);
    return queued.map((job) => this.#requireJob(job.id));
  }

  async #markCancelled(id: string): Promise<void> {
    if (!this.#inFlight(id)) return;
    updateJobStatus(this.#db, id, {
      status: "cancelled",
      finished_at: this.#now(),
    });
    await removeStagingDir(this.#paths, id);
    this.#forget(id);
    this.#broadcastJob(id);
    log(`job ${id} cancelled`);
  }

  // ------------------------------------------------------------------ events

  /** Wired to the ComfyUI websocket; ordering per job is preserved. */
  handleEvent(event: ComfyEvent): void {
    if (event.type === "preview") {
      if (this.#currentJobId) {
        this.#hub.broadcastPreview(
          this.#currentJobId,
          event.format,
          event.bytes,
        );
      }
      return;
    }
    if (event.type === "status") {
      this.#hub.broadcast({
        type: "system_status",
        data: this.#comfy.status(),
      });
      return;
    }
    const promptId = event.prompt_id;
    if (!promptId) return;
    const jobId = this.#jobIdFor(promptId);
    if (!jobId) return;

    switch (event.type) {
      case "execution_start": {
        const live = this.#ensureLive(jobId);
        live.tracker.start();
        this.#currentJobId = jobId;
        // A generation is under way: the VRAM report samples now, every ten
        // seconds, and again when this closes (§7.1).
        this.#vram?.generationStarted(jobId);
        updateJobStatus(this.#db, jobId, {
          status: "running",
          started_at: this.#now(),
          progress: live.tracker.snapshot(),
        });
        this.#broadcastJob(jobId);
        log(`job ${jobId} started — ${live.tracker.nodeTotal} nodes`);
        return;
      }
      case "execution_cached": {
        const live = this.#ensureLive(jobId);
        live.tracker.cached(event.nodes);
        this.#publishProgress(live, true);
        return;
      }
      case "executing": {
        const live = this.#ensureLive(jobId);
        this.#currentJobId = jobId;
        live.tracker.executing(event.node);
        if (event.node === null) {
          // Older ComfyUI marks the end of a prompt this way.
          this.#enqueue(() => this.#finalize(jobId));
          return;
        }
        this.#publishProgress(live, true);
        return;
      }
      case "progress": {
        const live = this.#ensureLive(jobId);
        live.tracker.progress(event.node, event.value, event.max);
        this.#publishProgress(live, false);
        return;
      }
      case "executed": {
        const live = this.#ensureLive(jobId);
        if (event.images.length > 0) live.images.set(event.node, event.images);
        return;
      }
      case "execution_success":
        this.#enqueue(() => this.#finalize(jobId));
        return;
      case "execution_error":
        this.#enqueue(async () => {
          await this.#failAndClean(jobId, {
            type: event.exception_type,
            message: event.exception_message,
            node_id: event.node_id,
            node_type: event.node_type,
            traceback: event.traceback,
          });
        });
        return;
      case "execution_interrupted":
        this.#enqueue(() => this.#markCancelled(jobId));
        return;
    }
  }

  #publishProgress(live: LiveJob, force: boolean): void {
    const progress = live.tracker.snapshot();
    const now = this.#now();
    // Throttle the writes, not the pushes: clients see every frame, while the
    // row keeps a recent-enough copy for a refresh (§5 step 6).
    if (force || now - live.lastWriteAt >= PROGRESS_WRITE_INTERVAL_MS) {
      live.lastWriteAt = now;
      updateJobProgress(this.#db, live.jobId, progress);
    }
    this.#broadcastJob(live.jobId, progress);
  }

  // -------------------------------------------------------------- finishing

  async #finalize(jobId: string, images?: JobOutputImages[]): Promise<void> {
    const live = this.#live.get(jobId);
    if (live?.finalized) return;
    const job = getJob(this.#db, jobId);
    if (!job || (job.status !== "running" && job.status !== "queued")) return;
    if (live) live.finalized = true;

    const at = this.#now();
    live?.tracker.finish(at);
    const collected = images ??
      [...(live?.images ?? new Map())].map(([node, files]) => ({
        node,
        files,
      }));

    try {
      const manifest = this.#manifestFor(job);
      const result = await completeJob({
        db: this.#db,
        paths: this.#paths,
        job,
        manifest,
        images: collected,
        timing: {
          total_ms: live?.tracker.totalMs(at) ?? 0,
          nodes: live?.tracker.timings() ?? {},
        },
        createdAt: new Date(job.created_at),
        resolveModels: this.#resolveModels,
      });
      updateJobStatus(this.#db, jobId, {
        status: "done",
        finished_at: at,
        progress: completedProgress(live?.tracker.nodeTotal ?? 1),
        error: null,
      });
      this.#forget(jobId);
      this.#broadcastJob(jobId);
      log(
        `job ${jobId} finished in ${
          seconds(
            live?.tracker.totalMs(at) ??
              at - (job.started_at ?? job.created_at),
          )
        } — ${result.outputs.length} output${
          result.outputs.length === 1 ? "" : "s"
        }${result.outputs.map((output) => `\n  ${output.path}`).join("")}`,
      );
      for (const output of result.outputs) {
        this.#hub.broadcast({
          type: "output",
          data: this.#outputs.view(output),
        });
      }
      await this.#recordOutputSizes(result.outputs);
    } catch (cause) {
      await this.#failAndClean(jobId, {
        type: "completion_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async #failAndClean(jobId: string, error: JobError): Promise<void> {
    this.#fail(jobId, error);
    await removeStagingDir(this.#paths, jobId);
  }

  #fail(jobId: string, error: JobError): void {
    if (!this.#inFlight(jobId)) return;
    updateJobStatus(this.#db, jobId, {
      status: "failed",
      finished_at: this.#now(),
      error,
    });
    this.#forget(jobId);
    this.#broadcastJob(jobId);
    logError(
      `job ${jobId} failed — ${error.type}: ${oneLine(error.message, 160)}${
        error.node_id ? ` (node ${error.node_id})` : ""
      }`,
    );
  }

  // ------------------------------------------------------------- recovering

  /**
   * Startup (§M2): a job that was running when the app stopped is recorded as
   * failed, and staging directories with no job behind them are swept (§6.3).
   */
  async sweepAtStartup(): Promise<{ failed: string[]; removed: string[] }> {
    const failed = failInterruptedJobs(this.#db, {
      type: "app_restarted",
      message: "the app restarted while this job was running",
    }, this.#now());
    for (const id of failed) this.#broadcastJob(id);

    const keep = new Set(jobsInFlight(this.#db).map((job) => job.id));
    const removed: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.#paths.staging)) {
        if (!entry.isDirectory || keep.has(entry.name)) continue;
        await Deno.remove(join(this.#paths.staging, entry.name), {
          recursive: true,
        });
        removed.push(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return { failed, removed };
  }

  /**
   * Called on every (re)connection: ask ComfyUI what became of the jobs the
   * app still thinks are in flight. This is how a disconnect mid-job, or a
   * ComfyUI that died before `executed`, ends up resolved.
   */
  async reconcile(): Promise<void> {
    const inFlight = jobsInFlight(this.#db);
    if (inFlight.length === 0) return;

    let queued: Set<string>;
    try {
      const queue = await this.#comfy.client.queue();
      queued = new Set(
        [...queue.running, ...queue.pending].map((item) => item.prompt_id),
      );
    } catch {
      return; // Not connected after all; the next reconnect tries again.
    }

    for (const job of inFlight) {
      if (!job.prompt_id) {
        // Never made it to ComfyUI, and the submit path already failed it.
        continue;
      }
      this.#byPrompt.set(job.prompt_id, job.id);
      if (queued.has(job.prompt_id)) continue;

      const history = await this.#comfy.client.history(job.prompt_id).catch(
        () => null,
      );
      if (history === null) {
        await this.#failAndClean(job.id, {
          type: "lost",
          message: "ComfyUI has no record of this job",
        });
        continue;
      }
      const interrupted = history.messages.some(
        ([type]) => type === "execution_interrupted",
      );
      if (interrupted) {
        await this.#markCancelled(job.id);
        continue;
      }
      if (history.status === "error") {
        const [, data] = history.messages.find(([type]) =>
          type === "execution_error"
        ) ?? [];
        await this.#failAndClean(job.id, {
          type: typeof data?.exception_type === "string"
            ? data.exception_type
            : "execution_error",
          message: typeof data?.exception_message === "string"
            ? data.exception_message
            : "ComfyUI reported an error while the app was not listening",
          node_id: typeof data?.node_id === "string" ? data.node_id : null,
        });
        continue;
      }
      const images = Object.entries(history.outputs).map(([node, files]) => ({
        node,
        files,
      }));
      if (images.length === 0) {
        await this.#failAndClean(job.id, {
          type: "lost",
          message: "ComfyUI finished this job without writing any files",
        });
        continue;
      }
      // It finished while the app was away: pick the results up now.
      this.#ensureLive(job.id).tracker.start(job.started_at ?? job.created_at);
      await this.#finalize(job.id, images);
    }
  }

  // ----------------------------------------------------------------- helpers

  jobWithOutputs(id: string): JobRow & { outputs: string[] } {
    const job = getJob(this.#db, id);
    if (!job) throw new JobNotFoundError(id);
    return {
      ...job,
      outputs: listOutputsForJob(this.#db, id).map((output) => output.id),
    };
  }

  /** True while the job can still change state on its own. */
  #inFlight(id: string): boolean {
    const status = getJob(this.#db, id)?.status;
    return status === "queued" || status === "running";
  }

  /**
   * Refuse a job whose model, text encoder or VAE is not on disk. The bundled
   * workflows ship the filenames their source template used, which are not
   * the filenames on anyone else's machine, and without this the job is
   * queued and ComfyUI fails somewhere the user has to go digging for. Naming
   * the param and the value is enough to fix it in the panel.
   */
  #assertModelsPresent(
    manifest: Manifest,
    values: Record<string, unknown>,
  ): void {
    if (!this.#modelExists) return;
    const missing: string[] = [];
    for (const param of manifest.params) {
      if (
        param.type !== "model" && param.type !== "text_encoder" &&
        param.type !== "vae"
      ) {
        continue;
      }
      const name = values[param.key];
      if (typeof name !== "string" || name.length === 0) continue;
      const modelClass = param.filter?.class ?? MODEL_PARAM_CLASS[param.type];
      if (this.#modelExists(name, modelClass)) continue;
      missing.push(`${param.label ?? param.key} ("${name}")`);
    }
    if (missing.length > 0) {
      throw new JobRequestError(
        `not in your model folders: ${missing.join(", ")}. ` +
          `Pick one that is, or add the file and rescan.`,
      );
    }
  }

  /** The workflow's name if it still exists, else the id the job carries. */
  #labelFor(workflowId: string | null): string {
    if (!workflowId) return "a frozen graph";
    return this.#workflows.get(workflowId)?.manifest?.name ?? workflowId;
  }

  /**
   * The workflow's first text param, which is the prompt everywhere it
   * matters. A rerun has no workflow to ask, so it falls back to the names a
   * prompt goes by.
   */
  #promptOf(
    workflowId: string | null,
    params: Record<string, unknown>,
  ): string {
    const manifest = workflowId
      ? this.#workflows.get(workflowId)?.manifest
      : null;
    const keys = manifest
      ? manifest.params.filter((param) => param.type === "text").map((param) =>
        param.key
      )
      : ["prompt", "positive", "text"];
    for (const key of keys) {
      const value = params[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return `: ${oneLine(value)}`;
      }
    }
    return "";
  }

  #assertConnected(): void {
    if (!this.#comfy.connected) {
      throw new ComfyOfflineError(this.#comfy.state);
    }
  }

  #manifestFor(job: JobRow): Manifest | null {
    if (!job.workflow_id) return null;
    return this.#workflows.get(job.workflow_id)?.manifest ?? null;
  }

  #jobIdFor(promptId: string): string | null {
    const known = this.#byPrompt.get(promptId);
    if (known) return known;
    const job = getJobByPromptId(this.#db, promptId);
    if (!job) return null;
    this.#byPrompt.set(promptId, job.id);
    return job.id;
  }

  #ensureLive(jobId: string): LiveJob {
    const existing = this.#live.get(jobId);
    if (existing) return existing;
    const job = getJob(this.#db, jobId);
    const live: LiveJob = {
      jobId,
      promptId: job?.prompt_id ?? null,
      tracker: new ProgressTracker(job?.api_graph ?? {}, {
        now: this.#now,
        weights: nodeTimingsFor(this.#db, job?.workflow_hash ?? null),
      }),
      images: new Map(),
      lastWriteAt: 0,
      finalized: false,
    };
    this.#live.set(jobId, live);
    return live;
  }

  /**
   * One entry per file the job produced (§7.1). The size is read from disk
   * because the row does not carry one, and a file that has already moved on
   * is simply not reported.
   */
  async #recordOutputSizes(outputs: OutputRow[]): Promise<void> {
    const telemetry = this.#telemetry;
    if (!telemetry || outputs.length === 0) return;
    for (const output of outputs) {
      let bytes: number;
      try {
        bytes = (await Deno.stat(join(this.#paths.root, output.path))).size;
      } catch {
        continue;
      }
      telemetry.recordOutput({
        output_id: output.id,
        path: output.path,
        bytes,
        kind: output.kind,
        family: output.family,
        workflow_id: output.workflow_id,
        job_id: output.job_id,
        created_at: output.created_at,
      });
    }
  }

  #forget(jobId: string): void {
    this.#vram?.generationFinished(jobId);
    const live = this.#live.get(jobId);
    if (live?.promptId) this.#byPrompt.delete(live.promptId);
    this.#live.delete(jobId);
    if (this.#currentJobId === jobId) this.#currentJobId = null;
  }

  #requireJob(id: string): JobRow {
    const job = getJob(this.#db, id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  #broadcastJob(id: string, progress?: Progress): void {
    const job = getJob(this.#db, id);
    if (!job) return;
    this.#hub.broadcast({
      type: "job",
      data: {
        ...job,
        ...(progress ? { progress } : {}),
        outputs: job.status === "done"
          ? listOutputsForJob(this.#db, id).map((output) => output.id)
          : [],
      },
    });
  }

  #enqueue(work: () => Promise<void>): void {
    this.#chain = this.#chain.then(work).catch((error) => {
      console.error("job pipeline failed:", error);
    });
  }
}

/**
 * A frozen graph writes into its original job's staging directory, so a rerun
 * has to be re-stamped or its files would land under the old job id (§5 step
 * 3). Nothing else about the graph is touched — that is the point of a rerun.
 */
export function restampOutputs(graph: ApiGraph, jobId: string): ApiGraph {
  const copy = structuredClone(graph);
  let stamped = 0;
  for (const node of Object.values(copy)) {
    const isOutput = isOutputNodeType(node.class_type) ||
      typeof node.inputs.filename_prefix === "string";
    if (!isOutput) continue;
    node.inputs.filename_prefix = `${jobId}/out`;
    stamped++;
  }
  if (stamped === 0) {
    throw new JobRequestError(
      "this graph has no save node, so it cannot be rerun",
    );
  }
  return copy;
}
