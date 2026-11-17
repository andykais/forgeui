import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeNodes,
  type NodeDetail,
  searchNodes,
} from "../../src/workflows/node_catalog.ts";
import type { ObjectInfo } from "../../src/workflows/node_spec.ts";

/**
 * Against a slice of a real ComfyUI 0.34's `/object_info` (no model files
 * installed): every node the bundled workflows use, the v3 input kinds, one
 * deprecated and two paid API nodes. The fake ComfyUI types everything `*`,
 * which is how a false type error once got past the suite.
 */
const INFO = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/object_info_comfy_0.34.json", import.meta.url),
  ),
) as ObjectInfo;

const describe = (name: string) => describeNodes(INFO, [name])[0] as NodeDetail;

Deno.test("search: words over name, aliases and description; one line of signature each", () => {
  const result = searchNodes(INFO, { query: "qwen image edit" });
  assertEquals(result.nodes.map((n) => n.name), ["TextEncodeQwenImageEdit"]);
  const [node] = result.nodes;
  assertEquals(node!.outputs, "CONDITIONING");
  assertEquals(
    node!.inputs,
    "clip: CLIP, prompt: STRING, vae?: VAE, image?: IMAGE",
  );
  assertEquals(node!.source, "core");
});

Deno.test("search: by what a node plugs into", () => {
  const makes = searchNodes(INFO, { output_type: "conditioning", limit: 100 });
  assert(makes.nodes.some((n) => n.name === "CLIPTextEncode"));
  assert(!makes.nodes.some((n) => n.name === "KSampler"));
  const takes = searchNodes(INFO, { input_type: "LATENT", limit: 100 });
  assert(takes.nodes.some((n) => n.name === "VAEDecode"));
  assert(!takes.nodes.some((n) => n.name === "CLIPTextEncode"));
});

Deno.test("search: API and deprecated nodes are left out, and counted", () => {
  const all = searchNodes(INFO, { limit: 200 });
  assertEquals(all.left_out, { api_nodes: 2, deprecated: 2 });
  assert(!all.nodes.some((n) => n.name === "ClaudeNode"));
  assert(!all.nodes.some((n) => n.name === "CheckpointLoader"));
  const withApi = searchNodes(INFO, {
    include_api_nodes: true,
    query: "claude",
  });
  assertEquals(withApi.nodes[0]?.name, "ClaudeNode");
  assertEquals(withApi.nodes[0]?.source, "api");
});

Deno.test("search: a category and everything under it; categories counted", () => {
  const loaders = searchNodes(INFO, { category: "model/loaders/", limit: 100 });
  assert(loaders.nodes.length > 3);
  assert(loaders.nodes.every((n) => n.category!.startsWith("model/loaders")));
  assert(
    searchNodes(INFO, {}).categories.some((c) =>
      c.category === "model/loaders"
    ),
  );
});

Deno.test("search: a merge node's 70 inputs stay one line", () => {
  const [merge] = searchNodes(INFO, { query: "ModelMergeQwenImage" }).nodes;
  assertStringIncludes(merge!.inputs, "more");
  assert(merge!.inputs.length < 600, merge!.inputs);
});

Deno.test("search: a switch's output is said as what it passes on", () => {
  const [node] = searchNodes(INFO, { query: "ComfySwitchNode" }).nodes;
  assertEquals(node!.outputs, "* (as on_false/on_true)");
});

Deno.test("describe: inputs with ranges and choices, and a node ready to paste", () => {
  const ks = describe("KSampler");
  const seed = ks.inputs.find((i) => i.name === "seed")!;
  assertEquals(seed.takes, "value");
  assertEquals(seed.min, 0);
  assertEquals(seed.max, undefined, "2^64-1 says nothing JSON can carry");
  const sampler = ks.inputs.find((i) => i.name === "sampler_name")!;
  assertEquals(sampler.takes, "choice");
  assert(sampler.choices!.includes("euler"));
  assertEquals(ks.inputs.find((i) => i.name === "model")!.takes, "link");
  assertEquals(ks.example!.inputs.model, "<link: MODEL>");
  assertEquals(ks.example!.inputs.steps, 20);
  assertEquals(ks.outputs, [{ slot: 0, name: "LATENT", type: "LATENT" }]);
});

Deno.test("describe: a loader with no files says so", () => {
  const unet = describe("UNETLoader").inputs.find((i) =>
    i.name === "unet_name"
  )!;
  assertEquals(unet.choices, []);
  assertStringIncludes(unet.choices_note!, "no file of this kind");
});

Deno.test("describe: a choice that brings inputs, and a repeatable input", () => {
  const resize = describe("ResizeImageMaskNode");
  const type = resize.inputs.find((i) => i.name === "resize_type")!;
  assertEquals(type.takes, "choice_with_inputs");
  assertEquals(type.options![0]!.key, "scale dimensions");
  assertEquals(
    type.options![0]!.inputs.map((i) => i.name),
    ["resize_type.width", "resize_type.height", "resize_type.crop"],
  );
  assertEquals(resize.example!.inputs["resize_type"], "scale dimensions");
  assertEquals(resize.example!.inputs["resize_type.width"], 512);
  assertEquals(resize.outputs[0]!.same_type_as, ["input"]);
  assertEquals(resize.outputs[0]!.type, "IMAGE,MASK");

  const batch = describe("BatchImagesNode");
  const images = batch.inputs[0]!;
  assertEquals(images.takes, "repeatable");
  assertEquals(images.type, "IMAGE");
  assertEquals(images.names, "images.image0, images.image1, … images.image49");
  assertEquals(images.min_count, 1);
  assertEquals(batch.example!.inputs, { "images.image0": "<link: IMAGE>" });
});

Deno.test("describe: an unknown name comes back with the nearest ones", () => {
  const [missing] = describeNodes(INFO, ["KSamplr"]);
  assertStringIncludes(
    (missing as { error: string }).error,
    'did you mean "KSampler"',
  );
});

Deno.test("describe: what a raw read of /object_info would be looked at for", () => {
  const image = describe("LoadImage").inputs.find((i) => i.name === "image")!;
  assertEquals(image.upload, "image");
  assertEquals(describe("LoadAudio").inputs[0]!.upload, "audio");
  const device = describe("CLIPLoader").inputs.find((i) =>
    i.name === "device"
  )!;
  assertEquals(device.advanced, true);
  const seed = describe("KSampler").inputs.find((i) => i.name === "seed")!;
  assertEquals(seed.randomized_in_editor, true);
  const vae = describe("LTXVEmptyLatentAudio").inputs.find((i) =>
    i.name === "audio_vae"
  )!;
  assert(vae.label && vae.label !== "audio_vae", JSON.stringify(vae));
  const output = describe("LoadImageOutput").inputs.find((i) =>
    i.name === "image"
  )!;
  assertStringIncludes(output.choices_from!, "at run time");

  const [multi] = describeNodes({
    PickMany: {
      input: {
        required: {
          tags: ["COMBO", { options: ["a", "b"], multiselect: true }],
        },
      },
      output: ["STRING"],
    },
  }, ["PickMany"]) as NodeDetail[];
  assertEquals(multi!.inputs[0]!.multiselect, true);
});

Deno.test("describe raw: the node's own entry, unabridged", () => {
  const [entry] = describeNodes(INFO, ["CLIPLoader"], { raw: true });
  assertEquals((entry as { raw: unknown }).raw, INFO["CLIPLoader"]);
});

Deno.test("tooltips: hidden unless asked for, then whole; inputs narrow it", () => {
  const plain = describe("KSampler");
  assert(plain.inputs.every((i) => i.tooltip === undefined));
  assertStringIncludes(plain.tooltips!, "include_tooltips");

  const [full] = describeNodes(INFO, ["KSampler"], {
    tooltips: true,
    inputs: ["cfg", "denoise", "cgf"],
  }) as NodeDetail[];
  assertEquals(full!.inputs.map((i) => i.name), ["cfg", "denoise"]);
  // Exactly ComfyUI's text, however long: never cut.
  const raw = (INFO["KSampler"]!.input!.required!["cfg"] as [
    string,
    { tooltip: string },
  ])[1].tooltip;
  assert(raw.length > 200, "the fixture's cfg tooltip is a long one");
  assertEquals(full!.inputs[0]!.tooltip, raw);
  assertEquals(full!.outputs[0]!.tooltip, "The denoised latent.");
  assertEquals(full!.example, undefined, "a narrowed look has no example");
  assertEquals(full!.unknown_inputs, ["cgf (did you mean cfg?)"]);
  assertEquals(full!.tooltips, undefined);
});
