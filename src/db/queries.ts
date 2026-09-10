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
    statement.run(outputId, normalizeModelHash(model.hash), model.role);
    inserted++;
  }
  return inserted;
}

/**
 * A model hash is the bare lowercase hex sha256 of the file, which is what
 * `models.hash` and every URL use. A sidecar written by hand (or by a future
 * version) may spell it `sha256:…`, so it is stripped on the way in (§8.1).
 */
export function normalizeModelHash(hash: string): string {
  const bare = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return bare.toLowerCase();
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

export type OutputSort = "newest" | "oldest";

/** The gallery's filter set (§11.2); everything else is not filterable. */
export interface OutputFilters {
  workflow?: string;
  kind?: string;
  /** Model hashes, always ANDed together. */
  models?: string[];
  /** Full-text over the denormalised prompt. */
  q?: string;
  /** Soft-deleted rows are hidden unless a caller asks for them. */
  includeDeleted?: boolean;
}

export type SqlValue = string | number;

export interface WhereClause {
  sql: string;
  params: SqlValue[];
}

/**
 * Turn a user's search text into an FTS5 MATCH expression: every term is
 * quoted (so punctuation cannot be read as operator syntax) and matched as a
 * prefix, which is what a search field should do as you type.
 */
export function ftsMatchQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" ");
}

/** Filters → SQL. Pure, so the shape of every query is unit-testable. */
export function buildOutputsWhere(filters: OutputFilters = {}): WhereClause {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (!filters.includeDeleted) clauses.push("outputs.deleted_at IS NULL");
  if (filters.workflow) {
    clauses.push("outputs.workflow_id = ?");
    params.push(filters.workflow);
  }
  if (filters.kind) {
    clauses.push("outputs.kind = ?");
    params.push(filters.kind);
  }
  for (const hash of filters.models ?? []) {
    // AND semantics: an output must have used every selected model (§11.2).
    clauses.push(
      `EXISTS (SELECT 1 FROM output_models om
                WHERE om.output_id = outputs.id AND om.model_hash = ?)`,
    );
    params.push(hash);
  }
  if (filters.q) {
    const match = ftsMatchQuery(filters.q);
    if (match !== null) {
      clauses.push(
        `outputs.rowid IN (SELECT rowid FROM outputs_fts WHERE outputs_fts MATCH ?)`,
      );
      params.push(match);
    }
  }
  return {
    sql: clauses.length > 0 ? clauses.join(" AND ") : "1",
    params,
  };
}

export interface ListOutputsOptions {
  filters?: OutputFilters;
  sort?: OutputSort;
  /** Exclusive: the last row of the previous page. */
  cursor?: { created_at: number; id: string } | null;
  limit?: number;
}

export const OUTPUTS_PAGE_LIMIT = 60;
export const OUTPUTS_MAX_LIMIT = 200;

/** One page of the gallery, keyset paginated on `(created_at, id)`. */
export function listOutputs(
  db: Database,
  options: ListOutputsOptions = {},
): OutputRow[] {
  const sort = options.sort ?? "newest";
  const where = buildOutputsWhere(options.filters);
  const clauses = [where.sql];
  const params: SqlValue[] = [...where.params];
  if (options.cursor) {
    // Spelled out rather than as a row value so the index is used.
    const comparison = sort === "newest" ? "<" : ">";
    clauses.push(
      `(outputs.created_at ${comparison} ? OR
        (outputs.created_at = ? AND outputs.id ${comparison} ?))`,
    );
    params.push(
      options.cursor.created_at,
      options.cursor.created_at,
      options.cursor.id,
    );
  }
  const direction = sort === "newest" ? "DESC" : "ASC";
  const limit = Math.min(
    Math.max(options.limit ?? OUTPUTS_PAGE_LIMIT, 1),
    OUTPUTS_MAX_LIMIT,
  );
  return db.prepare(
    `SELECT ${OUTPUT_COLUMNS} FROM outputs
      WHERE ${clauses.join(" AND ")}
      ORDER BY outputs.created_at ${direction}, outputs.id ${direction}
      LIMIT ?`,
  ).values<OutputRecord>(...params, limit).map(toOutput);
}

/** Total under the active filters, fetched lazily by the client (§11.2). */
export function countOutputs(
  db: Database,
  filters: OutputFilters = {},
): number {
  const where = buildOutputsWhere(filters);
  return db.prepare(
    `SELECT count(*) FROM outputs WHERE ${where.sql}`,
  ).value<[number]>(...where.params)?.[0] ?? 0;
}

export interface DayRange {
  /** The label the client asked about, echoed back. */
  date: string;
  /** Half-open `[from, to)` in epoch ms, so the client owns the timezone. */
  from: number;
  to: number;
}

/** Per-day counts for the dividers currently on screen (§11.2). */
export function countOutputsByDay(
  db: Database,
  ranges: DayRange[],
  filters: OutputFilters = {},
): Record<string, number> {
  const where = buildOutputsWhere(filters);
  const statement = db.prepare(
    `SELECT count(*) FROM outputs
      WHERE ${where.sql} AND outputs.created_at >= ? AND outputs.created_at < ?`,
  );
  const counts: Record<string, number> = {};
  for (const range of ranges) {
    counts[range.date] =
      statement.value<[number]>(...where.params, range.from, range.to)?.[0] ??
        0;
  }
  return counts;
}

export interface OutputModelRow {
  output_id: string;
  model_hash: string;
  role: string;
}

/** The MODELS chips for a page of outputs, in one query. */
export function outputModelsFor(
  db: Database,
  outputIds: string[],
): Map<string, OutputModelRow[]> {
  const byOutput = new Map<string, OutputModelRow[]>();
  if (outputIds.length === 0) return byOutput;
  const rows = db.prepare(
    `SELECT output_id, model_hash, role FROM output_models
      WHERE output_id IN (${outputIds.map(() => "?").join(", ")})`,
  ).values<[string, string, string]>(...outputIds);
  for (const [output_id, model_hash, role] of rows) {
    const list = byOutput.get(output_id) ?? [];
    list.push({ output_id, model_hash, role });
    byOutput.set(output_id, list);
  }
  return byOutput;
}

/** Wall-clock generation time per job, for the table's DURATION column. */
export function generationTimesFor(
  db: Database,
  jobIds: string[],
): Map<string, number> {
  const times = new Map<string, number>();
  if (jobIds.length === 0) return times;
  const rows = db.prepare(
    `SELECT id, started_at, finished_at FROM jobs
      WHERE id IN (${jobIds.map(() => "?").join(", ")})
        AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
  ).values<[string, number, number]>(...jobIds);
  for (const [id, startedAt, finishedAt] of rows) {
    times.set(id, Math.max(0, finishedAt - startedAt));
  }
  return times;
}

/** Soft delete (§11.2): the row goes at once, the bytes wait for the undo. */
export function softDeleteOutput(
  db: Database,
  id: string,
  at: number,
): boolean {
  const changes = db.prepare(
    `UPDATE outputs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).run(at, id);
  return changes > 0;
}

export function restoreOutput(db: Database, id: string): boolean {
  const changes = db.prepare(
    `UPDATE outputs SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
  ).run(id);
  return changes > 0;
}

/** Rows whose undo window has closed and whose files can go. */
export function outputsDeletedBefore(db: Database, at: number): OutputRow[] {
  return db.prepare(
    `SELECT ${OUTPUT_COLUMNS} FROM outputs
      WHERE deleted_at IS NOT NULL AND deleted_at <= ?
      ORDER BY deleted_at ASC`,
  ).values<OutputRecord>(at).map(toOutput);
}

/**
 * How many live outputs still point at a sidecar. A job with several outputs
 * shares one sidecar file, so it only goes when the last one does.
 */
export function countLiveOutputsForSidecar(
  db: Database,
  sidecarPath: string,
  excludeId: string,
): number {
  return db.prepare(
    `SELECT count(*) FROM outputs
      WHERE sidecar_path = ? AND id != ? AND deleted_at IS NULL`,
  ).value<[number]>(sidecarPath, excludeId)?.[0] ?? 0;
}

export function allOutputIds(db: Database): string[] {
  return db.prepare(`SELECT id FROM outputs`).values<[string]>().map(([id]) =>
    id
  );
}

/** Drop a row outright; only `reindex` does this, for files that are gone. */
export function deleteOutputRow(db: Database, id: string): void {
  db.prepare(`DELETE FROM output_models WHERE output_id = ?`).run(id);
  db.prepare(
    `DELETE FROM outputs_fts WHERE rowid = (SELECT rowid FROM outputs WHERE id = ?)`,
  ).run(id);
  db.prepare(`DELETE FROM outputs WHERE id = ?`).run(id);
}

/** External-content FTS tables are rebuilt in one statement. */
export function rebuildOutputsFts(db: Database): void {
  db.exec(`INSERT INTO outputs_fts (outputs_fts) VALUES ('rebuild')`);
}

export function jobExists(db: Database, id: string): boolean {
  return db.prepare(`SELECT 1 FROM jobs WHERE id = ?`).value<[number]>(id) !==
    undefined;
}

export interface RebuiltJob {
  id: string;
  workflow_id: string | null;
  workflow_hash: string | null;
  params: Record<string, unknown>;
  api_graph: ApiGraph;
  created_at: number;
  /** From the sidecar's `timing.total_ms`, so DURATION survives a reindex. */
  total_ms: number;
}

/**
 * §5.2: `reindex` recreates a `done` job row for any output whose job is
 * missing. `prompt_id` and progress cannot be known from a sidecar and stay
 * null.
 */
export function insertRebuiltJob(db: Database, job: RebuiltJob): void {
  db.prepare(
    `INSERT INTO jobs (id, workflow_id, workflow_hash, status, params_json,
                       api_graph_json, created_at, started_at, finished_at)
     VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.workflow_id,
    job.workflow_hash,
    JSON.stringify(job.params),
    JSON.stringify(job.api_graph),
    job.created_at,
    job.created_at,
    job.created_at + job.total_ms,
  );
}

export function listOutputsForJob(db: Database, jobId: string): OutputRow[] {
  return db.prepare(
    `SELECT ${OUTPUT_COLUMNS} FROM outputs WHERE job_id = ? AND deleted_at IS NULL
      ORDER BY id ASC`,
  ).values<OutputRecord>(jobId).map(toOutput);
}

/**
 * A hashed model (§7). The row exists only once the background hasher has
 * finished the file; until then a model is known by its path alone (§8.1).
 */
export interface ModelRow {
  hash: string;
  path: string;
  kind: string;
  size: number;
  mtime: number;
  display_name: string | null;
  family: string | null;
  notes: string | null;
  tags: string[];
  thumb_path: string | null;
  /** The ends of this model's strength sliders; null means the default. */
  strength_min: number | null;
  strength_max: number | null;
  output_count: number;
  last_used_at: number | null;
  last_seen_at: number;
}

const MODEL_COLUMNS = `hash, path, kind, size, mtime, display_name, family,
  notes, tags_json, thumb_path, strength_min, strength_max,
  output_count, last_used_at, last_seen_at`;

type ModelRecord = [
  string,
  string,
  string,
  number,
  number,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number | null,
  number | null,
  number,
  number | null,
  number,
];

function toModel(record: ModelRecord): ModelRow {
  return {
    hash: record[0],
    path: record[1],
    kind: record[2],
    size: record[3],
    mtime: record[4],
    display_name: record[5],
    family: record[6],
    notes: record[7],
    tags: parse<string[]>(record[8], []),
    thumb_path: record[9],
    strength_min: record[10],
    strength_max: record[11],
    output_count: record[12],
    last_used_at: record[13],
    last_seen_at: record[14],
  };
}

export interface NewModel {
  hash: string;
  path: string;
  kind: string;
  size: number;
  mtime: number;
  last_seen_at: number;
}

/**
 * Record a file the hasher finished. Editable metadata is left alone, so a
 * re-hash of the same file never loses a display name. `path` is unique: a
 * file whose bytes changed gets a new hash, and the row that used to hold
 * that path goes.
 */
/** What a scanned file's header said it is, keyed by path (§6). */
export interface ModelProbeRow {
  path: string;
  size: number;
  mtime: number | null;
  arch: string | null;
  probed_at: number;
}

/** Every probe result, for the family fallback the library applies. */
export function listModelProbes(db: Database): Map<string, ModelProbeRow> {
  const rows = db.prepare(
    `SELECT path, size, mtime, arch, probed_at FROM model_probes`,
  ).all() as ModelProbeRow[];
  return new Map(rows.map((row) => [row.path, row]));
}

export function upsertModelProbe(db: Database, probe: ModelProbeRow): void {
  db.prepare(
    `INSERT INTO model_probes (path, size, mtime, arch, probed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime,
       arch = excluded.arch, probed_at = excluded.probed_at`,
  ).run(probe.path, probe.size, probe.mtime, probe.arch, probe.probed_at);
}

export function upsertModel(db: Database, model: NewModel): void {
  db.prepare(`DELETE FROM models WHERE path = ? AND hash != ?`).run(
    model.path,
    model.hash,
  );
  db.prepare(
    `INSERT INTO models (hash, path, kind, size, mtime, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       path = excluded.path, kind = excluded.kind, size = excluded.size,
       mtime = excluded.mtime, last_seen_at = excluded.last_seen_at`,
  ).run(
    model.hash,
    model.path,
    model.kind,
    model.size,
    model.mtime,
    model.last_seen_at,
  );
}

export function getModel(db: Database, hash: string): ModelRow | null {
  const record = db.prepare(
    `SELECT ${MODEL_COLUMNS} FROM models WHERE hash = ?`,
  ).value<ModelRecord>(hash);
  return record ? toModel(record) : null;
}

export function getModelByPath(db: Database, path: string): ModelRow | null {
  const record = db.prepare(
    `SELECT ${MODEL_COLUMNS} FROM models WHERE path = ?`,
  ).value<ModelRecord>(path);
  return record ? toModel(record) : null;
}

export function listModels(db: Database, kind?: string): ModelRow[] {
  return kind === undefined
    ? db.prepare(`SELECT ${MODEL_COLUMNS} FROM models ORDER BY path`)
      .values<ModelRecord>().map(toModel)
    : db.prepare(
      `SELECT ${MODEL_COLUMNS} FROM models WHERE kind = ? ORDER BY path`,
    ).values<ModelRecord>(kind).map(toModel);
}

/** The file is still where it was; only the sighting is news. */
export function markModelSeen(db: Database, hash: string, at: number): void {
  db.prepare(`UPDATE models SET last_seen_at = ? WHERE hash = ?`).run(at, hash);
}

export interface ModelMetaPatch {
  display_name?: string | null;
  family?: string | null;
  notes?: string | null;
  tags?: string[];
  thumb_path?: string | null;
  strength_min?: number | null;
  strength_max?: number | null;
}

/** The edit-in-place header of §8.1. Nothing here touches the file. */
export function updateModelMeta(
  db: Database,
  hash: string,
  patch: ModelMetaPatch,
): boolean {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.display_name !== undefined) {
    sets.push("display_name = ?");
    values.push(patch.display_name);
  }
  if (patch.family !== undefined) {
    sets.push("family = ?");
    values.push(patch.family);
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    values.push(patch.notes);
  }
  if (patch.tags !== undefined) {
    sets.push("tags_json = ?");
    values.push(JSON.stringify(patch.tags));
  }
  if (patch.thumb_path !== undefined) {
    sets.push("thumb_path = ?");
    values.push(patch.thumb_path);
  }
  if (patch.strength_min !== undefined) {
    sets.push("strength_min = ?");
    values.push(patch.strength_min);
  }
  if (patch.strength_max !== undefined) {
    sets.push("strength_max = ?");
    values.push(patch.strength_max);
  }
  if (sets.length === 0) return false;
  return db.prepare(`UPDATE models SET ${sets.join(", ")} WHERE hash = ?`)
    .run(...values, hash) > 0;
}

/**
 * `output_count` and `last_used_at` are derived from `output_models` (§7).
 * Recomputing them is cheaper to keep right than incrementing them, and it is
 * what makes soft delete, restore and reindex agree without extra bookkeeping.
 */
export function refreshModelUsage(db: Database, hashes?: string[]): void {
  const where = hashes === undefined
    ? ""
    : `WHERE hash IN (${hashes.map(() => "?").join(", ")})`;
  if (hashes !== undefined && hashes.length === 0) return;
  db.prepare(
    `UPDATE models SET
       output_count = (
         SELECT count(*) FROM output_models om
           JOIN outputs o ON o.id = om.output_id
          WHERE om.model_hash = models.hash AND o.deleted_at IS NULL),
       last_used_at = (
         SELECT max(o.created_at) FROM output_models om
           JOIN outputs o ON o.id = om.output_id
          WHERE om.model_hash = models.hash AND o.deleted_at IS NULL)
     ${where}`,
  ).run(...(hashes ?? []));
}

/** Which models an output used, for the usage figures it affects. */
export function modelHashesForOutput(db: Database, outputId: string): string[] {
  return db.prepare(
    `SELECT model_hash FROM output_models WHERE output_id = ?`,
  ).values<[string]>(outputId).map(([hash]) => hash);
}

/** Model counts per family, for `GET /api/families`; null → `unset`. */
export function modelCountsByFamily(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  for (
    const [family, count] of db.prepare(
      `SELECT family, count(*) FROM models GROUP BY family`,
    ).values<[string | null, number]>()
  ) {
    counts.set(family ?? "unset", count);
  }
  return counts;
}

/**
 * Sample media for a model (§8.3): dropped on the model page, or promoted
 * from an output. Stored in `samples/<model_hash>/` with a sidecar in the
 * same schema as an output's, so Reuse Parameters works on both.
 */
export interface SampleRow {
  id: string;
  model_hash: string;
  /** Relative to `<appdata>`, like every other path in the index. */
  path: string;
  sidecar_path: string;
  kind: string;
  source_url: string | null;
  params: Record<string, unknown> | null;
  created_at: number;
}

const SAMPLE_COLUMNS =
  `id, model_hash, path, sidecar_path, kind, source_url, params_json,
  created_at`;

type SampleRecord = [
  string,
  string,
  string,
  string,
  string,
  string | null,
  string | null,
  number,
];

function toSample(record: SampleRecord): SampleRow {
  return {
    id: record[0],
    model_hash: record[1],
    path: record[2],
    sidecar_path: record[3],
    kind: record[4],
    source_url: record[5],
    params: record[6] === null
      ? null
      : parse<Record<string, unknown>>(record[6], {}),
    created_at: record[7],
  };
}

export function insertSample(db: Database, sample: SampleRow): void {
  db.prepare(
    `INSERT INTO samples (id, model_hash, path, sidecar_path, kind,
                          source_url, params_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sample.id,
    sample.model_hash,
    sample.path,
    sample.sidecar_path,
    sample.kind,
    sample.source_url,
    sample.params === null ? null : JSON.stringify(sample.params),
    sample.created_at,
  );
}

export function getSample(db: Database, id: string): SampleRow | null {
  const record = db.prepare(
    `SELECT ${SAMPLE_COLUMNS} FROM samples WHERE id = ?`,
  )
    .value<SampleRecord>(id);
  return record ? toSample(record) : null;
}

/** The Samples strip of the model page, newest first. */
export function listSamples(db: Database, modelHash: string): SampleRow[] {
  return db.prepare(
    `SELECT ${SAMPLE_COLUMNS} FROM samples WHERE model_hash = ?
      ORDER BY created_at DESC, id DESC`,
  ).values<SampleRecord>(modelHash).map(toSample);
}

export function deleteSampleRow(db: Database, id: string): boolean {
  return db.prepare(`DELETE FROM samples WHERE id = ?`).run(id) > 0;
}

/** A thumbnail that pointed at a sample cannot outlive it. */
export function clearThumbPath(db: Database, path: string): void {
  db.prepare(`UPDATE models SET thumb_path = NULL WHERE thumb_path = ?`)
    .run(path);
}

/** Most recent surviving output per model, for the thumbnail fallback (§8.1). */
export function latestOutputPathByModel(db: Database): Map<string, string> {
  const rows = db.prepare(
    `SELECT om.model_hash, o.path, max(o.created_at)
       FROM output_models om
       JOIN outputs o ON o.id = om.output_id
      WHERE o.deleted_at IS NULL AND o.kind = 'image'
      GROUP BY om.model_hash`,
  ).values<[string, string, number]>();
  return new Map(rows.map(([hash, path]) => [hash, path]));
}

/**
 * Per-node durations per workflow (§5.1), the weights the ETA is built from.
 * `ewma_ms` is an exponentially weighted moving average so a machine that got
 * faster is believed within a few runs.
 */
export const NODE_TIMING_ALPHA = 0.3;

export interface NodeTiming {
  node_id: string;
  ewma_ms: number;
  samples: number;
}

export function nodeTimingsFor(
  db: Database,
  workflowHash: string | null,
): Map<string, number> {
  if (!workflowHash) return new Map();
  const rows = db.prepare(
    `SELECT node_id, ewma_ms FROM node_timings WHERE workflow_hash = ?`,
  ).values<[string, number]>(workflowHash);
  return new Map(rows);
}

export function listNodeTimings(
  db: Database,
  workflowHash: string,
): NodeTiming[] {
  return db.prepare(
    `SELECT node_id, ewma_ms, samples FROM node_timings
      WHERE workflow_hash = ? ORDER BY node_id`,
  ).values<[string, number, number]>(workflowHash).map((
    [node_id, ewma_ms, samples],
  ) => ({ node_id, ewma_ms, samples }));
}

export function countNodeTimings(db: Database): number {
  return db.prepare(`SELECT count(*) FROM node_timings`).value<[number]>()
    ?.[0] ?? 0;
}

/** Fold one run's measurements into the average (§5.1). */
export function updateNodeTimings(
  db: Database,
  workflowHash: string | null,
  nodes: Record<string, number>,
  alpha = NODE_TIMING_ALPHA,
): number {
  if (!workflowHash) return 0;
  const statement = db.prepare(
    `INSERT INTO node_timings (workflow_hash, node_id, ewma_ms, samples)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(workflow_hash, node_id) DO UPDATE SET
       ewma_ms = ? * excluded.ewma_ms + (1 - ?) * node_timings.ewma_ms,
       samples = node_timings.samples + 1`,
  );
  let updated = 0;
  for (const [nodeId, ms] of Object.entries(nodes)) {
    if (!Number.isFinite(ms) || ms < 0) continue;
    statement.run(workflowHash, nodeId, ms, alpha, alpha);
    updated++;
  }
  return updated;
}

/**
 * Replace the whole table with what a seeding pass computed. Seeding is a
 * rebuild from the sidecars, so running it twice has to leave the same rows.
 */
export function replaceNodeTimings(
  db: Database,
  timings: Iterable<
    { workflow_hash: string; node_id: string; ewma_ms: number; samples: number }
  >,
): number {
  db.exec(`DELETE FROM node_timings`);
  const statement = db.prepare(
    `INSERT INTO node_timings (workflow_hash, node_id, ewma_ms, samples)
     VALUES (?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const timing of timings) {
    statement.run(
      timing.workflow_hash,
      timing.node_id,
      timing.ewma_ms,
      timing.samples,
    );
    inserted++;
  }
  return inserted;
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
