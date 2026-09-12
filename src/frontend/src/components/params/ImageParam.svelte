<script lang="ts">
  import ImagePlus from "@lucide/svelte/icons/image-plus";
  import X from "@lucide/svelte/icons/x";
  import { untrack } from "svelte";
  import { api, ApiError } from "../../api.ts";
  import type { Param } from "../../types.ts";

  /**
   * An `image` param (§9, §11.2). Three ways in, because all three are how
   * people actually have a picture to hand: the file picker, a drop, and a
   * paste — a screenshot lives only on the clipboard, and making somebody
   * save it to disk first to get it into the app is a step with no purpose.
   *
   * What the param holds is `<sha256>.<ext>`: the upload happens here, so
   * that by the time Generate is pressed the server already has the bytes
   * and the value is something a rerun can resolve months later.
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
  /** What was attached here, for the thumbnail; the value is only a name. */
  let preview = $state<{ filename: string; url: string; width: number; height: number } | null>(null);

  const shown = $derived(preview?.filename === value ? preview : null);
  /**
   * A value filled in from somewhere else — a previous run, or the Upscale
   * action — has no preview beside it, but the name is enough to find the
   * file: the store is addressed by exactly that. The thumbnail can be shown
   * straight away from the name, and the store is then asked how big the
   * picture is, because "attached" says less than "1024×1024" about what the
   * job is going to receive.
   */
  const fallbackUrl = $derived(
    value && !shown ? `/api/media/inputs/${value.slice(0, 2)}/${value}` : null,
  );

  $effect(() => {
    const filename = value;
    if (filename === "" || untrack(() => preview?.filename === filename)) return;
    let current = true;
    api.input(filename.replace(/\.[^.]+$/, ""))
      .then((media) => {
        if (!current) return;
        preview = {
          filename: media.filename,
          url: media.url,
          width: media.width,
          height: media.height,
        };
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });

  async function take(file: File | Blob | null | undefined, name?: string) {
    if (!file) return;
    busy = true;
    error = null;
    try {
      const media = await api.uploadInput(file, name ?? "pasted.png");
      preview = {
        filename: media.filename,
        url: media.url,
        width: media.width,
        height: media.height,
      };
      onchange(media.filename);
    } catch (cause) {
      error = cause instanceof ApiError
        ? cause.message
        : cause instanceof Error
        ? cause.message
        : String(cause);
    } finally {
      busy = false;
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    over = false;
    const file = event.dataTransfer?.files?.[0];
    take(file);
  }

  /**
   * Pasting is caught on the drop zone rather than on the window: a paste
   * belongs to whatever has focus, and a panel with two image params would
   * otherwise have no way to say which one was meant.
   */
  function onPaste(event: ClipboardEvent) {
    const item = [...(event.clipboardData?.items ?? [])].find((entry) =>
      entry.type.startsWith("image/")
    );
    if (!item) return;
    event.preventDefault();
    take(item.getAsFile());
  }

  function clear() {
    preview = null;
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
    aria-label={`${param.label ?? param.key}: choose, drop or paste an image`}
    onclick={() => input?.click()}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input?.click();
      }
    }}
    onpaste={onPaste}
    ondrop={onDrop}
    ondragover={(event) => {
      event.preventDefault();
      over = true;
    }}
    ondragleave={() => (over = false)}
  >
    {#if value !== ""}
      <img class="shot" src={shown?.url ?? fallbackUrl} alt="" />
      <div class="meta mono dim">
        {#if shown}{shown.width}×{shown.height}{:else}attached{/if}
      </div>
    {:else}
      <div class="empty">
        <ImagePlus size={18} />
        <span>{busy ? "reading…" : "Choose, drop or paste an image"}</span>
      </div>
    {/if}
  </div>

  {#if value !== ""}
    <button class="clear" title="Remove this image" aria-label="Remove this image" onclick={clear}>
      <X size={12} />
    </button>
  {/if}

  <input
    class="file"
    type="file"
    accept="image/png,image/jpeg,image/webp"
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

  /* Dashed borders survive in exactly two places; this is the other (§11.5). */
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
    padding: 0;
  }

  .shot {
    display: block;
    width: 100%;
    max-height: 220px;
    /* Fit, not fill: this is the picture about to be worked on, and a crop
       of it would misrepresent what the job is going to receive. */
    object-fit: contain;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px;
    font-size: 12px;
    color: var(--text-3);
    text-align: center;
  }

  .meta {
    position: absolute;
    left: 6px;
    bottom: 6px;
    padding: 1px 5px;
    border-radius: var(--radius-control);
    background: rgb(13 13 13 / 72%);
    font-size: 10px;
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

  .file {
    display: none;
  }

  .error {
    margin-top: 6px;
    font-size: 11px;
    color: var(--error);
  }
</style>
