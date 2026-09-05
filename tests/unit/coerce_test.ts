import { assertEquals, assertThrows } from "@std/assert";
import { coerceParams, ParamError } from "../../src/workflows/coerce.ts";
import { validateManifest } from "../../src/workflows/manifest.ts";
import type { ApiGraph, Manifest } from "../../src/workflows/types.ts";

const graph: ApiGraph = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "base.safetensors" },
  },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 7,
      denoise: 1,
      sampler_name: "euler",
      model: ["1", 0],
      positive: ["6", 0],
      negative: ["6", 0],
      latent_image: ["5", 0],
    },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
  "10": { class_type: "LoadImage", inputs: { image: "example.png" } },
  "9": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ForgeUI/out", images: ["8", 0] },
  },
};

function build(params: unknown[]): Manifest {
  return validateManifest({
    id: "fixture",
    name: "Fixture",
    family: "sdxl",
    kind: "image",
    category: null,
    description: null,
    params,
    outputs: [{ node: "9", kind: "image" }],
  }, { graph });
}

const everything = build([
  { key: "prompt", type: "text", required: true, bind: "6.text" },
  { key: "steps", type: "int", default: 20, min: 4, max: 100, bind: "3.steps" },
  {
    key: "cfg",
    type: "float",
    default: 7,
    min: 0,
    max: 20,
    step: 0.1,
    bind: "3.cfg",
  },
  {
    key: "denoise",
    type: "float",
    default: 1,
    min: 0,
    max: 1,
    bind: "3.denoise",
  },
  {
    key: "sampler",
    type: "enum",
    options: ["euler", "dpmpp_2m"],
    default: "euler",
    bind: "3.sampler_name",
  },
  { key: "seed", type: "seed", default: -1, bind: "3.seed" },
  {
    key: "size",
    type: "size",
    default: [1024, 1024],
    step: 64,
    bind: { w: "5.width", h: "5.height" },
  },
  { key: "checkpoint", type: "checkpoint", bind: "1.ckpt_name" },
  { key: "image", type: "image", bind: "10.image" },
  {
    key: "loras",
    type: "lora_list",
    bind: {
      chain: {
        model_from: "1.MODEL",
        clip_from: "1.CLIP",
        model_to: ["3.model"],
        clip_to: ["6.clip"],
      },
    },
  },
]);

const fixedSeed = { randomSeed: () => 777 };

Deno.test("missing params fall back to manifest defaults", () => {
  const { values } = coerceParams(everything, { prompt: "figs" }, fixedSeed);
  assertEquals(values, {
    prompt: "figs",
    steps: 20,
    cfg: 7,
    denoise: 1,
    sampler: "euler",
    seed: 777,
    size: [1024, 1024],
    checkpoint: "",
    image: null,
    loras: [],
  });
});

Deno.test("required params must not be empty", () => {
  assertThrows(
    () => coerceParams(everything, {}, fixedSeed),
    ParamError,
    "prompt: is required",
  );
  assertThrows(
    () => coerceParams(everything, { prompt: "   " }, fixedSeed),
    ParamError,
    "prompt: is required",
  );
});

Deno.test("numbers are clamped, rounded and snapped to their step", () => {
  const { values } = coerceParams(everything, {
    prompt: "figs",
    steps: 1000,
    cfg: 7.34,
  }, fixedSeed);
  assertEquals(values.steps, 100);
  assertEquals(values.cfg, 7.3);

  assertEquals(
    coerceParams(everything, { prompt: "x", steps: 1 }, fixedSeed).values.steps,
    4,
  );
  assertEquals(
    coerceParams(everything, { prompt: "x", steps: 12.6 }, fixedSeed).values
      .steps,
    13,
  );
  // Numeric strings from a form field are accepted.
  assertEquals(
    coerceParams(everything, { prompt: "x", steps: "30" }, fixedSeed).values
      .steps,
    30,
  );
  assertThrows(
    () => coerceParams(everything, { prompt: "x", steps: "many" }, fixedSeed),
    ParamError,
    "expected a number",
  );
});

Deno.test("seed: -1 resolves to a real seed, and a seed is kept as given", () => {
  assertEquals(
    coerceParams(everything, { prompt: "x", seed: -1 }, fixedSeed).values.seed,
    777,
  );
  assertEquals(
    coerceParams(everything, { prompt: "x", seed: 12345 }, fixedSeed).values
      .seed,
    12345,
  );
  // A real random seed still lands in the safe integer range.
  const { values } = coerceParams(everything, { prompt: "x", seed: -1 });
  const seed = values.seed as number;
  assertEquals(Number.isSafeInteger(seed) && seed >= 0, true);
});

Deno.test("sizes snap to the workflow's grid", () => {
  const size = (value: unknown) =>
    coerceParams(everything, { prompt: "x", size: value }, fixedSeed).values
      .size;
  assertEquals(size([1000, 1500]), [1024, 1472]);
  assertEquals(size([1344, 768]), [1344, 768]);
  assertEquals(size([3, 3]), [64, 64]);
  assertThrows(
    () => size([1024]),
    ParamError,
    "expected [width, height]",
  );
});

Deno.test("LoRA rows are normalised and empty ones dropped", () => {
  const { values } = coerceParams(everything, {
    prompt: "x",
    loras: [
      { name: "a.safetensors", strength_model: 0.8 },
      { name: "  ", strength_model: 1 },
      { name: "b.safetensors", strength_model: 1, strength_clip: 0.5 },
      { name: "c.safetensors" },
    ],
  }, fixedSeed);
  assertEquals(values.loras, [
    // Linked strengths are the default; the sidecar records both.
    { name: "a.safetensors", strength_model: 0.8, strength_clip: 0.8 },
    { name: "b.safetensors", strength_model: 1, strength_clip: 0.5 },
    { name: "c.safetensors", strength_model: 1, strength_clip: 1 },
  ]);
});

Deno.test("enums only accept their options", () => {
  assertThrows(
    () => coerceParams(everything, { prompt: "x", sampler: "heun" }, fixedSeed),
    ParamError,
    "is not one of euler, dpmpp_2m",
  );
});

Deno.test("keys the manifest no longer has are reported, not silently dropped", () => {
  const { values, unknownKeys } = coerceParams(everything, {
    prompt: "x",
    refiner_steps: 8,
    old_key: "gone",
  }, fixedSeed);
  assertEquals(unknownKeys, ["refiner_steps", "old_key"]);
  assertEquals("refiner_steps" in values, false);
});

Deno.test("a workflow with no params coerces to nothing", () => {
  assertEquals(coerceParams(build([]), { anything: 1 }), {
    values: {},
    unknownKeys: ["anything"],
  });
});
