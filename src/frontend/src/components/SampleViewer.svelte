<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import PencilLine from "@lucide/svelte/icons/pencil-line";
  import Star from "@lucide/svelte/icons/star";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { Sample } from "../types.ts";
  import MediaThumb from "./MediaThumb.svelte";

  /**
   * A model's samples at full size (§8.3), walked the way the outputs below
   * them are walked: ← / → and the strip along the bottom, `esc` back to the
   * page, `f` for the black field.
   *
   * Not the output viewer. That one is built on an output's sidecar — its
   * params, its lineage, Generate again — and a sample has none of those: a
   * dropped file has nothing but its pixels, and an imported one a link to
   * where it came from. What is here is what a sample does have, and the
   * three things the strip's hover menu already offers.
   */
  interface Props {
    samples: Sample[];
    selected: Sample;
    thumbPath?: string | null;
    onselect: (sample: Sample) => void;
    onclose: () => void;
    onthumb: (sample: Sample) => void;
    onedit: (sample: Sample) => void;
    ondelete: (sample: Sample) => void;
  }

  let {
    samples,
    selected,
    thumbPath = null,
    onselect,
    onclose,
    onthumb,
    onedit,
    ondelete,
  }: Props = $props();

  let fit = $state(true);
  let fullscreen = $state(false);
  let strip = $state<HTMLDivElement | undefined>(undefined);

  const index = $derived(samples.findIndex((sample) => sample.id === selected.id));
  /** A promotion's prompt, which is the one thing worth reading off it. */
  const prompt = $derived(
    typeof selected.params?.prompt === "string" ? selected.params.prompt : null,
  );

  export function step(delta: number) {
    const next = samples[index + delta];
    if (next) onselect(next);
  }

  export function toggleFullscreen() {
    fullscreen = !fullscreen;
  }

  export function exitFullscreen(): boolean {
    if (!fullscreen) return false;
    fullscreen = false;
    return true;
  }

  $effect(() => {
    const id = selected.id;
    strip
      ?.querySelector(`[data-sample-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  });
</script>

{#if fullscreen}
  <!-- Media only, no chrome, black field (§11.4). -->
  <div class="fullscreen" role="presentation" onclick={() => (fullscreen = false)}>
    {#if selected.kind === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={selected.media_url} controls autoplay loop></video>
    {:else}
      <img src={selected.media_url} alt={prompt ?? selected.id} />
    {/if}
  </div>
{/if}

<div class="sample-viewer">
  <header>
    <button class="back" onclick={onclose} title="Back to the model">
      <ArrowLeft size={13} />
      <span class="back-label">Back to model</span>
      <span class="key mono">esc</span>
    </button>
    <span class="spacer"></span>
    <div class="row nav">
      <button
        title="Previous sample"
        aria-label="Previous sample"
        disabled={index <= 0}
        onclick={() => step(-1)}
      >
        <ArrowLeft size={13} />
      </button>
      <button
        title="Next sample"
        aria-label="Next sample"
        disabled={index >= samples.length - 1}
        onclick={() => step(1)}
      >
        <ArrowRight size={13} />
      </button>
    </div>
    <span class="position mono">{index + 1} / {samples.length}</span>
    <div class="row zoom">
      <button class:active={fit} onclick={() => (fit = true)}>Fit</button>
      <button class:active={!fit} onclick={() => (fit = false)}>1:1</button>
    </div>
  </header>

  <div class="media" class:one-to-one={!fit}>
    {#if selected.kind === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={selected.media_url} controls autoplay loop></video>
    {:else}
      <img src={selected.media_url} alt={prompt ?? selected.id} />
    {/if}
  </div>

  <!-- What the sample is, and what can be done with it. -->
  <div class="about">
    {#if selected.source}
      <a
        class="origin mono external"
        href={selected.source.url ?? undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        title={`Imported from ${selected.source.label}`}
      >
        {selected.source.label} ↗
      </a>
    {:else}
      <span class="origin mono dim">
        {selected.reusable ? "promoted from an output" : "dropped file"}
      </span>
    {/if}
    {#if selected.path === thumbPath}
      <span class="badge accent">thumbnail</span>
    {/if}
    <span class="prompt" title={prompt ?? undefined}>{prompt ?? ""}</span>
    <div class="row actions">
      <button onclick={() => onthumb(selected)} disabled={selected.path === thumbPath}>
        <Star size={13} /> Set as thumbnail
      </button>
      {#if selected.reusable}
        <button onclick={() => onedit(selected)}>
          <PencilLine size={13} /> Reuse parameters
        </button>
      {/if}
      <button class="danger" onclick={() => ondelete(selected)}>
        <Trash2 size={13} /> Delete
      </button>
    </div>
  </div>

  <div class="strip scroll" bind:this={strip}>
    {#each samples as sample (sample.id)}
      <button
        class="thumb"
        class:current={sample.id === selected.id}
        data-sample-id={sample.id}
        aria-label={`Sample ${sample.id}`}
        onclick={() => onselect(sample)}
      >
        <MediaThumb src={sample.media_url} kind={sample.kind} lazy />
      </button>
    {/each}
  </div>
</div>

<style>
  .sample-viewer {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--canvas);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--app);
  }

  .back {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    background: var(--raised-2);
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .key {
    font-size: 10px;
    color: var(--text-4);
  }

  .nav button,
  .zoom button {
    padding: 4px 8px;
    font-size: 12px;
    display: flex;
  }

  .zoom button.active {
    background: var(--control-selected);
  }

  .position {
    font-size: 11px;
    color: var(--text-3);
    white-space: nowrap;
  }

  .media {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
  }

  .media img,
  .media video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    background: var(--raised);
    border-radius: var(--radius-input);
  }

  .media.one-to-one img,
  .media.one-to-one video {
    max-width: none;
    max-height: none;
  }

  .about {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    font-size: 12px;
    background: var(--app);
    min-width: 0;
  }

  .origin {
    font-size: 11px;
    white-space: nowrap;
  }

  .external {
    color: var(--accent);
    text-decoration: none;
  }

  .prompt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-3);
  }

  .actions {
    gap: 6px;
    flex: none;
  }

  .actions button {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 3px 8px;
  }

  .actions .danger {
    color: var(--error);
  }

  .strip {
    display: flex;
    gap: 6px;
    padding: 8px 12px 10px;
    overflow-x: auto;
    background: var(--app);
  }

  .thumb {
    width: 64px;
    height: 64px;
    flex: 0 0 auto;
    padding: 0;
    border-radius: var(--radius-control);
    overflow: hidden;
    background: var(--control);
    opacity: 0.6;
  }

  .thumb.current {
    opacity: 1;
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .thumb:hover {
    opacity: 1;
  }

  .fullscreen {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .fullscreen img,
  .fullscreen video {
    max-width: 100vw;
    max-height: 100vh;
    object-fit: contain;
  }

  @media (max-width: 1100px) {
    .back-label,
    .key {
      display: none;
    }
  }
</style>
