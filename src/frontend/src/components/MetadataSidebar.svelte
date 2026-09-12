<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ImageUpscale from "@lucide/svelte/icons/image-upscale";
  import Plus from "@lucide/svelte/icons/plus";
  import type { OutputDetail } from "../types.ts";
  import { absoluteTime, duration, relativeTime } from "../lib/format.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate } from "../router.svelte.ts";
  import { api } from "../api.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import { panel } from "../stores/panel.svelte.ts";
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
    /**
     * Upscale this output with the named workflow (§10). Absent hides the
     * action, which is what a screen with nowhere to land does.
     */
    onupscale?: (workflowId: string) => void;
  }

  let { output, onedit, onrerun, ondelete, onupscale }: Props = $props();

  let copied = $state<string | null>(null);
  let promoteOpen = $state(false);
  let upscaleOpen = $state(false);

  /**
   * Upscale is the same-family `category: upscale` workflow (§10). One match
   * runs outright, several offer the choice, none hides the button: an
   * action with nowhere to go is worse than no action.
   */
  const upscalers = $derived(onupscale ? app.upscalersFor(output) : []);
  let promoting = $state(false);
  let checked = $state<Record<string, boolean>>({});
  const sidecar = $derived(output.sidecar);
  /**
   * A model row is a link to its page once the model has been hashed, and
   * shift-click filters the grid to it instead (§11.2). Before hashing there
   * is only a name, so the row is plain text.
   */
  const models = $derived.by(() => {
    // `output_models` is keyed by role, and a job with three LoRAs has three
    // rows under the one `lora` role, so looking a hash up by role handed
    // every LoRA the first of those three: the right number of rows, all
    // wearing one name. A filename identifies a file where a role cannot,
    // so the library resolves it, the sidecar's own hash is the fallback,
    // and the role is trusted only where it names a single model.
    const byRole = new Map<string, string[]>();
    for (const link of output.models) {
      byRole.set(link.role, [...(byRole.get(link.role) ?? []), link.model_hash]);
    }
    return (sidecar?.models ?? []).map((model) => {
      const known = app.modelByName(model.name);
      const sole = byRole.get(model.role);
      const hash = known?.hash ?? model.hash ??
        (sole?.length === 1 ? sole[0]! : null);
      return {
        role: model.role,
        name: model.name,
        hash,
        label: known?.display_name ?? (hash ? app.modelName(hash) : model.name),
      };
    });
  });

  /**
   * Save as sample (§8.3): the models popover, restricted to the models
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
        `Saved as ${samples.length} sample${samples.length === 1 ? "" : "s"}`,
      );
      promoteOpen = false;
      checked = {};
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not save it");
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
    const known = app.modelByName(name);
    const hash = known?.hash ?? hashOfName.get(name) ?? null;
    return {
      name,
      hash,
      label: known?.display_name ?? (hash ? app.modelName(hash) : name),
    };
  }

  /** A LoRA row as the panel wrote it: a name and one or two strengths. */
  function loraOf(entry: unknown) {
    const row = entry as Record<string, unknown>;
    const model = typeof row.strength_model === "number" ? row.strength_model : 1;
    const clip = typeof row.strength_clip === "number" ? row.strength_clip : model;
    return {
      ...linkTo(String(row.name)),
      name: String(row.name),
      strength_model: model,
      strength_clip: clip,
      strength: model === clip ? `${model}` : `${model} / ${clip}`,
    };
  }

  /**
   * The workflow open in the param panel, when it takes LoRAs at all. What
   * makes a LoRA usable is the strength somebody found for it, and that
   * number is sitting right here in the run that used it — so it can be put
   * into the panel as it stands rather than read off and typed back in.
   */
  const loraTarget = $derived(
    panel.manifest && panel.loraParam
      ? { name: panel.detail?.name ?? panel.manifest.name }
      : null,
  );

  function applyLora(lora: ReturnType<typeof loraOf>) {
    const what = panel.addLora({
      name: lora.name,
      strength_model: lora.strength_model,
      strength_clip: lora.strength_clip,
    });
    if (what === null) return;
    toasts.message(
      `${what === "added" ? "Added" : "Set"} ${lora.label} at ${lora.strength}` +
        ` in ${loraTarget?.name ?? "the panel"}`,
    );
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
    <button class="primary" onclick={onedit}>Reuse parameters →</button>
    <button onclick={onrerun}>Generate again ⟳</button>
    {#if upscalers.length === 1}
      <button title={`Upscale with ${upscalers[0]!.name}`} onclick={() => onupscale?.(upscalers[0]!.id)}>
        <ImageUpscale size={12} /> Upscale
      </button>
    {:else if upscalers.length > 1}
      <div class="chip-wrap">
        <button title="Upscale with…" onclick={() => (upscaleOpen = !upscaleOpen)}>
          <ImageUpscale size={12} /> Upscale
        </button>
        <Popover
          open={upscaleOpen}
          width={240}
          title="Upscale with"
          onclose={() => (upscaleOpen = false)}
        >
          {#each upscalers as workflow (workflow.id)}
            <button
              class="option"
              onclick={() => {
                upscaleOpen = false;
                onupscale?.(workflow.id);
              }}
            >
              <span class="option-name">{workflow.name}</span>
            </button>
          {/each}
        </Popover>
      </div>
    {/if}
    {#if promotable.length > 0}
      <div class="chip-wrap">
        <button onclick={() => (promoteOpen = !promoteOpen)}>Save as sample</button>
        <Popover
          open={promoteOpen}
          width={240}
          title="Save as sample"
          onclose={() => (promoteOpen = false)}
        >
          <!-- Hash and role together: one file can fill two roles in a graph,
               and two rows keyed on the hash alone would be one key twice. -->
          {#each promotable as model (`${model.hash}:${model.role}`)}
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
            {promoting ? "Saving…" : "Save"}
          </button>
        </Popover>
      </div>
    {/if}
    <button class="danger" onclick={ondelete}>Delete</button>
  </div>

  <!--
    Rows, not a description list. Two reasons, and they point the same way.
    The label sat in a 74px column that took a fifth of a 306px sidebar away
    from the value, which is the part worth reading; it goes above instead,
    and the value gets the whole width. And Firefox's plain-text serialiser
    indents the contents of a `dd` by four spaces — every line, blank ones
    included — whenever the selection spans the element, which is what a
    drag across the sidebar does, so a copied prompt came back indented.
  -->
  <section>
    <div class="label">Params</div>
    <div class="rows">
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

      <div class="field">
        <div class="key">created</div>
        <div class="mono">
          {absoluteTime(output.created_at)}
          <span class="dim">· {relativeTime(output.created_at)}</span>
        </div>
      </div>
      <div class="field">
        <div class="key">duration</div>
        <div class="mono">
          {duration(output.generation_ms ?? sidecar?.timing.total_ms ?? null)}
        </div>
      </div>
      <div class="field">
        <div class="key">workflow</div>
        <div>
          {sidecar?.workflow?.name ?? output.workflow_id ?? "—"}
          {#if output.workflow_hash}
            <span class="dim mono">· {output.workflow_hash.slice(7, 13)}</span>
          {/if}
        </div>
      </div>

      <!-- Only the roles no param already names; the rest appear once, below. -->
      {#each otherModels as model (model.role + model.name)}
        <div class="field">
          <div class="key">{model.role}</div>
          <div class="mono">{@render modelLink(model)}</div>
        </div>
      {/each}

      {#each params as [key, value] (key)}
        <div class="field">
          <div class="key">{key}</div>
          {#if isLoraList(value)}
            <div class="loras">
              {#each value as Record<string, unknown>[] as entry (entry.name)}
                {@const lora = loraOf(entry)}
                <span class="lora">
                  <span class="lora-name mono">{@render modelLink(lora)}</span>
                  <span class="lora-strength mono dim">{lora.strength}</span>
                  {#if loraTarget}
                    <button
                      class="apply"
                      title={`Add this LoRA at ${lora.strength} to ${loraTarget.name}`}
                      aria-label={`Add ${lora.label} at ${lora.strength} to ${loraTarget.name}`}
                      onclick={() => applyLora(lora)}
                    >
                      <Plus size={12} />
                    </button>
                  {/if}
                </span>
              {/each}
            </div>
          {:else if typeof value === "string" && hashOfName.has(value)}
            <div class="mono">{@render modelLink(linkTo(value))}</div>
          {:else}
            <div
              class="mono value"
              class:selectable={selectable(key)}
            >{render(value)}</div>
          {/if}
        </div>
      {/each}
    </div>
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

  .option {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 7px;
    font-size: 12px;
  }

  .option:hover {
    background: var(--control);
  }

  .option .mark {
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

  .rows {
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
  /*
   * Not `.row`: that is a global utility meaning a flex row, and it laid the
   * label and the value side by side again.
   */
  .field {
    background: var(--raised);
    border-radius: var(--radius-control);
    padding: 3px 7px 5px;
    min-width: 0;
  }

  /* Above its value, not beside it: the value is what is worth the width. */
  .key {
    color: var(--text-4);
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .field > :not(.key) {
    color: var(--text-2);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .value {
    white-space: pre-wrap;
  }

  /* One click takes the whole value, which is the point of showing it. */
  .selectable {
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

  /* Dim rather than hidden: an offer nobody can see is not an offer, and
     three of them at full strength would shout over the names beside them. */
  .apply {
    display: flex;
    flex: 0 0 auto;
    background: transparent;
    padding: 1px;
    color: var(--text-4);
    opacity: 0.4;
  }

  .lora:hover .apply,
  .apply:focus-visible {
    opacity: 1;
  }

  .apply:hover {
    background: var(--control);
    color: var(--text);
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
