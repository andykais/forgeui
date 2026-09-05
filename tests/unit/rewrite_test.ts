import { assert, assertEquals, assertThrows } from "@std/assert";
import { coerceParams } from "../../src/workflows/coerce.ts";
import { validateManifest } from "../../src/workflows/manifest.ts";
import { RewriteError, rewriteGraph } from "../../src/workflows/rewrite.ts";
import type { ApiGraph, Manifest } from "../../src/workflows/types.ts";
import { assertGoldenJson, goldenCases } from "../golden/runner.ts";

const GOLDEN_JOB_ID = "01JGOLDEN000000000000000000";
const GOLDEN_SEED = 424242;

Deno.test("golden rewrites", async (t) => {
  for (const testCase of await goldenCases("rewrite")) {
    await t.step(testCase.name, async () => {
      const graph = await testCase.json<ApiGraph>("api.json");
      const manifest = validateManifest(await testCase.json("manifest.json"), {
        graph,
      });
      const { values } = coerceParams(
        manifest,
        await testCase.json<Record<string, unknown>>("params.json"),
        { randomSeed: () => GOLDEN_SEED },
      );
      const result = rewriteGraph({
        manifest,
        graph,
        params: values,
        jobId: GOLDEN_JOB_ID,
      });
      await assertGoldenJson(testCase.file("expected.json"), result.graph);
    });
  }
});

function fixture(): { graph: ApiGraph; manifest: Manifest } {
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
        model: ["1", 0],
        positive: ["6", 0],
        negative: ["6", 0],
        latent_image: ["5", 0],
      },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["1", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["1", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ForgeUI/out", images: ["8", 0] },
    },
  };
  const manifest = validateManifest({
    id: "fixture",
    name: "Fixture",
    family: "sdxl",
    kind: "image",
    category: null,
    description: null,
    params: [
      { key: "prompt", type: "text", bind: "6.text" },
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
  return { graph, manifest };
}

Deno.test("the source graph is never mutated", () => {
  const { graph, manifest } = fixture();
  const before = structuredClone(graph);
  rewriteGraph({
    manifest,
    graph,
    params: {
      prompt: "hello",
      loras: [{ name: "a.safetensors", strength_model: 1, strength_clip: 1 }],
    },
    jobId: "01JA",
  });
  assertEquals(graph, before);
});

Deno.test("spliced LoRA nodes get ids that do not collide", () => {
  const { graph, manifest } = fixture();
  const { graph: rewritten } = rewriteGraph({
    manifest,
    graph,
    params: {
      prompt: "hello",
      loras: [
        { name: "a.safetensors", strength_model: 1, strength_clip: 1 },
        { name: "b.safetensors", strength_model: 1, strength_clip: 1 },
      ],
    },
    jobId: "01JA",
  });
  assertEquals(Object.keys(rewritten).filter((id) => !(id in graph)), [
    "10",
    "11",
  ]);
  // The chain runs base → a → b, and the targets point at the last node.
  assertEquals(rewritten["10"]!.inputs.model, ["1", 0]);
  assertEquals(rewritten["11"]!.inputs.model, ["10", 0]);
  assertEquals(rewritten["11"]!.inputs.clip, ["10", 1]);
  assertEquals(rewritten["3"]!.inputs.model, ["11", 0]);
  assertEquals(rewritten["6"]!.inputs.clip, ["11", 1]);
});

Deno.test("every output node is stamped with the job's prefix", () => {
  const { graph, manifest } = fixture();
  graph["10"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "elsewhere", images: ["8", 0] },
  };
  manifest.outputs.push({ node: "10", kind: "image" });
  const { graph: rewritten, outputNodes, filenamePrefix } = rewriteGraph({
    manifest,
    graph,
    params: { prompt: "hello", loras: [] },
    jobId: "01JPREFIX",
  });
  assertEquals(filenamePrefix, "01JPREFIX/out");
  assertEquals(outputNodes, ["9", "10"]);
  for (const id of outputNodes) {
    assertEquals(rewritten[id]!.inputs.filename_prefix, "01JPREFIX/out");
  }
});

Deno.test("a job id that would escape the staging dir is refused", () => {
  const { graph, manifest } = fixture();
  for (const jobId of ["", "../escape", "nested/id"]) {
    assertThrows(
      () => rewriteGraph({ manifest, graph, params: {}, jobId }),
      RewriteError,
      "usable directory name",
    );
  }
});

Deno.test("a workflow with no outputs cannot be rewritten", () => {
  const { graph, manifest } = fixture();
  manifest.outputs = [];
  assertThrows(
    () => rewriteGraph({ manifest, graph, params: {}, jobId: "01JA" }),
    RewriteError,
    "nothing to save",
  );
});

Deno.test("an empty image param leaves the graph's own value alone", () => {
  const graph: ApiGraph = {
    "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "x", images: ["1", 0] },
    },
  };
  const manifest = validateManifest({
    id: "img",
    name: "Img",
    family: null,
    kind: "image",
    category: "img2img",
    description: null,
    params: [{ key: "image", type: "image", bind: "1.image" }],
    outputs: [{ node: "9", kind: "image" }],
  }, { graph });

  const untouched = rewriteGraph({
    manifest,
    graph,
    params: { image: null },
    jobId: "01JA",
  });
  assertEquals(untouched.graph["1"]!.inputs.image, "example.png");

  const attached = rewriteGraph({
    manifest,
    graph,
    params: { image: "abc123.png" },
    jobId: "01JA",
  });
  assertEquals(attached.graph["1"]!.inputs.image, "abc123.png");
});

Deno.test("binding into a node that vanished is an error, not a silent no-op", () => {
  const { graph, manifest } = fixture();
  delete graph["6"];
  assert(manifest.params.some((param) => param.key === "prompt"));
  assertThrows(
    () =>
      rewriteGraph({
        manifest,
        graph,
        params: { prompt: "hi" },
        jobId: "01JA",
      }),
    RewriteError,
    'no node "6"',
  );
});
