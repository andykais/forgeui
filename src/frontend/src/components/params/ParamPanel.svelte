<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { tick, untrack } from "svelte";
  import SeedParam from "./SeedParam.svelte";
  import SizeParam from "./SizeParam.svelte";
  import LoraListParam from "./LoraListParam.svelte";
  import ModelParam from "./ModelParam.svelte";
  import type { LoraRow, Manifest, ModelEntry, Param } from "../../types.ts";

  /**
   * The param panel is rendered from the manifest alone (§4.2, §11.2):
   * required params first, then optional, then a collapsed Advanced section,
   * under a PARAMETERS header that carries Edit and Reset to defaults.
   */
  interface Props {
    manifest: Manifest;
    values: Record<string, unknown>;
    seedLocked: boolean;
    lastSeed: number | null;
    loras?: ModelEntry[];
    checkpoints?: ModelEntry[];
    /** A `model` param picks from its own class, not always `diffusion`. */
    modelsOfClass?: (modelClass: string | undefined) => ModelEntry[];
    /** Keys the panel was filled from that this manifest no longer has (§6.4). */
    warnings?: string[];
    onchange: (key: string, value: unknown) => void;
    onreset: () => void;
    /** Open this workflow's inputs for editing; absent hides the button. */
    onedit?: () => void;
    /** Enter in a text param runs the workflow; absent leaves Enter alone. */
    onsubmit?: () => void;
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
    modelsOfClass = () => checkpoints,
    warnings = [],
    onchange,
    onreset,
    onedit,
    onsubmit,
    onseededit,
    onseedroll,
    onseedlock,
  }: Props = $props();

  let advancedOpen = $state(false);
  let paramsEl = $state<HTMLDivElement | undefined>(undefined);

  /**
   * What a picker's popover covers: the panel that scrolls, so the list is
   * the same size wherever in the panel its trigger happens to be (§11.3).
   */
  const pickerFill = $derived(
    paramsEl?.closest<HTMLElement>(".scroll") ?? paramsEl ?? null,
  );

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

  function isModelParam(param: Param): boolean {
    return (
      param.type === "model" || param.type === "text_encoder" || param.type === "vae"
    );
  }

  /**
   * What would stop this param from running, in the terms the server refuses
   * the job in (§5.1): a required field left empty, or a model that is not in
   * the model folders. A collapsed Advanced section hides both, so the panel
   * has to say that they are down there.
   */
  function problemOf(param: Param): string | null {
    const value = values[param.key];
    if (isModelParam(param)) {
      const name = typeof value === "string" ? value : "";
      const models = modelsOfClass(param.filter?.class);
      if (name !== "" && models.length > 0) {
        if (!models.some((model) => model.name === name)) return "not found";
      }
    }
    if (!param.required || param.type === "seed") return null;
    const empty =
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);
    return empty ? "required" : null;
  }

  const advancedProblems = $derived(
    advanced.filter((param) => problemOf(param) !== null).map((param) => param.key),
  );

  /**
   * A problem the user cannot see is a problem they cannot fix, so Advanced
   * opens itself when one appears. It opens once per distinct set, so closing
   * it again sticks.
   */
  let announced = $state("");
  $effect(() => {
    const signature = advancedProblems.join(" ");
    untrack(() => {
      if (signature.length === 0) {
        announced = "";
      } else if (signature !== announced) {
        announced = signature;
        advancedOpen = true;
      }
    });
  });

  /**
   * Where a picked model or LoRA hands the caret back: the prompt, so the
   * next thing typed lands in it without a second click.
   */
  const promptKey = $derived(
    (
      manifest.params.find((param) => param.type === "text" && param.required) ??
      manifest.params.find((param) => param.type === "text")
    )?.key ?? null,
  );

  function promptField(): HTMLTextAreaElement | null {
    const key = promptKey;
    if (!key) return null;
    return (
      [...(paramsEl?.querySelectorAll("[data-param]") ?? [])]
        .find((element) => (element as HTMLElement).dataset.param === key)
        ?.querySelector("textarea") ?? null
    );
  }

  /**
   * Picking a model or a LoRA also changes a value, so the panel re-renders
   * on the same turn: wait for that to settle before taking the caret, then
   * again on the next frame, because whichever of the two lands last is the
   * one that decides where the focus ends up.
   */
  async function focusPrompt(): Promise<void> {
    if (!promptKey) return;
    const take = () => {
      const field = promptField();
      if (!field || document.activeElement === field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
      field.scrollIntoView({ block: "nearest" });
    };
    await tick();
    take();
    requestAnimationFrame(take);
  }

  /**
   * Grow with the text, on every keystroke and whenever the value arrives
   * from outside — a workflow being selected, a panel filled from the last
   * job, Reset to defaults.
   *
   * `field-sizing: content` does grow the box, but only until someone drags
   * the resize handle: that writes an inline height, which outranks it for
   * good. There is no way back from that in the UI, and the same textarea is
   * reused when the next workflow also has a `prompt`, so one drag follows
   * you from workflow to workflow. Setting the height here on every input is
   * what makes it unstickable — the handle is off, so nothing else writes to
   * it, and every keystroke reasserts the fit.
   */
  /** The text each box was last sized for, so an unchanged one is left alone. */
  const fitted = new WeakMap<HTMLTextAreaElement, string>();

  function fitTextarea(node: HTMLTextAreaElement, force = false): void {
    // Every param change runs this over every prompt, and a slider sends one
    // per pixel dragged. Measuring costs a reflow, so a box whose text has
    // not moved is not touched at all.
    if (!force && fitted.get(node) === node.value) return;
    fitted.set(node, node.value);
    // `height: auto` momentarily shrinks the panel's content, and the browser
    // clamps the scroll position to the shorter page before the real height
    // comes back. Putting it back is what stops the panel jumping to the top.
    const scroller = node.closest<HTMLElement>(".scroll");
    const top = scroller?.scrollTop;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
    if (scroller && top !== undefined && scroller.scrollTop !== top) {
      scroller.scrollTop = top;
    }
  }

  function autogrow(node: HTMLTextAreaElement) {
    const fit = () => fitTextarea(node);
    // A narrower panel wraps the same text differently, so that one is forced.
    const rewrap = () => fitTextarea(node, true);
    fit();
    node.addEventListener("input", fit);
    globalThis.addEventListener("resize", rewrap);
    return {
      destroy: () => {
        node.removeEventListener("input", fit);
        globalThis.removeEventListener("resize", rewrap);
      },
    };
  }

  /**
   * A value that arrives from outside sizes the box too: the panel filled
   * from the last job on load, `Edit in Generate`, Reset to defaults. Only an
   * input event resizes it on its own, and none of those raise one.
   */
  $effect(() => {
    values;
    const fields = paramsEl?.querySelectorAll<HTMLTextAreaElement>("textarea.text");
    for (const field of fields ?? []) fitTextarea(field);
  });

  /** Enter runs the workflow, Shift+Enter is a newline (§11.4). */
  function onPromptKeydown(event: KeyboardEvent): void {
    if (!onsubmit) return;
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    if (event.ctrlKey || event.metaKey || event.isComposing) return;
    event.preventDefault();
    onsubmit();
  }
</script>

<div class="panel-head row">
  <span class="label">Parameters</span>
  <span class="mono dim count">{manifest.params.length}</span>
  <span class="spacer"></span>
  {#if onedit}
    <button class="link" onclick={onedit} title="Edit this workflow's inputs">
      Edit
    </button>
  {/if}
  <button class="link" onclick={onreset}>Reset to defaults</button>
</div>

{#if warnings.length > 0}
  <p class="warning mono">
    <TriangleAlert size={12} />
    ignored: {warnings.join(", ")} — this workflow no longer exposes
    {warnings.length === 1 ? "it" : "them"}
  </p>
{/if}

<div class="params" bind:this={paramsEl}>
  {#snippet field(param: Param)}
    {@const problem = problemOf(param)}
    <div
      class="param"
      class:problem={problem === "not found"}
      data-param={param.key}
      data-type={param.type}
    >
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
          use:autogrow
          onkeydown={onPromptKeydown}
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
        <!--
          No `onpicked` here, unlike a model. Picking a model is the start of
          writing a prompt, so the caret goes there; adding a LoRA is not —
          you are working in this list and usually about to add another, and
          being thrown back up to the prompt took the panel with it.
        -->
        <LoraListParam
          {param}
          value={(values[param.key] as LoraRow[]) ?? []}
          models={loras}
          onchange={(rows) => onchange(param.key, rows)}
          fill={pickerFill}
        />
      {:else if param.type === "model" || param.type === "text_encoder" || param.type === "vae"}
        <ModelParam
          {param}
          value={(values[param.key] as string) ?? ""}
          models={modelsOfClass(param.filter?.class)}
          onchange={(name) => onchange(param.key, name)}
          onpicked={focusPrompt}
          fill={pickerFill}
        />
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
        {#if advancedProblems.length > 0}
          <span class="badge error problems" title="Something down here needs fixing">
            <TriangleAlert size={11} />
            {advancedProblems.length}
          </span>
        {/if}
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
    gap: 6px;
  }

  .count {
    font-size: 11px;
  }

  .link {
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

  /*
   * Only a value that is wrong is marked, not one that has not been typed
   * yet: `required` already says what an empty field needs.
   */
  .param.problem .name {
    color: var(--error);
  }

  .required {
    color: var(--accent);
  }

  /*
   * The height is set from the content by `autogrow`, so the box always fits
   * what is in it. `resize` is off: a dragged height would be overwritten by
   * the next keystroke, which is worse than not offering the handle.
   */
  textarea.text {
    resize: none;
    min-height: 62px;
    line-height: 1.45;
    overflow-y: hidden;
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

  .problems {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
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
