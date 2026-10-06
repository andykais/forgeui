<script lang="ts">
  import Brush from "@lucide/svelte/icons/brush";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";
  import { api, ApiError } from "../../api.ts";
  import { inputUrl } from "../../lib/mask.ts";
  import type { Param } from "../../types.ts";
  import MaskEditor from "./MaskEditor.svelte";

  /**
   * A `mask` param (§10): the picture its `of` names with the mask tinted
   * over it, and a button into the editor. There is nothing to paint on
   * until that picture is attached, so until then it says so rather than
   * opening on an empty canvas.
   */
  interface Props {
    param: Param;
    /** The mask: `<sha256>.png`, or "" for none. */
    value: string;
    /** The picture it is painted over: the `of` param's value. */
    image: string;
    /** That picture's label, to say what to attach first. */
    imageLabel: string;
    onchange: (filename: string) => void;
  }

  let { param, value, image, imageLabel, onchange }: Props = $props();

  let open = $state(false);
  let error = $state<string | null>(null);
  /** Both sizes, to catch a mask left over from another picture (§9). */
  let sizes = $state<{
    image: string;
    mask: string;
    imageSize: [number, number] | null;
    maskSize: [number, number] | null;
  } | null>(null);

  const label = $derived(param.label ?? param.key);

  $effect(() => {
    const mask = value;
    const picture = image;
    if (mask === "" || picture === "") {
      sizes = null;
      return;
    }
    let current = true;
    const sizeOf = (filename: string) =>
      api
        .input(filename.replace(/\.[^.]+$/, ""))
        .then((media): [number, number] | null =>
          media.width !== null && media.height !== null
            ? [media.width, media.height]
            : null,
        )
        .catch(() => null);
    Promise.all([sizeOf(picture), sizeOf(mask)]).then(([imageSize, maskSize]) => {
      if (current) sizes = { image: picture, mask, imageSize, maskSize };
    });
    return () => {
      current = false;
    };
  });

  /**
   * The mask was painted on a picture of another size: the image changed
   * underneath it. The server would refuse the run; saying so here, next to
   * the button that fixes it, is the useful place.
   */
  const mismatch = $derived.by(() => {
    if (!sizes || sizes.mask !== value || sizes.image !== image) return null;
    const { imageSize, maskSize } = sizes;
    if (!imageSize || !maskSize) return null;
    if (imageSize[0] === maskSize[0] && imageSize[1] === maskSize[1]) return null;
    return `Painted on a ${maskSize[0]}×${maskSize[1]} picture; this one is ${imageSize[0]}×${imageSize[1]}. Paint it again.`;
  });

  async function save(png: Blob | null) {
    error = null;
    if (!png) {
      // Nothing painted is no mask, not a black square (§10).
      onchange("");
      open = false;
      return;
    }
    try {
      const media = await api.uploadInput(png, "mask.png");
      onchange(media.filename);
      open = false;
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause);
      // Thrown on, so the editor stays open with the painting in it.
      throw cause;
    }
  }
</script>

<div class="mask-param">
  {#if image === ""}
    <p class="waiting dim">
      <Brush size={13} />
      Attach the {imageLabel.toLowerCase()} first — the mask is painted over it.
    </p>
  {:else}
    <button
      class="preview"
      title={value ? "Edit the mask" : "Paint the mask"}
      aria-label={`${label}: ${value ? "edit the mask" : "paint the mask"}`}
      onclick={() => (open = true)}
    >
      <img class="shot" src={inputUrl(image)} alt="" />
      {#if value}
        <div
          class="tint"
          data-mask-tint
          style:mask-image={`url(${inputUrl(value)})`}
        ></div>
      {/if}
      <span class="action">
        <Brush size={12} />
        {value ? "Edit mask" : "Paint mask"}
      </span>
    </button>
    {#if value}
      <button
        class="clear"
        title="Remove the mask"
        aria-label="Remove the mask"
        onclick={() => onchange("")}
      >
        <X size={12} />
      </button>
    {/if}
  {/if}
  {#if mismatch}
    <p class="error"><TriangleAlert size={11} /> {mismatch}</p>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>

{#if open && image !== ""}
  <MaskEditor
    image={inputUrl(image)}
    mask={value && !mismatch ? inputUrl(value) : null}
    {label}
    ondone={save}
    oncancel={() => (open = false)}
  />
{/if}

<style>
  .mask-param {
    position: relative;
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 10px;
    font-size: 12px;
    background: var(--control);
    border-radius: var(--radius-input);
  }

  .preview {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    background: var(--control);
    border-radius: var(--radius-input);
    overflow: hidden;
    cursor: pointer;
  }

  .shot {
    display: block;
    width: 100%;
    max-height: 220px;
    object-fit: contain;
  }

  /* The mask over the picture, in the accent: white shows, black does not.
     Sized and placed exactly as the picture is, so the two line up. */
  .tint {
    position: absolute;
    inset: 0;
    background: var(--accent);
    opacity: 0.55;
    mask-mode: luminance;
    mask-size: contain;
    mask-position: center;
    mask-repeat: no-repeat;
    pointer-events: none;
  }

  .action {
    position: absolute;
    left: 6px;
    bottom: 6px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border-radius: var(--radius-control);
    background: rgb(13 13 13 / 78%);
    color: var(--text);
    font-size: 11px;
  }

  .preview:hover .action {
    color: var(--accent);
  }

  .clear {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    padding: 3px;
    background: rgb(13 13 13 / 72%);
    color: var(--text-2);
  }

  .clear:hover {
    background: rgb(13 13 13 / 90%);
    color: var(--text);
  }

  .error {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--error);
  }
</style>
