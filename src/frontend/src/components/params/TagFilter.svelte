<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import X from "@lucide/svelte/icons/x";
  import { focusOnMount } from "../../lib/focus.ts";
  import { matcher } from "../../lib/search.ts";
  import type { ModelEntry } from "../../types.ts";

  /**
   * Tag chips over a picker's list (§8.1). The five commonest tags are always
   * on screen, because with a hundred LoRAs the tags are how anyone finds
   * anything; the rest are behind one control so the row cannot grow into a
   * wall. Each carries the count of models it would leave listed, so it is
   * clear before clicking whether a tag is worth clicking.
   *
   * Selecting more than one narrows: a model has to carry all of them.
   */
  interface Props {
    /** What the list holds before any tag is chosen; the counts come from it. */
    models: ModelEntry[];
    selected: string[];
    onchange: (tags: string[]) => void;
  }

  let { models, selected, onchange }: Props = $props();

  const TOP = 5;

  let open = $state(false);
  let search = $state("");

  /** Every tag on these models, commonest first, ties alphabetical. */
  const counts = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const model of models) {
      for (const tag of model.tags) totals.set(tag, (totals.get(tag) ?? 0) + 1);
    }
    return [...totals].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  });

  const top = $derived(counts.slice(0, TOP));
  /** The rest, plus anything already chosen that did not make the cut. */
  const rest = $derived(counts.filter(([tag]) => !top.some(([shown]) => shown === tag)));
  const found = $derived.by(() => {
    const matches = matcher(search);
    return rest.filter(([tag]) => matches(tag));
  });

  function toggle(tag: string) {
    onchange(
      selected.includes(tag)
        ? selected.filter((each) => each !== tag)
        : [...selected, tag],
    );
  }

  function pick(tag: string) {
    if (!selected.includes(tag)) onchange([...selected, tag]);
    open = false;
    search = "";
  }
</script>

{#if counts.length > 0}
  <div class="tags">
    <!-- Chosen tags that are not among the top five still need a way off. -->
    {#each selected.filter((tag) => !top.some(([shown]) => shown === tag)) as tag (tag)}
      <button class="chip on" onclick={() => toggle(tag)}>
        {tag}
        <X size={10} />
      </button>
    {/each}

    {#each top as [tag, count] (tag)}
      <button class="chip" class:on={selected.includes(tag)} onclick={() => toggle(tag)}>
        {tag}
        <span class="count mono">{count}</span>
      </button>
    {/each}

    {#if rest.length > 0}
      <div class="more-wrap">
        <button class="chip more" onclick={() => (open = !open)}>
          {rest.length} more
          <ChevronDown size={11} />
        </button>
        {#if open}
          <div class="sheet" role="dialog" aria-label="All tags">
            <input
              class="tag-search"
              placeholder="Find a tag…"
              aria-label="Find a tag"
              bind:value={search}
              use:focusOnMount
            />
            <div class="sheet-list scroll">
              {#each found as [tag, count] (tag)}
                <button class="row" onclick={() => pick(tag)}>
                  <span class="row-tag">{tag}</span>
                  <span class="count mono">{count}</span>
                </button>
              {:else}
                <p class="none">No tag matches.</p>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if selected.length > 0}
      <button class="chip clear" onclick={() => onchange([])}>clear</button>
    {/if}
  </div>
{/if}

<style>
  .tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 3px 6px;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--control);
    color: var(--text-3);
  }

  .chip.on {
    background: var(--accent-tint);
    color: var(--accent);
  }

  .chip.more,
  .chip.clear {
    background: transparent;
    color: var(--text-4);
  }

  .chip.more:hover,
  .chip.clear:hover {
    color: var(--text-2);
    background: var(--control);
  }

  .count {
    font-size: 10px;
    color: var(--text-4);
  }

  .chip.on .count {
    color: var(--accent);
  }

  .more-wrap {
    position: relative;
  }

  /* Inside a popover that already fills the panel, so this stays small. */
  .sheet {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    width: 220px;
    max-height: 260px;
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border-radius: var(--radius-input);
    box-shadow: 0 10px 26px rgb(0 0 0 / 55%);
    padding: 4px;
  }

  .sheet-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .tag-search {
    margin-bottom: 4px;
    font-size: 12px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 4px 6px;
    font-size: 12px;
  }

  .row:hover {
    background: var(--control);
  }

  .row-tag {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .none {
    margin: 0;
    padding: 6px;
    font-size: 11px;
    color: var(--text-4);
  }
</style>
