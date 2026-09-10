import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withTestApp } from "../fixtures/app.ts";
import { startFakeComfy } from "../fake-comfy/server.ts";
import { coerceParams } from "../../src/workflows/coerce.ts";
import { rewriteGraph } from "../../src/workflows/rewrite.ts";
import type { Manifest } from "../../src/workflows/types.ts";

interface WorkflowSummary {
  id: string;
  name: string;
  family: string | null;
  kind: string;
  category: string | null;
  source: "bundled" | "user";
  has_user_copy: boolean;
  has_bundled: boolean;
  hash: string;
  params: { keys: string[]; advanced: number };
  runnable: boolean;
  error: string | null;
  last_job_at: number | null;
  last_output_id: string | null;
  has_ui_json: boolean;
}

interface WorkflowDetail extends WorkflowSummary {
  manifest: Manifest | null;
  api_json: Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
  ui_json: { nodes: unknown[]; links: unknown[] };
}

/** The eight of §4.6, in the order the Workflows screen shows them (by name). */
/**
 * Node ids in the bundled `krea2` graph, which came from the official
 * ComfyUI template (§7) rather than being hand-numbered.
 */
const KREA2_SAMPLER = "1";
const KREA2_SAVE = "21";

/** Listed by display name, which is how `GET /api/workflows` orders them. */
const BUNDLED = [
  ["anima", "Anima"],
  ["krea2-img2img", "Flux Krea 2 (img2img)"],
  ["flux-klein", "Flux.2 Klein 4B"],
  ["illustrious", "Illustrious XL"],
  ["krea2", "Krea 2 Turbo"],
  ["ltx", "LTX Video"],
  ["sd15", "Stable Diffusion 1.5"],
  ["z-image-turbo", "Z-Image Turbo"],
] as const;

async function list(app: { fetch: (p: string) => Promise<Response> }) {
  const response = await app.fetch("/api/workflows");
  assertEquals(response.status, 200);
  return (await response.json() as { workflows: WorkflowSummary[] }).workflows;
}

async function detail(
  app: { fetch: (p: string, init?: RequestInit) => Promise<Response> },
  id: string,
) {
  const response = await app.fetch(`/api/workflows/${id}`);
  assertEquals(response.status, 200);
  return await response.json() as WorkflowDetail;
}

Deno.test("the bundled workflows load and list", async () => {
  await withTestApp(async (app) => {
    const workflows = await list(app);
    assertEquals(
      workflows.map((workflow) => [workflow.id, workflow.name]),
      BUNDLED.map(([id, name]) => [id, name]),
    );
    for (const workflow of workflows) {
      assertEquals(workflow.source, "bundled", workflow.id);
      assertEquals(workflow.error, null, workflow.id);
      assertEquals(workflow.runnable, true, workflow.id);
      assert(workflow.hash.startsWith("sha256:"), workflow.id);
      assertEquals(workflow.last_job_at, null);
      assertEquals(workflow.last_output_id, null);
    }

    // The bundled tree is copied into the data dir on boot (§4.6).
    const onDisk: string[] = [];
    for await (const entry of Deno.readDir(app.paths.bundledWorkflows)) {
      if (entry.isDirectory) onDisk.push(entry.name);
    }
    assertEquals(onDisk.sort(), [...BUNDLED.map(([id]) => id)].sort());
  });
});

Deno.test("bundled manifests expose the surface DESIGN §4.6 specifies", async () => {
  await withTestApp(async (app) => {
    const byId = new Map((await list(app)).map((w) => [w.id, w]));
    const keys = (id: string) => byId.get(id)!.params.keys;

    // Rebuilt from the official template (§7). The real Krea 2 is a separate
    // model from Flux.1 Krea [dev], which is what the old graph held; its
    // LoRA sits behind the template's own style switch rather than a chain.
    assertEquals(keys("krea2"), [
      "prompt",
      "model",
      "size",
      "seed",
      "enhance",
      "style",
    ]);
    assertEquals(byId.get("krea2")!.params.advanced, 2); // steps, cfg
    assertEquals(keys("krea2-img2img"), [
      "image",
      "prompt",
      "denoise",
      "size",
      "seed",
      "loras",
    ]);
    assertEquals(byId.get("krea2-img2img")!.category, "img2img");
    // No official ComfyUI page for this SDXL finetune, so its graph is
    // unchanged (§7); it gains the model param like the rest.
    assertEquals(keys("illustrious"), [
      "prompt",
      "negative",
      "model",
      "size",
      "seed",
      "loras",
    ]);
    assertEquals(keys("ltx"), [
      "prompt",
      "size",
      "frames",
      "fps",
      "seed",
      "loras",
    ]);
    // Rebuilt from the official template (§7): the distilled 4B variant,
    // through the custom sampler chain rather than KSampler.
    assertEquals(keys("flux-klein"), ["prompt", "model", "size", "seed"]);
    assertEquals(byId.get("flux-klein")!.params.advanced, 2); // steps, cfg
    // Anima keeps the template's own Turbo LoRA switch as a bool param.
    assertEquals(keys("anima"), [
      "prompt",
      "negative",
      "model",
      "size",
      "seed",
      "turbo",
    ]);
    assertEquals(byId.get("anima")!.params.advanced, 2); // steps, cfg
    // Rebuilt from the official ComfyUI template (§7): three loaders for a
    // split-file model, and a model param to swap it.
    assertEquals(keys("z-image-turbo"), ["prompt", "model", "size", "seed"]);
    assertEquals(byId.get("z-image-turbo")!.params.advanced, 2); // steps, shift
    assertEquals(keys("sd15"), [
      "prompt",
      "negative",
      "size",
      "seed",
      "loras",
    ]);
    assertEquals(byId.get("sd15")!.params.advanced, 2); // steps, cfg

    assertEquals(byId.get("ltx")!.kind, "video");
    assertEquals(
      [...byId.values()].map((w) => w.family),
      // flux-klein is FLUX.2, a different architecture from Flux.1 (§6).
      ["anima", "flux", "flux2", "sdxl", "krea2", "ltx", "sd15", "z-image"],
    );
  });
});

Deno.test("every bundled workflow rewrites into a graph ComfyUI accepts", async () => {
  await withTestApp(async (app) => {
    const dir = await Deno.makeTempDir({ prefix: "forgeui-bundled-" });
    const fake = await startFakeComfy({ stagingDir: join(dir, "staging") });
    try {
      for (const workflow of app.workflows.list()) {
        const manifest = workflow.manifest!;
        const jobId = `01JBUNDLED${
          workflow.id.toUpperCase().replace(/[^A-Z0-9]/g, "")
        }`;
        const { values } = coerceParams(manifest, {
          prompt: "a granite bowl of figs",
          image: "abc123.png",
          loras: [{ name: "film-grain.safetensors", strength_model: 0.8 }],
        }, { randomSeed: () => 42 });
        const { graph } = rewriteGraph({
          manifest,
          graph: workflow.apiGraph,
          params: values,
          jobId,
        });

        const response = await fetch(`${fake.url}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: graph, client_id: "test" }),
        });
        assertEquals(
          response.status,
          200,
          `${workflow.id}: ${await response.clone().text()}`,
        );
        await response.body?.cancel();
      }
      await fake.settled();
      assertEquals(fake.prompts.length, BUNDLED.length);
    } finally {
      await fake.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("GET /api/workflows/:id carries the manifest and both graphs", async () => {
  await withTestApp(async (app) => {
    const workflow = await detail(app, "krea2");
    assertEquals(workflow.manifest?.id, "krea2");
    assertEquals(workflow.api_json[KREA2_SAVE]?.class_type, "SaveImage");
    // No ui.json shipped, so the editor gets one rebuilt from the api graph.
    assertEquals(workflow.has_ui_json, false);
    assertEquals(
      workflow.ui_json.nodes.length,
      Object.keys(workflow.api_json).length,
    );

    const missing = await app.fetch("/api/workflows/nope");
    assertEquals(missing.status, 404);
    assertEquals(
      (await missing.json() as { error: { code: string } }).error.code,
      "not_found",
    );
  });
});

Deno.test("GET /api/workflows/:id/inputs lists literal inputs for the editor", async () => {
  await withTestApp(async (app) => {
    const response = await app.fetch("/api/workflows/krea2/inputs");
    assertEquals(response.status, 200);
    const { inputs } = await response.json() as {
      inputs: {
        node_id: string;
        node_type: string;
        input: string;
        value: unknown;
        exposed_by: string | null;
      }[];
    };

    const sampler = inputs.filter((input) => input.node_id === KREA2_SAMPLER);
    assertEquals(sampler.map((input) => input.input), [
      "seed",
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "denoise",
    ]);
    // krea2's prompt is a PrimitiveStringMultiline the template feeds into
    // the encoder, so `text` is a link now and `value` is the literal.
    assertEquals(
      inputs.find((input) => input.node_id === "13")?.exposed_by,
      "prompt",
    );
    // A model param binds one literal input, like any scalar (§5).
    assertEquals(
      inputs.find((input) => input.input === "unet_name")?.exposed_by,
      "model",
    );
    // Links never appear.
    assertEquals(inputs.some((input) => input.input === "clip"), false);
  });
});

Deno.test("saving a bundled workflow creates a user copy that shadows it", async () => {
  await withTestApp(async (app) => {
    const before = await detail(app, "krea2");
    const manifest = structuredClone(before.manifest!);
    manifest.name = "Flux Krea 2 (mine)";
    manifest.params = manifest.params.filter((param) => param.key !== "cfg");

    const saved = await app.fetch("/api/workflows/krea2", {
      method: "PUT",
      body: JSON.stringify({ manifest }),
    });
    assertEquals(saved.status, 200);
    const after = await saved.json() as WorkflowDetail;
    assertEquals(after.source, "user");
    assertEquals(after.has_user_copy, true);
    assertEquals(after.has_bundled, true);
    assertEquals(after.name, "Flux Krea 2 (mine)");
    assertEquals(after.params.advanced, 1);
    // Editing the manifest changes the workflow hash (§4.7).
    assert(after.hash !== before.hash);

    // The bundled copy on disk is untouched.
    const bundled = JSON.parse(
      await Deno.readTextFile(
        join(app.paths.bundledWorkflows, "krea2", "manifest.json"),
      ),
    ) as Manifest;
    assertEquals(bundled.name, "Krea 2 Turbo");
    assert(
      (await Deno.stat(join(app.paths.userWorkflows, "krea2"))).isDirectory,
    );

    // The list shows one krea2, the user one.
    const listed = (await list(app)).filter((w) => w.id === "krea2");
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.source, "user");
  });
});

Deno.test("a manifest that does not fit the graph is refused before writing", async () => {
  await withTestApp(async (app) => {
    const before = await detail(app, "krea2");
    const manifest = structuredClone(before.manifest!) as Manifest & {
      params: { key: string; type: string; bind: string }[];
    };
    manifest.params.push({ key: "nope", type: "text", bind: "999.text" });

    const response = await app.fetch("/api/workflows/krea2", {
      method: "PUT",
      body: JSON.stringify({ manifest }),
    });
    assertEquals(response.status, 400);
    assertStringIncludes(
      (await response.json() as { error: { message: string } }).error.message,
      'no node "999"',
    );

    // Nothing was written: krea2 is still the bundled one.
    assertEquals((await detail(app, "krea2")).source, "bundled");
    await assertMissing(join(app.paths.userWorkflows, "krea2"));
  });
});

async function assertMissing(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`${path} should not exist`);
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound, `${path} should not exist`);
  }
}

Deno.test("PUT can save the editor's two graph files together", async () => {
  await withTestApp(async (app) => {
    const before = await detail(app, "illustrious");
    const api = structuredClone(before.api_json);
    api["5"]!.inputs.batch_size = 1;
    api["3"]!.inputs.steps = 32;
    const ui = {
      nodes: [{ id: 3, type: "KSampler" }],
      links: [],
      version: 0.4,
    };

    const response = await app.fetch("/api/workflows/illustrious", {
      method: "PUT",
      body: JSON.stringify({ api_json: api, ui_json: ui }),
    });
    assertEquals(response.status, 200);
    const after = await response.json() as WorkflowDetail;
    assertEquals(after.source, "user");
    assertEquals(after.has_ui_json, true);
    assertEquals(after.api_json["3"]?.inputs.steps, 32);
    // The saved document is served back, not a rebuilt one.
    assertEquals(after.ui_json.nodes.length, 1);
    assertEquals(after.manifest?.name, "Illustrious XL");
  });
});

Deno.test("reset drops the user copy and brings the bundled one back", async () => {
  await withTestApp(async (app) => {
    const manifest = structuredClone((await detail(app, "anima")).manifest!);
    manifest.name = "Anima (mine)";
    await app.fetch("/api/workflows/anima", {
      method: "PUT",
      body: JSON.stringify({ manifest }),
    });
    assertEquals((await detail(app, "anima")).source, "user");

    const reset = await app.fetch("/api/workflows/anima/reset", {
      method: "POST",
    });
    assertEquals(reset.status, 200);
    const after = await reset.json() as WorkflowDetail;
    assertEquals(after.source, "bundled");
    assertEquals(after.name, "Anima");
    await assertMissing(join(app.paths.userWorkflows, "anima"));

    // Resetting one that has no user copy is a conflict, not a silent no-op.
    const again = await app.fetch("/api/workflows/anima/reset", {
      method: "POST",
    });
    assertEquals(again.status, 409);
    assertStringIncludes(
      (await again.json() as { error: { message: string } }).error.message,
      "no user copy",
    );
  });
});

Deno.test("bundled workflows cannot be deleted", async () => {
  await withTestApp(async (app) => {
    const bundled = await app.fetch("/api/workflows/krea2", {
      method: "DELETE",
    });
    assertEquals(bundled.status, 409);
    assertStringIncludes(
      (await bundled.json() as { error: { message: string } }).error.message,
      "is bundled and cannot be deleted",
    );

    // A user copy of a bundled workflow is reset, not deleted (§11.2).
    const manifest = structuredClone((await detail(app, "krea2")).manifest!);
    manifest.description = "mine";
    await app.fetch("/api/workflows/krea2", {
      method: "PUT",
      body: JSON.stringify({ manifest }),
    });
    const shadowed = await app.fetch("/api/workflows/krea2", {
      method: "DELETE",
    });
    assertEquals(shadowed.status, 409);
    assertStringIncludes(
      (await shadowed.json() as { error: { message: string } }).error.message,
      "reset it instead",
    );
    assertEquals((await detail(app, "krea2")).source, "user");
  });
});

Deno.test("POST /api/workflows creates a blank workflow, and DELETE removes it", async () => {
  await withTestApp(async (app) => {
    const created = await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "My Sketch" }),
    });
    assertEquals(created.status, 201);
    const workflow = await created.json() as WorkflowDetail;
    assertEquals(workflow.id, "my-sketch");
    assertEquals(workflow.source, "user");
    assertEquals(workflow.has_bundled, false);
    assertEquals(workflow.manifest?.params, []);
    assertEquals(workflow.api_json, {});
    // A blank workflow has nothing to save, so it is not runnable yet.
    assertEquals(workflow.runnable, false);
    assertEquals(workflow.error, null);

    assert((await list(app)).some((w) => w.id === "my-sketch"));

    const removed = await app.fetch("/api/workflows/my-sketch", {
      method: "DELETE",
    });
    assertEquals(removed.status, 204);
    assertEquals((await app.fetch("/api/workflows/my-sketch")).status, 404);
    await assertMissing(join(app.paths.userWorkflows, "my-sketch"));
  });
});

Deno.test("POST /api/workflows imports a LiteGraph document", async () => {
  await withTestApp(async (app) => {
    const ui = {
      nodes: [{
        id: 1,
        type: "CheckpointLoaderSimple",
        widgets_values: ["x.safetensors"],
      }],
      links: [],
      version: 0.4,
    };
    const created = await app.fetch("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Imported", ui_json: ui }),
    });
    assertEquals(created.status, 201);
    const workflow = await created.json() as WorkflowDetail;
    assertEquals(workflow.has_ui_json, true);
    assertEquals(workflow.ui_json.nodes.length, 1);
    // The api graph comes from the editor's save, so it starts out empty.
    assertEquals(workflow.api_json, {});
    assertEquals(workflow.runnable, false);
  });
});

Deno.test("duplicate makes an independent copy with a free id", async () => {
  await withTestApp(async (app) => {
    const first = await app.fetch("/api/workflows/krea2/duplicate", {
      method: "POST",
    });
    assertEquals(first.status, 201);
    const copy = await first.json() as WorkflowDetail;
    assertEquals(copy.id, "krea2-copy");
    assertEquals(copy.name, "Krea 2 Turbo copy");
    assertEquals(copy.source, "user");
    assertEquals(copy.has_bundled, false);
    assertEquals(copy.manifest?.id, "krea2-copy");
    assertEquals(copy.runnable, true);

    const second = await app.fetch("/api/workflows/krea2/duplicate", {
      method: "POST",
    });
    assertEquals((await second.json() as WorkflowDetail).id, "krea2-copy-2");

    // The original is untouched.
    assertEquals((await detail(app, "krea2")).source, "bundled");
  });
});

Deno.test("a user workflow with a broken manifest lists with its error", async () => {
  await withTestApp(async (app) => {
    const workflows = await list(app);
    const broken = workflows.find((workflow) => workflow.id === "broken");
    assert(broken, "the broken workflow should still be listed");
    assertEquals(broken.runnable, false);
    assertStringIncludes(broken.error ?? "", 'no node "42"');
    // Everything else still loaded.
    assertEquals(workflows.length, BUNDLED.length + 1);
  }, {
    files: {
      "workflows/user/broken/manifest.json": JSON.stringify({
        id: "broken",
        name: "Broken",
        family: null,
        kind: "image",
        category: null,
        description: null,
        params: [{ key: "prompt", type: "text", bind: "42.text" }],
        outputs: [],
      }),
      "workflows/user/broken/workflow.api.json": "{}",
    },
  });
});

Deno.test("a user workflow shadows the bundled one it was copied from", async () => {
  await withTestApp(async (app) => {
    const workflows = await list(app);
    const krea2 = workflows.filter((workflow) => workflow.id === "krea2");
    assertEquals(krea2.length, 1);
    assertEquals(krea2[0]?.source, "user");
    assertEquals(krea2[0]?.name, "Krea 2, my way");
    assertEquals(krea2[0]?.has_bundled, true);
    assertEquals(workflows.length, BUNDLED.length);
  }, {
    files: {
      "workflows/user/krea2/manifest.json": JSON.stringify({
        id: "krea2",
        name: "Krea 2, my way",
        family: "flux",
        kind: "image",
        category: null,
        description: null,
        params: [],
        outputs: [],
      }),
      "workflows/user/krea2/workflow.api.json": "{}",
    },
  });
});
