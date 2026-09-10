import { assertEquals, assertThrows } from "@std/assert";
import {
  ManifestError,
  resolveDefaults,
  serializeManifest,
  validateManifest,
} from "../../src/workflows/manifest.ts";
import { canonicalJson, workflowHash } from "../../src/workflows/hash.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";

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
  "9": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ForgeUI/out", images: ["8", 0] },
  },
};

function manifest(params: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "fixture",
    name: "Fixture",
    family: "sdxl",
    kind: "image",
    category: null,
    description: null,
    params,
    outputs: [{ node: "9", kind: "image" }],
    ...extra,
  };
}

function invalid(params: unknown[], message: string, extra = {}) {
  assertThrows(
    () => validateManifest(manifest(params, extra), { graph }),
    ManifestError,
    message,
  );
}

Deno.test("each param type in the closed set validates", () => {
  const parsed = validateManifest(
    manifest([
      { key: "prompt", type: "text", required: true, bind: "6.text" },
      {
        key: "steps",
        type: "int",
        default: 20,
        min: 1,
        max: 100,
        bind: "3.steps",
      },
      { key: "cfg", type: "float", default: 7, step: 0.1, bind: "3.cfg" },
      { key: "seed", type: "seed", default: -1, bind: "3.seed" },
      {
        key: "size",
        type: "size",
        default: [1024, 1024],
        step: 64,
        bind: { w: "5.width", h: "5.height" },
      },
      {
        key: "sampler",
        type: "enum",
        options: ["euler", "dpmpp_2m"],
        default: "euler",
        bind: "3.sampler_name",
      },
      { key: "batch", type: "int", default: 1, bind: "5.batch_size" },
      {
        key: "checkpoint",
        type: "checkpoint",
        filter: { family: "sdxl" },
        bind: "1.ckpt_name",
      },
      {
        key: "loras",
        type: "lora_list",
        filter: { family: "sdxl" },
        bind: {
          chain: {
            model_from: "1.MODEL",
            clip_from: "1.CLIP",
            model_to: ["3.model"],
            clip_to: ["6.clip"],
          },
        },
      },
    ]),
    { graph, id: "fixture" },
  );
  assertEquals(parsed.params.length, 9);
  assertEquals(parsed.params[4]?.type, "size");
  assertEquals(parsed.family, "sdxl");
});

Deno.test("a param type outside the closed set is rejected", () => {
  invalid(
    [{ key: "lora_stack", type: "lora_stack", bind: "3.stack" }],
    "one of text, int, float",
  );
});

Deno.test("binds are checked against the graph", () => {
  invalid([{ key: "prompt", type: "text", bind: "66.text" }], 'no node "66"');
  invalid(
    [{ key: "prompt", type: "text", bind: "6.txet" }],
    'node 6 (CLIPTextEncode) has no input "txet"',
  );
  invalid([{ key: "prompt", type: "text", bind: "6text" }], "binding");
  // An input fed by a link is not a literal the panel can set.
  invalid(
    [{ key: "latent", type: "text", bind: "3.latent_image" }],
    "fed by a link",
  );
});

Deno.test("a chain must start at a real output and end on real links", () => {
  const chain = (over: Record<string, unknown>) => [{
    key: "loras",
    type: "lora_list",
    bind: {
      chain: {
        model_from: "1.MODEL",
        clip_from: "1.CLIP",
        model_to: ["3.model"],
        clip_to: ["6.clip"],
        ...over,
      },
    },
  }];
  invalid(chain({ model_from: "1.LATENT" }), 'has no output "LATENT"');
  invalid(chain({ model_to: ["3.steps"] }), "must be fed by a link");
  invalid(chain({ model_to: [] }), "at least one input to rewire");
  invalid(chain({ clip_from: null }), "both be null for");
  // A slot index is the escape hatch for nodes the app has no schema for.
  validateManifest(manifest(chain({ model_from: "1.0" })), { graph });
});

Deno.test("model-only chains are allowed", () => {
  const parsed = validateManifest(
    manifest([{
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
    }]),
    { graph },
  );
  assertEquals(parsed.params[0]?.type, "lora_list");
});

Deno.test("keys are unique, snake_case, and there is one LoRA list", () => {
  invalid(
    [
      { key: "prompt", type: "text", bind: "6.text" },
      { key: "prompt", type: "text", bind: "6.text" },
    ],
    'duplicate key "prompt"',
  );
  invalid(
    [{ key: "Prompt", type: "text", bind: "6.text" }],
    "lower_snake_case",
  );
  const list = {
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
  };
  invalid([list, { ...list, key: "more_loras" }], "only one lora_list");
});

Deno.test("numbers, enums and sizes are sanity-checked", () => {
  invalid(
    [{ key: "steps", type: "int", min: 10, max: 5, bind: "3.steps" }],
    "min 10 is above max 5",
  );
  invalid(
    [{ key: "steps", type: "int", default: 2.5, bind: "3.steps" }],
    "a whole number",
  );
  invalid([{ key: "cfg", type: "float", step: 0, bind: "3.cfg" }], "positive");
  invalid(
    [{ key: "sampler", type: "enum", bind: "3.sampler_name" }],
    "options or a source",
  );
  invalid(
    [{
      key: "sampler",
      type: "enum",
      options: ["euler"],
      default: "heun",
      bind: "3.sampler_name",
    }],
    "not one of the options",
  );
  invalid(
    [{
      key: "size",
      type: "size",
      default: [1024],
      bind: { w: "5.width", h: "5.height" },
    }],
    "[width, height]",
  );
  invalid(
    [{
      key: "size",
      type: "size",
      default: [1024, 1024],
      step: 12,
      bind: { w: "5.width", h: "5.height" },
    }],
    "8, 16 or 64",
  );
});

Deno.test("workflow-level fields are checked", () => {
  assertThrows(
    () => validateManifest(manifest([], { family: "pony" }), { graph }),
    ManifestError,
    "one of flux, flux2, krea2, chroma, sdxl, anima, ltx, ltx-2, z-image, sd15",
  );
  assertThrows(
    () => validateManifest(manifest([], { kind: "audio" }), { graph }),
    ManifestError,
    "one of image, video",
  );
  assertThrows(
    () => validateManifest(manifest([], { category: "upscale" }), { graph }),
    ManifestError,
    "one of img2img",
  );
  assertThrows(
    () =>
      validateManifest(
        manifest([], { outputs: [{ node: "42", kind: "image" }] }),
        {
          graph,
        },
      ),
    ManifestError,
    'no node "42"',
  );
  assertThrows(
    () => validateManifest(manifest([]), { graph, id: "other" }),
    ManifestError,
    'does not match the directory "other"',
  );
});

Deno.test("a draft with no params or outputs loads", () => {
  const parsed = validateManifest(manifest([], { outputs: [] }), { graph });
  assertEquals(parsed.outputs, []);
  assertEquals(parsed.params, []);
});

Deno.test("serialising a manifest keeps the §4.2 field order", () => {
  const parsed = validateManifest(manifest([]), { graph });
  assertEquals(Object.keys(JSON.parse(serializeManifest(parsed))), [
    "id",
    "name",
    "family",
    "kind",
    "category",
    "description",
    "params",
    "outputs",
  ]);
});

Deno.test("the workflow hash tracks content, not formatting", async () => {
  const parsed = validateManifest(manifest([]), { graph });
  const hash = await workflowHash(graph, parsed);
  assertEquals(hash.startsWith("sha256:"), true);
  assertEquals(hash.length, "sha256:".length + 64);

  // Key order does not matter…
  const reordered: ApiGraph = Object.fromEntries(
    Object.entries(graph).reverse(),
  );
  assertEquals(await workflowHash(reordered, parsed), hash);

  // …but a changed value does.
  const changed = structuredClone(graph);
  changed["3"]!.inputs.steps = 21;
  assertEquals((await workflowHash(changed, parsed)) === hash, false);
  assertEquals(
    (await workflowHash(graph, { ...parsed, name: "Renamed" })) === hash,
    false,
  );
});

Deno.test("canonical JSON sorts keys but keeps array order", () => {
  assertEquals(
    canonicalJson({ b: 1, a: [3, 1, 2], c: { z: null, y: "x" } }),
    '{"a":[3,1,2],"b":1,"c":{"y":"x","z":null}}',
  );
});

Deno.test("checkpoint is the old spelling of model, and widens to the class", () => {
  const graph: ApiGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "x" } },
  };
  const legacy = validateManifest({
    id: "w",
    name: "W",
    family: "flux",
    kind: "image",
    params: [{
      key: "model",
      type: "checkpoint",
      filter: { family: "flux" },
      bind: "1.unet_name",
    }],
    outputs: [{ node: "1", kind: "image" }],
  }, { graph });
  const param = legacy.params[0]!;
  assertEquals(param.type, "model");
  // The old spelling could only reach checkpoints/; a model param reaches
  // every folder that can drive a generation (§5, §14).
  assertEquals(
    (param as { filter?: { class?: string; family?: string } }).filter,
    { class: "diffusion", family: "flux" },
  );

  // The new spelling parses the same, and its class can be named outright.
  const current = validateManifest({
    id: "w",
    name: "W",
    family: null,
    kind: "image",
    params: [{
      key: "model",
      type: "model",
      filter: { class: "diffusion" },
      bind: "1.unet_name",
    }],
    outputs: [{ node: "1", kind: "image" }],
  }, { graph });
  assertEquals(current.params[0]!.type, "model");
});

Deno.test("the graph supplies the defaults it already holds", () => {
  const graph: ApiGraph = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "mine.safetensors" },
    },
    "3": {
      class_type: "KSampler",
      inputs: { seed: 12345, steps: 28, cfg: 5, denoise: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "out" } },
  };
  const manifest = validateManifest({
    id: "w",
    name: "W",
    family: null,
    kind: "image",
    params: [
      { key: "model", type: "model", bind: "1.ckpt_name" },
      { key: "prompt", type: "text", bind: "6.text" },
      { key: "steps", type: "int", bind: "3.steps" },
      { key: "seed", type: "seed", bind: "3.seed" },
      { key: "cfg", type: "float", default: 7, bind: "3.cfg" },
    ],
    outputs: [{ node: "9", kind: "image" }],
  }, { graph });

  const resolved = resolveDefaults(manifest, graph);
  const byKey = new Map(resolved.params.map((param) => [param.key, param]));
  const defaultOf = (key: string) =>
    (byKey.get(key) as { default?: unknown }).default;

  // What the graph loads is what the panel starts from, so editing the
  // loader in ComfyUI is visible instead of being overwritten at submit.
  assertEquals(defaultOf("model"), "mine.safetensors");
  assertEquals(defaultOf("prompt"), "a cat");
  assertEquals(defaultOf("steps"), 28);
  // A seed's -1 means "randomise at submit"; the graph's concrete number
  // would pin every generation to it.
  assertEquals(defaultOf("seed"), undefined);
  // An explicit default is the author saying the two differ on purpose.
  assertEquals(defaultOf("cfg"), 7);
});

Deno.test("a default the graph cannot supply is left alone", () => {
  const graph: ApiGraph = {
    "1": { class_type: "LoadImage", inputs: { image: "sample.png" } },
    "3": { class_type: "KSampler", inputs: { steps: 20, model: ["1", 0] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "out" } },
  };
  const manifest = validateManifest({
    id: "w",
    name: "W",
    family: null,
    kind: "image",
    params: [
      // A filename left in a bundled LoadImage is not a default anyone chose.
      { key: "image", type: "image", bind: "1.image" },
    ],
    outputs: [{ node: "9", kind: "image" }],
  }, { graph });

  const resolved = resolveDefaults(manifest, graph);
  for (const param of resolved.params) {
    assertEquals(
      (param as { default?: unknown }).default,
      undefined,
      param.key,
    );
  }
});
