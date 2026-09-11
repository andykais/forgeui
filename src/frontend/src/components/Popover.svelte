<script lang="ts">
  import type { Snippet } from "svelte";
  import { optionKeys } from "../lib/options.ts";

  /**
   * The one popover component (§11.3): 326px hanging off its trigger, used by
   * the workflow picker and the models filter.
   *
   * A picker inside the param panel passes `fill` instead. Hanging off the
   * trigger puts a list under whatever param happens to be low in the panel,
   * and half of it ends up below the bottom of the screen; `fill` covers the
   * panel itself, so the list is the same size and in the same place wherever
   * its trigger sits.
   *
   * `anchor` is the third shape: still beside its trigger, but positioned in
   * viewport coordinates so nothing between the two can clip it. A model card
   * hides its own overflow to round its thumbnail, which took the SET FAMILY
   * list with it; a table cell would do the same.
   *
   * Whichever shape it takes, the list answers to the arrow keys and Enter.
   */
  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    width?: number;
    align?: "left" | "right";
    /** Cover this element rather than hang off the trigger. */
    fill?: HTMLElement | null;
    /** Hang off this element, but escape anything that would clip it. */
    anchor?: HTMLElement | null;
    children: Snippet;
  }

  let {
    open,
    onclose,
    title,
    width = 326,
    align = "left",
    fill = null,
    anchor = null,
    children,
  }: Props = $props();

  let element = $state<HTMLDivElement | undefined>(undefined);

  /** Viewport coordinates while this is open, for `fill` and `anchor` alike. */
  let box = $state<
    { top: number; left: number; width: number; height: number | null } | null
  >(null);

  /** What an anchored list may grow to before it scrolls, from `measure`. */
  let maxHeight = $state(0);

  const INSET = 8;
  /** How close to the window's edge an anchored list may come. */
  const MARGIN = 8;
  const GAP = 6;

  $effect(() => {
    const filling = open ? fill : null;
    const hanging = open && !filling ? anchor : null;
    if (!filling && !hanging) {
      box = null;
      return;
    }
    const measure = () => {
      const rect = (filling ?? hanging!).getBoundingClientRect();
      if (filling) {
        box = {
          top: rect.top + INSET,
          left: rect.left + INSET,
          width: Math.max(0, rect.width - INSET * 2),
          height: Math.max(0, rect.height - INSET * 2),
        };
        return;
      }
      // Under the trigger by preference, above it when there is more room
      // there, and never past either edge of the window.
      const below = globalThis.innerHeight - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const flip = below < 180 && above > below;
      box = {
        top: flip ? Math.max(MARGIN, rect.top - GAP - above) : rect.bottom + GAP,
        left: Math.max(
          MARGIN,
          Math.min(rect.left, globalThis.innerWidth - width - MARGIN),
        ),
        width,
        height: null,
      };
      maxHeight = Math.max(120, flip ? above : below);
    };
    measure();
    // The panel does not move when its own content scrolls, so a resize is
    // the only thing that can invalidate this.
    globalThis.addEventListener("resize", measure);
    // An anchored list is in viewport coordinates, so anything that scrolls
    // its trigger — a table, the models grid — moves it out from under it.
    if (hanging) globalThis.addEventListener("scroll", measure, true);
    return () => {
      globalThis.removeEventListener("resize", measure);
      globalThis.removeEventListener("scroll", measure, true);
    };
  });


  /**
   * The boundary is the wrapper that holds both the trigger and this popover,
   * so the click that opened it does not immediately close it again.
   */
  function onWindowClick(event: MouseEvent) {
    if (!open || !element) return;
    const target = event.target as Node | null;
    // Something that closed itself on this very click is gone from the tree
    // by the time this runs, and `contains` then says it was outside. A
    // detached target is not a click elsewhere, it is a click on us.
    if (!target || !target.isConnected) return;
    const boundary = element.parentElement ?? element;
    if (!boundary.contains(target)) onclose();
  }

  function onWindowKey(event: KeyboardEvent) {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

{#if open}
  <div
    class="popover"
    class:fixed={box !== null}
    class:right={align === "right" && box === null}
    style:width={box ? `${box.width}px` : `${width}px`}
    style:left={box ? `${box.left}px` : null}
    style:top={box ? `${box.top}px` : null}
    style:height={box?.height != null ? `${box.height}px` : null}
    style:max-height={box !== null && box.height === null ? `${maxHeight}px` : null}
    bind:this={element}
    role="dialog"
    aria-label={title ?? "Options"}
  >
    {#if title}<div class="head label">{title}</div>{/if}
    <!-- The arrow keys reach the list from the search box above it. -->
    <div class="body" use:optionKeys>{@render children()}</div>
  </div>
{/if}

<style>
  .popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 40;
    background: var(--raised-2);
    border-radius: var(--radius-popover);
    box-shadow: 0 12px 32px rgb(0 0 0 / 55%);
    overflow: hidden;
    max-height: min(60vh, 520px);
    display: flex;
    flex-direction: column;
  }

  /*
   * Viewport coordinates: either over the panel or hanging off a trigger
   * that something else would have clipped. Either way the list is out of
   * every ancestor's overflow and always on screen.
   */
  .popover.fixed {
    position: fixed;
    max-height: none;
    box-shadow: 0 16px 48px rgb(0 0 0 / 65%);
  }

  .popover.right {
    left: auto;
    right: 0;
  }

  .head {
    padding: 8px 10px 4px;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
    scrollbar-color: var(--control) transparent;
    scrollbar-width: thin;
  }
</style>
