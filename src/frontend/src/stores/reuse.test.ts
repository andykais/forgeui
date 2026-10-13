import { describe, expect, test, vi } from "vitest";
import type { Template, WorkflowSummary } from "../types.ts";

/**
 * What Reuse image offers (§10): every workflow that takes a picture, with
 * its templates under it, the output's own family first.
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
    last_output: null,
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

const ids = (groups: ReturnType<typeof app.reuseTargetsFor>) =>
  groups.map((group) => [group.workflow.id, group.templates.map((t) => t.id)]);

describe("what Reuse image offers", () => {
  test("every workflow that takes a picture, the output's family first", () => {
    app.workflows = [
      workflow({
        id: "illustrious-img2img",
        name: "Illustrious XL (img2img)",
        family: "sdxl",
        image_param: "image",
      }),
      workflow({ id: "krea2", name: "Krea 2 Turbo", image_param: null }),
      workflow({
        id: "krea2-inpaint",
        name: "Krea 2 Turbo (inpaint)",
        image_param: "image",
      }),
      workflow({
        id: "krea2-img2img",
        name: "Krea 2 Turbo (img2img)",
        image_param: "image",
      }),
      workflow({
        id: "ltx2-i2v",
        name: "LTX-2.3 Image to Video",
        family: "ltx-2",
        kind: "video",
        image_param: "image",
      }),
      workflow({
        id: "z-mystery",
        name: "Unfiled",
        family: null,
        image_param: "picture",
      }),
    ];
    app.templates = [
      template({ id: "krea2-loras", name: "Film grain", action: null }),
      template({ id: "krea2-upscale" }),
      template({
        id: "illustrious-upscale",
        workflow: "illustrious-img2img",
        family: "sdxl",
      }),
    ];
    expect(ids(app.reuseTargetsFor(output()))).toEqual([
      // Its own family, by name; an upscale first under its workflow.
      ["krea2-img2img", ["krea2-upscale", "krea2-loras"]],
      ["krea2-inpaint", []],
      // Then everything else, by family — a video from a picture included.
      ["ltx2-i2v", []],
      ["illustrious-img2img", ["illustrious-upscale"]],
      ["z-mystery", []],
    ]);
    expect(app.reuseTargetsFor(output()).map((group) => group.sameFamily)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test("never a video, never a workflow that cannot run, never a template that no longer fits", () => {
    app.workflows = [
      workflow({ id: "krea2-img2img", name: "a", image_param: "image" }),
      workflow({ id: "broken", name: "b", image_param: "image", runnable: false }),
    ];
    app.templates = [template({ problems: ['no param "scale"'] })];
    expect(ids(app.reuseTargetsFor(output()))).toEqual([["krea2-img2img", []]]);
    expect(app.reuseTargetsFor(output({ kind: "video" }))).toEqual([]);
    expect(app.reuseTargetsFor(null)).toEqual([]);
  });

  test("an output nobody filed has no family to put first", () => {
    app.workflows = [workflow({ id: "krea2-img2img", name: "a", image_param: "image" })];
    app.templates = [];
    expect(app.reuseTargetsFor(output({ family: null }))[0]?.sameFamily).toBe(false);
  });
});
