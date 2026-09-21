<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Popover from "./Popover.svelte";
  import { app } from "../stores/app.svelte.ts";
  import { GALLERY_LAYOUTS, type Layout, LAYOUTS } from "../types.ts";
  import type { UiScreen } from "../types.ts";

  /**
   * Where the inputs, the media and the metadata go (§11.3).
   *
   * This replaces the show/hide metadata toggle, which could only say
   * whether the third pane existed — never where any of them went. The
   * options are drawn rather than named, because the thing being chosen is
   * a shape: a row of five words would make you read all five to find the
   * one you can see at a glance.
   *
   * Gallery has no inputs panel, so it is offered only the three that
   * differ there.
   */
  interface Props {
    screen: UiScreen;
    /** Hang the list off this, so a header's overflow cannot clip it. */
    anchor?: HTMLElement | null;
  }

  let { screen, anchor = null }: Props = $props();

  const current = $derived(app.layout(screen));
  const offered = $derived<readonly Layout[]>(
    screen === "generate" ? LAYOUTS : GALLERY_LAYOUTS,
  );

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);

  /**
   * Each layout as rectangles in a 26×18 box: what the screen will look
   * like, in the order the eye reads it. `media` is the filled one, because
   * the media is what an arrangement is chosen for.
   */
  type Cell = { x: number; y: number; w: number; h: number; role: Role };
  type Role = "inputs" | "media" | "meta";

  const DIAGRAMS: Record<Layout, Cell[]> = {
    columns: [
      { x: 0, y: 0, w: 7, h: 18, role: "inputs" },
      { x: 8, y: 0, w: 9, h: 18, role: "media" },
      { x: 18, y: 0, w: 8, h: 18, role: "meta" },
    ],
    split: [
      { x: 0, y: 0, w: 7, h: 18, role: "inputs" },
      { x: 8, y: 0, w: 18, h: 8, role: "media" },
      { x: 8, y: 9, w: 18, h: 9, role: "meta" },
    ],
    wide: [
      { x: 0, y: 0, w: 7, h: 18, role: "inputs" },
      { x: 8, y: 0, w: 18, h: 18, role: "media" },
    ],
    top: [
      { x: 0, y: 0, w: 26, h: 8, role: "media" },
      { x: 0, y: 9, w: 26, h: 9, role: "inputs" },
    ],
    "top-split": [
      { x: 0, y: 0, w: 26, h: 8, role: "media" },
      { x: 0, y: 9, w: 17, h: 9, role: "inputs" },
      { x: 18, y: 9, w: 8, h: 9, role: "meta" },
    ],
  };

  /** Short enough for one line; the diagram beside each says the rest. */
  const LABELS: Record<Layout, string> = {
    columns: "Metadata beside",
    split: "Metadata below",
    wide: "No metadata",
    top: "Media on top",
    "top-split": "Media on top, metadata beside",
  };

  function choose(layout: Layout) {
    app.setLayout(screen, layout);
    open = false;
  }
</script>

{#snippet diagram(layout: Layout)}
  <svg class="diagram" viewBox="0 0 26 18" aria-hidden="true">
    {#each DIAGRAMS[layout] as cell (`${cell.role}${cell.x}${cell.y}`)}
      <rect
        class={`pane-${cell.role}`}
        x={cell.x}
        y={cell.y}
        width={cell.w}
        height={cell.h}
        rx="1.5"
      />
    {/each}
  </svg>
{/snippet}

<button
  class="trigger"
  bind:this={trigger}
  title={`Layout: ${LABELS[current]}`}
  aria-label={`Layout: ${LABELS[current]}`}
  onclick={() => (open = !open)}
>
  {@render diagram(current)}
  <ChevronDown size={11} />
</button>

<Popover
  {open}
  width={250}
  align="right"
  anchor={anchor ?? trigger ?? null}
  title="Layout"
  onclose={() => (open = false)}
>
  {#each offered as layout (layout)}
    <button
      class="option"
      class:chosen={layout === current}
      aria-pressed={layout === current}
      onclick={() => choose(layout)}
    >
      {@render diagram(layout)}
      <span class="name">{LABELS[layout]}</span>
    </button>
  {/each}
</Popover>

<style>
  .trigger {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 5px;
    /* Never squeezed out of a narrow header: this is the control that gets
       the media its room back (§11.3). */
    flex: 0 0 auto;
  }

  .diagram {
    width: 26px;
    height: 18px;
    flex: 0 0 auto;
    display: block;
  }

  /* The panes as fills, not outlines: at 18px a stroke is the whole cell. */
  .diagram .pane-inputs,
  .diagram .pane-meta {
    fill: var(--text-4);
    opacity: 0.55;
  }

  .diagram .pane-media {
    fill: var(--accent);
    opacity: 0.85;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border-radius: var(--radius-control);
    text-align: left;
  }

  .option:hover {
    background: var(--control);
  }

  .option.chosen {
    background: var(--accent-tint);
  }

  .option.chosen .name {
    color: var(--text);
  }

  .name {
    font-size: 12px;
    color: var(--text-2);
    min-width: 0;
  }
</style>
