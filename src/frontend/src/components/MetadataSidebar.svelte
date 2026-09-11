<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import type { OutputDetail } from "../types.ts";
  import { absoluteTime, duration, relativeTime } from "../lib/format.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate } from "../router.svelte.ts";
  import { api } from "../api.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import Popover from "./Popover.svelte";

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
  let promoteOpen = $state(false);
  let promoting = $state(false);
  let checked = $state<Record<string, boolean>>({});
  const sidecar = $derived(output.sidecar);
  /**
   * A model row is a link to its page once the model has been hashed, and
   * shift-click filters the grid to it instead (§11.2). Before hashing there
   * is only a name, so the row is plain text.
   */
  const models = $derived(
    (sidecar?.models ?? []).map((model) => {
      const hash =
        output.models.find((link) => link.role === model.role)?.model_hash ?? null;
      return {
        role: model.role,
        name: model.name,
        hash,
        label: hash ? app.modelName(hash) : model.name,
      };
    }),
  );

  /**
   * Promote to sample (§8.3): the models popover, restricted to the models
   * this output actually used, each checkable, with a confirm
   * (MOCK-REVISIONS §13).
   */
  const promotable = $derived(models.filter((model) => model.hash !== null));

  async function promote() {
    const hashes = promotable.map((model) => model.hash!).filter((hash) => checked[hash]);
    if (hashes.length === 0) return;
    promoting = true;
    try {
      const { samples } = await api.promote(output.id, hashes);
      toasts.message(
        `Promoted to ${samples.length} sample${samples.length === 1 ? "" : "s"}`,
      );
      promoteOpen = false;
      checked = {};
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not promote it");
    } finally {
      promoting = false;
    }
  }

  function openModel(event: MouseEvent, hash: string) {
    event.preventDefault();
    // Shift-click filters the grid rather than leaving it (§11.2).
    navigate(event.shiftKey ? `/gallery?models=${hash}` : `/models/${hash}`);
  }
  /** Absolute paths, as FILES shows them. */
  const dataDir = $derived(app.dataDir);

  function copy(path: string) {
    navigator.clipboard?.writeText(path);
    copied = path;
    setTimeout(() => (copied = copied === path ? null : copied), 1200);
  }

  const params = $derived(
    Object.entries(sidecar?.params ?? output.params).filter(
      ([, value]) =>
        value !== null && value !== "" && !(Array.isArray(value) && value.length === 0),
    ),
  );

  /** The hash the sidecar recorded for a model filename, if it has one. */
  const hashOfName = $derived(new Map(models.map((model) => [model.name, model.hash])));

  function linkTo(name: string) {
    const hash = hashOfName.get(name) ?? null;
    return { name, hash, label: hash ? app.modelName(hash) : name };
  }

  /** A LoRA row as the panel wrote it: a name and one or two strengths. */
  function loraOf(entry: unknown) {
    const row = entry as Record<string, unknown>;
    const model = row.strength_model;
    const clip = row.strength_clip;
    return {
      ...linkTo(String(row.name)),
      strength: model === clip ? `${model}` : `${model} / ${clip}`,
    };
  }

  function isLoraList(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).name === "string",
      )
    );
  }

  /**
   * Every model filename a param already shows. The roles above the params
   * named the same files a second time — the same LoRA as a `lora` row and
   * again inside `loras` — so a role is only listed when no param carries it.
   */
  const namedByParams = $derived.by(() => {
    const names = new Set<string>();
    for (const [, value] of params) {
      if (typeof value === "string") names.add(value);
      else if (isLoraList(value)) {
        for (const entry of value as Record<string, unknown>[]) {
          names.add(String(entry.name));
        }
      }
    }
    return names;
  });

  const otherModels = $derived(models.filter((model) => !namedByParams.has(model.name)));

  /** The prompt and the seed are what people copy out of here (§11.2). */
  function selectable(key: string): boolean {
    return key === "seed" || key.includes("prompt");
  }

  function render(value: unknown): string {
    if (Array.isArray(value)) {
      if (value.length === 2 && value.every((entry) => typeof entry === "number")) {
        return `${value[0]} × ${value[1]}`;
      }
      return value.map((entry) => render(entry)).join(", ");
    }
    if (value && typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
</script>

<aside class="sidebar scroll">
  <div class="actions">
    <button class="primary" onclick={onedit}>Edit in Generate →</button>
    <button onclick={onrerun}>Rerun now ⟳</button>
    {#if promotable.length > 0}
      <div class="chip-wrap">
        <button onclick={() => (promoteOpen = !promoteOpen)}>Promote to sample</button>
        <Popover
          open={promoteOpen}
          width={240}
          title="Promote to sample"
          onclose={() => (promoteOpen = false)}
        >
          {#each promotable as model (model.hash)}
            <button
              class="option check"
              onclick={() =>
                (checked = { ...checked, [model.hash!]: !checked[model.hash!] })}
            >
              <span class="mark mono">{checked[model.hash!] ? "✓" : ""}</span>
              <span class="option-name">{model.label}</span>
              <span class="mono dim">{model.role}</span>
            </button>
          {/each}
          <button
            class="confirm"
            disabled={promoting || promotable.every((model) => !checked[model.hash!])}
            onclick={promote}
          >
            {promoting ? "Promoting…" : "Promote"}
          </button>
        </Popover>
      </div>
    {/if}
    <button class="danger" onclick={ondelete}>Delete</button>
  </div>

  <section>
    <div class="label">Params</div>
    <dl>
      {#snippet modelLink(link: { name: string; label: string; hash: string | null })}
        {#if link.hash}
          <a
            class="model-link"
            href={`/models/${link.hash}`}
            title="Open the model page · shift-click to filter the grid"
            onclick={(event) => openModel(event, link.hash!)}
          >
            {link.label}
          </a>
        {:else}
          {link.label}
        {/if}
      {/snippet}

      <div class="row">
        <dt>created</dt>
        <dd class="mono">
          {absoluteTime(output.created_at)}
          <span class="dim">· {relativeTime(output.created_at)}</span>
        </dd>
      </div>
      <div class="row">
        <dt>duration</dt>
        <dd class="mono">
          {duration(output.generation_ms ?? sidecar?.timing.total_ms ?? null)}
        </dd>
      </div>
      <div class="row">
        <dt>workflow</dt>
        <dd>
          {sidecar?.workflow?.name ?? output.workflow_id ?? "—"}
          {#if output.workflow_hash}
            <span class="dim mono">· {output.workflow_hash.slice(7, 13)}</span>
          {/if}
        </dd>
      </div>

      <!-- Only the roles no param already names; the rest appear once, below. -->
      {#each otherModels as model (model.role + model.name)}
        <div class="row">
          <dt>{model.role}</dt>
          <dd class="mono">{@render modelLink(model)}</dd>
        </div>
      {/each}

      {#each params as [key, value] (key)}
        <div class="row">
          <dt>{key}</dt>
          {#if isLoraList(value)}
            <dd class="loras">
              {#each value as Record<string, unknown>[] as entry (entry.name)}
                {@const lora = loraOf(entry)}
                <span class="lora">
                  <span class="lora-name mono">{@render modelLink(lora)}</span>
                  <span class="lora-strength mono dim">{lora.strength}</span>
                </span>
              {/each}
            </dd>
          {:else if typeof value === "string" && hashOfName.has(value)}
            <dd class="mono">{@render modelLink(linkTo(value))}</dd>
          {:else}
            <dd class="mono value" class:selectable={selectable(key)}>
              {render(value)}
            </dd>
          {/if}
        </div>
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
  .chip-wrap {
    position: relative;
  }

  .option.check {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 7px;
    font-size: 12px;
  }

  .option.check:hover {
    background: var(--control);
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

  .confirm {
    margin: 6px 7px 2px;
    width: calc(100% - 14px);
    background: var(--accent);
    color: #08191d;
    font-size: 12px;
  }

  .confirm:disabled {
    background: var(--control);
    color: var(--text-4);
  }

  .model-link {
    color: var(--accent);
  }

  .model-link:hover {
    text-decoration: underline;
  }

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
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0 0;
    font-size: 12px;
  }

  /*
   * One plate per param, the same ground the inputs on the left sit on, so
   * where a long prompt ends and the next param begins is a line you can see
   * rather than one you have to work out.
   */
  .row {
    display: grid;
    grid-template-columns: 74px 1fr;
    gap: 8px;
    background: var(--raised);
    border-radius: var(--radius-control);
    padding: 4px 7px;
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
    min-width: 0;
  }

  dd.value {
    white-space: pre-wrap;
  }

  /* One click takes the whole value, which is the point of showing it. */
  dd.selectable {
    user-select: all;
  }

  .loras {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .lora {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .lora-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lora-strength {
    flex: 0 0 auto;
    font-size: 11px;
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
