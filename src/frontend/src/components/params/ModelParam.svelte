<script lang="ts">
  import Popover from "../Popover.svelte";
  import { matcher } from "../../lib/search.ts";
  import type { ModelEntry, Param } from "../../types.ts";

  /**
   * The base-model picker (§5, §13). One search box over every folder in the
   * param's class — `diffusion` pools `checkpoints`, `Stable-Diffusion`,
   * `diffusion_models` and `unet` — so which folder a file sits in stops
   * mattering.
   *
   * The workflow's family orders the list rather than gating it: matching
   * models come first, the rest follow under a divider and stay selectable.
   * A model nobody has filed yet counts as matching, because it has no
   * family only because no one has said so.
   */
  interface Props {
    param: Param;
    value: string;
    models: ModelEntry[];
    onchange: (name: string) => void;
    /** Called once a model has been chosen, so the panel can move the caret. */
    onpicked?: () => void;
    /** The panel this picker's list covers, rather than hanging off the row. */
    fill?: HTMLElement | null;
  }

  let { param, value, models, onchange, onpicked, fill = null }: Props = $props();

  let open = $state(false);
  let search = $state("");

  const family = $derived(param.filter?.family ?? null);

  const matched = $derived.by(() => {
    const matches = matcher(search);
    return models.filter((model) => matches(model.name, model.display_name));
  });

  function fits(model: ModelEntry): boolean {
    return !family || model.family === family || model.family === "unset";
  }

  const preferred = $derived(matched.filter(fits));
  const others = $derived(matched.filter((model) => !fits(model)));

  const selected = $derived(models.find((model) => model.name === value) ?? null);
  /**
   * A bundled workflow ships the filenames its source template used, which
   * are not the filenames on this machine. Saying so in the panel is the
   * whole warning a user gets before the server refuses the job.
   */
  const missing = $derived(value !== "" && selected === null && models.length > 0);

  function pick(model: ModelEntry) {
    onchange(model.name);
    open = false;
    search = "";
    onpicked?.();
  }
</script>

<div class="picker-wrap">
  <button class="picker" class:missing onclick={() => (open = !open)}>
    <span class="name">
      {selected?.display_name ?? value ?? ""}
      {#if !value}<span class="dim">choose a model…</span>{/if}
    </span>
    {#if missing}
      <span class="warn" title="Not in your model folders">not found</span>
    {/if}
    {#if selected && selected.family !== "unset"}
      <span class="badge">{selected.family}</span>
    {/if}
  </button>

  <Popover {open} {fill} title="Models" onclose={() => (open = false)}>
    <input
      class="search"
      placeholder="Search models… (regex ok)"
      bind:value={search}
      aria-label="Search models"
    />
    {#if models.length === 0}
      <p class="note">
        No models found in <code class="mono">model_folders</code>.
      </p>
    {:else if matched.length === 0}
      <p class="note">Nothing matches “{search}”.</p>
    {:else}
      {#each preferred as model (model.id)}
        <button
          class="option"
          class:current={model.name === value}
          onclick={() => pick(model)}
        >
          <span class="option-name">{model.display_name}</span>
          <span class="option-kind mono">{model.kind}</span>
        </button>
      {/each}
      {#if others.length > 0}
        <!-- Not this workflow's family, but still reachable: the filter
             orders the list, it does not hide half of it. -->
        <p class="divider">Other models</p>
        {#each others as model (model.id)}
          <button
            class="option"
            class:current={model.name === value}
            onclick={() => pick(model)}
          >
            <span class="option-name">{model.display_name}</span>
            <span class="option-kind mono">{model.family}</span>
          </button>
        {/each}
      {/if}
    {/if}
  </Popover>
</div>

<style>
  .picker-wrap {
    position: relative;
  }

  .picker {
    display: flex;
    border: 1px solid transparent;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--raised);
    font-size: 12px;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dim {
    color: var(--text-4);
  }

  .picker.missing {
    border: 1px solid var(--error);
  }

  .warn {
    flex: none;
    padding: 1px 6px;
    font-size: 11px;
    color: var(--error);
  }

  .badge {
    flex: none;
    padding: 1px 6px;
    font-size: 11px;
    color: var(--text-3);
    background: var(--control);
    border-radius: 999px;
  }

  .search {
    margin-bottom: 4px;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 7px;
    font-size: 12px;
  }

  .option:hover {
    background: var(--control);
  }

  .option.current {
    background: var(--control-selected);
  }

  .option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .option-kind {
    flex: none;
    font-size: 11px;
    color: var(--text-4);
  }

  .divider {
    margin: 8px 0 4px;
    padding-top: 6px;
    font-size: 11px;
    color: var(--text-4);
    border-top: 1px solid var(--line-2);
  }

  .note {
    padding: 6px 7px;
    font-size: 12px;
    color: var(--text-3);
  }
</style>
