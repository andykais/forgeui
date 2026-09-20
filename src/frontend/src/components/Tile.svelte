<script lang="ts">
  import type { Output } from "../types.ts";
  import { clock } from "../lib/format.ts";
  import { startOutputDrag } from "../lib/drag.ts";

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
  const isAudio = $derived(output.kind === "audio");

  /** A tile can be dragged straight into a media param (§11.2, lib/drag.ts). */
</script>

<div
  class="tile"
  class:selected
  role="group"
  data-output-id={output.id}
  draggable="true"
  ondragstart={(event) => startOutputDrag(event, output)}
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
    {:else if isAudio}
      <!--
        A drawn waveform (§2.2), which is the only picture sound has. It is
        two thirds of the tile and sits on the strip — and a take with no
        waveform yet still gets its duration and prompt from the strip below.
      -->
      <span class="wave">
        {#if output.waveform_url}
          <img src={output.waveform_url} alt="" loading="lazy" />
        {/if}
      </span>
    {:else}
      <img src={output.media_url} alt={output.prompt ?? output.id} loading="lazy" />
    {/if}
  </button>

  {#if isVideo || isAudio}
    <span class="badge kind">{isVideo ? "Video" : "Audio"}</span>
    {#if output.duration_ms}
      <span class="length mono">{clock(output.duration_ms)}</span>
    {/if}
  {/if}

  <!--
    What it was asked to sound like, above the waveform and in the same hue it
    was drawn in (§11.5). Drawn by the tile rather than baked into the picture:
    it stays crisp at every tile size, where text rendered into a 1000px-wide
    PNG and scaled down to 200 is a smudge.
  -->
  {#if isAudio && output.tone}
    <span class="tone mono" style={`color: ${output.tone_color ?? "var(--text-3)"}`}
      >{output.tone}</span
    >
  {/if}

  <div class="strip">
    <span class="prompt">{output.prompt ?? output.id}</span>
    <span class="meta mono dim">{output.family ?? output.workflow_id ?? ""}</span>
  </div>
</div>

<style>
  .tile {
    /* What the waveform stands on, in one place (§11.5). */
    --strip-height: 30px;
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

  /*
   * Edge to edge, and standing on the strip rather than floating in the
   * middle of the cell. The picture is drawn at 3:2 (`media/audio.ts`), so
   * full width makes it two thirds of a square tile, and the band left above
   * it is the tone line's. Centred, the same drawing read as a thing
   * suspended in an empty box; sitting on the strip it reads as a chart,
   * with the quiet end of the take where quiet belongs.
   *
   * Not stretched to fill: the y axis is amplitude, and scaling it would say
   * something false about the sound. A take drawn before this — an old row,
   * still 2.5:1 — is simply shorter, and sits in the same place.
   */
  .wave {
    position: absolute;
    left: 0;
    right: 0;
    bottom: var(--strip-height);
    display: block;
  }

  .wave img {
    display: block;
    width: 100%;
    height: auto;
  }

  /* Fit, not fill: a portrait or panoramic result is shown whole (§11.5). */
  img,
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  /*
   * The body size, 13px, rather than the 11px this started at. A tile is
   * read at arm's length beside a panel of 13px text, and shrinking the one
   * line that says what a take is made it the hardest thing on the screen to
   * read. It costs words on a small tile — the prompt is the first few rather
   * than the first phrase — and the title attribute still carries all of it.
   */
  .strip {
    position: absolute;
    inset: auto 0 0 0;
    height: var(--strip-height);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 7px;
    background: rgb(13 13 13 / 82%);
    font-size: 13px;
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
    font-size: 11px;
  }

  .badge.kind {
    position: absolute;
    top: 6px;
    left: 6px;
  }

  /*
   * Under the badge row and clear of it, on one line: the tone is a label, not
   * the prompt, and a tone that wrapped to three lines would bury the shape
   * it is supposed to be introducing.
   */
  .tone {
    position: absolute;
    inset: 27px 7px auto 7px;
    font-size: 13px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.92;
    pointer-events: none;
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
