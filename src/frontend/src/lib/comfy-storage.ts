/**
 * What the embedded editor is allowed to remember between visits (§4.1).
 *
 * ComfyUI keeps its open tabs in `localStorage` and reopens every one of them
 * on boot, so a session that has edited twenty workflows opens twenty tabs —
 * none of which this app asked for. The editor is proxied under this origin,
 * which makes that storage this origin's, and this app keeps nothing in it,
 * so the tab list can simply be dropped before ComfyUI reads it. The graph
 * the app does want is loaded by `loadGraphData`, as it always was.
 */

/**
 * Whether a key is tab-restore state rather than a setting. Settings are kept
 * — including the workflow-shaped ones, which is why this cannot be a bare
 * substring test: ComfyUI has settings called things like
 * `Comfy.Settings.Comfy.Workflow.WorkflowTabsPosition`.
 */
export function restoresATab(key: string): boolean {
  if (key.startsWith("Comfy.Settings")) return false;
  return key === "workflow" || /workflow/i.test(key);
}

/**
 * Drop them. Returns what went, so a caller can say so; a key that will not
 * go is one tab too many and nothing worse, so nothing here throws.
 */
export function forgetOpenTabs(storage: Storage | undefined): string[] {
  if (!storage) return [];
  const gone: string[] = [];
  let keys: string[];
  try {
    keys = Object.keys(storage);
  } catch {
    // Storage can be disabled outright, and an editor that reopens its tabs
    // is a far smaller problem than a screen that will not render.
    return [];
  }
  for (const key of keys) {
    if (!restoresATab(key)) continue;
    try {
      storage.removeItem(key);
      gone.push(key);
    } catch {
      // Ignore and carry on with the rest.
    }
  }
  return gone;
}
