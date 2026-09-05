import type { Database } from "@db/sqlite";
import type { ApiGraph } from "../workflows/types.ts";

/**
 * Every SQL statement the app runs lives here, one function per query. The
 * database is a derived index (§7), so nothing in here is a source of truth.
 */

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Exactly the `progress_json` shape of §7. `pct` is 0–100. */
export interface Progress {
  pct: number;
  eta_ms: number | null;
  node_id: string | null;
  node_label: string | null;
  node_index: number;
  node_total: number;
  step: number;
  max: number;
}

export interface JobError {
  type: string;
  message: string;
  node_id?: string | null;
  node_type?: string | null;
  traceback?: string[];
  node_errors?: Record<string, unknown>;
}

export interface JobRow {
  id: string;
  prompt_id: string | null;
  workflow_id: string | null;
  workflow_hash: string | null;
  status: JobStatus;
  params: Record<string, unknown>;
  api_graph: ApiGraph;
  progress: Progress | null;
  error: JobError | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface NewJob {
  id: string;
  workflow_id: string | null;
  workflow_hash: string | null;
  params: Record<string, unknown>;
  api_graph: ApiGraph;
  created_at: number;
}

export interface OutputRow {
  id: string;
  job_id: string | null;
  path: string;
  sidecar_path: string;
  kind: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  sha256: string | null;
  workflow_id: string | null;
  workflow_hash: string | null;
  family: string | null;
  prompt: string | null;
  params: Record<string, unknown>;
  deleted_at: number | null;
  created_at: number;
}

export interface SidecarModelRef {
  role: string;
  name: string;
  hash: string | null;
  [unknownField: string]: unknown;
}

type JobRecord = [
  string,
  string | null,
  string | null,
  string | null,
  string,
  string,
  string,
  string | null,
  string | null,
  number,
  number | null,
  number | null,
];

const JOB_COLUMNS = `id, prompt_id, workflow_id, workflow_hash, status,
  params_json, api_graph_json, progress_json, error_json,
  created_at, started_at, finished_at`;

function parse<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toJob(record: JobRecord): JobRow {
  return {
    id: record[0],
    prompt_id: record[1],
    workflow_id: record[2],
    workflow_hash: record[3],
    status: record[4] as JobStatus,
    params: parse<Record<string, unknown>>(record[5], {}),
    api_graph: parse<ApiGraph>(record[6], {}),
    progress: parse<Progress | null>(record[7], null),
    error: parse<JobError | null>(record[8], null),
    created_at: record[9],
    started_at: record[10],
    finished_at: record[11],
  };
}

/** §5 step 4: the row exists before `/prompt` is called. */
export function insertJob(db: Database, job: NewJob): void {
  db.prepare(
    `INSERT INTO jobs (id, workflow_id, workflow_hash, status, params_json,
                       api_graph_json, created_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(
    job.id,
    job.workflow_id,
    job.workflow_hash,
    JSON.stringify(job.params),
    JSON.stringify(job.api_graph),
    job.created_at,
  );
}

export function setJobPromptId(
  db: Database,
  id: string,
  promptId: string,
): void {
  db.prepare(`UPDATE jobs SET prompt_id = ? WHERE id = ?`).run(promptId, id);
}

export interface JobStatusPatch {
  status: JobStatus;
  started_at?: number | null;
  finished_at?: number | null;
  error?: JobError | null;
  progress?: Progress | null;
}

export function updateJobStatus(
  db: Database,
  id: string,
  patch: JobStatusPatch,
): void {
  const sets = ["status = ?"];
  const values: (string | number | null)[] = [patch.status];
  if (patch.started_at !== undefined) {
    sets.push("started_at = ?");
    values.push(patch.started_at);
  }
  if (patch.finished_at !== undefined) {
    sets.push("finished_at = ?");
    values.push(patch.finished_at);
  }
  if (patch.error !== undefined) {
    sets.push("error_json = ?");
    values.push(patch.error === null ? null : JSON.stringify(patch.error));
  }
  if (patch.progress !== undefined) {
    sets.push("progress_json = ?");
    values.push(
      patch.progress === null ? null : JSON.stringify(patch.progress),
    );
  }
  values.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function updateJobProgress(
  db: Database,
  id: string,
  progress: Progress,
): void {
  db.prepare(`UPDATE jobs SET progress_json = ? WHERE id = ?`).run(
    JSON.stringify(progress),
    id,
  );
}

export function getJob(db: Database, id: string): JobRow | null {
  const record = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
    .value<JobRecord>(id);
  return record ? toJob(record) : null;
}

export function getJobByPromptId(
  db: Database,
  promptId: string,
): JobRow | null {
  const record = db.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE prompt_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).value<JobRecord>(promptId);
  return record ? toJob(record) : null;
}

export interface ListJobsFilter {
  statuses?: JobStatus[];
  workflow_id?: string;
  limit?: number;
}

export function listJobs(db: Database, filter: ListJobsFilter = {}): JobRow[] {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (filter.statuses && filter.statuses.length > 0) {
    where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    values.push(...filter.statuses);
  }
  if (filter.workflow_id) {
    where.push("workflow_id = ?");
    values.push(filter.workflow_id);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  return db.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).values<JobRecord>(...values, limit).map(toJob);
}

/** Queued or running: what the queue strip and the session grid show. */
export function jobsInFlight(db: Database): JobRow[] {
  return db.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC`,
  ).values<JobRecord>().map(toJob);
}

/**
 * Startup: a job that was running when the app stopped cannot be recovered
 * from the app's side, so it is recorded as failed rather than left hanging.
 */
export function failInterruptedJobs(
  db: Database,
  error: JobError,
  now: number,
): string[] {
  const ids = db.prepare(`SELECT id FROM jobs WHERE status = 'running'`)
    .values<[string]>().map(([id]) => id);
  if (ids.length === 0) return [];
  db.prepare(
    `UPDATE jobs SET status = 'failed', error_json = ?, finished_at = ?
      WHERE status = 'running'`,
  ).run(JSON.stringify(error), now);
  return ids;
}

export function insertOutput(db: Database, output: OutputRow): void {
  db.prepare(
    `INSERT INTO outputs (id, job_id, path, sidecar_path, kind, width, height,
                          duration_ms, sha256, workflow_id, workflow_hash,
                          family, prompt, params_json, deleted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    output.id,
    output.job_id,
    output.path,
    output.sidecar_path,
    output.kind,
    output.width,
    output.height,
    output.duration_ms,
    output.sha256,
    output.workflow_id,
    output.workflow_hash,
    output.family,
    output.prompt,
    JSON.stringify(output.params),
    output.deleted_at,
    output.created_at,
  );
  // `outputs_fts` is an external-content table, so it is filled explicitly.
  db.prepare(
    `INSERT INTO outputs_fts (rowid, prompt)
      SELECT rowid, prompt FROM outputs WHERE id = ?`,
  ).run(output.id);
}

/**
 * Discoverability rows (§7). A model is identified by its hash, which the app
 * only learns once the Phase 2 scanner has hashed the folders — until then a
 * sidecar records the filename and `reindex` fills these in later.
 */
export function insertOutputModels(
  db: Database,
  outputId: string,
  models: SidecarModelRef[],
): number {
  const statement = db.prepare(
    `INSERT OR IGNORE INTO output_models (output_id, model_hash, role)
     VALUES (?, ?, ?)`,
  );
  let inserted = 0;
  for (const model of models) {
    if (!model.hash) continue;
    statement.run(outputId, model.hash, model.role);
    inserted++;
  }
  return inserted;
}

const OUTPUT_COLUMNS = `id, job_id, path, sidecar_path, kind, width, height,
  duration_ms, sha256, workflow_id, workflow_hash, family, prompt,
  params_json, deleted_at, created_at`;

type OutputRecord = [
  string,
  string | null,
  string,
  string,
  string,
  number | null,
  number | null,
  number | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string,
  number | null,
  number,
];

function toOutput(record: OutputRecord): OutputRow {
  return {
    id: record[0],
    job_id: record[1],
    path: record[2],
    sidecar_path: record[3],
    kind: record[4],
    width: record[5],
    height: record[6],
    duration_ms: record[7],
    sha256: record[8],
    workflow_id: record[9],
    workflow_hash: record[10],
    family: record[11],
    prompt: record[12],
    params: parse<Record<string, unknown>>(record[13], {}),
    deleted_at: record[14],
    created_at: record[15],
  };
}

export function getOutput(db: Database, id: string): OutputRow | null {
  const record = db.prepare(
    `SELECT ${OUTPUT_COLUMNS} FROM outputs WHERE id = ?`,
  ).value<OutputRecord>(id);
  return record ? toOutput(record) : null;
}

export function listOutputsForJob(db: Database, jobId: string): OutputRow[] {
  return db.prepare(
    `SELECT ${OUTPUT_COLUMNS} FROM outputs WHERE job_id = ? AND deleted_at IS NULL
      ORDER BY id ASC`,
  ).values<OutputRecord>(jobId).map(toOutput);
}

export interface WorkflowUsage {
  /** When the workflow was last submitted, ms since epoch. */
  last_job_at: number | null;
  /** Most recent surviving output, for the workflow card's thumbnail. */
  last_output_id: string | null;
}

/** Usage figures for the Workflows list and the Generate workflow card. */
export function workflowUsage(db: Database): Map<string, WorkflowUsage> {
  const usage = new Map<string, WorkflowUsage>();
  const upsert = (id: string): WorkflowUsage => {
    const existing = usage.get(id);
    if (existing) return existing;
    const created = { last_job_at: null, last_output_id: null };
    usage.set(id, created);
    return created;
  };

  const jobs = db.prepare(
    `SELECT workflow_id, MAX(created_at) AS last_job_at
       FROM jobs
      WHERE workflow_id IS NOT NULL
      GROUP BY workflow_id`,
  ).values<[string, number]>();
  for (const [id, lastJobAt] of jobs) upsert(id).last_job_at = lastJobAt;

  const outputs = db.prepare(
    `SELECT workflow_id, id, MAX(created_at)
       FROM outputs
      WHERE workflow_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY workflow_id`,
  ).values<[string, string, number]>();
  for (const [id, outputId] of outputs) upsert(id).last_output_id = outputId;

  return usage;
}
