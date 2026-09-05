import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startTestApp, type TestApp, withTestApp } from "../fixtures/app.ts";
import { decodePreviewFrame } from "../../src/http/ws.ts";
import {
  readPngSize,
  readTextChunks,
  SIDECAR_KEYWORD,
} from "../../src/jobs/png.ts";
import { parseSidecar, type Sidecar } from "../../src/jobs/sidecar.ts";
import type { JobRow, OutputRow, Progress } from "../../src/db/queries.ts";
import type { ApiGraph } from "../../src/workflows/types.ts";

interface JobResponse extends Omit<JobRow, "params" | "api_graph"> {
  params: Record<string, unknown>;
  api_graph: ApiGraph;
  outputs: string[];
}

const PROMPT = "a granite bowl of figs, north light";

async function submit(
  app: TestApp,
  params: Record<string, unknown> = {},
  workflow = "krea2",
): Promise<JobResponse> {
  return await app.json<JobResponse>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: workflow,
      params: { prompt: PROMPT, ...params },
    }),
  });
}

async function job(app: TestApp, id: string): Promise<JobResponse> {
  return await app.json<JobResponse>(`/api/jobs/${id}`);
}

const TERMINAL = ["done", "failed", "cancelled"];

/**
 * ComfyUI's events reach the app over a websocket, so a settled fake does not
 * mean a settled job: wait for the row to stop moving.
 */
async function awaitJob(
  app: TestApp,
  id: string,
  statuses: string[] = TERMINAL,
  timeoutMs = 5000,
): Promise<JobResponse> {
  const deadline = Date.now() + timeoutMs;
  let current = await job(app, id);
  while (!statuses.includes(current.status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `job ${id} was still "${current.status}" after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await job(app, id);
  }
  await app.jobs.idle();
  return await job(app, id);
}

async function listDir(path: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

Deno.test("a job runs end to end: submit, progress, files, sidecar, index", async () => {
  await withTestApp(async (app) => {
    const socket = await app.socket();
    const submitted = await submit(app, { size: [128, 96], seed: 4242 });

    // §5 step 4: the row is persisted before ComfyUI is asked to do anything,
    // and it carries the exact graph that was queued.
    // The prompt id is recorded before ComfyUI is asked to do anything, so by
    // the time the call returns the job may already be running.
    assert(
      ["queued", "running", "done"].includes(submitted.status),
      submitted.status,
    );
    assert(submitted.prompt_id, "the prompt id is stored");
    assertEquals(submitted.workflow_id, "krea2");
    assertEquals(submitted.params.seed, 4242);
    assertEquals(
      submitted.api_graph["9"]?.inputs.filename_prefix,
      `${submitted.id}/out`,
    );
    assertEquals(app.fake!.prompts.length, 1);
    assertEquals(app.fake!.lastPrompt?.prompt_id, submitted.prompt_id);

    const done = await awaitJob(app, submitted.id);
    await socket.waitFor((message) =>
      message.kind === "json" && message.type === "job" &&
      (message.data as unknown as JobRow).status === "done"
    );
    assertEquals(done.status, "done");
    assertEquals(done.error, null);
    assert(done.started_at !== null && done.finished_at !== null);
    assertEquals(done.progress?.pct, 100);
    assertEquals(done.outputs, [`${submitted.id}-0`]);

    // Timestamps are epoch milliseconds, not something the driver mangled on
    // the way into SQLite.
    assert(
      Math.abs(Date.now() - done.created_at) < 60_000,
      `created_at ${done.created_at} is not a recent clock reading`,
    );
    assert(done.finished_at! >= done.started_at!);

    // The file moved out of staging into the day directory (§5 step 7).
    const created = new Date(submitted.created_at);
    assertEquals(
      created.getUTCFullYear(),
      new Date().getUTCFullYear(),
      "the output day directory follows the wall clock",
    );
    const day = `${created.getUTCFullYear()}/${
      `${created.getUTCMonth() + 1}`.padStart(2, "0")
    }/${`${created.getUTCDate()}`.padStart(2, "0")}`;
    const outputDir = join(app.paths.outputs, day);
    assertEquals(await listDir(outputDir), [
      `${submitted.id}-0.png`,
      `${submitted.id}.json`,
    ]);
    assertEquals(await listDir(app.paths.staging), []);

    // The image is the size the workflow asked for.
    const bytes = await Deno.readFile(join(outputDir, `${submitted.id}-0.png`));
    assertEquals(readPngSize(bytes), { width: 128, height: 96 });

    // The sidecar reproduces the run, and a copy rides along in the PNG.
    const sidecar = parseSidecar(
      await Deno.readTextFile(join(outputDir, `${submitted.id}.json`)),
    );
    assertEquals(sidecar.job_id, submitted.id);
    assertEquals(sidecar.workflow?.id, "krea2");
    assertEquals(sidecar.workflow?.family, "flux");
    assert(sidecar.workflow?.hash.startsWith("sha256:"));
    assertEquals(sidecar.params.prompt, PROMPT);
    assertEquals(sidecar.params.seed, 4242);
    assertEquals(sidecar.outputs, [{
      file: `${submitted.id}-0.png`,
      kind: "image",
      width: 128,
      height: 96,
    }]);
    assertEquals(
      sidecar.models.map((model) => `${model.role}:${model.name}`),
      [
        "unet:flux1-krea-dev.safetensors",
        "clip:t5xxl_fp16.safetensors",
        "clip:clip_l.safetensors",
        "vae:ae.safetensors",
      ],
    );
    assert(sidecar.timing.total_ms >= 0);
    assertEquals(
      (sidecar.api_graph as ApiGraph)["9"]?.inputs.filename_prefix,
      `${submitted.id}/out`,
    );
    assertEquals(
      parseSidecar(readTextChunks(bytes)[SIDECAR_KEYWORD]!),
      sidecar as Sidecar,
    );

    // …and the database row that the gallery reads.
    const output = await app.json<{ output: OutputRow }>(
      `/api/jobs/${submitted.id}`,
    ).then(() =>
      app.db.prepare(`SELECT path, sidecar_path, kind, width, height,
        sha256, workflow_id, family, prompt FROM outputs WHERE id = ?`)
        .value<
          [
            string,
            string,
            string,
            number,
            number,
            string,
            string,
            string,
            string,
          ]
        >(
          `${submitted.id}-0`,
        )
    );
    assertEquals(output?.[0], `outputs/${day}/${submitted.id}-0.png`);
    assertEquals(output?.[1], `outputs/${day}/${submitted.id}.json`);
    assertEquals(output?.[2], "image");
    assertEquals(output?.[3], 128);
    assertEquals(output?.[4], 96);
    assertEquals(output?.[6], "krea2");
    assertEquals(output?.[7], "flux");
    assertEquals(output?.[8], PROMPT);
    // The hash is of the bytes on disk, so reindex can recompute it.
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    assertEquals(
      output?.[5],
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }, { comfy: true });
});

Deno.test("progress and previews arrive on the app's /ws", async () => {
  await withTestApp(async (app) => {
    const socket = await app.socket();
    const submitted = await submit(app);
    await awaitJob(app, submitted.id);
    await socket.waitFor((message) =>
      message.kind === "json" && message.type === "job" &&
      (message.data as unknown as JobRow).status === "done"
    );

    const jobEvents = socket.json("job").map((message) =>
      message.data as unknown as JobRow
    );
    assertEquals(jobEvents[0]?.status, "queued");
    assertEquals(jobEvents.at(-1)?.status, "done");
    assert(
      jobEvents.some((event) => event.status === "running"),
      "the running state is pushed",
    );

    // §7's progress shape, pushed as the job walks the graph.
    const withProgress = jobEvents.filter((event) =>
      event.progress !== null && event.progress.node_id !== null
    );
    assert(withProgress.length > 0, "progress is pushed");
    const progress = withProgress.at(-1)!.progress as Progress;
    assertEquals(Object.keys(progress), [
      "pct",
      "eta_ms",
      "node_id",
      "node_label",
      "node_index",
      "node_total",
      "step",
      "max",
    ]);
    assert(progress.node_total > 1);
    assert(progress.pct > 0 && progress.pct <= 100);

    // The output event carries the row in the shape the API returns it, so a
    // live tile has everything a reloaded one does — the media URL included.
    const outputs = socket.json("output").map((message) =>
      message.data as unknown as OutputRow & { media_url: string }
    );
    assertEquals(outputs.length, 1);
    assertEquals(outputs[0]?.id, `${submitted.id}-0`);
    assertEquals(outputs[0]?.media_url, `/api/media/${outputs[0]?.path}`);
    const fromEvent = await app.fetch(outputs[0]!.media_url);
    assertEquals(fromEvent.status, 200);
    assertEquals(fromEvent.headers.get("content-type"), "image/png");
    await fromEvent.body?.cancel();

    // ComfyUI's preview frame is relayed with the job id in front (§5 step 6).
    const previews = socket.binary();
    assertEquals(previews.length, 1);
    const frame = decodePreviewFrame(
      new Uint8Array([
        ...new Uint8Array(
          new Uint32Array([1, previews[0]!.format]).buffer,
        ).slice(0, 0),
        ...rebuild(previews[0]!.bytes, previews[0]!.event, previews[0]!.format),
      ]),
    );
    assertEquals(frame?.jobId, submitted.id);
    assertEquals(readPngSize(frame!.image), { width: 32, height: 32 });
  }, { comfy: true });
});

/** The test socket splits off the 8-byte header, so put it back to decode. */
function rebuild(rest: Uint8Array, event: number, format: number): Uint8Array {
  const frame = new Uint8Array(8 + rest.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, event);
  view.setUint32(4, format);
  frame.set(rest, 8);
  return frame;
}

Deno.test("a multi-output job indexes every file", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("multi-output");
    const submitted = await submit(app);
    const done = await awaitJob(app, submitted.id);
    assertEquals(done.status, "done");
    assertEquals(done.outputs, [`${submitted.id}-0`, `${submitted.id}-1`]);

    const sidecar = await readSidecar(app, submitted.id);
    assertEquals(sidecar.outputs.map((output) => output.file), [
      `${submitted.id}-0.png`,
      `${submitted.id}-1.png`,
    ]);
    assertEquals(await listDir(app.paths.staging), []);
  }, { comfy: true });
});

async function readSidecar(app: TestApp, jobId: string): Promise<Sidecar> {
  const row = app.db.prepare(
    `SELECT sidecar_path FROM outputs WHERE job_id = ?`,
  )
    .value<[string]>(jobId);
  assert(row, `no output row for ${jobId}`);
  return parseSidecar(await Deno.readTextFile(join(app.paths.root, row[0])));
}

Deno.test("an error mid-graph lands on the job row and clears staging", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("error-mid-graph");
    const submitted = await submit(app);
    const failed = await awaitJob(app, submitted.id);
    assertEquals(failed.status, "failed");
    assertEquals(failed.outputs, []);
    assertEquals(failed.error?.type, "torch.OutOfMemoryError");
    assertStringIncludes(failed.error?.message ?? "", "exceed allowed memory");
    assertEquals(failed.error?.node_id, "3");
    assert(failed.finished_at !== null);
    // The staging directory is removed (§5 step 8).
    assertEquals(await listDir(app.paths.staging), []);
    assertEquals(await listDir(app.paths.outputs), []);
  }, { comfy: true });
});

Deno.test("cancelling a queued job dequeues it in ComfyUI", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-queued");
    const submitted = await submit(app);
    assertEquals((await job(app, submitted.id)).status, "queued");

    const cancelled = await app.json<JobResponse>(
      `/api/jobs/${submitted.id}/cancel`,
      { method: "POST" },
    );
    assertEquals(cancelled.status, "cancelled");
    assertEquals(
      await app.fake!.waitForPrompt(submitted.prompt_id!),
      "deleted",
    );
    assertEquals((await awaitJob(app, submitted.id)).status, "cancelled");
    assertEquals(await listDir(app.paths.outputs), []);
  }, { comfy: true });
});

Deno.test("cancelling a running job interrupts it", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-running");
    const socket = await app.socket();
    const submitted = await submit(app);

    await socket.waitFor((message) =>
      message.kind === "json" && message.type === "job" &&
      (message.data as unknown as JobRow).status === "running"
    );
    await app.fake!.waitForGate("interrupt");

    await app.fetch(`/api/jobs/${submitted.id}/cancel`, { method: "POST" });
    assertEquals(app.fake!.interruptCount, 1);
    await app.fake!.waitForPrompt(submitted.prompt_id!);
    const cancelled = await awaitJob(app, submitted.id);
    assertEquals(cancelled.status, "cancelled");
    assertEquals(cancelled.outputs, []);
    assertEquals(await listDir(app.paths.staging), []);
  }, { comfy: true });
});

Deno.test("clearing the queue cancels the queued jobs", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("cancel-while-queued");
    const first = await submit(app);
    const second = await submit(app);

    const cleared = await app.json<{ cancelled: JobRow[] }>("/api/jobs/clear", {
      method: "POST",
    });
    assertEquals(cleared.cancelled.length, 2);
    assertEquals((await awaitJob(app, first.id)).status, "cancelled");
    assertEquals((await awaitJob(app, second.id)).status, "cancelled");
  }, { comfy: true });
});

Deno.test("a job that finished while the socket was down is recovered", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("ws-reconnect");
    const submitted = await submit(app);

    // The fake drops every socket mid-job, then parks until the app is back.
    await app.fake!.waitForGate("reconnected");
    await app.comfy.waitForState("disconnected", 5000);
    app.fake!.openGate("reconnected");

    // Reconnecting triggers a reconcile, which picks the job up from /history.
    await app.comfy.waitForState("running", 5000);
    const done = await awaitJob(app, submitted.id);
    assertEquals(done.status, "done");
    assertEquals(done.outputs, [`${submitted.id}-0`]);
    assertEquals(await listDir(app.paths.staging), []);
  }, { comfy: true });
});

Deno.test("ComfyUI dying mid-job leaves a failed job and a swept staging dir", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-restart-" });
  const first = await startTestApp({ dataDir, comfy: true });
  let jobId: string;
  try {
    first.fake!.setScenario("death-before-executed");
    const submitted = await submit(first);
    jobId = submitted.id;
    await first.fake!.waitForPrompt(submitted.prompt_id!);
    await first.jobs.idle();

    // The job is still marked running: nothing told the app otherwise.
    assertEquals((await job(first, jobId)).status, "running");
  } finally {
    await first.shutdown();
    await first.fake?.close();
  }

  // A fresh boot on the same data dir has to clean up after that (§M2).
  const second = await startTestApp({ dataDir });
  try {
    const failed = await job(second, jobId);
    assertEquals(failed.status, "failed");
    assertEquals(failed.error?.type, "app_restarted");
    assertEquals(await listDir(second.paths.staging), []);
  } finally {
    await second.dispose();
  }
});

Deno.test("rerun resubmits the frozen graph from a sidecar", async () => {
  await withTestApp(async (app) => {
    const original = await submit(app, { seed: 999 });
    await awaitJob(app, original.id);
    const outputId = `${original.id}-0`;

    const rerun = await app.json<JobResponse>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify({ output_id: outputId }),
    });
    await awaitJob(app, rerun.id);

    assert(rerun.id !== original.id);
    assertEquals(rerun.workflow_id, "krea2");
    // Same seed, same everything — except where the files land (§6.4).
    assertEquals(rerun.params.seed, 999);
    assertEquals(
      rerun.api_graph["3"]?.inputs.seed,
      original.api_graph["3"]?.inputs.seed,
    );
    assertEquals(
      rerun.api_graph["9"]?.inputs.filename_prefix,
      `${rerun.id}/out`,
    );

    const done = await awaitJob(app, rerun.id);
    assertEquals(done.status, "done");
    assertEquals(done.outputs, [`${rerun.id}-0`]);
    const sidecar = await readSidecar(app, rerun.id);
    assertEquals(sidecar.params.seed, 999);
  }, { comfy: true });
});

Deno.test("rerun works from a failed job row, and after the workflow is gone", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("error-mid-graph");
    const failed = await submit(app, { seed: 7 });
    assertEquals((await awaitJob(app, failed.id)).status, "failed");

    // Retry from the frozen graph on the failed row (§6.4).
    app.fake!.setScenario("success");
    const retry = await app.json<JobResponse>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify({ job_id: failed.id }),
    });
    assertEquals((await awaitJob(app, retry.id)).status, "done");
    assertEquals(retry.params.seed, 7);

    // Deleting the workflow must not break rerunning its outputs (§6.1).
    const duplicate = await app.json<{ id: string }>(
      "/api/workflows/krea2/duplicate",
      { method: "POST" },
    );
    const viaCopy = await app.json<JobResponse>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: duplicate.id,
        params: { prompt: PROMPT },
      }),
    });
    await awaitJob(app, viaCopy.id);
    assertEquals(
      (await app.fetch(`/api/workflows/${duplicate.id}`, { method: "DELETE" }))
        .status,
      204,
    );
    const orphanRerun = await app.json<JobResponse>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify({ output_id: `${viaCopy.id}-0` }),
    });
    assertEquals((await awaitJob(app, orphanRerun.id)).status, "done");
  }, { comfy: true });
});

Deno.test("GET /api/jobs filters, and a refresh sees the same state", async () => {
  await withTestApp(async (app) => {
    const done = await submit(app);
    await awaitJob(app, done.id);
    app.fake!.setScenario("cancel-while-queued");
    const queued = await submit(app);

    const active = await app.json<{ jobs: JobResponse[] }>(
      "/api/jobs?status=active",
    );
    assertEquals(active.jobs.map((entry) => entry.id), [queued.id]);

    const all = await app.json<{ jobs: JobResponse[] }>("/api/jobs?status=all");
    assertEquals(
      all.jobs.map((entry) => entry.id).sort(),
      [done.id, queued.id].sort(),
    );

    const byWorkflow = await app.json<{ jobs: JobResponse[] }>(
      "/api/jobs?workflow_id=krea2&limit=1",
    );
    assertEquals(byWorkflow.jobs.length, 1);
    // Newest first, so this is the "last used params" lookup of §11.2.
    assertEquals(byWorkflow.jobs[0]?.id, queued.id);
    assertEquals(byWorkflow.jobs[0]?.params.prompt, PROMPT);

    assertEquals((await app.fetch("/api/jobs?status=nope")).status, 400);
    assertEquals((await app.fetch("/api/jobs/nope")).status, 404);
  }, { comfy: true });
});

Deno.test("ComfyUI refusing a graph fails the job and says why", async () => {
  await withTestApp(async (app) => {
    // Give a user workflow a node type ComfyUI does not have.
    const detail = await app.json<{ api_json: ApiGraph }>(
      "/api/workflows/krea2",
    );
    const graph = structuredClone(detail.api_json);
    graph["3"]!.class_type = "SuperCustomSampler";
    await app.fetch("/api/workflows/krea2", {
      method: "PUT",
      body: JSON.stringify({ api_json: graph }),
    });

    const response = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "krea2",
        params: { prompt: PROMPT },
      }),
    });
    assertEquals(response.status, 502);
    const body = await response.json() as {
      error: { code: string; message: string };
      node_errors: Record<string, unknown>;
      job: JobRow;
    };
    assertEquals(body.error.code, "comfy_rejected");
    assert("3" in body.node_errors);

    // The attempt is still on the record (§5.2: job rows are kept forever).
    const failed = await job(app, body.job.id);
    assertEquals(failed.status, "failed");
    assertEquals(failed.error?.type, "submit_failed");
    assert("3" in (failed.error?.node_errors ?? {}));
  }, { comfy: true });
});

Deno.test("submitting is refused when ComfyUI is not connected", async () => {
  await withTestApp(async (app) => {
    const response = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "krea2",
        params: { prompt: PROMPT },
      }),
    });
    assertEquals(response.status, 503);
    const body = await response.json() as { error: { code: string } };
    assertEquals(body.error.code, "comfy_offline");
    // Nothing was recorded, because nothing was attempted.
    assertEquals(
      (await app.json<{ jobs: JobRow[] }>("/api/jobs?status=all")).jobs.length,
      0,
    );
  });
});

Deno.test("submitting refuses unknown or unrunnable workflows", async () => {
  await withTestApp(async (app) => {
    assertEquals(
      (await app.fetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ workflow_id: "nope", params: {} }),
      })).status,
      404,
    );
    assertEquals(
      (await app.fetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ params: {} }),
      })).status,
      400,
    );

    const blank = await app.json<{ id: string }>("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Empty" }),
    });
    const response = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: blank.id, params: {} }),
    });
    assertEquals(response.status, 400);
    assertStringIncludes(
      (await response.json() as { error: { message: string } }).error.message,
      "no output node",
    );

    // A required param that is empty is rejected before ComfyUI sees anything.
    const missingPrompt = await app.fetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "krea2", params: {} }),
    });
    assertEquals(missingPrompt.status, 400);
    assertStringIncludes(
      (await missingPrompt.json() as { error: { message: string } }).error
        .message,
      "prompt: is required",
    );
  }, { comfy: true });
});
