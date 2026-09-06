<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { toasts } from "../stores/toasts.svelte.ts";
  import { bytes, relativeTime } from "../lib/format.ts";

  /**
   * Settings (§11.2, frame 08), read-only in Phase 1: the connection, the
   * install path, the model folders, the data dir and the key bindings, all
   * as they stand in `config.yaml`. The only maintenance action here is
   * Reindex; model folders are launch-time only, so they are shown rather
   * than edited.
   */
  let log = $state<string[] | null>(null);
  let reindexing = $state(false);
  let rescanning = $state(false);
  let storage = $state<import("../types.ts").Storage | null>(null);
  let reindexResult = $state<string | null>(null);
  let copied = $state(false);

  const config = $derived(app.config);
  const comfy = $derived(app.comfy);
  const managed = $derived(config?.comfy.mode === "managed");

  async function viewLog() {
    const body = await api.comfyLog();
    log = body.available ? body.lines : ["(the app does not own this process)"];
  }

  async function restart() {
    try {
      await api.restartComfy();
      toasts.message("Restarting ComfyUI…");
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not restart");
    }
  }

  /** The storage cards of §11.2; the numbers come from the server (§12). */
  $effect(() => {
    void api
      .storage()
      .then((body) => (storage = body))
      .catch(() => {});
  });

  async function rescanModels() {
    rescanning = true;
    try {
      const result = await api.rescanModels();
      await app.refreshModels();
      toasts.message(
        result.queued > 0
          ? `${result.models} models · hashing ${result.queued}`
          : `${result.models} models, nothing new to hash`,
      );
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "the rescan failed");
    } finally {
      rescanning = false;
    }
  }

  async function reindex() {
    reindexing = true;
    reindexResult = null;
    try {
      const result = await api.reindex();
      reindexResult =
        `${result.outputs} outputs from ${result.sidecars} sidecars` +
        (result.jobs_created > 0 ? `, ${result.jobs_created} job rows recreated` : "") +
        (result.removed.length > 0
          ? `, ${result.removed.length} stale rows dropped`
          : "") +
        (result.errors.length > 0 ? `, ${result.errors.length} sidecars skipped` : "");
    } catch (cause) {
      reindexResult = cause instanceof Error ? cause.message : "reindex failed";
    } finally {
      reindexing = false;
    }
  }

  function copyDataDir() {
    navigator.clipboard?.writeText(app.dataDir);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<section class="settings scroll">
  <header class="row">
    <h1>Settings</h1>
    <span class="spacer"></span>
    <span class="mono dim">
      read-only in this phase · edit <code>config.yaml</code> and restart
    </span>
  </header>

  <div class="cards">
    <article class="card">
      <div class="row card-head">
        <h2>ComfyUI connection</h2>
        <span class="dot" class:ok={comfy?.state === "running"}></span>
        <span class="mono dim">
          {comfy?.state}
          {#if comfy?.pid}· pid {comfy.pid}{/if}
          {#if comfy?.uptime_ms}· up {relativeTime(Date.now() - comfy.uptime_ms)}{/if}
        </span>
      </div>

      <div class="modes">
        <div class="mode" class:active={managed}>
          <strong>Managed child process</strong>
          <p class="dim">
            The app starts and stops ComfyUI, and passes its own output, input and
            model-path flags.
          </p>
        </div>
        <div class="mode" class:active={!managed}>
          <strong>Connect to a local URL</strong>
          <p class="dim">
            You start ComfyUI yourself with the flags below. Same machine.
          </p>
        </div>
      </div>

      <div class="field">
        <span class="label">ComfyUI install path</span>
        <div class="value mono">{config?.comfy.path ?? "— not set —"}</div>
      </div>
      <div class="field">
        <span class="label">URL</span>
        <div class="value mono">{config?.comfy.url}</div>
      </div>
      <div class="field">
        <span class="label">Launch flags (generated, read-only)</span>
        <pre class="flags mono">{(comfy?.launch_flags ?? []).join("\n")}</pre>
      </div>

      {#if comfy?.error}
        <p class="error-line mono">{comfy.error}</p>
      {/if}

      <div class="row card-actions">
        <button disabled={!managed} onclick={restart}>Restart ComfyUI</button>
        <button disabled={!managed} onclick={viewLog}>View log</button>
        <span class="dim">managed mode only</span>
      </div>
      {#if log}
        <pre class="log mono">{log.slice(-40).join("\n")}</pre>
      {/if}
    </article>

    <article class="card">
      <div class="row card-head">
        <h2>Model folders</h2>
        <span class="badge">read-only</span>
      </div>
      {#each Object.entries(config?.model_folders ?? {}) as [kind, folders] (kind)}
        <div class="folder-row">
          <span class="kind mono">{kind}</span>
          {#if folders.length === 0}
            <span class="dim">— not set —</span>
          {:else}
            <div class="paths">
              {#each folders as folder (folder)}
                <span class="mono">{folder}</span>
              {/each}
            </div>
          {/if}
          {#if kind === "loras"}
            <span class="mono dim count">{app.loras.length}</span>
          {:else if kind === "checkpoints"}
            <span class="mono dim count">{app.checkpoints.length}</span>
          {/if}
        </div>
      {/each}
      <p class="dim note">
        Edited in <code class="mono">config.yaml</code> and applied on app restart;
        <code class="mono">extra_model_paths.yaml</code> is regenerated from it each launch.
      </p>
      <div class="row card-actions">
        <button disabled={rescanning} onclick={rescanModels}>
          {rescanning ? "Rescanning…" : "Rescan"}
        </button>
        {#if app.hashing?.running}
          <span class="mono dim">
            hashing {app.hashing.done}/{app.hashing.total}
          </span>
        {/if}
      </div>
    </article>

    <article class="card">
      <div class="row card-head">
        <h2>Data directory</h2>
      </div>
      <button class="path-button mono" onclick={copyDataDir}>
        <span>{app.dataDir}</span>
        {#if copied}<Check size={13} />{:else}<span class="dim">copy</span>{/if}
      </button>
      <p class="dim note">
        Set by <code class="mono">--data-dir</code> at launch, else
        <code class="mono">FORGEUI_DATA_DIR</code>, else
        <code class="mono">~/.forgeui</code>.
      </p>
      {#if storage}
        <div class="storage">
          {#each [["outputs", storage.outputs], ["samples", storage.samples], ["inputs", storage.inputs], ["staging", storage.staging], ["app.db", storage.db]] as const as [label, use] (label)}
            <div class="use">
              <span class="use-label mono dim">{label}</span>
              <span class="use-bytes mono">{bytes(use.bytes)}</span>
              <span class="use-files mono dim">
                {use.files} file{use.files === 1 ? "" : "s"}
              </span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="field">
        <span class="label">App server</span>
        <div class="value mono">
          {config?.server.host}:{config?.server.port}
        </div>
      </div>
    </article>

    <article class="card">
      <div class="row card-head">
        <h2>Keyboard</h2>
        <span class="badge">config.yaml</span>
      </div>
      <p class="dim note">
        The only bindings in the app, and the single source of truth for them.
      </p>
      <div class="keys">
        {#each Object.entries(config?.keys ?? {}) as [action, keys] (action)}
          <div class="key-row">
            <span class="mono">{action}</span>
            <span class="spacer"></span>
            {#each keys as key (key)}<kbd class="mono">{key}</kbd>{/each}
          </div>
        {/each}
      </div>
    </article>

    <article class="card">
      <div class="row card-head">
        <h2>Maintenance</h2>
      </div>
      <div class="maintenance">
        <strong>Reindex</strong>
        <p class="dim">
          Rebuilds <code class="mono">app.db</code> from the files and sidecars on disk. Safe
          to run at any time; nothing on disk is modified.
        </p>
        <div class="row card-actions">
          <button disabled={reindexing} onclick={reindex}>
            {reindexing ? "Reindexing…" : "Run reindex"}
          </button>
          {#if reindexResult}<span class="mono dim">{reindexResult}</span>{/if}
        </div>
      </div>
    </article>
  </div>
</section>

<style>
  .storage {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 6px;
    margin-top: 8px;
  }

  .use {
    background: var(--control);
    border-radius: var(--radius-input);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .use-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .use-bytes {
    font-size: 13px;
    color: var(--text);
  }

  .use-files {
    font-size: 10px;
  }

  .settings {
    flex: 1;
    padding: 10px 12px 16px;
  }

  header {
    padding-bottom: 10px;
  }

  h1 {
    font-size: 15px;
    font-weight: 500;
    margin: 0;
  }

  h2 {
    font-size: 13px;
    font-weight: 500;
    margin: 0;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 10px;
    align-items: start;
  }

  .card {
    background: var(--app);
    border-radius: var(--radius-card);
    padding: 12px;
  }

  .card-head {
    margin-bottom: 10px;
  }

  .card-head .mono {
    font-size: 11px;
  }

  .modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 10px;
  }

  .mode {
    background: var(--raised);
    border-radius: var(--radius-input);
    padding: 8px;
    font-size: 12px;
    opacity: 0.55;
  }

  .mode.active {
    background: var(--accent-tint);
    opacity: 1;
  }

  .mode p {
    margin: 4px 0 0;
    font-size: 11px;
  }

  .field {
    margin-bottom: 8px;
  }

  .value {
    background: var(--raised);
    border-radius: var(--radius-input);
    padding: 6px 8px;
    font-size: 12px;
    margin-top: 3px;
    overflow-wrap: anywhere;
  }

  .flags,
  .log {
    background: var(--canvas);
    border-radius: var(--radius-input);
    padding: 8px;
    margin: 3px 0 0;
    font-size: 11px;
    color: var(--text-3);
    white-space: pre-wrap;
    max-height: 200px;
    overflow: auto;
  }

  .card-actions {
    margin-top: 8px;
    font-size: 11px;
  }

  .card-actions button {
    font-size: 12px;
  }

  .folder-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 4px 0;
    border-top: 1px solid var(--line);
    font-size: 12px;
  }

  .kind {
    width: 96px;
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--text-4);
  }

  .paths {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-wrap: anywhere;
  }

  .count {
    font-size: 11px;
  }

  .note {
    font-size: 11px;
    margin: 8px 0 0;
  }

  .path-button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--raised);
    font-size: 12px;
  }

  .path-button span:first-child {
    flex: 1;
    overflow-wrap: anywhere;
  }

  .keys {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .key-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    padding: 3px 0;
    border-top: 1px solid var(--line);
  }

  kbd {
    background: var(--control);
    border-radius: var(--radius-control);
    padding: 1px 6px;
    font-size: 11px;
  }

  .maintenance strong {
    font-size: 12px;
    font-weight: 500;
  }

  .maintenance p {
    margin: 4px 0 0;
    font-size: 11px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-4);
  }

  .dot.ok {
    background: var(--ok);
  }

  .error-line {
    color: var(--error);
    font-size: 11px;
  }
</style>
