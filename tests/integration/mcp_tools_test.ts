import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { tinyPng } from "../fixtures/png.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { createBridgeServer } from "../../src/mcp/tools.ts";

/**
 * The bridge's library listings (DESIGN-AGENT-LOOP §5.1), driven the way a
 * harness drives them: JSON-RPC over the HTTP binding, not by calling the
 * handler function. What the model is handed is a projection of `GET
 * /api/models`, so these assert the projection as much as the filtering —
 * a listing that leaves `name` out is one nothing can generate from.
 */

interface Entry {
  name: string;
  display_name: string;
  family: string;
  kind: string;
  strength_min?: number;
  strength_max?: number;
}

interface Listing {
  family: string | null;
  total: number;
  families: { family: string; count: number }[];
  note?: string;
  models: Entry[];
}

/** Call one tool over the Streamable HTTP binding and read its JSON back. */
async function callTool<T>(
  app: TestApp,
  name: string,
  args: Record<string, unknown> = {},
  options: { expectError?: boolean } = {},
): Promise<T> {
  const forge = new ForgeUi({ url: app.url });
  const handler = createMcpHandler(() =>
    createBridgeServer({
      forge,
      llama: null,
      freeVram: false,
      progress: false,
      defaultTimeoutMs: 30_000,
    })
  );
  try {
    const response = await handler.fetch(
      new Request("http://bridge/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    assertEquals(response.status, 200);
    const body = await response.text();
    // The binding answers a call as one SSE `message` event.
    const data = body.split("\n").find((line) => line.startsWith("data:"));
    assert(data, `no JSON-RPC response in: ${body}`);
    const message = JSON.parse(data.slice("data:".length)) as {
      result?: { isError?: boolean; content: { text: string }[] };
      error?: { message: string };
    };
    assert(!message.error, `${name} failed: ${message.error?.message}`);
    const result = message.result!;
    const answer = result.content[0]!.text;
    if (options.expectError) {
      assert(result.isError, `${name} should have failed, got: ${answer}`);
      return answer as T;
    }
    assert(!result.isError, `${name} answered an error: ${answer}`);
    return JSON.parse(answer) as T;
  } finally {
    await handler.close();
  }
}

/** Two checkpoint folders and a LoRA folder, spanning two families. */
async function modelFolders(): Promise<{ dir: string; argv: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-mcp-models-" });
  await writeFakeSafetensors(
    join(dir, "checkpoints", "someSDXL.safetensors"),
    {
      name: "sdxl",
      tensors: [
        "model.diffusion_model.input_blocks.0.0.weight",
        "model.diffusion_model.label_emb.0.0.weight",
      ],
    },
  );
  // A second diffusion folder: `list_checkpoints` asks by class, so a model
  // under `diffusion_models/` has to come back beside one under
  // `checkpoints/` — that pooling is the whole point of the class (§8.2).
  await writeFakeSafetensors(
    join(dir, "diffusion_models", "flux1-dev.safetensors"),
    {
      name: "flux",
      tensors: [
        "double_blocks.0.img_attn.norm.key_norm.weight",
        "img_in.weight",
      ],
    },
  );
  // The families are the header's, as they are for a real file (§6).
  await writeFakeSafetensors(
    join(dir, "loras", "film-grain-35mm.safetensors"),
    {
      name: "grain",
      tensors: [
        "lora_unet_input_blocks_1_1.lora_down.weight",
        "lora_te2_text_model_encoder_layers_0_self_attn.lora_up.weight",
      ],
    },
  );
  await writeFakeSafetensors(
    join(dir, "loras", "soft-studio-light.safetensors"),
    {
      name: "soft",
      tensors: ["double_blocks.0.img_attn.proj.lora_down.weight"],
    },
  );
  return {
    dir,
    argv: [
      "--models-dir",
      `checkpoints=${join(dir, "checkpoints")}`,
      "--models-dir",
      `diffusion_models=${join(dir, "diffusion_models")}`,
      "--models-dir",
      `loras=${join(dir, "loras")}`,
    ],
  };
}

async function withModels(
  body: (app: TestApp) => Promise<void>,
): Promise<void> {
  const folders = await modelFolders();
  try {
    await withTestApp(async (app) => {
      await app.models.rescan();
      await app.models.idle();
      await body(app);
    }, { argv: folders.argv });
  } finally {
    await Deno.remove(folders.dir, { recursive: true });
  }
}

Deno.test("list_checkpoints pools the diffusion folders and names what to pass", async () => {
  await withModels(async (app) => {
    const listing = await callTool<Listing>(app, "list_checkpoints");
    const names = listing.models.map((model) => model.name).sort();
    assertEquals(names, ["flux1-dev.safetensors", "someSDXL.safetensors"]);
    assertEquals(listing.total, 2);
    // `name` is what a model param binds to; a display name passed to
    // `generate` reaches ComfyUI and fails there.
    for (const model of listing.models) {
      assert(model.name.endsWith(".safetensors"), model.name);
      assert(model.display_name.length > 0);
      // A strength range is a LoRA's, and means nothing here.
      assertEquals(model.strength_min, undefined);
      assertEquals(model.strength_max, undefined);
    }
    assertEquals(
      listing.models.map((model) => model.kind).sort(),
      ["checkpoints", "diffusion_models"],
    );
  });
});

Deno.test("list_loras lists only LoRAs, with the range its owner set", async () => {
  await withModels(async (app) => {
    const listing = await callTool<Listing>(app, "list_loras");
    assertEquals(listing.total, 2);
    for (const lora of listing.models) {
      assertEquals(lora.kind, "loras");
      assert(typeof lora.strength_min === "number", "the range comes back");
      assert(typeof lora.strength_max === "number");
    }
  });
});

Deno.test("either listing filters by family, and counts the ones there are", async () => {
  await withModels(async (app) => {
    const loras = await callTool<Listing>(app, "list_loras", {
      family: "sdxl",
    });
    assertEquals(loras.family, "sdxl");
    assertEquals(loras.models.map((lora) => lora.name), [
      "film-grain-35mm.safetensors",
    ]);

    const checkpoints = await callTool<Listing>(app, "list_checkpoints", {
      family: "flux",
    });
    assertEquals(checkpoints.models.map((model) => model.name), [
      "flux1-dev.safetensors",
    ]);

    // A family that matches nothing has to say so, with what this class
    // *does* hold: an empty array and a vocabulary of every family ForgeUI
    // knows is what sends a model off to the REST API on its own.
    const none = await callTool<Listing>(app, "list_loras", {
      family: "krea2",
    });
    assertEquals(none.total, 0);
    assertEquals(none.models, []);
    assertStringIncludes(none.note ?? "", "krea2");
    // Counted over this class, not over the whole library.
    assertEquals(none.families, [
      { family: "flux", count: 1 },
      { family: "sdxl", count: 1 },
    ]);
  });
});

Deno.test("an empty class says which folders exist, not just nothing", async () => {
  // The other empty: a folder holding LoRAs under a name the default table
  // does not know is filed as `other`, and `class=lora` then misses it with
  // no hint at all. One line of config fixes it — if you can tell.
  const dir = await Deno.makeTempDir({ prefix: "forgeui-odd-folder-" });
  try {
    await writeFakeSafetensors(join(dir, "lora", "some-style.safetensors"), {
      name: "style",
    });
    await withTestApp(async (app) => {
      await app.models.rescan();
      await app.models.idle();
      const listing = await callTool<Listing>(app, "list_loras");
      assertEquals(listing.total, 0);
      assertStringIncludes(listing.note ?? "", "lora (other)");
      assertStringIncludes(listing.note ?? "", "model_classes");
    }, { argv: ["--models-dir", `lora=${join(dir, "lora")}`] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a listing narrows by text, and otherwise holds nothing back", async () => {
  await withModels(async (app) => {
    const found = await callTool<Listing>(app, "list_loras", { q: "grain" });
    assertEquals(found.models.map((lora) => lora.name), [
      "film-grain-35mm.safetensors",
    ]);

    // No page, no cap: a library is a closed set its owner curated, and a
    // model cannot tell a truncated list from the whole shelf.
    const all = await callTool<Listing>(app, "list_loras");
    assertEquals(all.total, 2);
    assertEquals(all.models.length, all.total);
  });
});
// ------------------------------------------------------- chaining rounds

interface RoundResult {
  counts: { done: number; failed: number };
  jobs: {
    status: string;
    error?: string;
    outputs: {
      id: string;
      kind: string;
      path?: string;
      media_url?: string;
      width?: number | null;
    }[];
  }[];
}

interface Attached {
  value: string;
  kind: string;
  width?: number;
  duration_s?: number;
  bytes: number;
}

/**
 * DESIGN-AUDIO §3's chain, as the model has to walk it: make something, then
 * feed it to the next workflow. There is no dragging over MCP — an output
 * becomes an input through `attach_input`, and the value it hands back is
 * what a media param binds to.
 */
Deno.test("a round names its files, and one of them feeds the next round", async () => {
  await withTestApp(async (app) => {
    const round = await callTool<RoundResult>(app, "generate", {
      jobs: [{ workflow_id: "krea2", params: { prompt: "a granite bowl" } }],
    });
    assertEquals(round.counts.done, 1, round.jobs[0]?.error);

    // Named, not counted: an id to chain from and the file it actually is.
    const [output] = round.jobs[0]!.outputs;
    assert(output, "the round reports what it made");
    assertEquals(output.kind, "image");
    assert(output.path?.endsWith(".png"), `no file path: ${output.path}`);
    assert(output.media_url?.startsWith("/api/media/"), output.media_url);

    // The whole output, not the downscaled copy `get_output_image` returns.
    const attached = await callTool<Attached>(app, "attach_input", {
      output_id: output.id,
    });
    assertEquals(attached.kind, "image");
    assert(attached.bytes > 0);

    const next = await callTool<RoundResult>(app, "generate", {
      jobs: [{
        workflow_id: "krea2-upscale",
        params: { image: attached.value, creativity: 0.4 },
      }],
    });
    assertEquals(next.counts.done, 1, next.jobs[0]?.error);

    // §9 step 3: the file reached ComfyUI under the name the graph binds.
    assert(
      app.fake!.uploads.map((file) => file.name).includes(attached.value),
      `${attached.value} was never uploaded`,
    );
  }, { comfy: true });
});

Deno.test("attach_input also takes a file off the bridge's own disk", async () => {
  // Not everything the model works from was made here: a reference photo, a
  // voice clip to mimic. The bridge reads its own disk and uploads the bytes,
  // because ForgeUI may not be on the same machine.
  await withTestApp(async (app) => {
    const path = await Deno.makeTempFile({ suffix: ".png" });
    try {
      await Deno.writeFile(path, tinyPng({ width: 64, height: 48 }));
      const attached = await callTool<Attached>(app, "attach_input", {
        file: path,
      });
      assertEquals(attached.kind, "image");
      assertEquals(attached.width, 64);
      assert(attached.value.endsWith(".png"), attached.value);
    } finally {
      await Deno.remove(path);
    }
  });
});

Deno.test("attach_input refuses to guess which source you meant", async () => {
  await withTestApp(async (app) => {
    const both = await callTool<string>(app, "attach_input", {
      output_id: "x",
      file: "/tmp/y.png",
    }, { expectError: true });
    assertStringIncludes(both, "exactly one");

    const neither = await callTool<string>(
      app,
      "attach_input",
      {},
      { expectError: true },
    );
    assertStringIncludes(neither, "exactly one");
  });
});

Deno.test("describe_workflow says how to supply media, and leaves the graph out", async () => {
  await withTestApp(async (app) => {
    const detail = await callTool<
      {
        id: string;
        params: {
          key: string;
          type: string;
          bind?: unknown;
          supply?: string;
        }[];
        api_json?: unknown;
      }
    >(app, "describe_workflow", { workflow_id: "ltx2-ia2v" });

    // The whole ComfyUI graph, twice, is not something the model can act on.
    assertEquals(detail.api_json, undefined);
    const byKey = new Map(detail.params.map((param) => [param.key, param]));

    for (const key of ["image", "audio"]) {
      const param = byKey.get(key)!;
      assertStringIncludes(param.supply ?? "", "attach_input");
      // `bind` is the graph's business, not the model's.
      assertEquals(param.bind, undefined);
    }

    // The one number the panel fills in for a human, and therefore the one a
    // model silently gets wrong: the default would trim the take.
    const duration = byKey.get("duration")!;
    assertStringIncludes(duration.supply ?? "", "`audio`");
    assertStringIncludes(duration.supply ?? "", "0.5");
  });
});
