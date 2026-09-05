import { assert, assertEquals } from "@std/assert";
import {
  apiGraphToLiteGraph,
  emptyLiteGraph,
  type LiteGraphNode,
} from "../../src/workflows/litegraph.ts";
import { literalInputs } from "../../src/workflows/inputs.ts";
import { validateManifest } from "../../src/workflows/manifest.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";

const graph: ApiGraph = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "base.safetensors" },
    _meta: { title: "Load Checkpoint" },
  },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 12345,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["1", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 768, batch_size: 1 },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "figs", clip: ["1", 1] },
  },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["3", 0], vae: ["1", 2] },
  },
  "9": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ForgeUI/out", images: ["8", 0] },
  },
};

function nodeById(nodes: LiteGraphNode[], id: number): LiteGraphNode {
  const found = nodes.find((node) => node.id === id);
  assert(found, `no node ${id}`);
  return found;
}

Deno.test("every api node reaches the LiteGraph document", () => {
  const doc = apiGraphToLiteGraph(graph);
  assertEquals(doc.nodes.length, Object.keys(graph).length);
  assertEquals(
    doc.nodes.map((node) => node.id).sort((a, b) => a - b),
    [1, 3, 5, 6, 7, 8, 9],
  );
  assertEquals(doc.last_node_id, 9);
});

Deno.test("widget values follow the node's declared order", () => {
  const doc = apiGraphToLiteGraph(graph);
  // KSampler: the editor shows control_after_generate right after the seed.
  assertEquals(nodeById(doc.nodes, 3).widgets_values, [
    12345,
    "randomize",
    20,
    7,
    "euler",
    "normal",
    1,
  ]);
  assertEquals(nodeById(doc.nodes, 5).widgets_values, [1024, 768, 1]);
  assertEquals(nodeById(doc.nodes, 6).widgets_values, ["figs"]);
  assertEquals(nodeById(doc.nodes, 1).widgets_values, ["base.safetensors"]);
});

Deno.test("links are numbered and wired to the right slots", () => {
  const doc = apiGraphToLiteGraph(graph);
  assertEquals(doc.links.length, 9);
  assertEquals(doc.last_link_id, 9);

  const sampler = nodeById(doc.nodes, 3);
  const modelInput = sampler.inputs?.find((slot) => slot.name === "model");
  assert(modelInput?.link);
  const link = doc.links.find(([id]) => id === modelInput.link);
  assert(link);
  // [link_id, origin_node, origin_slot, target_node, target_slot, type]
  assertEquals(link[1], 1);
  assertEquals(link[2], 0);
  assertEquals(link[3], 3);
  assertEquals(link[5], "MODEL");

  // The checkpoint's CLIP output feeds both text encoders.
  const clipOutput = nodeById(doc.nodes, 1).outputs?.[1];
  assertEquals(clipOutput?.name, "CLIP");
  assertEquals(clipOutput?.links?.length, 2);
});

Deno.test("nodes are laid out left to right by depth", () => {
  const doc = apiGraphToLiteGraph(graph);
  const x = (id: number) => nodeById(doc.nodes, id).pos[0];
  assert(x(1) < x(6), "the loader sits left of the text encoder");
  assert(x(6) < x(3), "the text encoder sits left of the sampler");
  assert(x(3) < x(8), "the sampler sits left of the decoder");
  assert(x(8) < x(9), "the decoder sits left of the save node");
});

Deno.test("an empty document is what a blank workflow gets", () => {
  const doc = emptyLiteGraph();
  assertEquals(doc.nodes, []);
  assertEquals(doc.links, []);
  assertEquals(apiGraphToLiteGraph({}).nodes, []);
});

Deno.test("literal inputs list what the manifest editor shows", () => {
  const inputs = literalInputs(graph);
  // Links are not literal inputs.
  assertEquals(inputs.some((input) => input.input === "model"), false);
  assertEquals(
    inputs.filter((input) => input.node_id === "3").map((input) => input.input),
    ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  );
  const seed = inputs.find((input) => input.input === "seed")!;
  assertEquals(seed.node_type, "KSampler");
  assertEquals(seed.value, 12345);
  assertEquals(seed.type_hint, "int");
  assertEquals(seed.exposed_by, null);

  // Hints: combos and model filenames read as enums, everything else as text.
  const hint = (nodeId: string, name: string) =>
    inputs.find((input) => input.node_id === nodeId && input.input === name)
      ?.type_hint;
  assertEquals(hint("3", "sampler_name"), "enum");
  assertEquals(hint("1", "ckpt_name"), "enum");
  assertEquals(hint("6", "text"), "text");
  assertEquals(hint("9", "filename_prefix"), "text");
  assertEquals(
    inputs.find((input) => input.node_id === "1")?.node_title,
    "Load Checkpoint",
  );
});

Deno.test("inputs already exposed by the manifest say which param owns them", () => {
  const manifest = validateManifest({
    id: "fixture",
    name: "Fixture",
    family: null,
    kind: "image",
    category: null,
    description: null,
    params: [
      { key: "prompt", type: "text", bind: "6.text" },
      {
        key: "size",
        type: "size",
        default: [1024, 768],
        bind: { w: "5.width", h: "5.height" },
      },
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
    ],
    outputs: [{ node: "9", kind: "image" }],
  }, { graph });

  const inputs = literalInputs(graph, manifest);
  const exposed = inputs.filter((input) => input.exposed_by !== null);
  // A size param covers two literal inputs in one row (§4.7).
  assertEquals(exposed.map((input) => `${input.node_id}.${input.input}`), [
    "5.width",
    "5.height",
    "6.text",
  ]);
  assertEquals(exposed.map((input) => input.exposed_by), [
    "size",
    "size",
    "prompt",
  ]);
  // The LoRA chain is synthetic and must not be counted among them.
  assertEquals(inputs.some((input) => input.exposed_by === "loras"), false);
});
