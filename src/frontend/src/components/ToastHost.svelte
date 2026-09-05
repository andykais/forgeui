<script lang="ts">
  import { toasts } from "../stores/toasts.svelte.ts";

  /** Delete has no confirmation; this is the undo (§11.2). */
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <div class="toast">
      <span>{toast.message}</span>
      {#if toast.undo}
        <button onclick={toast.undo}>Undo</button>
      {/if}
      <button class="close" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}>
        ×
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(var(--queue-height) + 14px);
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px 7px 12px;
    border-radius: var(--radius-input);
    background: var(--raised-2);
    box-shadow: 0 10px 26px rgb(0 0 0 / 50%);
    font-size: 12px;
    pointer-events: auto;
  }

  .toast button {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--accent-tint);
    color: var(--accent);
  }

  .close {
    background: transparent;
    color: var(--text-4);
    padding: 2px 6px;
  }
</style>
