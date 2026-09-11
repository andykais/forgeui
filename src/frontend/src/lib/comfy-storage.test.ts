import { describe, expect, test } from "vitest";
import { forgetOpenTabs, restoresATab } from "./comfy-storage.ts";

/**
 * What the embedded editor may remember between visits (§4.1). The editor is
 * proxied under this app's origin, so these keys are on the app's own
 * `localStorage` — which is the only reason it can reach them, and the reason
 * it has to be careful about which ones it takes.
 */

/** A `Storage` that is a plain object, which jsdom's own is not. */
function storage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    ...Object.fromEntries(map),
  } as unknown as Storage;
}

describe("the editor's tab memory", () => {
  test("tab-restore keys go and settings stay", () => {
    // The tab list and the autosaved active graph.
    expect(restoresATab("workflow")).toBe(true);
    expect(restoresATab("Comfy.PreviousWorkflow")).toBe(true);
    expect(restoresATab("Comfy.OpenWorkflowsPaths")).toBe(true);
    expect(restoresATab("Comfy.ActiveWorkflowIndex")).toBe(true);
    expect(restoresATab("workflow_manager.openWorkflows")).toBe(true);

    // Settings stay, and workflow-shaped settings are exactly why this is
    // not a bare substring test.
    expect(restoresATab("Comfy.Settings")).toBe(false);
    expect(
      restoresATab("Comfy.Settings.Comfy.Workflow.WorkflowTabsPosition"),
    ).toBe(false);
    expect(restoresATab("Comfy.Settings.Comfy.NodeBadge.NodeIdBadgeMode"))
      .toBe(false);

    // Anything unrelated is left alone rather than swept up.
    expect(restoresATab("Comfy.NodeLibrary.Bookmarks")).toBe(false);
    expect(restoresATab("litegraph.canvas.zoom")).toBe(false);
  });

  test("only the tab keys are removed", () => {
    const store = storage({
      "workflow": "{}",
      "Comfy.PreviousWorkflow": "a.json",
      "Comfy.OpenWorkflowsPaths": "[]",
      "Comfy.Settings": "{}",
      "Comfy.Settings.Comfy.Workflow.WorkflowTabsPosition": '"Topbar"',
      "Comfy.NodeLibrary.Bookmarks": "[]",
    });

    const gone = forgetOpenTabs(store).sort();
    expect(gone).toEqual([
      "Comfy.OpenWorkflowsPaths",
      "Comfy.PreviousWorkflow",
      "workflow",
    ]);
    expect(store.getItem("workflow")).toBeNull();
    expect(store.getItem("Comfy.Settings")).toBe("{}");
    expect(store.getItem("Comfy.Settings.Comfy.Workflow.WorkflowTabsPosition"))
      .toBe('"Topbar"');
    expect(store.getItem("Comfy.NodeLibrary.Bookmarks")).toBe("[]");
  });

  test("no storage at all is not an error", () => {
    // Private windows and blocked site data reach here; an editor that
    // reopens its tabs beats a screen that will not render.
    expect(forgetOpenTabs(undefined)).toEqual([]);
  });
});
