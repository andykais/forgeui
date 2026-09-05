<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The one popover component (§11.3): 326px, used by the workflow picker,
   * the LoRA picker, the models filter and the checkpoint picker.
   */
  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    width?: number;
    align?: "left" | "right";
    children: Snippet;
  }

  let { open, onclose, title, width = 326, align = "left", children }: Props = $props();

  let element = $state<HTMLDivElement | undefined>(undefined);

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
    class:right={align === "right"}
    style:width={`${width}px`}
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

  .popover.right {
    left: auto;
    right: 0;
  }

  .head {
    padding: 8px 10px 4px;
  }

  .body {
    overflow-y: auto;
    padding: 4px;
    scrollbar-color: var(--control) transparent;
    scrollbar-width: thin;
  }
</style>
