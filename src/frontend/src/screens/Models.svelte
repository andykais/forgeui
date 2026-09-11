<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import Grid3x3 from "@lucide/svelte/icons/grid-3x3";
  import List from "@lucide/svelte/icons/list";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Brain from "@lucide/svelte/icons/brain";
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, router, setQuery } from "../router.svelte.ts";
  import { bytes, relativeTime } from "../lib/format.ts";
  import { matcher } from "../lib/search.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import type { ModelEntry } from "../types.ts";
  import ModelCard from "../components/ModelCard.svelte";
  import FamilyPicker from "../components/FamilyPicker.svelte";
  import TagPicker from "../components/TagPicker.svelte";

  /**
   * Models (§11.2, frame 04): a tab per model class, tiles or table, search
   * over the same fields the API's `q` searches, and a family filter with an
   * `unset` chip. Every filter is a URL param, so a view is a link. No
   * multi-select and no bulk edits (MOCK-REVISIONS §8).
   *
   * The tabs are classes, not folders: `checkpoints`, `Stable-Diffusion`,
   * `diffusion_models` and `unet` all hold things that can drive a generation
   * (§8.2), and looking through four tabs for one of them is four times the
   * work. Which folder a file sits in is a filter under the tab, for when it
   * is the question.
   */
  let models = $state<ModelEntry[]>([]);
  /** Every model of every kind, for the counts on the tabs and the chips. */
  let all = $state<ModelEntry[]>([]);
  let folders = $state<string[]>([]);
  /** Which class each configured folder holds; the server owns the table. */
  let classes = $state<Record<string, string>>({});
  let loading = $state(false);
  let searchDraft = $state("");
  let rescanning = $state(false);
  /**
   * Keyboard navigation (§11.4): which model the arrows are moving from.
   * A grid whose column count is `auto-fill` cannot be walked in two
   * dimensions without measuring it, so the tiles step through the list
   * left and right, and the table — one model per line — up and down.
   */
  let selectedId = $state<string | null>(null);
  let listEl = $state<HTMLElement | undefined>(undefined);

  const query = $derived(router.current.query);
  const modelClass = $derived(query.get("class") ?? "diffusion");
  /** The folder within the class, or "" for all of them. */
  const kind = $derived(query.get("kind") ?? "");
  const family = $derived(query.get("family") ?? "");
  const q = $derived(query.get("q") ?? "");
  /** Comma separated, all required; a URL param like every other filter. */
  const tags = $derived(query.get("tags") ?? "");
  const chosenTags = $derived(
    tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0),
  );
  /** The set-aside pile, or everything else; never both (§8.1). */
  const hidden = $derived(query.get("hidden") === "1");
  const view = $derived(query.get("view") === "table" ? "table" : "tiles");
  const filterKey = $derived(
    `${modelClass}\u0000${kind}\u0000${family}\u0000${q}\u0000${tags}\u0000${hidden}`,
  );

  /** What a class is called on a tab; anything else is shown as it is named. */
  const CLASS_LABELS: Record<string, string> = {
    diffusion: "Diffusion models",
    lora: "LoRAs",
    clip: "Text encoders",
    vae: "VAEs",
    controlnet: "ControlNet",
    upscale: "Upscalers",
    embedding: "Embeddings",
    other: "Other",
  };

  function classLabel(name: string): string {
    return CLASS_LABELS[name] ?? name;
  }

  /**
   * A tab per class the config declares a folder for, in `config.yaml` order.
   * Falling back to the models themselves keeps the tabs from vanishing while
   * the first request is still out.
   */
  const classTabs = $derived.by(() => {
    const names: string[] = [];
    for (const name of Object.values(classes)) {
      if (!names.includes(name)) names.push(name);
    }
    for (const model of all) {
      if (!names.includes(model.class)) names.push(model.class);
    }
    return names;
  });

  /** The folders that make up the current tab, when there is a choice. */
  const classKinds = $derived(
    Object.entries(classes)
      .filter(([, name]) => name === modelClass)
      .map(([folder]) => folder),
  );

  $effect(() => {
    filterKey;
    untrack(() => void load());
  });

  /**
   * Hashing changes identities, counts and thumbnails under our feet, but the
   * hasher reports twice per file: reloading on each of those would put the
   * list through two fetches per model in the folder, and the answers would
   * land out of order. They are coalesced, and `load` ignores everything but
   * the newest request.
   */
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let hashingSeen = "";
  $effect(() => {
    const signature = `${app.hashing?.running ?? false}:${app.hashing?.done ?? 0}`;
    untrack(() => {
      if (signature === hashingSeen) return;
      const first = hashingSeen === "";
      hashingSeen = signature;
      // The filter effect owns the first load; this one only follows changes.
      if (first) return;
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void load();
      }, 400);
    });
    return () => {
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      reloadTimer = null;
    };
  });

  /** Only the newest request may write to the screen. */
  let request = 0;

  async function load() {
    const mine = ++request;
    loading = true;
    try {
      const body = await api.models({
        // A chosen folder narrows the class it belongs to.
        kind: kind || undefined,
        class: kind ? undefined : modelClass,
        family: family || undefined,
        q: q || undefined,
        tags: tags || undefined,
        hidden: hidden || undefined,
      });
      if (mine !== request) return;
      models = body.models;
      folders = body.folders;
      classes = body.classes;
      searchDraft = q;
      // Both piles, so the counts can reflect the filters without a second
      // round trip per chip.
      const everything = await api.models({ hidden: hidden || undefined });
      if (mine !== request) return;
      all = everything.models;
    } catch (cause) {
      // The list that is up stays up: a failed refresh is not an empty folder.
      if (mine === request) {
        toasts.message(cause instanceof Error ? cause.message : "could not list models");
      }
    } finally {
      if (mine === request) loading = false;
    }
  }

  async function rescan() {
    rescanning = true;
    try {
      const result = await api.rescanModels();
      toasts.message(
        result.queued > 0
          ? `${result.models} models · hashing ${result.queued}`
          : `${result.models} models, nothing new to hash`,
      );
      await load();
      await app.refreshModels();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "the rescan failed");
    } finally {
      rescanning = false;
    }
  }

  async function setHidden(model: ModelEntry, next: boolean) {
    try {
      await api.patchModel(model.id, { hidden: next });
      await load();
      await app.refreshModels();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not hide it");
    }
  }

  async function setFamily(model: ModelEntry, next: string) {
    try {
      const updated = await api.patchModel(model.id, { family: next });
      models = models.map((entry) => (entry.id === updated.id ? updated : entry));
      await app.refreshModels();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not set the family");
    }
  }

  /** Keep the highlight on something that is still listed. */
  $effect(() => {
    if (selectedId && !models.some((model) => model.id === selectedId)) {
      selectedId = null;
    }
  });

  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const index = models.findIndex((model) => model.id === selectedId);
    // Enter opens whatever the highlight is on, which is what a click does.
    // Before the binding lookup, because Enter is not one of the bindings:
    // §11.4's table is about moving, and this is about arriving.
    if (event.key === "Enter" && index >= 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigate(`/models/${encodeURIComponent(models[index]!.id)}`);
      return;
    }

    const action = app.keyAction(event);
    if (!action) return;
    if (action === "close" && selectedId !== null) {
      event.preventDefault();
      selectedId = null;
      return;
    }

    // Left and right walk the tiles, up and down walk the table; each view
    // answers to the pair that matches how it is laid out.
    const forward = view === "table" ? "select_down" : "select_next";
    const back = view === "table" ? "select_up" : "select_prev";
    const delta = action === forward ? 1 : action === back ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    // Nothing chosen yet: the first key takes the first model rather than
    // jumping into the middle of the list.
    const next = index < 0 ? models[0] : models[index + delta];
    if (!next) return;
    selectedId = next.id;
    listEl
      ?.querySelector(`[data-model="${CSS.escape(next.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  const hashingLeft = $derived(models.filter((model) => model.hashing).length);
  /** What the listed models take up on disk, for the info row. */
  const listedBytes = $derived(
    models.reduce((total, model) => total + model.size, 0),
  );

  /**
   * The counts beside the tabs and the chips answer the same question the
   * list does. `all` is already narrowed to the visible or the hidden pile;
   * the search and the tags are applied here, so typing narrows the counts
   * rather than leaving them describing a library nobody is looking at.
   *
   * The class and folder counts ignore the class and folder filters, and the
   * family counts ignore the family filter — a count on a chip has to say
   * what clicking it would give you, not what you already have.
   */
  const searched = $derived.by(() => {
    const matches = matcher(q);
    const wanted = tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(
      (tag) => tag.length > 0,
    );
    return all.filter((model) => {
      if (q && !matches(model.name, model.display_name, ...model.tags)) {
        return false;
      }
      if (wanted.length === 0) return true;
      const mine = model.tags.map((tag) => tag.toLowerCase());
      return wanted.every((tag) => mine.some((own) => own.includes(tag)));
    });
  });
  /**
   * The chips are reconciled rather than hardcoded: a family the server
   * accepts, or that a model on disk is already filed as, has to be filterable
   * even when this build's constant has not caught up (§8.1).
   */
  const families = $derived(
    [...new Set([...app.families, ...all.map((model) => model.family)])].filter(
      (name) => name !== "unset",
    ),
  );
  const perKind = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const model of searched) {
      counts.set(model.kind, (counts.get(model.kind) ?? 0) + 1);
    }
    return counts;
  });
  const perClass = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const model of searched) {
      counts.set(model.class, (counts.get(model.class) ?? 0) + 1);
    }
    return counts;
  });
  /** Families of what this tab is showing, not of the whole library. */
  const perFamily = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const model of searched) {
      if (kind ? model.kind !== kind : model.class !== modelClass) continue;
      counts.set(model.family, (counts.get(model.family) ?? 0) + 1);
    }
    return counts;
  });
</script>

<svelte:window onkeydown={onKeydown} />

<section class="models">
  <header class="filters">
    <div class="row tabs">
      {#each classTabs as tab (tab)}
        <button
          class:active={modelClass === tab}
          onclick={() =>
            setQuery({ class: tab === "diffusion" ? null : tab, kind: null })}
        >
          {classLabel(tab)}
          <span class="mono dim">{perClass.get(tab) ?? 0}</span>
        </button>
      {/each}
    </div>

    <label class="search">
      <Search size={13} />
      <input
        placeholder="Search models…"
        value={searchDraft}
        oninput={(event) =>
          (searchDraft = (event.currentTarget as HTMLInputElement).value)}
        onkeydown={(event) => {
          if (event.key === "Enter") setQuery({ q: searchDraft || null });
          if (event.key === "Escape") {
            searchDraft = "";
            setQuery({ q: null });
          }
        }}
        onblur={() => setQuery({ q: searchDraft || null })}
      />
    </label>

    <!--
      Tags, asked for as tags. `q` reaches them too, but only mixed in with
      every name and filename, so a tag whose word appears in a filename
      cannot be asked for on its own. Chosen from a list rather than typed
      blind: you had to know a tag existed before you could ask for it.
    -->
    <TagPicker
      models={all}
      selected={chosenTags}
      onchange={(next) => setQuery({ tags: next.length > 0 ? next.join(",") : null })}
    />

    <span class="spacer"></span>

    <!--
      The pile you have set aside, or everything else — never both. Something
      you cannot identify and might want to delete later should be out of the
      way of the Generate pickers without being gone (§8.1).
    -->
    <button
      class="toggle"
      class:active={hidden}
      title="Show only the models hidden from the Generate inputs"
      onclick={() => setQuery({ hidden: hidden ? null : "1" })}
    >
      <EyeOff size={13} />
      Show hidden
    </button>

    <div class="row views">
      <button
        class:active={view === "tiles"}
        title="Tiles"
        onclick={() => setQuery({ view: null })}
      >
        <Grid3x3 size={14} />
      </button>
      <button
        class:active={view === "table"}
        title="Table"
        onclick={() => setQuery({ view: "table" })}
      >
        <List size={14} />
      </button>
    </div>

    <button class="rescan" disabled={rescanning} onclick={rescan}>
      <RefreshCw size={13} />
      {rescanning ? "Rescanning…" : "Rescan"}
    </button>
  </header>

  <!-- Which folder, then which family: narrower with each row down. -->
  {#if classKinds.length > 1}
    <div class="band">
      <div class="row folders">
        <button class:active={kind === ""} onclick={() => setQuery({ kind: null })}>
          All
        </button>
        {#each classKinds as folder (folder)}
          <button
            class:active={kind === folder}
            onclick={() => setQuery({ kind: kind === folder ? null : folder })}
          >
            {folder}
            {#if (perKind.get(folder) ?? 0) > 0}
              <span class="mono dim count-chip">{perKind.get(folder)}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="band">
    <div class="row families">
      <button class:active={family === ""} onclick={() => setQuery({ family: null })}>
        All
      </button>
      {#each [...families, "unset"] as name (name)}
        <button
          class:active={family === name}
          onclick={() => setQuery({ family: family === name ? null : name })}
        >
          {name}
          {#if (perFamily.get(name) ?? 0) > 0}
            <span class="mono dim count-chip">{perFamily.get(name)}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="count mono dim">
    {models.length} model{models.length === 1 ? "" : "s"}
    {#if listedBytes > 0}· {bytes(listedBytes)}{/if}{hashingLeft > 0
      ? ` · ${hashingLeft} still hashing`
      : ""}
    {#if folders.length > 0}
      <!-- One or two paths are worth reading; four is a paragraph. -->
      <span title={folders.join("\n")}>
        · {folders.length > 2 ? `${folders.length} folders` : folders.join(" · ")}
      </span>
    {/if}
    <!--
      What the hasher is doing right now, so a folder that says "still
      hashing" also says whether anything is happening about it. Reading a
      whole file is what takes the time, so the bytes are the honest measure
      of progress, not the file count.
    -->
    {#if app.hashing?.running}
      <span class="hashing-now">
        · hashing {app.hashing.done}/{app.hashing.total}
        ({bytes(app.hashing.bytes_done)} of {bytes(app.hashing.bytes_total)})
        {#if app.hashing.current}· {app.hashing.current}{/if}
      </span>
    {/if}
  </div>

  {#if models.length === 0 && !loading}
    <div class="empty">
      <Brain size={22} />
      <p>No {kind || classLabel(modelClass).toLowerCase()} here.</p>
      <p class="dim">
        Model folders are set in <span class="mono">config.yaml</span> and read at launch (§3.1).
      </p>
    </div>
  {:else if view === "table"}
    <div class="table-wrap" bind:this={listEl}>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Family</th>
            <th>Outputs</th>
            <th>Size</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          {#each models as model (model.path)}
            <tr
              class:selected={selectedId === model.id}
              data-model={model.id}
              onclick={() => {
                selectedId = model.id;
                navigate(`/models/${encodeURIComponent(model.id)}`);
              }}
            >
              <td class="thumb-cell">
                {#if model.thumb_url}
                  <img src={model.thumb_url} alt="" loading="lazy" />
                {:else}
                  <span class="plate"></span>
                {/if}
              </td>
              <td>
                {model.display_name}
                {#if model.hashing}
                  <span class="badge hashing mono">hashing</span>
                {:else if model.hash_error}
                  <span
                    class="badge failed mono"
                    title={`Could not read it: ${model.hash_error}`}
                  >unreadable</span>
                {/if}
                <div class="mono dim file">{model.name}</div>
              </td>
              <td class="family-cell">
                {#if model.hashing || model.hash_error}
                  <span class="mono dim">—</span>
                {:else}
                  <!-- The same control as the card and the model page; the
                       row navigates on click, so the picker stops its own. -->
                  <FamilyPicker
                    family={model.family}
                    counts={perFamily}
                    onchange={(family) => setFamily(model, family)}
                  />
                {/if}
              </td>
              <td class="mono">{model.output_count || "—"}</td>
              <td class="mono dim">{bytes(model.size)}</td>
              <td class="mono dim">
                {model.last_used_at ? relativeTime(model.last_used_at) : "never"}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="grid" bind:this={listEl}>
      {#each models as model (model.path)}
        <ModelCard
          {model}
          selected={selectedId === model.id}
          onfamily={setFamily}
          onhidden={setHidden}
        />
      {/each}
    </div>
  {/if}
</section>

<style>
  .models {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .filters {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    flex-wrap: wrap;
  }

  .row {
    display: flex;
    gap: 2px;
    background: var(--control);
    border-radius: var(--radius-input);
    padding: 2px;
  }

  .row button {
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
    padding: 3px 9px;
    border-radius: var(--radius-control);
    display: flex;
    align-items: center;
  }

  .row button.active {
    background: var(--control-selected);
    color: var(--text);
  }

  .tabs button {
    gap: 6px;
  }

  /* The two narrowing rows under the tabs, each on its own line. */
  .band {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 8px;
    flex-wrap: wrap;
  }

  /* Folder keys are `config.yaml` keys, so they are shown as they are typed. */
  .folders button {
    font-family: var(--mono);
    font-size: 11px;
  }

  .count-chip {
    margin-left: 4px;
  }

  .families button {
    font-family: var(--mono);
    font-size: 11px;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--control);
    border-radius: var(--radius-input);
    padding: 0 8px;
    color: var(--text-4);
  }

  .search input {
    background: transparent;
    border: 0;
    color: var(--text);
    font-size: 12px;
    padding: 5px 0;
    width: 180px;
  }


  .spacer {
    flex: 1;
  }

  .rescan {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-3);
  }

  .toggle.active {
    background: var(--accent-tint-2);
    color: var(--accent);
  }

  .count {
    flex: 0 0 auto;
    padding: 0 12px 8px;
    font-size: 11px;
  }

  .hashing-now {
    color: var(--accent);
  }

  .grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    /* Rows are pinned to their content. A grid with a definite height and
       `auto` rows shares that height out among however many rows there are,
       so past a screenful the cards are squeezed — to 40px at a hundred of
       them — and `overflow: hidden` clips everything but the top of each.
       `align-content: start` does not prevent it: the rows themselves shrink,
       they are not merely packed. */
    grid-auto-rows: max-content;
    gap: 10px;
    padding: 0 12px 16px;
    align-content: start;
    align-items: start;
  }

  .table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 12px 16px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th {
    text-align: left;
    font-weight: 400;
    font-size: 11px;
    color: var(--text-4);
    padding: 4px 8px;
    position: sticky;
    top: 0;
    background: var(--canvas);
  }

  td {
    padding: 6px 8px;
    border-top: 1px solid var(--edge-2);
    vertical-align: middle;
  }

  tbody tr:hover {
    background: var(--raised);
    cursor: pointer;
  }

  /* Where the arrow keys are, which is not the same as where the mouse is. */
  tbody tr.selected td {
    background: var(--control);
    box-shadow: inset 0 1px 0 var(--accent), inset 0 -1px 0 var(--accent);
  }

  tbody tr.selected td:first-child {
    box-shadow: inset 1px 1px 0 var(--accent), inset 0 -1px 0 var(--accent);
  }

  tbody tr.selected td:last-child {
    box-shadow: inset -1px 1px 0 var(--accent), inset 0 -1px 0 var(--accent);
  }

  .thumb-cell {
    width: 40px;
  }

  /* Wide enough that the longest family name does not reflow the column. */
  .family-cell {
    width: 130px;
  }

  .thumb-cell img,
  .plate {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-control);
    object-fit: cover;
    display: block;
    background: var(--control);
  }

  .file {
    font-size: 11px;
  }

  .badge.hashing,
  .badge.failed {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: var(--radius-control);
    background: var(--accent-tint);
    color: var(--accent);
    margin-left: 6px;
  }

  .badge.failed {
    background: var(--control);
    color: var(--error);
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--text-3);
  }
</style>
