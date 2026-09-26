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

/**
 * A bridge whose websocket says nothing, ever.
 *
 * The worst case of a real race, made deterministic. `watch` used to be an
 * async generator, so the socket it opened opened on the first `next()` —
 * after the jobs had been submitted — and a job that finished in that gap
 * emitted an event nobody was listening for. It passed here every time and
 * failed on CI, where the timing is someone else's.
 */
class DeafForgeUi extends ForgeUi {
  override watch(): Promise<AsyncIterable<{ type: string; data: unknown }>> {
    return Promise.resolve({
      // deno-lint-ignore require-yield
      async *[Symbol.asyncIterator]() {
        return;
      },
    });
  }
}

Deno.test("a round finishes even if no event ever arrives", async () => {
  await withTestApp(async (app) => {
    const started = Date.now();
    const result = await runRound({
      jobs: [
        { workflow_id: "krea2", params: { prompt: "one" } },
        { workflow_id: "krea2", params: { prompt: "two" } },
      ],
      timeoutMs: 20_000,
    }, { forge: new DeafForgeUi({ url: app.url }), llama: null });

    // Settled by re-reading the rows, not by waiting out the timeout.
    assertEquals(result.counts.done, 2);
    assert(
      Date.now() - started < 10_000,
      `took ${Date.now() - started}ms; the reconcile is not running`,
    );
  }, { comfy: true });
});

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
      assert(job.outputs.length > 0, "a finished job carries its outputs");
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
  // `get_output_image` (now `get_output_preview`) answer 404 the first time it met a real output.
  await withTestApp(async (app) => {
    const forge = new ForgeUi({ url: app.url });
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge, llama: null });

    const outputId = result.jobs[0]!.outputs[0]!.id;
    const { bytes, mimeType } = await forge.media(outputId);
    assertEquals(mimeType, "image/png");
    assertEquals([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47], "PNG magic");
  }, { comfy: true });
});

Deno.test("a round hands the GPU back when it is done", async () => {
  // The bug this pins: the route did not exist, the bridge swallowed the 404,
  // ComfyUI kept the weights, and llama-server could not start afterwards —
  // with nothing in any log connecting the two.
  await withTestApp(async (app) => {
    assertEquals(app.fake!.freed, 0);
    await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llama: null, freeVram: true });
    assertEquals(app.fake!.freed, 1, "ComfyUI was asked to unload");
  }, { comfy: true });
});

Deno.test("freeing VRAM goes through the route, not the client", async () => {
  await withTestApp(async (app) => {
    const body = await app.json<{ freed: boolean }>("/api/system/free_vram", {
      method: "POST",
    });
    assertEquals(body.freed, true);
    assertEquals(app.fake!.freed, 1);
  }, { comfy: true });
});
