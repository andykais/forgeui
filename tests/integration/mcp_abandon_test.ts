import { assertEquals, assertStringIncludes } from "@std/assert";
import { withTestApp } from "../fixtures/app.ts";
import { ForgeUi } from "../../src/mcp/forgeui.ts";
import { createBridgeServer } from "../../src/mcp/tools.ts";
import { serveHttp } from "../../src/mcp/serve.ts";

/**
 * pi's MCP request timeout, end to end (DESIGN-AGENT-LOOP §5.3, §10).
 *
 * A harness that stops waiting closes the response stream and sends its next
 * completion, which reloads the LLM. If the round behind the closed stream
 * keeps ComfyUI sampling, the two fill the same memory and the machine locks.
 * So: the real HTTP binding, a client that hangs up mid-sample, and the job
 * must be cancelled long before the round's own timeout.
 */
Deno.test("a client that hangs up on generate cancels the round", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-running");
    const stop = new AbortController();
    const { server, port } = await bridge(
      new ForgeUi({ url: app.url }),
      stop.signal,
    );

    const client = new AbortController();
    const call = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      signal: client.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "generate",
          arguments: {
            jobs: [{ workflow_id: "krea2", params: { prompt: "a heron" } }],
          },
        },
      }),
    }).then((response) => response.text()).catch(() => "aborted");

    await app.fake!.waitForGate("interrupt");
    client.abort(); // the harness's timeout
    assertEquals(await call, "aborted");

    // The round notices, interrupts ComfyUI and hands the GPU back.
    const deadline = Date.now() + 10_000;
    while (app.fake!.freed === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertEquals(app.fake!.interruptCount, 1, "ComfyUI was interrupted");
    assertEquals(app.fake!.freed, 1, "VRAM was freed");
    const { jobs } = await app.json<{ jobs: { status: string }[] }>(
      "/api/jobs",
    );
    assertEquals(jobs.map((job) => job.status), ["cancelled"]);

    stop.abort();
    await server.finished;
  }, { comfy: true });
});

/** Starts the bridge's HTTP binding against `forge`; returns its port. */
async function bridge(forge: ForgeUi, signal: AbortSignal) {
  const listening = Promise.withResolvers<number>();
  const server = serveHttp(() =>
    createBridgeServer({
      forge,
      llm: null,
      freeVram: true,
      progress: false,
      defaultTimeoutMs: 600_000,
    }), {
    hostname: "127.0.0.1",
    port: 0,
    signal,
    onListen: ({ port }) => listening.resolve(port),
  });
  return { server, port: await listening.promise };
}

Deno.test("a client that waits still gets its round", async () => {
  // The other half: whatever aborts a round on a hang-up must not abort one
  // whose client is still listening.
  await withTestApp(async (app) => {
    const stop = new AbortController();
    const { server, port } = await bridge(
      new ForgeUi({ url: app.url }),
      stop.signal,
    );
    const body = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "generate",
          arguments: {
            jobs: [
              { workflow_id: "krea2", params: { prompt: "one" } },
              { workflow_id: "krea2", params: { prompt: "two" } },
            ],
          },
        },
      }),
    }).then((response) => response.text());
    assertStringIncludes(body, '\\"done\\": 2');
    assertEquals(app.fake!.interruptCount, 0);
    stop.abort();
    await server.finished;
  }, { comfy: true });
});
