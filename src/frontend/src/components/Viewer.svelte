<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import type { Job, Layout, Output, OutputDetail, UiScreen } from "../types.ts";
  import { hasMetadata } from "../types.ts";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { clock, dimensions } from "../lib/format.ts";
  import MetadataSidebar from "./MetadataSidebar.svelte";
  import Filmstrip from "./Filmstrip.svelte";
  import LayoutPicker from "./LayoutPicker.svelte";

  /**
   * The one viewer component (§11.2), shared by Gallery's viewer and
   * Generate's focused view: media in the centre with Fit / 1:1 and a
   * size+zoom chip, the metadata sidebar on the right and the filmstrip along
   * the bottom, both collapsible with their state persisted per screen.
   */
  interface Props {
    screen: UiScreen;
    /** Where the media and the metadata go (§11.3). */
    layout: Layout;
    /**
     * The parent is already the grid these panes belong to, so disappear
     * into it: `display: contents`, and the media and the metadata become
     * items of *its* grid. That is what lets Generate put the metadata
     * beside the inputs, which is on the other side of this component.
     */
    dissolve?: boolean;
    /** The ordered set the grid was showing; ← / → walk it. */
    outputs: Output[];
    selected: Output;
    /** What has not landed yet, for the head of the filmstrip (§11.2). */
    activeJobs?: Job[];
    /** Generate's follow-latest chip (§11.4); omitted in Gallery. */
    following?: boolean | null;
    onselect: (output: Output) => void;
    onclose: () => void;
    onedit: (output: Output) => void;
    onrerun: (output: Output) => void;
    ondelete: (output: Output) => void;
    /** Upscale this output with the named workflow (§10). */
    onupscale?: (output: Output, workflowId: string) => void;
    /** Open another output by id — a lineage node (§11.2). */
    onopenoutput?: (id: string) => void;
    onfollow?: () => void;
  }

  let {
    screen,
    layout,
    dissolve = false,
    outputs,
    selected,
    activeJobs = [],
    following = null,
    onselect,
    onclose,
    onedit,
    onrerun,
    ondelete,
    onupscale,
    onopenoutput,
    onfollow,
  }: Props = $props();

  let fit = $state(true);
  let fullscreen = $state(false);
  const isAudio = $derived(selected.kind === "audio");
  /**
   * The two video elements — the one in the page and the one over it —
   * exist at the same time while fullscreen is up, and both would play: the
   * page carried on behind the black field, so an LTX clip with sound played
   * its audio twice, a frame or two apart. Only the one on top plays, and
   * the position is handed across so the picture does not jump back to zero.
   */
  let inlineVideo = $state<HTMLVideoElement | undefined>(undefined);
  let fullVideo = $state<HTMLVideoElement | undefined>(undefined);
  let detail = $state<OutputDetail | null>(null);
  let mediaBox: HTMLDivElement | undefined;
  let renderedWidth = $state(0);

  /** Three of the five layouts have a metadata pane; two do not (§11.3). */
  const showMetadata = $derived(hasMetadata(layout));
  const filmstripCollapsed = $derived(app.filmstripCollapsed(screen));
  const index = $derived(outputs.findIndex((output) => output.id === selected.id));
  const isNewest = $derived(index === 0);

  /**
   * The sidecar comes from the detail route (§12). The sidebar that is up
   * stays up while the next one loads: clearing it first swaps in a
   * placeholder, which unmounts and remounts the whole sidebar and reads as a
   * flicker on every step through the strip. Only a failed load empties it,
   * so a stale panel is never left standing for an output that has none.
   */
  $effect(() => {
    const id = selected.id;
    api
      .output(id)
      .then((loaded) => {
        if (selected.id === id) detail = loaded;
      })
      .catch(() => {
        if (selected.id === id) detail = null;
      });
  });

  $effect(() => {
    if (!mediaBox) return;
    const observer = new ResizeObserver(() => {
      const image = mediaBox?.querySelector("img, video") as HTMLElement | null;
      renderedWidth = image?.clientWidth ?? 0;
    });
    observer.observe(mediaBox);
    return () => observer.disconnect();
  });

  const zoom = $derived(
    selected.width && renderedWidth
      ? Math.round((renderedWidth / selected.width) * 100)
      : 100,
  );

  export function step(delta: number) {
    const next = outputs[index + delta];
    if (next) onselect(next);
    // → past the newest resumes following (§11.4).
    else if (delta < 0 && index === 0) onfollow?.();
  }

  $effect(() => {
    const inline = inlineVideo;
    const full = fullVideo;
    if (!inline) return;
    if (fullscreen) {
      const at = inline.currentTime;
      inline.pause();
      if (full) {
        full.currentTime = at;
        full.play().catch(() => {});
      }
      return;
    }
    // Back from fullscreen: pick the clip up where it was left.
    inline.play().catch(() => {});
  });

  /** Hand the position back before the fullscreen element goes. */
  function leaveFullscreen() {
    if (fullVideo && inlineVideo) inlineVideo.currentTime = fullVideo.currentTime;
    fullscreen = false;
  }

  export function toggleFullscreen() {
    if (fullscreen) {
      leaveFullscreen();
      return;
    }
    // A black field with a waveform on it is not a fullscreen anything: there
    // is nothing to see bigger, so `f` does nothing on an audio output.
    if (isAudio) return;
    fullscreen = true;
  }

  export function isFullscreen(): boolean {
    return fullscreen;
  }

  export function exitFullscreen(): boolean {
    if (!fullscreen) return false;
    leaveFullscreen();
    return true;
  }
</script>

{#if fullscreen}
  <!-- Media only, no chrome, black field (§11.4). -->
  <div class="fullscreen" role="presentation" onclick={leaveFullscreen}>
    {#if selected.kind === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={fullVideo} src={selected.media_url} controls autoplay loop
      ></video>
    {:else}
      <img src={selected.media_url} alt={selected.prompt ?? selected.id} />
    {/if}
  </div>
{/if}

<div class="viewer" class:dissolve data-layout={layout}>
  <div class="main">
    <header>
      <button class="back" onclick={onclose} title="Back to grid">
        <ArrowLeft size={13} />
        <span class="back-label">Back to grid</span>
        <span class="key mono">esc</span>
      </button>
      <span class="spacer"></span>
      <div class="row nav">
        <button
          title="Older"
          aria-label="Older"
          disabled={index >= outputs.length - 1}
          onclick={() => step(1)}
        >
          <ArrowLeft size={13} />
        </button>
        <button title="Newer" aria-label="Newer" onclick={() => step(-1)}>
          <ArrowRight size={13} />
        </button>
      </div>
      <div class="row zoom">
        <button class:active={fit} onclick={() => (fit = true)}>Fit</button>
        <button class:active={!fit} onclick={() => (fit = false)}>1:1</button>
      </div>
      <span class="id mono">{selected.id}</span>
      <LayoutPicker {screen} />
    </header>

    <div class="media" class:one-to-one={!fit} bind:this={mediaBox}>
      <!--
        Two different things wearing one shape before: while it is following,
        the chip is a label and does nothing when clicked, so it no longer
        offers itself as a button; pinned, it is the way back, and says so.
      -->
      {#if following === true}
        <span class="follow-chip">latest</span>
      {:else if following === false}
        <button class="follow-chip jump" onclick={onfollow}>jump to latest</button>
      {/if}
      {#if following && isNewest}
        <span class="newest badge accent">newest</span>
      {/if}
      {#if selected.kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={inlineVideo}
          src={selected.media_url}
          controls
          autoplay
          loop
        ></video>
      {:else if isAudio}
        <!--
          The waveform is the picture, and the transport sits under it: a take
          is something you listen to, so it plays on open the way a video does.
        -->
        <div class="audio">
          {#if selected.waveform_url}
            <img class="wave" src={selected.waveform_url} alt="" />
          {/if}
          <audio src={selected.media_url} controls autoplay></audio>
        </div>
      {:else}
        <img src={selected.media_url} alt={selected.prompt ?? selected.id} />
      {/if}
      {#if !isAudio}
        <span class="size-chip mono">
          {dimensions(selected.width, selected.height, selected.duration_ms)}
          · shown at {zoom}%
        </span>
      {:else if selected.duration_ms}
        <span class="size-chip mono">{clock(selected.duration_ms)}</span>
      {/if}
    </div>

    <Filmstrip
      {outputs}
      selectedId={selected.id}
      collapsed={filmstripCollapsed}
      {activeJobs}
      oncollapse={(collapsed) => app.setFilmstripCollapsed(screen, collapsed)}
      onselect={(output) => onselect(output)}
    />
  </div>

  {#if showMetadata}
    {#if detail}
      <MetadataSidebar
        output={detail}
        onedit={() => onedit(selected)}
        onrerun={() => onrerun(selected)}
        ondelete={() => ondelete(selected)}
        onupscale={onupscale
          ? (workflowId) => onupscale(selected, workflowId)
          : undefined}
        onopen={onopenoutput}
      />
    {:else}
      <aside class="sidebar-loading"><span class="dim">loading metadata…</span></aside>
    {/if}
  {/if}
</div>

<style>
  /*
   * Sound in the place a picture would be: the waveform as wide as the box
   * allows, the transport under it, both centred so a short take does not
   * sit in the top-left corner of an empty field.
   */
  .audio {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    width: min(760px, 100%);
    margin: auto;
    padding: 0 16px;
  }

  /*
   * Bounded on both axes rather than stretched to the box and capped: with
   * `width: 100%` and a max height, the element stayed 760px wide and
   * `contain` letterboxed the picture inside it — so making the drawing
   * taller (3:2, `media/audio.ts`) made the waveform *narrower*. Sized by
   * whichever limit it reaches first, it simply gets as large as it fits.
   */
  .audio .wave {
    width: auto;
    max-width: 100%;
    max-height: 420px;
    object-fit: contain;
  }

  .audio audio {
    width: 100%;
  }

  /*
   * The grid of §11.3, for the screens where this component is the whole of
   * it — Gallery, which has media and metadata and nothing else. Generate
   * has an inputs panel on the other side of this component, so there the
   * grid is its, and this dissolves into it.
   */
  .viewer {
    flex: 1;
    display: grid;
    /*
     * Load-bearing, and was before this was a grid. Without it this is a
     * flex item at `min-width: auto`, so its min-content width wins — and
     * its min-content is the filmstrip laid out in full, which grows with
     * every result. The row then overflows, the filmstrip's
     * `scrollIntoView` scrolls the whole screen sideways to follow the
     * selection, and the sidebar walks off the right edge until it is gone.
     */
    min-width: 0;
    min-height: 0;
  }

  .viewer[data-layout="columns"] {
    grid-template-columns: minmax(0, 1fr) var(--sidebar-width);
    grid-template-areas: "media meta";
  }

  .viewer[data-layout="split"] {
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas: "media" "meta";
  }

  .viewer[data-layout="wide"] {
    grid-template-areas: "media";
  }

  /* Generate's grid owns these panes; this box is in the way of that. */
  .viewer.dissolve {
    display: contents;
  }

  .main {
    grid-area: media;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    /* The plate the media sits on, which `.viewer` carried until it could
       no longer be relied on to have a box at all. */
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
    /* It used to wrap to three lines in a narrow window, taking the header
       with it and pushing the metadata toggle off the right edge. */
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

  /*
   * The one thing here that may be cut short: a ULID is 26 characters of
   * mono, it is the widest item in the row, and nothing is decided by it.
   */
  .id {
    font-size: 11px;
    color: var(--text-3);
    padding: 0 4px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .media {
    position: relative;
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

  .size-chip {
    position: absolute;
    left: 24px;
    bottom: 24px;
    font-size: 11px;
    padding: 3px 7px;
    border-radius: var(--radius-control);
    background: rgb(13 13 13 / 82%);
    color: var(--text-2);
  }

  .follow-chip {
    position: absolute;
    top: 22px;
    left: 24px;
    z-index: 1;
    font-size: 11px;
    padding: 3px 8px;
    background: var(--accent-tint);
    color: var(--accent);
  }

  /* A label, not a control: nothing happens on click, so nothing lights up. */
  span.follow-chip {
    border-radius: var(--radius-control);
    cursor: default;
  }

  .follow-chip.jump {
    background: var(--raised-2);
    color: var(--text-2);
  }

  .follow-chip.jump:hover {
    background: var(--control);
    color: var(--text);
  }

  .newest {
    position: absolute;
    top: 22px;
    right: 24px;
  }

  .sidebar-loading {
    grid-area: meta;
    min-width: 0;
    min-height: 0;
    background: var(--panel);
    padding: 12px;
    font-size: 12px;
  }

  /*
   * Too narrow for three columns — the app in one half of a split monitor,
   * which is how it is actually used beside an editor (§11.3).
   *
   * Side by side, the two fixed columns (360px of params, 306px of metadata)
   * plus the rail leave the media `width - 722`: 238px in a half-screen 1080p
   * window, a sliver with a 1024px picture shown at 20%. 1100px is where that
   * remainder falls below the width of the params panel itself, and there is
   * no width left to take from — so the metadata takes height instead: media
   * above, metadata below, half each. `Escape` and the toggle both still do
   * what they did.
   *
   * Width *and* aspect, because aspect alone does not survive a real browser:
   * a window occupying half of a 1920×1080 screen is 960×1080 on the outside
   * but 960×990 or so inside, once the tab strip and the address bar have
   * taken their share — 0.97, comfortably above 8/9, so the rule never fired
   * for anyone who was not running a browser with no chrome at all. The
   * aspect clause stays for the case width alone misses: a tall, narrow
   * window on a large monitor, where a portrait display wants stacking too.
   */
  @media (max-width: 1100px), (max-aspect-ratio: 8 / 9) {
    /*
     * Beside the media there is no room for a 306px column, so the metadata
     * takes height instead — which is what the `split` layout is, arrived at
     * by the window rather than by the picker.
     */
    .viewer[data-layout="columns"] {
      grid-template-columns: none;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas: "media" "meta";
    }

    /* What the row can no longer afford. The id is in the sidebar. */
    .id,
    .back-label,
    .key {
      display: none;
    }
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
</style>
