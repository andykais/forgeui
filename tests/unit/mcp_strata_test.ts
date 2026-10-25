import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { parseHealth, Strata } from "../../src/mcp/strata.ts";

/**
 * Strata's side of the handoff (DESIGN-LLM-BACKENDS §2), against a scripted
 * fake. The rule is the one llama-swap's client keeps: a release returns only
 * once the GPU is confirmed free, and anything else submits nothing.
 */

interface Call {
  method: string;
  path: string;
  authorization: string | null;
}

interface FakeStrata {
  /** What `/unload` answers; `loaded` goes false on a 200. */
  unload?: () => Response;
  /** What `/load` answers. */
  load?: () => Response | Promise<Response>;
  /** How many `/health` reads still say `loaded: true` after an unload. */
  lingers?: number;
  /** `/health`'s `model`. */
  model?: string;
  /** Leave `loaded` out of `/health` altogether. */
  noLoadedField?: boolean;
}

function fakeStrata(script: FakeStrata = {}) {
  const calls: Call[] = [];
  let loaded = true;
  let lingers = script.lingers ?? 0;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.pathname === "/health") {
      const reportLoaded = loaded || lingers-- > 0;
      return Response.json({
        status: "ok",
        model: script.model ?? "qwen3.8-flash-next",
        ...(script.noLoadedField ? {} : { loaded: reportLoaded }),
      });
    }
    if (url.pathname === "/unload") {
      const response = script.unload?.() ??
        Response.json({ status: "unloaded" });
      const body = await response.clone().json().catch(() => null);
      if (response.ok && body?.status !== "busy") loaded = false;
      return response;
    }
    if (url.pathname === "/load") {
      const response = await (script.load?.() ??
        Response.json({ status: "loaded" }));
      if (response.ok) loaded = true;
      return response;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, isLoaded: () => loaded };
}

Deno.test("health is read without insisting on the rest of its shape", () => {
  assertEquals(parseHealth({ status: "ok", model: "q", loaded: true }), {
    model: "q",
    loaded: true,
  });
  assertEquals(parseHealth({ status: "ok" }), { model: null, loaded: null });
  for (const body of [null, 42, "ok", [], { model: "", loaded: "yes" }]) {
    assertEquals(parseHealth(body), { model: null, loaded: null });
  }
});

Deno.test("release unloads, then confirms the engine is gone", async () => {
  const { fetcher, calls, isLoaded } = fakeStrata({ lingers: 2 });
  const strata = new Strata({ url: "http://strata/", fetch: fetcher });
  const { was } = await strata.release();

  assertEquals(was, "qwen3.8-flash-next");
  assertEquals(isLoaded(), false);
  assert(calls.some((call) => call.path === "/unload?wait=30"));
  // Polled past the two reads that still said loaded, not trusting the POST.
  const healthAfter = calls.slice(
    calls.findIndex((call) => call.path.startsWith("/unload")),
  ).filter((call) => call.path === "/health");
  assertEquals(healthAfter.length, 3);
});

Deno.test("an unload of a model that was not loaded is still a release", async () => {
  const { fetcher } = fakeStrata({
    unload: () => Response.json({ status: "not loaded" }),
  });
  const strata = new Strata({ url: "http://strata", fetch: fetcher });
  await strata.release();
});

Deno.test("an unload that answers with no body is read by its status", async () => {
  const { fetcher } = fakeStrata({ unload: () => new Response(null) });
  const strata = new Strata({ url: "http://strata", fetch: fetcher });
  await strata.release();
});

Deno.test("a busy Strata refuses the round instead of waiting forever", async () => {
  for (
    const unload of [
      () => Response.json({ status: "busy" }, { status: 409 }),
      () => Response.json({ status: "busy" }),
    ]
  ) {
    const { fetcher, isLoaded } = fakeStrata({ unload });
    const strata = new Strata({
      url: "http://strata",
      busyWaitS: 5,
      fetch: fetcher,
    });
    await assertRejects(
      () => strata.release(),
      Error,
      "still answering another request after 5s; nothing was submitted",
    );
    assertEquals(isLoaded(), true);
  }
});

Deno.test("a busy wait of zero asks for an unload that does not wait", async () => {
  const { fetcher, calls } = fakeStrata();
  const strata = new Strata({
    url: "http://strata",
    busyWaitS: 0,
    fetch: fetcher,
  });
  await strata.release();
  assert(calls.some((call) => call.path === "/unload"));
});

Deno.test("a 401 says a key is wanted", async () => {
  const { fetcher } = fakeStrata({
    unload: () => new Response("unauthorized", { status: 401 }),
  });
  const strata = new Strata({ url: "http://strata", fetch: fetcher });
  const error = await assertRejects(() => strata.release(), Error);
  assertStringIncludes(error.message, "wants an API key");
  assertStringIncludes(error.message, "--llm-api-key is not set");
});

Deno.test("any other failure names the status and submits nothing", async () => {
  const { fetcher } = fakeStrata({
    unload: () => Response.json({ error: "engine crashed" }, { status: 500 }),
  });
  const strata = new Strata({ url: "http://strata", fetch: fetcher });
  await assertRejects(
    () => strata.release(),
    Error,
    "500 engine crashed",
  );
});

Deno.test("a model that will not let go fails loudly rather than submitting", async () => {
  const { fetcher } = fakeStrata({ lingers: 1_000 });
  const strata = new Strata({
    url: "http://strata",
    unloadTimeoutMs: 300,
    fetch: fetcher,
  });
  await assertRejects(
    () => strata.release(),
    Error,
    "refusing to submit into an OOM",
  );
});

Deno.test("a Strata that does not report loaded is taken at its 200", async () => {
  const { fetcher } = fakeStrata({ noLoadedField: true });
  const strata = new Strata({
    url: "http://strata",
    unloadTimeoutMs: 300,
    fetch: fetcher,
  });
  await strata.release();
});

Deno.test("no key, no Authorization header; a key, on every call", async () => {
  const open = fakeStrata();
  await new Strata({ url: "http://strata", fetch: open.fetcher }).release();
  assert(open.calls.length > 0);
  assert(open.calls.every((call) => call.authorization === null));

  const keyed = fakeStrata();
  await new Strata({
    url: "http://strata",
    apiKey: "sekrit",
    reload: "eager",
    fetch: keyed.fetcher,
  }).release().then(() => undefined);
  assert(keyed.calls.length > 0);
  assert(
    keyed.calls.every((call) => call.authorization === "Bearer sekrit"),
  );
});

Deno.test("the label comes from --llm-model, then /health, then the last seen", async () => {
  const { fetcher } = fakeStrata({ model: "from-health" });
  assertEquals(
    await new Strata({ url: "http://s", model: "mine", fetch: fetcher })
      .currentModel(),
    "mine",
  );
  assertEquals(
    await new Strata({ url: "http://s", fetch: fetcher }).currentModel(),
    "from-health",
  );

  // Seen once, then the server goes away: the round is still that model's.
  let up = true;
  const flaky =
    ((input: string | URL | Request, init?: RequestInit) =>
      up
        ? fetcher(input, init)
        : Promise.reject(new Error("refused"))) as typeof fetch;
  const strata = new Strata({ url: "http://s", fetch: flaky });
  assertEquals(await strata.currentModel(), "from-health");
  up = false;
  assertEquals(await strata.currentModel(), "from-health");
});

Deno.test("resident is the model while loaded, nothing once unloaded", async () => {
  const { fetcher } = fakeStrata();
  const strata = new Strata({ url: "http://strata", fetch: fetcher });
  assertEquals(await strata.resident(), ["qwen3.8-flash-next"]);
  await strata.release();
  assertEquals(await strata.resident(), []);
});

Deno.test("lazy restore leaves loading to the next completion", async () => {
  const { fetcher, calls } = fakeStrata();
  const strata = new Strata({ url: "http://strata", fetch: fetcher });
  await strata.release();
  await strata.restore();
  assert(!calls.some((call) => call.path === "/load"));
});

Deno.test("eager restore loads, and a failed load is logged, never thrown", async () => {
  const ok = fakeStrata();
  const eager = new Strata({
    url: "http://strata",
    reload: "eager",
    fetch: ok.fetcher,
  });
  await eager.release();
  await eager.restore();
  assertEquals(ok.isLoaded(), true);
  assertEquals(ok.calls.at(-1)?.method, "POST");
  assertEquals(ok.calls.at(-1)?.path, "/load");

  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const broken = fakeStrata({
      load: () => new Response("no room", { status: 503 }),
    });
    await new Strata({
      url: "http://strata",
      reload: "eager",
      fetch: broken.fetcher,
    }).restore();

    // A load slower than the timeout is abandoned, not waited on forever.
    const slow = fakeStrata({
      load: () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json({})), 2_000)
        ),
    });
    const started = Date.now();
    await new Strata({
      url: "http://strata",
      reload: "eager",
      loadTimeoutMs: 100,
      fetch: (input, init) =>
        Promise.race([
          slow.fetcher(input, init),
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal!.reason))
          ),
        ]),
    }).restore();
    assert(Date.now() - started < 1_500, "the load timeout was not honoured");
  } finally {
    console.error = original;
  }
  assertEquals(errors.length, 2);
  assertStringIncludes(String(errors[0]), "503");
});
