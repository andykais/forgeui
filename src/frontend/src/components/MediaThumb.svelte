<script lang="ts">
  import {
    isAudioUrl,
    isVideoUrl,
    posterFrame,
    waveformUrl,
  } from "../lib/media.ts";

  /**
   * One thumbnail, whatever the media is (§11.5).
   *
   * Every small picture of an output — a workflow's last run, a model's tile,
   * a lineage node, a sample — used to be an `<img>`, which draws the
   * browser's broken-image outline the moment the output is a video. This
   * picks the element by what the file is: `kind` where the caller has it,
   * the extension where all it has is a URL.
   */
  interface Props {
    src: string | null | undefined;
    /** `image` / `video` where it is known; otherwise read from the URL. */
    kind?: string | null;
    alt?: string;
    /** Off the critical path: a grid of these should not fetch all at once. */
    lazy?: boolean;
  }

  let { src, kind = null, alt = "", lazy = false }: Props = $props();

  const video = $derived(kind ? kind === "video" : isVideoUrl(src));
  /**
   * Sound has no frame to show, so the thumbnail is the waveform ffmpeg drew
   * beside it. Pointing an `<img>` at the audio file itself is what put a
   * broken-image outline on the workflow card and the model tiles.
   */
  const audio = $derived(kind ? kind === "audio" : isAudioUrl(src));
  const picture = $derived(audio ? waveformUrl(src) : src);

  /**
   * And if that picture is not there — no ffmpeg on the machine, a file
   * deleted underneath — nothing is better than a broken plate.
   */
  let broken = $state(false);
  $effect(() => {
    picture;
    broken = false;
  });
</script>

{#if picture && !broken}
  {#if video}
    <!--
      Muted and silent: a wall of thumbnails is not something to hear, and a
      muted video is the only kind a browser will render without a gesture.
      `preload="metadata"` alone often leaves a black plate, so the source
      seeks a fraction in for a frame to paint.
    -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      src={posterFrame(picture)}
      muted
      playsinline
      preload="metadata"
      tabindex="-1"
    ></video>
  {:else}
    <img
      src={picture}
      {alt}
      class:wave={audio}
      loading={lazy ? "lazy" : undefined}
      onerror={() => (broken = true)}
    />
  {/if}
{/if}

<style>
  /*
   * The two elements have to be interchangeable: every caller sizes its own
   * thumb box and styled `img` alone, so the video matches it rather than
   * each of eight call sites growing a second rule.
   */
  img,
  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /*
   * A waveform is a wide strip, and cropping one to a square thumb keeps a
   * sixth of a take — often the quiet middle, which reads as an empty box.
   * The whole clip, letterboxed, is the only honest version at this size.
   */
  img.wave {
    object-fit: contain;
    opacity: 0.85;
  }
</style>
