<script lang="ts">
  import { absoluteTime, axisTime, measure } from "../lib/format.ts";
  import { niceCeiling } from "../lib/chart.ts";
  import type { TelemetryPoint, TelemetryUnit } from "../types.ts";

  /**
   * The telemetry timeline (§11.2). Every point the report holds, for all
   * time, squeezed into the width there is — as one mark per point, or as a
   * smoothed line over them. One value, one y axis, no zoom and no range
   * picker: narrowing is the filters' job, not the graph's.
   *
   * A report can draw more than one line (Memory Usage draws VRAM and RAM),
   * in which case a legend is always present: identity never rests on colour
   * alone.
   */
  export interface ChartSeries {
    key: string | null;
    label: string;
    points: TelemetryPoint[];
  }

  interface Props {
    series: ChartSeries[];
    unit: TelemetryUnit;
    valueLabel: string;
    mode: "bars" | "line";
    /**
     * What a column stands for when more points land in it than there are
     * pixels: the tallest of them, or the last. A running total is read as
     * "where the line had got to", so it takes the last (§7.1).
     */
    aggregate?: "max" | "last";
    /** Dimmed rather than blanked while a reload is in flight. */
    loading?: boolean;
  }

  let {
    series,
    unit,
    valueLabel,
    mode,
    aggregate = "max",
    loading = false,
  }: Props = $props();

  const HEIGHT = 212;
  const PAD = { top: 14, right: 14, bottom: 22, left: 68 };
  /** 24px is the cap; a band narrower than 2px stops being a mark. */
  const MAX_SLOT = 24;
  const MIN_SLOT = 2;
  const LABEL_GAP = 110;

  let width = $state(720);
  let hovered = $state<number | null>(null);

  const plotWidth = $derived(Math.max(40, width - PAD.left - PAD.right));
  const plotHeight = $derived(HEIGHT - PAD.top - PAD.bottom);
  /**
   * Every line the report declares, empty ones included: a line that has no
   * points yet keeps its name in the legend and its colour in the order, so
   * the other line is not repainted the moment data arrives for it.
   */
  const lines = $derived(series);
  const totalPoints = $derived(
    lines.reduce((total, line) => total + line.points.length, 0),
  );
  const longest = $derived(
    lines.reduce((most, line) => Math.max(most, line.points.length), 0),
  );

  /** The window every line shares, so they are read against one another. */
  const bounds = $derived.by(() => {
    let from = Infinity;
    let to = -Infinity;
    for (const line of lines) {
      if (line.points.length === 0) continue;
      from = Math.min(from, line.points[0]!.at);
      to = Math.max(to, line.points[line.points.length - 1]!.at);
    }
    return totalPoints === 0 ? { from: 0, to: 0 } : { from, to };
  });
  const span = $derived(bounds.to - bounds.from);

  interface Cell {
    value: number;
    /** How many points landed here; 1 unless the log is denser than the px. */
    count: number;
    at: number;
  }

  interface Slot {
    /** Left edge in px. */
    x: number;
    /** When the points in this slot happened; the first of them. */
    at: number;
    /** One cell per line, or null where that line has nothing here. */
    cells: (Cell | null)[];
  }

  const slotWidth = $derived(
    Math.min(MAX_SLOT, Math.max(MIN_SLOT, plotWidth / Math.max(1, longest))),
  );

  /**
   * The x axis is time, so points are placed by when they happened rather
   * than by their position in the list, and every line lands on the same
   * grid. Once the log is denser than the pixels available, a slot stands
   * for the points that share it; the count travels to the tooltip so a mark
   * is never read as one entry.
   */
  const slots = $derived.by<Slot[]>(() => {
    if (totalPoints === 0) return [];
    const count = Math.max(1, Math.floor(plotWidth / slotWidth));
    const found = new Map<number, Slot>();
    lines.forEach((line, index) => {
      for (const point of line.points) {
        const fraction = span === 0 ? 0.5 : (point.at - bounds.from) / span;
        const at = Math.min(count - 1, Math.floor(fraction * count));
        let slot = found.get(at);
        if (!slot) {
          slot = {
            x: PAD.left + at * slotWidth,
            at: point.at,
            cells: lines.map(() => null),
          };
          found.set(at, slot);
        }
        slot.at = Math.min(slot.at, point.at);
        const cell = slot.cells[index];
        if (!cell) {
          slot.cells[index] = { value: point.value, count: 1, at: point.at };
          continue;
        }
        cell.count++;
        if (aggregate === "last" || point.value > cell.value) {
          cell.value = point.value;
          cell.at = point.at;
        }
      }
    });
    return [...found.values()].sort((a, b) => a.x - b.x);
  });

  const ceiling = $derived(
    niceCeiling(
      slots.reduce(
        (peak, slot) =>
          slot.cells.reduce((highest, cell) => Math.max(highest, cell?.value ?? 0), peak),
        0,
      ),
      unit,
    ),
  );

  function y(value: number): number {
    return PAD.top + plotHeight - (value / ceiling) * plotHeight;
  }

  const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((at) => at * ceiling));

  /** Lines share the slot side by side, with the 2px gap between them. */
  const barWidth = $derived.by(() => {
    const share = slotWidth / Math.max(1, lines.length);
    return Math.max(1, share - (share >= 6 ? 2 : share >= 3 ? 1 : 0));
  });

  function barX(slot: Slot, index: number): number {
    const share = slotWidth / Math.max(1, lines.length);
    return slot.x + index * share + (share - barWidth) / 2;
  }

  /** Square at the baseline, 4px rounded at the data end. */
  function barPath(slot: Slot, index: number, cell: Cell): string {
    const height = Math.max(1, PAD.top + plotHeight - y(cell.value));
    const top = PAD.top + plotHeight - height;
    const x = barX(slot, index);
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

  function centre(slot: Slot): number {
    return slot.x + slotWidth / 2;
  }

  /**
   * The smoothing window follows the point count: a handful of entries is
   * drawn as it is, a thousand is a trend. Always odd, so the mean is
   * centred on the slot it replaces.
   */
  const smoothWindow = $derived(
    Math.max(1, Math.min(31, 2 * Math.floor(slots.length / 24) + 1)),
  );

  interface Drawn {
    /** Slot index and value, for the slots this line actually has. */
    at: number[];
    raw: number[];
    smoothed: number[];
  }

  const drawn = $derived.by<Drawn[]>(() =>
    lines.map((_line, index) => {
      const at: number[] = [];
      const raw: number[] = [];
      slots.forEach((slot, slotIndex) => {
        const cell = slot.cells[index];
        if (!cell) return;
        at.push(slotIndex);
        raw.push(cell.value);
      });
      const smoothed = raw.map((value, position) => {
        if (smoothWindow === 1) return value;
        const half = (smoothWindow - 1) / 2;
        const from = Math.max(0, position - half);
        const to = Math.min(raw.length - 1, position + half);
        let total = 0;
        for (let i = from; i <= to; i++) total += raw[i]!;
        return total / (to - from + 1);
      });
      return { at, raw, smoothed };
    }),
  );

  function path(line: Drawn, values: number[]): string {
    return line.at
      .map(
        (slotIndex, position) =>
          `${position === 0 ? "M" : "L"}${centre(slots[slotIndex]!).toFixed(1)} ${y(
            values[position]!,
          ).toFixed(1)}`,
      )
      .join(" ");
  }

  /** The wash only reads under a single line; two of them would muddy. */
  const showArea = $derived(mode === "line" && lines.length === 1);
  /** Markers only while they can be told apart (≥ 8px across, r ≥ 4). */
  const showMarkers = $derived(mode === "line" && slots.length <= 40);

  /**
   * Labels are chosen by where they land, not by how many slots apart they
   * are: entries arrive in bursts, so evenly-spaced slots are not evenly
   * spaced across the plot, and picking by index writes them on top of one
   * another.
   */
  const xLabels = $derived.by(() => {
    if (slots.length === 0) return [];
    const labels: { x: number; text: string }[] = [];
    const count = Math.max(2, Math.floor(plotWidth / LABEL_GAP));
    for (let index = 0; index < count; index++) {
      const target = PAD.left + (plotWidth * index) / (count - 1);
      let slot = slots[0]!;
      let distance = Infinity;
      for (const candidate of slots) {
        const delta = Math.abs(centre(candidate) - target);
        if (delta < distance) {
          distance = delta;
          slot = candidate;
        }
      }
      const x = Math.max(PAD.left + 32, Math.min(width - PAD.right - 32, centre(slot)));
      const previous = labels[labels.length - 1];
      if (previous && x - previous.x < LABEL_GAP * 0.7) continue;
      labels.push({ x, text: axisTime(slot.at, span) });
    }
    return labels;
  });

  const active = $derived(hovered === null ? null : (slots[hovered] ?? null));
  /** One tooltip, every line: the pointer never has to find a mark. */
  const activeRows = $derived(
    active === null
      ? []
      : lines
          .map((line, index) => ({
            label: line.label,
            index,
            cell: active.cells[index] ?? null,
          }))
          .filter((row) => row.cell !== null),
  );

  function nearest(event: PointerEvent | MouseEvent): number | null {
    if (slots.length === 0) return null;
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const x = event.clientX - box.left;
    let best = 0;
    let distance = Infinity;
    for (let index = 0; index < slots.length; index++) {
      const delta = Math.abs(centre(slots[index]!) - x);
      if (delta < distance) {
        distance = delta;
        best = index;
      }
    }
    return best;
  }

  function onKeydown(event: KeyboardEvent) {
    if (slots.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const from = hovered ?? (delta > 0 ? -1 : slots.length);
      hovered = Math.max(0, Math.min(slots.length - 1, from + delta));
      return;
    }
    if (event.key === "Escape") hovered = null;
  }

  /** Kept inside the plot, so a mark at either edge still reads its tooltip. */
  const tooltipLeft = $derived(
    active === null ? 0 : Math.max(PAD.left, Math.min(width - 160, centre(active) - 80)),
  );
</script>

<div class="chart" class:loading bind:clientWidth={width}>
  {#if lines.length > 1}
    <!-- Two lines or more always carry a legend (§11.2). -->
    <ul class="legend">
      {#each lines as line, index (line.key ?? index)}
        <li>
          <span class="swatch" class:stroke={mode === "line"} data-series={index}></span>
          {line.label}
        </li>
      {/each}
    </ul>
  {/if}

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
    aria-label={`${valueLabel} over time, ${totalPoints} points`}
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
      {#each slots as slot, slotIndex (slot.x)}
        {#each slot.cells as cell, index (index)}
          {#if cell}
            <path
              class="bar"
              class:hot={slotIndex === hovered}
              data-series={index}
              d={barPath(slot, index, cell)}
            />
          {/if}
        {/each}
      {/each}
    {:else}
      {#each drawn as line, index (lines[index]?.key ?? index)}
        {#if line.at.length > 0}
          {#if showArea}
            <path
              class="area"
              data-series={index}
              d={`${path(line, line.smoothed)} L${centre(
                slots[line.at[line.at.length - 1]!]!,
              ).toFixed(1)} ${PAD.top + plotHeight} L${centre(
                slots[line.at[0]!]!,
              ).toFixed(1)} ${PAD.top + plotHeight} Z`}
            />
          {/if}
          {#if smoothWindow > 1}
            <!-- The raw heights stay behind the trend, faintly (§11.2). -->
            <path class="raw" data-series={index} d={path(line, line.raw)} />
          {/if}
          <path class="line" data-series={index} d={path(line, line.smoothed)} />
          {#if showMarkers}
            {#each line.at as slotIndex, position (slotIndex)}
              <circle
                class="marker"
                data-series={index}
                cx={centre(slots[slotIndex]!)}
                cy={y(line.smoothed[position]!)}
                r="4"
              />
            {/each}
          {/if}
        {/if}
      {/each}
    {/if}

    {#if active}
      <line
        class="crosshair"
        x1={centre(active)}
        x2={centre(active)}
        y1={PAD.top}
        y2={PAD.top + plotHeight}
      />
      {#each activeRows as row (row.index)}
        <circle class="hot-dot" cx={centre(active)} cy={y(row.cell!.value)} r="4" />
      {/each}
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

  {#if active && activeRows.length > 0}
    <div class="tooltip mono" style:left={`${tooltipLeft}px`}>
      {#each activeRows as row (row.index)}
        <div class="row">
          {#if lines.length > 1}
            <span class="key" data-series={row.index}></span>
            <span class="dim name">{row.label}</span>
          {/if}
          <strong>{measure(row.cell!.value, unit)}</strong>
        </div>
      {/each}
      <span class="dim when">{absoluteTime(active.at)}</span>
      {#if activeRows.some((row) => (row.cell?.count ?? 0) > 1)}
        <span class="dim when">
          {activeRows.reduce((total, row) => total + (row.cell?.count ?? 0), 0)}
          entries here · {aggregate === "last" ? "latest" : "tallest"} shown
        </span>
      {/if}
    </div>
  {/if}

  {#if totalPoints === 0}
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

  /*
   * The two series colours are assigned in a fixed order and never cycled:
   * line one is always the accent, line two always the gold (§11.5).
   */
  [data-series="0"] {
    --series: var(--series-1);
  }

  [data-series="1"] {
    --series: var(--series-2);
  }

  .legend {
    display: flex;
    gap: 12px;
    list-style: none;
    margin: 0 0 2px;
    padding: 0 0 0 var(--legend-inset, 68px);
    font-size: 11px;
    color: var(--text-3);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--series, var(--series-1));
  }

  /* The legend mirrors the mark: a rect for bars, a stroke for lines. */
  .swatch.stroke {
    height: 2px;
    width: 14px;
    border-radius: 1px;
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
    fill: var(--series, var(--series-1));
  }

  .bar.hot {
    fill: var(--text);
  }

  .line {
    fill: none;
    stroke: var(--series, var(--series-1));
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* The unsmoothed series, kept as a whisper under the trend. */
  .raw {
    fill: none;
    stroke: var(--series, var(--series-1));
    stroke-width: 1;
    opacity: 0.28;
  }

  .area {
    fill: var(--series, var(--series-1));
    opacity: 0.1;
  }

  .marker {
    fill: var(--series, var(--series-1));
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
    width: 160px;
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

  .tooltip .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tooltip .name {
    flex: 1;
    min-width: 0;
  }

  .tooltip .key {
    width: 10px;
    height: 2px;
    border-radius: 1px;
    background: var(--series, var(--series-1));
  }

  .tooltip strong {
    color: var(--text);
    font-weight: 500;
    font-size: 12px;
  }

  .tooltip .when {
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
