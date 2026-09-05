<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import type { OutputDetail } from "../types.ts";
  import { absoluteTime, duration, relativeTime } from "../lib/format.ts";
  import { app } from "../stores/app.svelte.ts";

  /**
   * The metadata sidebar (§11.2), in its stated order: actions, created,
   * duration, params, FILES. Inputs and lineage are Phase 3 and Phase 4 and
   * appear when there is something to show.
   */
  interface Props {
    output: OutputDetail;
    onedit: () => void;
    onrerun: () => void;
    ondelete: () => void;
  }

  let { output, onedit, onrerun, ondelete }: Props = $props();

  let copied = $state<string | null>(null);
  const sidecar = $derived(output.sidecar);
  const models = $derived(sidecar?.models ?? []);
  /** Absolute paths, as FILES shows them. */
  const dataDir = $derived(app.dataDir);

  function copy(path: string) {
    navigator.clipboard?.writeText(path);
    copied = path;
    setTimeout(() => (copied = copied === path ? null : copied), 1200);
  }

  function paramRows(): [string, unknown][] {
    const params = sidecar?.params ?? output.params;
    return Object.entries(params).filter(
      ([, value]) =>
        value !== null && value !== "" && !(Array.isArray(value) && value.length === 0),
    );
  }

  function render(value: unknown): string {
    if (Array.isArray(value)) {
      if (value.length === 2 && value.every((entry) => typeof entry === "number")) {
        return `${value[0]} × ${value[1]}`;
      }
      return value.map((entry) => render(entry)).join(", ");
    }
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (typeof row.name === "string") {
        const model = row.strength_model;
        const clip = row.strength_clip;
        const strengths = model === clip ? `${model}` : `${model} / ${clip}`;
        return `${row.name} — ${strengths}`;
      }
      return JSON.stringify(value);
    }
    return String(value);
  }
</script>

<aside class="sidebar scroll">
  <div class="actions">
    <button class="primary" onclick={onedit}>Edit in Generate →</button>
    <button onclick={onrerun}>Rerun now ⟳</button>
    <button class="danger" onclick={ondelete}>Delete</button>
  </div>

  <section>
    <div class="label">Params</div>
    <dl>
      <dt>created</dt>
      <dd class="mono">
        {absoluteTime(output.created_at)}
        <span class="dim">· {relativeTime(output.created_at)}</span>
      </dd>
      <dt>duration</dt>
      <dd class="mono">
        {duration(output.generation_ms ?? sidecar?.timing.total_ms ?? null)}
      </dd>
      <dt>workflow</dt>
      <dd>
        {sidecar?.workflow?.name ?? output.workflow_id ?? "—"}
        {#if output.workflow_hash}
          <span class="dim mono">· {output.workflow_hash.slice(7, 13)}</span>
        {/if}
      </dd>
      {#each models as model (model.role + model.name)}
        <dt>{model.role}</dt>
        <dd class="mono">{model.name}</dd>
      {/each}
      {#each paramRows() as [key, value] (key)}
        <dt>{key}</dt>
        <dd class="mono value">{render(value)}</dd>
      {/each}
    </dl>
  </section>

  <section>
    <div class="label">Files</div>
    <button
      class="file"
      title={`${dataDir}/${output.path}`}
      onclick={() => copy(`${dataDir}/${output.path}`)}
    >
      <span class="kind mono dim">{output.path.split(".").pop()}</span>
      <span class="path mono">{dataDir}/{output.path}</span>
      {#if copied === `${dataDir}/${output.path}`}
        <Check size={12} />
      {:else}
        <span class="copy dim">copy</span>
      {/if}
    </button>
    <button
      class="file"
      title={`${dataDir}/${output.sidecar_path}`}
      onclick={() => copy(`${dataDir}/${output.sidecar_path}`)}
    >
      <span class="kind mono dim">json</span>
      <span class="path mono">{dataDir}/{output.sidecar_path}</span>
      {#if copied === `${dataDir}/${output.sidecar_path}`}
        <Check size={12} />
      {:else}
        <span class="copy dim">copy</span>
      {/if}
    </button>
    {#if output.sidecar_error}
      <p class="warn mono">sidecar: {output.sidecar_error}</p>
    {/if}
  </section>
</aside>

<style>
  .sidebar {
    width: 306px;
    flex: 0 0 auto;
    background: var(--panel);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .actions button {
    font-size: 12px;
  }

  .primary {
    background: var(--accent-tint-2);
    color: var(--accent);
  }

  .danger {
    color: var(--error);
  }

  dl {
    display: grid;
    grid-template-columns: 74px 1fr;
    gap: 3px 8px;
    margin: 6px 0 0;
    font-size: 12px;
  }

  dt {
    color: var(--text-4);
    font-size: 11px;
    padding-top: 1px;
  }

  dd {
    margin: 0;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }

  dd.value {
    white-space: pre-wrap;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin-top: 4px;
    background: transparent;
    padding: 3px 4px;
    font-size: 11px;
    text-align: left;
  }

  .file:hover {
    background: var(--raised);
  }

  .kind {
    width: 30px;
    flex: 0 0 auto;
    font-size: 10px;
  }

  /* Left-truncated so the filename stays visible (§11.2). */
  .path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: ltr;
    unicode-bidi: plaintext;
    text-align: right;
  }

  .copy {
    font-size: 10px;
  }

  .warn {
    color: var(--error);
    font-size: 11px;
  }
</style>
