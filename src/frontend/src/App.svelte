<script lang="ts">
  import { app } from "./stores/app.svelte.ts";
  import { router } from "./router.svelte.ts";
  import Rail from "./components/Rail.svelte";
  import QueueStrip from "./components/QueueStrip.svelte";
  import ToastHost from "./components/ToastHost.svelte";
  import Generate from "./screens/Generate.svelte";
  import Gallery from "./screens/Gallery.svelte";
  import Models from "./screens/Models.svelte";
  import ModelDetail from "./screens/ModelDetail.svelte";
  import Workflows from "./screens/Workflows.svelte";
  import WorkflowDetail from "./screens/WorkflowDetail.svelte";
  import Comfy from "./screens/Comfy.svelte";
  import Telemetry from "./screens/Telemetry.svelte";
  import Settings from "./screens/Settings.svelte";

  /**
   * The shell (§11.1): the nav rail on the left, the screen in the middle,
   * and the queue strip pinned to the bottom on every screen.
   */
  const screen = $derived(router.current.screen);

  $effect(() => {
    void app.load();
  });
</script>

<div class="shell">
  <Rail />
  <main>
    {#if !app.loaded}
      <div class="booting">
        {#if app.error}
          <p class="error mono">{app.error}</p>
          <p class="dim">Is the ForgeUI server still running?</p>
        {:else}
          <p class="dim">loading…</p>
        {/if}
      </div>
    {:else if screen === "generate"}
      <Generate />
    {:else if screen === "gallery"}
      <Gallery />
    {:else if screen === "models"}
      <Models />
    {:else if screen === "model" && router.current.id}
      <ModelDetail id={router.current.id} />
    {:else if screen === "workflows"}
      <Workflows />
    {:else if screen === "workflow" && router.current.id}
      <WorkflowDetail id={router.current.id} />
    {:else if screen === "comfy"}
      <Comfy />
    {:else if screen === "telemetry"}
      <Telemetry />
    {:else if screen === "settings"}
      <Settings />
    {/if}
    <QueueStrip />
  </main>
  <ToastHost />
</div>

<style>
  .shell {
    height: 100%;
    display: flex;
    background: var(--canvas);
    border-radius: var(--radius-window);
    overflow: hidden;
  }

  main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .booting {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .error {
    color: var(--error);
  }
</style>
