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
      <div class="numbers row">
        <span class="pct mono">{Math.round(progress?.pct ?? 0)}<small>%</small></span>
        <div class="node">
          <div class="mono node-label">{progress?.node_label ?? ""}</div>
          <div class="mono dim">
            {#if progress && progress.max > 0}
              step {progress.step}/{progress.max} ·
            {/if}
            node {progress?.node_index ?? 0} of {progress?.node_total ?? 0}
          </div>
        </div>
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
    <div class="mono dim">
      {#if position !== undefined}position {position} ·
      {/if}
      {#if seed !== null && seed >= 0}seed {seed}{:else}random seed{/if}
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
    <div class="mono dim">nothing was written</div>
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

  /* A running card spans two columns so the numbers stay readable (§11.2). */
  .card.running {
    grid-column: span 2;
    aspect-ratio: 2;
    background: var(--canvas);
  }

  .preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /*
     * Fit, not fill. A preview frame is a handful of pixels to begin with —
     * cropping it to the card's 2:1 and scaling what is left only makes it
     * harder to read, which is the one thing it is there for.
     */
    object-fit: contain;
    opacity: 0.75;
  }

  .head {
    position: relative;
    padding: 8px;
    font-size: 11px;
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
    gap: 10px;
  }

  .pct {
    font-size: 30px;
    line-height: 1;
    color: var(--text);
  }

  .pct small {
    font-size: 13px;
    color: var(--text-3);
  }

  .node-label {
    color: var(--running);
    font-size: 12px;
  }

  .node div,
  .eta div {
    font-size: 11px;
  }

  .eta {
    text-align: right;
  }

  .eta .mono {
    font-size: 15px;
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
