<script lang="ts">
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
  import Images from "@lucide/svelte/icons/images";
  import Brain from "@lucide/svelte/icons/brain";
  import Workflow from "@lucide/svelte/icons/workflow";
  import Server from "@lucide/svelte/icons/server";
  import Settings from "@lucide/svelte/icons/settings";
  import ChevronsRight from "@lucide/svelte/icons/chevrons-right";
  import ChevronsLeft from "@lucide/svelte/icons/chevrons-left";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, router, type ScreenName } from "../router.svelte.ts";

  /**
   * The 56px icon rail, collapsible to 196px labelled, state persisted in
   * `config.yaml` (§11.1). There are no keyboard shortcuts for switching
   * screens (§11.4).
   */
  const items: {
    screen: ScreenName;
    label: string;
    icon: typeof Images;
    href: string;
    phase2?: boolean;
  }[] = [
    { screen: "generate", label: "Generate", icon: WandSparkles, href: "/generate" },
    { screen: "gallery", label: "Gallery", icon: Images, href: "/gallery" },
    { screen: "workflows", label: "Models", icon: Brain, href: "/models", phase2: true },
    { screen: "workflows", label: "Workflows", icon: Workflow, href: "/workflows" },
    { screen: "comfy", label: "ComfyUI", icon: Server, href: "/comfy" },
    { screen: "settings", label: "Settings", icon: Settings, href: "/settings" },
  ];

  const expanded = $derived(app.railExpanded);
  const current = $derived(router.current.screen);

  function go(event: MouseEvent, href: string) {
    event.preventDefault();
    navigate(href);
  }
</script>

<nav class="rail" class:expanded aria-label="Screens">
  <div class="mark" title="ForgeUI">
    <span class="wordmark mono">{expanded ? "ForgeUI" : "f"}</span>
  </div>

  <div class="items">
    {#each items as item (item.label)}
      {#if item.phase2}
        <!-- The model library is Phase 2; the rail slot is kept, disabled. -->
        <span class="item disabled" title="Models — Phase 2">
          <item.icon size={18} />
          {#if expanded}<span class="label-text">{item.label}</span>{/if}
        </span>
      {:else}
        <a
          class="item"
          class:active={current === item.screen &&
            (item.screen !== "workflows" || router.current.path.startsWith("/workflows"))}
          href={item.href}
          title={item.label}
          onclick={(event) => go(event, item.href)}
        >
          <item.icon size={18} />
          {#if expanded}<span class="label-text">{item.label}</span>{/if}
        </a>
      {/if}
    {/each}
  </div>

  <button
    class="collapse"
    title={expanded ? "Collapse the rail" : "Expand the rail"}
    onclick={() => app.setRailExpanded(!expanded)}
  >
    {#if expanded}<ChevronsLeft size={16} />{:else}<ChevronsRight size={16} />{/if}
  </button>
</nav>

<style>
  .rail {
    width: var(--rail-width);
    background: var(--app);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 8px 0;
    gap: 4px;
    flex: 0 0 auto;
    transition: width 120ms var(--ease);
  }

  .rail.expanded {
    width: var(--rail-width-open);
  }

  .mark {
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 8px 8px;
    border-radius: var(--radius-input);
    background: var(--accent-tint);
    color: var(--accent);
  }

  .wordmark {
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
  }

  .items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    margin: 0 8px;
    padding: 0 9px;
    border-radius: var(--radius-input);
    color: var(--text-3);
  }

  .item:hover {
    background: var(--raised);
    color: var(--text);
  }

  .item.active {
    background: var(--control-selected);
    color: var(--text);
  }

  .item.disabled {
    color: var(--mark);
    cursor: default;
  }

  .item.disabled:hover {
    background: transparent;
    color: var(--mark);
  }

  .label-text {
    font-size: 13px;
    white-space: nowrap;
  }

  .collapse {
    margin: auto 8px 0;
    background: transparent;
    color: var(--text-4);
    display: flex;
    justify-content: center;
  }

  .collapse:hover {
    background: var(--raised);
    color: var(--text-2);
  }
</style>
