import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { writeFakeSafetensors } from "../fixtures/models.ts";
import { tinyPng } from "../fixtures/png.ts";
import { ffmpegAvailable } from "../../src/media/audio.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { createBridgeServer } from "../../src/mcp/tools.ts";

/**
 * A model's samples, as the listings count them and as `get_model_samples`
 * shows them (DESIGN-AGENT-LOOP §5.1). Samples are what a LoRA's page says
 * it does; the counts beside `output_count` are what tell a model there is
 * something there worth asking for.
 */

const haveFfmpeg = await ffmpegAvailable();
const LORA = "film-grain-35mm.safetensors";

interface Row {
  id: string;
  name: string;
  filename: string;
  hash: string | null;
  sample_count: number;
  output_count: number;
}

type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

async function callTool(
  app: TestApp,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: Block[] }> {
  const handler = createMcpHandler(() =>
    createBridgeServer({
      forge: new ForgeUi({ url: app.url }),
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
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data:"));
    assert(data, `no JSON-RPC response in: ${body}`);
    const message = JSON.parse(data.slice("data:".length));
    assert(!message.error, `${name} failed: ${message.error?.message}`);
    return message.result;
  } finally {
    await handler.close();
  }
}

/** One LoRA, hashed, with two samples dropped on its page. */
async function withSamples(
  body: (app: TestApp, lora: Row) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-mcp-samples-" });
  await writeFakeSafetensors(join(dir, "loras", LORA), { name: "grain" });
  try {
    await withTestApp(async (app) => {
      await app.models.rescan();
      await app.models.idle();
      const { models } = await app.json<{ models: Row[] }>("/api/models");
      const lora = models.find((model) => model.filename === LORA)!;
      assert(lora.hash, "the fixture LoRA is hashed");
      for (const [width, height] of [[640, 400], [300, 600]]) {
        const form = new FormData();
        form.set(
          "file",
          new File([tinyPng({ width, height }) as BlobPart], "sample.png"),
        );
        const response = await app.fetch(`/api/models/${lora.hash}/samples`, {
          method: "POST",
          body: form,
        });
        assertEquals(response.status, 201);
        await response.body?.cancel();
      }
      await body(app, lora);
    }, { argv: ["--models-dir", `loras=${join(dir, "loras")}`] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the model list counts each model's samples beside its outputs", async () => {
  await withSamples(async (app, lora) => {
    const { models } = await app.json<{ models: Row[] }>("/api/models");
    const row = models.find((model) => model.id === lora.id)!;
    assertEquals(row.sample_count, 2);
    assertEquals(row.output_count, 0);
  });
});

Deno.test("list_loras says how many samples and outputs each LoRA has", async () => {
  await withSamples(async (app) => {
    const result = await callTool(app, "list_loras", {});
    const listing = JSON.parse((result.content[0] as { text: string }).text);
    const entry = listing.models.find((model: { name: string }) =>
      model.name.endsWith(LORA)
    );
    assertEquals(entry.sample_count, 2);
    assertEquals(entry.output_count, 0);
  });
});

Deno.test({
  name: "get_model_samples lists a LoRA's samples and shows them small",
  ignore: !haveFfmpeg,
  fn: async () => {
    await withSamples(async (app, lora) => {
      const result = await callTool(app, "get_model_samples", {
        model: lora.name,
        max_edge: 160,
      });
      assert(!result.isError, JSON.stringify(result));
      const listing = JSON.parse((result.content[0] as { text: string }).text);
      assertEquals(listing.sample_count, 2);
      assertEquals(listing.samples.length, 2);
      assertEquals(listing.samples[0].origin, "dropped in by hand");

      // A caption and a picture for each, fitted inside the edge.
      const pictures = result.content.filter((block) => block.type === "image");
      assertEquals(pictures.length, 2);
      for (const picture of pictures) {
        assertEquals(picture.mimeType, "image/jpeg");
        const bytes = decodeBase64(picture.data);
        assertEquals([...bytes.slice(0, 2)], [0xff, 0xd8], "JPEG magic");
      }
    });
  },
});

Deno.test("get_model_samples finds a model by hash, and can skip the pictures", async () => {
  await withSamples(async (app, lora) => {
    const result = await callTool(app, "get_model_samples", {
      model: lora.hash!,
      limit: 0,
    });
    assert(!result.isError, JSON.stringify(result));
    assertEquals(result.content.length, 1, "the list alone");
    const listing = JSON.parse((result.content[0] as { text: string }).text);
    assertEquals(listing.sample_count, 2);
  });
});

Deno.test("get_model_samples names the tools that list models when it cannot find one", async () => {
  await withSamples(async (app) => {
    const result = await callTool(app, "get_model_samples", {
      model: "no-such-lora.safetensors",
    });
    assert(result.isError);
    assertStringIncludes(
      (result.content[0] as { text: string }).text,
      "list_loras",
    );
  });
});
