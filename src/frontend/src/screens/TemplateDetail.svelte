<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { defaultFor, panel } from "../stores/panel.svelte.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import { navigate, opensElsewhere } from "../router.svelte.ts";
  import {
    describeValue,
    describeValues,
    type ParamState,
    STATE_HINTS,
    STATE_LABELS,
    statesOf,
  } from "../lib/templates.ts";
  import type { Manifest, Param, Template } from "../types.ts";

  /**
   * One template (§4.8, §11.2): its name and description, edited in place,
   * and every param of its workflow with the state the template leaves it in.
   * A set value is changed by opening the template in Generate and saving it
   * from there; this page moves params between set, asked and open.
   */
  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  let template = $state<Template | null>(null);
  let manifest = $state<Manifest | null>(null);
  let error = $state<string | null>(null);
  let nameDraft = $state("");
  let descriptionDraft = $state("");
  let saving = $state(false);

  async function load() {
    try {
      const loaded = await api.template(id);
      template = loaded;
      nameDraft = loaded.name;
      descriptionDraft = loaded.description ?? "";
      error = null;
      try {
        manifest = (await api.workflow(loaded.workflow)).manifest;
      } catch {
        // Its workflow is gone: the page still shows what it holds, and its
        // problems say why nothing here can be changed.
        manifest = null;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $effect(() => {
    void id;
    void load();
  });

  const states = $derived(
    template && manifest
      ? statesOf(template, manifest)
      : ({} as Record<string, ParamState>),
  );
  const main = $derived(manifest?.params.filter((param) => !param.advanced) ?? []);
  const advanced = $derived(manifest?.params.filter((param) => param.advanced) ?? []);

  /** Save what changed; a bundled template comes back as the user's copy. */
  async function put(body: Parameters<typeof api.saveTemplate>[1], what: string) {
    if (!template) return;
    const wasBundled = template.source === "bundled";
    saving = true;
    try {
      template = await api.saveTemplate(template.id, body);
      nameDraft = template.name;
      descriptionDraft = template.description ?? "";
      if (wasBundled) toasts.message(`${what} — saved as your copy of it`);
      await app.refreshTemplates().catch(() => {});
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not save it");
    } finally {
      saving = false;
    }
  }

  function commitName() {
    if (!template) return;
    const name = nameDraft.trim();
    if (name.length === 0 || name === template.name) {
      nameDraft = template.name;
      return;
    }
    void put({ name }, "Renamed");
  }

  function commitDescription() {
    if (!template) return;
    const description = descriptionDraft.trim() || null;
    if (description === (template.description ?? null)) return;
    void put({ description }, "Description saved");
  }

  /** Move a param to another state. Setting one starts from the default. */
  function setState(param: Param, next: ParamState) {
    if (!template) return;
    const values = { ...template.values };
    let ask = template.ask.filter((key) => key !== param.key);
    delete values[param.key];
    if (next === "set")
      values[param.key] = template.values[param.key] ?? defaultFor(param);
    if (next === "ask") ask = [...ask, param.key];
    void put({ values, ask }, `${param.label ?? param.key} changed`);
  }

  function choices(param: Param): ParamState[] {
    return param.required && param.type !== "seed"
      ? ["set", "ask"]
      : ["set", "ask", "open"];
  }

  /** What a row says beside its state. */
  function shown(param: Param): string {
    if (!template) return "";
    const state = states[param.key];
    if (state === "set")
      return describeValue(template.values[param.key], param, app.loras);
    if (state === "ask") return "asked for each time";
    const fallback = describeValue(defaultFor(param), param, app.loras);
    return fallback === "—" ? "open" : `open — ${fallback} by default`;
  }

  async function openInGenerate() {
    if (!template) return;
    try {
      await panel.applyTemplate(template);
      navigate(`/generate?workflow=${template.workflow}`);
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not open it");
    }
  }

  async function remove() {
    if (!template) return;
    const restores = template.has_bundled;
    try {
      await api.deleteTemplate(template.id);
      await app.refreshTemplates().catch(() => {});
      if (restores) {
        toasts.message(`Your copy is gone; the bundled “${template.name}” is back`);
        await load();
      } else {
        toasts.message(`Deleted “${template.name}”`);
        navigate("/templates");
      }
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not delete it");
    }
  }

  function openWorkflow(event: MouseEvent) {
    if (!template || opensElsewhere(event)) return;
    event.preventDefault();
    navigate(`/workflows/${template.workflow}`);
  }
</script>

{#if error}
  <div class="empty">
    <p class="error mono">{error}</p>
    <button onclick={() => navigate("/templates")}>Back to templates</button>
  </div>
{:else if template}
  <section class="template scroll">
    <nav class="crumbs mono dim">
      <button onclick={() => navigate("/templates")}>Templates</button>
      <span>/</span>
      <span class="here">{template.name}</span>
    </nav>

    <header class="head">
      <button
        class="back"
        title="Back to templates"
        onclick={() => navigate("/templates")}
      >
        <ArrowLeft size={15} />
      </button>
      <div class="identity">
        <div class="name-row">
          <input
            class="name"
            aria-label="Template name"
            disabled={saving}
            bind:value={nameDraft}
            onblur={commitName}
            onkeydown={(event) => {
              if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
              if (event.key === "Escape") {
                nameDraft = template?.name ?? "";
                (event.currentTarget as HTMLInputElement).blur();
              }
            }}
          />
          {#if template.source === "bundled"}
            <span class="badge">bundled</span>
          {:else if template.has_bundled}
            <span class="badge accent">user copy</span>
          {/if}
          <span class="spacer"></span>
          <button
            class="primary"
            disabled={!manifest || template.problems.length > 0}
            title="Fill the Generate panel from this template"
            onclick={openInGenerate}
          >
            Open in Generate
          </button>
          {#if template.source === "user"}
            <button
              class="danger"
              title={template.has_bundled
                ? "Delete your copy; the bundled template comes back"
                : "Delete this template"}
              onclick={remove}
            >
              {template.has_bundled ? "Delete copy" : "Delete"}
            </button>
          {/if}
        </div>

        <div class="meta mono dim">
          fills
          <a class="link" href={`/workflows/${template.workflow}`} onclick={openWorkflow}
            >{template.workflow_name ?? template.workflow}</a
          >
          {#if template.family}<span class="badge accent">{template.family}</span>{/if}
          {#if template.action === "upscale"}<span>· used by Upscale image</span>{/if}
        </div>

        <textarea
          class="description"
          rows="2"
          aria-label="Template description"
          placeholder="What it is for"
          disabled={saving}
          bind:value={descriptionDraft}
          onblur={commitDescription}
        ></textarea>

        {#if template.source === "bundled"}
          <p class="dim note">
            Bundled with the app. Changing anything here saves your own copy, which
            replaces it until you delete the copy.
          </p>
        {/if}
        {#if template.problems.length > 0}
          <ul class="problems mono">
            {#each template.problems as problem (problem)}
              <li><TriangleAlert size={11} /> {problem}</li>
            {/each}
          </ul>
        {/if}
      </div>
    </header>

    {#snippet row(param: Param)}
      {@const state = states[param.key] ?? "open"}
      <div class="param" data-param={param.key}>
        <span class="param-name">
          {param.label ?? param.key}
          {#if param.required && param.type !== "seed"}
            <span class="dim required">required</span>
          {/if}
        </span>
        <span class="mono value" class:dim={state !== "set"}>{shown(param)}</span>
        <div class="states" role="radiogroup" aria-label={param.label ?? param.key}>
          {#each choices(param) as choice (choice)}
            <button
              role="radio"
              aria-checked={state === choice}
              class:on={state === choice}
              title={STATE_HINTS[choice]}
              disabled={saving}
              onclick={() => state !== choice && setState(param, choice)}
            >
              {STATE_LABELS[choice]}
            </button>
          {/each}
        </div>
      </div>
    {/snippet}

    <div class="params">
      <div class="label">Inputs</div>
      {#if manifest}
        {#each main as param (param.key)}{@render row(param)}{/each}
        {#if advanced.length > 0}
          <div class="label advanced">Advanced</div>
          {#each advanced as param (param.key)}{@render row(param)}{/each}
        {/if}
        <p class="dim note">
          To change a saved value, open the template in Generate, adjust it, and use <strong
            >Save as template</strong
          > → Update.
        </p>
      {:else}
        <p class="mono dim">{describeValues(template.values, app.loras)}</p>
      {/if}
    </div>
  </section>
{/if}

<style>
  .template {
    flex: 1;
    min-height: 0;
    padding-bottom: 16px;
  }

  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 0;
    font-size: 11px;
  }

  .crumbs button {
    background: transparent;
    color: var(--text-3);
    padding: 0;
    font-size: 11px;
  }

  .crumbs button:hover {
    color: var(--accent);
  }

  .crumbs .here {
    color: var(--text-2);
  }

  .head {
    display: flex;
    gap: 12px;
    padding: 12px;
    align-items: flex-start;
  }

  .back {
    background: transparent;
    color: var(--text-3);
    padding: 4px;
  }

  .back:hover {
    color: var(--text);
    background: var(--raised);
  }

  .identity {
    flex: 1;
    min-width: 0;
    max-width: 760px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .name {
    font-size: 16px;
    background: transparent;
    border: 1px solid transparent;
    padding: 2px 6px;
    min-width: 0;
    flex: 0 1 360px;
  }

  .name:hover,
  .name:focus {
    border-color: var(--line-2);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .link {
    color: var(--accent);
  }

  .description {
    font-size: 12px;
    resize: vertical;
  }

  .note {
    margin: 0;
    font-size: 11px;
  }

  .note strong {
    color: var(--text-2);
    font-weight: 500;
  }

  .problems {
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--error);
    font-size: 11px;
  }

  .primary {
    background: var(--accent);
    color: #08191d;
    font-size: 12px;
  }

  .danger {
    color: var(--error);
    font-size: 12px;
  }

  .params {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 760px;
    padding: 0 12px 0 52px;
  }

  .param {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    background: var(--raised);
    border-radius: var(--radius-control);
    padding: 6px 8px;
    font-size: 12px;
  }

  .param-name {
    color: var(--text-2);
  }

  .required {
    font-size: 10px;
    margin-left: 4px;
  }

  .value {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .states {
    display: flex;
    background: var(--control);
    border-radius: var(--radius-control);
    padding: 2px;
  }

  .states button {
    background: transparent;
    font-size: 10px;
    padding: 2px 7px;
    color: var(--text-3);
  }

  .states button.on {
    background: var(--raised-2);
    color: var(--text);
  }

  .advanced {
    margin-top: 8px;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
</style>
