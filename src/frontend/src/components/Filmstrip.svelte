<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import type { Job, Output } from "../types.ts";
  import { app } from "../stores/app.svelte.ts";
  import { queuePosition } from "../lib/queue.ts";

  /**
   * The filmstrip along the bottom of a viewer (§11.2): it walks the same
   * ordered set the grid was showing, the jobs still in flight keep their
   * progress treatment at the head of it, and it collapses to a one-line
   * count bar.
   */
  interface Props {
    outputs: Output[];
    selectedId: string | null;
    collapsed: boolean;
    /**
     * What has not landed yet, newest first — the running job and the queue
     * behind it, as the grid shows them. It used to be the running job
     * alone, so queueing five more while the viewer was open looked like
     * queueing nothing.
     */
    activeJobs?: Job[];
    oncollapse: (collapsed: boolean) => void;
    onselect: (output: Output) => void;
  }

  let {
    outputs,
    selectedId,
    collapsed,
    activeJobs = [],
    oncollapse,
    onselect,
  }: Props = $props();

  /** Position in the queue, which is what a queued tile has to say. */
  const queued = $derived(activeJobs.filter((job) => job.status === "queued"));

  let strip = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (collapsed || !selectedId || !strip) return;
    strip
      .querySelector(`[data-strip-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  });
</script>

{#if collapsed}
  <button class="count-bar" onclick={() => oncollapse(false)}>
    <ChevronUp size={13} />
    <span class="mono">
      {outputs.length} results{activeJobs.length > 0
        ? ` · ${activeJobs.length} in flight`
        : ""}
    </span>
  </button>
{:else}
  <div class="filmstrip">
    <div class="strip scroll" bind:this={strip}>
      {#each activeJobs as job (job.id)}
        {#if job.status === "running"}
          <div class="thumb running" title="running">
            <span class="mono pct">{Math.round(job.progress?.pct ?? 0)}%</span>
            {#if app.previews[job.id]}
              <img src={app.previews[job.id]} alt="streaming preview" />
            {/if}
          </div>
        {:else}
          {@const position = queuePosition(queued, job.id)}
          <div class="thumb queued" title={`queued · position ${position}`}>
            <span class="mono label">queued</span>
            <span class="mono position">{position}</span>
          </div>
        {/if}
      {/each}
      {#each outputs as output (output.id)}
        <button
          class="thumb"
          class:selected={output.id === selectedId}
          data-strip-id={output.id}
          title={output.prompt ?? output.id}
          onclick={() => onselect(output)}
        >
          {#if output.kind === "video"}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={output.media_url} muted preload="metadata"></video>
          {:else}
            <img src={output.media_url} alt={output.prompt ?? output.id} />
          {/if}
        </button>
      {/each}
    </div>
    <button
      class="collapse"
      title="Collapse the filmstrip"
      aria-label="Collapse the filmstrip"
      onclick={() => oncollapse(true)}
    >
      <ChevronDown size={14} />
    </button>
  </div>
{/if}

<style>
  .filmstrip {
    flex: 0 0 auto;
    height: 84px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px;
    background: var(--app);
  }

  .strip {
    flex: 1;
    /* It scrolls; it does not push its container wider than the screen. */
    min-width: 0;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    height: 100%;
  }

  .thumb {
    all: unset;
    /*
     * `all: unset` takes `box-sizing` back to its initial `content-box`,
     * overriding the global `border-box` — so the running tile, the only one
     * with a border, measured 70px in a 68px strip and had its bottom two
     * pixels, dashes and all, clipped by the strip's `overflow-y: hidden`.
     */
    box-sizing: border-box;
    position: relative;
    flex: 0 0 auto;
    width: 68px;
    height: 68px;
    border-radius: var(--radius-control);
    overflow: hidden;
    background: var(--raised);
    cursor: pointer;
  }

  .thumb.selected {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .thumb.running {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--running);
    cursor: default;
  }

  /* Dashed, like the queued card on the grid: nothing has been made yet. */
  .thumb.queued {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: transparent;
    border: 1px dashed var(--line-2);
    color: var(--text-4);
    cursor: default;
  }

  .thumb.queued .label {
    font-size: 10px;
  }

  .thumb.queued .position {
    font-size: 13px;
    color: var(--text-3);
  }

  .thumb img,
  .thumb video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* A preview frame is tiny; show all of it rather than a crop of it. */
  .thumb.running img {
    object-fit: contain;
  }

  .pct {
    position: absolute;
    font-size: 11px;
    color: var(--running);
    z-index: 1;
  }

  .collapse {
    background: transparent;
    color: var(--text-4);
    padding: 4px;
  }

  .collapse:hover {
    background: var(--raised);
    color: var(--text);
  }

  .count-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 24px;
    width: 100%;
    border-radius: 0;
    background: var(--app);
    color: var(--text-4);
    font-size: 11px;
  }

  .count-bar:hover {
    color: var(--text-2);
    background: var(--raised);
  }
</style>
