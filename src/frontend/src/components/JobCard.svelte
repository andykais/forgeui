<script lang="ts">
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { panel } from "../stores/panel.svelte.ts";
  import type { Job } from "../types.ts";
  import { clock } from "../lib/format.ts";

  /**
   * A job that has no output yet: running (percent, ETA, node, step counter
   * over the streaming preview), queued (a dashed placeholder with its own
   * cancel — the strip does not cancel individual queued jobs), or failed
   * (the error inline with Retry, Reuse parameters and Copy error) — §11.2.
   */
  interface Props {
    job: Job;
    position?: number;
  }

  let { job, position }: Props = $props();

  const preview = $derived(app.previews[job.id] ?? null);
  const progress = $derived(job.progress);
  const seed = $derived(typeof job.params.seed === "number" ? job.params.seed : null);

  async function retry() {
    await api.rerun({ job_id: job.id });
  }

  async function editInGenerate() {
    if (job.workflow_id) await panel.editWith(job.workflow_id, job.params);
  }

  function copyError() {
    navigator.clipboard?.writeText(JSON.stringify(job.error, null, 2));
  }
</script>

{#if job.status === "running"}
  <div class="card running">
    {#if preview}
      <img class="preview" src={preview} alt="streaming preview" />
    {/if}
    <div class="head row">
      <span class="badge running">Running</span>
      <span class="dim">{preview ? "streaming preview" : "waiting for preview"}</span>
    </div>
    <div class="foot">
      <!--
        The node over the numbers rather than between them: squeezed between
        the percent and the ETA it had forty pixels of a small tile, which is
        room for "node…" and nothing else.
      -->
      <div class="node">
        <div class="mono node-label">{progress?.node_label ?? ""}</div>
        <div class="mono dim">
          {#if progress && progress.max > 0}
            step {progress.step}/{progress.max} ·
          {/if}
          node {progress?.node_index ?? 0} of {progress?.node_total ?? 0}
        </div>
      </div>
      <div class="numbers row">
        <span class="pct mono">{Math.round(progress?.pct ?? 0)}<small>%</small></span>
        <span class="spacer"></span>
        <div class="eta">
          <div class="mono">{clock(progress?.eta_ms)}</div>
          <div class="label">eta</div>
        </div>
      </div>
      <div class="bar">
        <span class="fill" style:width={`${progress?.pct ?? 0}%`}></span>
      </div>
    </div>
  </div>
{:else if job.status === "queued"}
  <div class="card queued">
    <span class="label">Queued</span>
    <!--
      One fact per line, each on one line. As a sentence it wrapped wherever
      a tile a third of half a screen wide ran out, so no two cards broke it
      in the same place — and at the body's 13px beside an 11px label.
    -->
    <div class="details mono dim">
      {#if position !== undefined}<span>position {position}</span>{/if}
      {#if seed !== null && seed >= 0}
        <span title={`seed ${seed}`}>seed {seed}</span>
      {:else}
        <span>random seed</span>
      {/if}
    </div>
    <button onclick={() => api.cancelJob(job.id)}>Cancel</button>
  </div>
{:else if job.status === "failed"}
  <div class="card failed">
    <div class="head row">
      <span class="badge error">Failed</span>
      <span class="mono dim">
        {#if job.error?.node_id}node {job.error.node_id}{/if}
        {#if job.error?.node_type}· {job.error.node_type}{/if}
      </span>
    </div>
    <pre class="mono error-text">{job.error?.message ?? "unknown error"}</pre>
    <div class="row actions">
      <button class="retry" onclick={retry}>Retry</button>
      <button onclick={editInGenerate}>Reuse parameters →</button>
      <button onclick={copyError}>Copy error</button>
    </div>
  </div>
{:else if job.status === "cancelled"}
  <div class="card queued cancelled">
    <span class="label">Cancelled</span>
    <div class="details mono dim"><span>nothing was written</span></div>
    <button onclick={retry}>Run again ⟳</button>
  </div>
{/if}

<style>
  .card {
    position: relative;
    aspect-ratio: 1;
    border-radius: var(--radius-input);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--raised);
  }

  /*
   * A running card is one tile like every other, so the grid keeps its rhythm
   * while a job is in flight (§11.2). That leaves the numbers a square to fit
   * into rather than a 2:1 strip, which is what the sizes below are for.
   */
  .card.running {
    background: var(--canvas);
  }

  .preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /*
     * Fit, not fill. A preview frame is a handful of pixels to begin with —
     * cropping it to the card's square and scaling what is left only makes it
     * harder to read, which is the one thing it is there for.
     */
    object-fit: contain;
    opacity: 0.75;
  }

  .head {
    position: relative;
    padding: 8px;
    font-size: 11px;
    /* One tile wide, the caption is the first thing with no room; clip it
       rather than let it wrap the badge onto a second line. */
    overflow: hidden;
  }

  .head .dim {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The preview frame behind this can be any colour, so scrim the text. */
  .card.running .head {
    background: linear-gradient(rgb(13 13 13 / 72%), transparent);
  }

  .foot {
    position: relative;
    margin-top: auto;
    padding: 8px;
    background: linear-gradient(transparent, rgb(13 13 13 / 78%) 40%);
  }

  .numbers {
    align-items: flex-end;
    gap: 8px;
  }

  .pct {
    font-size: 22px;
    line-height: 1;
    color: var(--text);
  }

  .pct small {
    font-size: 11px;
    color: var(--text-3);
  }

  /* The node name is the one part with no length to it; it is the part
     that gives way when the tile is narrow. */
  .node {
    min-width: 0;
    margin-bottom: 6px;
  }

  .node-label {
    color: var(--running);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node div,
  .eta div {
    font-size: 10px;
    white-space: nowrap;
  }

  .node .dim {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .eta {
    text-align: right;
    flex: none;
  }

  .eta .mono {
    font-size: 13px;
  }

  .bar {
    margin-top: 8px;
    height: 4px;
    border-radius: 2px;
    background: var(--control);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--running);
    transition: width 140ms linear;
  }

  /* Dashed borders survive in exactly two places; this is one (§11.5). */
  .card.queued {
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: transparent;
    border: 1px dashed var(--line-2);
  }

  .details {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    max-width: 100%;
    padding: 0 8px;
    font-size: 11px;
  }

  .details span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card.queued button {
    font-size: 11px;
    padding: 3px 8px;
  }

  .card.failed {
    background: #1d1717;
    padding: 0 0 8px;
    gap: 6px;
  }

  .error-text {
    margin: 0 8px;
    padding: 8px;
    background: var(--canvas);
    border-radius: var(--radius-control);
    color: var(--error);
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow: auto;
    flex: 1;
  }

  .actions {
    padding: 0 8px;
    flex-wrap: wrap;
    gap: 6px;
  }

  .actions button {
    font-size: 11px;
    padding: 3px 8px;
  }

  .retry {
    background: #55302c;
    color: #ffd9d4;
  }

  .cancelled {
    border-style: dashed;
  }
</style>
