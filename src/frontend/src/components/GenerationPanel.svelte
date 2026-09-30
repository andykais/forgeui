<script lang="ts">
  import Copy from "@lucide/svelte/icons/copy";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, opensElsewhere } from "../router.svelte.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import type { ModelEntry, SampleRaw } from "../types.ts";

  /**
   * What an imported sample was made with (§8.3, DESIGN-MODEL-IMPORT §5.3):
   * Civitai's `meta`, or the settings a file carried inside it. Read-only —
   * none of it is mapped onto a workflow's params yet — but the prompt and
   * the seed are what people come here to copy, so those copy in one click.
   *
   * A model or a LoRA it names is a link wherever it can be: to its page here
   * when the library has it, by the Civitai version it was fetched from or by
   * the short hash A1111 records, and otherwise to Civitai's own page for
   * that version.
   */
  interface Props {
    raw: SampleRaw;
    /** Where the sample came from; its host is the Civitai to link to. */
    sourceUrl?: string | null;
  }

  let { raw, sourceUrl = null }: Props = $props();

  const fields = $derived(raw.fields);

  const FORMATS: Record<string, string> = {
    "civitai-meta": "Civitai",
    "a1111-infotext": "A1111 infotext",
    "comfyui-workflow": "ComfyUI",
    "forgeui-sidecar": "ForgeUI",
  };

  /** civitai.com unless the sample came from a mirror of it. */
  const civitai = $derived.by(() => {
    try {
      const url = new URL(sourceUrl ?? "");
      if (url.hostname.includes("civitai")) return url.origin;
    } catch {
      // No URL, or not one: the default below.
    }
    return "https://civitai.com";
  });

  /** A model in the library, by the Civitai version or a hash prefix. */
  function local(
    versionId: number | undefined,
    hash: string | undefined,
  ): ModelEntry | null {
    const models = app.allModels;
    if (versionId !== undefined) {
      const byVersion = models.find(
        (model) => model.source?.source?.model_version_id === versionId,
      );
      if (byVersion) return byVersion;
    }
    // A1111's short hashes: a checkpoint's is the start of its sha256; a
    // LoRA's usually is not, so a miss there is expected and harmless.
    const prefix = hash?.toLowerCase();
    if (prefix && prefix.length >= 8) {
      return models.find((model) => model.hash?.startsWith(prefix)) ?? null;
    }
    return null;
  }

  const settings = $derived(
    [
      ["seed", fields.seed],
      ["steps", fields.steps],
      ["cfg", fields.cfg],
      ["sampler", fields.sampler],
      ["scheduler", fields.scheduler],
      [
        "size",
        fields.width && fields.height ? `${fields.width} × ${fields.height}` : undefined,
      ],
      ["clip skip", fields.clip_skip],
      ["denoise", fields.denoise],
    ].filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );

  const checkpoint = $derived(local(fields.model_version_id, fields.model_hash));

  /** In the app, unless the click asked for a new tab. */
  function openModel(event: MouseEvent, hash: string) {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    navigate(`/models/${hash}`);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.message(`${what} copied`);
    } catch {
      toasts.message("could not reach the clipboard");
    }
  }
</script>

<section class="generation">
  <header>
    <span class="label">Generation</span>
    <span class="mono dim format">{FORMATS[raw.format] ?? raw.format}</span>
  </header>

  {#snippet text(key: string, value: string)}
    <div class="field">
      <div class="key-row">
        <span class="key">{key}</span>
        <button class="copy" title={`Copy the ${key}`} onclick={() => copy(value, key)}>
          <Copy size={11} />
        </button>
      </div>
      <div class="value">{value}</div>
    </div>
  {/snippet}

  {#if fields.prompt}{@render text("prompt", fields.prompt)}{/if}
  {#if fields.negative_prompt}
    {@render text("negative prompt", fields.negative_prompt)}
  {/if}

  {#if fields.model || fields.model_version_id !== undefined}
    <div class="field">
      <div class="key">model</div>
      <div class="mono">
        {#if checkpoint?.hash}
          <a
            class="link"
            href={`/models/${checkpoint.hash}`}
            onclick={(event) => openModel(event, checkpoint!.hash!)}
            >{checkpoint.display_name}</a
          >
        {:else if fields.model_version_id !== undefined}
          <a
            class="link external"
            href={`${civitai}/model-versions/${fields.model_version_id}`}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {fields.model ?? `version ${fields.model_version_id}`} ↗
          </a>
        {:else}
          {fields.model}
        {/if}
        {#if fields.model_hash}<span class="dim"> · {fields.model_hash}</span>{/if}
      </div>
    </div>
  {/if}

  {#if fields.loras && fields.loras.length > 0}
    <div class="field">
      <div class="key">loras</div>
      <div class="loras">
        {#each fields.loras as lora, i (i)}
          {@const mine = local(lora.model_version_id, lora.hash)}
          <div class="lora">
            <span class="lora-name mono">
              {#if mine?.hash}
                <a
                  class="link"
                  href={`/models/${mine.hash}`}
                  onclick={(event) => openModel(event, mine.hash!)}>{mine.display_name}</a
                >
              {:else if lora.model_version_id !== undefined}
                <a
                  class="link external"
                  href={`${civitai}/model-versions/${lora.model_version_id}`}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  title={lora.name}
                >
                  {lora.name} ↗
                </a>
              {:else}
                <span title={lora.hash ? `hash ${lora.hash}` : undefined}
                  >{lora.name}</span
                >
              {/if}
            </span>
            {#if lora.weight !== undefined}
              <span class="mono dim weight">{lora.weight}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if settings.length > 0}
    <div class="grid">
      {#each settings as [key, value] (key)}
        <div class="field">
          <div class="key">{key}</div>
          <div class="mono" class:selectable={key === "seed"}>{value}</div>
        </div>
      {/each}
    </div>
  {/if}

  {#if !fields.prompt && settings.length === 0 && !fields.loras?.length}
    <p class="dim empty">
      The file says it came from {FORMATS[raw.format] ?? raw.format}, but nothing in it
      reads as a prompt or a setting.
    </p>
  {/if}
</section>

<style>
  .generation {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 2px;
  }

  .format {
    font-size: 11px;
  }

  .field {
    background: var(--raised);
    border-radius: var(--radius-control);
    padding: 3px 7px 5px;
    min-width: 0;
  }

  .key-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .key {
    color: var(--text-4);
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .field > :not(.key):not(.key-row) {
    color: var(--text-2);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .value {
    white-space: pre-wrap;
    max-height: 220px;
    overflow: auto;
  }

  .copy {
    display: flex;
    padding: 2px;
    background: transparent;
    color: var(--text-4);
  }

  .copy:hover {
    background: var(--control);
    color: var(--text);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }

  .loras {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .lora {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .lora-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .weight {
    flex: 0 0 auto;
    font-size: 11px;
  }

  .link {
    color: var(--accent);
    text-decoration: none;
  }

  .link:hover {
    text-decoration: underline;
  }

  .selectable {
    user-select: all;
  }

  .empty {
    margin: 0;
    font-size: 11px;
  }
</style>
