import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { readPngSize, readTextChunks } from "../../src/jobs/png.ts";
import { TestSocket } from "../fake-comfy/client.ts";
import { type FakeComfy, startFakeComfy } from "../fake-comfy/server.ts";
import type { FakeComfyOptions, HistoryEntry } from "../fake-comfy/server.ts";
import { simpleImageGraph } from "../fixtures/graphs.ts";
import { tinyPng } from "../fixtures/png.ts";
import type { ApiGraph } from "../fake-comfy/graph.ts";

interface Harness {
  fake: FakeComfy;
  staging: string;
  inputs: string;
  /** Submit a prompt and return ComfyUI's answer. */
  submit(graph: ApiGraph): Promise<{ prompt_id: string; number: number }>;
  submitRaw(body: unknown): Promise<Response>;
  ws(): Promise<TestSocket>;
  files(jobId: string): Promise<string[]>;
  history(): Promise<Record<string, HistoryEntry>>;
}

async function withFake(
  body: (h: Harness) => Promise<void>,
  options: Partial<FakeComfyOptions> = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-fake-" });
  const staging = join(dir, "staging");
  const inputs = join(dir, "comfy-input");
  const fake = await startFakeComfy({
    stagingDir: staging,
    inputDir: inputs,
    ...options,
  });
  const sockets: TestSocket[] = [];
  try {
    await body({
      fake,
      staging,
      inputs,
      async submit(graph: ApiGraph) {
        const response = await fetch(`${fake.url}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: graph, client_id: "test-client" }),
        });
        assertEquals(response.status, 200, await response.clone().text());
        return await response.json();
      },
      submitRaw: (payload: unknown) =>
        fetch(`${fake.url}/prompt`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      async ws() {
        const socket = await TestSocket.connect(
          `${fake.url.replace("http", "ws")}/ws?clientId=test-client`,
        );
        sockets.push(socket);
        return socket;
      },
      async files(jobId: string) {
        const names: string[] = [];
        try {
          for await (const entry of Deno.readDir(join(staging, jobId))) {
            names.push(entry.name);
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        return names.sort();
      },
      history: async () =>
        await (await fetch(`${fake.url}/history`)).json() as Record<
          string,
          HistoryEntry
        >,
    });
    assertEquals(fake.errors, []);
  } finally {
    for (const socket of sockets) socket.close();
    await fake.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a graph that is not core ComfyUI is rejected before queueing", async () => {
  await withFake(async (h) => {
    const graph = simpleImageGraph({ jobId: "01JBAD" });
    graph["4"] = {
      class_type: "SuperCustomSampler",
      inputs: { model: ["1", 0] },
    };
    const response = await h.submitRaw({ prompt: graph, client_id: "c" });
    assertEquals(response.status, 400);
    const body = await response.json() as {
      error: { message: string };
      node_errors: Record<
        string,
        { class_type: string; errors: { message: string }[] }
      >;
    };
    assertEquals(body.error.message, "Prompt has invalid nodes");
    assertEquals(body.node_errors["4"]?.class_type, "SuperCustomSampler");
    assertStringIncludes(
      body.node_errors["4"]!.errors[0]!.message,
      "not a core ComfyUI node",
    );
    assertEquals(h.fake.prompts.length, 0);
  });
});

Deno.test("graph shape problems are reported per node", async () => {
  await withFake(async (h) => {
    const rejection = async (graph: unknown) => {
      const response = await h.submitRaw({ prompt: graph });
      assertEquals(response.status, 400);
      return await response.json() as {
        error: { message: string };
        node_errors: Record<string, { errors: { message: string }[] }>;
      };
    };

    const missingPrefix = simpleImageGraph({ jobId: "01JX" });
    delete missingPrefix["9"]!.inputs.filename_prefix;
    assertStringIncludes(
      (await rejection(missingPrefix)).node_errors["9"]!.errors[0]!.message,
      "needs a string filename_prefix",
    );

    const brokenLink = simpleImageGraph({ jobId: "01JX" });
    brokenLink["8"]!.inputs.samples = ["42", 0];
    assertStringIncludes(
      (await rejection(brokenLink)).node_errors["8"]!.errors[0]!.message,
      'links to unknown node "42"',
    );

    const badLink = simpleImageGraph({ jobId: "01JX" });
    badLink["8"]!.inputs.samples = ["3", "0"];
    assertStringIncludes(
      (await rejection(badLink)).node_errors["8"]!.errors[0]!.message,
      "is not a [node_id, slot] link",
    );

    const noOutput = simpleImageGraph({ jobId: "01JX" });
    delete noOutput["9"];
    assertEquals(
      (await rejection(noOutput)).error.message,
      "Prompt has no output node",
    );

    assertEquals((await rejection({})).error.message, "prompt is empty");
    assertEquals(
      (await rejection("not a graph")).error.message,
      "prompt must be an object of nodes",
    );
  });
});

Deno.test("scenario: success", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    const jobId = "01JSUCCESS";
    const { prompt_id } = await h.submit(
      simpleImageGraph({ jobId, width: 128, height: 96 }),
    );
    await socket.waitFor("execution_success");
    assertEquals(await h.fake.waitForPrompt(prompt_id), "done");

    // The event stream a client sees, in order.
    assertEquals(
      socket.jsonTypes.filter((type) => type !== "status"),
      [
        "execution_start",
        "execution_cached",
        "executing",
        "progress",
        "progress",
        "executing",
        "executed",
        "executing",
        "execution_success",
      ],
    );
    assertEquals(socket.json("executing").at(-1)?.data.node, null);

    // Binary preview frames arrive as ComfyUI sends them.
    const previews = socket.binary();
    assertEquals(previews.length, 1);
    assertEquals(previews[0]!.event, 1);
    assertEquals(previews[0]!.format, 2);
    assertEquals(readPngSize(previews[0]!.bytes), { width: 32, height: 32 });

    // One file, written where SaveImage would have written it.
    assertEquals(await h.files(jobId), ["out_00001_.png"]);
    const bytes = await Deno.readFile(join(h.staging, jobId, "out_00001_.png"));
    assertEquals(readPngSize(bytes), { width: 128, height: 96 });
    assertStringIncludes(readTextChunks(bytes).prompt ?? "", "SaveImage");

    // History reports the same files, and the queue has drained.
    const entry = (await h.history())[prompt_id]!;
    assertEquals(entry.status.status_str, "success");
    assertEquals(entry.status.completed, true);
    assertEquals(entry.outputs["9"]?.images, [{
      filename: "out_00001_.png",
      subfolder: jobId,
      type: "output",
    }]);
    const queue = await (await fetch(`${h.fake.url}/queue`)).json();
    assertEquals(queue.queue_running, []);
    assertEquals(queue.queue_pending, []);

    // And /view serves the bytes back.
    const view = await fetch(
      `${h.fake.url}/view?filename=out_00001_.png&subfolder=${jobId}&type=output`,
    );
    assertEquals(view.headers.get("content-type"), "image/png");
    assertEquals(new Uint8Array(await view.arrayBuffer()), bytes);
  });
});

Deno.test("scenario: multi-output", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    h.fake.setScenario("multi-output");
    const jobId = "01JMULTI";
    const { prompt_id } = await h.submit(
      simpleImageGraph({ jobId, saveNodes: 2 }),
    );
    await socket.waitFor("execution_success");

    assertEquals(await h.files(jobId), [
      "out-1_00001_.png",
      "out_00001_.png",
      "out_00002_.png",
    ]);
    const entry = (await h.history())[prompt_id]!;
    assertEquals(entry.outputs["9"]?.images.length, 2);
    assertEquals(entry.outputs["10"]?.images.length, 1);
  });
});

Deno.test("scenario: multi-output skips steps a graph has no node for", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    h.fake.setScenario("multi-output");
    const jobId = "01JONESAVE";
    const { prompt_id } = await h.submit(simpleImageGraph({ jobId }));
    await socket.waitFor("execution_success");

    assertEquals(await h.files(jobId), ["out_00001_.png", "out_00002_.png"]);
    assertEquals(Object.keys((await h.history())[prompt_id]!.outputs), ["9"]);
  });
});

Deno.test("scenario: error mid-graph", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    h.fake.setScenario("error-mid-graph");
    const jobId = "01JERROR";
    const { prompt_id } = await h.submit(simpleImageGraph({ jobId }));
    const event = await socket.waitFor("execution_error");
    assertEquals(await h.fake.waitForPrompt(prompt_id), "error");

    assert(event.kind === "json");
    assertEquals(event.data.node_id, "3");
    assertEquals(event.data.node_type, "KSampler");
    assertEquals(event.data.exception_type, "torch.OutOfMemoryError");
    assertStringIncludes(
      String(event.data.exception_message),
      "would exceed allowed memory",
    );
    assert(!socket.jsonTypes.includes("execution_success"));

    assertEquals(await h.files(jobId), []);
    const entry = (await h.history())[prompt_id]!;
    assertEquals(entry.status.status_str, "error");
    assertEquals(entry.status.completed, false);
    assertEquals(entry.outputs, {});
  });
});

Deno.test("scenario: cancel while queued", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    h.fake.setScenario("cancel-while-queued");
    const jobId = "01JQUEUED";
    const { prompt_id } = await h.submit(simpleImageGraph({ jobId }));

    const queued = await (await fetch(`${h.fake.url}/queue`)).json();
    assertEquals(queued.queue_pending.length, 1);
    assertEquals(queued.queue_pending[0][1], prompt_id);
    assertEquals(queued.queue_running, []);

    const deleted = await fetch(`${h.fake.url}/queue`, {
      method: "POST",
      body: JSON.stringify({ delete: [prompt_id] }),
    });
    assertEquals(deleted.status, 200);
    assertEquals(await h.fake.waitForPrompt(prompt_id), "deleted");

    // It never ran: no graph events, no files, no history entry.
    assertEquals(socket.jsonTypes.filter((type) => type !== "status"), []);
    assertEquals(await h.files(jobId), []);
    assertEquals(await h.history(), {});
    const after = await (await fetch(`${h.fake.url}/queue`)).json();
    assertEquals(after.queue_pending, []);
  });
});

Deno.test("clearing the queue cancels every pending prompt", async () => {
  await withFake(async (h) => {
    h.fake.setScenario("cancel-while-queued");
    const first = await h.submit(simpleImageGraph({ jobId: "01JC1" }));
    const second = await h.submit(simpleImageGraph({ jobId: "01JC2" }));

    await fetch(`${h.fake.url}/queue`, {
      method: "POST",
      body: JSON.stringify({ clear: true }),
    });
    assertEquals(await h.fake.waitForPrompt(first.prompt_id), "deleted");
    assertEquals(await h.fake.waitForPrompt(second.prompt_id), "deleted");
    assertEquals(await h.history(), {});
  });
});

Deno.test("scenario: cancel while running", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    h.fake.setScenario("cancel-while-running");
    const jobId = "01JRUNNING";
    const { prompt_id } = await h.submit(simpleImageGraph({ jobId }));

    await socket.waitFor("progress");
    await h.fake.waitForGate("interrupt");
    const running = await (await fetch(`${h.fake.url}/queue`)).json();
    assertEquals(running.queue_running.length, 1);

    const interrupted = await fetch(`${h.fake.url}/interrupt`, {
      method: "POST",
    });
    assertEquals(interrupted.status, 200);
    assertEquals(h.fake.interruptCount, 1);
    assertEquals(await h.fake.waitForPrompt(prompt_id), "interrupted");

    const event = await socket.waitFor("execution_interrupted");
    assert(event.kind === "json");
    assertEquals(event.data.node_id, "3");
    assertEquals(event.data.node_type, "KSampler");
    assert(!socket.jsonTypes.includes("execution_success"));
    assertEquals(await h.files(jobId), []);

    const entry = (await h.history())[prompt_id]!;
    assertEquals(entry.status.status_str, "error");
    assertEquals(entry.status.completed, false);
    assertEquals(
      entry.status.messages.map(([type]) => type).at(-1),
      "execution_interrupted",
    );
  });
});

Deno.test("scenario: websocket disconnect and reconnect mid-job", async () => {
  await withFake(async (h) => {
    const first = await h.ws();
    h.fake.setScenario("ws-reconnect");
    const jobId = "01JRECONNECT";
    const { prompt_id } = await h.submit(simpleImageGraph({ jobId }));

    await first.waitFor("progress");
    await h.fake.waitForGate("reconnected");
    // The fake dropped the socket, as ComfyUI would on a restart.
    assertEquals(first.closes.length, 1);
    assertEquals(h.fake.socketCount, 0);
    assert(!first.jsonTypes.includes("execution_success"));

    const second = await h.ws();
    h.fake.openGate("reconnected");
    await second.waitFor("execution_success");
    assertEquals(await h.fake.waitForPrompt(prompt_id), "done");

    // The reconnected client sees the rest of the job...
    assertEquals(
      second.jsonTypes.filter((type) => type !== "status"),
      ["progress", "executing", "executed", "executing", "execution_success"],
    );
    // ...and the missed events are still recoverable from /history.
    const entry = (await h.history())[prompt_id]!;
    assertEquals(entry.status.status_str, "success");
    assertEquals(
      entry.status.messages.map(([type]) => type),
      [
        "execution_start",
        "executing",
        "progress",
        "progress",
        "executing",
        "executed",
        "executing",
        "execution_success",
      ],
    );
    assertEquals(await h.files(jobId), ["out_00001_.png"]);
  });
});

Deno.test("scenario: ComfyUI dies before the output is executed", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    h.fake.setScenario("death-before-executed");
    const jobId = "01JDEAD";
    const { prompt_id } = await h.submit(simpleImageGraph({ jobId }));

    assertEquals(await h.fake.waitForPrompt(prompt_id), "dead");
    assertEquals(socket.closes.length, 1);
    assertEquals(h.fake.socketCount, 0);

    // No completion event, no history entry, no files: the app has to notice
    // on restart and fail the job (§M2 startup sweep).
    assert(!socket.jsonTypes.includes("execution_success"));
    assert(!socket.jsonTypes.includes("execution_error"));
    assertEquals(await h.history(), {});
    assertEquals(await h.files(jobId), []);
    const queue = await (await fetch(`${h.fake.url}/queue`)).json();
    assertEquals(queue.queue_running, []);
  });
});

Deno.test("prompts run one at a time, in submission order", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    const first = await h.submit(simpleImageGraph({ jobId: "01JFIRST" }));
    const second = await h.submit(simpleImageGraph({ jobId: "01JSECOND" }));
    await h.fake.settled();

    assertEquals(await h.files("01JFIRST"), ["out_00001_.png"]);
    assertEquals(await h.files("01JSECOND"), ["out_00001_.png"]);
    const starts = socket
      .json("execution_start")
      .map((message) => message.data.prompt_id);
    assertEquals(starts, [first.prompt_id, second.prompt_id]);
    assertEquals(h.fake.prompts.map((p) => p.number), [1, 2]);
  });
});

Deno.test("one-shot scenarios apply to the next prompt only", async () => {
  await withFake(async (h) => {
    h.fake.queueScenario("error-mid-graph");
    const failing = await h.submit(simpleImageGraph({ jobId: "01JONE" }));
    const succeeding = await h.submit(simpleImageGraph({ jobId: "01JTWO" }));
    await h.fake.settled();

    assertEquals(await h.fake.waitForPrompt(failing.prompt_id), "error");
    assertEquals(await h.fake.waitForPrompt(succeeding.prompt_id), "done");
    assertEquals(
      h.fake.prompts.map((prompt) => prompt.scenario),
      ["error-mid-graph", "success"],
    );
  });
});

Deno.test("uploads land in the input directory and come back from /view", async () => {
  await withFake(async (h) => {
    const png = tinyPng({ width: 16, height: 8 });
    const upload = async (name: string, overwrite: boolean) => {
      const form = new FormData();
      form.set(
        "image",
        new File([png.buffer as ArrayBuffer], name, { type: "image/png" }),
      );
      form.set("overwrite", String(overwrite));
      form.set("type", "input");
      const response = await fetch(`${h.fake.url}/upload/image`, {
        method: "POST",
        body: form,
      });
      assertEquals(response.status, 200);
      return await response.json() as {
        name: string;
        subfolder: string;
        type: string;
      };
    };

    const first = await upload("abc123.png", true);
    assertEquals(first, { name: "abc123.png", subfolder: "", type: "input" });
    // Content-addressed uploads overwrite by design (§9 step 3).
    const again = await upload("abc123.png", true);
    assertEquals(again.name, "abc123.png");
    // Without overwrite, ComfyUI renames instead of clobbering.
    const renamed = await upload("abc123.png", false);
    assertEquals(renamed.name, "abc123 (1).png");

    assertEquals(h.fake.uploads.length, 3);
    assertEquals(h.fake.uploads[0]!.size, png.length);

    const view = await fetch(
      `${h.fake.url}/view?filename=abc123.png&type=input`,
    );
    assertEquals(new Uint8Array(await view.arrayBuffer()), png);
    const missing = await fetch(`${h.fake.url}/view?filename=nope.png`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  });
});

Deno.test("system stats report a device the app can show", async () => {
  await withFake(async (h) => {
    const stats = await (await fetch(`${h.fake.url}/system_stats`)).json();
    assertEquals(typeof stats.system.comfyui_version, "string");
    assertEquals(stats.devices.length, 1);
    assert(stats.devices[0].vram_free > 0);
    assert(stats.devices[0].vram_free <= stats.devices[0].vram_total);
  });
});

Deno.test("a websocket client is greeted with the queue state", async () => {
  await withFake(async (h) => {
    const socket = await h.ws();
    const status = await socket.waitFor("status");
    assert(status.kind === "json");
    assertEquals(status.data.sid, "test-client");
    assertEquals(
      (status.data.status as { exec_info: { queue_remaining: number } })
        .exec_info.queue_remaining,
      0,
    );
  });
});

Deno.test("image size follows the graph unless overridden", async () => {
  await withFake(async (h) => {
    const jobId = "01JSIZE";
    await h.submit(simpleImageGraph({ jobId, width: 512, height: 768 }));
    await h.fake.settled();
    assertEquals(
      readPngSize(
        await Deno.readFile(join(h.staging, jobId, "out_00001_.png")),
      ),
      { width: 512, height: 768 },
    );
  }, {});

  await withFake(async (h) => {
    const jobId = "01JSIZEFIXED";
    await h.submit(simpleImageGraph({ jobId, width: 512, height: 768 }));
    await h.fake.settled();
    assertEquals(
      readPngSize(
        await Deno.readFile(join(h.staging, jobId, "out_00001_.png")),
      ),
      { width: 8, height: 8 },
    );
  }, { imageSize: { width: 8, height: 8 } });
});
