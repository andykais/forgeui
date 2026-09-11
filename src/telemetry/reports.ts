/**
 * The report catalogue (§7.1, §11.2). One definition per report, shared by
 * the routes (which parse the filters from it) and the screen (which draws
 * its columns and chips from it), so a report is described in exactly one
 * place.
 */

export const TELEMETRY_REPORTS_IDS = [
  "api_requests",
  "output_size",
  "model_size",
  "memory",
  "telemetry_size",
] as const;

export type ReportId = typeof TELEMETRY_REPORTS_IDS[number];

/** The sparse dimension columns of §7.1, which is all a filter can narrow. */
export const DIMENSIONS = [
  "method",
  "route",
  "status",
  "family",
  "model_class",
  "change",
  "series",
] as const;

export type Dimension = typeof DIMENSIONS[number];

export interface FilterDef {
  /** URL param name, which for a dimension is the column itself. */
  key: Dimension | "min_value";
  label: string;
  /**
   * `enum` offers what has actually been recorded; `min` is a number the
   * user types and keeps everything at or above it.
   */
  kind: "enum" | "min";
  /** The column an `enum` filter narrows; absent on `min`. */
  column?: Dimension;
  /** Integers come back as numbers so the chip does not show `200.0`. */
  numeric?: boolean;
  unit?: "ms";
}

export interface ColumnDef {
  /** `at`, `value`, `label`, or a dimension. */
  key: "at" | "value" | "label" | Dimension;
  label: string;
  kind: "time" | "value" | "text" | "number";
}

/** One line of a report that draws more than one (§11.2). */
export interface SeriesDef {
  /** The value in the `series` column. */
  key: string;
  label: string;
}

export interface ReportDef {
  id: ReportId;
  title: string;
  /** One line under the title: what an entry is and when one is written. */
  description: string;
  /** How `value` reads. */
  unit: "ms" | "bytes";
  valueLabel: string;
  columns: ColumnDef[];
  filters: FilterDef[];
  /**
   * The graph plots the running total rather than the entries themselves: an
   * entry is a change (a model added, an output written), and what the
   * question is about is what those changes add up to. The table still lists
   * the entries one by one (§11.2). `change: "deleted"` subtracts.
   */
  cumulative?: boolean;
  /** The lines this report draws, when it draws more than one. */
  series?: SeriesDef[];
}

const WHEN: ColumnDef = { key: "at", label: "When", kind: "time" };

/**
 * Columns are the graphed value plus everything filterable, so whatever a
 * chip narrows is visible in the rows it leaves behind (§11.2).
 */
export const TELEMETRY_REPORTS: readonly ReportDef[] = [
  {
    id: "api_requests",
    title: "API request duration",
    description:
      "One entry per answered /api request. Requests to the telemetry reports themselves are not recorded.",
    unit: "ms",
    valueLabel: "Duration",
    columns: [
      WHEN,
      { key: "value", label: "Duration", kind: "value" },
      { key: "method", label: "Method", kind: "text" },
      { key: "route", label: "URL", kind: "text" },
      { key: "status", label: "Status", kind: "number" },
    ],
    filters: [
      { key: "method", label: "Method", kind: "enum", column: "method" },
      { key: "route", label: "URL", kind: "enum", column: "route" },
      {
        key: "status",
        label: "Status",
        kind: "enum",
        column: "status",
        numeric: true,
      },
      { key: "min_value", label: "Min duration", kind: "min", unit: "ms" },
    ],
  },
  {
    id: "output_size",
    title: "Output size",
    description:
      "One entry per output file a generation produced; the graph is what they add up to.",
    unit: "bytes",
    valueLabel: "Size on disk",
    cumulative: true,
    columns: [
      WHEN,
      { key: "value", label: "Size", kind: "value" },
      { key: "family", label: "Family", kind: "text" },
      { key: "label", label: "Output", kind: "text" },
    ],
    filters: [
      { key: "family", label: "Family", kind: "enum", column: "family" },
    ],
  },
  {
    id: "model_size",
    title: "Model size",
    description:
      "One entry per model added or removed, written on startup and on every rescan; the graph is what the folders hold.",
    unit: "bytes",
    valueLabel: "Size on disk",
    cumulative: true,
    columns: [
      WHEN,
      { key: "value", label: "Size", kind: "value" },
      { key: "change", label: "Change", kind: "text" },
      { key: "model_class", label: "Type", kind: "text" },
      { key: "family", label: "Family", kind: "text" },
      { key: "label", label: "Model", kind: "text" },
    ],
    filters: [
      {
        key: "model_class",
        label: "Model type",
        kind: "enum",
        column: "model_class",
      },
      { key: "family", label: "Family", kind: "enum", column: "family" },
    ],
  },
  {
    id: "memory",
    title: "Memory Usage",
    description:
      "VRAM and RAM in use, as ComfyUI reports them: sampled when a generation starts, every 10 seconds while one runs, and when it finishes.",
    unit: "bytes",
    valueLabel: "In use",
    series: [
      { key: "vram", label: "VRAM" },
      { key: "ram", label: "RAM" },
    ],
    columns: [
      WHEN,
      { key: "value", label: "In use", kind: "value" },
      { key: "series", label: "Memory", kind: "text" },
      { key: "label", label: "Sample", kind: "text" },
    ],
    filters: [],
  },
  {
    id: "telemetry_size",
    title: "Size of the telemetry log",
    description:
      "Written on every insert into telemetry.db except its own, so this report never feeds itself.",
    unit: "bytes",
    valueLabel: "Log size",
    columns: [
      WHEN,
      { key: "value", label: "Log size", kind: "value" },
      { key: "label", label: "Caused by", kind: "text" },
    ],
    filters: [],
  },
];

export function reportDef(id: string): ReportDef | null {
  return TELEMETRY_REPORTS.find((report) => report.id === id) ?? null;
}

export function isReportId(id: string): id is ReportId {
  return (TELEMETRY_REPORTS_IDS as readonly string[]).includes(id);
}
