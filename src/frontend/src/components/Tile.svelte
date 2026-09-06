<script lang="ts">
  import type { Output } from "../types.ts";
  import { clock } from "../lib/format.ts";

  /**
   * One media tile (§11.5): always square, cropped to fill, with a 24–26px
   * metadata strip. Video and image are the same component — the kind only
   * changes the badge and hover playback (§11.3). The action overlay appears
   * on hover and stays on the selected tile, and its buttons are focusable.
   *
   * Phase 1 ships only the two actions that exist: Use in workflow and
   * Upscale image belong to Phase 3 and are deliberately absent.
   */
  interface Props {
    output: Output;
    selected?: boolean;
    onopen?: (output: Output) => void;
    onedit?: (output: Output) => void;
    onrerun?: (output: Output) => void;
  }

  let { output, selected = false, onopen, onedit, onrerun }: Props = $props();

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

  <div class="actions" class:visible={selected} class:empty={!onedit && !onrerun}>
    {#if onedit}
      <button onclick={() => onedit?.(output)}>Edit in Generate →</button>
    {/if}
    {#if onrerun}
      <button onclick={() => onrerun?.(output)}>Rerun now ⟳</button>
    {/if}
  </div>

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
  }

  .tile.selected {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .surface {
    all: unset;
    display: block;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }

  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
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

  .actions.empty {
    display: none;
  }

  .actions {
    position: absolute;
    inset: 0 0 25px 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 5px;
    padding: 0 8px;
    background: rgb(13 13 13 / 62%);
    opacity: 0;
    transition: opacity 90ms var(--ease);
    /* Clicking the tile opens it; only the buttons take the pointer. */
    pointer-events: none;
  }

  .tile:hover .actions,
  .actions.visible,
  .actions:focus-within {
    opacity: 1;
  }

  .actions button {
    font-size: 11px;
    padding: 3px 7px;
    background: var(--raised-2);
    pointer-events: auto;
  }

  .actions button:hover {
    background: var(--control-selected);
  }
</style>
