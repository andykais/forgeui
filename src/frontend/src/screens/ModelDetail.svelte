<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Brain from "@lucide/svelte/icons/brain";
  import Copy from "@lucide/svelte/icons/copy";
  import Eye from "@lucide/svelte/icons/eye";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, opensElsewhere } from "../router.svelte.ts";
  import { panel } from "../stores/panel.svelte.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import { bytes, relativeTime } from "../lib/format.ts";
  import type { ModelDetail, Output, Sample } from "../types.ts";
  import FamilyPicker from "../components/FamilyPicker.svelte";
  import SamplesStrip from "../components/SamplesStrip.svelte";
  import TagPicker from "../components/TagPicker.svelte";
  import Tile from "../components/Tile.svelte";
  import Viewer from "../components/Viewer.svelte";

  /**
   * The model page (§8.1, §11.2, frame 05): an edit-in-place header — blur
   * commits, Esc reverts — the full sha256 on its own line, the Samples
   * strip, and the gallery filtered to this model beneath.
   *
   * A model with no hash yet cannot be edited at all: the fields are
   * disabled and the badge says why, which is the same thing the API says
   * with a 409 (§8.1).
   */
  let { id }: { id: string } = $props();

  let model = $state<ModelDetail | null>(null);
  let error = $state<string | null>(null);
  let outputs = $state<Output[]>([]);
  let selectedId = $state<string | null>(null);
  let importing = $state(false);
  let rereading = $state(false);

  /**
   * The debugging action of §8.1: when a model is filed as something it
   * plainly is not, this says whether the file or the cache was wrong.
   */
  async function reread() {
    if (!model) return;
    rereading = true;
    const before = model.family;
    try {
      model = await api.rescanModel(model.id);
      await app.refreshModels();
      toasts.message(
        model.family === before
          ? `Re-read it: still ${model.family}`
          : `Re-read it: ${before} → ${model.family}`,
      );
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not re-read it");
    } finally {
      rereading = false;
    }
  }
  /** Named rather than inline, so `model` is narrowed where it is read. */
  function toggleHidden() {
    if (!model) return;
    void patch({ hidden: !model.hidden });
  }

  let nameDraft = $state("");
  let notesDraft = $state("");
  /**
   * Where a tag leads: the Models screen, filtered to it, on the tab this
   * model is on. The screen is tabbed by class and falls back to diffusion,
   * so a tag on a LoRA that did not name its class landed on a tab the LoRA
   * was not in and showed nothing.
   */
  function tagHref(tag: string): string {
    const params = new URLSearchParams({ tags: tag });
    if (model && model.class !== "diffusion") params.set("class", model.class);
    return `/models?${params}`;
  }

  /** How many models carry each tag, for the chips beside this model's. */
  const tagCounts = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const entry of app.allModels) {
      for (const tag of entry.tags) totals.set(tag, (totals.get(tag) ?? 0) + 1);
    }
    return totals;
  });
  /** Family counts for the combo, as frame 05 draws them. */
  let familyCounts = $state<Map<string, number>>(new Map());

  const hashing = $derived(model?.hashing ?? false);
  const selected = $derived(outputs.find((output) => output.id === selectedId) ?? null);

  $effect(() => {
    id;
    untrack(() => void load());
  });

  /**
   * A page opened while the file was still being read has to notice when it
   * stops being read: the badge goes, the fields come alive, and the URL
   * becomes the hash the model is now known by (§8.1).
   */
  $effect(() => {
    const running = app.hashing?.running ?? false;
    const done = app.hashing?.done ?? 0;
    void running;
    void done;
    untrack(() => {
      if (model?.hashing) void load();
    });
  });

  async function load() {
    try {
      const detail = await api.model(id);
      model = detail;
      // It was addressed by path because it had no hash; now it has one.
      if (detail.hash && id.startsWith("path:")) {
        navigate(`/models/${detail.hash}`, { replace: true });
      }
      nameDraft = detail.display_name;
      notesDraft = detail.notes ?? "";
      error = null;
      outputs = detail.hash
        ? (await api.outputs({ models: [detail.hash], limit: 60 })).outputs
        : [];
      void loadFamilyCounts(detail.kind);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** Decoration on the family combo: a failure here is not a failed page. */
  async function loadFamilyCounts(kind: string) {
    try {
      const counts = new Map<string, number>();
      for (const entry of (await api.models({ kind })).models) {
        counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
      }
      familyCounts = counts;
    } catch {
      familyCounts = new Map();
    }
  }

  /**
   * Only the field that was written gets its draft resynced: a reply that
   * arrives while another field is being typed into must not overwrite it.
   */
  /** Blank puts the bound back to the default rather than to zero. */
  function setBound(field: "strength_min" | "strength_max", input: HTMLInputElement) {
    const raw = input.value.trim();
    if (raw === "") {
      void patch({ [field]: null });
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      input.value = String(model?.[field] ?? "");
      return;
    }
    void patch({ [field]: value });
  }

  async function patch(body: Parameters<typeof api.patchModel>[1]) {
    if (!model) return;
    try {
      model = await api.patchModel(model.id, body);
      if ("display_name" in body) nameDraft = model.display_name;
      if ("notes" in body) notesDraft = model.notes ?? "";
      await app.refreshModels();
    } catch (cause) {
      // A 409 means the hasher has not got here yet, which the badge says.
      toasts.message(cause instanceof Error ? cause.message : "could not save that");
      if (model) {
        nameDraft = model.display_name;
        notesDraft = model.notes ?? "";
      }
    }
  }

  function commitName() {
    if (!model || hashing) return;
    if (nameDraft.trim() === model.display_name) return;
    void patch({ display_name: nameDraft.trim() });
  }

  function commitNotes() {
    if (!model || hashing) return;
    if (notesDraft === (model.notes ?? "")) return;
    void patch({ notes: notesDraft });
  }


  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.message(`${what} copied`);
    } catch {
      toasts.message("could not reach the clipboard");
    }
  }

  async function importSamples(files: File[]) {
    if (!model?.hash) return;
    importing = true;
    try {
      for (const file of files) await api.uploadSample(model.hash, file);
      await load();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "the import failed");
    } finally {
      importing = false;
    }
  }

  async function deleteSample(sample: Sample) {
    try {
      await api.deleteSample(sample.id);
      await load();
      await app.refreshModels();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not delete it");
    }
  }

  /** Only promoted samples have params to reuse (§8.3). */
  async function editSample(sample: Sample) {
    const workflowId =
      (sample.params?.workflow_id as string | undefined) ?? app.workflows[0]?.id;
    if (!workflowId) return;
    await panel.editWith(workflowId, sample.params ?? {});
    navigate(`/generate?workflow=${workflowId}`);
  }

  function openOutput(output: Output) {
    selectedId = output.id;
  }

  async function editInGenerate(output: Output) {
    if (!output.workflow_id) return;
    const detail = await api.output(output.id);
    await panel.editWith(output.workflow_id, detail.sidecar?.params ?? output.params);
    navigate(`/generate?workflow=${output.workflow_id}`);
  }

  async function rerun(output: Output) {
    try {
      await api.rerun({ output_id: output.id });
      toasts.message("Queued");
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not rerun it");
    }
  }

  async function removeOutput(output: Output) {
    await api.deleteOutput(output.id).catch(() => {});
    outputs = outputs.filter((entry) => entry.id !== output.id);
    selectedId = null;
  }
</script>

{#if selected}
  <Viewer
    screen="models"
    {outputs}
    {selected}
    onselect={(output) => (selectedId = output.id)}
    onclose={() => (selectedId = null)}
    onedit={editInGenerate}
    onrerun={rerun}
    ondelete={removeOutput}
  />
{:else if error}
  <div class="empty">
    <p class="error mono">{error}</p>
    <button onclick={() => navigate("/models")}>Back to models</button>
  </div>
{:else if model}
  <section class="model">
    <nav class="crumbs mono dim">
      <button onclick={() => navigate("/models")}>Models</button>
      <span>/</span>
      <button onclick={() => navigate(`/models?kind=${model?.kind}`)}>
        {model.kind}
      </button>
      <span>/</span>
      <span class="here">{model.display_name}</span>
    </nav>

    <header class="head">
      <button class="back" title="Back to models" onclick={() => navigate("/models")}>
        <ArrowLeft size={15} />
      </button>

      <div class="thumb">
        {#if model.thumb_url}
          <img src={model.thumb_url} alt="" />
        {:else}
          <span class="plate"><Brain size={20} /></span>
        {/if}
      </div>

      <div class="identity">
        <div class="name-row">
          <input
            class="name"
            aria-label="Display name"
            disabled={hashing}
            value={nameDraft}
            oninput={(event) =>
              (nameDraft = (event.currentTarget as HTMLInputElement).value)}
            onblur={commitName}
            onkeydown={(event) => {
              if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
              if (event.key === "Escape") {
                nameDraft = model?.display_name ?? "";
                (event.currentTarget as HTMLInputElement).blur();
              }
            }}
          />

          {#if model.display_name !== model.filename.replace(/\.[^.]+$/, "")}
            <!-- The name is editable; the filename it falls back to is not. -->
            <button
              class="reset mono"
              disabled={hashing}
              onclick={() => patch({ display_name: null })}
            >
              Reset to filename
            </button>
          {/if}

          {#if hashing}
            <span class="badge hashing mono" title="Reading the file to identify it">
              hashing
            </span>
          {:else}
            <FamilyPicker
              family={model.family}
              counts={familyCounts}
              onchange={(family) => void patch({ family })}
            />
          {/if}
        </div>

        <div class="usage mono dim">
          <span>{bytes(model.size)}</span>
          <span>·</span>
          {#if model.output_count > 0}
            <a
              class="outputs"
              href={`/gallery?models=${model.hash}`}
              onclick={(event) => {
                if (opensElsewhere(event)) return;
                event.preventDefault();
                navigate(`/gallery?models=${model?.hash}`);
              }}
            >
              {model.output_count} output{model.output_count === 1 ? "" : "s"}
            </a>
          {:else}
            <span>unused</span>
          {/if}
          {#if model.last_used_at}
            <span>·</span>
            <span>last used {relativeTime(model.last_used_at)}</span>
          {/if}
        </div>

        <!-- The filename is immutable and lives only here (§8.1). -->
        <div class="file mono dim">
          <span>{model.name}</span>
          <button
            class="icon"
            title="Copy path"
            onclick={() => copy(model?.path ?? "", "Path")}
          >
            <Copy size={12} />
          </button>
          {#if !model.present}
            <span class="badge mono missing">file missing</span>
          {/if}
        </div>

        <div class="hash mono dim">
          {#if model.hash}
            sha256 <span class="value">{model.hash}</span>
          {:else}
            sha256 <span class="value pending">still being read</span>
          {/if}
        </div>

        <!--
          The sha256 is what these two look a model up by, which is the one
          identifier that survives being renamed or refiled. Nothing is sent
          anywhere: they are ordinary links, opened when clicked (§8.1).
        -->
        {#if model.hash}
          <div class="lookups mono dim">
            <!--
              Re-reads the file, header and hash both, past the caches the
              ordinary scan uses to skip files that have not moved — which is
              exactly why the ordinary Rescan cannot fix a wrong cached
              answer (§8.1).
            -->
            <button
              class="reread"
              disabled={rereading}
              title="Read this file again: its header and its hash, ignoring what was cached"
              onclick={reread}
            >
              {rereading ? "Re-reading…" : "Re-read this file"}
            </button>
            <!--
              Hidden is out of the Generate pickers, not gone: it is still
              here, still in the Models list behind Show hidden (§8.1).
            -->
            <button
              class="reread"
              class:on={model.hidden}
              title={model.hidden
                ? "Offer this in the Generate inputs again"
                : "Keep this out of the Generate inputs; it stays listed on Models"}
              onclick={toggleHidden}
            >
              {#if model.hidden}
                <Eye size={11} /> Hidden
              {:else}
                <EyeOff size={11} /> Hide
              {/if}
            </button>
            <span class="spacer"></span>
            look up
            <a
              href={`https://civitaiarchive.com/sha256/${model.hash}`}
              target="_blank"
              rel="noreferrer noopener"
            >civitaiarchive</a>
            <a
              href={`https://civitai.red/search/models?sortBy=models_v9&query=${model.hash}`}
              target="_blank"
              rel="noreferrer noopener"
            >civitai</a>
          </div>
        {/if}

        <!--
          What a LoRA's strength sliders reach in the panel (§8.1). Typed by
          hand, because only the person who trained or downloaded it knows
          how far it wants to be pushed; blank is the -2..2 default.
        -->
        {#if model.class === "lora"}
          <div class="strength row">
            <span class="label">strength range</span>
            <input
              class="mono bound"
              type="number"
              step="0.1"
              aria-label="Lowest strength"
              disabled={hashing}
              value={model.strength_min}
              onchange={(event) => setBound("strength_min", event.currentTarget)}
            />
            <span class="dim">to</span>
            <input
              class="mono bound"
              type="number"
              step="0.1"
              aria-label="Highest strength"
              disabled={hashing}
              value={model.strength_max}
              onchange={(event) => setBound("strength_max", event.currentTarget)}
            />
          </div>
        {/if}

        <!--
          The same picker the Models screen filters with, so the tags on
          offer are the ones that exist, with what they already hold beside
          them; typing a name nothing matches offers to make it. Each tag
          here is a link into that screen filtered to it — a tag is only
          worth carrying if it can be followed.
        -->
        <div class="tags">
          {#each model.tags as tag (tag)}
            <a
              class="tag mono"
              href={tagHref(tag)}
              title={`Show everything tagged ${tag}`}
              onclick={(event) => {
                if (opensElsewhere(event)) return;
                event.preventDefault();
                navigate(tagHref(tag));
              }}
            >
              {tag}
              <span class="dim">{tagCounts.get(tag) ?? 1}</span>
            </a>
          {/each}
          {#if !hashing}
            <TagPicker
              models={app.allModels}
              selected={model.tags}
              placeholder="+ tag"
              mode="edit"
              allowCreate
              onchange={(tags: string[]) => void patch({ tags })}
            />
          {/if}
        </div>

        <textarea
          class="notes"
          aria-label="Notes"
          placeholder="Notes"
          disabled={hashing}
          value={notesDraft}
          oninput={(event) =>
            (notesDraft = (event.currentTarget as HTMLTextAreaElement).value)}
          onblur={commitNotes}
          onkeydown={(event) => {
            if (event.key === "Escape") {
              notesDraft = model?.notes ?? "";
              (event.currentTarget as HTMLTextAreaElement).blur();
            }
          }}
        ></textarea>
      </div>
    </header>

    <div class="body">
      {#if model.hash}
        <SamplesStrip
          samples={model.samples}
          thumbPath={model.thumb_path}
          busy={importing}
          onimport={importSamples}
          onthumb={(sample) => patch({ thumb_sample_id: sample.id })}
          ondelete={deleteSample}
          onedit={editSample}
        />
      {/if}

      <section class="outputs-section">
        <header>
          <h2>Outputs</h2>
          <span class="mono dim">{model.output_count}</span>
        </header>
        {#if outputs.length === 0}
          <p class="dim empty-line">Nothing has been generated with this model yet.</p>
        {:else}
          <div class="grid">
            {#each outputs as output (output.id)}
              <!-- Open it; the viewer is where the actions live (§11.2). -->
              <Tile {output} onopen={openOutput} />
            {/each}
          </div>
        {/if}
      </section>
    </div>
  </section>
{/if}

<style>
  .model {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }

  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 0;
    font-size: 11px;
  }

  .crumbs button {
    background: transparent;
    color: var(--text-3);
    padding: 0;
    font-size: 11px;
    text-transform: capitalize;
  }

  .crumbs button:hover {
    color: var(--accent);
  }

  .crumbs .here {
    color: var(--text-2);
  }

  .reset {
    background: transparent;
    color: var(--text-4);
    font-size: 10px;
    padding: 2px 6px;
  }

  .reset:hover:not(:disabled) {
    color: var(--text-2);
    background: var(--control);
  }


  .head {
    display: flex;
    gap: 12px;
    padding: 12px;
    align-items: flex-start;
  }

  .back {
    background: transparent;
    color: var(--text-3);
    padding: 4px;
  }

  .back:hover {
    color: var(--text);
    background: var(--raised);
  }

  .thumb {
    width: 120px;
    height: 120px;
    border-radius: var(--radius-card);
    overflow: hidden;
    background: var(--control);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--mark);
    flex: 0 0 auto;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .identity {
    flex: 1;
    min-width: 0;
    max-width: 640px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .usage {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .name {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text);
    font-size: 17px;
    padding: 2px 6px;
    border-radius: var(--radius-input);
    min-width: 0;
    flex: 0 1 auto;
    width: 22ch;
  }

  .name:hover:not(:disabled),
  .name:focus {
    border-color: var(--edge);
    background: var(--control);
  }

  .name:disabled {
    color: var(--text-3);
  }


  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-control);
    background: var(--control);
    color: var(--text-3);
  }

  .badge.hashing {
    background: var(--accent-tint);
    color: var(--accent);
  }

  .badge.missing {
    background: var(--control);
    color: var(--error);
  }


  .file,
  .hash {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .lookups {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }

  .reread {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    padding: 2px 6px;
  }

  .reread.on {
    background: var(--accent-tint-2);
    color: var(--accent);
  }

  .reread:hover:not(:disabled) {
    color: var(--text-2);
    background: var(--control);
  }

  .lookups a {
    color: var(--accent);
  }

  .lookups a:hover {
    text-decoration: underline;
  }

  /* Full sha256 on its own line: selectable, never truncated (§11.2). */
  .hash .value {
    user-select: all;
    color: var(--text-3);
    word-break: break-all;
  }

  .hash .value.pending {
    color: var(--text-4);
  }

  .icon {
    background: transparent;
    color: var(--text-4);
    padding: 2px;
  }

  .icon:hover:not(:disabled) {
    color: var(--text-2);
  }

  .outputs {
    color: var(--accent);
  }

  .strength {
    gap: 6px;
    font-size: 12px;
  }

  .bound {
    width: 66px;
    text-align: right;
    font-size: 12px;
    padding: 3px 6px;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  /* A link now: a tag is worth carrying only if it can be followed. */
  .tag {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: var(--radius-control);
    background: var(--control);
    color: var(--text-2);
  }

  .tag:hover {
    background: var(--control-selected);
    color: var(--text);
  }


  .notes {
    background: var(--control);
    border: 1px solid transparent;
    border-radius: var(--radius-input);
    color: var(--text-2);
    font-size: 12px;
    padding: 6px 8px;
    resize: vertical;
    min-height: 44px;
    max-width: 560px;
  }

  .notes:focus {
    border-color: var(--edge);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 0 12px 20px;
  }

  .outputs-section header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
  }

  h2 {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-2);
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }

  .empty-line {
    font-size: 12px;
    margin: 0;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  .error {
    color: var(--error);
  }
</style>
