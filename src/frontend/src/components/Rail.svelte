<script lang="ts">
  import Anvil from "@lucide/svelte/icons/anvil";
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
  import Images from "@lucide/svelte/icons/images";
  import Brain from "@lucide/svelte/icons/brain";
  import Workflow from "@lucide/svelte/icons/workflow";
  import Server from "@lucide/svelte/icons/server";
  import Settings from "@lucide/svelte/icons/settings";
  import ChevronsRight from "@lucide/svelte/icons/chevrons-right";
  import ChevronsLeft from "@lucide/svelte/icons/chevrons-left";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, opensElsewhere, router, type ScreenName } from "../router.svelte.ts";

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
  }[] = [
    { screen: "generate", label: "Generate", icon: WandSparkles, href: "/generate" },
    { screen: "gallery", label: "Gallery", icon: Images, href: "/gallery" },
    { screen: "models", label: "Models", icon: Brain, href: "/models" },
    { screen: "workflows", label: "Workflows", icon: Workflow, href: "/workflows" },
    { screen: "comfy", label: "ComfyUI", icon: Server, href: "/comfy" },
    { screen: "settings", label: "Settings", icon: Settings, href: "/settings" },
  ];

  const expanded = $derived(app.railExpanded);
  const current = $derived(router.current.screen);

  function go(event: MouseEvent, href: string) {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    navigate(href);
  }

  /** A detail page keeps its list's rail item lit. */
  function isActive(item: { screen: ScreenName; href: string }): boolean {
    if (current === item.screen) return true;
    if (item.screen === "models") return current === "model";
    if (item.screen === "workflows") return current === "workflow";
    return false;
  }
</script>

<nav class="rail" class:expanded aria-label="Screens">
  <!--
    The anvil, which is also the favicon: one mark for the app rather than a
    lone "f" that meant nothing on its own. The name comes back beside it
    when the rail is open.
  -->
  <div class="mark" title="ForgeUI">
    <Anvil size={16} />
    {#if expanded}<span class="wordmark mono">ForgeUI</span>{/if}
  </div>

  <div class="items">
    {#each items as item (item.label)}
      <a
        class="item"
        class:active={isActive(item)}
        href={item.href}
        title={item.label}
        onclick={(event) => go(event, item.href)}
      >
        <item.icon size={18} />
        {#if expanded}<span class="label-text">{item.label}</span>{/if}
      </a>
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
    gap: 7px;
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
