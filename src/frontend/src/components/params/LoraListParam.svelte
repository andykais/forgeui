<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import Link from "@lucide/svelte/icons/link";
  import Unlink from "@lucide/svelte/icons/unlink";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import Popover from "../Popover.svelte";
  import type { LoraRow, ModelEntry, Param } from "../../types.ts";
  import { relativeTime } from "../../lib/format.ts";

  /**
   * §11.3: repeatable rows, drag to reorder, and linked strengths by default
   * — one slider drives model and clip together until ⛓ splits it. The
   * sidecar records both values either way. The picker is family-filtered to
   * the workflow by default; "Show all" is one click and does not persist,
   * and already-added LoRAs stay listed, marked "added".
   */
  interface Props {
    param: Param;
    value: LoraRow[];
    models: ModelEntry[];
    onchange: (rows: LoraRow[]) => void;
  }

  let { param, value, models, onchange }: Props = $props();

  let pickerOpen = $state(false);
  let showAll = $state(false);
  let search = $state("");
  /** Rows whose two strengths are shown separately. */
  let unlinked = $state<Record<string, boolean>>({});
  let dragging = $state<number | null>(null);

  const family = $derived(param.filter?.family ?? null);

  const listed = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return models.filter((model) => {
      // A model nobody has filed yet is not hidden by a family filter: it
      // has no family because the user has not said, not because it is wrong.
      const familyOk =
        showAll || !family || model.family === family || model.family === "unset";
      const searchOk =
        needle === "" ||
        model.display_name.toLowerCase().includes(needle) ||
        model.name.toLowerCase().includes(needle);
      return familyOk && searchOk;
    });
  });

  function add(model: ModelEntry) {
    onchange([...value, { name: model.name, strength_model: 0.8, strength_clip: 0.8 }]);
    pickerOpen = false;
    search = "";
  }

  function remove(index: number) {
    onchange(value.filter((_, position) => position !== index));
  }

  function setStrength(index: number, part: "model" | "clip", raw: number) {
    const rows = value.map((row, position) => {
      if (position !== index) return row;
      const linked = !unlinked[row.name];
      if (linked) return { ...row, strength_model: raw, strength_clip: raw };
      return part === "model"
        ? { ...row, strength_model: raw }
        : { ...row, strength_clip: raw };
    });
    onchange(rows);
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= value.length || from === to) return;
    const rows = [...value];
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row!);
    onchange(rows);
  }

  function displayName(name: string): string {
    return (
      models.find((model) => model.name === name)?.display_name ??
      name.replace(/\.[^.]+$/, "")
    );
  }
</script>

<div class="lora-list">
  {#each value as row, index (row.name + index)}
    {@const linked = !unlinked[row.name]}
    <div
      class="lora-row"
      class:dragging={dragging === index}
      draggable="true"
      role="listitem"
      ondragstart={() => (dragging = index)}
      ondragend={() => (dragging = null)}
      ondragover={(event) => event.preventDefault()}
      ondrop={() => {
        if (dragging !== null) move(dragging, index);
        dragging = null;
      }}
    >
      <div class="row head">
        <span class="grip" title="Drag to reorder"><GripVertical size={13} /></span>
        <span class="name" title={row.name}>{displayName(row.name)}</span>
        <span class="spacer"></span>
        {#if family}<span class="badge accent">{family}</span>{/if}
        <button
          class="icon"
          title="Remove"
          aria-label={`Remove ${displayName(row.name)}`}
          onclick={() => remove(index)}
        >
          <X size={12} />
        </button>
      </div>

      {#if linked}
        <div class="row strength">
          <span class="strength-label">strength</span>
          <input
            type="range"
            min="-1"
            max="2"
            step="0.05"
            value={row.strength_model}
            aria-label={`${displayName(row.name)} strength`}
            oninput={(event) =>
              setStrength(
                index,
                "model",
                Number((event.currentTarget as HTMLInputElement).value),
              )}
          />
          <span class="value mono">{row.strength_model.toFixed(2)}</span>
          <button
            class="icon"
            title="Unlink model and clip strengths"
            aria-label="Unlink strengths"
            onclick={() => (unlinked = { ...unlinked, [row.name]: true })}
          >
            <Link size={12} />
          </button>
        </div>
      {:else}
        <div class="row strength">
          <span class="strength-label">model</span>
          <input
            type="range"
            min="-1"
            max="2"
            step="0.05"
            value={row.strength_model}
            aria-label={`${displayName(row.name)} model strength`}
            oninput={(event) =>
              setStrength(
                index,
                "model",
                Number((event.currentTarget as HTMLInputElement).value),
              )}
          />
          <span class="value mono">{row.strength_model.toFixed(2)}</span>
          <button
            class="icon"
            title="Link model and clip strengths"
            aria-label="Link strengths"
            onclick={() => {
              const { [row.name]: _gone, ...rest } = unlinked;
              unlinked = rest;
              setStrength(index, "model", row.strength_model);
            }}
          >
            <Unlink size={12} />
          </button>
        </div>
        <div class="row strength">
          <span class="strength-label">clip</span>
          <input
            type="range"
            min="-1"
            max="2"
            step="0.05"
            value={row.strength_clip}
            aria-label={`${displayName(row.name)} clip strength`}
            oninput={(event) =>
              setStrength(
                index,
                "clip",
                Number((event.currentTarget as HTMLInputElement).value),
              )}
          />
          <span class="value mono">{row.strength_clip.toFixed(2)}</span>
          <span class="icon-spacer"></span>
        </div>
      {/if}
    </div>
  {/each}

  <div class="add-wrap">
    <button class="add" onclick={() => (pickerOpen = !pickerOpen)}>
      <Plus size={12} /> Add
    </button>
    <Popover open={pickerOpen} title="LoRAs" onclose={() => (pickerOpen = false)}>
      <input
        class="search"
        placeholder="Search LoRAs…"
        bind:value={search}
        aria-label="Search LoRAs"
      />
      {#if family}
        <button class="show-all" onclick={() => (showAll = !showAll)}>
          {showAll ? `Filter to ${family}` : "Show all"}
        </button>
      {/if}
      {#if models.length === 0}
        <p class="empty">
          No LoRAs found. Point <code class="mono">model_folders.loras</code> at a folder
          in <code class="mono">config.yaml</code> and restart.
        </p>
      {:else if listed.length === 0}
        <p class="empty">Nothing matches.</p>
      {:else}
        {#each listed as model (model.name)}
          {@const added = value.some((row) => row.name === model.name)}
          <button class="option" disabled={added} onclick={() => add(model)}>
            <span class="option-thumb">
              {#if model.thumb_url}
                <img src={model.thumb_url} alt="" loading="lazy" />
              {:else}
                <span class="plate"></span>
              {/if}
            </span>
            <span class="option-text">
              <span class="option-name">{model.display_name}</span>
              <span class="option-line mono dim">
                {model.output_count > 0
                  ? `${model.output_count} output${model.output_count === 1 ? "" : "s"}`
                  : "no outputs"}
                {#if model.last_used_at}· used {relativeTime(model.last_used_at)}{/if}
                {#if model.hashing}· hashing{/if}
              </span>
            </span>
            {#if added}
              <span class="dim added">added</span>
            {:else}
              <span class="badge">{model.family}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </Popover>
  </div>
</div>

<style>
  .lora-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .lora-row {
    background: var(--raised);
    border-radius: var(--radius-input);
    padding: 6px 8px 8px;
  }

  .lora-row.dragging {
    opacity: 0.5;
  }

  .grip {
    color: var(--mark);
    cursor: grab;
    display: flex;
  }

  .name {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 170px;
  }

  .strength {
    margin-top: 4px;
    gap: 6px;
  }

  /* Lower case and wide enough not to clip, as frame 01 draws it. */
  .strength-label {
    width: 54px;
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--text-4);
  }

  .strength input[type="range"] {
    flex: 1;
  }

  .value {
    width: 34px;
    text-align: right;
    font-size: 11px;
  }

  .icon {
    background: transparent;
    color: var(--text-4);
    padding: 2px 3px;
    display: flex;
  }

  .icon:hover {
    color: var(--text);
    background: var(--control);
  }

  .icon-spacer {
    width: 19px;
  }

  .add-wrap {
    position: relative;
  }

  .add {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    background: transparent;
    color: var(--accent);
    padding: 2px 4px;
    margin-left: auto;
  }

  .search {
    margin-bottom: 4px;
  }

  .show-all {
    font-size: 11px;
    background: transparent;
    color: var(--accent);
    margin-bottom: 4px;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 7px;
  }

  .option:hover:not(:disabled) {
    background: var(--control);
  }

  .option-thumb {
    width: 24px;
    height: 24px;
    border-radius: var(--radius-control);
    overflow: hidden;
    background: var(--control);
    flex: 0 0 auto;
  }

  .option-thumb img,
  .option-thumb .plate {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .option-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .option-line {
    font-size: 10px;
  }

  .added {
    font-size: 10px;
  }

  .option-name {
    flex: 1;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty {
    font-size: 11px;
    color: var(--text-4);
    padding: 8px;
    margin: 0;
  }
</style>
