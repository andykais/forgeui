<script lang="ts">
  import ImagePlus from "@lucide/svelte/icons/image-plus";
  import Star from "@lucide/svelte/icons/star";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import PencilLine from "@lucide/svelte/icons/pencil-line";
  import type { Sample } from "../types.ts";

  /**
   * The Samples strip of the model page (§8.3, frame 05): media that shows
   * what this model does, dropped on the page or promoted from an output.
   * The hover menu is Set as thumbnail and Delete, plus Edit in Generate on
   * the ones that came from an output and therefore have params to reuse.
   *
   * The Civitai URL field and Fetch info button belong to Phase 3 and are
   * not drawn — the space is left, not stubbed (MOCK-REVISIONS §9).
   */
  let {
    samples,
    thumbPath = null,
    busy = false,
    onimport,
    onthumb,
    ondelete,
    onedit,
  }: {
    samples: Sample[];
    thumbPath?: string | null;
    busy?: boolean;
    onimport: (files: File[]) => void;
    onthumb: (sample: Sample) => void;
    ondelete: (sample: Sample) => void;
    onedit: (sample: Sample) => void;
  } = $props();

  let dragging = $state(false);
  let input = $state<HTMLInputElement | undefined>(undefined);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) onimport(files);
  }
</script>

<section class="samples">
  <header>
    <h2>Samples</h2>
    <span class="mono dim">{samples.length}</span>
  </header>

  <div class="strip">
    {#each samples as sample (sample.id)}
      <figure class="sample" class:chosen={sample.path === thumbPath}>
        <img src={sample.media_url} alt="" loading="lazy" />
        <div class="menu">
          <button
            title="Set as thumbnail"
            aria-label={`Set ${sample.id} as thumbnail`}
            onclick={() => onthumb(sample)}
          >
            <Star size={13} />
          </button>
          {#if sample.reusable}
            <button
              title="Edit in Generate"
              aria-label={`Edit ${sample.id} in Generate`}
              onclick={() => onedit(sample)}
            >
              <PencilLine size={13} />
            </button>
          {/if}
          <button
            class="danger"
            title="Delete"
            aria-label={`Delete sample ${sample.id}`}
            onclick={() => ondelete(sample)}
          >
            <Trash2 size={13} />
          </button>
        </div>
        {#if sample.path === thumbPath}
          <figcaption class="mono">thumbnail</figcaption>
        {/if}
      </figure>
    {/each}

    <button
      class="drop"
      class:dragging
      class:busy
      ondragover={(event) => {
        event.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      onclick={() => input?.click()}
    >
      <ImagePlus size={16} />
      <span>{busy ? "Importing…" : "Drop a file"}</span>
    </button>
    <input
      bind:this={input}
      class="file"
      type="file"
      accept="image/*,video/*"
      multiple
      aria-label="Import a sample"
      onchange={(event) => {
        const picked = [...((event.currentTarget as HTMLInputElement).files ?? [])];
        if (picked.length > 0) onimport(picked);
        (event.currentTarget as HTMLInputElement).value = "";
      }}
    />
  </div>
</section>

<style>
  .samples {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  h2 {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-2);
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .sample {
    position: relative;
    width: 108px;
    height: 108px;
    flex: 0 0 auto;
    margin: 0;
    border-radius: var(--radius-tile);
    overflow: hidden;
    background: var(--control);
  }

  .sample img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .sample.chosen {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .menu {
    position: absolute;
    inset: auto 0 0 0;
    display: flex;
    gap: 2px;
    padding: 4px;
    justify-content: flex-end;
    background: linear-gradient(transparent, rgb(0 0 0 / 65%));
    opacity: 0;
    transition: opacity 100ms var(--ease);
  }

  .sample:hover .menu,
  .sample:focus-within .menu {
    opacity: 1;
  }

  .menu button {
    background: rgb(0 0 0 / 45%);
    color: var(--text-2);
    padding: 3px;
  }

  .menu button:hover {
    color: var(--text);
  }

  .menu button.danger:hover {
    color: var(--error);
  }

  figcaption {
    position: absolute;
    top: 4px;
    left: 4px;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: var(--radius-control);
    background: var(--accent);
    color: #08191d;
  }

  .drop {
    width: 108px;
    height: 108px;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-4);
    background: transparent;
    border: 1px dashed var(--edge);
    border-radius: var(--radius-tile);
  }

  .drop:hover,
  .drop.dragging {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-tint);
  }

  .file {
    display: none;
  }
</style>
