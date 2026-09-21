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
   * Each layout as rectangles in a 26×15 box — the proportions of a window
   * rather than a square, and the cells in the proportions the grid actually
   * gives them: at 1600px the three columns are 360, 878 and 306, which is
   * about 6, 12 and 6 of these units.
   *
   * `media` is the filled one, because the media is what an arrangement is
   * chosen for.
   */
  type Cell = { x: number; y: number; w: number; h: number; role: Role };
  type Role = "inputs" | "media" | "meta";

  /** With an inputs panel — Generate. */
  const WITH_INPUTS: Record<Layout, Cell[]> = {
    columns: [
      { x: 0, y: 0, w: 6, h: 15, role: "inputs" },
      { x: 7, y: 0, w: 12, h: 15, role: "media" },
      { x: 20, y: 0, w: 6, h: 15, role: "meta" },
    ],
    split: [
      { x: 0, y: 0, w: 6, h: 15, role: "inputs" },
      { x: 7, y: 0, w: 19, h: 7, role: "media" },
      { x: 7, y: 8, w: 19, h: 7, role: "meta" },
    ],
    wide: [
      { x: 0, y: 0, w: 6, h: 15, role: "inputs" },
      { x: 7, y: 0, w: 19, h: 15, role: "media" },
    ],
    top: [
      { x: 0, y: 0, w: 26, h: 7, role: "media" },
      { x: 0, y: 8, w: 26, h: 7, role: "inputs" },
    ],
    "top-split": [
      { x: 0, y: 0, w: 26, h: 7, role: "media" },
      { x: 0, y: 8, w: 19, h: 7, role: "inputs" },
      { x: 20, y: 8, w: 6, h: 7, role: "meta" },
    ],
  };

  /**
   * Without one — Gallery, and a model's page. Drawing the inputs pane there
   * was a picture of a screen that does not exist: three columns where there
   * are two, and a sliver of media where the media is the whole thing.
   */
  const WITHOUT_INPUTS: Partial<Record<Layout, Cell[]>> = {
    columns: [
      { x: 0, y: 0, w: 19, h: 15, role: "media" },
      { x: 20, y: 0, w: 6, h: 15, role: "meta" },
    ],
    split: [
      { x: 0, y: 0, w: 26, h: 7, role: "media" },
      { x: 0, y: 8, w: 26, h: 7, role: "meta" },
    ],
    wide: [{ x: 0, y: 0, w: 26, h: 15, role: "media" }],
  };

  const hasInputs = $derived(screen === "generate");
  const cellsFor = $derived((layout: Layout): Cell[] =>
    (hasInputs ? WITH_INPUTS[layout] : WITHOUT_INPUTS[layout]) ??
      WITH_INPUTS[layout]
  );

  /** Short enough for one line; the diagram beside each says the rest. */
  const LABELS: Record<Layout, string> = {
    columns: "Metadata beside",
    split: "Metadata below",
    wide: "No metadata",
    top: "Media on top",
    "top-split": "Media on top, metadata beside",
  };

  /**
   * The window is too narrow for a media column between two fixed panes, so
   * `columns` would not be honoured if it were picked — it falls back to
   * `split` (§11.3). The same condition as the CSS, kept in step by hand:
   * a media query cannot be read out of a stylesheet.
   */
  const NARROW = "(max-width: 1100px), (max-aspect-ratio: 8 / 9)";
  let narrow = $state(false);
  $effect(() => {
    const query = globalThis.matchMedia?.(NARROW);
    if (!query) return;
    narrow = query.matches;
    const follow = (event: MediaQueryListEvent) => (narrow = event.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  });

  function unavailable(layout: Layout): boolean {
    return narrow && layout === "columns";
  }

  function choose(layout: Layout) {
    app.setLayout(screen, layout);
    open = false;
  }
</script>

{#snippet diagram(layout: Layout)}
  <svg class="diagram" viewBox="0 0 26 15" aria-hidden="true">
    {#each cellsFor(layout) as cell (`${cell.role}${cell.x}${cell.y}`)}
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
      class:unavailable={unavailable(layout)}
      aria-pressed={layout === current}
      disabled={unavailable(layout)}
      title={unavailable(layout)
        ? "No room for three columns in a window this narrow"
        : LABELS[layout]}
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
    height: 15px;
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

  /*
   * Offered but not available: this window has no room for it, and picking
   * it would silently get `split` instead.
   */
  .option.unavailable {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .option.unavailable:hover {
    background: transparent;
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
