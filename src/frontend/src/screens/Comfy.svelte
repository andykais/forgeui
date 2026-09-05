<script lang="ts">
  import { api } from "../api.ts";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, router } from "../router.svelte.ts";
  import { toasts } from "../stores/toasts.svelte.ts";

  /**
   * The embedded editor (§4.1): ComfyUI's own frontend, proxied under this
   * origin so the iframe is same-origin and the app can call
   * `app.graphToPrompt()` on it. The app never uses ComfyUI's own Save — when
   * a workflow is being edited an app-owned toolbar sits above the iframe with
   * Save & return and Discard. Opened from the rail it is raw ComfyUI with no
   * toolbar.
   */
  let frame = $state<HTMLIFrameElement | null>(null);
  let saving = $state(false);
  let ready = $state(false);
  let unreachable = $state<string | null>(null);

  /** How long ComfyUI's frontend may take to put itself on the window. */
  const FRONTEND_TIMEOUT_MS = 60_000;

  const workflowId = $derived(router.current.query.get("workflow"));
  const workflow = $derived(app.workflow(workflowId));

  /**
   * ComfyUI's frontend exposes its app on the window. Reaching it is the one
   * thing this screen cannot verify without a real ComfyUI, so failure is
   * reported rather than swallowed.
   */
  interface ComfyFrontend {
    graphToPrompt: () => Promise<{ output: unknown; workflow: unknown }>;
    graph?: { serialize: () => unknown };
    loadGraphData?: (graph: unknown) => void;
  }

  function frontend(): ComfyFrontend | null {
    try {
      const win = frame?.contentWindow as
        (Window & { app?: ComfyFrontend }) | null | undefined;
      return win?.app ?? null;
    } catch {
      // Cross-origin would land here; the proxy exists to prevent it (§4.1).
      return null;
    }
  }

  /**
   * The iframe's `load` event fires long before ComfyUI's frontend has
   * booted and put its app on the window, so waiting for the object is the
   * only way to tell "not ready yet" from "this build does not expose it".
   */
  async function waitForFrontend(
    timeoutMs = FRONTEND_TIMEOUT_MS,
  ): Promise<ComfyFrontend | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const editor = frontend();
      if (typeof editor?.graphToPrompt === "function") return editor;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  /** Load this workflow's LiteGraph document into the editor. */
  async function onLoad() {
    unreachable = null;
    ready = false;
    if (!workflowId) return;
    const editor = await waitForFrontend();
    if (!editor?.loadGraphData) {
      unreachable =
        "This ComfyUI build does not expose app.loadGraphData(); open the workflow from ComfyUI's own menu instead.";
      return;
    }
    const detail = await api.workflow(workflowId);
    try {
      editor.loadGraphData(detail.ui_json);
      ready = true;
    } catch (cause) {
      unreachable = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function saveAndReturn() {
    if (!workflowId) return;
    const editor = await waitForFrontend(5000);
    if (!editor?.graphToPrompt) {
      unreachable =
        "This ComfyUI build does not expose app.graphToPrompt(), so the app cannot capture the graph.";
      return;
    }
    saving = true;
    try {
      // Both files are written together so they can never drift (§4.1).
      const prompt = await editor.graphToPrompt();
      await api.saveWorkflow(workflowId, {
        api_json: prompt.output,
        ui_json: prompt.workflow ?? editor.graph?.serialize(),
      });
      await app.refreshWorkflows();
      toasts.message("Saved both workflow files");
      navigate(`/workflows/${workflowId}`);
    } catch (cause) {
      toasts.message(cause instanceof Error ? cause.message : "could not save it");
    } finally {
      saving = false;
    }
  }
</script>

<section class="comfy">
  {#if workflowId}
    <header>
      <span class="label">Editing</span>
      <span class="name">{workflow?.name ?? workflowId}</span>
      {#if workflow?.source === "bundled"}
        <span class="dim">· saving creates a user copy</span>
      {/if}
      <span class="spacer"></span>
      {#if unreachable}
        <span class="warn mono">{unreachable}</span>
      {/if}
      <button onclick={() => navigate(`/workflows/${workflowId}`)}>Discard</button>
      <button
        class="primary"
        disabled={saving || (!ready && !unreachable)}
        onclick={saveAndReturn}
      >
        {saving ? "Saving…" : !ready && !unreachable ? "Loading…" : "Save & return"}
      </button>
    </header>
  {/if}

  {#if app.comfy && (app.comfy.state === "failed" || app.comfy.state === "disconnected")}
    <div class="offline">
      <p>ComfyUI is {app.comfy.state}.</p>
      {#if app.comfy.error}<p class="mono dim">{app.comfy.error}</p>{/if}
      <a
        href="/settings"
        onclick={(event) => {
          event.preventDefault();
          navigate("/settings");
        }}>Check the connection in Settings</a
      >
    </div>
  {:else}
    <iframe
      bind:this={frame}
      title="ComfyUI"
      src="/comfy/"
      onload={onLoad}
      allow="clipboard-read; clipboard-write"
    ></iframe>
  {/if}
</section>

<style>
  .comfy {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--app);
  }

  .name {
    font-size: 13px;
  }

  header button {
    font-size: 12px;
  }

  .primary {
    background: var(--accent);
    color: #08191d;
  }

  .warn {
    font-size: 11px;
    color: var(--running);
    max-width: 520px;
  }

  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: var(--canvas);
  }

  .offline {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--text-3);
  }
</style>
