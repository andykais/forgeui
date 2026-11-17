import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  checkGraphAgainstNodes,
  checkGraphShape,
  closest,
  type ObjectInfo,
} from "../../src/workflows/graph_check.ts";
import { shippedBundledDir } from "../../src/workflows/loader.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";

/** A slice of a real ComfyUI's `/object_info`, in its own shape. */
const INFO: ObjectInfo = {
  CheckpointLoaderSimple: {
    input: {
      required: {
        ckpt_name: [["v1-5.safetensors", "sdxl.safetensors"], {}],
      },
    },
    output: ["MODEL", "CLIP", "VAE"],
    output_name: ["MODEL", "CLIP", "VAE"],
  },
  CLIPTextEncode: {
    input: {
      required: {
        text: ["STRING", { multiline: true }],
        clip: ["CLIP", {}],
      },
    },
    output: ["CONDITIONING"],
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT", { min: 0 }],
        steps: ["INT", {}],
        sampler_name: ["COMBO", { options: ["euler", "dpmpp_2m"] }],
        positive: ["CONDITIONING"],
      },
    },
    output: ["LATENT"],
  },
  SaveImage: {
    input: {
      required: { images: ["IMAGE"], filename_prefix: ["STRING"] },
      hidden: { prompt: "PROMPT" },
    },
    output: [],
    output_node: true,
  },
  PreviewAny: {
    input: { required: { source: ["*"] } },
    output: [],
    output_node: true,
  },
};

const node = (class_type: string, inputs: Record<string, unknown>) => ({
  class_type,
  inputs,
});

Deno.test("shape: every problem at once, each naming its node", () => {
  const problems = checkGraphShape({
    "1": node("CLIPTextEncode", { clip: [2, 1] }),
    "2": { inputs: {} },
    "3": node("KSampler", { model: ["9", 0], steps: [1, 2, 3] }),
    "4": { class_type: "SaveImage" },
    "5": "not a node",
  } as unknown as ApiGraph);
  assertEquals(problems, [
    'node "1" (CLIPTextEncode).clip: the node id in a link is a string — ["2", 1], not [2, 1]',
    'node "2": class_type is missing',
    'node "3" (KSampler).model: links to node "9", which is not in the graph',
    'node "3" (KSampler).steps: an array is read as a link and must be ["<node id>", <output slot>], e.g. ["4", 0]',
    'node "4" (SaveImage): inputs is missing (use {} for a node with none)',
    'node "5": expected {class_type, inputs}',
  ]);
});

Deno.test("shape: an empty graph is a draft, not a problem", () => {
  assertEquals(checkGraphShape({}), []);
});

Deno.test("nodes: unknown types, missing inputs, wrong slots and wrong types are errors", () => {
  const { errors } = checkGraphAgainstNodes({
    "1": node("CheckpointLoaderSimple", { ckpt_name: "v1-5.safetensors" }),
    "2": node("ClipTextEncode", { text: "x", clip: ["1", 1] }),
    "3": node("KSampler", {
      model: ["1", 1],
      seed: 0,
      sampler_name: "euler",
      positive: ["1", 5],
    }),
    "4": node("SaveImage", { images: ["3", 0], filename_prefix: "f" }),
  }, INFO);
  assertEquals(errors, [
    'node "2" (ClipTextEncode): this ComfyUI has no node type "ClipTextEncode" — did you mean "CLIPTextEncode"?',
    'node "3" (KSampler): required input "steps" is missing',
    'node "3" (KSampler).model: expects MODEL, but output 1 of node "1" (CheckpointLoaderSimple) is CLIP',
    'node "3" (KSampler).positive: links to output 5 of node "1" (CheckpointLoaderSimple), which has 3 (0: MODEL, 1: CLIP, 2: VAE)',
    'node "4" (SaveImage).images: expects IMAGE, but output 0 of node "3" (KSampler) is LATENT',
  ]);
});

Deno.test("nodes: a combo value off the list and an unknown input are warnings", () => {
  const { errors, warnings } = checkGraphAgainstNodes({
    "1": node("CheckpointLoaderSimple", { ckpt_name: "flux.safetensors" }),
    "2": node("CLIPTextEncode", { text: "x", clip: ["1", 1], txt: "y" }),
    "3": node("KSampler", {
      model: ["1", 0],
      seed: 0,
      steps: 4,
      sampler_name: "eulr",
      positive: ["2", 0],
    }),
    "4": node("PreviewAny", { source: ["3", 0] }),
  }, INFO);
  assertEquals(errors, []);
  assertEquals(warnings.length, 3);
  assertStringIncludes(warnings[0]!, '"flux.safetensors" is not one of');
  assertStringIncludes(warnings[0]!, '"v1-5.safetensors", "sdxl.safetensors"');
  assertStringIncludes(warnings[1]!, '"txt" is not an input of CLIPTextEncode');
  assertStringIncludes(warnings[1]!, 'did you mean "text"');
  assertStringIncludes(warnings[2]!, '"eulr" is not one of');
});

Deno.test("nodes: a graph with no output node would run nothing", () => {
  const { errors } = checkGraphAgainstNodes({
    "1": node("CheckpointLoaderSimple", { ckpt_name: "v1-5.safetensors" }),
  }, INFO);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "no output node");
});

Deno.test("closest suggests by case, containment and edit distance", () => {
  const names = ["KSampler", "KSamplerAdvanced", "VAEDecode", "SaveImage"];
  assertEquals(closest("ksampler", names), ["KSampler", "KSamplerAdvanced"]);
  assertEquals(closest("VAEDecod", names), ["VAEDecode"]);
  assertEquals(closest("Banana", names), []);
});

Deno.test("every bundled graph has the shape the server asks of a written one", async () => {
  // A person saving one of these unchanged must not be refused (§4.9).
  for await (const entry of Deno.readDir(shippedBundledDir())) {
    if (!entry.isDirectory) continue;
    const graph = JSON.parse(
      await Deno.readTextFile(
        join(shippedBundledDir(), entry.name, "workflow.api.json"),
      ),
    ) as ApiGraph;
    assertEquals(checkGraphShape(graph), [], entry.name);
  }
});

/** A real ComfyUI 0.34's node list, trimmed (tests/unit/node_catalog_test.ts). */
const REAL = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/object_info_comfy_0.34.json", import.meta.url),
  ),
) as ObjectInfo;

Deno.test("real node list: every bundled graph passes but for the node pack it needs", async () => {
  // Bundled graphs use switches and resizes whose outputs are typed by what
  // is wired into them; a check that read the placeholder type refused them.
  for await (const entry of Deno.readDir(shippedBundledDir())) {
    if (!entry.isDirectory) continue;
    const graph = JSON.parse(
      await Deno.readTextFile(
        join(shippedBundledDir(), entry.name, "workflow.api.json"),
      ),
    ) as ApiGraph;
    const { errors } = checkGraphAgainstNodes(graph, REAL);
    const real = errors.filter((e) => !e.includes('no node type "BreezeTTS2'));
    assertEquals(real, [], entry.name);
  }
});

Deno.test("real node list: a switch passes on the type wired into it", () => {
  const graph = (feed: [string, number]) => ({
    "1": node("CheckpointLoaderSimple", { ckpt_name: "x.safetensors" }),
    "2": node("ComfySwitchNode", {
      switch: true,
      on_true: feed,
      on_false: feed,
    }),
    "3": node("KSampler", {
      model: ["2", 0],
      seed: 0,
      steps: 4,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "normal",
      positive: ["4", 0],
      negative: ["4", 0],
      latent_image: ["5", 0],
      denoise: 1,
    }),
    "4": node("CLIPTextEncode", { text: "", clip: ["1", 1] }),
    "5": node("EmptyLatentImage", { width: 64, height: 64, batch_size: 1 }),
    "6": node("PreviewAny", { source: ["3", 0] }),
  });
  assertEquals(checkGraphAgainstNodes(graph(["1", 0]), REAL).errors, []);
  assertEquals(checkGraphAgainstNodes(graph(["1", 1]), REAL).errors, [
    'node "3" (KSampler).model: expects MODEL, but output 0 of node "2" (ComfySwitchNode) is CLIP',
  ]);
});

Deno.test("real node list: a repeatable input is sent by its numbered names", () => {
  const graph = (inputs: Record<string, unknown>) => ({
    "1": node("LoadImage", { image: "a.png" }),
    "2": node("BatchImagesNode", inputs),
    "3": node("PreviewAny", { source: ["2", 0] }),
  });
  assertEquals(
    checkGraphAgainstNodes(graph({ "images.image0": ["1", 0] }), REAL).errors,
    [],
  );
  assertEquals(checkGraphAgainstNodes(graph({}), REAL).errors, [
    'node "2" (BatchImagesNode): required input "images.image0" is missing',
  ]);
});

Deno.test("real node list: a choice that brings inputs needs them, and must be one of its options", () => {
  const graph = (inputs: Record<string, unknown>) => ({
    "1": node("LoadImage", { image: "a.png" }),
    "2": node("ResizeImageMaskNode", { input: ["1", 0], ...inputs }),
    "3": node("PreviewAny", { source: ["2", 0] }),
  });
  assertEquals(
    checkGraphAgainstNodes(
      graph({
        resize_type: "scale dimensions",
        "resize_type.width": 512,
        "resize_type.height": 512,
        "resize_type.crop": "center",
        scale_method: "area",
      }),
      REAL,
    ).errors,
    [],
  );
  assertEquals(
    checkGraphAgainstNodes(
      graph({
        resize_type: "scale dimensions",
        "resize_type.width": 512,
        scale_method: "area",
      }),
      REAL,
    ).errors,
    [
      'node "2" (ResizeImageMaskNode): required input "resize_type.height" is missing',
      'node "2" (ResizeImageMaskNode): required input "resize_type.crop" is missing',
    ],
  );
  const wrong = checkGraphAgainstNodes(
    graph({
      resize_type: "bigger",
      scale_method: "area",
    }),
    REAL,
  ).errors;
  assertEquals(wrong.length, 1);
  assertStringIncludes(wrong[0]!, '"bigger" is not one of its options');
});
