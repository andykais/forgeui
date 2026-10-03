<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { app } from "../stores/app.svelte.ts";
  import { navigate, opensElsewhere } from "../router.svelte.ts";
  import { describeValues } from "../lib/templates.ts";
  import type { Template } from "../types.ts";

  /**
   * Templates (§4.8, §11.2): saved ways to fill a workflow's panel — what each
   * sets, what it asks for, and which workflow it fills. Made from Generate
   * with Save as template; edited and deleted from a template's own page.
   */
  $effect(() => {
    void app.refreshTemplates().catch(() => {});
  });

  const templates = $derived(app.templates);
  const bundled = $derived(templates.filter((t) => t.source === "bundled").length);

  /** The ask list by the workflow's own labels where the workflow is known. */
  function asks(template: Template): string {
    return template.ask.length === 0 ? "—" : template.ask.join(", ");
  }

  function open(event: MouseEvent | KeyboardEvent, template: Template) {
    if (event instanceof MouseEvent && opensElsewhere(event)) {
      window.open(`/templates/${template.id}`, "_blank");
      return;
    }
    navigate(`/templates/${template.id}`);
  }
</script>

<section class="templates">
  <header>
    <h1>Templates</h1>
    <span class="mono dim">
      {templates.length} · {bundled} bundled, {templates.length - bundled} yours
    </span>
    <span class="spacer"></span>
    <span class="dim hint">
      Make one from <strong>Save as template</strong> on the Generate panel.
    </span>
  </header>

  <div class="table scroll">
    {#if templates.length === 0}
      <p class="dim empty">
        No templates yet. On Generate, set up a workflow the way you like it and press <strong
          >Save as template</strong
        >.
      </p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Workflow</th>
            <th>Sets</th>
            <th>Asks for</th>
            <th>Used by</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {#each templates as template (template.id)}
            <tr
              tabindex="0"
              onclick={(event) => open(event, template)}
              onkeydown={(event) => {
                if (event.key === "Enter") open(event, template);
              }}
            >
              <td>
                <span class="name">{template.name}</span>
                {#if template.has_bundled}
                  <span class="badge accent">user copy</span>
                {/if}
                {#if template.problems.length > 0}
                  <span class="badge error" title={template.problems.join("\n")}>
                    <TriangleAlert size={10} /> doesn't fit
                  </span>
                {/if}
              </td>
              <td>
                <span class="workflow">{template.workflow_name ?? template.workflow}</span
                >
                {#if template.family}
                  <span class="badge accent">{template.family}</span>
                {/if}
              </td>
              <td class="mono values" title={describeValues(template.values, app.loras)}>
                {describeValues(template.values, app.loras)}
              </td>
              <td class="mono dim">{asks(template)}</td>
              <td class="dim">
                {template.action === "upscale" ? "Upscale image" : "—"}
              </td>
              <td class="dim">{template.source}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<style>
  .templates {
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

  .hint {
    font-size: 11px;
  }

  .hint strong,
  .empty strong {
    color: var(--text-2);
    font-weight: 500;
  }

  .table {
    flex: 1;
    background: var(--app);
    border-radius: var(--radius-card);
  }

  .empty {
    padding: 24px;
    font-size: 12px;
    margin: 0;
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
    padding: 8px;
    border-top: 1px solid var(--line);
    color: var(--text-2);
  }

  tr {
    cursor: pointer;
  }

  tr:hover td {
    background: var(--raised);
  }

  .name {
    color: var(--text);
    margin-right: 6px;
  }

  .workflow {
    margin-right: 6px;
  }

  .values {
    font-size: 11px;
    color: var(--text-3);
    max-width: 320px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .badge.error {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
</style>
