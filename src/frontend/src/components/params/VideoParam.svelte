<script lang="ts">
  import Film from "@lucide/svelte/icons/film";
  import X from "@lucide/svelte/icons/x";
  import { untrack } from "svelte";
  import { api, ApiError } from "../../api.ts";
  import { draggedOutput } from "../../lib/drag.ts";
  import { clock } from "../../lib/format.ts";
  import type { Param } from "../../types.ts";

  /**
   * A `video` param (§4.3, §9). The same idea and the same binding as an
   * `audio` param — the value is `<sha256>.<ext>`, uploaded here so the server
   * has the bytes before Generate is pressed — showing a player, because what
   * a source video looks like in motion is the whole question about it.
   *
   * No paste, for the reason audio has none: a clipboard does not hold video.
   */
  interface Props {
    param: Param;
    value: string;
    onchange: (filename: string) => void;
  }

  let { param, value, onchange }: Props = $props();

  let input = $state<HTMLInputElement | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let over = $state(false);
  /** What was attached here; the value itself is only a name. */
  let attached = $state<{
    filename: string;
    url: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  } | null>(null);

  const shown = $derived(attached?.filename === value ? attached : null);
  /** The store is addressed by the value itself, so it can play at once. */
  const fallbackUrl = $derived(
    value && !shown ? `/api/media/inputs/${value.slice(0, 2)}/${value}` : null,
  );

  $effect(() => {
    const filename = value;
    if (filename === "" || untrack(() => attached?.filename === filename)) {
      return;
    }
    let current = true;
    api
      .input(filename.replace(/\.[^.]+$/, ""))
      .then((media) => {
        if (current) attached = fromMedia(media);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });

  function fromMedia(media: {
    filename: string;
    url: string;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
  }) {
    return {
      filename: media.filename,
      url: media.url,
      width: media.width,
      height: media.height,
      durationMs: media.duration_ms,
    };
  }

  function failed(cause: unknown): string {
    if (cause instanceof ApiError || cause instanceof Error) {
      return cause.message;
    }
    return String(cause);
  }

  async function take(file: File | Blob | null | undefined) {
    if (!file) return;
    busy = true;
    error = null;
    try {
      const media = await api.uploadInput(file, "clip.mp4");
      if (media.kind !== "video") {
        error =
          `that is ${media.kind === "audio" ? "a sound" : "a picture"}, ` + `not a video`;
        return;
      }
      attached = fromMedia(media);
      onchange(media.filename);
    } catch (cause) {
      error = failed(cause);
    } finally {
      busy = false;
    }
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    over = false;
    // A video dragged out of the results is adopted rather than sent back up
    // again: the bytes are already on the server (§9).
    const dragged = draggedOutput(event);
    if (dragged) {
      if (dragged.kind && dragged.kind !== "video") {
        error = `this takes a video, not ${
          dragged.kind === "audio" ? "a sound" : "a picture"
        }`;
        return;
      }
      busy = true;
      error = null;
      try {
        const media = await api.adoptOutput(dragged.id);
        attached = fromMedia(media);
        onchange(media.filename);
      } catch (cause) {
        error = failed(cause);
      } finally {
        busy = false;
      }
      return;
    }
    take(event.dataTransfer?.files?.[0]);
  }

  function clear() {
    attached = null;
    error = null;
    onchange("");
  }

  const meta = $derived.by(() => {
    if (!shown) return "attached";
    const parts: string[] = [];
    if (shown.width && shown.height) parts.push(`${shown.width}×${shown.height}`);
    if (shown.durationMs) parts.push(clock(shown.durationMs));
    return parts.length > 0 ? parts.join(" · ") : "attached";
  });
</script>

<div class="wrap">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="zone"
    class:over
    class:filled={value !== ""}
    role="button"
    tabindex="0"
    aria-label={`${param.label ?? param.key}: choose or drop a video`}
    onclick={(event) => {
      // The transport is inside the zone, so a click on it must not also
      // open the file dialog.
      if ((event.target as HTMLElement).closest("video")) return;
      input?.click();
    }}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input?.click();
      }
    }}
    ondrop={onDrop}
    ondragover={(event) => {
      event.preventDefault();
      over = true;
    }}
    ondragleave={() => (over = false)}
  >
    {#if value !== ""}
      <div class="clip">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={shown?.url ?? fallbackUrl}
          controls
          muted
          loop
          playsinline
          preload="metadata"
        ></video>
        <div class="meta mono dim">{meta}</div>
      </div>
    {:else}
      <div class="empty">
        <Film size={18} />
        <span>{busy ? "reading…" : "Choose or drop a video"}</span>
      </div>
    {/if}
  </div>

  {#if value !== ""}
    <button
      class="clear"
      title="Remove this video"
      aria-label="Remove this video"
      onclick={clear}
    >
      <X size={12} />
    </button>
  {/if}

  <input
    class="file"
    type="file"
    accept="video/*,.mp4,.mov,.webm,.mkv"
    bind:this={input}
    onchange={(event) => {
      const target = event.currentTarget as HTMLInputElement;
      take(target.files?.[0]);
      // So choosing the same file twice in a row still fires.
      target.value = "";
    }}
  />

  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .wrap {
    position: relative;
  }

  /* The same dashed zone an image or audio param uses. */
  .zone {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 96px;
    border: 1px dashed var(--line-2);
    border-radius: var(--radius-input);
    background: var(--control);
    cursor: pointer;
    overflow: hidden;
    position: relative;
  }

  .zone:hover,
  .zone.over {
    border-color: var(--accent);
  }

  .zone.filled {
    border-style: solid;
    cursor: default;
  }

  .clip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 8px;
  }

  .clip video {
    display: block;
    width: 100%;
    max-height: 240px;
    background: #000;
    border-radius: 2px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    color: var(--text-4);
    font-size: 12px;
  }

  .meta {
    font-size: 10px;
    text-align: right;
  }

  .clear {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    background: rgb(0 0 0 / 55%);
    color: var(--text-2);
    padding: 3px;
  }

  .clear:hover {
    background: rgb(0 0 0 / 75%);
    color: var(--text);
  }

  .file {
    display: none;
  }

  .error {
    margin: 4px 0 0;
    color: var(--error);
    font-size: 11px;
  }
</style>
