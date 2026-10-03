<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { defaultFor } from "../stores/panel.svelte.ts";
  import { focusOnMount } from "../lib/focus.ts";
  import {
    defaultStates,
    describeValue,
    fromStates,
    type ParamState,
    STATE_HINTS,
    STATE_LABELS,
    statesOf,
  } from "../lib/templates.ts";
  import type { Manifest, ModelEntry, Param, Template } from "../types.ts";

  /**
   * Save as template (§4.8): the workflow on the panel and, for each of its
   * params, whether the template saves the value on screen, asks for one
   * whenever it is applied, or leaves it open.
   *
   * Opened from a template, it starts where that template is and offers to
   * update it — the way a set value is changed — or to save a new one.
   */
  interface Props {
    workflow: string;
    workflowName: string;
    /** The workflow's own manifest, not one a template has marked up. */
    manifest: Manifest;
    values: Record<string, unknown>;
    seedLocked: boolean;
    /** The template the panel was filled from, if any. */
    from: Template | null;
    loras?: ModelEntry[];
    onclose: () => void;
    onsaved: (template: Template, how: "created" | "updated") => void;
  }

  let {
    workflow,
    workflowName,
    manifest,
    values,
    seedLocked,
    from,
    loras = [],
    onclose,
    onsaved,
  }: Props = $props();

  // Where the dialog starts, read once: from then on it is the user's, and
  // the panel changing underneath it must not reset what they chose.
  const start = untrack(() => {
    const here = from !== null && from.workflow === workflow ? from : null;
    return {
      from: here,
      name: here?.name ?? `${workflowName} template`,
      description: here?.description ?? "",
      states: here
        ? statesOf(here, manifest)
        : defaultStates(manifest, values, defaultFor, seedLocked),
    };
  });
  const fromHere = start.from;
  let name = $state(start.name);
  let description = $state(start.description);
  let states = $state<Record<string, ParamState>>(start.states);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const main = $derived(manifest.params.filter((param) => !param.advanced));
  const advanced = $derived(manifest.params.filter((param) => param.advanced));
  const counts = $derived({
    set: Object.values(states).filter((state) => state === "set").length,
    ask: Object.values(states).filter((state) => state === "ask").length,
  });

  /** A param the workflow requires is required either way: saved or asked. */
  function choices(param: Param): ParamState[] {
    return param.required && param.type !== "seed"
      ? ["set", "ask"]
      : ["set", "ask", "open"];
  }

  async function save(how: "created" | "updated") {
    if (name.trim().length === 0) {
      error = "a template needs a name";
      return;
    }
    saving = true;
    error = null;
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        ...fromStates(states, values),
      };
      const saved =
        how === "updated" && fromHere
          ? await api.saveTemplate(fromHere.id, body)
          : await api.createTemplate({ ...body, workflow });
      onsaved(saved, how);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }
</script>

<div class="save-template">
  <label class="field">
    <span class="label">Name</span>
    <input bind:value={name} aria-label="Template name" use:focusOnMount />
  </label>
  <label class="field">
    <span class="label">Description</span>
    <textarea
      rows="2"
      bind:value={description}
      aria-label="Template description"
      placeholder="What it is for — optional"
    ></textarea>
  </label>

  <p class="dim note">
    Fills <span class="mono">{workflowName}</span>. For each input: save the value on
    screen, ask for one whenever the template is used, or leave it open.
  </p>

  {#snippet row(param: Param)}
    {@const state = states[param.key] ?? "open"}
    <div class="param" data-param={param.key}>
      <div class="param-text">
        <span class="param-name">
          {param.label ?? param.key}
          {#if param.required && param.type !== "seed"}
            <span class="dim required">required</span>
          {/if}
        </span>
        <span class="mono dim value" class:faded={state !== "set"}>
          {describeValue(values[param.key], param, loras)}
        </span>
      </div>
      <div class="states" role="radiogroup" aria-label={`${param.label ?? param.key}`}>
        {#each choices(param) as choice (choice)}
          <button
            role="radio"
            aria-checked={state === choice}
            class:on={state === choice}
            title={STATE_HINTS[choice]}
            onclick={() => (states = { ...states, [param.key]: choice })}
          >
            {STATE_LABELS[choice]}
          </button>
        {/each}
      </div>
    </div>
  {/snippet}

  <div class="params">
    {#each main as param (param.key)}{@render row(param)}{/each}
    {#if advanced.length > 0}
      <div class="label advanced">Advanced</div>
      {#each advanced as param (param.key)}{@render row(param)}{/each}
    {/if}
  </div>

  {#if error}<p class="error mono">{error}</p>{/if}

  <footer>
    <span class="mono dim">saves {counts.set} · asks {counts.ask}</span>
    <span class="spacer"></span>
    <button onclick={onclose}>Cancel</button>
    {#if fromHere}
      <button
        disabled={saving}
        title={fromHere.source === "bundled"
          ? "Saves your own copy of it; the bundled one comes back if you delete the copy"
          : undefined}
        onclick={() => save("updated")}
      >
        Update “{fromHere.name}”
      </button>
    {/if}
    <button class="primary" disabled={saving} onclick={() => save("created")}>
      {fromHere ? "Save as new" : "Save template"}
    </button>
  </footer>
</div>

<style>
  .save-template {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .field input,
  .field textarea {
    font-size: 12px;
  }

  .note {
    margin: 0;
    font-size: 11px;
  }

  .params {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .param {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--raised);
    border-radius: var(--radius-control);
    padding: 5px 7px;
  }

  .param-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .param-name {
    color: var(--text-2);
  }

  .required {
    font-size: 10px;
  }

  .value {
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .value.faded {
    opacity: 0.55;
  }

  .states {
    display: flex;
    flex: 0 0 auto;
    background: var(--control);
    border-radius: var(--radius-control);
    padding: 2px;
  }

  .states button {
    background: transparent;
    font-size: 10px;
    padding: 2px 6px;
    color: var(--text-3);
  }

  .states button.on {
    background: var(--raised-2);
    color: var(--text);
  }

  .advanced {
    margin-top: 6px;
  }

  .error {
    color: var(--error);
    margin: 0;
    font-size: 11px;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding-top: 4px;
  }

  footer button {
    font-size: 12px;
  }

  .primary {
    background: var(--accent);
    color: #08191d;
  }
</style>
