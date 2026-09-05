<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Grid2x2 from "@lucide/svelte/icons/grid-2x2";
  import Grid3x3 from "@lucide/svelte/icons/grid-3x3";
  import List from "@lucide/svelte/icons/list";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { panel } from "../stores/panel.svelte.ts";
  import { untrack } from "svelte";
  import { navigate, router, setQuery } from "../router.svelte.ts";
  import { relativeTime } from "../lib/format.ts";
  import type { Output, TileSize } from "../types.ts";
  import ParamPanel from "../components/params/ParamPanel.svelte";
  import Popover from "../components/Popover.svelte";
  import Tile from "../components/Tile.svelte";
  import JobCard from "../components/JobCard.svelte";
  import Viewer from "../components/Viewer.svelte";
  import MediaTable from "../components/MediaTable.svelte";
  import { toasts } from "../stores/toasts.svelte.ts";

  /**
   * Generate (§11.2): the param panel on the left with the workflow selector
   * inside it, this session's results on the right, and a focused view that
   * keeps the panel and uses the same viewer layout as Gallery.
   */
  let pickerOpen = $state(false);
  let filter = $state<"all" | "active" | "done">("all");
  let following = $state(true);
  let selectedId = $state<string | null>(null);
  /** True once a result has been opened; the focused view replaces the grid. */
  let focusRequested = $state(false);
  let viewer = $state<ReturnType<typeof Viewer> | null>(null);

  const workflows = $derived(app.workflows.filter((workflow) => workflow.runnable));
  const selectedWorkflow = $derived(app.workflow(panel.workflowId));
  const tileSize = $derived(app.tileSize("generate"));

  /** This session's jobs, newest first, with their outputs (§11.2). */
  const sessionJobs = $derived(
    app.jobs.filter(
      (job) =>
        filter === "all" ||
        (filter === "active"
          ? job.status === "queued" || job.status === "running"
          : job.status === "done"),
    ),
  );
  const sessionOutputs = $derived(
    app.jobs
      .flatMap((job) => app.jobOutputs(job))
      .sort((a, b) =>
        b.created_at === a.created_at
          ? b.id.localeCompare(a.id)
          : b.created_at - a.created_at,
      ),
  );
  const queuedJobs = $derived(app.activeJobs.filter((job) => job.status === "queued"));

  const focused = $derived.by(() => {
    if (following) return sessionOutputs[0] ?? null;
    return sessionOutputs.find((output) => output.id === selectedId) ?? null;
  });
  const isFocused = $derived(focusRequested && focused !== null);

  /** The workflow is chosen in the URL, so a refresh keeps the panel (§11.2). */
  $effect(() => {
    const wanted = router.current.query.get("workflow");
    const available = workflows.length;
    untrack(() => {
      if (wanted && wanted !== panel.workflowId) {
        void panel.select(wanted);
      } else if (!wanted && !panel.workflowId && available > 0) {
        const last = [...workflows].sort(
          (a, b) => (b.last_job_at ?? 0) - (a.last_job_at ?? 0),
        )[0];
        if (last) setQuery({ workflow: last.id });
      }
    });
  });

  function pick(id: string) {
    pickerOpen = false;
    setQuery({ workflow: id });
  }

  /** Grouped by family and kind, with the last output as the thumbnail. */
  const grouped = $derived.by(() => {
    const groups = new Map<string, typeof workflows>();
    for (const workflow of workflows) {
      const key = `${workflow.family ?? "unset"} · ${workflow.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), workflow]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  function thumbnailFor(outputId: string | null): string | null {
    if (!outputId) return null;
    return app.outputs[outputId]?.media_url ?? null;
  }

  function open(output: Output) {
    selectedId = output.id;
    focusRequested = true;
    following = sessionOutputs[0]?.id === output.id;
  }

  function closeFocused() {
    selectedId = null;
    focusRequested = false;
  }

  async function editInGenerate(output: Output) {
    const workflowId = output.workflow_id;
    if (!workflowId) return;
    const detail = await api.output(output.id);
    await panel.editWith(workflowId, detail.sidecar?.params ?? output.params);
    setQuery({ workflow: workflowId });
    closeFocused();
  }

  async function rerun(output: Output) {
    await api.rerun({ output_id: output.id });
    following = true;
    selectedId = null;
  }

  async function remove(output: Output) {
    const { undo_window_ms } = await api.deleteOutput(output.id);
    if (selectedId === output.id) closeFocused();
    toasts.undo(output, undo_window_ms);
  }

  /** §11.4: two behaviours only, and never while typing. */
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
    const columns = tileSize === "large" ? 2 : 3;
    const index = focused
      ? sessionOutputs.findIndex((output) => output.id === focused.id)
      : -1;
    const move = (delta: number) => {
      const next = sessionOutputs[index + delta];
      if (next) {
        selectedId = next.id;
        following = sessionOutputs[0]?.id === next.id;
        focusRequested = true;
      } else if (delta < 0 && index === 0) {
        following = true;
      }
    };
    switch (action) {
      case "select_prev":
        event.preventDefault();
        move(1);
        break;
      case "select_next":
        event.preventDefault();
        move(-1);
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
        if (focused) {
          event.preventDefault();
          viewer?.toggleFullscreen();
        }
        break;
      case "close":
        event.preventDefault();
        if (!viewer?.exitFullscreen()) closeFocused();
        break;
    }
  }

  const sizes: { size: TileSize; icon: typeof List; title: string }[] = [
    { size: "small", icon: Grid3x3, title: "Small tiles" },
    { size: "large", icon: Grid2x2, title: "Large tiles" },
    { size: "table", icon: List, title: "Table" },
  ];
</script>

<svelte:window onkeydown={onKeydown} />

<div class="generate">
  <section class="panel scroll">
    <div class="card-wrap">
      <button class="workflow-card" onclick={() => (pickerOpen = !pickerOpen)}>
        <span class="thumb">
          {#if thumbnailFor(selectedWorkflow?.last_output_id ?? null)}
            <img src={thumbnailFor(selectedWorkflow?.last_output_id ?? null)} alt="" />
          {/if}
        </span>
        <span class="card-text">
          <span class="card-name">{selectedWorkflow?.name ?? "Choose a workflow"}</span>
          <span class="card-meta row">
            {#if selectedWorkflow?.family}
              <span class="badge accent">{selectedWorkflow.family}</span>
            {/if}
            {#if selectedWorkflow}
              <span class="badge">{selectedWorkflow.kind}</span>
              <span class="dim"
                >last run {relativeTime(selectedWorkflow.last_job_at)}</span
              >
            {/if}
          </span>
        </span>
        <ChevronDown size={14} />
      </button>

      <Popover open={pickerOpen} title="Workflows" onclose={() => (pickerOpen = false)}>
        {#each grouped as [group, entries] (group)}
          <div class="group label">{group}</div>
          {#each entries as workflow (workflow.id)}
            <button class="option" onclick={() => pick(workflow.id)}>
              <span class="option-thumb">
                {#if thumbnailFor(workflow.last_output_id)}
                  <img src={thumbnailFor(workflow.last_output_id)} alt="" />
                {/if}
              </span>
              <span class="option-text">
                <span>{workflow.name}</span>
                <span class="mono dim option-keys">
                  {workflow.params.keys.join(" · ")}
                </span>
              </span>
            </button>
          {/each}
        {/each}
      </Popover>
    </div>

    {#if panel.manifest}
      <ParamPanel
        manifest={panel.manifest}
        values={panel.values}
        seedLocked={panel.seedLocked}
        lastSeed={panel.lastSeed}
        loras={app.loras}
        checkpoints={app.checkpoints}
        warnings={panel.warnings}
        onchange={(key, value) => panel.set(key, value)}
        onreset={() => panel.resetToDefaults()}
        onseededit={(value) => panel.editSeed(value)}
        onseedroll={() => panel.rollSeed()}
        onseedlock={() => panel.toggleSeedLock()}
      />
    {:else if panel.loading}
      <p class="empty">loading…</p>
    {:else}
      <p class="empty">This workflow has no manifest to render.</p>
    {/if}

    <div class="generate-bar">
      {#if panel.submitError}
        <p class="submit-error mono">{panel.submitError}</p>
      {/if}
      <button
        class="generate-button"
        disabled={!panel.canSubmit}
        title={panel.canSubmit
          ? "One click is one job"
          : !app.comfyReady
            ? "ComfyUI is not connected"
            : panel.missingRequired.length > 0
              ? `${panel.missingRequired.join(", ")} required`
              : "Not ready"}
        onclick={() => panel.submit()}
      >
        Generate
      </button>
    </div>
  </section>

  {#if isFocused && focused}
    <Viewer
      bind:this={viewer}
      screen="generate"
      outputs={sessionOutputs}
      selected={focused}
      runningJob={app.runningJob}
      {following}
      onselect={(output) => {
        selectedId = output.id;
        following = sessionOutputs[0]?.id === output.id;
      }}
      onclose={closeFocused}
      onedit={editInGenerate}
      onrerun={rerun}
      ondelete={remove}
      onfollow={() => {
        following = true;
        selectedId = null;
      }}
    />
  {:else}
    <section class="results">
      <header class="results-head">
        <span class="label">This session</span>
        <span class="mono dim">
          {app.jobs.length} jobs · {app.activeJobs.length} active
        </span>
        <span class="spacer"></span>
        <div class="row filters">
          {#each ["all", "active", "done"] as const as option (option)}
            <button class:active={filter === option} onclick={() => (filter = option)}>
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          {/each}
        </div>
        <div class="row sizes">
          {#each sizes as entry (entry.size)}
            <button
              class:active={tileSize === entry.size}
              title={entry.title}
              aria-label={entry.title}
              onclick={() => app.setTileSize("generate", entry.size)}
            >
              <entry.icon size={14} />
            </button>
          {/each}
        </div>
        {#if selectedWorkflow}
          <a
            class="edit-workflow"
            href={`/comfy?workflow=${selectedWorkflow.id}`}
            onclick={(event) => {
              event.preventDefault();
              navigate(`/comfy?workflow=${selectedWorkflow.id}`);
            }}
          >
            Edit this workflow in ComfyUI <ExternalLink size={12} />
          </a>
        {/if}
      </header>

      {#if tileSize === "table"}
        <div class="table-wrap scroll">
          <MediaTable
            outputs={sessionOutputs}
            selectedId={focused?.id ?? null}
            onopen={open}
          />
        </div>
      {:else}
        <div class="grid scroll" class:large={tileSize === "large"}>
          {#each sessionJobs as job (job.id)}
            {#if job.status === "done"}
              {#each app.jobOutputs(job) as output (output.id)}
                <Tile
                  {output}
                  selected={focused?.id === output.id}
                  onopen={open}
                  onedit={editInGenerate}
                  onrerun={rerun}
                />
              {/each}
            {:else}
              <JobCard
                {job}
                position={job.status === "queued"
                  ? queuedJobs.findIndex((queued) => queued.id === job.id) + 1
                  : undefined}
              />
            {/if}
          {/each}
          {#if app.jobs.length === 0}
            <p class="empty grid-empty">
              Nothing generated yet. Type a prompt and press Generate.
            </p>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .generate {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .panel {
    width: var(--panel-width);
    flex: 0 0 auto;
    background: var(--panel);
    display: flex;
    flex-direction: column;
  }

  .card-wrap {
    position: relative;
    padding: 10px;
  }

  .workflow-card {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: var(--raised-2);
    border-radius: var(--radius-card);
    padding: 8px;
  }

  .thumb {
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    border-radius: var(--radius-input);
    background: var(--control);
    overflow: hidden;
  }

  .thumb img,
  .option-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .card-text {
    flex: 1;
    min-width: 0;
  }

  .card-name {
    display: block;
    font-size: 13px;
  }

  .card-meta {
    font-size: 11px;
    gap: 6px;
    margin-top: 2px;
  }

  .group {
    padding: 8px 8px 2px;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    padding: 5px 7px;
  }

  .option:hover {
    background: var(--control);
  }

  .option-thumb {
    width: 26px;
    height: 26px;
    flex: 0 0 auto;
    border-radius: var(--radius-control);
    background: var(--control);
    overflow: hidden;
  }

  .option-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 12px;
  }

  .option-keys {
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Sticky, because one click is one job (§11.2). */
  .generate-bar {
    position: sticky;
    bottom: 0;
    margin-top: auto;
    padding: 10px 12px 12px;
    background: linear-gradient(transparent, var(--panel) 30%);
  }

  .generate-button {
    width: 100%;
    height: 34px;
    font-size: 13px;
    background: var(--accent);
    color: #08191d;
  }

  .generate-button:hover:not(:disabled) {
    background: #82c6d6;
  }

  .generate-button:disabled {
    background: var(--control);
    color: var(--text-4);
  }

  .submit-error {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--error);
  }

  .results {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .results-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }

  .filters button,
  .sizes button {
    font-size: 11px;
    padding: 3px 8px;
    background: transparent;
    color: var(--text-3);
  }

  .sizes button {
    display: flex;
    padding: 4px 6px;
  }

  .filters button.active,
  .sizes button.active {
    background: var(--control-selected);
    color: var(--text);
  }

  .edit-workflow {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--text-3);
    background: var(--raised-2);
    padding: 4px 8px;
    border-radius: var(--radius-input);
  }

  .edit-workflow:hover {
    color: var(--text);
  }

  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 0 12px 12px;
    align-content: start;
  }

  .grid.large {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .grid-empty {
    grid-column: 1 / -1;
  }

  .table-wrap {
    flex: 1;
    padding: 0 12px 12px;
  }
</style>
