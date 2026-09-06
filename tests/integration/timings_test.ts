import { assert, assertEquals } from "@std/assert";
import { startTestApp, type TestApp, withTestApp } from "../fixtures/app.ts";
import {
  countNodeTimings,
  type JobRow,
  listNodeTimings,
} from "../../src/db/queries.ts";

/**
 * §5.1 end to end: a finished job leaves the per-node durations behind, the
 * next run of that workflow is weighted by them, and a rebuild recovers them
 * from the sidecars alone.
 */

async function submit(
  app: TestApp,
  params: Record<string, unknown> = {},
): Promise<JobRow> {
  return await app.json<JobRow>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: "krea2",
      params: { prompt: "a granite bowl of figs", ...params },
    }),
  });
}

async function awaitJob(app: TestApp, id: string): Promise<JobRow> {
  const deadline = Date.now() + 5000;
  let job = await app.json<JobRow>(`/api/jobs/${id}`);
  while (!["done", "failed", "cancelled"].includes(job.status)) {
    if (Date.now() > deadline) {
      throw new Error(`job ${id} was still "${job.status}" after 5s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await app.json<JobRow>(`/api/jobs/${id}`);
  }
  await app.jobs.idle();
  return job;
}

Deno.test("a finished job teaches the next one how long it takes", async () => {
  await withTestApp(async (app) => {
    const hash = app.workflows.get("krea2")!.hash;
    assertEquals(countNodeTimings(app.db), 0, "nothing is known up front");

    const first = await awaitJob(app, (await submit(app)).id);
    assertEquals(first.status, "done");
    const learned = listNodeTimings(app.db, hash);
    assert(learned.length > 0, "the run left timings behind");
    assert(
      learned.every((row) => row.samples === 1),
      "one run is one sample",
    );
    // They are the same numbers the sidecar recorded (§6.2).
    const sidecar = (await app.json<
      { sidecar: { timing: { nodes: Record<string, number> } } }
    >(
      `/api/outputs/${first.id}-0`,
    )).sidecar;
    for (const row of learned) {
      assertEquals(row.ewma_ms, sidecar.timing.nodes[row.node_id]);
    }

    // A second run folds into the average rather than replacing it.
    await awaitJob(app, (await submit(app)).id);
    assert(
      listNodeTimings(app.db, hash).every((row) => row.samples === 2),
      "the second run is a second sample",
    );

    // And the next job is weighted by them, which a client sees as an ETA
    // from the first frame instead of a dash (§5.1).
    const socket = await app.socket();
    const third = await submit(app);
    await awaitJob(app, third.id);
    await socket.waitFor((message) =>
      message.kind === "json" && message.type === "job" &&
      (message.data as unknown as JobRow).id === third.id &&
      (message.data as unknown as JobRow).status === "done"
    );
    const firstRunning = socket.json("job")
      .map((message) => message.data as unknown as JobRow)
      .find((job) => job.id === third.id && job.status === "running");
    assert(firstRunning, "the running state was pushed");
    assert(
      firstRunning.progress !== null &&
        typeof firstRunning.progress.eta_ms === "number",
      "a workflow with history has an ETA before any node finishes",
    );
  }, { comfy: true });
});

Deno.test("without history there is no ETA to give yet", async () => {
  await withTestApp(async (app) => {
    const socket = await app.socket();
    const job = await awaitJob(app, (await submit(app)).id);
    await socket.waitFor((message) =>
      message.kind === "json" && message.type === "job" &&
      (message.data as unknown as JobRow).status === "done"
    );
    const firstRunning = socket.json("job")
      .map((message) => message.data as unknown as JobRow)
      .find((row) => row.id === job.id && row.status === "running");
    assertEquals(
      firstRunning?.progress?.eta_ms,
      null,
      "the first run of a workflow claims nothing it cannot know",
    );
  }, { comfy: true });
});

Deno.test("a failed job teaches nothing", async () => {
  await withTestApp(async (app) => {
    app.fake!.setScenario("error-mid-graph");
    const failed = await awaitJob(app, (await submit(app)).id);
    assertEquals(failed.status, "failed");
    assertEquals(countNodeTimings(app.db), 0);
  }, { comfy: true });
});

Deno.test("a rebuild recovers the timings from the sidecars", async () => {
  await withTestApp(async (app) => {
    const hash = app.workflows.get("krea2")!.hash;
    await awaitJob(app, (await submit(app)).id);
    const learned = listNodeTimings(app.db, hash);
    assert(learned.length > 0);

    // The table is derived, so losing it is not losing anything (§7).
    app.db.exec("DELETE FROM node_timings");
    const result = await app.json<{ node_timings: number }>(
      "/api/maintenance/reindex",
      { method: "POST" },
    );
    assertEquals(result.node_timings, learned.length);
    assertEquals(listNodeTimings(app.db, hash), learned);
  }, { comfy: true });
});

Deno.test("the first launch after this phase seeds from what is on disk", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-seed-boot-" });
  try {
    // One app generates an output and its sidecar…
    const first = await startTestApp({
      dataDir,
      comfy: true,
      keepDataDir: true,
    });
    const hash = first.workflows.get("krea2")!.hash;
    const job = await awaitJob(first, (await submit(first)).id);
    assertEquals(job.status, "done");
    const learned = listNodeTimings(first.db, hash);
    first.db.exec("DELETE FROM node_timings");
    await first.dispose();

    // …and the next one finds the timings again without being asked.
    const second = await startTestApp({ dataDir, keepDataDir: true });
    try {
      const deadline = Date.now() + 5000;
      while (countNodeTimings(second.db) === 0) {
        if (Date.now() > deadline) throw new Error("the boot seed never ran");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assertEquals(listNodeTimings(second.db, hash), learned);
    } finally {
      await second.dispose();
    }
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});
