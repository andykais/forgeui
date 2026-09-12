<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import Grid2x2 from "@lucide/svelte/icons/grid-2x2";
  import Grid3x3 from "@lucide/svelte/icons/grid-3x3";
  import List from "@lucide/svelte/icons/list";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { panel } from "../stores/panel.svelte.ts";
  import { navigate, router, setQuery } from "../router.svelte.ts";
  import { dayLabel, localDate } from "../lib/format.ts";
  import { byModel } from "../lib/models.ts";
  import type { Output, TileSize } from "../types.ts";
  import Tile from "../components/Tile.svelte";
  import MediaTable from "../components/MediaTable.svelte";
  import { untrack } from "svelte";
  import Popover from "../components/Popover.svelte";
  import Viewer from "../components/Viewer.svelte";
  import { toasts } from "../stores/toasts.svelte.ts";

  /**
   * Gallery (§11.2): one infinite keyset-paginated list in tiles or table
   * form, day dividers inserted client-side with counts fetched lazily,
   * every filter a URL param, and the shared viewer over the top.
   */
  let outputs = $state<Output[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  let exhausted = $state(false);
  let total = $state<number | null>(null);
  let dayCounts = $state<Record<string, number>>({});
  let workflowOpen = $state(false);
  let modelsOpen = $state(false);
  let sortOpen = $state(false);
  let searchDraft = $state("");
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let viewer = $state<ReturnType<typeof Viewer> | null>(null);

  const query = $derived(router.current.query);
  const filters = $derived({
    workflow: query.get("workflow") ?? undefined,
    kind: query.get("kind") ?? undefined,
    models: query.get("models")?.split(",").filter(Boolean) ?? undefined,
    q: query.get("q") ?? undefined,
    sort: (query.get("sort") as "newest" | "oldest" | null) ?? "newest",
  });
  const filterKey = $derived(JSON.stringify(filters));
  const selectedId = $derived(query.get("output"));
  const selected = $derived(outputs.find((output) => output.id === selectedId) ?? null);
  const tileSize = $derived(app.tileSize("gallery"));
  const hasFilters = $derived(
    Boolean(filters.workflow || filters.kind || filters.q || filters.models?.length),
  );

  /**
   * Every filter change restarts the list from the top. The reload runs
   * untracked: `loadMore` reads `loading` and `cursor`, and letting those
   * become dependencies would make this effect retrigger itself.
   */
  $effect(() => {
    filterKey;
    untrack(() => {
      outputs = [];
      cursor = null;
      exhausted = false;
      dayCounts = {};
      searchDraft = filters.q ?? "";
      void loadMore(true);
      api
        .outputCount(filters)
        .then((count) => (total = count))
        .catch(() => {});
    });
  });

  async function loadMore(first = false) {
    if (loading || (exhausted && !first)) return;
    loading = true;
    try {
      const page = await api.outputs({
        ...filters,
        cursor: first ? null : cursor,
        limit: 60,
      });
      outputs = first ? page.outputs : [...outputs, ...page.outputs];
      cursor = page.cursor;
      exhausted = page.cursor === null;
      void loadDayCounts();
    } finally {
      loading = false;
    }
  }

  /** Counts arrive after the rows; they are allowed to pop in late (§11.2). */
  async function loadDayCounts() {
    const dates = [...new Set(outputs.map((output) => localDate(output.created_at)))];
    if (dates.length === 0) return;
    const counts = await api.outputDays(dates, filters).catch(() => ({}));
    dayCounts = { ...dayCounts, ...counts };
  }

  /** The client inserts the dividers; the endpoint returns flat rows (§11.2). */
  const rows = $derived.by(() => {
    const out: ({ divider: string } | { output: Output })[] = [];
    let currentDay = "";
    for (const output of outputs) {
      const day = localDate(output.created_at);
      if (day !== currentDay) {
        currentDay = day;
        out.push({ divider: day });
      }
      out.push({ output });
    }
    return out;
  });

  function onScroll() {
    if (!scroller || loading || exhausted) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < 600) void loadMore();
  }

  function select(output: Output | null) {
    setQuery({ output: output?.id ?? null });
  }

  async function reuseParams(output: Output) {
    if (!output.workflow_id) return;
    const detail = await api.output(output.id);
    await panel.editWith(output.workflow_id, detail.sidecar?.params ?? output.params);
    navigate(`/generate?workflow=${output.workflow_id}`);
  }

  /**
   * One click to an upscale (§10): the output becomes the workflow's image
   * and the run that made it fills the rest. The numbers that make it an
   * upscale — creativity 0.4, scale 2 — are the workflow's own defaults, so
   * there is nothing to preset and everything to adjust before generating.
   */
  async function upscale(output: Output, workflowId: string) {
    const detail = await api.output(output.id);
    try {
      await panel.upscale(
        workflowId,
        output,
        detail.sidecar?.params ?? output.params,
      );
    } catch (cause) {
      toasts.message(
        `Could not upscale: ${cause instanceof Error ? cause.message : cause}`,
      );
      return;
    }
    navigate(`/generate?workflow=${workflowId}`);
  }

  async function rerun(output: Output) {
    await api.rerun({ output_id: output.id });
    toasts.message("Queued a rerun of that graph");
  }

  async function remove(output: Output) {
    const { undo_window_ms } = await api.deleteOutput(output.id);
    outputs = outputs.filter((entry) => entry.id !== output.id);
    if (selectedId === output.id) select(null);
    if (total !== null) total -= 1;
    // The day divider's count has to follow the tile that just left.
    void loadDayCounts();
    toasts.undo(output, undo_window_ms, (restored) => {
      // Back where it was, so the undo does not move the grid around.
      const descending = filters.sort !== "oldest";
      const at = outputs.findIndex((entry) =>
        descending
          ? entry.created_at < restored.created_at ||
            (entry.created_at === restored.created_at && entry.id < restored.id)
          : entry.created_at > restored.created_at ||
            (entry.created_at === restored.created_at && entry.id > restored.id),
      );
      outputs =
        at < 0
          ? [...outputs, restored]
          : [...outputs.slice(0, at), restored, ...outputs.slice(at)];
      if (total !== null) total += 1;
      void loadDayCounts();
    });
  }

  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const action = app.keyAction(event);
    if (!action) return;
    const columns = tileSize === "large" ? 4 : 6;
    const index = outputs.findIndex((output) => output.id === selectedId);
    const move = (delta: number) => {
      if (index < 0) return;
      const next = outputs[index + delta];
      if (next) select(next);
      // Walking off the end pulls the next page in.
      if (index + delta >= outputs.length - 2) void loadMore();
    };
    switch (action) {
      // The list reads left to right, so left is a step back through it.
      case "select_prev":
        event.preventDefault();
        move(-1);
        break;
      case "select_next":
        event.preventDefault();
        move(1);
        break;
      case "select_down":
        event.preventDefault();
        move(columns);
        break;
      case "select_up":
        event.preventDefault();
        move(-columns);
        break;
      case "fullscreen":
        if (selected) {
          event.preventDefault();
          viewer?.toggleFullscreen();
        }
        break;
      case "close":
        event.preventDefault();
        if (!viewer?.exitFullscreen()) select(null);
        break;
    }
  }

  const sizes: { size: TileSize; icon: typeof List; title: string }[] = [
    { size: "small", icon: Grid3x3, title: "Small tiles" },
    { size: "large", icon: Grid2x2, title: "Large tiles" },
    { size: "table", icon: List, title: "Table" },
  ];

  const selectedModels = $derived(filters.models ?? []);
  const modelNames = $derived(selectedModels.map((hash) => app.modelName(hash)));

  /**
   * Checkpoints then LoRAs, each with the count behind it (§11.2). One row
   * per model, not per file: these rows filter by hash, so two copies of one
   * file would be the same filter listed twice.
   */
  const modelGroups = $derived([
    {
      label: "checkpoints",
      models: byModel(app.checkpoints.filter((model) => model.hash !== null)),
    },
    {
      label: "loras",
      models: byModel(app.loras.filter((model) => model.hash !== null)),
    },
  ]);

  /** Selections always AND, so toggling one adds a condition (§11.2). */
  function toggleModel(hash: string) {
    const next = selectedModels.includes(hash)
      ? selectedModels.filter((entry) => entry !== hash)
      : [...selectedModels, hash];
    setQuery({ models: next.length > 0 ? next.join(",") : null });
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if selected}
  <Viewer
    bind:this={viewer}
    screen="gallery"
    {outputs}
    {selected}
    onselect={select}
    onclose={() => select(null)}
    onedit={reuseParams}
    onrerun={rerun}
    ondelete={remove}
    onupscale={upscale}
  />
{:else}
  <section class="gallery">
    <header class="filters">
      <label class="search">
        <Search size={13} />
        <input
          placeholder="Search prompts…"
          value={searchDraft}
          oninput={(event) =>
            (searchDraft = (event.currentTarget as HTMLInputElement).value)}
          onkeydown={(event) => {
            if (event.key === "Enter") setQuery({ q: searchDraft || null });
            if (event.key === "Escape") {
              searchDraft = "";
              setQuery({ q: null });
            }
          }}
          onblur={() => setQuery({ q: searchDraft || null })}
        />
      </label>

      <div class="chip-wrap">
        <button class="chip" onclick={() => (workflowOpen = !workflowOpen)}>
          Workflow: <strong>{filters.workflow ?? "All"}</strong>
          <ChevronDown size={12} />
        </button>
        <Popover
          open={workflowOpen}
          title="Workflow"
          onclose={() => (workflowOpen = false)}
        >
          <button
            class="option"
            onclick={() => {
              setQuery({ workflow: null });
              workflowOpen = false;
            }}
          >
            All workflows
          </button>
          {#each app.workflows as workflow (workflow.id)}
            <button
              class="option"
              onclick={() => {
                setQuery({ workflow: workflow.id });
                workflowOpen = false;
              }}
            >
              {workflow.name}
            </button>
          {/each}
        </Popover>
      </div>

      <div class="row kinds">
        {#each [["", "All"], ["image", "Image"], ["video", "Video"]] as const as [value, text] (value)}
          <button
            class:active={(filters.kind ?? "") === value}
            onclick={() => setQuery({ kind: value || null })}
          >
            {text}
          </button>
        {/each}
      </div>

      <div class="chip-wrap">
        <button class="chip" onclick={() => (modelsOpen = !modelsOpen)}>
          Models: <strong>{modelNames.length > 0 ? modelNames.join(", ") : "All"}</strong>
          <ChevronDown size={12} />
        </button>
        <Popover
          open={modelsOpen}
          width={260}
          title="Models"
          onclose={() => (modelsOpen = false)}
        >
          {#if selectedModels.length > 0}
            <button class="option" onclick={() => setQuery({ models: null })}>
              Clear the model filter
            </button>
          {/if}
          {#each modelGroups as group (group.label)}
            {#if group.models.length > 0}
              <div class="group mono dim">{group.label}</div>
              {#each group.models as model (model.id)}
                <button class="option check" onclick={() => toggleModel(model.hash!)}>
                  <span class="mark mono">
                    {selectedModels.includes(model.hash!) ? "✓" : ""}
                  </span>
                  <span class="option-name">{model.display_name}</span>
                  <span class="mono dim">{model.output_count}</span>
                </button>
              {/each}
            {/if}
          {/each}
          {#if modelGroups.every((group) => group.models.length === 0)}
            <p class="empty">
              Nothing has been hashed yet, so no output can be attributed to a model
              (§8.1).
            </p>
          {/if}
        </Popover>
      </div>

      <span class="spacer"></span>

      <div class="chip-wrap">
        <button class="chip" onclick={() => (sortOpen = !sortOpen)}>
          Sort: <strong>{filters.sort === "oldest" ? "Oldest" : "Newest"}</strong>
          <ChevronDown size={12} />
        </button>
        <Popover
          open={sortOpen}
          width={160}
          align="right"
          onclose={() => (sortOpen = false)}
        >
          {#each [["newest", "Newest"], ["oldest", "Oldest"]] as const as [value, text] (value)}
            <button
              class="option"
              onclick={() => {
                setQuery({ sort: value === "newest" ? null : value });
                sortOpen = false;
              }}
            >
              {text}
            </button>
          {/each}
        </Popover>
      </div>

      <div class="row sizes">
        {#each sizes as entry (entry.size)}
          <button
            class:active={tileSize === entry.size}
            title={entry.title}
            aria-label={entry.title}
            onclick={() => app.setTileSize("gallery", entry.size)}
          >
            <entry.icon size={14} />
          </button>
        {/each}
      </div>

      <span class="mono dim total">
        {total === null ? "…" : `${total.toLocaleString()} outputs`}
      </span>
      {#if hasFilters}
        <button
          class="clear"
          onclick={() => setQuery({ workflow: null, kind: null, models: null, q: null })}
        >
          Clear filters
        </button>
      {/if}
    </header>

    <div class="body scroll" bind:this={scroller} onscroll={onScroll}>
      {#if tileSize === "table"}
        <MediaTable {outputs} selectedId={null} onopen={select} />
      {:else}
        {#each rows as row ("divider" in row ? `d:${row.divider}` : row.output.id)}
          {#if "divider" in row}
            <div class="divider">
              <span class="day">{dayLabel(row.divider)}</span>
              <span class="mono dim">
                {dayCounts[row.divider] === undefined
                  ? "…"
                  : `${dayCounts[row.divider]} outputs`}
              </span>
            </div>
          {:else}
            <div class="cell" class:large={tileSize === "large"}>
              <Tile
                output={row.output}
                selected={selectedId === row.output.id}
                onopen={select}
              />
            </div>
          {/if}
        {/each}
      {/if}

      {#if loading}
        <p class="empty">loading…</p>
      {:else if outputs.length === 0}
        <div class="empty-state">
          <p>No outputs{hasFilters ? " match these filters" : " yet"}.</p>
          <p class="dim">
            {app.workflows.length} workflows ready · generate something and it lands here.
          </p>
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .gallery {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    flex-wrap: wrap;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--raised);
    border-radius: var(--radius-input);
    padding-left: 8px;
    width: 220px;
    color: var(--text-4);
  }

  .search input {
    background: transparent;
    padding-left: 0;
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

  .group {
    font-size: 10px;
    padding: 6px 7px 2px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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

  .empty {
    font-size: 11px;
    color: var(--text-4);
    padding: 6px 8px;
    margin: 0;
  }

  .kinds button,
  .sizes button {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--raised);
    color: var(--text-3);
  }

  .sizes button {
    display: flex;
    padding: 4px 6px;
  }

  .kinds button.active,
  .sizes button.active {
    background: var(--control-selected);
    color: var(--text);
  }

  .total {
    font-size: 11px;
  }

  .clear {
    font-size: 11px;
    background: transparent;
    color: var(--accent);
  }

  .body {
    flex: 1;
    /* The same guard the Generate grid needs: a scrolling grid that cannot
       shrink below its content overflows its row instead of scrolling. */
    min-height: 0;
    padding: 0 12px 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    /* The same row-collapse guard the Models grid needs. */
    grid-auto-rows: max-content;
    gap: 8px;
    align-content: start;
    align-items: start;
  }

  /* Day dividers span the grid and stick while scrolling (§11.2). */
  .divider {
    grid-column: 1 / -1;
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 10px 0 4px;
    background: var(--canvas);
  }

  .day {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  .divider .mono {
    font-size: 11px;
  }

  .cell.large {
    grid-column: span 2;
  }

  .empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 48px 12px;
    color: var(--text-3);
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
</style>
