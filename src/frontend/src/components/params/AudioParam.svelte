<script lang="ts">
  import AudioLines from "@lucide/svelte/icons/audio-lines";
  import X from "@lucide/svelte/icons/x";
  import { untrack } from "svelte";
  import { api, ApiError } from "../../api.ts";
  import { draggedOutput } from "../../lib/drag.ts";
  import { clock } from "../../lib/format.ts";
  import type { Param } from "../../types.ts";

  /**
   * An `audio` param (DESIGN-AUDIO §2.3, §4.2). The same idea as an `image`
   * param and the same binding — what the value holds is `<sha256>.<ext>`,
   * uploaded here so the server has the bytes before Generate is pressed —
   * with two differences that come from what sound is.
   *
   * It does not take a paste: a clipboard rarely holds audio, and the
   * hover-to-paste rule exists for screenshots. And it shows a player rather
   * than a thumbnail, because the whole question about a reference voice is
   * what it sounds like — a picture of it is not an answer.
   */
  interface Props {
    param: Param;
    value: string;
    onchange: (filename: string) => void;
    /** What was attached, so a duration can follow the clip (§11.3). */
    onattach?: (media: { duration_ms: number | null }) => void;
  }

  let { param, value, onchange, onattach }: Props = $props();

  let input = $state<HTMLInputElement | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let over = $state(false);
  /** What was attached here; the value itself is only a name. */
  let attached = $state<
    {
      filename: string;
      url: string;
      waveform: string | null;
      durationMs: number | null;
    } | null
  >(null);

  const shown = $derived(attached?.filename === value ? attached : null);
  /**
   * A value that arrived from somewhere else — a previous run, a clip dragged
   * in — can be played straight away, because the store is addressed by
   * exactly the name the value holds. The rest (how long, what it looks like)
   * is then asked for.
   */
  const fallbackUrl = $derived(
    value && !shown ? `/api/media/inputs/${value.slice(0, 2)}/${value}` : null,
  );

  $effect(() => {
    const filename = value;
    if (filename === "" || untrack(() => attached?.filename === filename)) {
      return;
    }
    let current = true;
    api.input(filename.replace(/\.[^.]+$/, ""))
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
    waveform_url: string | null;
    duration_ms: number | null;
  }) {
    return {
      filename: media.filename,
      url: media.url,
      waveform: media.waveform_url,
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
      const media = await api.uploadInput(file, "clip.wav");
      attached = fromMedia(media);
      onchange(media.filename);
      onattach?.(media);
    } catch (cause) {
      error = failed(cause);
    } finally {
      busy = false;
    }
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    over = false;
    // A take dragged out of the results: the bytes are already on the server,
    // so it is adopted rather than sent back up again (§9).
    const dragged = draggedOutput(event);
    if (dragged) {
      // A picture has no sound in it. Taking one anyway used to leave a clip
      // that would not play and a run that failed in ComfyUI.
      if (dragged.kind && dragged.kind !== "audio") {
        error = `${dragged.kind} has no sound in it — this takes an audio take`;
        return;
      }
      busy = true;
      error = null;
      try {
        const media = await api.adoptOutput(dragged.id);
        attached = fromMedia(media);
        onchange(media.filename);
        onattach?.(media);
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
</script>

<div class="wrap">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="zone"
    class:over
    class:filled={value !== ""}
    role="button"
    tabindex="0"
    aria-label={`${param.label ?? param.key}: choose or drop an audio clip`}
    onclick={(event) => {
      // The transport is inside the zone, so a click on play must not also
      // open the file dialog.
      if ((event.target as HTMLElement).closest("audio")) return;
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
        {#if shown?.waveform}
          <img class="wave" src={shown.waveform} alt="" />
        {/if}
        <audio src={shown?.url ?? fallbackUrl} controls preload="metadata"
        ></audio>
        <div class="meta mono dim">
          {shown?.durationMs ? clock(shown.durationMs) : "attached"}
        </div>
      </div>
    {:else}
      <div class="empty">
        <AudioLines size={18} />
        <span>{busy ? "reading…" : "Choose or drop an audio clip"}</span>
      </div>
    {/if}
  </div>

  {#if value !== ""}
    <button
      class="clear"
      title="Remove this clip"
      aria-label="Remove this clip"
      onclick={clear}
    >
      <X size={12} />
    </button>
  {/if}

  <input
    class="file"
    type="file"
    accept="audio/*,.wav,.flac,.mp3,.opus,.ogg,.m4a"
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

  /* The same dashed zone an image param uses, so the two read as one idea. */
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

  /*
   * Stretched to the width rather than letterboxed: the x axis is time, and
   * all of it belongs here — a clip is attached to be heard end to end. Only
   * the amplitude is squashed, which is the axis a strip this short cannot
   * show anyway.
   */
  .clip .wave {
    display: block;
    width: 100%;
    height: 40px;
    object-fit: fill;
    opacity: 0.85;
  }

  .clip audio {
    width: 100%;
    height: 32px;
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
