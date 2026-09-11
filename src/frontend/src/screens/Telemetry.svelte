<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import BarChart3 from "@lucide/svelte/icons/bar-chart-3";
  import LineChartIcon from "@lucide/svelte/icons/line-chart";
  import X from "@lucide/svelte/icons/x";
  import Info from "@lucide/svelte/icons/info";
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { router, setQuery } from "../router.svelte.ts";
  import { absoluteTime, bytes, localDate, measure } from "../lib/format.ts";
  import type {
    TelemetryEntry,
    TelemetryFilter,
    TelemetryLine,
    TelemetryReport,
  } from "../types.ts";
  import Popover from "../components/Popover.svelte";
  import TimelineChart, { type ChartSeries } from "../components/TimelineChart.svelte";

  /**
   * Telemetry (§7.1, §11.2): one report at a time, always in both shapes —
   * the whole history as a timeline across the top, and the entries behind it
   * as a table that scrolls forever. The report, the graph's shape, every
   * filter and the open entry are all URL params, so a view is a link.
   */
  let reports = $state<TelemetryReport[]>([]);
  let logBytes = $state<number | null>(null);
  let series = $state<TelemetryLine[]>([]);
  let seriesTruncated = $state(false);
  let seriesTotal = $state<number | null>(null);
  let entries = $state<TelemetryEntry[]>([]);
  let cursor = $state<string | null>(null);
  let loadingSeries = $state(false);
  let loadingEntries = $state(false);
  let exhausted = $state(false);
  let error = $state<string | null>(null);
  let openFilter = $state<string | null>(null);
  let minDraft = $state("");
  let scroller = $state<HTMLDivElement | undefined>(undefined);

  const query = $derived(router.current.query);
  const reportId = $derived(query.get("report") ?? "api_requests");
  const report = $derived(
    reports.find((entry) => entry.id === reportId) ?? reports[0] ?? null,
  );
  const mode = $derived(query.get("graph") === "line" ? "line" : "bars");
  const selectedId = $derived(query.get("entry"));
  const selected = $derived(
    entries.find((entry) => String(entry.id) === selectedId) ?? null,
  );

  /**
   * Only the params this report declares reach the server, which is also what
   * keeps one report's chips from narrowing another's (§7.1).
   */
  const filterParams = $derived.by(() => {
    const params = new URLSearchParams();
    for (const filter of report?.filters ?? []) {
      const value = query.get(filter.key);
      if (value !== null && value.length > 0) params.set(filter.key, value);
    }
    return params;
  });
  const filterKey = $derived(`${reportId}?${filterParams}`);
  const activeFilters = $derived(
    (report?.filters ?? []).filter((filter) => filterParams.has(filter.key)),
  );

  $effect(() => {
    void load();
  });

  async function load() {
    try {
      const body = await api.telemetryReports();
      reports = body.reports;
      logBytes = body.bytes;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /**
   * The report or any filter changing reloads both halves together, so the
   * graph and the table never disagree (§11.2). Untracked, because the loads
   * read state they would otherwise re-trigger on.
   */
  $effect(() => {
    filterKey;
    if (!report) return;
    untrack(() => {
      minDraft = query.get("min_value") ?? "";
      void loadSeries();
      void loadEntries(true);
    });
  });

  async function loadSeries() {
    if (!report) return;
    loadingSeries = true;
    try {
      const body = await api.telemetrySeries(report.id, filterParams);
      series = body.series;
      seriesTruncated = body.truncated;
      seriesTotal = body.total;
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loadingSeries = false;
    }
  }

  async function loadEntries(first = false) {
    if (!report || loadingEntries || (exhausted && !first)) return;
    loadingEntries = true;
    if (first) {
      exhausted = false;
      cursor = null;
    }
    try {
      const page = await api.telemetryEntries(report.id, filterParams, {
        cursor: first ? null : cursor,
        limit: 100,
      });
      entries = first ? page.entries : [...entries, ...page.entries];
      cursor = page.cursor;
      exhausted = page.cursor === null;
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loadingEntries = false;
    }
  }

  function onScroll() {
    if (!scroller || loadingEntries || exhausted) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < 400) void loadEntries();
  }

  function pick(id: string) {
    // A different report's filters mean nothing here, so they do not travel.
    const keep = query.get("graph");
    setQuery(
      {
        report: id,
        entry: null,
        graph: keep,
        ...Object.fromEntries(
          reports.flatMap((entry) => entry.filters).map((filter) => [filter.key, null]),
        ),
      },
      { replace: false },
    );
  }

  /** A chip's values are a list: picking one more widens that dimension. */
  function toggle(filter: TelemetryFilter, value: string) {
    const current = (query.get(filter.key) ?? "").split(",").filter(Boolean);
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    setQuery({ [filter.key]: next.length > 0 ? next.join(",") : null });
  }

  function chosen(filter: TelemetryFilter): string[] {
    return (query.get(filter.key) ?? "").split(",").filter(Boolean);
  }

  function chipLabel(filter: TelemetryFilter): string {
    if (filter.kind === "min") {
      const value = query.get(filter.key);
      return value ? measure(Number(value), filter.unit ?? "ms") : "Any";
    }
    const values = chosen(filter);
    return values.length === 0 ? "All" : values.join(", ");
  }

  /**
   * Entries land seconds apart, so "just now" on every row says nothing; the
   * clock is what tells two of them apart. The date comes back for anything
   * older than today, and the full stamp is on the row's title.
   */
  function stamp(at: number): string {
    const date = new Date(at);
    const time = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (localDate(date) === localDate(new Date())) return time;
    return `${date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    })} ${time}`;
  }

  function cell(entry: TelemetryEntry, key: string): string {
    if (key === "at") return stamp(entry.at);
    if (key === "value") return measure(entry.value, report?.unit ?? "ms");
    const value = (entry as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined || value === "") return "—";
    // A line is named the same way in the table as in the legend: "VRAM",
    // not the `vram` it is stored under.
    if (key === "series") {
      const line = report?.series?.find((entry) => entry.key === value);
      if (line) return line.label;
    }
    return String(value);
  }

  /**
   * The lines the chart draws, named from the report's own definition so a
   * legend reads "VRAM" rather than the column value it was stored under.
   * A report that declares its lines keeps their order even while one of
   * them has nothing yet, so a colour never moves from one to the other.
   */
  const lines = $derived.by<ChartSeries[]>(() => {
    const defined = report?.series ?? [];
    if (defined.length === 0) {
      return [
        {
          key: null,
          label: report?.value_label ?? "",
          points: series[0]?.points ?? [],
        },
      ];
    }
    return defined.map((line) => ({
      key: line.key,
      label: line.label,
      points: series.find((entry) => entry.key === line.key)?.points ?? [],
    }));
  });

  const plotted = $derived(lines.reduce((total, line) => total + line.points.length, 0));

  /** The raw entry, pretty-printed: what §11.2's sidebar is for. */
  const rawEntry = $derived(
    selected === null
      ? ""
      : JSON.stringify(
          {
            id: selected.id,
            report: selected.report,
            at: selected.at,
            recorded: absoluteTime(selected.at),
            value: selected.value,
            label: selected.label,
            data: selected.data,
          },
          null,
          2,
        ),
  );

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && selectedId) setQuery({ entry: null });
  }
</script>

<svelte:window onkeydown={onKeydown} />

<section class="telemetry">
  <header class="reports">
    {#each reports as entry (entry.id)}
      <button
        class="tab"
        class:active={entry.id === report?.id}
        onclick={() => pick(entry.id)}
      >
        {entry.title}
        <span class="mono dim">{entry.entries.toLocaleString()}</span>
      </button>
    {/each}
    <span class="spacer"></span>
    {#if logBytes !== null}
      <span class="mono dim log">telemetry.db · {bytes(logBytes)}</span>
    {/if}
  </header>

  {#if error}
    <p class="error mono">{error}</p>
  {/if}

  {#if report}
    <div class="top">
      {#if report.filters.length > 0}
        <div class="filters">
          {#each report.filters as filter (filter.key)}
            {#if filter.kind === "min"}
              <label class="chip min">
                {filter.label}
                <input
                  class="mono"
                  type="number"
                  min="0"
                  placeholder="any"
                  value={minDraft}
                  oninput={(event) =>
                    (minDraft = (event.currentTarget as HTMLInputElement).value)}
                  onchange={() => setQuery({ [filter.key]: minDraft || null })}
                  onkeydown={(event) => {
                    if (event.key === "Enter")
                      setQuery({ [filter.key]: minDraft || null });
                  }}
                />
                <span class="dim">{filter.unit === "ms" ? "ms" : ""}</span>
              </label>
            {:else}
              <div class="chip-wrap">
                <button
                  class="chip"
                  onclick={() =>
                    (openFilter = openFilter === filter.key ? null : filter.key)}
                >
                  {filter.label}: <strong>{chipLabel(filter)}</strong>
                  <ChevronDown size={12} />
                </button>
                <Popover
                  open={openFilter === filter.key}
                  width={260}
                  title={filter.label}
                  onclose={() => (openFilter = null)}
                >
                  {#if chosen(filter).length > 0}
                    <button
                      class="option"
                      onclick={() => setQuery({ [filter.key]: null })}
                    >
                      Clear this filter
                    </button>
                  {/if}
                  {#each filter.options ?? [] as option (option.value)}
                    <button
                      class="option check"
                      onclick={() => toggle(filter, String(option.value))}
                    >
                      <span class="mark mono">
                        {chosen(filter).includes(String(option.value)) ? "✓" : ""}
                      </span>
                      <span class="option-name">{option.value}</span>
                      <span class="mono dim">{option.entries.toLocaleString()}</span>
                    </button>
                  {/each}
                  {#if (filter.options ?? []).length === 0}
                    <p class="empty">Nothing has been recorded under this yet.</p>
                  {/if}
                </Popover>
              </div>
            {/if}
          {/each}
          {#if activeFilters.length > 0}
            <button
              class="clear"
              onclick={() =>
                setQuery(
                  Object.fromEntries(report.filters.map((filter) => [filter.key, null])),
                )}
            >
              Clear filters
            </button>
          {/if}
        </div>
      {/if}

      <div class="card">
        <div class="card-head">
          <div class="titles">
            <h2>{report.title}</h2>
            <!--
              What an entry is and when one is written: a note for the moment
              someone asks, not a line of prose over every graph (§11.2).
            -->
            <span
              class="info"
              role="img"
              title={report.description}
              aria-label={report.description}
            >
              <Info size={13} />
            </span>
          </div>
          <span class="mono dim count">
            {seriesTotal === null
              ? "…"
              : `${seriesTotal.toLocaleString()} ${
                  seriesTotal === 1 ? "entry" : "entries"
                }`}
            {#if seriesTruncated}· newest {plotted.toLocaleString()} drawn{/if}
          </span>
          <div class="row shapes">
            {#each [["bars", "Bars", BarChart3], ["line", "Line", LineChartIcon]] as const as [value, label, Icon] (value)}
              <button
                class:active={mode === value}
                title={value === "line" ? "Smoothed line" : "One bar per data point"}
                aria-label={label}
                onclick={() => setQuery({ graph: value === "bars" ? null : value })}
              >
                <Icon size={14} />
              </button>
            {/each}
          </div>
        </div>
        <TimelineChart
          series={lines}
          unit={report.unit}
          valueLabel={report.value_label}
          {mode}
          aggregate={report.cumulative ? "last" : "max"}
          loading={loadingSeries}
        />
      </div>
    </div>

    <div class="split">
      <div class="body scroll" bind:this={scroller} onscroll={onScroll}>
        <table>
          <thead>
            <tr>
              {#each report.columns as column (column.key)}
                <th class:num={column.kind === "value" || column.kind === "number"}>
                  {column.label}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each entries as entry (entry.id)}
              <tr
                class:selected={String(entry.id) === selectedId}
                tabindex="0"
                onclick={() => setQuery({ entry: String(entry.id) })}
                onkeydown={(event) => {
                  if (event.key === "Enter") setQuery({ entry: String(entry.id) });
                }}
              >
                {#each report.columns as column (column.key)}
                  <td
                    class:mono={column.kind !== "text" || column.key === "route"}
                    class:num={column.kind === "value" || column.kind === "number"}
                    title={column.kind === "time" ? absoluteTime(entry.at) : undefined}
                  >
                    {cell(entry, column.key)}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>

        {#if loadingEntries}
          <p class="empty">loading…</p>
        {:else if entries.length === 0}
          <p class="empty">
            No entries{activeFilters.length > 0 ? " match these filters" : " yet"}.
          </p>
        {:else if exhausted}
          <p class="empty">
            {entries.length.toLocaleString()} loaded · that is all of them.
          </p>
        {/if}
      </div>

      <!-- The raw entry, opened by clicking a row (§11.2). -->
      {#if selected}
        <aside class="sidebar">
          <div class="sidebar-head">
            <div>
              <div class="label">Raw entry</div>
              <div class="mono dim">#{selected.id} · {absoluteTime(selected.at)}</div>
            </div>
            <button
              class="icon"
              title="Close"
              aria-label="Close the raw entry"
              onclick={() => setQuery({ entry: null })}
            >
              <X size={14} />
            </button>
          </div>
          <div class="headline mono">
            <strong>{measure(selected.value, report.unit)}</strong>
            <span class="dim">{report.value_label}</span>
          </div>
          <pre class="mono">{rawEntry}</pre>
        </aside>
      {/if}
    </div>
  {/if}
</section>

<style>
  .telemetry {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .reports {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px 0;
    flex-wrap: wrap;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    background: var(--raised);
    color: var(--text-3);
  }

  .tab.active {
    background: var(--control-selected);
    color: var(--text);
  }

  .spacer {
    flex: 1;
  }

  .log,
  .count {
    font-size: 11px;
  }

  .error {
    color: var(--error);
    padding: 6px 12px;
    margin: 0;
    font-size: 12px;
  }

  .top {
    padding: 8px 12px 0;
  }

  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-bottom: 8px;
  }

  .chip-wrap {
    position: relative;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    background: var(--raised);
    color: var(--text-3);
  }

  .chip strong {
    color: var(--text);
    font-weight: 400;
  }

  .chip.min input {
    width: 72px;
    padding: 2px 6px;
    background: var(--control);
    font-size: 11px;
  }

  .clear {
    font-size: 11px;
    background: transparent;
    color: var(--accent);
  }

  .option {
    display: block;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 7px;
    font-size: 12px;
  }

  .option:hover {
    background: var(--control);
  }

  .option.check {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .option.check .mark {
    width: 10px;
    color: var(--accent);
    font-size: 11px;
  }

  .option-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card {
    background: var(--panel);
    border-radius: var(--radius-card);
    padding: 10px 12px 4px;
  }

  .card-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 4px;
  }

  .titles {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .titles h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }

  .info {
    display: flex;
    color: var(--text-4);
    cursor: help;
  }

  .info:hover {
    color: var(--text-2);
  }

  .shapes {
    display: flex;
    gap: 2px;
  }

  .shapes button {
    display: flex;
    padding: 4px 6px;
    background: var(--raised);
    color: var(--text-3);
  }

  .shapes button.active {
    background: var(--control-selected);
    color: var(--text);
  }

  /* The table scrolls; the graph and the filters above it stay put (§11.2). */
  .split {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .body {
    flex: 1;
    min-width: 0;
    padding: 4px 12px 16px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th {
    text-align: left;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-4);
    font-weight: 400;
    padding: 6px 8px;
    position: sticky;
    top: 0;
    background: var(--canvas);
    z-index: 1;
  }

  td {
    padding: 4px 8px;
    border-top: 1px solid var(--line);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 320px;
  }

  th.num,
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  tr {
    cursor: pointer;
  }

  tbody tr:hover td {
    background: var(--app);
  }

  tbody tr.selected td {
    background: var(--accent-tint);
  }

  .empty {
    font-size: 11px;
    color: var(--text-4);
    padding: 8px;
    margin: 0;
  }

  .sidebar {
    width: 320px;
    flex: 0 0 auto;
    background: var(--panel);
    padding: 10px 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .sidebar-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .sidebar-head .mono {
    font-size: 10px;
  }

  .icon {
    background: transparent;
    color: var(--text-4);
    display: flex;
  }

  .icon:hover {
    color: var(--text);
  }

  .headline {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .headline strong {
    font-size: 18px;
    font-weight: 500;
    color: var(--text);
  }

  .headline .dim {
    font-size: 11px;
  }

  pre {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-2);
    background: var(--raised);
    border-radius: var(--radius-control);
    padding: 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
