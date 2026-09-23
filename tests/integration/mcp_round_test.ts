import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { withTestApp } from "../fixtures/app.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { LlamaSwap } from "../../src/mcp/llama.ts";
import { runRound } from "../../src/mcp/round.ts";

/**
 * The round of DESIGN-AGENT-LOOP §5.2, against the real server and the fake
 * ComfyUI. The GPU handoff is the part with no second chance — everything
 * here is about the order things happen in, not about MCP framing.
 */

/** A llama-swap that records the order it was called in. */
function fakeSwap(calls: string[]) {
  let resident = true;
  const fetcher = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/running") {
      return Promise.resolve(
        Response.json(resident ? [{ model: "qwen-vlm" }] : []),
      );
    }
    if (url.pathname.startsWith("/api/models/unload")) {
      calls.push("unload");
      resident = false;
      return Promise.resolve(Response.json({}));
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  return { fetcher, isResident: () => resident };
}

Deno.test("a round evicts the model, generates, and labels the work", async () => {
  await withTestApp(async (app) => {
    const calls: string[] = [];
    const { fetcher, isResident } = fakeSwap(calls);
    const forge = new ForgeUi({ url: app.url });
    const llama = new LlamaSwap({ url: "http://swap", fetch: fetcher });

    const result = await runRound({
      jobs: [
        { workflow_id: "krea2", params: { prompt: "a heron" }, note: "0.7" },
        {
          workflow_id: "krea2",
          params: { prompt: "a heron, dusk" },
          note: "0.9",
        },
      ],
      project: "herons",
      note: "round 1",
      timeoutMs: 30_000,
    }, { forge, llama });

    // The source is the model that was resident when the round began — read
    // before the eviction, because afterwards there is nothing to ask.
    assertEquals(result.source, "llm:qwen-vlm");
    assertEquals(result.project, "herons");
    assertEquals(calls, ["unload"]);
    assertEquals(isResident(), false);

    assertEquals(result.counts.done, 2);
    assertEquals(result.counts.failed, 0);
    assertEquals(result.jobs.length, 2);
    for (const job of result.jobs) {
      assertEquals(job.status, "done");
      assert(job.output_ids.length > 0, "a finished job carries its outputs");
    }
    // The per-job note survives alongside the round's.
    assertEquals(result.jobs.map((job) => job.note), ["0.7", "0.9"]);
  }, { comfy: true });
});

Deno.test("a round with no llama-swap still runs, and says it cannot name a model", async () => {
  // The LLM is not on this GPU — a hosted model, or another box. Nothing to
  // evict, and the work is still recorded as having come from a model.
  await withTestApp(async (app) => {
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llama: null });

    assertEquals(result.source, "llm:unknown");
    assertEquals(result.counts.done, 1);
  }, { comfy: true });
});

Deno.test("a bad param fails the round and leaves nothing queued", async () => {
  await withTestApp(async (app) => {
    const forge = new ForgeUi({ url: app.url });
    const error = await runRound({
      jobs: [
        { workflow_id: "krea2", params: { prompt: "fine" } },
        { workflow_id: "nope", params: {} },
      ],
      timeoutMs: 30_000,
    }, { forge, llama: null }).then(() => null, (cause: Error) => cause);

    assert(error, "the round rejects rather than running half of itself");
    assertStringIncludes(error.message, "nope");

    // The one that was accepted before the failure is cancelled, not orphaned
    // — otherwise a rejected round leaves the GPU working on half a batch.
    const jobs = await app.json<{ jobs: { status: string }[] }>(
      "/api/jobs?status=all",
    );
    for (const job of jobs.jobs) {
      assert(
        job.status !== "queued" && job.status !== "running",
        `left a ${job.status} job behind`,
      );
    }
  }, { comfy: true });
});

Deno.test("every job failing still ends the round", async () => {
  // Terminal means terminal, not successful (§6.1). The alternative is a
  // bridge that waits forever holding the GPU.
  await withTestApp(async (app) => {
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "error" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llama: null });

    assertEquals(result.counts.done, 0);
    assertEquals(result.counts.failed, 1);
    assert(result.jobs[0]!.error, "the failure is reported, not swallowed");
  }, { comfy: { scenario: "error-mid-graph" } });
});

Deno.test("an output's media is fetched by the url the row carries", async () => {
  // §12 serves media from /api/media/<path>, not from a path under the
  // output. Building the URL here instead of reading `media_url` is what made
  // `get_output_image` answer 404 the first time it met a real output.
  await withTestApp(async (app) => {
    const forge = new ForgeUi({ url: app.url });
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge, llama: null });

    const outputId = result.jobs[0]!.output_ids[0]!;
    const { bytes, mimeType } = await forge.media(outputId);
    assertEquals(mimeType, "image/png");
    assertEquals([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47], "PNG magic");
  }, { comfy: true });
});
