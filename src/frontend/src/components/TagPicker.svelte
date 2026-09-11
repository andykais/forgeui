<script lang="ts">
  import Tag from "@lucide/svelte/icons/tag";
  import X from "@lucide/svelte/icons/x";
  import Popover from "./Popover.svelte";
  import { matcher } from "../lib/search.ts";
  import { focusOnMount } from "../lib/focus.ts";
  import type { ModelEntry } from "../types.ts";

  /**
   * The Models screen's tag filter (§11.2). A text box could only be typed
   * into blind — you had to know a tag existed to ask for it. This lists the
   * ten commonest with their counts, narrows as you type, and takes the arrow
   * keys and Enter like every other picker in the app (§11.3).
   *
   * Several tags narrow rather than widen: a model has to carry all of them,
   * which is what `?tags=` means on the API.
   */
  interface Props {
    /** Every model in the current pile; the counts are taken from these. */
    models: ModelEntry[];
    selected: string[];
    onchange: (tags: string[]) => void;
  }

  let { models, selected, onchange }: Props = $props();

  /** Enough to choose from without becoming a list to scroll. */
  const SHOWN = 10;

  let open = $state(false);
  let search = $state("");
  let trigger = $state<HTMLButtonElement | undefined>(undefined);

  /** Every tag on these models, commonest first, ties alphabetical. */
  const counts = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const model of models) {
      for (const tag of model.tags) totals.set(tag, (totals.get(tag) ?? 0) + 1);
    }
    return [...totals].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  });

  const listed = $derived.by(() => {
    const matches = matcher(search);
    return counts.filter(([tag]) => matches(tag)).slice(0, SHOWN);
  });

  /** A tag chosen but no longer on anything here still has to be removable. */
  const orphans = $derived(
    selected.filter((tag) => !counts.some(([name]) => name === tag)),
  );

  function toggle(tag: string) {
    onchange(
      selected.includes(tag)
        ? selected.filter((name) => name !== tag)
        : [...selected, tag],
    );
    search = "";
  }
</script>

<span class="wrap">
  <button
    class="trigger"
    class:on={selected.length > 0}
    bind:this={trigger}
    title="Filter by tag; several narrow, a model must carry all of them"
    onclick={() => (open = !open)}
  >
    <Tag size={13} />
    {#if selected.length === 0}
      <span class="dim">Tags…</span>
    {:else}
      <span class="chosen mono">{selected.join(", ")}</span>
    {/if}
  </button>
  {#if selected.length > 0}
    <button class="clear" aria-label="Clear the tag filter" onclick={() => onchange([])}>
      <X size={12} />
    </button>
  {/if}

  <Popover
    {open}
    anchor={trigger}
    width={230}
    title="Tags"
    onclose={() => (open = false)}
  >
    <input
      class="search"
      placeholder="Search tags…"
      bind:value={search}
      aria-label="Search tags"
      use:focusOnMount
    />
    {#if counts.length === 0}
      <p class="note">Nothing here is tagged yet.</p>
    {:else if listed.length === 0}
      <p class="note">No tag matches “{search}”.</p>
    {:else}
      {#each listed as [tag, count] (tag)}
        <button
          class="option"
          class:current={selected.includes(tag)}
          onclick={() => toggle(tag)}
        >
          <span class="mark mono">{selected.includes(tag) ? "✓" : ""}</span>
          <span class="option-name">{tag}</span>
          <span class="mono dim">{count}</span>
        </button>
      {/each}
    {/if}
    {#each orphans as tag (tag)}
      <button class="option orphan" onclick={() => toggle(tag)}>
        <span class="mark mono">✓</span>
        <span class="option-name">{tag}</span>
        <span class="mono dim">0</span>
      </button>
    {/each}
  </Popover>
</span>

<style>
  .wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: var(--control);
    border-radius: var(--radius-input);
    padding: 0 4px 0 8px;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    padding: 5px 0;
    font-size: 12px;
    color: var(--text-4);
    max-width: 190px;
  }

  .trigger.on {
    color: var(--text);
  }

  .chosen {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .clear {
    display: flex;
    background: transparent;
    padding: 2px;
    color: var(--text-4);
  }

  .clear:hover {
    color: var(--text);
  }

  .search {
    margin-bottom: 4px;
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
    color: var(--text-2);
  }

  .option:hover {
    background: var(--control);
    color: var(--text);
  }

  .option.current {
    background: var(--control-selected);
    color: var(--text);
  }

  .mark {
    width: 10px;
    color: var(--accent);
    font-size: 11px;
  }

  .option-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Chosen, but nothing in this pile carries it any more. */
  .option.orphan .option-name {
    color: var(--text-4);
  }

  .note {
    padding: 6px 7px;
    font-size: 12px;
    color: var(--text-3);
  }
</style>
