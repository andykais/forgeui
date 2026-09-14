<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, opensElsewhere } from "../router.svelte.ts";
  import type {
    LiteralInput,
    Manifest,
    Param,
    ParamType,
    WorkflowDetail,
  } from "../types.ts";
  import ParamPanel from "../components/params/ParamPanel.svelte";
  import { defaultFor } from "../stores/panel.svelte.ts";
  import { plain } from "../lib/state.svelte.ts";
  import { toasts } from "../stores/toasts.svelte.ts";

  /**
   * The manifest editor (§4.7): one table of every literal input in
   * `api.json`. Exposed rows are full-width editable, unexposed rows collapse
   * to node · input · current value, and a live panel preview sits on the
   * right. `lora_list` is not a node input at all — it is a synthetic chain
   * row and is not counted among the literal inputs.
   */
  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  let detail = $state<WorkflowDetail | null>(null);
  let inputs = $state<LiteralInput[]>([]);
  let draft = $state<Manifest | null>(null);
  let previewValues = $state<Record<string, unknown>>({});
  let saving = $state(false);
  let filter = $state("");
  let band = $state<"all" | "exposed">("all");
  let dragKey = $state<string | null>(null);

  const TYPES: ParamType[] = [
    "text",
    "int",
    "float",
    "bool",
    "enum",
    "seed",
    "size",
    "model",
    "text_encoder",
    "vae",
  ];

  $effect(() => {
    const wanted = id;
    untrack(
      () =>
        void (async () => {
          const [loaded, literals] = await Promise.all([
            api.workflow(wanted),
            api.workflowInputs(wanted),
          ]);
          detail = loaded;
          inputs = literals;
          draft = loaded.manifest ? plain(loaded.manifest) : null;
          resetPreview();
        })(),
    );
  });

  function resetPreview() {
    if (!draft) return;
    previewValues = Object.fromEntries(
      draft.params.map((param) => [param.key, defaultFor(param)]),
    );
  }

  /** The chain row is synthetic, so it never counts as a literal input. */
  const chainParam = $derived(
    draft?.params.find((param) => param.type === "lora_list") ?? null,
  );
  const exposedByBind = $derived.by(() => {
    const map = new Map<string, Param>();
    for (const param of draft?.params ?? []) {
      if (param.type === "size") {
        const bind = param.bind as { w: string; h: string };
        map.set(bind.w, param);
        map.set(bind.h, param);
      } else if (Array.isArray(param.bind)) {
        // One model pick, several loaders: each input is spoken for (§4.6).
        for (const bind of param.bind) map.set(bind, param);
      } else if (typeof param.bind === "string") {
        map.set(param.bind, param);
      }
    }
    return map;
  });

  function literalFor(param: Param): LiteralInput | null {
    const bind =
      param.type === "size"
        ? (param.bind as { w: string }).w
        : Array.isArray(param.bind)
          ? param.bind[0] ?? null
          : typeof param.bind === "string"
            ? param.bind
            : null;
    if (!bind) return null;
    const [node, ...rest] = bind.split(".");
    return (
      inputs.find((input) => input.node_id === node && input.input === rest.join(".")) ??
      null
    );
  }

  function matchesFilter(text: string): boolean {
    const needle = filter.trim().toLowerCase();
    return needle === "" || text.toLowerCase().includes(needle);
  }

  /** Exposed rows are listed in manifest order, because that is panel order. */
  const exposedRows = $derived(
    (draft?.params ?? []).filter((param) => {
      const input = literalFor(param);
      return matchesFilter(
        `${param.key} ${param.label ?? ""} ${input?.node_type ?? ""} ${input?.input ?? ""}`,
      );
    }),
  );

  const hiddenRows = $derived(
    band === "exposed"
      ? []
      : inputs.filter(
          (input) =>
            !exposedByBind.has(`${input.node_id}.${input.input}`) &&
            matchesFilter(`${input.node_id} ${input.node_type} ${input.input}`),
        ),
  );

  function typeFor(hint: string): ParamType {
    if (hint === "int" || hint === "float" || hint === "bool" || hint === "enum") {
      return hint;
    }
    return "text";
  }

  function uniqueKey(base: string): string {
    const taken = new Set(draft?.params.map((param) => param.key) ?? []);
    let key = base.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    if (!/^[a-z]/.test(key)) key = `p_${key}`;
    if (!taken.has(key)) return key;
    for (let i = 2; i < 100; i++) if (!taken.has(`${key}_${i}`)) return `${key}_${i}`;
    return `${key}_${Date.now()}`;
  }

  function expose(input: LiteralInput) {
    if (!draft) return;
    const param: Param = {
      key: uniqueKey(input.input),
      label: input.input.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      type: typeFor(input.type_hint),
      bind: `${input.node_id}.${input.input}`,
      default: input.value as never,
      advanced: true,
    };
    if (param.type === "enum") param.options = [String(input.value)];
    draft = { ...draft, params: [...draft.params, param] };
    resetPreview();
  }

  function unexpose(key: string) {
    if (!draft) return;
    draft = {
      ...draft,
      params: draft.params.filter((param) => param.key !== key),
    };
    resetPreview();
  }

  function patch(key: string, patchValue: Partial<Param>) {
    if (!draft) return;
    draft = {
      ...draft,
      params: draft.params.map((param) =>
        param.key === key ? ({ ...param, ...patchValue } as Param) : param,
      ),
    };
    resetPreview();
  }

  /** Row order is panel order (§4.7). */
  function move(key: string, targetKey: string) {
    if (!draft || key === targetKey) return;
    const params = [...draft.params];
    const from = params.findIndex((param) => param.key === key);
    const to = params.findIndex((param) => param.key === targetKey);
    if (from < 0 || to < 0) return;
    const [param] = params.splice(from, 1);
    params.splice(to, 0, param!);
    draft = { ...draft, params };
  }

  /** One advanced param per literal widget value, for a fresh import (§4.7). */
  function autoExposeAll() {
    if (!draft) return;
    let next = draft;
    for (const input of inputs) {
      const bind = `${input.node_id}.${input.input}`;
      if (exposedByBind.has(bind)) continue;
      const key = uniqueKey(input.input);
      const param: Param = {
        key,
        label: input.input.replace(/_/g, " "),
        type: typeFor(input.type_hint),
        bind,
        default: input.value as never,
        advanced: true,
      };
      if (param.type === "enum") param.options = [String(input.value)];
      next = { ...next, params: [...next.params, param] };
    }
    draft = next;
    resetPreview();
  }

  async function save() {
    if (!draft) return;
    saving = true;
    try {
      const saved = await api.saveWorkflow(id, { manifest: draft });
      detail = saved;
      draft = saved.manifest ? plain(saved.manifest) : null;
      await app.refreshWorkflows();
      toasts.message(
        saved.has_bundled
          ? "Saved as your copy; the bundled workflow is untouched"
          : "Manifest saved",
      );
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not save it");
    } finally {
      saving = false;
    }
  }
</script>

{#if !detail}
  <p class="empty">loading…</p>
{:else}
  <section class="detail">
    <header>
      <span class="thumb"></span>
      <div class="titles">
        <div class="row">
          <h1>{detail.name}</h1>
          {#if detail.family}<span class="badge accent">{detail.family}</span>{/if}
          <span class="badge">{detail.kind}</span>
        </div>
        <div class="mono dim sub">
          {detail.id} · {detail.source} · hash {detail.hash.slice(7, 13)} ·
          {Object.keys(detail.api_json).length} nodes, {inputs.length} literal inputs
        </div>
      </div>
      <span class="spacer"></span>
      <button
        onclick={() =>
          api.duplicateWorkflow(id).then((copy) => navigate(`/workflows/${copy.id}`))}
      >
        Duplicate
      </button>
      <button onclick={autoExposeAll}>Auto-expose all</button>
      <a
        class="button-link"
        href={`/comfy?workflow=${id}`}
        onclick={(event) => {
          if (opensElsewhere(event)) return;
          event.preventDefault();
          navigate(`/comfy?workflow=${id}`);
        }}
      >
        Open in ComfyUI <ExternalLink size={12} />
      </a>
      <button class="primary" disabled={saving || !draft} onclick={save}>
        Save manifest
      </button>
      {#if detail.source === "bundled"}
        <span class="dim note">saving creates a user copy</span>
      {/if}
    </header>

    <div class="body">
      <div class="inputs scroll">
        <div class="inputs-head row">
          <span class="label">Exposed inputs</span>
          <span class="mono dim">
            {draft?.params.length ?? 0} params ·
            {exposedByBind.size} of {inputs.length} literal inputs bound
            {#if chainParam}, plus the synthetic LoRA chain{/if}
          </span>
          <span class="spacer"></span>
          <div class="row bands">
            <button class:active={band === "all"} onclick={() => (band = "all")}>
              All inputs
            </button>
            <button class:active={band === "exposed"} onclick={() => (band = "exposed")}>
              Exposed only
            </button>
          </div>
          <input class="filter" placeholder="filter nodes…" bind:value={filter} />
        </div>

        <table>
          <thead>
            <tr>
              <th class="tick"></th>
              <th>Node · input</th>
              <th>Key</th>
              <th>Label</th>
              <th>Type</th>
              <th>Default</th>
              <th class="adv">Adv</th>
            </tr>
          </thead>
          <tbody>
            {#each exposedRows as param (param.key)}
              {@const input = literalFor(param)}
              <tr
                class="exposed"
                class:chain={param.type === "lora_list"}
                draggable="true"
                ondragstart={() => (dragKey = param.key)}
                ondragover={(event) => event.preventDefault()}
                ondrop={() => {
                  if (dragKey) move(dragKey, param.key);
                  dragKey = null;
                }}
              >
                <td class="tick">
                  <input
                    type="checkbox"
                    checked
                    disabled={param.type === "lora_list"}
                    aria-label={`Unexpose ${param.key}`}
                    onchange={() => unexpose(param.key)}
                  />
                </td>
                <td class="mono node">
                  {#if param.type === "lora_list"}
                    LoRA chain
                    <div class="dim">synthetic · rewrites the graph</div>
                  {:else}
                    {input?.node_id ?? "?"} · {input?.node_type ?? "?"}
                    <div class="dim">
                      {param.type === "size" ? "width + height" : (input?.input ?? "")}
                    </div>
                  {/if}
                </td>
                <td>
                  <input
                    class="mono"
                    value={param.key}
                    aria-label="Key"
                    onchange={(event) =>
                      patch(param.key, {
                        key: (event.currentTarget as HTMLInputElement).value,
                      })}
                  />
                </td>
                <td>
                  <input
                    value={param.label ?? ""}
                    aria-label="Label"
                    onchange={(event) =>
                      patch(param.key, {
                        label: (event.currentTarget as HTMLInputElement).value,
                      })}
                  />
                </td>
                <td>
                  {#if param.type === "lora_list"}
                    <span class="mono">lora_list</span>
                  {:else}
                    <select
                      class="mono"
                      value={param.type}
                      aria-label="Type"
                      onchange={(event) =>
                        patch(param.key, {
                          type: (event.currentTarget as HTMLSelectElement)
                            .value as ParamType,
                        })}
                    >
                      {#each TYPES as type (type)}
                        <option value={type}>{type}</option>
                      {/each}
                    </select>
                  {/if}
                </td>
                <td class="mono default" class:chain-bind={param.type === "lora_list"}>
                  {#if param.type === "lora_list"}
                    {#if typeof param.bind === "object" && "chain" in param.bind}
                      {param.bind.chain.model_from} → {param.bind.chain.model_to.join(
                        ", ",
                      )}
                      {#if param.bind.chain.clip_from}
                        · {param.bind.chain.clip_from} → {param.bind.chain.clip_to?.join(
                          ", ",
                        )}
                      {/if}
                    {/if}
                  {:else if param.type === "seed"}
                    <span class="dim">-1 → random at submit</span>
                  {:else if param.type === "size"}
                    {(param.default as number[])?.join(" × ")}
                    {#if param.step}<span class="dim">· step {param.step}</span>{/if}
                  {:else}
                    {String(param.default ?? "")}
                    {#if param.min !== undefined}
                      <span class="dim">· min {param.min} · max {param.max}</span>
                    {/if}
                  {/if}
                  {#if param.required}<span class="req">required</span>{/if}
                </td>
                <td class="adv">
                  {#if param.type !== "lora_list"}
                    <input
                      type="checkbox"
                      checked={param.advanced ?? false}
                      aria-label={`${param.key} advanced`}
                      onchange={(event) =>
                        patch(param.key, {
                          advanced: (event.currentTarget as HTMLInputElement).checked,
                        })}
                    />
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if hiddenRows.length > 0}
          <div class="not-exposed">
            <div class="label">Not exposed · {hiddenRows.length}</div>
            {#each hiddenRows as input (input.node_id + input.input)}
              <label class="hidden-row">
                <input
                  type="checkbox"
                  aria-label={`Expose ${input.node_id}.${input.input}`}
                  onchange={() => expose(input)}
                />
                <span class="mono dim">
                  {input.node_id} · {input.node_type} · {input.input}
                </span>
                <span class="mono value">{JSON.stringify(input.value)}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <aside class="preview scroll">
        <div class="label preview-head">Panel preview</div>
        {#if draft}
          <div class="preview-panel">
            <ParamPanel
              manifest={draft}
              values={previewValues}
              seedLocked={false}
              lastSeed={null}
              loras={app.loras}
              checkpoints={app.checkpoints}
              modelsOfClass={(c) => app.modelsOfClass(c)}
              onchange={(key, value) =>
                (previewValues = { ...previewValues, [key]: value })}
              onreset={resetPreview}
              onseededit={() => {}}
              onseedroll={() => {}}
              onseedlock={() => {}}
            />
          </div>
          <div class="output-nodes">
            <div class="label">Output nodes</div>
            {#each draft.outputs as output (output.node)}
              <div class="row output-row mono">
                <span>{output.node}</span>
                <span class="dim">
                  {detail.api_json[output.node]?.class_type ?? "?"}
                </span>
                <span class="spacer"></span>
                <span class="badge">{output.kind}</span>
              </div>
            {/each}
          </div>
          <p class="note-box">
            Saving changes the workflow hash. Existing outputs keep their own copy of the
            graph and stay rerunnable.
          </p>
        {:else}
          <p class="empty">
            This workflow has no valid manifest{detail.error ? `: ${detail.error}` : ""}.
          </p>
        {/if}
      </aside>
    </div>
  </section>
{/if}

<style>
  .detail {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
  }

  .thumb {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-input);
    background: var(--control);
  }

  h1 {
    font-size: 15px;
    font-weight: 500;
    margin: 0;
  }

  .sub {
    font-size: 11px;
  }

  header button,
  .button-link {
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 5px;
    background: var(--control);
    padding: 5px 10px;
    border-radius: var(--radius-input);
    color: var(--text);
  }

  .primary {
    background: var(--accent);
    color: #08191d;
  }

  .note {
    font-size: 11px;
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    gap: 10px;
    padding: 0 12px 12px;
  }

  .inputs {
    flex: 1;
    min-width: 0;
    background: var(--app);
    border-radius: var(--radius-card);
    padding: 8px;
  }

  .inputs-head {
    gap: 8px;
    padding: 2px 2px 8px;
  }

  .inputs-head .mono {
    font-size: 11px;
  }

  .bands button {
    font-size: 11px;
    background: var(--raised);
    color: var(--text-3);
  }

  .bands button.active {
    background: var(--control-selected);
    color: var(--text);
  }

  .filter {
    width: 160px;
    flex: 0 0 auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th {
    text-align: left;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-4);
    font-weight: 400;
    padding: 4px 6px;
  }

  td {
    padding: 4px 6px;
    border-top: 1px solid var(--line);
    vertical-align: top;
  }

  tr.exposed {
    background: var(--raised);
    cursor: grab;
  }

  .tick,
  .adv {
    width: 28px;
  }

  .tick input,
  .adv input {
    width: auto;
    accent-color: var(--accent);
  }

  .node {
    font-size: 11px;
    white-space: nowrap;
  }

  .node .dim {
    font-size: 10px;
  }

  td input,
  td select {
    padding: 3px 6px;
    font-size: 12px;
    background: var(--canvas);
  }

  .default {
    font-size: 11px;
    color: var(--text-3);
  }

  .chain-bind {
    max-width: 260px;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .req {
    color: var(--error);
    margin-left: 6px;
  }

  .not-exposed {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hidden-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    border-radius: var(--radius-control);
    font-size: 11px;
  }

  .hidden-row:hover {
    background: var(--raised);
  }

  .hidden-row input {
    width: auto;
    accent-color: var(--accent);
  }

  .value {
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview {
    width: 320px;
    flex: 0 0 auto;
    background: var(--panel);
    border-radius: var(--radius-card);
  }

  .preview-head {
    padding: 10px 12px 0;
  }

  .preview-panel {
    pointer-events: auto;
  }

  .output-nodes {
    padding: 0 12px 8px;
  }

  .output-row {
    font-size: 11px;
    padding: 4px 0;
  }

  .note-box {
    margin: 0 12px 12px;
    padding: 8px;
    border-radius: var(--radius-control);
    background: #2e2114;
    color: var(--running);
    font-size: 11px;
  }
</style>
