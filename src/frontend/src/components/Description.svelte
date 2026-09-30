<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { renderMarkdown } from "../lib/markdown.ts";

  /**
   * One description from a source record (DESIGN-MODEL-IMPORT §7.5):
   * rendered by default, with a toggle to the Markdown it came from.
   * `lib/markdown.ts` is what makes the `{@html}` safe — raw HTML escaped,
   * links `http(s):` only, no image ever loaded — and its tests say so.
   *
   * Collapsed past a few lines because a description can be eight kilobytes
   * and the samples are what people came for. Each description has its own
   * state, so opening the overview does not open the version's.
   */
  let { text, title }: { text: string; title: string } = $props();

  let expanded = $state(false);
  let raw = $state(false);

  const lines = $derived(text.split("\n"));
  const long = $derived(lines.length > 8 || text.length > 600);
  const shown = $derived(expanded || !long ? text : lines.slice(0, 8).join("\n"));
  const rendered = $derived(renderMarkdown(text));
</script>

<div class="description" data-title={title}>
  <h3>{title}</h3>
  {#if raw}
    <!-- The source is text, and Svelte escapes it. -->
    <p class="body raw mono" class:clipped={long && !expanded}>{shown}</p>
  {:else}
    <!--
      The one `{@html}` of something a stranger wrote. It is safe because of
      what `renderMarkdown` refuses to emit, and its tests say so.
    -->
    <div class="body rendered" class:clipped={long && !expanded}>
      {@html rendered}
    </div>
  {/if}
  <div class="controls">
    {#if long}
      <button class="more" onclick={() => (expanded = !expanded)}>
        <ChevronDown size={13} class={expanded ? "flip" : ""} />
        {expanded ? "Show less" : "Show more"}
      </button>
    {/if}
    <div class="view" role="group" aria-label={`${title}: view`}>
      <button aria-pressed={!raw} onclick={() => (raw = false)}>Preview</button>
      <button aria-pressed={raw} onclick={() => (raw = true)}>Source</button>
    </div>
  </div>
</div>

<style>
  h3 {
    margin: 14px 0 0;
    color: var(--text-4);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .body {
    margin: 8px 0 0;
    color: var(--text-3);
    font-size: 12.5px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .body.raw {
    white-space: pre-wrap;
    font-size: 12px;
  }

  .body.clipped {
    -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
    mask-image: linear-gradient(to bottom, #000 60%, transparent);
  }

  /* The source is clipped by lines; rendered, a line is not a line any more,
     so the same eight are a height. */
  .body.rendered.clipped {
    max-height: calc(8 * 1.55em);
    overflow: hidden;
  }

  /* Sized for a panel, not a page: an author's h1 should not outshout the
     model's own name above it. */
  .rendered :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: 12px 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }

  .rendered :global(h1) {
    font-size: 14px;
  }

  .rendered :global(p) {
    margin: 0 0 8px;
  }

  .rendered :global(:is(ul, ol)) {
    margin: 0 0 8px;
    padding-left: 20px;
  }

  .rendered :global(li) {
    margin: 2px 0;
  }

  .rendered :global(a) {
    color: var(--accent);
    text-decoration: none;
  }

  .rendered :global(a:hover) {
    text-decoration: underline;
  }

  .rendered :global(strong) {
    color: var(--text-2);
    font-weight: 600;
  }

  .rendered :global(code) {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--control);
  }

  .rendered :global(pre) {
    margin: 0 0 8px;
    padding: 8px 10px;
    border-radius: 4px;
    background: var(--control);
    overflow-x: auto;
  }

  .rendered :global(pre code) {
    padding: 0;
    background: none;
  }

  .rendered :global(blockquote) {
    margin: 0 0 8px;
    padding-left: 10px;
    border-left: 2px solid var(--line);
    color: var(--text-4);
  }

  .rendered :global(hr) {
    border: 0;
    border-top: 1px solid var(--line);
    margin: 10px 0;
  }

  .rendered :global(table) {
    border-collapse: collapse;
    margin: 0 0 8px;
  }

  .rendered :global(:is(th, td)) {
    padding: 3px 8px;
    border: 1px solid var(--line);
  }

  .rendered > :global(:first-child) {
    margin-top: 0;
  }

  .rendered > :global(:last-child) {
    margin-bottom: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }

  .view {
    margin-left: auto;
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 4px;
    overflow: hidden;
  }

  .view button {
    padding: 1px 8px;
    border: 0;
    background: none;
    color: var(--text-4);
    font-size: 11px;
    cursor: pointer;
  }

  .view button + button {
    border-left: 1px solid var(--line);
  }

  .view button[aria-pressed="true"] {
    background: var(--control);
    color: var(--text-2);
  }

  .more {
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
</style>
