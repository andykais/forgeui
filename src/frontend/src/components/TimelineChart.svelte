<script lang="ts">
  import { absoluteTime, axisTime, measure } from "../lib/format.ts";
  import type { TelemetryPoint, TelemetryUnit } from "../types.ts";

  /**
   * The telemetry timeline (§11.2). Every point the report holds, for all
   * time, squeezed into the width there is — as one mark per point, or as a
   * smoothed line over them. One value, one y axis, no zoom and no range
   * picker: narrowing is the filters' job, not the graph's.
   */
  interface Props {
    points: TelemetryPoint[];
    unit: TelemetryUnit;
    valueLabel: string;
    mode: "bars" | "line";
    /** Dimmed rather than blanked while a reload is in flight. */
    loading?: boolean;
  }

  let { points, unit, valueLabel, mode, loading = false }: Props = $props();

  const HEIGHT = 212;
  const PAD = { top: 14, right: 14, bottom: 22, left: 68 };
  /** 24px is the cap; a band narrower than 2px stops being a mark. */
  const MAX_SLOT = 24;
  const MIN_SLOT = 2;

  let width = $state(720);
  let hovered = $state<number | null>(null);

  const plotWidth = $derived(Math.max(40, width - PAD.left - PAD.right));
  const plotHeight = $derived(HEIGHT - PAD.top - PAD.bottom);
  const span = $derived.by(() => {
    if (points.length === 0) return 0;
    return points[points.length - 1]!.at - points[0]!.at;
  });

  interface Column {
    /** Left edge in px. */
    x: number;
    /** The tallest value in this column — what the bar draws. */
    value: number;
    /** How many points landed here; 1 unless the log is denser than the px. */
    count: number;
    /** When the tallest point in this column happened. */
    at: number;
  }

  const slotWidth = $derived(
    Math.min(MAX_SLOT, Math.max(MIN_SLOT, plotWidth / Math.max(1, points.length))),
  );

  /**
   * The x axis is time, so points are placed by when they happened rather
   * than by their position in the list. Once the log is denser than the
   * pixels available, a column stands for the points that share its slot and
   * draws the tallest of them; the count travels to the tooltip so the mark
   * is never read as one entry.
   */
  const columns = $derived.by<Column[]>(() => {
    if (points.length === 0) return [];
    const slots = Math.max(1, Math.floor(plotWidth / slotWidth));
    const first = points[0]!.at;
    const buckets = new Map<number, Column>();
    for (const point of points) {
      const fraction = span === 0 ? 0.5 : (point.at - first) / span;
      const slot = Math.min(slots - 1, Math.floor(fraction * slots));
      const existing = buckets.get(slot);
      if (!existing) {
        buckets.set(slot, {
          x: PAD.left + slot * slotWidth,
          value: point.value,
          count: 1,
          at: point.at,
        });
        continue;
      }
      existing.count++;
      if (point.value > existing.value) {
        existing.value = point.value;
        existing.at = point.at;
      }
    }
    return [...buckets.values()].sort((a, b) => a.x - b.x);
  });

  /** A clean ceiling, so the axis reads 0 / 2 MB / 4 MB rather than 3.7 MB. */
  const ceiling = $derived.by(() => {
    const peak = columns.reduce((max, column) => Math.max(max, column.value), 0);
    if (peak <= 0) return 1;
    const base = unit === "bytes" ? 1024 : 10;
    const magnitude = Math.pow(base, Math.floor(Math.log(peak) / Math.log(base)));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (peak <= step * magnitude) return step * magnitude;
    }
    return base * magnitude;
  });

  function y(value: number): number {
    return PAD.top + plotHeight - (value / ceiling) * plotHeight;
  }

  const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((at) => at * ceiling));

  const barWidth = $derived(
    Math.max(1, slotWidth - (slotWidth >= 6 ? 2 : slotWidth >= 3 ? 1 : 0)),
  );

  /** Square at the baseline, 4px rounded at the data end. */
  function barPath(column: Column): string {
    const height = Math.max(1, PAD.top + plotHeight - y(column.value));
    const top = PAD.top + plotHeight - height;
    const x = column.x + (slotWidth - barWidth) / 2;
    const radius = Math.min(4, barWidth / 2, height);
    if (barWidth < 3 || radius <= 0.5) {
      return `M${x} ${top} h${barWidth} v${height} h${-barWidth} Z`;
    }
    return [
      `M${x} ${top + height}`,
      `L${x} ${top + radius}`,
      `Q${x} ${top} ${x + radius} ${top}`,
      `L${x + barWidth - radius} ${top}`,
      `Q${x + barWidth} ${top} ${x + barWidth} ${top + radius}`,
      `L${x + barWidth} ${top + height}`,
      "Z",
    ].join(" ");
  }

  /**
   * The smoothing window follows the point count: a handful of entries is
   * drawn as it is, a thousand is a trend. Always odd, so the mean is
   * centred on the column it replaces.
   */
  const smoothWindow = $derived(
    Math.max(1, Math.min(31, 2 * Math.floor(columns.length / 24) + 1)),
  );

  const smoothed = $derived.by(() =>
    columns.map((column, index) => {
      if (smoothWindow === 1) return column.value;
      const half = (smoothWindow - 1) / 2;
      const from = Math.max(0, index - half);
      const to = Math.min(columns.length - 1, index + half);
      let total = 0;
      for (let i = from; i <= to; i++) total += columns[i]!.value;
      return total / (to - from + 1);
    }),
  );

  function centre(column: Column): number {
    return column.x + slotWidth / 2;
  }

  const rawPath = $derived(
    columns
      .map(
        (column, index) =>
          `${index === 0 ? "M" : "L"}${centre(column).toFixed(1)} ${y(
            column.value,
          ).toFixed(1)}`,
      )
      .join(" "),
  );

  const linePath = $derived(
    smoothed
      .map(
        (value, index) =>
          `${index === 0 ? "M" : "L"}${centre(columns[index]!).toFixed(1)} ${y(
            value,
          ).toFixed(1)}`,
      )
      .join(" "),
  );

  const areaPath = $derived(
    columns.length === 0
      ? ""
      : `${linePath} L${centre(columns[columns.length - 1]!).toFixed(1)} ${
          PAD.top + plotHeight
        } L${centre(columns[0]!).toFixed(1)} ${PAD.top + plotHeight} Z`,
  );

  /** Markers only while they can be told apart (≥ 8px across, r ≥ 4). */
  const showMarkers = $derived(mode === "line" && columns.length <= 40);

  /**
   * Labels are chosen by where they land, not by how many columns apart they
   * are: entries arrive in bursts, so evenly-spaced columns are not evenly
   * spaced across the plot, and picking by index writes them on top of one
   * another.
   */
  const LABEL_GAP = 110;

  const xLabels = $derived.by(() => {
    if (columns.length === 0) return [];
    const labels: { x: number; text: string }[] = [];
    const slots = Math.max(2, Math.floor(plotWidth / LABEL_GAP));
    for (let index = 0; index < slots; index++) {
      const target = PAD.left + (plotWidth * index) / (slots - 1);
      let column = columns[0]!;
      let distance = Infinity;
      for (const candidate of columns) {
        const delta = Math.abs(centre(candidate) - target);
        if (delta < distance) {
          distance = delta;
          column = candidate;
        }
      }
      const x = Math.max(PAD.left + 32, Math.min(width - PAD.right - 32, centre(column)));
      const previous = labels[labels.length - 1];
      if (previous && x - previous.x < LABEL_GAP * 0.7) continue;
      labels.push({ x, text: axisTime(column.at, span) });
    }
    return labels;
  });

  const active = $derived(hovered === null ? null : (columns[hovered] ?? null));

  function nearest(event: PointerEvent | MouseEvent): number | null {
    const target = event.currentTarget as SVGElement;
    const box = target.getBoundingClientRect();
    const x = event.clientX - box.left;
    if (columns.length === 0) return null;
    let best = 0;
    let distance = Infinity;
    for (let index = 0; index < columns.length; index++) {
      const delta = Math.abs(centre(columns[index]!) - x);
      if (delta < distance) {
        distance = delta;
        best = index;
      }
    }
    return best;
  }

  function onKeydown(event: KeyboardEvent) {
    if (columns.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const from = hovered ?? (delta > 0 ? -1 : columns.length);
      hovered = Math.max(0, Math.min(columns.length - 1, from + delta));
      return;
    }
    if (event.key === "Escape") hovered = null;
  }

  /** Kept inside the plot, so a mark at either edge still reads its tooltip. */
  const tooltipLeft = $derived.by(() => {
    if (!active) return 0;
    return Math.max(PAD.left, Math.min(width - 150, centre(active) - 75));
  });
</script>

<div class="chart" class:loading bind:clientWidth={width}>
  <!--
    The plot is deliberately focusable: a keyboard user walks the columns with
    the arrow keys and gets the same readout hovering gives, so the tooltip is
    never the only way to read a value.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    {width}
    height={HEIGHT}
    viewBox={`0 0 ${width} ${HEIGHT}`}
    role="img"
    aria-label={`${valueLabel} over time, ${points.length} points`}
    tabindex="0"
    onpointermove={(event) => (hovered = nearest(event))}
    onpointerleave={() => (hovered = null)}
    onkeydown={onKeydown}
    onblur={() => (hovered = null)}
  >
    <!-- Gridlines and axes are hairlines one step off the surface. -->
    {#each ticks as tick (tick)}
      <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
      <text class="tick" x={PAD.left - 8} y={y(tick) + 3.5} text-anchor="end">
        {measure(tick, unit)}
      </text>
    {/each}

    {#if mode === "bars"}
      {#each columns as column, index (column.x)}
        <path class="bar" class:hot={index === hovered} d={barPath(column)} />
      {/each}
    {:else if columns.length > 0}
      <!-- The raw heights stay behind the smoothed line, faintly (§11.2). -->
      <path class="area" d={areaPath} />
      {#if smoothWindow > 1}
        <path class="raw" d={rawPath} />
      {/if}
      <path class="line" d={linePath} />
      {#if showMarkers}
        {#each columns as column, index (column.x)}
          <circle class="marker" cx={centre(column)} cy={y(smoothed[index]!)} r="4" />
        {/each}
      {/if}
    {/if}

    {#if active}
      <line
        class="crosshair"
        x1={centre(active)}
        x2={centre(active)}
        y1={PAD.top}
        y2={PAD.top + plotHeight}
      />
      <circle class="hot-dot" cx={centre(active)} cy={y(active.value)} r="4" />
    {/if}

    <line
      class="axis"
      x1={PAD.left}
      x2={width - PAD.right}
      y1={PAD.top + plotHeight}
      y2={PAD.top + plotHeight}
    />
    {#each xLabels as label (label.x)}
      <text class="tick" x={label.x} y={HEIGHT - 6} text-anchor="middle">
        {label.text}
      </text>
    {/each}
  </svg>

  {#if active}
    <div class="tooltip mono" style:left={`${tooltipLeft}px`}>
      <strong>{measure(active.value, unit)}</strong>
      <span class="dim">{absoluteTime(active.at)}</span>
      {#if active.count > 1}
        <span class="dim">{active.count} entries here · tallest shown</span>
      {/if}
    </div>
  {/if}

  {#if points.length === 0}
    <p class="empty">Nothing recorded yet.</p>
  {/if}
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
  }

  .chart.loading {
    opacity: 0.55;
  }

  svg {
    display: block;
    overflow: visible;
  }

  svg:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-control);
  }

  .grid {
    stroke: var(--line-2);
    stroke-width: 1;
  }

  .axis {
    stroke: var(--control);
    stroke-width: 1;
  }

  .tick {
    fill: var(--text-4);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .bar {
    fill: var(--accent);
  }

  .bar.hot {
    fill: var(--text);
  }

  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* The unsmoothed series, kept as a whisper under the trend. */
  .raw {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1;
    opacity: 0.28;
  }

  .area {
    fill: var(--accent);
    opacity: 0.1;
  }

  .marker {
    fill: var(--accent);
    stroke: var(--panel);
    stroke-width: 2;
  }

  .crosshair {
    stroke: var(--text-4);
    stroke-width: 1;
  }

  .hot-dot {
    fill: var(--text);
    stroke: var(--panel);
    stroke-width: 2;
  }

  /* Values lead, the label follows (§11.2). */
  .tooltip {
    position: absolute;
    top: 2px;
    width: 150px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    background: var(--raised-2);
    border-radius: var(--radius-control);
    box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
    font-size: 11px;
    pointer-events: none;
  }

  .tooltip strong {
    color: var(--text);
    font-weight: 500;
    font-size: 12px;
  }

  .tooltip .dim {
    font-size: 10px;
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    color: var(--text-4);
    font-size: 12px;
  }
</style>
