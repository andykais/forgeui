import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LoraRow, Manifest, WorkflowDetail } from "../types.ts";

/**
 * Putting a LoRA from a finished run into the panel (§11.2). The number that
 * makes a LoRA worth anything is the strength somebody found for it, and it
 * is sitting in the metadata of the output on screen — so it is carried over
 * as it stands rather than read off and typed back in.
 */

const fakeApi = {
  adoptOutput: vi.fn(async (id: string) => ({
    sha256: "a".repeat(64),
    ext: "png",
    filename: `${"a".repeat(64)}.png`,
    width: 1024,
    height: 1024,
    bytes: 1,
    url: "/api/media/inputs/aa/x.png",
    derived_from_output: id,
  })),
  workflow: vi.fn(async () => ({
    id: "up",
    name: "Up",
    manifest: upscaleManifest,
  })),
  jobs: vi.fn(async () => []),
};
vi.mock("../api.ts", () => ({ api: fakeApi }));
vi.mock("./app.svelte.ts", () => ({ app: { comfyReady: true } }));

const { panel } = await import("./panel.svelte.ts");

const LORA_PARAM = {
  key: "loras",
  type: "lora_list",
  bind: {
    chain: {
      model_from: "1.MODEL",
      clip_from: null,
      model_to: ["3.model"],
      clip_to: null,
    },
  },
} as const;

function load(params: unknown[]) {
  const manifest = {
    id: "w",
    name: "Krea 2 Turbo",
    family: "krea2",
    kind: "image",
    category: null,
    description: null,
    params,
    outputs: [{ node: "9", kind: "image" }],
  } as unknown as Manifest;
  panel.detail = { id: "w", name: "Krea 2 Turbo", manifest } as WorkflowDetail;
  panel.values = {};
}

const row = (name: string, strength: number): LoraRow => ({
  name,
  strength_model: strength,
  strength_clip: strength,
});

const rows = () => panel.values.loras as LoraRow[] | undefined;

describe("adding a LoRA to the panel", () => {
  beforeEach(() => load([LORA_PARAM]));

  test("arrives at the strength it was run at", () => {
    expect(panel.addLora(row("glow.safetensors", 0.8))).toBe("added");
    expect(rows()).toEqual([
      { name: "glow.safetensors", strength_model: 0.8, strength_clip: 0.8 },
    ]);
  });

  test("a second one is appended, not swapped in", () => {
    panel.addLora(row("glow.safetensors", 0.8));
    panel.addLora(row("grain.safetensors", 1.2));
    expect(rows()!.map((lora) => lora.name)).toEqual([
      "glow.safetensors",
      "grain.safetensors",
    ]);
  });

  test("one already listed moves to the new strength", () => {
    // Two rows naming one file would have ComfyUI apply it twice, which is
    // not what "apply this at 0.5" means.
    panel.addLora(row("glow.safetensors", 0.8));
    expect(panel.addLora(row("glow.safetensors", 0.5))).toBe("updated");
    expect(rows()).toEqual([
      { name: "glow.safetensors", strength_model: 0.5, strength_clip: 0.5 },
    ]);
  });

  test("model and clip strengths are kept apart", () => {
    panel.addLora({
      name: "glow.safetensors",
      strength_model: 1,
      strength_clip: 0.4,
    });
    expect(rows()![0]).toEqual({
      name: "glow.safetensors",
      strength_model: 1,
      strength_clip: 0.4,
    });
  });

  test("a workflow that takes no LoRAs says so rather than inventing a list", () => {
    load([{ key: "prompt", type: "text", bind: "4.text" }]);
    expect(panel.loraParam).toBeNull();
    expect(panel.addLora(row("glow.safetensors", 1))).toBeNull();
    expect(panel.values.loras).toBeUndefined();
  });
});

/**
 * Upscale (§10) is `editWith` with the picture attached, so what it has to
 * get right is which values come across and which do not.
 */
const upscaleManifest = {
  id: "up",
  name: "Krea 2 Turbo (upscale)",
  family: "krea2",
  kind: "image",
  category: "upscale",
  description: null,
  params: [
    { key: "image", type: "image", required: true, bind: "6.image" },
    { key: "creativity", type: "float", default: 0.4, bind: "9.denoise" },
    { key: "scale", type: "float", default: 2, bind: "7.scale_by" },
    { key: "prompt", type: "text", bind: "4.text" },
    { key: "seed", type: "seed", default: -1, bind: "9.seed" },
  ],
  outputs: [{ node: "11", kind: "image" }],
} as unknown as Manifest;

describe("upscaling an output", () => {
  test("the picture is attached and the run that made it fills the rest", async () => {
    await panel.upscale("up", { id: "01JOUT" }, {
      prompt: "a granite bowl of figs",
      seed: 42,
      // The source's own knobs, which this workflow does not have: an
      // upscale takes its size from the picture (§10).
      size: [1024, 1024],
      enhance: true,
    });

    expect(fakeApi.adoptOutput).toHaveBeenCalledWith("01JOUT");
    expect(panel.values.image).toBe(`${"a".repeat(64)}.png`);
    expect(panel.values.prompt).toBe("a granite bowl of figs");
    expect(panel.values.seed).toBe(42);
    // From the workflow, not from the source: this is what makes it one
    // click rather than a preset applied on the way in.
    expect(panel.values.creativity).toBe(0.4);
    expect(panel.values.scale).toBe(2);
    // And nothing is said about the keys this workflow never had. That
    // warning is for a workflow that changed under a saved run; here it
    // would fire on every single upscale.
    expect(panel.values.size).toBeUndefined();
    expect(panel.warnings).toEqual([]);
  });

  test("a workflow with no image param refuses rather than half-filling", async () => {
    fakeApi.workflow.mockResolvedValueOnce({
      id: "up",
      name: "Up",
      manifest: { ...upscaleManifest, params: [] } as unknown as Manifest,
    });
    await expect(panel.upscale("up", { id: "01JOUT" }, {})).rejects.toThrow(
      /no image param/,
    );
  });
});

/**
 * The submit gate has to agree with what the panel shows (§4.3). A required
 * field the workflow is ignoring is not on screen, so blocking Generate over
 * it would refuse with nothing to go and fill in — and the server checks the
 * same way, so disagreeing here would only move the refusal later.
 */
describe("what blocks Generate", () => {
  const params = [
    { key: "upscale", type: "bool", default: false, bind: "17.value" },
    {
      key: "image",
      label: "Image",
      type: "image",
      required: true,
      bind: "6.image",
      when: { param: "upscale", is: true },
    },
    {
      key: "prompt",
      label: "Prompt",
      type: "text",
      required: true,
      bind: "4.text",
    },
  ];

  beforeEach(() => load(params));

  test("a required field that does not apply blocks nothing", () => {
    panel.values = { upscale: false, prompt: "a granite bowl of figs" };
    expect(panel.missingRequired).toEqual([]);
  });

  test("and blocks by name the moment it does", () => {
    panel.values = { upscale: true, prompt: "a granite bowl of figs" };
    expect(panel.missingRequired).toEqual(["Image"]);
    panel.values = { ...panel.values, image: "abc.png" };
    expect(panel.missingRequired).toEqual([]);
  });

  test("an unconditional one is unaffected", () => {
    panel.values = { upscale: false, prompt: "" };
    expect(panel.missingRequired).toEqual(["Prompt"]);
  });
});

/**
 * §11.3: attaching a picture says what shape to generate at, so the panel
 * does not make you say it twice. Only the workflows that have both an image
 * and a size are touched — an upscale states a `scale` instead.
 */
describe("the size follows the attached image", () => {
  const params = [
    { key: "image", type: "image", required: true, bind: "6.image" },
    { key: "prompt", type: "text", bind: "4.text" },
    {
      key: "size",
      type: "size",
      default: [1280, 720],
      step: 8,
      bind: { w: "5.width", h: "5.height" },
    },
  ];

  beforeEach(() => load(params));

  test("a portrait picture gives a portrait size", () => {
    expect(panel.sizeFromImage(720, 1280)).toEqual([720, 1280]);
    expect(panel.values.size).toEqual([720, 1280]);
  });

  test("an upscaled frame is taken at its own size, not brought down", () => {
    expect(panel.sizeFromImage(2720, 1536)).toEqual([2720, 1536]);
    expect(panel.values.size).toEqual([2720, 1536]);
  });

  test("attaching the same shape twice changes nothing and says so", () => {
    expect(panel.sizeFromImage(1280, 720)).toEqual([1280, 720]);
    // Already there: nothing to announce the second time round.
    expect(panel.sizeFromImage(1280, 720)).toBeNull();
  });

  test("a workflow with no size param is left alone", () => {
    load(params.filter((param) => param.key !== "size"));
    expect(panel.sizeFromImage(720, 1280)).toBeNull();
    expect(panel.values.size).toBeUndefined();
  });
});

/**
 * §11.3: and a length follows the clip, for the same reason — `ltx2-ia2v`
 * trims the take to the duration and makes that many frames, so attaching
 * one is saying how long the video is.
 */
describe("the duration follows the attached clip", () => {
  const params = [
    { key: "image", type: "image", required: true, bind: "54.image" },
    { key: "audio", type: "audio", required: true, bind: "55.audio" },
    {
      key: "duration",
      type: "float",
      default: 9,
      min: 1,
      max: 60,
      step: 0.5,
      follows: "audio",
      bind: "42.value",
    },
  ];

  beforeEach(() => load(params));

  test("an 11.4s clip gives 11.5 seconds, not 11", () => {
    // Up, never down: overshooting pads, undershooting cuts a word off.
    expect(panel.durationFromAudio("audio", 11_400)).toBe(11.5);
    expect(panel.values.duration).toBe(11.5);
  });

  test("a clip that lands on the step is taken as it is", () => {
    expect(panel.durationFromAudio("audio", 4_000)).toBe(4);
  });

  test("a clip longer than the param allows stops at the maximum", () => {
    expect(panel.durationFromAudio("audio", 90_000)).toBe(60);
  });

  test("attaching the same clip twice changes nothing and says so", () => {
    expect(panel.durationFromAudio("audio", 6_000)).toBe(6);
    expect(panel.durationFromAudio("audio", 6_000)).toBeNull();
  });

  test("a clip whose length is unknown is left alone", () => {
    panel.values = { duration: 9 };
    expect(panel.durationFromAudio("audio", null)).toBeNull();
    expect(panel.values.duration).toBe(9);
  });

  test("a duration that follows nothing is not touched", () => {
    load(
      params.map((param) =>
        param.key === "duration" ? { ...param, follows: undefined } : param
      ),
    );
    panel.values = { duration: 9 };
    expect(panel.durationFromAudio("audio", 11_400)).toBeNull();
    expect(panel.values.duration).toBe(9);
  });
});
