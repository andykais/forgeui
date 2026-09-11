import type { Database } from "@db/sqlite";
import {
  countEntries,
  databaseBytes,
  type DimensionOption,
  dimensionOptions,
  encodeEntryCursor,
  ENTRIES_MAX_LIMIT,
  type EntryCursor,
  insertTelemetryEntry,
  listEntries,
  listModelSizes,
  listSeries,
  type ModelSizeRow,
  type NewTelemetryEntry,
  replaceModelSizes,
  type SeriesResult,
  type TelemetryEntryRow,
  type TelemetryFilters,
  totalEntries,
} from "./queries.ts";
import { logError } from "../log.ts";
import {
  type ColumnDef,
  type FilterDef,
  type ReportDef,
  type ReportShape,
  type SeriesDef,
  TELEMETRY_REPORTS,
} from "./reports.ts";

/**
 * The telemetry log (§7.1): one `record` path in, one pair of read shapes
 * out — the series the timeline draws and the paginated entries the table
 * lists. Recording is best-effort by construction: a report that cannot be
 * written must never take a request, a generation or a scan down with it.
 */

export interface TelemetryPage {
  entries: TelemetryEntryRow[];
  /** Pass back as `?cursor=`; null at the end. */
  cursor: string | null;
}

/** One report as `GET /api/telemetry/reports` returns it (§12). */
export interface ReportView {
  id: string;
  title: string;
  description: string;
  unit: ReportDef["unit"];
  value_label: string;
  columns: ColumnDef[];
  filters: (FilterDef & { options?: DimensionOption[] })[];
  /** What an entry is, which is how the graph reads it (§7.1). */
  shape: ReportShape;
  /** The lines the graph draws; absent when it draws one. */
  series?: SeriesDef[];
  entries: number;
}

export interface ApiRequestSample {
  method: string;
  /** The route pattern, e.g. `/api/outputs/:id` (§7.1). */
  route: string;
  /** The path actually requested; kept in the raw entry only. */
  path: string;
  status: number;
  duration_ms: number;
}

export interface OutputSample {
  output_id: string;
  path: string;
  bytes: number;
  kind: string;
  family: string | null;
  workflow_id: string | null;
  job_id: string | null;
  created_at?: number;
  /** True when this is history read back rather than a job's own report. */
  backfilled?: boolean;
}

export type MemoryPhase = "start" | "tick" | "end";

/** One kind of memory at one instant: a point on one of the two lines. */
export interface MemoryReading {
  series: "vram" | "ram";
  /** Bytes in use, which is what the report plots. */
  used: number;
  free: number;
  total: number;
  /** The GPU, for the VRAM reading; null for RAM. */
  device?: string | null;
}

export interface MemorySample {
  phase: MemoryPhase;
  readings: MemoryReading[];
  /** The generation the sample belongs to; null for a sample without one. */
  job_id?: string | null;
}

/** A model as a scan sees it, which is all the diff needs (§7.1). */
export interface ModelSample {
  path: string;
  size: number;
  model_class: string;
  family: string | null;
  kind: string;
  display_name: string;
}

export interface ModelPassResult {
  added: number;
  deleted: number;
}

export class TelemetryStore {
  #db: Database;
  #now: () => number;
  #reportedFailure = false;
  /**
   * Kept in memory because it is read on every insert: `COUNT(*)` walks the
   * table, and this app is the only writer, so counting once and adding to it
   * is both cheaper and exact.
   */
  #entries: number;

  constructor(options: { db: Database; now?: () => number }) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#entries = totalEntries(options.db);
  }

  get db(): Database {
    return this.#db;
  }

  // -------------------------------------------------------------- recording

  /**
   * Append one entry, then record what that did to the size of the log
   * itself — except for `telemetry_size` entries, which would otherwise
   * never stop causing one another (§7.1).
   */
  record(entry: NewTelemetryEntry): void {
    this.#safe(() => {
      insertTelemetryEntry(this.#db, entry);
      this.#entries++;
      if (entry.report === "telemetry_size") return;
      // Measured after the entry that caused this one and before this one
      // lands, so both numbers describe the log as of this insert — the `+ 1`
      // is this very row, which is about to exist.
      const bytes = databaseBytes(this.#db);
      insertTelemetryEntry(this.#db, {
        report: "telemetry_size",
        at: entry.at,
        value: bytes,
        label: entry.report,
        data: { report: entry.report, entries: this.#entries + 1, bytes },
      });
      this.#entries++;
    });
  }

  /** Every answered `/api` request, bar the telemetry reports' own (§7.1). */
  recordApiRequest(sample: ApiRequestSample, at = this.#now()): void {
    this.record({
      report: "api_requests",
      at,
      value: sample.duration_ms,
      label: sample.path,
      method: sample.method,
      route: sample.route,
      status: sample.status,
      data: { ...sample },
    });
  }

  /** One entry per file a generation produced (§7.1). */
  recordOutput(sample: OutputSample): void {
    this.record({
      report: "output_size",
      at: sample.created_at ?? this.#now(),
      value: sample.bytes,
      label: sample.output_id,
      family: sample.family,
      data: { ...sample },
    });
  }

  /**
   * One entry per kind of memory, so VRAM and RAM are two lines of the same
   * graph rather than one number that has to stand for both (§11.2).
   */
  recordMemory(sample: MemorySample, at = this.#now()): void {
    for (const reading of sample.readings) {
      this.record({
        report: "memory",
        at,
        value: reading.used,
        label: sample.phase,
        series: reading.series,
        data: {
          phase: sample.phase,
          job_id: sample.job_id ?? null,
          ...reading,
        },
      });
    }
  }

  /**
   * Diff what is on disk against the last pass and record the difference:
   * one entry per model added, one per model gone. A pass that changes
   * nothing writes nothing (§7.1).
   */
  recordModelPass(models: readonly ModelSample[]): ModelPassResult {
    const result: ModelPassResult = { added: 0, deleted: 0 };
    this.#safe(() => {
      const previous = listModelSizes(this.#db);
      const at = this.#now();
      const current = new Map<string, ModelSample>();
      for (const model of models) current.set(model.path, model);

      for (const model of current.values()) {
        const before = previous.get(model.path);
        if (before && before.size === model.size) continue;
        // A file whose size moved is the old bytes gone and new bytes in
        // their place, recorded as both — so the running total moves by the
        // difference rather than counting the file twice (§7.1).
        if (before) {
          this.record({
            report: "model_size",
            at,
            value: before.size,
            label: before.display_name,
            family: before.family,
            model_class: before.model_class,
            change: "deleted",
            data: { ...before, change: "deleted", replaced: true },
          });
          result.deleted++;
        }
        this.record({
          report: "model_size",
          at,
          value: model.size,
          label: model.display_name,
          family: model.family,
          model_class: model.model_class,
          change: "added",
          data: {
            ...model,
            change: "added",
            previous_size: before?.size ?? null,
          },
        });
        result.added++;
      }
      for (const before of previous.values()) {
        if (current.has(before.path)) continue;
        this.record({
          report: "model_size",
          at,
          value: before.size,
          label: before.display_name,
          family: before.family,
          model_class: before.model_class,
          change: "deleted",
          data: { ...before, change: "deleted" },
        });
        result.deleted++;
      }
      replaceModelSizes(this.#db, [...current.values()] as ModelSizeRow[]);
    });
    return result;
  }

  // ------------------------------------------------------------------ reads

  /** The catalogue, with each filter's options read from the data (§12). */
  catalogue(): ReportView[] {
    return TELEMETRY_REPORTS.map((report) => ({
      id: report.id,
      title: report.title,
      description: report.description,
      unit: report.unit,
      value_label: report.valueLabel,
      columns: [...report.columns],
      shape: report.shape,
      series: report.series ? [...report.series] : undefined,
      filters: report.filters.map((filter) =>
        filter.column
          ? {
            ...filter,
            options: dimensionOptions(
              this.#db,
              report.id,
              filter.column,
              filter.numeric,
            ),
          }
          : { ...filter }
      ),
      entries: countEntries(this.#db, report.id),
    }));
  }

  /**
   * The timeline's data, shaped by what the report is: a running total for a
   * report whose entries are changes, and one line per `series` value for a
   * report that records more than one thing at a time (§7.1).
   */
  series(report: string, filters: TelemetryFilters = {}): SeriesResult {
    const def = TELEMETRY_REPORTS.find((entry) => entry.id === report);
    return listSeries(this.#db, report, {
      filters,
      cumulative: def?.shape === "total",
      bySeries: (def?.series?.length ?? 0) > 0,
    });
  }

  entries(
    report: string,
    options: {
      filters?: TelemetryFilters;
      cursor?: EntryCursor | null;
      limit?: number;
    } = {},
  ): TelemetryPage {
    const limit = Math.min(options.limit ?? 100, ENTRIES_MAX_LIMIT);
    // One more than asked for, so the end of the list is known without a
    // second count query.
    const rows = listEntries(this.#db, report, {
      filters: options.filters,
      cursor: options.cursor,
      limit: limit + 1,
    });
    const entries = rows.slice(0, limit);
    const last = entries[entries.length - 1];
    return {
      entries,
      cursor: rows.length > limit && last
        ? encodeEntryCursor({ at: last.at, id: last.id })
        : null,
    };
  }

  count(report: string, filters: TelemetryFilters = {}): number {
    return countEntries(this.#db, report, filters);
  }

  bytes(): number {
    return databaseBytes(this.#db);
  }

  /**
   * Telemetry is an observer: it reports failures once and then stays out of
   * the way rather than failing whatever it was watching.
   */
  #safe(body: () => void): void {
    try {
      body();
    } catch (error) {
      if (this.#reportedFailure) return;
      this.#reportedFailure = true;
      // One line in the terminal, like everything else the app says there,
      // and only the first: an observer that cannot write must not become
      // the loudest thing in the log.
      logError(
        `telemetry could not be recorded; further failures are silent: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
