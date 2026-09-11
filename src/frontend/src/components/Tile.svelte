<script lang="ts">
  import type { Output } from "../types.ts";
  import { clock } from "../lib/format.ts";

  /**
   * One media tile (§11.5): always a square cell with the whole image fitted
   * inside it, and a 24–26px metadata strip. Video and image are the same
   * component — the kind only changes the badge and hover playback (§11.3).
   *
   * Selection is a highlight and nothing else: no overlay, no dimming and no
   * buttons. Opening a tile is what offers the actions, in the viewer's
   * sidebar, so nothing here depends on a tile being "current".
   *
   * Hover and selection both read from outside the tile as well as in: a
   * square image fills the cell edge to edge and leaves no letterbox to tint,
   * so a tint alone is invisible on exactly the pictures people generate.
   */
  interface Props {
    output: Output;
    selected?: boolean;
    onopen?: (output: Output) => void;
  }

  let { output, selected = false, onopen }: Props = $props();

  let video = $state<HTMLVideoElement | undefined>(undefined);
  const isVideo = $derived(output.kind === "video");
</script>

<div
  class="tile"
  class:selected
  role="group"
  data-output-id={output.id}
  onmouseenter={() => video?.play().catch(() => {})}
  onmouseleave={() => video?.pause()}
>
  <button
    class="surface"
    title={output.prompt ?? output.id}
    onclick={() => onopen?.(output)}
  >
    {#if isVideo}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={video}
        src={output.media_url}
        muted
        loop
        playsinline
        preload="metadata"
      ></video>
    {:else}
      <img src={output.media_url} alt={output.prompt ?? output.id} loading="lazy" />
    {/if}
  </button>

  {#if isVideo}
    <span class="badge kind">Video</span>
    {#if output.duration_ms}
      <span class="length mono">{clock(output.duration_ms)}</span>
    {/if}
  {/if}

  <div class="strip">
    <span class="prompt">{output.prompt ?? output.id}</span>
    <span class="meta mono dim">{output.family ?? output.workflow_id ?? ""}</span>
  </div>
</div>

<style>
  .tile {
    position: relative;
    aspect-ratio: 1;
    border-radius: var(--radius-input);
    overflow: hidden;
    background: var(--raised);
    transition: box-shadow 110ms var(--ease);
  }

  /* Outside the tile's own edge, where a full-bleed image cannot cover it. */
  .tile:hover {
    box-shadow:
      0 0 0 1px rgb(255 255 255 / 22%),
      0 2px 14px rgb(0 0 0 / 45%);
  }

  /* A soft highlight, so a selected tile reads as chosen without hiding it. */
  .tile.selected {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    box-shadow:
      0 0 0 1px var(--accent),
      0 2px 16px rgb(0 0 0 / 55%);
  }

  .surface {
    all: unset;
    /* `all` resets `box-sizing` to `content-box`; keep the global border-box
       so anything bordered here stays inside its 100% box. */
    box-sizing: border-box;
    display: block;
    width: 100%;
    height: 100%;
    cursor: pointer;
    background: transparent;
  }

  /* The letterbox behind a fitted image; the ring above carries the rest. */
  .tile:hover .surface {
    background: var(--control-selected);
  }

  /* Fit, not fill: a portrait or panoramic result is shown whole (§11.5). */
  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .strip {
    position: absolute;
    inset: auto 0 0 0;
    height: 25px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 7px;
    background: rgb(13 13 13 / 82%);
    font-size: 11px;
    pointer-events: none;
  }

  .prompt {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-2);
  }

  .meta {
    font-size: 10px;
  }

  .badge.kind {
    position: absolute;
    top: 6px;
    left: 6px;
  }

  .length {
    position: absolute;
    top: 6px;
    right: 6px;
    font-size: 10px;
    padding: 1px 4px;
    border-radius: var(--radius-control);
    background: rgb(13 13 13 / 82%);
    color: var(--text-2);
  }
</style>
