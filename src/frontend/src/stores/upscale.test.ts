import { describe, expect, test, vi } from "vitest";
import type { Template, WorkflowSummary } from "../types.ts";

/**
 * Which template Upscale applies (§4.8, §10). The rule is the output's own
 * family: a Krea 2 render upscaled through an SDXL graph is not an upscale
 * of it, it is a different picture.
 */

vi.mock("../api.ts", () => ({ api: {} }));

const { app } = await import("./app.svelte.ts");

function template(patch: Partial<Template>): Template {
  return {
    id: "t",
    name: "Upscale 2×",
    description: null,
    workflow: "krea2-img2img",
    workflow_name: "Krea 2 Turbo (img2img)",
    family: "krea2",
    action: "upscale",
    values: { scale: 2, creativity: 0.2 },
    ask: ["image"],
    source: "bundled",
    has_bundled: false,
    problems: [],
    ...patch,
  };
}

function workflow(patch: Partial<WorkflowSummary>): WorkflowSummary {
  return {
    id: "krea2-img2img",
    family: "krea2",
    kind: "image",
    category: "img2img",
    runnable: true,
    ...patch,
  } as WorkflowSummary;
}

const output = (patch: Partial<{ family: string | null; kind: string }> = {}) => ({
  family: "krea2",
  kind: "image",
  ...patch,
});

describe("what Upscale applies", () => {
  test("the upscale template in the output's own family", () => {
    app.workflows = [
      workflow({}),
      workflow({ id: "illustrious-img2img", family: "sdxl" }),
    ];
    app.templates = [
      template({ id: "krea2-upscale" }),
      template({
        id: "illustrious-upscale",
        workflow: "illustrious-img2img",
        family: "sdxl",
      }),
      // A template for something else is not an upscale, whatever its family.
      template({ id: "krea2-loras", action: null }),
    ];
    expect(app.upscaleTemplatesFor(output()).map((t) => t.id)).toEqual(["krea2-upscale"]);
  });

  test("several are offered, so the choice is the user's", () => {
    app.workflows = [workflow({})];
    app.templates = [
      template({ id: "krea2-upscale" }),
      template({ id: "krea2-upscale-gentle" }),
    ];
    expect(app.upscaleTemplatesFor(output())).toHaveLength(2);
  });

  test("never a video: none of these graphs take one", () => {
    app.workflows = [workflow({})];
    app.templates = [template({})];
    expect(app.upscaleTemplatesFor(output({ kind: "video" }))).toEqual([]);
  });

  test("never one whose workflow cannot run, or that no longer fits it", () => {
    app.workflows = [workflow({ runnable: false })];
    app.templates = [template({})];
    expect(app.upscaleTemplatesFor(output())).toEqual([]);
    app.workflows = [workflow({})];
    app.templates = [template({ problems: ['no workflow "krea2-img2img"'] })];
    expect(app.upscaleTemplatesFor(output())).toEqual([]);
    app.templates = [template({})];
    expect(app.upscaleTemplatesFor(null)).toEqual([]);
  });

  test("an output nobody filed matches nothing rather than everything", () => {
    app.workflows = [workflow({})];
    app.templates = [template({ family: null })];
    expect(app.upscaleTemplatesFor(output({ family: null }))).toEqual([]);
  });
});
