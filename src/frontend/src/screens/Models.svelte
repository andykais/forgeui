<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import Grid3x3 from "@lucide/svelte/icons/grid-3x3";
  import List from "@lucide/svelte/icons/list";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Brain from "@lucide/svelte/icons/brain";
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, router, setQuery } from "../router.svelte.ts";
  import { bytes, relativeTime } from "../lib/format.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import { FAMILIES, type ModelEntry } from "../types.ts";
  import ModelCard from "../components/ModelCard.svelte";

  /**
   * Models (§11.2, frame 04): tabs per kind, tiles or table, search over the
   * same fields the API's `q` searches, and a family filter with an `unset`
   * chip. Every filter is a URL param, so a view is a link. No multi-select
   * and no bulk edits (MOCK-REVISIONS §8).
   */
  let models = $state<ModelEntry[]>([]);
  let folders = $state<string[]>([]);
  let loading = $state(false);
  let searchDraft = $state("");
  let rescanning = $state(false);

  const query = $derived(router.current.query);
  const kind = $derived(query.get("kind") ?? "checkpoints");
  const family = $derived(query.get("family") ?? "");
  const q = $derived(query.get("q") ?? "");
  const view = $derived(query.get("view") === "table" ? "table" : "tiles");
  const filterKey = $derived(`${kind}\u0000${family}\u0000${q}`);

  /** Kinds come from `config.model_folders`, so a folder set is a tab set. */
  const kinds = $derived(Object.keys(app.config?.model_folders ?? {}));

  $effect(() => {
    filterKey;
    untrack(() => void load());
  });

  // A finished hashing pass changes identities and counts under our feet.
  $effect(() => {
    const running = app.hashing?.running ?? false;
    const done = app.hashing?.done ?? 0;
    void running;
    void done;
    untrack(() => {
      if (!loading) void load();
    });
  });

  async function load() {
    loading = true;
    try {
      const body = await api.models({
        kind,
        family: family || undefined,
        q: q || undefined,
      });
      models = body.models;
      folders = body.folders;
      searchDraft = q;
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not list models");
    } finally {
      loading = false;
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

  async function setFamily(model: ModelEntry, next: string) {
    try {
      const updated = await api.patchModel(model.id, { family: next });
      models = models.map((entry) => (entry.id === updated.id ? updated : entry));
      await app.refreshModels();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not set the family");
    }
  }

  const hashingLeft = $derived(models.filter((model) => model.hashing).length);
</script>

<section class="models">
  <header class="filters">
    <div class="row tabs">
      {#each kinds as tab (tab)}
        <button
          class:active={kind === tab}
          onclick={() => setQuery({ kind: tab === "checkpoints" ? null : tab })}
        >
          {tab}
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

    <div class="row families">
      <button class:active={family === ""} onclick={() => setQuery({ family: null })}>
        All
      </button>
      {#each [...FAMILIES, "unset"] as name (name)}
        <button
          class:active={family === name}
          onclick={() => setQuery({ family: family === name ? null : name })}
        >
          {name}
        </button>
      {/each}
    </div>

    <span class="spacer"></span>

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

  <div class="count mono dim">
    {models.length} model{models.length === 1 ? "" : "s"}{hashingLeft > 0
      ? ` · ${hashingLeft} still hashing`
      : ""}
    {#if folders.length > 0}
      · {folders.join(" · ")}
    {/if}
  </div>

  {#if models.length === 0 && !loading}
    <div class="empty">
      <Brain size={22} />
      <p>No {kind} here.</p>
      <p class="dim">
        Model folders are set in <span class="mono">config.yaml</span> and read at launch (§3.1).
      </p>
    </div>
  {:else if view === "table"}
    <div class="table-wrap">
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
          {#each models as model (model.id)}
            <tr
              data-model={model.id}
              onclick={() => navigate(`/models/${encodeURIComponent(model.id)}`)}
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
                {/if}
                <div class="mono dim file">{model.name}</div>
              </td>
              <td class="mono dim">{model.family}</td>
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
    <div class="grid">
      {#each models as model (model.id)}
        <ModelCard {model} onfamily={setFamily} />
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
    text-transform: capitalize;
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

  .count {
    padding: 0 12px 8px;
    font-size: 11px;
  }

  .grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
    padding: 0 12px 16px;
    align-content: start;
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

  .thumb-cell {
    width: 40px;
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

  .badge.hashing {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: var(--radius-control);
    background: var(--accent-tint);
    color: var(--accent);
    margin-left: 6px;
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
