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

/**
 * What `forge models` brought back about the LoRA, as an ingested batch: the
 * author's two write-ups, already Markdown (DESIGN-MODEL-IMPORT §5.5).
 */
async function importDescriptions(app: TestApp, lora: Row): Promise<void> {
  const dir = join(app.paths.imports, "fetched", "success", lora.hash!);
  await Deno.mkdir(dir, { recursive: true });
  const source = {
    kind: "civitai",
    label: "Civitai",
    url: "https://civitai.com/models/82098?modelVersionId=87153",
    model_id: 82098,
    model_version_id: 87153,
    fetched_at: "2026-10-01T10:00:00Z",
  };
  await Deno.writeTextFile(
    join(dir, "model.json"),
    JSON.stringify({
      format: 1,
      forgecli_version: "0.1.0",
      created_at: "2026-10-01T10:00:00Z",
      model: {
        sha256: lora.hash,
        filename: LORA,
        kind: "loras",
        display_name: "Film Grain 35mm",
        family: "sdxl",
        tags: [],
        trigger_words: ["filmgrain"],
      },
      source,
      civitai: {
        format: 1,
        source,
        creator: null,
        model: {
          name: "Film Grain 35mm",
          type: "LORA",
          tags: [],
          description_html: "<h2>Overview</h2><p>Grain like Portra 400.</p>",
          description_text: "## Overview\n\nGrain like **Portra 400**.",
        },
        version: {
          name: "v1",
          base_model: "SDXL 1.0",
          description_html: "<p>Use 0.6–0.8.</p>",
          description_text: "Use **0.6–0.8**; trigger with `filmgrain`.",
        },
        trigger_words: ["filmgrain"],
      },
      samples: [],
    }),
  );
  await app.models.rescan();
  await app.models.idle();
}

Deno.test("the LoRA listing says there is a description, and gives it when asked", async () => {
  await withSamples(async (app, lora) => {
    await importDescriptions(app, lora);
    const find = (result: { content: Block[] }) =>
      JSON.parse((result.content[0] as { text: string }).text).models.find(
        (model: { name: string }) => model.name.endsWith(LORA),
      );

    // By default, the short facts — and a hint that there is more.
    const brief = find(await callTool(app, "list_loras", {}));
    assertEquals(brief.trigger_words, ["filmgrain"]);
    assertEquals(brief.base_model, "SDXL 1.0");
    assertEquals(brief.has_description, true);
    assertEquals(brief.description, undefined);

    // Asked for, the Markdown as the model page shows it: the version's
    // notes as `description`, the model's page as `overview`.
    const full = find(
      await callTool(app, "list_loras", { descriptions: true }),
    );
    assertEquals(
      full.description,
      "Use **0.6–0.8**; trigger with `filmgrain`.",
    );
    assertEquals(full.overview, "## Overview\n\nGrain like **Portra 400**.");
    assertEquals(full.has_description, undefined);
  });
});

Deno.test("get_model_samples carries the model's description too", async () => {
  await withSamples(async (app, lora) => {
    await importDescriptions(app, lora);
    const result = await callTool(app, "get_model_samples", {
      model: lora.name,
      limit: 0,
    });
    const listing = JSON.parse((result.content[0] as { text: string }).text);
    assertStringIncludes(listing.description, "0.6–0.8");
    assertStringIncludes(listing.overview, "Portra 400");
    assertEquals(listing.trigger_words, ["filmgrain"]);
  });
});

Deno.test("set_model_summary and set_model_notes write two different fields", async () => {
  await withSamples(async (app, lora) => {
    const summary = await callTool(app, "set_model_summary", {
      model: lora.name,
      text: "Fine 35mm grain for SDXL photographs.",
    });
    assert(!summary.isError, JSON.stringify(summary));
    const afterSummary = JSON.parse(
      (summary.content[0] as { text: string }).text,
    );
    assertEquals(afterSummary.summary, "Fine 35mm grain for SDXL photographs.");
    assertEquals(afterSummary.notes, null);

    // By hash works too, and the notes land in their own field.
    const notes = await callTool(app, "set_model_notes", {
      model: lora.hash!,
      text: "0.6 is the sweet spot; above 0.9 it bleeds into faces.",
    });
    assert(!notes.isError, JSON.stringify(notes));

    // Both are on the listing, beside the name.
    const listing = JSON.parse(
      ((await callTool(app, "list_loras", {})).content[0] as { text: string })
        .text,
    );
    const entry = listing.models.find((model: { name: string }) =>
      model.name.endsWith(LORA)
    );
    assertEquals(entry.summary, "Fine 35mm grain for SDXL photographs.");
    assertEquals(
      entry.notes,
      "0.6 is the sweet spot; above 0.9 it bleeds into faces.",
    );

    // And on the page the owner reads, through the same route.
    const row = await app.json<Row & { summary: string; notes: string }>(
      `/api/models/${lora.hash}`,
    );
    assertEquals(row.summary, "Fine 35mm grain for SDXL photographs.");

    // An empty string clears.
    await callTool(app, "set_model_summary", { model: lora.name, text: "" });
    const cleared = await app.json<{ summary: string | null }>(
      `/api/models/${lora.hash}`,
    );
    assertEquals(cleared.summary, null);
  });
});

Deno.test("a summary longer than two sentences is refused before it is sent", async () => {
  await withSamples(async (app, lora) => {
    const handler = await callToolRaw(app, "set_model_summary", {
      model: lora.name,
      text: "x".repeat(301),
    });
    // The schema says 300; the protocol refuses it as an invalid argument
    // or a tool error, depending on the SDK — either way nothing is written.
    assert(handler.refused, "a 301-character summary must not be accepted");
    const row = await app.json<{ summary: string | null }>(
      `/api/models/${lora.hash}`,
    );
    assertEquals(row.summary, null);
  });
});

Deno.test("editing a model that does not exist names the listing tools", async () => {
  await withSamples(async (app) => {
    const result = await callTool(app, "set_model_notes", {
      model: "no-such.safetensors",
      text: "anything",
    });
    assert(result.isError);
    assertStringIncludes(
      (result.content[0] as { text: string }).text,
      "list_loras",
    );
  });
});

/** A call whose answer may be a protocol error rather than a result. */
async function callToolRaw(
  app: TestApp,
  name: string,
  args: Record<string, unknown>,
): Promise<{ refused: boolean }> {
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
    if (!data) return { refused: true };
    const message = JSON.parse(data.slice("data:".length));
    return { refused: Boolean(message.error || message.result?.isError) };
  } finally {
    await handler.close();
  }
}
