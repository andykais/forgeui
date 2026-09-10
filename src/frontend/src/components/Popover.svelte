<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The one popover component (§11.3): 326px hanging off its trigger, used by
   * the workflow picker and the models filter.
   *
   * A picker inside the param panel passes `fill` instead. Hanging off the
   * trigger puts a list under whatever param happens to be low in the panel,
   * and half of it ends up below the bottom of the screen; `fill` covers the
   * panel itself, so the list is the same size and in the same place wherever
   * its trigger sits.
   */
  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    width?: number;
    align?: "left" | "right";
    /** Cover this element rather than hang off the trigger. */
    fill?: HTMLElement | null;
    children: Snippet;
  }

  let {
    open,
    onclose,
    title,
    width = 326,
    align = "left",
    fill = null,
    children,
  }: Props = $props();

  let element = $state<HTMLDivElement | undefined>(undefined);

  /** Viewport coordinates of `fill`, inset a little, while this is open. */
  let box = $state<{ top: number; left: number; width: number; height: number } | null>(
    null,
  );

  const INSET = 8;

  $effect(() => {
    const target = open ? fill : null;
    if (!target) {
      box = null;
      return;
    }
    const measure = () => {
      const rect = target.getBoundingClientRect();
      box = {
        top: rect.top + INSET,
        left: rect.left + INSET,
        width: Math.max(0, rect.width - INSET * 2),
        height: Math.max(0, rect.height - INSET * 2),
      };
    };
    measure();
    // The panel does not move when its own content scrolls, so a resize is
    // the only thing that can invalidate this.
    globalThis.addEventListener("resize", measure);
    return () => globalThis.removeEventListener("resize", measure);
  });

  /**
   * The boundary is the wrapper that holds both the trigger and this popover,
   * so the click that opened it does not immediately close it again.
   */
  function onWindowClick(event: MouseEvent) {
    if (!open || !element) return;
    const boundary = element.parentElement ?? element;
    if (!boundary.contains(event.target as Node)) onclose();
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
    class:filled={box !== null}
    class:right={align === "right" && box === null}
    style:width={box ? `${box.width}px` : `${width}px`}
    style:left={box ? `${box.left}px` : null}
    style:top={box ? `${box.top}px` : null}
    style:height={box ? `${box.height}px` : null}
    bind:this={element}
    role="dialog"
    aria-label={title ?? "Options"}
  >
    {#if title}<div class="head label">{title}</div>{/if}
    <div class="body">{@render children()}</div>
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

  /* Over the panel, in viewport coordinates: the whole list, always on screen. */
  .popover.filled {
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
