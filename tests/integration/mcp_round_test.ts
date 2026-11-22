import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { withTestApp } from "../fixtures/app.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { LlamaSwap } from "../../src/mcp/llama.ts";
import { Strata } from "../../src/mcp/strata.ts";
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
    }, { forge: new DeafForgeUi({ url: app.url }), llm: null });

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
    }, { forge, llm: llama });

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

/** A Strata that records the order it was called in. */
function fakeStrata(
  calls: string[],
  options: { busy?: boolean; onLoad?: () => void } = {},
) {
  let loaded = true;
  const fetcher = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/health") {
      return Promise.resolve(
        Response.json({ status: "ok", model: "qwen3.8-flash-next", loaded }),
      );
    }
    if (url.pathname === "/unload") {
      calls.push("unload");
      if (options.busy) {
        return Promise.resolve(Response.json({ status: "busy" }, {
          status: 409,
        }));
      }
      loaded = false;
      return Promise.resolve(Response.json({ status: "unloaded" }));
    }
    if (url.pathname === "/load") {
      calls.push("load");
      options.onLoad?.();
      loaded = true;
      return Promise.resolve(Response.json({ status: "loaded" }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return { fetcher, isLoaded: () => loaded };
}

Deno.test("a round takes the GPU from Strata, and labels the work", async () => {
  await withTestApp(async (app) => {
    const calls: string[] = [];
    const { fetcher, isLoaded } = fakeStrata(calls);
    const llm = new Strata({ url: "http://strata", fetch: fetcher });

    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llm });

    assertEquals(result.source, "llm:qwen3.8-flash-next");
    // Lazy: the harness's next completion loads it, not the bridge.
    assertEquals(calls, ["unload"]);
    assertEquals(isLoaded(), false);
    assertEquals(result.counts.done, 1);
  }, { comfy: true });
});

Deno.test("a busy Strata fails the round before anything is submitted", async () => {
  await withTestApp(async (app) => {
    const calls: string[] = [];
    const { fetcher, isLoaded } = fakeStrata(calls, { busy: true });
    const llm = new Strata({
      url: "http://strata",
      busyWaitS: 1,
      fetch: fetcher,
    });

    const error = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llm }).then(
      () => null,
      (cause: Error) => cause,
    );

    assert(error, "the round is refused");
    assertStringIncludes(error.message, "nothing was submitted");
    assertEquals(isLoaded(), true, "the model was left where it was");
    const jobs = await app.json<{ jobs: unknown[] }>("/api/jobs?status=all");
    assertEquals(jobs.jobs.length, 0);
  }, { comfy: true });
});

Deno.test("an LLM server the bridge cannot reach is named, not 'fetch failed'", async () => {
  await withTestApp(async (app) => {
    // What Deno's fetch throws for a host it cannot resolve or connect to:
    // the message alone says nothing, the cause says everything.
    const unreachable = () =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: new Error(
            "error sending request for url (http://llama:8080/running): " +
              "dns error: failed to lookup address information",
          ),
        }),
      );
    const llm = new LlamaSwap({ url: "http://llama:8080", fetch: unreachable });

    const error = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llm }).then(
      () => null,
      (cause: Error) => cause,
    );

    assert(error, "the round is refused");
    assertStringIncludes(error.message, "llama-swap at http://llama:8080");
    assertStringIncludes(error.message, "dns error");
    const jobs = await app.json<{ jobs: unknown[] }>("/api/jobs?status=all");
    assertEquals(jobs.jobs.length, 0, "nothing was submitted");
  }, { comfy: true });
});

Deno.test("an eager Strata loads again only after ComfyUI has let go", async () => {
  await withTestApp(async (app) => {
    const calls: string[] = [];
    let freedAtLoad = -1;
    const { fetcher, isLoaded } = fakeStrata(calls, {
      onLoad: () => freedAtLoad = app.fake!.freed,
    });
    const llm = new Strata({
      url: "http://strata",
      reload: "eager",
      fetch: fetcher,
    });

    await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llm, freeVram: true });

    assertEquals(calls, ["unload", "load"]);
    assertEquals(freedAtLoad, 1, "the load came after free_vram");
    assertEquals(isLoaded(), true);
  }, { comfy: true });
});

Deno.test("a round with no llama-swap still runs, and says it cannot name a model", async () => {
  // The LLM is not on this GPU — a hosted model, or another box. Nothing to
  // evict, and the work is still recorded as having come from a model.
  await withTestApp(async (app) => {
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
    }, { forge: new ForgeUi({ url: app.url }), llm: null });

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
    }, { forge, llm: null }).then(() => null, (cause: Error) => cause);

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
    }, { forge: new ForgeUi({ url: app.url }), llm: null });

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
    }, { forge, llm: null });

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
    }, { forge: new ForgeUi({ url: app.url }), llm: null, freeVram: true });
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

/**
 * The harness gave up on the call — pi's request timeout — while ComfyUI was
 * mid-sample. The harness's next completion reloads the LLM straight away, so
 * the round must stop its jobs and hand the GPU back now, not when its own
 * timeout runs out (DESIGN-AGENT-LOOP §5.3, §10).
 */
Deno.test("a round the client abandons cancels its jobs and hands the GPU back", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-running");
    const calls: string[] = [];
    const { fetcher, isLoaded } = fakeStrata(calls);
    const llm = new Strata({
      url: "http://strata",
      reload: "eager",
      fetch: fetcher,
    });
    const caller = new AbortController();

    const started = Date.now();
    const round = runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 600_000,
    }, {
      forge: new ForgeUi({ url: app.url }),
      llm,
      freeVram: true,
      signal: caller.signal,
    });
    await app.fake!.waitForGate("interrupt");
    caller.abort();
    const result = await round;

    assert(
      Date.now() - started < 15_000,
      `took ${Date.now() - started}ms; the round waited for its own timeout`,
    );
    assertEquals(app.fake!.interruptCount, 1, "ComfyUI was interrupted");
    assertEquals(result.counts.cancelled, 1);
    assertStringIncludes(result.jobs[0]!.error!, "MCP client stopped waiting");
    const row = await app.json<{ status: string }>(
      `/api/jobs/${result.jobs[0]!.job_id}`,
    );
    assertEquals(row.status, "cancelled", "the job really stopped");
    assertEquals(app.fake!.freed, 1, "ComfyUI was asked to unload");
    // Reloaded only after the job had stopped and VRAM was freed.
    assertEquals(calls, ["unload", "load"]);
    assertEquals(isLoaded(), true);
  }, { comfy: true });
});

/** A bridge whose cancel never reaches ComfyUI. */
class DeafCancelForgeUi extends ForgeUi {
  override cancel(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("a cancel that has not landed keeps the LLM off the GPU", async () => {
  // The machine-locking case: ComfyUI is still sampling, and an eager reload
  // would put the LLM into the same memory. Better to leave it to the next
  // completion than to load it on top.
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-running");
    const calls: string[] = [];
    const { fetcher, isLoaded } = fakeStrata(calls);
    const llm = new Strata({
      url: "http://strata",
      reload: "eager",
      fetch: fetcher,
    });
    const caller = new AbortController();

    const round = runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 600_000,
    }, {
      forge: new DeafCancelForgeUi({ url: app.url }),
      llm,
      signal: caller.signal,
      stopTimeoutMs: 500,
    });
    await app.fake!.waitForGate("interrupt");
    caller.abort();
    await round;

    assertEquals(calls, ["unload"], "no load while ComfyUI was busy");
    assertEquals(isLoaded(), false);
    app.fake!.openGate("interrupt");
  }, { comfy: true });
});

Deno.test("a call cancelled before the round begins takes nothing from the LLM", async () => {
  await withTestApp(async (app) => {
    const calls: string[] = [];
    const { fetcher } = fakeStrata(calls);
    const caller = new AbortController();
    caller.abort();
    let refused: unknown = null;
    try {
      await runRound({
        jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
        timeoutMs: 30_000,
      }, {
        forge: new ForgeUi({ url: app.url }),
        llm: new Strata({ url: "http://strata", fetch: fetcher }),
        signal: caller.signal,
      });
    } catch (cause) {
      refused = cause;
    }
    assert(refused instanceof Error);
    assertEquals(calls, []);
    const jobs = await app.json<{ jobs: unknown[] }>("/api/jobs");
    assertEquals(jobs.jobs.length, 0, "nothing was submitted");
  }, { comfy: true });
});

Deno.test("--on-timeout finish lets the jobs end, then says the round overran", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-running");
    const round = runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 200,
      onTimeout: "finish",
    }, { forge: new ForgeUi({ url: app.url }), llm: null, freeVram: true });
    await app.fake!.waitForGate("interrupt");
    // Well past the timeout, and the job is still running.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assertEquals(app.fake!.freed, 0, "the GPU is not handed back mid-job");
    app.fake!.openGate("interrupt");
    const result = await round;

    assertEquals(app.fake!.interruptCount, 0, "nothing was cancelled");
    assertEquals(result.counts.done, 1);
    assert(result.jobs[0]!.outputs.length > 0, "the work is kept");
    assertEquals(result.timed_out?.action, "finished");
    assertEquals(result.timed_out?.timeout_s, 0.2);
    assertStringIncludes(result.timed_out!.message, "left to finish");
    assertEquals(typeof result.jobs[0]!.ran_s, "number");
    assertEquals(typeof result.jobs[0]!.queued_s, "number");
    assertEquals(app.fake!.freed, 1, "and handed back once it ended");
  }, { comfy: true });
});

Deno.test("--on-timeout cancel stops the jobs at the timeout", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-running");
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 500,
      onTimeout: "cancel",
    }, { forge: new ForgeUi({ url: app.url }), llm: null });

    assertEquals(app.fake!.interruptCount, 1);
    assertEquals(result.counts.cancelled, 1);
    assertEquals(result.timed_out?.action, "cancelled");
    assertEquals(typeof result.jobs[0]!.ran_s, "number");
  }, { comfy: true });
});

Deno.test("a round inside its timeout says nothing about one", async () => {
  await withTestApp(async (app) => {
    const result = await runRound({
      jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
      timeoutMs: 30_000,
      onTimeout: "finish",
    }, { forge: new ForgeUi({ url: app.url }), llm: null });
    assertEquals(result.timed_out, undefined);
    assertEquals(result.counts.done, 1);
  }, { comfy: true });
});
