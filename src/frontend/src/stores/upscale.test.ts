import { describe, expect, test, vi } from "vitest";
import type { WorkflowSummary } from "../types.ts";

/**
 * Which workflow Upscale routes to (§10). The rule is the output's own
 * family: a Krea 2 render upscaled through an SDXL graph is not an upscale
 * of it, it is a different picture.
 */

vi.mock("../api.ts", () => ({ api: {} }));

const { app } = await import("./app.svelte.ts");

function workflow(patch: Partial<WorkflowSummary>): WorkflowSummary {
  return {
    id: "w",
    name: "W",
    family: "krea2",
    kind: "image",
    category: "upscale",
    runnable: true,
    ...patch,
  } as WorkflowSummary;
}

const output = (patch: Partial<{ family: string | null; kind: string }> = {}) => ({
  family: "krea2",
  kind: "image",
  ...patch,
});

describe("what Upscale routes to", () => {
  test("the upscale workflow in the output's own family", () => {
    app.workflows = [
      workflow({ id: "krea2-upscale" }),
      workflow({ id: "sdxl-upscale", family: "sdxl" }),
      workflow({ id: "krea2", category: null }),
      workflow({ id: "krea2-old", category: "img2img" }),
    ];
    expect(app.upscalersFor(output()).map((w) => w.id)).toEqual(["krea2-upscale"]);
  });

  test("several are offered, so the choice is the user's", () => {
    app.workflows = [
      workflow({ id: "krea2-upscale" }),
      workflow({ id: "krea2-upscale-mine" }),
    ];
    expect(app.upscalersFor(output())).toHaveLength(2);
  });

  test("nothing when the family has no upscaler", () => {
    app.workflows = [workflow({ id: "sdxl-upscale", family: "sdxl" })];
    expect(app.upscalersFor(output())).toEqual([]);
  });

  test("never a video: none of these graphs upscale one", () => {
    app.workflows = [workflow({ id: "krea2-upscale" })];
    expect(app.upscalersFor(output({ kind: "video" }))).toEqual([]);
  });

  test("never one that cannot run, and never without an output", () => {
    app.workflows = [workflow({ id: "krea2-upscale", runnable: false })];
    expect(app.upscalersFor(output())).toEqual([]);
    app.workflows = [workflow({ id: "krea2-upscale" })];
    expect(app.upscalersFor(null)).toEqual([]);
  });

  test("an output nobody filed matches nothing rather than everything", () => {
    app.workflows = [workflow({ id: "krea2-upscale" })];
    expect(app.upscalersFor(output({ family: null }))).toEqual([]);
  });
});
