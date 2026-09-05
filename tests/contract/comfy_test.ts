import { assert, assertEquals, assertMatch } from "@std/assert";
import { delay } from "@std/async/delay";
import { join } from "@std/path";
import { ulid } from "@std/ulid";
import { ComfyClient, ComfyHttpError } from "../../src/comfy/client.ts";
import {
  decodeComfyMessage,
  decodePreviewFrame,
} from "../../src/comfy/events.ts";
import {
  PNG_SIGNATURE,
  readPngSize,
  readTextChunks,
  SIDECAR_KEYWORD,
  withTextChunk,
} from "../../src/jobs/png.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";
import { TestSocket, type WsJsonMessage } from "../fake-comfy/client.ts";
import { tinyPng } from "../fixtures/png.ts";

/**
 * The contract check of §14.1, and the only test in this repository that
 * talks to a real ComfyUI. It asserts exactly the assumptions
 * `tests/fake-comfy/` is built on, one test per assumption, so a failure
 * names the thing the fake got wrong. **A failure is fixed in the fake, not
 * papered over in the app.**
 *
 * Opt in with the environment, or run `deno task test:comfy`:
 *
 * ```sh
 * FORGEUI_COMFY_URL=http://127.0.0.1:8188 deno task test:comfy
 * ```
 *
 * | Variable | Effect |
 * |---|---|
 * | `FORGEUI_COMFY_URL` | required; without it every test here is ignored |
 * | `FORGEUI_COMFY_OUTPUT_DIR` | ComfyUI's `--output-directory`: checks files on disk and cleans up after |
 * | `FORGEUI_COMFY_INPUT_DIR` | ComfyUI's `--input-directory`: removes the uploaded fixture afterwards |
 * | `FORGEUI_COMFY_CKPT` | a checkpoint filename; enables the two tests that need a sampler |
 *
 * The graphs need no model: `EmptyImage` → `SaveImage`. Only the sampler
 * tests — `progress` events and binary preview frames, which nothing without
 * a sampler emits — need `FORGEUI_COMFY_CKPT`, and they expect ComfyUI to
 * have been started with `--preview-method auto`.
 *
 * See `docs/HARDWARE-CHECKLIST.md` for the manual half of the check.
 */

const COMFY_URL = Deno.env.get("FORGEUI_COMFY_URL");
const OUTPUT_DIR = Deno.env.get("FORGEUI_COMFY_OUTPUT_DIR");
const INPUT_DIR = Deno.env.get("FORGEUI_COMFY_INPUT_DIR");
const CHECKPOINT = Deno.env.get("FORGEUI_COMFY_CKPT");

/** How long a model-free graph may take, end to end. */
const TRIVIAL_TIMEOUT_MS = 30_000;
/** How long a four-step sample may take on a cold model. */
const SAMPLER_TIMEOUT_MS = 300_000;
/** Steps the sampler tests ask for; `progress` is asserted against it. */
const SAMPLER_STEPS = 4;

const IMAGE_NODE = "1";
const SAVE_NODE = "2";
/** Where the deliberately escaping `filename_prefix` points. */
const ESCAPE_DIR = "forgeui-contract-escape";

interface ContractTestOptions {
  /** Needs a real checkpoint, so it is skipped unless one was named. */
  sampler?: boolean;
}

function contractTest(
  name: string,
  fn: () => Promise<void>,
  options: ContractTestOptions = {},
): void {
  Deno.test({
    name,
    ignore: COMFY_URL === undefined ||
      (options.sampler === true && CHECKPOINT === undefined),
    fn,
  });
}

interface Harness {
  client: ComfyClient;
  socket: TestSocket;
  /** A job id in the app's own shape, cleaned out of the output dir after. */
  newJobId(): string;
}

async function withComfy(body: (h: Harness) => Promise<void>): Promise<void> {
  const client = new ComfyClient({
    url: COMFY_URL!,
    clientId: `forgeui-contract-${crypto.randomUUID()}`,
  });
  const socket = await TestSocket.connect(client.wsUrl);
  const jobIds: string[] = [];
  try {
    await body({
      client,
      socket,
      newJobId() {
        const id = ulid();
        jobIds.push(id);
        return id;
      },
    });
  } finally {
    await closeSocket(socket);
    if (OUTPUT_DIR) {
      for (const id of jobIds) {
        await Deno.remove(join(OUTPUT_DIR, id), { recursive: true }).catch(
          () => {},
        );
      }
    }
  }
}

async function closeSocket(socket: TestSocket): Promise<void> {
  socket.close();
  for (let i = 0; i < 100 && socket.readyState !== WebSocket.CLOSED; i++) {
    await delay(20);
  }
}

/** `EmptyImage` → `SaveImage`: a prompt that needs no model of any kind. */
function emptyImageGraph(options: {
  jobId: string;
  width?: number;
  height?: number;
  /** Overrides `<jobid>/out`, for the test that wants `SaveImage` to throw. */
  filenamePrefix?: string;
}): ApiGraph {
  const { jobId, width = 96, height = 64 } = options;
  return {
    [IMAGE_NODE]: {
      class_type: "EmptyImage",
      inputs: { width, height, batch_size: 1, color: 0x6fb6c8 },
    },
    [SAVE_NODE]: {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: options.filenamePrefix ?? `${jobId}/out`,
        images: [IMAGE_NODE, 0],
      },
    },
  };
}

function samplerGraph(options: { jobId: string; seed: number }): ApiGraph {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: CHECKPOINT! },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: options.seed,
        steps: SAMPLER_STEPS,
        cfg: 2,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 256, height: 256, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a contract check", clip: ["1", 1] },
    },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["1", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: `${options.jobId}/out`,
        images: ["8", 0],
      },
    },
  };
}

/** Every JSON event ComfyUI filed under one prompt, in arrival order. */
function eventsFor(socket: TestSocket, promptId: string): WsJsonMessage[] {
  return socket.messages.filter((message): message is WsJsonMessage =>
    message.kind === "json" && message.data.prompt_id === promptId
  );
}

function isTerminal(message: WsJsonMessage, promptId: string): boolean {
  if (message.data.prompt_id !== promptId) return false;
  if (
    message.type === "execution_success" ||
    message.type === "execution_error" ||
    message.type === "execution_interrupted"
  ) {
    return true;
  }
  // How ComfyUI marked the end of a prompt before `execution_success`.
  return message.type === "executing" && message.data.node === null;
}

/**
 * Wait for the prompt to end, then leave a moment for the events that follow
 * the first terminal marker (`execution_success` after `executing: null`).
 */
async function waitForEnd(
  socket: TestSocket,
  promptId: string,
  timeoutMs = TRIVIAL_TIMEOUT_MS,
): Promise<void> {
  await socket.waitFor(
    (message) => message.kind === "json" && isTerminal(message, promptId),
    timeoutMs,
  );
  await delay(500);
}

function decode(message: WsJsonMessage) {
  return decodeComfyMessage(
    JSON.stringify({ type: message.type, data: message.data }),
  );
}

function summary(events: WsJsonMessage[]): string {
  return events.map((event) => event.type).join(", ");
}

contractTest("/prompt honours a client-supplied prompt_id", async () => {
  await withComfy(async (h) => {
    const jobId = h.newJobId();
    const promptId = crypto.randomUUID();
    const response = await fetch(new URL("/prompt", COMFY_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: emptyImageGraph({ jobId }),
        client_id: h.client.clientId,
        prompt_id: promptId,
      }),
    });
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, unknown>;

    // The app records this id on the job row before submitting, so events
    // cannot arrive before it knows whose they are (§5 step 5).
    assertEquals(
      body.prompt_id,
      promptId,
      "ComfyUI answered with a prompt_id of its own; the app copes, the fake does not",
    );
    assertEquals(typeof body.number, "number");
    assertEquals(typeof body.node_errors, "object");

    await waitForEnd(h.socket, promptId);
  });
});

contractTest(
  "the websocket reports a prompt with the fields the app decodes",
  async () => {
    await withComfy(async (h) => {
      const jobId = h.newJobId();
      const promptId = crypto.randomUUID();
      const submitted = await h.client.prompt(
        emptyImageGraph({ jobId }),
        promptId,
      );
      assertEquals(submitted.prompt_id, promptId);
      await waitForEnd(h.socket, promptId);

      const events = eventsFor(h.socket, promptId);
      const types = events.map((event) => event.type);
      const seen = summary(events);
      const first = (type: string) => types.indexOf(type);

      assert(first("execution_start") >= 0, `no execution_start; saw ${seen}`);
      assert(first("executing") >= 0, `no executing; saw ${seen}`);
      assert(first("executed") >= 0, `no executed; saw ${seen}`);
      assert(
        first("execution_start") < first("executing"),
        `execution_start did not come first; saw ${seen}`,
      );
      assert(
        first("executing") < first("executed"),
        `executed arrived before executing; saw ${seen}`,
      );
      assert(
        events.some((event) => isTerminal(event, promptId)),
        `nothing marked the end of the prompt; saw ${seen}`,
      );

      // execution_start: the app switches the job to `running` on it.
      const start = events.find((event) => event.type === "execution_start")!;
      assertEquals(start.data.prompt_id, promptId);
      assertEquals(decode(start)?.type, "execution_start");

      // executing: the node id the app shows as the current step, and the
      // `null` that ends the prompt.
      const executing = events.filter((event) => event.type === "executing");
      assert(
        executing.some((event) => typeof event.data.node === "string"),
        "no executing event named a node",
      );
      for (const event of executing) {
        assert(
          event.data.node === null || typeof event.data.node === "string",
          `executing.node was ${JSON.stringify(event.data.node)}`,
        );
        assertEquals(decode(event)?.type, "executing");
      }
      assertEquals(
        executing.at(-1)?.data.node,
        null,
        "the last executing event did not carry node: null",
      );

      // executed: where the app learns which files a node wrote.
      const executed = events.find((event) => event.type === "executed")!;
      assertEquals(executed.data.node, SAVE_NODE);
      const output = executed.data.output as { images?: unknown[] };
      assert(
        Array.isArray(output?.images),
        "executed.output.images is missing",
      );
      const image = output.images![0] as Record<string, unknown>;
      assertMatch(String(image.filename), /^out_\d+_\.png$/);
      assertEquals(image.subfolder, jobId);
      assertEquals(image.type, "output");
      const decodedExecuted = decode(executed);
      assert(decodedExecuted?.type === "executed");
      assertEquals(decodedExecuted.images.length, 1);
      assertEquals(decodedExecuted.images[0]!.subfolder, jobId);

      // status: the queue depth the app relays to its own clients.
      const status = h.socket.messages.find(
        (message): message is WsJsonMessage =>
          message.kind === "json" && message.type === "status",
      );
      assert(status, "ComfyUI never sent a status event");
      const decodedStatus = decode(status);
      assert(decodedStatus?.type === "status");
      assertEquals(typeof decodedStatus.queue_remaining, "number");
    });
  },
);

contractTest(
  "SaveImage writes filename_prefix <jobid>/out into <output-directory>/<jobid>/",
  async () => {
    await withComfy(async (h) => {
      const jobId = h.newJobId();
      const promptId = crypto.randomUUID();
      await h.client.prompt(
        emptyImageGraph({ jobId, width: 96, height: 64 }),
        promptId,
      );
      await waitForEnd(h.socket, promptId);

      const history = await h.client.history(promptId);
      assert(history, `no /history entry for ${promptId}`);
      const files = history.outputs[SAVE_NODE] ?? [];
      assertEquals(files.length, 1, "SaveImage did not report one file");
      const file = files[0]!;
      assertEquals(
        file.subfolder,
        jobId,
        "the job id in filename_prefix did not become the subfolder",
      );

      // /view is how the app reads a file it has not moved yet.
      const view = await fetch(
        `${h.client.url}/view?filename=${
          encodeURIComponent(file.filename)
        }&subfolder=${encodeURIComponent(file.subfolder)}&type=output`,
      );
      assertEquals(view.status, 200);
      assert(
        view.headers.get("content-type")?.startsWith("image/png"),
        `/view answered ${view.headers.get("content-type")}`,
      );
      const bytes = new Uint8Array(await view.arrayBuffer());
      assertEquals(bytes.subarray(0, 8), PNG_SIGNATURE);
      assertEquals(readPngSize(bytes), { width: 96, height: 64 });

      // Completion reads the size and appends a tEXt chunk to these bytes
      // (§5 step 7); a real ComfyUI PNG has to survive that.
      const embedded = withTextChunk(
        bytes,
        SIDECAR_KEYWORD,
        '{"app":"forgeui"}',
      );
      assertEquals(readPngSize(embedded), { width: 96, height: 64 });
      assertEquals(
        readTextChunks(embedded)[SIDECAR_KEYWORD],
        '{"app":"forgeui"}',
      );

      if (OUTPUT_DIR) {
        // The app renames staging/<jobid>/* out and removes the directory,
        // so the files really have to be there and nowhere else.
        const path = join(OUTPUT_DIR, jobId, file.filename);
        const stat = await Deno.stat(path);
        assert(stat.isFile, `${path} is not a file`);
        assertEquals(new Uint8Array(await Deno.readFile(path)), bytes);
      }
    });
  },
);

contractTest("/history settles a job the app did not watch", async () => {
  await withComfy(async (h) => {
    const jobId = h.newJobId();
    const promptId = crypto.randomUUID();
    await h.client.prompt(emptyImageGraph({ jobId }), promptId);
    await waitForEnd(h.socket, promptId);

    // The reconcile pass after every reconnection reads exactly this (§5).
    const entry = await h.client.history(promptId);
    assert(entry, `no /history entry for ${promptId}`);
    assertEquals(entry.status, "success");
    assertEquals(entry.completed, true);
    assertEquals(Object.keys(entry.outputs), [SAVE_NODE]);
    assert(
      entry.messages.some(([type]) => type === "execution_start"),
      "history did not replay the event messages",
    );

    assertEquals(await h.client.history(crypto.randomUUID()), null);
  });
});

contractTest(
  "a node that runs twice is reported as execution_cached",
  async () => {
    await withComfy(async (h) => {
      const graph = (jobId: string) => emptyImageGraph({ jobId });
      const firstId = crypto.randomUUID();
      await h.client.prompt(graph(h.newJobId()), firstId);
      await waitForEnd(h.socket, firstId);

      const secondId = crypto.randomUUID();
      await h.client.prompt(graph(h.newJobId()), secondId);
      await waitForEnd(h.socket, secondId);

      const cached = eventsFor(h.socket, secondId).find(
        (event) => event.type === "execution_cached",
      );
      assert(
        cached,
        `no execution_cached on the second run; saw ${
          summary(eventsFor(h.socket, secondId))
        }`,
      );
      const nodes = cached.data.nodes;
      assert(Array.isArray(nodes), "execution_cached.nodes is not an array");
      assert(
        nodes.includes(IMAGE_NODE),
        `execution_cached listed ${JSON.stringify(nodes)}`,
      );
      const decoded = decode(cached);
      assert(decoded?.type === "execution_cached");
      assert(decoded.nodes.includes(IMAGE_NODE));
    });
  },
);

contractTest("a node that throws sends execution_error", async () => {
  await withComfy(async (h) => {
    const promptId = crypto.randomUUID();
    // SaveImage refuses to write outside the output directory, which is the
    // one runtime failure a graph with no model can provoke. The app never
    // builds a prefix like this: rewrite refuses job ids that escape.
    const graph = emptyImageGraph({
      jobId: "unused",
      filenamePrefix: `../${ESCAPE_DIR}/out`,
    });
    try {
      await h.client.prompt(graph, promptId);
    } catch (cause) {
      throw new Error(
        "this ComfyUI rejected the escaping filename_prefix at queue time " +
          "instead of failing the node, so this test needs another way to " +
          `make a node throw: ${
            cause instanceof ComfyHttpError ? cause.message : cause
          }`,
      );
    }
    try {
      await waitForEnd(h.socket, promptId);
    } finally {
      // If the node wrote its file after all, the bytes went next to the
      // output directory rather than inside it.
      if (OUTPUT_DIR) {
        await Deno.remove(join(OUTPUT_DIR, "..", ESCAPE_DIR), {
          recursive: true,
        }).catch(() => {});
      }
    }

    const events = eventsFor(h.socket, promptId);
    const error = events.find((event) => event.type === "execution_error");
    assert(error, `no execution_error; saw ${summary(events)}`);
    assertEquals(error.data.node_id, SAVE_NODE);
    assertEquals(error.data.node_type, "SaveImage");
    assertEquals(typeof error.data.exception_message, "string");
    assertEquals(typeof error.data.exception_type, "string");
    assert(
      Array.isArray(error.data.traceback),
      "execution_error.traceback is not an array",
    );
    assert(
      !events.some((event) => event.type === "execution_success"),
      "a failed prompt also reported execution_success",
    );

    const decoded = decode(error);
    assert(decoded?.type === "execution_error");
    assertEquals(decoded.node_id, SAVE_NODE);
    assert(decoded.exception_message.length > 0);

    // The app resolves the same failure from /history when it was away.
    const entry = await h.client.history(promptId);
    assert(entry, "a failed prompt left no history entry");
    assertEquals(entry.status, "error");
    assertEquals(entry.completed, false);
    assert(
      entry.messages.some(([type]) => type === "execution_error"),
      "history did not record the execution_error",
    );
  });
});

contractTest("a graph with an unknown node is rejected with 400", async () => {
  await withComfy(async (h) => {
    const graph = emptyImageGraph({ jobId: h.newJobId() });
    graph["3"] = {
      class_type: "ForgeUIContractCheckMissingNode",
      inputs: { images: [IMAGE_NODE, 0] },
    };
    const error = await h.client.prompt(graph, crypto.randomUUID()).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert(
      error instanceof ComfyHttpError,
      `a graph with a missing node was accepted: ${error}`,
    );
    assertEquals(error.status, 400);
    assert(error.message.length > 0, "the rejection carried no message");
    assertEquals(typeof error.nodeErrors, "object");
  });
});

contractTest("/system_stats has the fields Settings shows", async () => {
  await withComfy(async (h) => {
    const raw = await (await fetch(`${h.client.url}/system_stats`)).json();
    assertEquals(typeof raw.system, "object");
    assert(Array.isArray(raw.devices), "/system_stats has no devices array");
    assert(raw.devices.length > 0, "/system_stats listed no devices");

    const stats = await h.client.systemStats();
    assertEquals(typeof stats.comfyui_version, "string");
    assertEquals(typeof stats.python_version, "string");
    assertEquals(typeof stats.device, "string");
    assert(
      stats.vram_total !== null && stats.vram_total > 0,
      `vram_total was ${stats.vram_total}`,
    );
    assert(
      stats.vram_free !== null && stats.vram_free <= stats.vram_total!,
      `vram_free ${stats.vram_free} exceeds vram_total ${stats.vram_total}`,
    );
  });
});

contractTest("/upload/image with overwrite=true keeps the name", async () => {
  await withComfy(async (h) => {
    // Content-addressed inputs upload the same name twice by design (§9).
    const name = `forgeui-contract-${crypto.randomUUID()}.png`;
    const png = tinyPng({ width: 16, height: 8 });
    try {
      const first = await h.client.uploadImage(name, png, "image/png");
      assertEquals(first.name, name);
      assertEquals(first.subfolder, "");
      const again = await h.client.uploadImage(name, png, "image/png");
      assertEquals(
        again.name,
        name,
        "the second upload was renamed; overwrite=true was ignored",
      );

      const view = await fetch(
        `${h.client.url}/view?filename=${encodeURIComponent(name)}&type=input`,
      );
      assertEquals(view.status, 200);
      assertEquals(new Uint8Array(await view.arrayBuffer()), png);
    } finally {
      if (INPUT_DIR) {
        await Deno.remove(join(INPUT_DIR, name)).catch(() => {});
      }
    }
  });
});

contractTest(
  "a sampler reports progress and streams binary preview frames",
  async () => {
    await withComfy(async (h) => {
      const jobId = h.newJobId();
      const promptId = crypto.randomUUID();
      await h.client.prompt(samplerGraph({ jobId, seed: 1 }), promptId);
      await waitForEnd(h.socket, promptId, SAMPLER_TIMEOUT_MS);

      const events = eventsFor(h.socket, promptId);
      assert(
        !events.some((event) => event.type === "execution_error"),
        `the sample failed: ${
          JSON.stringify(
            events.find((event) => event.type === "execution_error")?.data,
          )
        }`,
      );

      const progress = events.filter((event) => event.type === "progress");
      assert(progress.length > 0, `no progress events; saw ${summary(events)}`);
      const values: number[] = [];
      for (const event of progress) {
        assertEquals(typeof event.data.node, "string");
        assertEquals(
          event.data.max,
          SAMPLER_STEPS,
          "progress.max is not the sampler's step count",
        );
        assertEquals(typeof event.data.value, "number");
        values.push(event.data.value as number);
        assertEquals(decode(event)?.type, "progress");
      }
      assertEquals(
        values,
        [...values].sort((a, b) => a - b),
        `progress values arrived out of order: ${values.join(", ")}`,
      );
      assertEquals(
        values.at(-1),
        SAMPLER_STEPS,
        "the last progress event did not reach max",
      );

      // Binary preview frames: uint32 event id (1), uint32 format, image.
      const previews = h.socket.binary();
      assert(
        previews.length > 0,
        "no preview frames; start ComfyUI with --preview-method auto",
      );
      const frame = previews[0]!;
      assertEquals(frame.event, 1);
      assert(
        frame.format === 1 || frame.format === 2,
        `preview format was ${frame.format}, expected 1 (JPEG) or 2 (PNG)`,
      );
      const decoded = decodePreviewFrame(frame.raw);
      assert(decoded, "the app's decoder rejected a real preview frame");
      assertEquals(decoded.format, frame.format);
      if (decoded.format === 2) {
        assertEquals(decoded.bytes.subarray(0, 8), PNG_SIGNATURE);
      } else {
        assertEquals(
          decoded.bytes.subarray(0, 3),
          Uint8Array.of(
            0xff,
            0xd8,
            0xff,
          ),
        );
      }
    });
  },
  { sampler: true },
);

contractTest(
  "/queue lists the running and the pending prompt",
  async () => {
    await withComfy(async (h) => {
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      await h.client.prompt(
        samplerGraph({ jobId: h.newJobId(), seed: 2 }),
        first,
      );
      await h.client.prompt(
        samplerGraph({ jobId: h.newJobId(), seed: 3 }),
        second,
      );

      // Reconcile resolves an in-flight job from this before /history (§5).
      const raw = await (await fetch(`${h.client.url}/queue`)).json();
      assert(Array.isArray(raw.queue_running), "queue_running is not an array");
      assert(Array.isArray(raw.queue_pending), "queue_pending is not an array");
      for (const entry of [...raw.queue_running, ...raw.queue_pending]) {
        assert(Array.isArray(entry), "a queue entry is not an array");
        assertEquals(typeof entry[0], "number");
        assertEquals(typeof entry[1], "string");
      }

      const queue = await h.client.queue();
      const ids = [...queue.running, ...queue.pending].map((item) =>
        item.prompt_id
      );
      assert(
        ids.includes(first) || ids.includes(second),
        `neither prompt was in the queue: ${ids.join(", ")}`,
      );

      await waitForEnd(h.socket, first, SAMPLER_TIMEOUT_MS);
      await waitForEnd(h.socket, second, SAMPLER_TIMEOUT_MS);
      assertEquals((await h.client.queue()).pending, []);
    });
  },
  { sampler: true },
);
