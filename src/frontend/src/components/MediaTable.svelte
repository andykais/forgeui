<script lang="ts">
  import type { Output } from "../types.ts";
  import { dimensions, duration } from "../lib/format.ts";
  import { app } from "../stores/app.svelte.ts";

  /**
   * The table half of the tiles / table toggle (§11.2): thumb, prompt,
   * workflow, MODELS chips, SIZE, seed and DURATION. Column headers are not
   * sortable — sort lives in the filter bar.
   */
  interface Props {
    outputs: Output[];
    selectedId: string | null;
    onopen: (output: Output) => void;
  }

  let { outputs, selectedId, onopen }: Props = $props();

  function seedOf(output: Output): string {
    const seed = output.params.seed;
    return typeof seed === "number" ? String(seed) : "—";
  }

  /**
   * Model names come from the params until the Phase 2 scanner gives
   * `output_models` real hashes to join against.
   */
  function modelChips(output: Output): string[] {
    const loras = output.params.loras;
    const names: string[] = [];
    if (typeof output.params.checkpoint === "string" && output.params.checkpoint) {
      names.push(output.params.checkpoint);
    }
    if (Array.isArray(loras)) {
      for (const row of loras) {
        const name = (row as { name?: string }).name;
        if (name) names.push(name);
      }
    }
    return names.map(
      (name) =>
        app.loras.find((model) => model.name === name)?.display_name ??
        name.replace(/\.[^.]+$/, ""),
    );
  }
</script>

<table>
  <thead>
    <tr>
      <th class="thumb-col"></th>
      <th>Prompt</th>
      <th>Workflow</th>
      <th>Models</th>
      <th>Size</th>
      <th>Seed</th>
      <th>Duration</th>
    </tr>
  </thead>
  <tbody>
    {#each outputs as output (output.id)}
      {@const chips = modelChips(output)}
      <tr
        class:selected={output.id === selectedId}
        onclick={() => onopen(output)}
        tabindex="0"
        onkeydown={(event) => {
          if (event.key === "Enter") onopen(output);
        }}
      >
        <td class="thumb-col">
          <span class="thumb">
            {#if output.kind === "video"}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={output.media_url} muted preload="metadata"></video>
            {:else}
              <img src={output.media_url} alt="" loading="lazy" />
            {/if}
          </span>
        </td>
        <td class="prompt">{output.prompt ?? output.id}</td>
        <td><span class="badge">{output.workflow_id ?? "—"}</span></td>
        <td class="models">
          <span class="chips">
            {#each chips.slice(0, 2) as chip (chip)}
              <span class="badge" title={chip}>{chip}</span>
            {/each}
            {#if chips.length > 2}
              <span class="badge" title={chips.slice(2).join(", ")}>
                +{chips.length - 2}
              </span>
            {/if}
          </span>
        </td>
        <td class="mono">{dimensions(output.width, output.height, output.duration_ms)}</td
        >
        <td class="mono">{seedOf(output)}</td>
        <td class="mono">{duration(output.generation_ms)}</td>
      </tr>
    {/each}
  </tbody>
</table>
{#if outputs.length === 0}
  <p class="empty">Nothing here yet.</p>
{/if}

<style>
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th {
    text-align: left;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-4);
    font-weight: 400;
    padding: 6px 8px;
    position: sticky;
    top: 0;
    background: var(--canvas);
  }

  td {
    padding: 5px 8px;
    border-top: 1px solid var(--line);
    color: var(--text-2);
    vertical-align: middle;
  }

  tr {
    cursor: pointer;
  }

  tr:hover td {
    background: var(--app);
  }

  tr.selected td {
    background: var(--accent-tint);
  }

  .thumb-col {
    width: 46px;
  }

  .thumb {
    display: block;
    width: 38px;
    height: 38px;
    border-radius: var(--radius-control);
    overflow: hidden;
    background: var(--raised);
  }

  .thumb img,
  .thumb video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .prompt {
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Checkpoint first, then LoRAs, with `+n` overflow — on one line (§11.2). */
  .models {
    max-width: 190px;
  }

  .chips {
    display: flex;
    gap: 4px;
    align-items: center;
    overflow: hidden;
  }

  .chips .badge {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 88px;
  }
</style>
