<script lang="ts">
  import Dices from "@lucide/svelte/icons/dices";
  import Lock from "@lucide/svelte/icons/lock";
  import LockOpen from "@lucide/svelte/icons/lock-open";

  /**
   * §11.3: 🔒 captures the last run's actual seed so the next run repeats it.
   * While unlocked the field shows the last-used seed greyed with a "random
   * each run" hint. 🎲 re-rolls immediately in either state. Editing the
   * field auto-locks to the typed value, and `-1` always means random.
   */
  interface Props {
    value: number;
    locked: boolean;
    lastSeed: number | null;
    onedit: (value: number) => void;
    onroll: () => void;
    ontogglelock: () => void;
  }

  let { value, locked, lastSeed, onedit, onroll, ontogglelock }: Props = $props();

  const shown = $derived(
    locked ? String(value) : lastSeed === null ? "" : String(lastSeed),
  );
</script>

<div class="seed">
  <input
    class="mono"
    class:unlocked={!locked}
    type="text"
    inputmode="numeric"
    value={shown}
    placeholder="-1"
    aria-label="Seed"
    oninput={(event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      if (raw === "") return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) onedit(Math.trunc(parsed));
    }}
  />
  <button
    class="icon"
    title="Roll a new seed"
    aria-label="Roll a new seed"
    onclick={onroll}
  >
    <Dices size={14} />
  </button>
  <button
    class="icon"
    class:on={locked}
    title={locked ? "Unlock: use a new seed each run" : "Lock the last run's seed"}
    aria-label={locked ? "Unlock the seed" : "Lock the seed"}
    aria-pressed={locked}
    onclick={ontogglelock}
  >
    {#if locked}<Lock size={13} />{:else}<LockOpen size={13} />{/if}
  </button>
</div>
<p class="hint dim">
  {#if locked}
    locked to this seed · reused until unlocked
  {:else if lastSeed !== null}
    last run used {lastSeed} · random each run
  {:else}
    random each run
  {/if}
</p>

<style>
  .seed {
    display: flex;
    gap: 6px;
  }

  input.unlocked {
    color: var(--text-4);
  }

  .icon {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    padding: 6px 8px;
    color: var(--text-3);
  }

  .icon.on {
    background: var(--accent-tint);
    color: var(--accent);
  }

  .hint {
    margin: 4px 0 0;
    font-size: 11px;
  }
</style>
