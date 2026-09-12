import type {
  Config,
  FamilyCount,
  HashingProgress,
  Job,
  LiteralInput,
  Manifest,
  ModelDetail,
  InputMedia,
  ModelEntry,
  Output,
  OutputDetail,
  RescanProgress,
  Sample,
  Storage,
  TelemetryEntryPage,
  TelemetryReport,
  TelemetrySeries,
  WorkflowDetail,
  WorkflowSummary,
} from "./types.ts";

/** Every call the UI makes, in one place. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init.body
      ? { "content-type": "application/json", ...init.headers }
      : init.headers,
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = (body as { error?: { code: string; message: string } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "error",
      error?.message ?? `${init.method ?? "GET"} ${path} failed`,
      body,
    );
  }
  return body as T;
}

export interface OutputQuery {
  workflow?: string;
  kind?: string;
  models?: string[];
  q?: string;
  sort?: "newest" | "oldest";
  cursor?: string | null;
  limit?: number;
}

export function outputQueryParams(query: OutputQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.workflow) params.set("workflow", query.workflow);
  if (query.kind) params.set("kind", query.kind);
  if (query.models?.length) params.set("models", query.models.join(","));
  if (query.q) params.set("q", query.q);
  if (query.sort && query.sort !== "newest") params.set("sort", query.sort);
  return params;
}

export const api = {
  config: () => request<Config>("/api/config"),
  patchConfig: (patch: unknown) =>
    request<Config>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  workflows: () =>
    request<{ workflows: WorkflowSummary[] }>("/api/workflows").then(
      (body) => body.workflows,
    ),
  workflow: (id: string) => request<WorkflowDetail>(`/api/workflows/${id}`),
  workflowInputs: (id: string) =>
    request<{ inputs: LiteralInput[] }>(`/api/workflows/${id}/inputs`).then(
      (body) => body.inputs,
    ),
  saveWorkflow: (
    id: string,
    body: { manifest?: Manifest; ui_json?: unknown; api_json?: unknown },
  ) =>
    request<WorkflowDetail>(`/api/workflows/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  createWorkflow: (body: { name?: string; ui_json?: unknown }) =>
    request<WorkflowDetail>("/api/workflows", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  duplicateWorkflow: (id: string) =>
    request<WorkflowDetail>(`/api/workflows/${id}/duplicate`, {
      method: "POST",
    }),
  resetWorkflow: (id: string) =>
    request<WorkflowDetail>(`/api/workflows/${id}/reset`, { method: "POST" }),
  deleteWorkflow: (id: string) =>
    request<null>(`/api/workflows/${id}`, { method: "DELETE" }),

  submit: (workflowId: string, params: Record<string, unknown>) =>
    request<Job>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: workflowId, params }),
    }),
  rerun: (body: { output_id?: string; job_id?: string }) =>
    request<Job>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  jobs: (query: { status?: string; workflow_id?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.workflow_id) params.set("workflow_id", query.workflow_id);
    if (query.limit) params.set("limit", String(query.limit));
    return request<{ jobs: Job[] }>(`/api/jobs?${params}`).then((body) => body.jobs);
  },
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  clearQueue: () => request<{ cancelled: Job[] }>("/api/jobs/clear", { method: "POST" }),

  outputs: (query: OutputQuery = {}) => {
    const params = outputQueryParams(query);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    return request<{ outputs: Output[]; cursor: string | null }>(
      `/api/outputs?${params}`,
    );
  },
  outputCount: (query: OutputQuery = {}) =>
    request<{ count: number }>(`/api/outputs/count?${outputQueryParams(query)}`).then(
      (body) => body.count,
    ),
  outputDays: (dates: string[], query: OutputQuery = {}) => {
    const params = outputQueryParams(query);
    params.set("dates", dates.join(","));
    params.set("tz_offset", String(new Date().getTimezoneOffset()));
    return request<{ days: Record<string, number> }>(`/api/outputs/days?${params}`).then(
      (body) => body.days,
    );
  },
  output: (id: string) => request<OutputDetail>(`/api/outputs/${id}`),
  deleteOutput: (id: string) =>
    request<{ output: Output; undo_window_ms: number }>(`/api/outputs/${id}`, {
      method: "DELETE",
    }),
  restoreOutput: (id: string) =>
    request<{ output: Output }>(`/api/outputs/${id}/restore`, {
      method: "POST",
    }),

  models: (
    query: {
      kind?: string;
      class?: string;
      family?: string;
      q?: string;
      tags?: string;
      /** Only the hidden ones; absent or false means only the visible. */
      hidden?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.class) params.set("class", query.class);
    if (query.family) params.set("family", query.family);
    if (query.q) params.set("q", query.q);
    if (query.tags) params.set("tags", query.tags);
    if (query.hidden) params.set("hidden", "1");
    return request<{
      kind: string | null;
      class: string | null;
      /** The class each configured folder kind holds (§8.2). */
      classes: Record<string, string>;
      folders: string[];
      models: ModelEntry[];
      progress: { rescan: RescanProgress; hashing: HashingProgress };
    }>(`/api/models?${params}`);
  },
  modelsOfKind: (kind: string) =>
    request<{ models: ModelEntry[] }>(`/api/models?kind=${kind}`).then(
      (body) => body.models,
    ),
  /** Every kind in a class at once — what a model picker lists (§3). */
  modelsOfClass: (modelClass: string) =>
    request<{ models: ModelEntry[] }>(`/api/models?class=${modelClass}`).then(
      (body) => body.models,
    ),
  model: (id: string) => request<ModelDetail>(`/api/models/${encodeURIComponent(id)}`),
  /** Re-read one model's file from scratch (§8.1); a debugging action. */
  rescanModel: (id: string) =>
    request<ModelDetail>(`/api/models/${encodeURIComponent(id)}/rescan`, {
      method: "POST",
    }),
  patchModel: (
    id: string,
    patch: {
      display_name?: string | null;
      family?: string | null;
      notes?: string | null;
      tags?: string[];
      strength_min?: number | null;
      strength_max?: number | null;
      thumb_sample_id?: string | null;
      hidden?: boolean;
    },
  ) =>
    request<ModelDetail>(`/api/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  families: () =>
    request<{ families: FamilyCount[] }>("/api/families").then((body) => body.families),
  rescanModels: () =>
    request<{ models: number; queued: number }>("/api/maintenance/rescan-models", {
      method: "POST",
    }),

  /**
   * Put an image into the content-addressed store and get back the name a
   * param binds (§9). A file the user picked, dropped or pasted goes up as
   * multipart; one of the app's own outputs is named rather than uploaded,
   * because it is already on the server's disk.
   */
  uploadInput: async (file: File | Blob, name = "pasted.png") => {
    const form = new FormData();
    form.set("file", file instanceof File ? file : new File([file], name));
    const response = await fetch("/api/inputs", { method: "POST", body: form });
    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = (body as { error?: { code: string; message: string } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "error",
        error?.message ?? "the upload failed",
        body,
      );
    }
    return body as InputMedia;
  },
  /** What the store knows about one stored input, by its sha256. */
  input: (sha256: string) => request<InputMedia>(`/api/inputs/${sha256}`),
  adoptOutput: (outputId: string) =>
    request<InputMedia>("/api/inputs", {
      method: "POST",
      body: JSON.stringify({ output_id: outputId }),
    }),

  /** The drop zone on the model page; multipart, never JSON (§8.3). */
  uploadSample: async (hash: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(`/api/models/${encodeURIComponent(hash)}/samples`, {
      method: "POST",
      body: form,
    });
    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = (body as { error?: { code: string; message: string } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "error",
        error?.message ?? "the upload failed",
        body,
      );
    }
    return body as Sample;
  },
  deleteSample: (id: string) =>
    request<{ sample: Sample }>(`/api/samples/${id}`, { method: "DELETE" }),
  promote: (outputId: string, modelHashes: string[]) =>
    request<{ samples: Sample[] }>(`/api/outputs/${outputId}/promote`, {
      method: "POST",
      body: JSON.stringify({ model_hashes: modelHashes }),
    }),

  storage: () => request<Storage>("/api/system/storage"),

  /**
   * Telemetry (§7.1). The report's own filter params travel through
   * unchanged, so the URL the user is looking at is the query the server
   * answers.
   */
  telemetryReports: () =>
    request<{ reports: TelemetryReport[]; bytes: number }>("/api/telemetry/reports"),
  telemetrySeries: (report: string, filters: URLSearchParams) =>
    request<TelemetrySeries>(`/api/telemetry/${report}/series?${filters}`),
  telemetryEntries: (
    report: string,
    filters: URLSearchParams,
    options: { cursor?: string | null; limit?: number } = {},
  ) => {
    const params = new URLSearchParams(filters);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    return request<TelemetryEntryPage>(`/api/telemetry/${report}/entries?${params}`);
  },

  systemStatus: () =>
    request<{ comfy: import("./types.ts").ComfyStatus; data_dir: string }>(
      "/api/system/status",
    ),
  comfyLog: () =>
    request<{ mode: string; lines: string[]; available: boolean }>(
      "/api/system/comfy/log",
    ),
  restartComfy: () =>
    request<{ comfy: import("./types.ts").ComfyStatus }>("/api/system/comfy/restart", {
      method: "POST",
    }),
  reindex: () =>
    request<{
      sidecars: number;
      outputs: number;
      jobs_created: number;
      removed: string[];
      errors: { path: string; message: string }[];
    }>("/api/maintenance/reindex", { method: "POST" }),
};
