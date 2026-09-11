<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Popover from "./Popover.svelte";
  import { app } from "../stores/app.svelte.ts";
  import { matcher } from "../lib/search.ts";
  import { focusOnMount } from "../lib/focus.ts";

  /**
   * The one way a model's family is set (§8.1): the same control on the model
   * page, on a card in the grid, and in the Family column of the table, so
   * filing a model is the same gesture wherever it is in front of you.
   *
   * It hangs off its trigger through `anchor`, not through the ordinary
   * absolute position, because two of those three places clip their own
   * overflow and would swallow the list.
   */
  interface Props {
    family: string;
    /** How many models each family holds, beside its name. */
    counts?: Map<string, number>;
    onchange: (family: string) => void;
    /** `unset` reads as a prompt rather than a value on an unfiled model. */
    prompt?: boolean;
    disabled?: boolean;
  }

  let { family, counts, onchange, prompt = false, disabled = false }: Props = $props();

  let open = $state(false);
  let search = $state("");
  let trigger = $state<HTMLButtonElement | undefined>(undefined);

  /** Every family the app offers, with `unset` last: it is the way back. */
  const all = $derived([...app.families, "unset"]);
  const listed = $derived.by(() => {
    const matches = matcher(search);
    return all.filter((name) => matches(name));
  });

  function pick(name: string) {
    open = false;
    search = "";
    if (name !== family) onchange(name);
  }
</script>

<span class="chip-wrap">
  <button
    class="trigger mono"
    class:prompt
    {disabled}
    bind:this={trigger}
    title="Set this model's family"
    onclick={(event) => {
      // In the table this sits inside a row that navigates on click.
      event.stopPropagation();
      open = !open;
    }}
  >
    {prompt ? "SET FAMILY" : family}
    <ChevronDown size={11} />
  </button>
  <Popover
    {open}
    anchor={trigger}
    width={190}
    title="Family"
    onclose={() => (open = false)}
  >
    <input
      class="search"
      placeholder="Search families…"
      bind:value={search}
      aria-label="Search families"
      use:focusOnMount
    />
    {#if listed.length === 0}
      <p class="note">Nothing matches “{search}”.</p>
    {:else}
      {#each listed as name (name)}
        <button
          class="option"
          class:current={name === family}
          onclick={(event) => {
            event.stopPropagation();
            pick(name);
          }}
        >
          <span class="option-name mono">{name}</span>
          {#if counts}<span class="mono dim">{counts.get(name) ?? 0}</span>{/if}
        </button>
      {/each}
    {/if}
  </Popover>
</span>

<style>
  .chip-wrap {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    font-size: 11px;
    padding: 2px 7px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* An unfiled model asks to be filed, rather than showing "unset" twice. */
  .trigger.prompt {
    font-size: 10px;
    padding: 1px 6px;
    background: transparent;
    border: 1px dashed var(--edge-2);
    color: var(--text-4);
  }

  .trigger.prompt:hover:not(:disabled) {
    color: var(--text-2);
    border-color: var(--edge);
  }

  .search {
    margin-bottom: 4px;
  }

  .option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 8px;
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

  .option-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    padding: 6px 8px;
    font-size: 12px;
    color: var(--text-3);
  }
</style>
