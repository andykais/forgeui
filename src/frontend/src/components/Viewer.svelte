<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import PanelRight from "@lucide/svelte/icons/panel-right";
  import type { Job, Output, OutputDetail, UiScreen } from "../types.ts";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { dimensions } from "../lib/format.ts";
  import MetadataSidebar from "./MetadataSidebar.svelte";
  import Filmstrip from "./Filmstrip.svelte";

  /**
   * The one viewer component (§11.2), shared by Gallery's viewer and
   * Generate's focused view: media in the centre with Fit / 1:1 and a
   * size+zoom chip, the metadata sidebar on the right and the filmstrip along
   * the bottom, both collapsible with their state persisted per screen.
   */
  interface Props {
    screen: UiScreen;
    /** The ordered set the grid was showing; ← / → walk it. */
    outputs: Output[];
    selected: Output;
    runningJob?: Job | null;
    /** Generate's follow-latest chip (§11.4); omitted in Gallery. */
    following?: boolean | null;
    onselect: (output: Output) => void;
    onclose: () => void;
    onedit: (output: Output) => void;
    onrerun: (output: Output) => void;
    ondelete: (output: Output) => void;
    onfollow?: () => void;
  }

  let {
    screen,
    outputs,
    selected,
    runningJob = null,
    following = null,
    onselect,
    onclose,
    onedit,
    onrerun,
    ondelete,
    onfollow,
  }: Props = $props();

  let fit = $state(true);
  let fullscreen = $state(false);
  let detail = $state<OutputDetail | null>(null);
  let mediaBox: HTMLDivElement | undefined;
  let renderedWidth = $state(0);

  const sidebarCollapsed = $derived(app.sidebarCollapsed(screen));
  const filmstripCollapsed = $derived(app.filmstripCollapsed(screen));
  const index = $derived(outputs.findIndex((output) => output.id === selected.id));
  const isNewest = $derived(index === 0);

  /** The sidecar comes from the detail route (§12). */
  $effect(() => {
    const id = selected.id;
    detail = null;
    api
      .output(id)
      .then((loaded) => {
        if (selected.id === id) detail = loaded;
      })
      .catch(() => {});
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

  export function toggleFullscreen() {
    fullscreen = !fullscreen;
  }

  export function isFullscreen(): boolean {
    return fullscreen;
  }

  export function exitFullscreen(): boolean {
    if (!fullscreen) return false;
    fullscreen = false;
    return true;
  }
</script>

{#if fullscreen}
  <!-- Media only, no chrome, black field (§11.4). -->
  <div class="fullscreen" role="presentation" onclick={() => (fullscreen = false)}>
    {#if selected.kind === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={selected.media_url} controls autoplay loop></video>
    {:else}
      <img src={selected.media_url} alt={selected.prompt ?? selected.id} />
    {/if}
  </div>
{/if}

<div class="viewer">
  <div class="main">
    <header>
      <button class="back" onclick={onclose}>
        <ArrowLeft size={13} /> Back to grid <span class="key mono">esc</span>
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
      <button
        class="toggle"
        title={sidebarCollapsed ? "Show metadata" : "Hide metadata"}
        aria-label={sidebarCollapsed ? "Show metadata" : "Hide metadata"}
        onclick={() => app.setSidebarCollapsed(screen, !sidebarCollapsed)}
      >
        <PanelRight size={14} />
      </button>
    </header>

    <div class="media" class:one-to-one={!fit} bind:this={mediaBox}>
      {#if following !== null}
        <button class="follow-chip" class:pinned={!following} onclick={onfollow}>
          {following ? "following latest" : `pinned · ${selected.id.slice(-7)}`}
        </button>
      {/if}
      {#if following && isNewest}
        <span class="newest badge accent">newest</span>
      {/if}
      {#if selected.kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={selected.media_url} controls loop></video>
      {:else}
        <img src={selected.media_url} alt={selected.prompt ?? selected.id} />
      {/if}
      <span class="size-chip mono">
        {dimensions(selected.width, selected.height, selected.duration_ms)}
        · shown at {zoom}%
      </span>
    </div>

    <Filmstrip
      {outputs}
      selectedId={selected.id}
      collapsed={filmstripCollapsed}
      {runningJob}
      oncollapse={(collapsed) => app.setFilmstripCollapsed(screen, collapsed)}
      onselect={(output) => onselect(output)}
    />
  </div>

  {#if !sidebarCollapsed}
    {#if detail}
      <MetadataSidebar
        output={detail}
        onedit={() => onedit(selected)}
        onrerun={() => onrerun(selected)}
        ondelete={() => ondelete(selected)}
      />
    {:else}
      <aside class="sidebar-loading"><span class="dim">loading metadata…</span></aside>
    {/if}
  {:else}
    <!-- Collapsed, the sidebar becomes a thin edge (§11.2). -->
    <button
      class="edge"
      title="Show metadata"
      aria-label="Show metadata"
      onclick={() => app.setSidebarCollapsed(screen, false)}
    ></button>
  {/if}
</div>

<style>
  .viewer {
    flex: 1;
    display: flex;
    min-height: 0;
    /*
     * Load-bearing. Without it this is a flex item at `min-width: auto`, so
     * its min-content width wins over the flex basis — and its min-content is
     * the filmstrip laid out in full, which grows with every result. The row
     * then overflows, the filmstrip's `scrollIntoView` scrolls the whole
     * screen sideways to follow the selection, and the sidebar walks off the
     * right edge until it is gone.
     */
    min-width: 0;
    background: var(--canvas);
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
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
  }

  .key {
    font-size: 10px;
    color: var(--text-4);
  }

  .nav button,
  .zoom button,
  .toggle {
    padding: 4px 8px;
    font-size: 12px;
    display: flex;
  }

  .zoom button.active {
    background: var(--control-selected);
  }

  .id {
    font-size: 11px;
    color: var(--text-3);
    padding: 0 4px;
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

  .follow-chip.pinned {
    background: var(--raised-2);
    color: var(--text-4);
  }

  .newest {
    position: absolute;
    top: 22px;
    right: 24px;
  }

  .sidebar-loading {
    width: 306px;
    flex: 0 0 auto;
    background: var(--panel);
    padding: 12px;
    font-size: 12px;
  }

  .edge {
    width: 10px;
    flex: 0 0 auto;
    border-radius: 0;
    background: var(--panel);
  }

  .edge:hover {
    background: var(--raised-2);
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
