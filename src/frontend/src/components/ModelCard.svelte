<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import Eye from "@lucide/svelte/icons/eye";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import type { ModelEntry } from "../types.ts";
  import { bytes, relativeTime } from "../lib/format.ts";
  import { navigate, opensElsewhere } from "../router.svelte.ts";
  import FamilyPicker from "./FamilyPicker.svelte";

  /**
   * One card of the Models grid (§11.2, frame 04): thumbnail, display name,
   * the family picker (SET FAMILY while it has none), and the count of
   * outputs as a link into the gallery filtered to this model.
   * There is no multi-select and no bulk edit (MOCK-REVISIONS §8).
   */
  let {
    model,
    selected = false,
    onfamily,
    onhidden,
  }: {
    model: ModelEntry;
    /** Where the arrow keys are, which is not where the mouse is (§11.4). */
    selected?: boolean;
    onfamily: (model: ModelEntry, family: string) => void;
    /** Keep it out of the Generate pickers, or put it back (§8.1). */
    onhidden?: (model: ModelEntry, hidden: boolean) => void;
  } = $props();

  const href = $derived(`/models/${encodeURIComponent(model.id)}`);
  const galleryHref = $derived(model.hash ? `/gallery?models=${model.hash}` : "/gallery");
</script>

<article
  class="card"
  class:selected
  data-model={model.id}
  data-hashing={model.hashing}
>
  <a
    class="thumb"
    {href}
    onclick={(event) => {
      if (opensElsewhere(event)) return;
      event.preventDefault();
      navigate(href);
    }}
  >
    {#if model.thumb_url}
      <img src={model.thumb_url} alt="" loading="lazy" />
    {:else}
      <span class="plate"><Brain size={18} /></span>
    {/if}
  </a>

  <div class="body">
    <a
      class="name"
      {href}
      onclick={(event) => {
        if (opensElsewhere(event)) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {model.display_name}
    </a>

    <div class="meta">
      {#if model.hashing}
        <!-- No hash yet, so nothing about it can be edited (§8.1). -->
        <span class="badge hashing mono" title="Reading the file to identify it">
          hashing
        </span>
      {:else if model.hash_error}
        <!-- Not on its way: stopped, and saying why rather than reading
             "hashing" for ever. -->
        <span class="badge failed mono" title={`Could not read it: ${model.hash_error}`}>
          unreadable
        </span>
      {:else}
        <!-- The card clips its own overflow to round the thumbnail, so this
             list is anchored in viewport coordinates rather than absolutely
             positioned inside it. -->
        <FamilyPicker
          family={model.family}
          prompt={model.family === "unset"}
          onchange={(family) => onfamily(model, family)}
        />
      {/if}

      <span class="spacer"></span>

      {#if onhidden && !model.hashing && model.hash}
        <button
          class="hide"
          title={model.hidden
            ? "Show this in the Generate inputs again"
            : "Hide this from the Generate inputs"}
          aria-label={model.hidden ? `Unhide ${model.display_name}` : `Hide ${model.display_name}`}
          onclick={() => onhidden(model, !model.hidden)}
        >
          {#if model.hidden}<Eye size={12} />{:else}<EyeOff size={12} />{/if}
        </button>
      {/if}

      {#if model.output_count > 0}
        <a
          class="count mono"
          href={galleryHref}
          title="Show these in the gallery"
          onclick={(event) => {
            if (opensElsewhere(event)) return;
            event.preventDefault();
            navigate(galleryHref);
          }}
        >
          {model.output_count} output{model.output_count === 1 ? "" : "s"}
        </a>
      {:else}
        <span class="count mono dim">unused</span>
      {/if}
    </div>

    <div class="line mono dim">
      {bytes(model.size)}{model.last_used_at
        ? ` · ${relativeTime(model.last_used_at)}`
        : ""}
    </div>
  </div>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border-radius: var(--radius-card);
    overflow: hidden;
  }

  .card.selected {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .thumb {
    aspect-ratio: 1;
    background: var(--control);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--mark);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .body {
    padding: 8px 9px 9px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .name {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .name:hover {
    color: var(--accent);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .spacer {
    flex: 1;
  }

  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-control);
    background: var(--control);
    color: var(--text-3);
  }

  .badge.hashing {
    background: var(--accent-tint);
    color: var(--accent);
  }

  .badge.failed {
    color: var(--error);
  }


  .hide {
    display: flex;
    align-items: center;
    background: transparent;
    padding: 2px 4px;
    color: var(--text-4);
  }

  .hide:hover {
    color: var(--text-2);
    background: var(--control);
  }

  .count {
    font-size: 11px;
    color: var(--text-3);
  }

  a.count:hover {
    color: var(--accent);
  }

  .line {
    font-size: 11px;
  }

</style>
