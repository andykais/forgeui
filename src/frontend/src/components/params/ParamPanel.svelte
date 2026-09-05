<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import SeedParam from "./SeedParam.svelte";
  import SizeParam from "./SizeParam.svelte";
  import LoraListParam from "./LoraListParam.svelte";
  import Popover from "../Popover.svelte";
  import type { LoraRow, Manifest, ModelEntry, Param } from "../../types.ts";

  /**
   * The param panel is rendered from the manifest alone (§4.2, §11.2):
   * required params first, then optional, then a collapsed Advanced section,
   * under a PARAMETERS header that carries Reset to defaults.
   */
  interface Props {
    manifest: Manifest;
    values: Record<string, unknown>;
    seedLocked: boolean;
    lastSeed: number | null;
    loras?: ModelEntry[];
    checkpoints?: ModelEntry[];
    /** Keys the panel was filled from that this manifest no longer has (§6.4). */
    warnings?: string[];
    onchange: (key: string, value: unknown) => void;
    onreset: () => void;
    onseededit: (value: number) => void;
    onseedroll: () => void;
    onseedlock: () => void;
  }

  let {
    manifest,
    values,
    seedLocked,
    lastSeed,
    loras = [],
    checkpoints = [],
    warnings = [],
    onchange,
    onreset,
    onseededit,
    onseedroll,
    onseedlock,
  }: Props = $props();

  let advancedOpen = $state(false);
  let checkpointOpen = $state<string | null>(null);

  const main = $derived(manifest.params.filter((param) => !param.advanced));
  const advanced = $derived(manifest.params.filter((param) => param.advanced));
  /** Required first, then optional, keeping manifest order within each group. */
  const ordered = $derived([
    ...main.filter((param) => param.required),
    ...main.filter((param) => !param.required),
  ]);

  function label(param: Param): string {
    return param.label ?? param.key;
  }

  function number(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value);
  }
</script>

<div class="panel-head row">
  <span class="label">Parameters</span>
  <span class="mono dim count">{manifest.params.length}</span>
  <span class="spacer"></span>
  <button class="reset" onclick={onreset}>Reset to defaults</button>
</div>

{#if warnings.length > 0}
  <p class="warning mono">
    <TriangleAlert size={12} />
    ignored: {warnings.join(", ")} — this workflow no longer exposes
    {warnings.length === 1 ? "it" : "them"}
  </p>
{/if}

<div class="params">
  {#snippet field(param: Param)}
    <div class="param" data-param={param.key} data-type={param.type}>
      <div class="param-label row">
        <span class="name">{label(param)}</span>
        {#if param.required}<span class="required label">required</span>{/if}
      </div>

      {#if param.type === "text"}
        <textarea
          class="text"
          rows="3"
          value={(values[param.key] as string) ?? ""}
          aria-label={label(param)}
          oninput={(event) =>
            onchange(param.key, (event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      {:else if param.type === "int" || param.type === "float"}
        <div class="row number">
          {#if param.min !== undefined && param.max !== undefined}
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={param.step ?? (param.type === "int" ? 1 : 0.1)}
              value={(values[param.key] as number) ?? 0}
              aria-label={label(param)}
              oninput={(event) => onchange(param.key, number(event))}
            />
          {/if}
          <input
            class="mono narrow"
            type="number"
            min={param.min}
            max={param.max}
            step={param.step ?? (param.type === "int" ? 1 : 0.1)}
            value={(values[param.key] as number) ?? 0}
            aria-label={`${label(param)} value`}
            oninput={(event) => onchange(param.key, number(event))}
          />
        </div>
      {:else if param.type === "bool"}
        <label class="toggle">
          <input
            type="checkbox"
            checked={(values[param.key] as boolean) ?? false}
            aria-label={label(param)}
            onchange={(event) =>
              onchange(param.key, (event.currentTarget as HTMLInputElement).checked)}
          />
          <span class="dim">{values[param.key] ? "on" : "off"}</span>
        </label>
      {:else if param.type === "enum"}
        <select
          class="mono"
          value={(values[param.key] as string) ?? ""}
          aria-label={label(param)}
          onchange={(event) =>
            onchange(param.key, (event.currentTarget as HTMLSelectElement).value)}
        >
          {#each param.options ?? [] as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      {:else if param.type === "seed"}
        <SeedParam
          value={(values[param.key] as number) ?? -1}
          locked={seedLocked}
          {lastSeed}
          onedit={onseededit}
          onroll={onseedroll}
          ontogglelock={onseedlock}
        />
      {:else if param.type === "size"}
        <SizeParam
          {param}
          value={(values[param.key] as [number, number]) ?? [1024, 1024]}
          onchange={(value) => onchange(param.key, value)}
        />
      {:else if param.type === "lora_list"}
        <LoraListParam
          {param}
          value={(values[param.key] as LoraRow[]) ?? []}
          models={loras}
          onchange={(rows) => onchange(param.key, rows)}
        />
      {:else if param.type === "checkpoint"}
        <div class="picker-wrap">
          <button
            class="picker"
            onclick={() =>
              (checkpointOpen = checkpointOpen === param.key ? null : param.key)}
          >
            <span class="mono">
              {(values[param.key] as string) || "choose a checkpoint…"}
            </span>
          </button>
          <Popover
            open={checkpointOpen === param.key}
            title="Checkpoints"
            onclose={() => (checkpointOpen = null)}
          >
            {#if checkpoints.length === 0}
              <p class="note">
                No checkpoints found in <code class="mono">model_folders</code>.
              </p>
            {:else}
              {#each checkpoints as model (model.name)}
                <button
                  class="option"
                  onclick={() => {
                    onchange(param.key, model.name);
                    checkpointOpen = null;
                  }}
                >
                  {model.display_name}
                </button>
              {/each}
            {/if}
          </Popover>
        </div>
      {:else}
        <!--
          image / mask / video: the content-addressed input store is Phase 3,
          so the panel says so rather than pretending to accept a file.
        -->
        <p class="note">
          <TriangleAlert size={12} />
          {param.type} inputs arrive with the content-addressed input store in a later phase,
          so this workflow cannot run yet.
        </p>
      {/if}
    </div>
  {/snippet}

  {#each ordered as param (param.key)}
    {@render field(param)}
  {/each}

  {#if advanced.length > 0}
    <div class="advanced">
      <button class="advanced-head" onclick={() => (advancedOpen = !advancedOpen)}>
        {#if advancedOpen}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
        <span>Advanced</span>
        <span class="mono dim keys">
          {advanced.map((param) => param.key).join(" · ")}
        </span>
        <span class="mono dim count">{advanced.length}</span>
      </button>
      {#if advancedOpen}
        <div class="advanced-body">
          {#each advanced as param (param.key)}
            {@render field(param)}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .panel-head {
    padding: 10px 12px 6px;
  }

  .count {
    font-size: 11px;
  }

  .reset {
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    padding: 2px 4px;
  }

  .warning {
    margin: 0 12px 6px;
    padding: 6px 8px;
    border-radius: var(--radius-control);
    background: #2e2114;
    color: var(--running);
    font-size: 11px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .params {
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .param-label {
    margin-bottom: 5px;
    gap: 6px;
  }

  .name {
    font-size: 12px;
    color: var(--text);
  }

  .required {
    color: var(--accent);
  }

  textarea.text {
    resize: vertical;
    min-height: 62px;
    line-height: 1.45;
    field-sizing: content;
  }

  .number {
    gap: 8px;
  }

  .number input[type="range"] {
    flex: 1;
  }

  .narrow {
    width: 72px;
    flex: 0 0 auto;
    text-align: right;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .toggle input {
    width: auto;
    accent-color: var(--accent);
  }

  .advanced {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }

  .advanced-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: transparent;
    padding: 2px 0;
    font-size: 12px;
    color: var(--text-2);
  }

  .advanced-head:hover {
    background: transparent;
    color: var(--text);
  }

  .keys {
    font-size: 11px;
    flex: 1;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
  }

  .picker-wrap {
    position: relative;
  }

  .picker {
    width: 100%;
    text-align: left;
    background: var(--raised);
    font-size: 12px;
  }

  .option {
    display: block;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 5px 7px;
    font-size: 12px;
  }

  .option:hover {
    background: var(--control);
  }

  .note {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    padding: 7px 8px;
    border-radius: var(--radius-control);
    background: var(--raised);
    color: var(--text-4);
    font-size: 11px;
  }
</style>
