<script lang="ts">
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import X from "@lucide/svelte/icons/x";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import { app } from "../stores/app.svelte.ts";
  import { api } from "../api.ts";
  import { clock, vram } from "../lib/format.ts";

  /**
   * The persistent queue strip (§11.1): one detailed chip for the running
   * job, one collapsed count chip per workflow for the queued ones, and
   * connection plus VRAM at the right. Queue state lives only here. The strip
   * offers Clear queue and cancelling the running job; cancelling an
   * individual queued job is done from its placeholder on Generate. It has an
   * idle form rather than disappearing, and collapses to a 6px bar. While
   * ComfyUI is starting it says so, and when it is disconnected or failed the
   * strip is not shown at all (§11.3).
   */
  let collapsed = $state(false);

  const comfy = $derived(app.comfy);
  const running = $derived(app.runningJob);
  const queued = $derived(app.activeJobs.filter((job) => job.status === "queued"));
  const hidden = $derived(
    comfy === null || comfy.state === "disconnected" || comfy.state === "failed",
  );
  const starting = $derived(comfy?.state === "starting");

  const queuedByWorkflow = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const job of queued) {
      const name = app.workflow(job.workflow_id)?.name ?? job.workflow_id ?? "unknown";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()];
  });

  const runningName = $derived(
    running ? (app.workflow(running.workflow_id)?.name ?? running.workflow_id) : null,
  );
</script>

{#if !hidden}
  {#if collapsed}
    <button
      class="collapsed-bar"
      title="Show the queue"
      aria-label="Show the queue"
      onclick={() => (collapsed = false)}
    >
      {#if running}
        <span class="collapsed-fill" style:width={`${running.progress?.pct ?? 0}%`}
        ></span>
      {/if}
    </button>
  {:else}
    <footer class="strip">
      <span class="label queue-label">Queue</span>

      {#if starting}
        <span class="starting row">
          <LoaderCircle size={13} class="spin" />
          ComfyUI starting…
        </span>
      {:else if running}
        <div class="chip running-chip" title={runningName ?? ""}>
          <span class="name">{runningName}</span>
          <span class="bar">
            <span class="fill" style:width={`${running.progress?.pct ?? 0}%`}></span>
          </span>
          <span class="pct mono">{Math.round(running.progress?.pct ?? 0)}%</span>
          <span class="eta mono dim">{clock(running.progress?.eta_ms)}</span>
          <button
            class="cancel"
            title="Cancel the running job"
            aria-label="Cancel the running job"
            onclick={() => api.cancelJob(running.id)}
          >
            <X size={12} />
          </button>
        </div>
        {#each queuedByWorkflow as [name, count] (name)}
          <span class="chip queued-chip mono">{name} queued ×{count}</span>
        {/each}
      {:else}
        <span class="idle dim">idle — nothing running</span>
      {/if}

      <span class="spacer"></span>

      {#if queued.length > 0}
        <button class="clear" onclick={() => api.clearQueue()}>Clear queue</button>
      {/if}
      <span class="status row">
        <span class="dot" class:ok={comfy?.state === "running"}></span>
        <span class="mono dim">
          {comfy?.state === "running" ? "ComfyUI connected" : `ComfyUI ${comfy?.state}`}
          {#if comfy?.vram_free}
            · {vram(comfy.vram_free, comfy.vram_total)}
          {/if}
        </span>
      </span>
      <button
        class="collapse"
        title="Collapse the queue strip"
        aria-label="Collapse the queue strip"
        onclick={() => (collapsed = true)}
      >
        <ChevronDown size={14} />
      </button>
    </footer>
  {/if}
{:else if comfy}
  <!-- Disconnected or failed: the strip is gone, so say where to look. -->
  <footer class="strip failed">
    <span class="label queue-label">Queue</span>
    <span class="mono" style:color="var(--error)">
      ComfyUI {comfy.state}{comfy.error ? ` — ${comfy.error}` : ""}
    </span>
    <span class="spacer"></span>
    <a href="/settings" class="mono">Settings</a>
    <ChevronUp size={14} class="hidden-icon" />
  </footer>
{/if}

<style>
  .strip {
    height: var(--queue-height);
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    background: var(--app);
    border-top: 1px solid var(--line);
  }

  .strip.failed {
    background: #1c1616;
  }

  .queue-label {
    width: 44px;
    flex: 0 0 auto;
  }

  .collapsed-bar {
    height: var(--queue-height-collapsed);
    flex: 0 0 auto;
    width: 100%;
    padding: 0;
    border-radius: 0;
    background: var(--app);
    position: relative;
  }

  .collapsed-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--running);
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 22px;
    padding: 0 4px 0 8px;
    border-radius: var(--radius-control);
    background: var(--raised-2);
  }

  .running-chip {
    min-width: 240px;
  }

  .name {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 130px;
  }

  .bar {
    flex: 1;
    height: 3px;
    min-width: 40px;
    border-radius: 2px;
    background: var(--control);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--running);
    transition: width 120ms linear;
  }

  .pct,
  .eta {
    font-size: 11px;
  }

  .pct {
    color: var(--running);
  }

  /* Queued count chips are non-interactive (MOCK-REVISIONS §1). */
  .queued-chip {
    font-size: 11px;
    color: var(--text-3);
    pointer-events: none;
  }

  .idle,
  .starting {
    font-size: 12px;
  }

  .starting {
    color: var(--running);
  }

  .cancel,
  .collapse {
    background: transparent;
    padding: 2px;
    color: var(--text-4);
    display: flex;
  }

  .cancel:hover,
  .collapse:hover {
    background: var(--control);
    color: var(--text);
  }

  .clear {
    font-size: 12px;
    background: transparent;
    color: var(--text-3);
  }

  .status {
    font-size: 11px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-4);
  }

  .dot.ok {
    background: var(--ok);
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }

  :global(.hidden-icon) {
    visibility: hidden;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
