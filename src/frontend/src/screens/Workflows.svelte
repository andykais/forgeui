<script lang="ts">
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import FileJson from "@lucide/svelte/icons/file-json";
  import Plus from "@lucide/svelte/icons/plus";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate } from "../router.svelte.ts";
  import { relativeTime } from "../lib/format.ts";
  import Popover from "../components/Popover.svelte";
  import { toasts } from "../stores/toasts.svelte.ts";

  /**
   * The workflows table (§11.2): the manifest surface at a glance. The ⋯ menu
   * offers Open in ComfyUI, Duplicate and — only when a user copy exists —
   * Reset to bundled. Delete appears on user copies only, never on bundled.
   */
  let menuFor = $state<string | null>(null);
  let importing = $state(false);
  let fileInput: HTMLInputElement | undefined;

  const workflows = $derived(app.workflows);
  const bundled = $derived(workflows.filter((w) => w.source === "bundled").length);
  const userCopies = $derived(workflows.filter((w) => w.source === "user").length);

  function thumbnail(id: string | null): string | null {
    return id ? (app.outputs[id]?.media_url ?? null) : null;
  }

  function paramsSummary(keys: string[], advanced: number): string {
    const named = keys.join(" · ");
    return advanced > 0 ? `${named} · +${advanced} adv` : named;
  }

  async function duplicate(id: string) {
    menuFor = null;
    const copy = await api.duplicateWorkflow(id);
    await app.refreshWorkflows();
    navigate(`/workflows/${copy.id}`);
  }

  async function reset(id: string) {
    menuFor = null;
    await api.resetWorkflow(id);
    await app.refreshWorkflows();
    toasts.message("Reverted to the bundled workflow");
  }

  async function remove(id: string) {
    menuFor = null;
    try {
      await api.deleteWorkflow(id);
      await app.refreshWorkflows();
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not delete it");
    }
  }

  async function onImport(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    importing = true;
    try {
      const ui = JSON.parse(await file.text());
      const created = await api.createWorkflow({
        name: file.name.replace(/\.json$/i, ""),
        ui_json: ui,
      });
      await app.refreshWorkflows();
      navigate(`/comfy?workflow=${created.id}`);
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not import it");
    } finally {
      importing = false;
    }
  }

  async function newInComfy() {
    const created = await api.createWorkflow({ name: "Untitled workflow" });
    await app.refreshWorkflows();
    navigate(`/comfy?workflow=${created.id}`);
  }
</script>

<section class="workflows">
  <header>
    <h1>Workflows</h1>
    <span class="mono dim">
      {workflows.length} · {bundled} bundled, {userCopies} user
      {userCopies === 1 ? "copy" : "copies"}
    </span>
    <span class="spacer"></span>
    <button onclick={() => fileInput?.click()} disabled={importing}>
      <FileJson size={13} /> Import .json
    </button>
    <input
      class="hidden-input"
      type="file"
      accept="application/json,.json"
      bind:this={fileInput}
      onchange={onImport}
    />
    <button class="primary" onclick={newInComfy}>
      <Plus size={13} /> New in ComfyUI
    </button>
  </header>

  <div class="table scroll">
    <table>
      <thead>
        <tr>
          <th class="thumb-col"></th>
          <th>Name</th>
          <th>Family</th>
          <th>Kind</th>
          <th>Params</th>
          <th>Source</th>
          <th>Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each workflows as workflow (workflow.id)}
          <tr
            onclick={() => navigate(`/workflows/${workflow.id}`)}
            tabindex="0"
            onkeydown={(event) => {
              if (event.key === "Enter") navigate(`/workflows/${workflow.id}`);
            }}
          >
            <td class="thumb-col">
              <span class="thumb">
                {#if thumbnail(workflow.last_output_id)}
                  <img src={thumbnail(workflow.last_output_id)} alt="" />
                {/if}
              </span>
            </td>
            <td>
              <span class="name">{workflow.name}</span>
              {#if workflow.source === "user" && workflow.has_bundled}
                <span class="badge accent">user copy</span>
              {/if}
              {#if workflow.error}
                <span class="badge error" title={workflow.error}>manifest error</span>
              {/if}
            </td>
            <td>
              {#if workflow.family}
                <span class="badge accent">{workflow.family}</span>
              {:else}
                <span class="dim">—</span>
              {/if}
            </td>
            <td class="dim">{workflow.kind}</td>
            <td class="params mono">
              {paramsSummary(workflow.params.keys, workflow.params.advanced)}
            </td>
            <td class="dim">{workflow.source}</td>
            <td class="dim">{relativeTime(workflow.last_job_at)}</td>
            <td class="actions">
              <div class="row">
                <button
                  onclick={(event) => {
                    event.stopPropagation();
                    navigate(`/workflows/${workflow.id}`);
                  }}
                >
                  Edit manifest
                </button>
                <div class="menu-wrap">
                  <button
                    aria-label={`More actions for ${workflow.name}`}
                    onclick={(event) => {
                      event.stopPropagation();
                      menuFor = menuFor === workflow.id ? null : workflow.id;
                    }}
                  >
                    <Ellipsis size={14} />
                  </button>
                  <Popover
                    open={menuFor === workflow.id}
                    width={220}
                    align="right"
                    onclose={() => (menuFor = null)}
                  >
                    <button
                      class="option"
                      onclick={() => navigate(`/comfy?workflow=${workflow.id}`)}
                    >
                      Open in ComfyUI
                    </button>
                    <button class="option" onclick={() => duplicate(workflow.id)}>
                      Duplicate
                    </button>
                    {#if workflow.source === "user" && workflow.has_bundled}
                      <button class="option" onclick={() => reset(workflow.id)}>
                        Reset to bundled
                      </button>
                    {/if}
                    {#if workflow.source === "user" && !workflow.has_bundled}
                      <button class="option danger" onclick={() => remove(workflow.id)}>
                        Delete
                      </button>
                    {/if}
                  </Popover>
                </div>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .workflows {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px 12px 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 10px;
  }

  h1 {
    font-size: 15px;
    font-weight: 500;
    margin: 0;
  }

  header button {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }

  .primary {
    background: var(--accent);
    color: #08191d;
  }

  .hidden-input {
    display: none;
  }

  .table {
    flex: 1;
    background: var(--app);
    border-radius: var(--radius-card);
  }

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
    padding: 8px;
    position: sticky;
    top: 0;
    background: var(--app);
  }

  td {
    padding: 6px 8px;
    border-top: 1px solid var(--line);
    color: var(--text-2);
  }

  tr {
    cursor: pointer;
  }

  tr:hover td {
    background: var(--raised);
  }

  .thumb-col {
    width: 46px;
  }

  .thumb {
    display: block;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-control);
    background: var(--control);
    overflow: hidden;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .name {
    color: var(--text);
  }

  .params {
    font-size: 11px;
    color: var(--text-3);
    max-width: 280px;
  }

  .actions {
    width: 1%;
    white-space: nowrap;
  }

  .actions button {
    font-size: 11px;
    padding: 3px 8px;
  }

  .menu-wrap {
    position: relative;
  }

  .option {
    display: block;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 6px 8px;
    font-size: 12px;
  }

  .option:hover {
    background: var(--control);
  }

  .option.danger {
    color: var(--error);
  }
</style>
