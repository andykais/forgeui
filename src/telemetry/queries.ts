import type { Database } from "@db/sqlite";
import { CursorError, decodeCursor, encodeCursor } from "../outputs/cursor.ts";
import { type Dimension, DIMENSIONS } from "./reports.ts";

/**
 * Every statement run against `telemetry.db`, one function per query — the
 * same rule `src/db/queries.ts` follows for `app.db`, kept in its own file
 * because it is its own database (§7.1).
 */

export interface TelemetryEntryRow {
  id: number;
  report: string;
  at: number;
  value: number;
  label: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  family: string | null;
  model_class: string | null;
  change: string | null;
  /** The raw entry §11.2's sidebar shows, parsed. */
  data: Record<string, unknown>;
}

export interface NewTelemetryEntry {
  report: string;
  at: number;
  value: number;
  label?: string | null;
  method?: string | null;
  route?: string | null;
  status?: number | null;
  family?: string | null;
  model_class?: string | null;
  change?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Values within one dimension are an OR, dimensions are an AND, and
 * `min_value` keeps everything at or above it — what the chips in §11.2 read
 * as.
 */
export interface TelemetryFilters {
  method?: string[];
  route?: string[];
  status?: number[];
  family?: string[];
  model_class?: string[];
  change?: string[];
  min_value?: number;
}

export type SqlValue = string | number;

interface WhereClause {
  sql: string;
  params: SqlValue[];
}

export const ENTRIES_MAX_LIMIT = 500;

/**
 * The graph asks for every point for all time (§11.2), so this cap is not
 * paging — it is the point past which one report would hand the browser more
 * marks than it has pixels. The newest points win and the response says so.
 */
export const SERIES_MAX_POINTS = 20_000;

export function insertTelemetryEntry(
  db: Database,
  entry: NewTelemetryEntry,
): number {
  db.prepare(
    `INSERT INTO entries (
       report, at, value, label, method, route, status,
       family, model_class, change, data_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.report,
    entry.at,
    entry.value,
    entry.label ?? null,
    entry.method ?? null,
    entry.route ?? null,
    entry.status ?? null,
    entry.family ?? null,
    entry.model_class ?? null,
    entry.change ?? null,
    JSON.stringify(entry.data ?? {}),
  );
  return Number(db.lastInsertRowId);
}

function rowToEntry(row: Record<string, unknown>): TelemetryEntryRow {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.data_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A row whose blob cannot be read is still a point on the graph.
    data = { error: "this entry's raw data could not be parsed" };
  }
  return {
    id: Number(row.id),
    report: String(row.report),
    at: Number(row.at),
    value: Number(row.value),
    label: (row.label as string | null) ?? null,
    method: (row.method as string | null) ?? null,
    route: (row.route as string | null) ?? null,
    status: row.status === null || row.status === undefined
      ? null
      : Number(row.status),
    family: (row.family as string | null) ?? null,
    model_class: (row.model_class as string | null) ?? null,
    change: (row.change as string | null) ?? null,
    data,
  };
}

export function buildEntriesWhere(
  report: string,
  filters: TelemetryFilters = {},
): WhereClause {
  const conditions = ["report = ?"];
  const params: SqlValue[] = [report];
  for (const dimension of DIMENSIONS) {
    const values = filters[dimension] as (string | number)[] | undefined;
    if (!values || values.length === 0) continue;
    conditions.push(
      `${dimension} IN (${values.map(() => "?").join(", ")})`,
    );
    params.push(...values);
  }
  if (filters.min_value !== undefined) {
    conditions.push("value >= ?");
    params.push(filters.min_value);
  }
  return { sql: `WHERE ${conditions.join(" AND ")}`, params };
}

export interface SeriesPoint {
  id: number;
  at: number;
  value: number;
}

export interface SeriesResult {
  points: SeriesPoint[];
  /** True when older points were left out to stay under the cap. */
  truncated: boolean;
}

/** Every point under the filters, oldest first — what the timeline draws. */
export function listSeries(
  db: Database,
  report: string,
  filters: TelemetryFilters = {},
  max = SERIES_MAX_POINTS,
): SeriesResult {
  const where = buildEntriesWhere(report, filters);
  // Newest first with the cap, then reversed: when the cap bites it is the
  // oldest points that go, not the ones the user just made.
  const rows = db.prepare(
    `SELECT id, at, value FROM entries ${where.sql}
     ORDER BY at DESC, id DESC LIMIT ?`,
  ).all<{ id: number; at: number; value: number }>(...where.params, max + 1);
  const truncated = rows.length > max;
  const points = (truncated ? rows.slice(0, max) : rows)
    .map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      value: Number(row.value),
    }))
    .reverse();
  return { points, truncated };
}

export interface EntryCursor {
  at: number;
  id: number;
}

/** The same opaque keyset cursor the gallery uses, over `(at, id)` (§7.1). */
export function encodeEntryCursor(cursor: EntryCursor): string {
  return encodeCursor({ created_at: cursor.at, id: String(cursor.id) });
}

export function decodeEntryCursor(value: string): EntryCursor {
  const decoded = decodeCursor(value);
  const id = Number(decoded.id);
  if (!Number.isSafeInteger(id)) {
    throw new CursorError("cursor: not a valid cursor");
  }
  return { at: decoded.created_at, id };
}

export interface ListEntriesOptions {
  filters?: TelemetryFilters;
  cursor?: EntryCursor | null;
  limit?: number;
}

/** Newest first, one page at a time: the table's endless scroll (§11.2). */
export function listEntries(
  db: Database,
  report: string,
  options: ListEntriesOptions = {},
): TelemetryEntryRow[] {
  const where = buildEntriesWhere(report, options.filters);
  const params = [...where.params];
  let sql = `SELECT * FROM entries ${where.sql}`;
  if (options.cursor) {
    sql += " AND (at < ? OR (at = ? AND id < ?))";
    params.push(options.cursor.at, options.cursor.at, options.cursor.id);
  }
  sql += " ORDER BY at DESC, id DESC LIMIT ?";
  params.push(Math.min(options.limit ?? 100, ENTRIES_MAX_LIMIT));
  return db.prepare(sql).all<Record<string, unknown>>(...params).map(
    rowToEntry,
  );
}

export function countEntries(
  db: Database,
  report: string,
  filters: TelemetryFilters = {},
): number {
  const where = buildEntriesWhere(report, filters);
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM entries ${where.sql}`,
  ).value<[number]>(...where.params);
  return Number(row?.[0] ?? 0);
}

export interface DimensionOption {
  value: string | number;
  entries: number;
}

/**
 * What a filter offers: the values this report has actually recorded, with
 * how many entries each one has (§11.2). Unrecorded dimensions list nothing
 * rather than every value they could theoretically hold.
 */
export function dimensionOptions(
  db: Database,
  report: string,
  dimension: Dimension,
  numeric = false,
): DimensionOption[] {
  const rows = db.prepare(
    `SELECT ${dimension} AS value, COUNT(*) AS entries FROM entries
     WHERE report = ? AND ${dimension} IS NOT NULL
     GROUP BY ${dimension} ORDER BY ${dimension}`,
  ).all<{ value: string | number; entries: number }>(report);
  return rows.map((row) => ({
    value: numeric ? Number(row.value) : String(row.value),
    entries: Number(row.entries),
  }));
}

/** `page_count * page_size`: the log's own size, with no syscall (§7.1). */
export function databaseBytes(db: Database): number {
  const pages = db.prepare("PRAGMA page_count").value<[number]>()?.[0] ?? 0;
  const pageSize = db.prepare("PRAGMA page_size").value<[number]>()?.[0] ?? 0;
  return Number(pages) * Number(pageSize);
}

export function totalEntries(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM entries").value<[number]>();
  return Number(row?.[0] ?? 0);
}

export interface ModelSizeRow {
  path: string;
  size: number;
  model_class: string;
  family: string | null;
  kind: string;
  display_name: string;
}

/** What the last model pass saw, so this one can diff against it (§7.1). */
export function listModelSizes(db: Database): Map<string, ModelSizeRow> {
  const rows = db.prepare("SELECT * FROM model_sizes").all<
    Record<string, unknown>
  >();
  const sizes = new Map<string, ModelSizeRow>();
  for (const row of rows) {
    sizes.set(String(row.path), {
      path: String(row.path),
      size: Number(row.size),
      model_class: String(row.model_class),
      family: (row.family as string | null) ?? null,
      kind: String(row.kind),
      display_name: String(row.display_name),
    });
  }
  return sizes;
}

/** One transaction, because a half-replaced table would double-count. */
export function replaceModelSizes(
  db: Database,
  models: readonly ModelSizeRow[],
): void {
  const insert = db.prepare(
    `INSERT INTO model_sizes (path, size, model_class, family, kind, display_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM model_sizes");
    for (const model of models) {
      insert.run(
        model.path,
        model.size,
        model.model_class,
        model.family,
        model.kind,
        model.display_name,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
