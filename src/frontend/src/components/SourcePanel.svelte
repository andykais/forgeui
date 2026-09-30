<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Copy from "@lucide/svelte/icons/copy";
  import type { ModelSource } from "../types.ts";
  import Description from "./Description.svelte";

  /**
   * What Civitai knows about this model (DESIGN-MODEL-IMPORT §7.5): the
   * author's description, who wrote it, and the link out. Fetched by
   * `forge models` and applied on ingest — the app never asks for it.
   *
   * Civitai keeps two descriptions, and both are shown: the version's —
   * what this file is, usually the more accurate — and beneath it the
   * model's overview, where authors put what applies to every version (which
   * download is which, how to prompt it). Each is `description_text`, the
   * Markdown the server derived at ingest, rendered by `Description`. Two
   * rules are not style choices, and `lib/markdown.ts` keeps both: nothing a
   * stranger wrote reaches the DOM as their markup, and no image in it is
   * loaded. Those point at image.civitai.com, and rendering them would make
   * opening a model page call a third party every time, in an app whose
   * premise is that it does not.
   */
  let {
    source,
    triggerWords = [],
  }: {
    source: ModelSource | null;
    triggerWords?: string[];
  } = $props();

  let copied = $state<string | null>(null);

  const meta = $derived(source?.source ?? null);
  const version = $derived(source?.version?.description_text?.trim() || "");
  const overview = $derived(source?.model?.description_text?.trim() || "");
  const versionTitle = $derived(
    source?.version?.name ? `This version · ${source.version.name}` : "This version",
  );

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

{#if source && (version || overview || meta)}
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

    {#if version}
      <Description text={version} title={versionTitle} />
    {/if}
    <!-- The same text twice would be noise; some authors paste it into both. -->
    {#if overview && overview !== version}
      <Description text={overview} title="Overview" />
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
