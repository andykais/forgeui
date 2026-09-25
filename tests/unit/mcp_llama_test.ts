import { assertEquals, assertRejects } from "@std/assert";
import { LlamaSwap, parseRunning, sourceFor } from "../../src/mcp/llama.ts";

/**
 * `GET /running` has no documented response shape (DESIGN-AGENT-LOOP §8), so
 * the reader takes the shapes it could plausibly return and never throws —
 * a label is not worth failing a round over.
 */
Deno.test("the running list is read out of whichever shape it arrives in", () => {
  assertEquals(parseRunning(["qwen-vlm"]), ["qwen-vlm"]);
  assertEquals(parseRunning([{ model: "qwen-vlm" }]), ["qwen-vlm"]);
  assertEquals(parseRunning({ running: [{ model: "qwen-vlm" }] }), [
    "qwen-vlm",
  ]);
  assertEquals(parseRunning({ running: ["qwen-vlm"] }), ["qwen-vlm"]);
  assertEquals(parseRunning({ models: [{ id: "qwen-vlm" }] }), ["qwen-vlm"]);
  assertEquals(parseRunning({ data: [{ name: "qwen-vlm" }] }), ["qwen-vlm"]);
});

Deno.test("a model on its way out is not what a generation is attributed to", () => {
  assertEquals(parseRunning([{ model: "qwen-vlm", state: "stopping" }]), []);
  assertEquals(parseRunning([{ model: "qwen-vlm", status: "ready" }]), [
    "qwen-vlm",
  ]);
});

Deno.test("nothing readable is no models, never an exception", () => {
  for (const body of [null, undefined, 42, "text", {}, { running: "no" }]) {
    assertEquals(parseRunning(body), []);
  }
});

Deno.test("source names the model, and says so when it cannot", () => {
  assertEquals(sourceFor("qwen-vlm"), "llm:qwen-vlm");
  assertEquals(sourceFor(null), "llm:unknown");
});

/** A llama-swap that answers `/running` from a script of replies. */
function fakeSwap(replies: unknown[], seen: string[] = []) {
  let at = 0;
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/running") {
      const body = replies[Math.min(at++, replies.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  return { fetcher, seen };
}

Deno.test("unload waits for the GPU to actually come free", async () => {
  // The POST returning is not the VRAM being back: llama-swap stops the child
  // in its own time, and submitting into that gap is the OOM this guards.
  const { fetcher, seen } = fakeSwap([
    [{ model: "qwen-vlm" }],
    [{ model: "qwen-vlm" }],
    [],
  ]);
  const swap = new LlamaSwap({ url: "http://swap", fetch: fetcher });
  const { was } = await swap.unload();
  assertEquals(was, "qwen-vlm");
  assertEquals(seen.includes("POST /api/models/unload"), true);
  // Polled until empty rather than trusting the POST.
  assertEquals(
    seen.filter((call) => call === "GET /running").length >= 3,
    true,
  );
});

Deno.test("a model that will not let go fails loudly rather than submitting", async () => {
  const { fetcher } = fakeSwap([[{ model: "qwen-vlm" }]]);
  const swap = new LlamaSwap({
    url: "http://swap",
    fetch: fetcher,
    unloadTimeoutMs: 300,
  });
  await assertRejects(
    () => swap.unload(),
    Error,
    "refusing to submit into an OOM",
  );
});

Deno.test("the configured model wins, so a cold start is still labelled", async () => {
  // Nothing is running — which is the normal case between rounds — and the
  // round must still record what it was generated on behalf of.
  const { fetcher } = fakeSwap([[]]);
  const swap = new LlamaSwap({
    url: "http://swap",
    model: "qwen-vlm",
    fetch: fetcher,
  });
  assertEquals(await swap.currentModel(), "qwen-vlm");
});

Deno.test("with no configured model, the last one seen is remembered", async () => {
  const { fetcher } = fakeSwap([[{ model: "qwen-vlm" }], []]);
  const swap = new LlamaSwap({ url: "http://swap", fetch: fetcher });
  assertEquals(await swap.currentModel(), "qwen-vlm");
  // Now nothing is running, but the round it is about to label is that model's.
  assertEquals(await swap.currentModel(), "qwen-vlm");
});
