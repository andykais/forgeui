<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Copy from "@lucide/svelte/icons/copy";
  import type { ModelSource } from "../types.ts";

  /**
   * What Civitai knows about this model (DESIGN-MODEL-IMPORT §7.5): the
   * author's description, who wrote it, and the link out. Fetched by
   * `forge models` and applied on ingest — the app never asks for it.
   *
   * Two rules here are not style choices. The description is rendered as
   * **text**, never as HTML: the page asks for `description_text`, which the
   * server derived at ingest, so nothing a stranger wrote is ever handed to
   * the DOM as markup. And no image in it is loaded — those point at
   * image.civitai.com, and rendering them would make opening a model page
   * call a third party every time, in an app whose premise is that it does
   * not. The samples strip holds the images that matter, and those are on
   * disk.
   *
   * Collapsed past a few lines because a description can be eight kilobytes
   * and the samples are what people came for.
   */
  let {
    source,
    triggerWords = [],
  }: {
    source: ModelSource | null;
    triggerWords?: string[];
  } = $props();

  let expanded = $state(false);
  let copied = $state<string | null>(null);

  const meta = $derived(source?.source ?? null);
  const description = $derived(
    source?.version?.description_text?.trim() ||
      source?.model?.description_text?.trim() ||
      "",
  );
  const lines = $derived(description.split("\n"));
  const long = $derived(lines.length > 8 || description.length > 600);
  const shown = $derived(expanded || !long ? description : lines.slice(0, 8).join("\n"));

  async function copy(word: string) {
    try {
      await navigator.clipboard.writeText(word);
      copied = word;
      setTimeout(() => (copied = copied === word ? null : copied), 1200);
    } catch {
      // A clipboard the browser will not give us is not worth an error.
    }
  }
</script>

{#if triggerWords.length > 0}
  <!--
    The one part of an import the app acts on rather than displays: these go
    into a prompt, so each is a click to copy.
  -->
  <div class="triggers">
    <span class="label">trigger words</span>
    <div class="words">
      {#each triggerWords as word (word)}
        <button class="word mono" title={`Copy "${word}"`} onclick={() => copy(word)}>
          {word}
          {#if copied === word}
            <span class="dim">copied</span>
          {:else}
            <Copy size={11} />
          {/if}
        </button>
      {/each}
    </div>
  </div>
{/if}

{#if source && (description || meta)}
  <section class="source">
    <header>
      <h2>From {meta?.label ?? "elsewhere"}</h2>
      {#if source.creator?.username}
        <span class="dim">by {source.creator.username}</span>
      {/if}
      {#if source.version?.base_model}
        <span class="mono dim">{source.version.base_model}</span>
      {/if}
      {#if meta?.url}
        <a class="out" href={meta.url} target="_blank" rel="noopener noreferrer nofollow">
          {meta.label}
          <ExternalLink size={12} />
        </a>
      {/if}
    </header>

    {#if description}
      <!--
        `shown` is text. Svelte escapes it, which is the point: this is the
        one place in the app that renders something a stranger wrote.
      -->
      <p class="body" class:clipped={long && !expanded}>{shown}</p>
      {#if long}
        <button class="more" onclick={() => (expanded = !expanded)}>
          <ChevronDown size={13} class={expanded ? "flip" : ""} />
          {expanded ? "Show less" : "Show more"}
        </button>
      {/if}
    {/if}

    {#if source.model?.tags?.length}
      <div class="upstream">
        <span class="label">their tags</span>
        {#each source.model.tags as tag (tag)}
          <span class="chip mono">{tag}</span>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .triggers {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 10px;
  }

  .label {
    color: var(--text-4);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex: none;
  }

  .words {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .word {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--control);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
  }

  .word:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  .source {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }

  .dim {
    color: var(--text-4);
    font-size: 12px;
  }

  .out {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    font-size: 12px;
    text-decoration: none;
  }

  .out:hover {
    text-decoration: underline;
  }

  .body {
    margin: 8px 0 0;
    color: var(--text-3);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .body.clipped {
    -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
    mask-image: linear-gradient(to bottom, #000 60%, transparent);
  }

  .more {
    margin-top: 4px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-4);
    font-size: 12px;
    cursor: pointer;
  }

  .more:hover {
    color: var(--text-2);
  }

  .upstream {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 10px;
  }

  .chip {
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--control);
    color: var(--text-4);
    font-size: 11px;
  }
</style>
