<script lang="ts">
  import { isVideoUrl, posterFrame } from "../lib/media.ts";

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
</script>

{#if src}
  {#if video}
    <!--
      Muted and silent: a wall of thumbnails is not something to hear, and a
      muted video is the only kind a browser will render without a gesture.
      `preload="metadata"` alone often leaves a black plate, so the source
      seeks a fraction in for a frame to paint.
    -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      src={posterFrame(src)}
      muted
      playsinline
      preload="metadata"
      tabindex="-1"
    ></video>
  {:else}
    <img {src} {alt} loading={lazy ? "lazy" : undefined} />
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
</style>
