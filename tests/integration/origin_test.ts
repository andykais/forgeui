import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type TestApp, withTestApp } from "../fixtures/app.ts";
import { reindex } from "../../src/outputs/reindex.ts";
import type { Origin, OutputRow } from "../../src/db/queries.ts";
import type { Sidecar } from "../../src/jobs/sidecar.ts";

/**
 * `origin` (§6.2): who asked for a run, and why.
 *
 * The sidecar is the record and the columns are the index, which is the rule
 * for everything about an output — so the interesting cases are the ones
 * where those two could drift: a rebuild, and a row written before the block
 * existed.
 */

interface OutputView extends OutputRow {
  media_url: string;
}

interface JobView {
  id: string;
  status: string;
  origin: Origin | null;
}

const TERMINAL = ["done", "failed", "cancelled"];

async function generate(
  app: TestApp,
  body: Record<string, unknown>,
): Promise<JobView> {
  const job = await app.json<JobView>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: "krea2",
      params: { prompt: "a granite bowl of figs" },
      ...body,
    }),
  });
  const deadline = Date.now() + 5000;
  let status = job.status;
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${job.id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<JobView>(`/api/jobs/${job.id}`)).status;
  }
  await app.jobs.idle();
  return await app.json<JobView>(`/api/jobs/${job.id}`);
}

Deno.test("origin travels from the submit to the row and the sidecar", async () => {
  await withTestApp(async (app) => {
    const job = await generate(app, {
      origin: { source: "llm:qwen-vlm", project: "herons", note: "round 1" },
    });
    assertEquals(job.origin, {
      source: "llm:qwen-vlm",
      project: "herons",
      note: "round 1",
    });

    const { outputs } = await app.json<{ outputs: OutputView[] }>(
      "/api/outputs",
    );
    assertEquals(outputs[0]!.origin, job.origin);

    // The sidecar is the record; the columns are the index of it.
    const detail = await app.json<{ sidecar: Sidecar }>(
      `/api/outputs/${outputs[0]!.id}`,
    );
    assertEquals(detail.sidecar.origin, job.origin);
  }, { comfy: true });
});

Deno.test("a submit that names no source stays unnamed", async () => {
  // The server does not guess `ui`: that is the one label the filter exists
  // to tell apart, and a script posting here is not a person at the screen.
  // The web app names itself (src/frontend/src/api.ts).
  await withTestApp(async (app) => {
    const job = await generate(app, {});
    assertEquals(job.origin, null);

    const named = await generate(app, { origin: { source: "ui" } });
    assertEquals(named.origin, { source: "ui", project: null, note: null });
  }, { comfy: true });
});

Deno.test("the gallery filters on project and source", async () => {
  await withTestApp(async (app) => {
    await generate(app, {
      origin: { source: "llm:qwen-vlm", project: "herons" },
    });
    await generate(app, { origin: { source: "ui", project: "cactus" } });
    await generate(app, { origin: { source: "ui" } });

    const page = async (query: string) =>
      (await app.json<{ outputs: OutputView[] }>(`/api/outputs${query}`))
        .outputs;

    assertEquals((await page("")).length, 3);
    assertEquals(
      (await page("?project=herons")).map((output) => output.origin?.project),
      ["herons"],
    );
    // Exact, not a search: a project is a name the caller already knows.
    assertEquals((await page("?project=heron")).length, 0);
    assertEquals((await page("?source=llm:qwen-vlm")).length, 1);
    // Everything the person made by hand, which is the other half of the
    // question the filter exists to answer.
    assertEquals((await page("?source=ui")).length, 2);
    assertEquals(
      (await page("?project=cactus&source=ui")).map((output) =>
        output.origin?.project
      ),
      ["cactus"],
    );
  }, { comfy: true });
});

Deno.test("a rerun is its own run, not the one it copies", async () => {
  // Inheriting would file a person's rerun under the model that made the
  // first one, and the gallery would say an LLM made something it never saw.
  await withTestApp(async (app) => {
    const first = await generate(app, {
      origin: { source: "llm:qwen-vlm", project: "herons" },
    });
    const rerun = await app.json<JobView>("/api/jobs/rerun", {
      method: "POST",
      body: JSON.stringify({ job_id: first.id, origin: { source: "ui" } }),
    });
    assertEquals(rerun.origin, { source: "ui", project: null, note: null });
  }, { comfy: true });
});

Deno.test("a bad origin is a bad request, before the GPU is asked", async () => {
  await withTestApp(async (app) => {
    const cases: [unknown, string][] = [
      [{ project: 7 }, "origin.project"],
      [{ note: "x".repeat(1001) }, "origin.note"],
      ["herons", "origin:"],
    ];
    for (const [origin, expected] of cases) {
      const response = await app.fetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: "krea2",
          params: { prompt: "a granite bowl" },
          origin,
        }),
      });
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { message: string } };
      assertStringIncludes(body.error.message, expected);
    }
    // Nothing ran.
    const { jobs } = await app.json<{ jobs: unknown[] }>(
      "/api/jobs?status=all",
    );
    assertEquals(jobs.length, 0);
  }, { comfy: true });
});

Deno.test("reindex rebuilds origin from the sidecar", async () => {
  // The whole point of the sidecar being the record: drop the index and the
  // origin comes back with everything else.
  await withTestApp(async (app) => {
    await generate(app, {
      origin: { source: "llm:qwen-vlm", project: "herons", note: "round 1" },
    });
    app.db.exec("DELETE FROM outputs");
    app.db.exec("DELETE FROM jobs");

    const result = await reindex({ db: app.db, paths: app.paths });
    assert(result.outputs > 0, "something was rebuilt");

    const { outputs } = await app.json<{ outputs: OutputView[] }>(
      "/api/outputs?project=herons",
    );
    assertEquals(outputs.length, 1);
    assertEquals(outputs[0]!.origin, {
      source: "llm:qwen-vlm",
      project: "herons",
      note: "round 1",
    });
  }, { comfy: true });
});
