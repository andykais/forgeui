<script lang="ts">
  import Link from "@lucide/svelte/icons/link";
  import Unlink from "@lucide/svelte/icons/unlink";
  import type { Param } from "../../types.ts";

  /**
   * §11.3: the presets are ratios, not pixel counts. They resolve against the
   * workflow's base resolution (the param's default), snapped to the model's
   * grid by `step`, so 16:9 is one thing on Flux and another on SDXL. Exact
   * pixels live on the native title tooltip and in the W/H fields.
   */
  interface Props {
    param: Param;
    value: [number, number];
    onchange: (value: [number, number]) => void;
  }

  let { param, value, onchange }: Props = $props();

  const RATIOS: [string, number, number][] = [
    ["1:1", 1, 1],
    ["2:3", 2, 3],
    ["3:2", 3, 2],
    ["4:3", 4, 3],
    ["16:9", 16, 9],
    ["9:16", 9, 16],
    ["21:9", 21, 9],
  ];

  const step = $derived(param.step ?? 8);
  const base = $derived((param.default as [number, number]) ?? [1024, 1024]);
  let linked = $state(false);

  function snap(pixels: number): number {
    return Math.max(step, Math.round(pixels / step) * step);
  }

  function resolve(a: number, b: number): [number, number] {
    const area = base[0] * base[1];
    const width = Math.sqrt(area * (a / b));
    return [snap(width), snap(width / (a / b))];
  }

  function isActive(a: number, b: number): boolean {
    const [width, height] = resolve(a, b);
    return value[0] === width && value[1] === height;
  }

  function setDimension(index: 0 | 1, raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const next: [number, number] = [...value];
    next[index] = Math.round(parsed);
    if (linked) {
      const ratio = value[0] / value[1];
      next[index === 0 ? 1 : 0] = snap(index === 0 ? next[0] / ratio : next[1] * ratio);
    }
    onchange(next);
  }
</script>

<div class="ratios">
  {#each RATIOS as [label, a, b] (label)}
    {@const resolved = resolve(a, b)}
    <button
      class:active={isActive(a, b)}
      title={`${resolved[0]} × ${resolved[1]}`}
      onclick={() => onchange(resolved)}
    >
      {label}
    </button>
  {/each}
</div>

<div class="fields">
  <label class="field">
    <span class="prefix mono">W</span>
    <input
      class="mono"
      type="number"
      {step}
      min={step}
      value={value[0]}
      aria-label="Width"
      oninput={(event) =>
        setDimension(0, (event.currentTarget as HTMLInputElement).value)}
    />
  </label>
  <button
    class="lock"
    class:on={linked}
    title={linked ? "Unlock the aspect ratio" : "Lock the aspect ratio"}
    aria-label="Lock the aspect ratio"
    aria-pressed={linked}
    onclick={() => (linked = !linked)}
  >
    {#if linked}<Link size={13} />{:else}<Unlink size={13} />{/if}
  </button>
  <label class="field">
    <span class="prefix mono">H</span>
    <input
      class="mono"
      type="number"
      {step}
      min={step}
      value={value[1]}
      aria-label="Height"
      oninput={(event) =>
        setDimension(1, (event.currentTarget as HTMLInputElement).value)}
    />
  </label>
</div>

<style>
  .ratios {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .ratios button {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 7px;
    background: var(--raised);
    color: var(--text-3);
  }

  .ratios button.active {
    background: var(--accent-tint);
    color: var(--accent);
  }

  .fields {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }

  .field {
    flex: 1;
    display: flex;
    align-items: center;
    background: var(--raised);
    border-radius: var(--radius-input);
    padding-left: 8px;
  }

  .prefix {
    font-size: 10px;
    color: var(--text-4);
  }

  /* No spinners: the arrows are noise at this size and nobody clicks them. */
  .field input {
    appearance: textfield;
  }

  .field input::-webkit-outer-spin-button,
  .field input::-webkit-inner-spin-button {
    appearance: none;
    margin: 0;
  }

  .field input {
    background: transparent;
  }

  .lock {
    flex: 0 0 auto;
    padding: 6px 7px;
    color: var(--text-4);
    display: flex;
  }

  .lock.on {
    background: var(--accent-tint);
    color: var(--accent);
  }
</style>
