import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
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
  families?: string[];
  models: Entry[];
}

/** Call one tool over the Streamable HTTP binding and read its JSON back. */
async function callTool<T>(
  app: TestApp,
  name: string,
  args: Record<string, unknown> = {},
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
    assert(
      !result.isError,
      `${name} answered an error: ${result.content[0]?.text}`,
    );
    return JSON.parse(result.content[0]!.text) as T;
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

Deno.test("either listing filters by family, and says which families there are", async () => {
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

    // A family that matches nothing is a mistake the model can fix itself,
    // because the vocabulary comes back with the empty list.
    const none = await callTool<Listing>(app, "list_loras", {
      family: "krea2",
    });
    assertEquals(none.total, 0);
    assert(none.families?.includes("sdxl"), "the families are named");
    assert(none.families?.includes("flux"));
  });
});

Deno.test("a listing narrows by text and stops at the limit", async () => {
  await withModels(async (app) => {
    const found = await callTool<Listing>(app, "list_loras", { q: "grain" });
    assertEquals(found.models.map((lora) => lora.name), [
      "film-grain-35mm.safetensors",
    ]);

    const capped = await callTool<Listing>(app, "list_loras", { limit: 1 });
    assertEquals(capped.models.length, 1);
    // The total is the honest one, so a truncated list says so.
    assertEquals(capped.total, 2);
  });
});
