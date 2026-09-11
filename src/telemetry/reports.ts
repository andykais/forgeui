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
  "vram",
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
    title: "Output size over time",
    description: "One entry per output file a generation produced.",
    unit: "bytes",
    valueLabel: "Size",
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
    title: "Model size over time",
    description:
      "One entry per model added or removed, written on startup and on every rescan.",
    unit: "bytes",
    valueLabel: "Size",
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
    id: "vram",
    title: "VRAM over time",
    description:
      "Sampled when a generation starts, every 10 seconds while one runs, and when it finishes. A sample needs both the total and the free VRAM from ComfyUI.",
    unit: "bytes",
    valueLabel: "VRAM in use",
    columns: [
      WHEN,
      { key: "value", label: "VRAM in use", kind: "value" },
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
