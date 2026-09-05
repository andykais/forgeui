import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startTestApp, type TestApp, withTestApp } from "../fixtures/app.ts";
import type { OutputRow } from "../../src/db/queries.ts";
import type { Sidecar } from "../../src/jobs/sidecar.ts";

interface OutputView extends OutputRow {
  media_url: string;
  generation_ms: number | null;
  models: { model_hash: string; role: string }[];
}

interface OutputPage {
  outputs: OutputView[];
  cursor: string | null;
}

interface OutputDetail extends OutputView {
  sidecar: Sidecar | null;
  sidecar_error: string | null;
}

const TERMINAL = ["done", "failed", "cancelled"];

/** Run one job through the fake and wait for it to be indexed. */
async function generate(
  app: TestApp,
  params: Record<string, unknown> = {},
  workflow = "krea2",
): Promise<string> {
  const job = await app.json<{ id: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: workflow,
      params: { prompt: "a granite bowl of figs", ...params },
    }),
  });
  const deadline = Date.now() + 5000;
  let status = "queued";
  while (!TERMINAL.includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${job.id} stuck`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = (await app.json<{ status: string }>(`/api/jobs/${job.id}`)).status;
  }
  await app.jobs.idle();
  assertEquals(status, "done");
  return job.id;
}

/**
 * Timestamps are spread out by hand: every job in a test runs in the same
 * millisecond, and pagination, sorting and day dividers all key off
 * `created_at`.
 */
function backdate(app: TestApp, outputId: string, createdAt: number): void {
  app.db.prepare(`UPDATE outputs SET created_at = ? WHERE id = ?`).run(
    createdAt,
    outputId,
  );
}

async function seed(
  app: TestApp,
  entries: { prompt: string; at: number; workflow?: string }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of entries) {
    const jobId = await generate(
      app,
      { prompt: entry.prompt },
      entry.workflow ?? "krea2",
    );
    const id = `${jobId}-0`;
    backdate(app, id, entry.at);
    ids.push(id);
  }
  return ids;
}

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 8, 5, 12, 0, 0);

Deno.test("GET /api/outputs pages through the gallery by keyset", async () => {
  await withTestApp(async (app) => {
    const ids = await seed(app, [
      { prompt: "one heron", at: NOON },
      { prompt: "two herons", at: NOON + 1000 },
      { prompt: "three herons", at: NOON + 2000 },
      { prompt: "four herons", at: NOON + 3000 },
      { prompt: "five herons", at: NOON + 4000 },
    ]);

    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: OutputPage = await app.json(
        `/api/outputs?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seenIds.push(...page.outputs.map((output) => output.id));
      cursor = page.cursor;
      pages++;
      assert(pages < 10, "pagination should terminate");
    } while (cursor !== null);

    // Newest first, every row once, and the cursor closes the list.
    assertEquals(seenIds, [...ids].reverse());
    assertEquals(new Set(seenIds).size, ids.length);
    assertEquals(pages, 3);

    const oldest: OutputPage = await app.json("/api/outputs?sort=oldest");
    assertEquals(oldest.outputs.map((output) => output.id), ids);
    assertEquals(oldest.cursor, null);

    // Rows carry what the tiles and the table need.
    const first = oldest.outputs[0]!;
    assertEquals(first.media_url, `/api/media/${first.path}`);
    assertEquals(first.kind, "image");
    assertEquals(first.width, 1024);
    assertEquals(first.prompt, "one heron");
    assertEquals(first.workflow_id, "krea2");
    assertEquals(first.family, "flux");
    assert(first.generation_ms !== null && first.generation_ms >= 0);
    assertEquals(first.models, []);

    assertEquals((await app.fetch("/api/outputs?cursor=nonsense")).status, 400);
    assertEquals((await app.fetch("/api/outputs?sort=sideways")).status, 400);
    assertEquals((await app.fetch("/api/outputs?limit=9999")).status, 400);
  }, { comfy: true });
});

Deno.test("filters are AND-ed, and q searches the prompt", async () => {
  await withTestApp(async (app) => {
    const [heron, bowl] = await seed(app, [
      { prompt: "a heron in reeds at dawn", at: NOON },
      {
        prompt: "a granite bowl of figs",
        at: NOON + 1000,
        workflow: "illustrious",
      },
    ]);

    const byWorkflow: OutputPage = await app.json(
      "/api/outputs?workflow=illustrious",
    );
    assertEquals(byWorkflow.outputs.map((output) => output.id), [bowl]);

    const byKind: OutputPage = await app.json("/api/outputs?kind=image");
    assertEquals(byKind.outputs.length, 2);
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?kind=video")).outputs,
      [],
    );

    // Full text, including prefix matching as the user types.
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?q=heron")).outputs.map((o) =>
        o.id
      ),
      [heron],
    );
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?q=gran")).outputs.map((o) =>
        o.id
      ),
      [bowl],
    );
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?q=reeds+dawn")).outputs.map((
        o,
      ) => o.id),
      [heron],
    );
    // Punctuation is not FTS syntax.
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?q=%22heron")).outputs.map((o) =>
        o.id
      ),
      [heron],
    );

    // Filters combine.
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?workflow=krea2&q=heron"))
        .outputs
        .length,
      1,
    );
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?workflow=illustrious&q=heron"))
        .outputs.length,
      0,
    );
    assertEquals((await app.fetch("/api/outputs?kind=audio")).status, 400);
  }, { comfy: true });
});

Deno.test("the models filter ANDs over output_models", async () => {
  await withTestApp(async (app) => {
    const [first, second] = await seed(app, [
      { prompt: "with both loras", at: NOON },
      { prompt: "with one lora", at: NOON + 1000 },
    ]);
    // Phase 1 has no model hashes yet (the scanner is Phase 2), so the rows
    // that back this filter are written here directly.
    const insert = app.db.prepare(
      `INSERT INTO output_models (output_id, model_hash, role) VALUES (?, ?, ?)`,
    );
    insert.run(first, "sha256:grain", "lora");
    insert.run(first, "sha256:detail", "lora");
    insert.run(second, "sha256:grain", "lora");

    assertEquals(
      (await app.json<OutputPage>("/api/outputs?models=sha256:grain")).outputs
        .map((output) => output.id),
      [second, first],
    );
    // Both selected means both used, not either (§11.2).
    assertEquals(
      (await app.json<OutputPage>(
        "/api/outputs?models=sha256:grain,sha256:detail",
      )).outputs.map((output) => output.id),
      [first],
    );
    assertEquals(
      (await app.json<OutputPage>("/api/outputs?models=sha256:nothing"))
        .outputs,
      [],
    );

    // …and the chips a row carries come from the same table.
    const row = (await app.json<OutputPage>("/api/outputs?limit=1&sort=oldest"))
      .outputs[0]!;
    assertEquals(row.models.map((model) => model.model_hash).sort(), [
      "sha256:detail",
      "sha256:grain",
    ]);
  }, { comfy: true });
});

Deno.test("count and day counts follow the same filters", async () => {
  await withTestApp(async (app) => {
    await seed(app, [
      { prompt: "day before", at: NOON - DAY },
      { prompt: "today one", at: NOON },
      { prompt: "today two", at: NOON + 1000 },
      { prompt: "today three", at: NOON + 2000, workflow: "illustrious" },
    ]);

    assertEquals(
      (await app.json<{ count: number }>("/api/outputs/count")).count,
      4,
    );
    assertEquals(
      (await app.json<{ count: number }>("/api/outputs/count?workflow=krea2"))
        .count,
      3,
    );
    assertEquals(
      (await app.json<{ count: number }>("/api/outputs/count?q=today")).count,
      3,
    );

    // The client asks only about the days on screen (§11.2).
    const days = await app.json<{ days: Record<string, number> }>(
      "/api/outputs/days?dates=2026-09-05,2026-09-04,2026-09-03",
    );
    assertEquals(days.days, {
      "2026-09-05": 3,
      "2026-09-04": 1,
      "2026-09-03": 0,
    });

    // Counts respect the active filters too.
    assertEquals(
      (await app.json<{ days: Record<string, number> }>(
        "/api/outputs/days?dates=2026-09-05&workflow=krea2",
      )).days,
      { "2026-09-05": 2 },
    );

    // The client owns the timezone: `tz_offset` is what
    // getTimezoneOffset() returns, so -780 is UTC+13. The three rows at
    // 2026-09-05T12:00Z fall on the 6th there, and the older one on the 5th.
    assertEquals(
      (await app.json<{ days: Record<string, number> }>(
        "/api/outputs/days?dates=2026-09-06,2026-09-05&tz_offset=-780",
      )).days,
      { "2026-09-06": 3, "2026-09-05": 1 },
    );

    assertEquals((await app.fetch("/api/outputs/days?dates=nope")).status, 400);
    assertEquals(
      (await app.fetch("/api/outputs/days?dates=2026-09-05&tz_offset=99999"))
        .status,
      400,
    );
  }, { comfy: true });
});

Deno.test("GET /api/outputs/:id carries the sidecar", async () => {
  await withTestApp(async (app) => {
    const jobId = await generate(app, { seed: 4242 });
    const detail = await app.json<OutputDetail>(`/api/outputs/${jobId}-0`);

    assertEquals(detail.id, `${jobId}-0`);
    assertEquals(detail.sidecar_error, null);
    assertEquals(detail.sidecar?.job_id, jobId);
    assertEquals(detail.sidecar?.params.seed, 4242);
    assertEquals(detail.sidecar?.workflow?.id, "krea2");
    // The graph that produced it, for Rerun now (§6.4).
    assert(Object.keys(detail.sidecar?.api_graph ?? {}).length > 0);
    assert(detail.sidecar!.timing.total_ms >= 0);

    assertEquals((await app.fetch("/api/outputs/nope-0")).status, 404);
  }, { comfy: true });
});

Deno.test("GET /api/media serves the bytes, and only from the media dirs", async () => {
  await withTestApp(async (app) => {
    const jobId = await generate(app);
    const detail = await app.json<OutputDetail>(`/api/outputs/${jobId}-0`);

    const response = await app.fetch(detail.media_url);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertEquals(
      bytes,
      await Deno.readFile(join(app.paths.root, detail.path)),
    );
    assertEquals(Number(response.headers.get("content-length")), bytes.length);

    // Conditional requests, so the viewer does not refetch on every visit.
    const etag = response.headers.get("etag")!;
    const cached = await app.fetch(detail.media_url, {
      headers: { "if-none-match": etag },
    });
    assertEquals(cached.status, 304);
    await cached.body?.cancel();

    // Ranges, which is how a browser seeks a video (Phase 3).
    const ranged = await app.fetch(detail.media_url, {
      headers: { range: "bytes=0-31" },
    });
    assertEquals(ranged.status, 206);
    assertEquals(
      ranged.headers.get("content-range"),
      `bytes 0-31/${bytes.length}`,
    );
    assertEquals(
      new Uint8Array(await ranged.arrayBuffer()),
      bytes.subarray(0, 32),
    );

    // The sidecar is served too: FILES shows both (§11.2).
    const sidecar = await app.fetch(`/api/media/${detail.sidecar_path}`);
    assertEquals(sidecar.status, 200);
    assertStringIncludes(await sidecar.text(), jobId);

    // Nothing outside outputs/, inputs/ and samples/.
    for (
      const path of [
        "/api/media/config.yaml",
        "/api/media/app.db",
        "/api/media/workflows/user/krea2/manifest.json",
        "/api/media/outputs/../config.yaml",
      ]
    ) {
      const refused = await app.fetch(path);
      assertEquals(refused.status, 400, path);
      await refused.body?.cancel();
    }
    const missing = await app.fetch("/api/media/outputs/2026/01/01/nope.png");
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  }, { comfy: true });
});

Deno.test("delete is soft with an undo window, then the bytes go", async () => {
  await withTestApp(async (app) => {
    app.outputs.undoWindowMs = 150;
    const jobId = await generate(app);
    const id = `${jobId}-0`;
    const detail = await app.json<OutputDetail>(`/api/outputs/${id}`);
    const mediaPath = join(app.paths.root, detail.path);
    const sidecarPath = join(app.paths.root, detail.sidecar_path);
    const socket = await app.socket();

    const deleted = await app.json<{
      output: OutputRow;
      undo_window_ms: number;
    }>(`/api/outputs/${id}`, { method: "DELETE" });
    assert(deleted.output.deleted_at !== null);
    assertEquals(deleted.undo_window_ms, 150);
    // The tile disappears at once…
    assertEquals((await app.json<OutputPage>("/api/outputs")).outputs, []);
    assertEquals(
      (await app.json<{ count: number }>("/api/outputs/count")).count,
      0,
    );
    // …and the client is told, so other views drop it too.
    await socket.waitFor((message) =>
      message.kind === "json" && message.type === "output_deleted"
    );
    // …but the bytes are still there while the toast is up (§11.2).
    assert((await Deno.stat(mediaPath)).isFile);

    const restored = await app.json<{ output: OutputRow }>(
      `/api/outputs/${id}/restore`,
      { method: "POST" },
    );
    assertEquals(restored.output.deleted_at, null);
    assertEquals(
      (await app.json<OutputPage>("/api/outputs")).outputs.length,
      1,
    );

    // Delete again and let the window close.
    await app.fetch(`/api/outputs/${id}`, { method: "DELETE" });
    await waitGone(mediaPath);
    await waitGone(sidecarPath);

    // The row stays behind so lineage can still show it as an orphan (§11.2).
    const row = app.db.prepare(`SELECT deleted_at FROM outputs WHERE id = ?`)
      .value<[number]>(id);
    assert(row && row[0] !== null);
    // And restoring now is refused rather than silently failing.
    const late = await app.fetch(`/api/outputs/${id}/restore`, {
      method: "POST",
    });
    assertEquals(late.status, 410);
    assertStringIncludes(
      (await late.json() as { error: { message: string } }).error.message,
      "already been removed",
    );
  }, { comfy: true });
});

async function waitGone(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await Deno.stat(path);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`${path} was not removed`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test("a shared sidecar goes with the last of its outputs", async () => {
  await withTestApp(async (app) => {
    app.outputs.undoWindowMs = 100;
    app.fake!.setScenario("multi-output");
    const jobId = await generate(app);
    const first = await app.json<OutputDetail>(`/api/outputs/${jobId}-0`);
    const second = await app.json<OutputDetail>(`/api/outputs/${jobId}-1`);
    assertEquals(first.sidecar_path, second.sidecar_path);
    const sidecarPath = join(app.paths.root, first.sidecar_path);

    await app.fetch(`/api/outputs/${jobId}-0`, { method: "DELETE" });
    await waitGone(join(app.paths.root, first.path));
    // The other output still needs it.
    assert((await Deno.stat(sidecarPath)).isFile);

    await app.fetch(`/api/outputs/${jobId}-1`, { method: "DELETE" });
    await waitGone(join(app.paths.root, second.path));
    await waitGone(sidecarPath);
  }, { comfy: true });
});

Deno.test("a deletion whose window closed while the app was down is reaped", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "forgeui-undo-" });
  const first = await startTestApp({ comfy: true, dataDir });
  let mediaPath = "";
  try {
    // A long window, so nothing is removed while this app is running.
    first.outputs.undoWindowMs = 60_000;
    const jobId = await generate(first);
    const detail = await first.json<OutputDetail>(`/api/outputs/${jobId}-0`);
    mediaPath = join(first.paths.root, detail.path);
    await first.fetch(`/api/outputs/${jobId}-0`, { method: "DELETE" });
    assert((await Deno.stat(mediaPath)).isFile);
    // Backdate the deletion so the next boot sees an expired window.
    first.db.prepare(`UPDATE outputs SET deleted_at = ? WHERE id = ?`).run(
      Date.now() - 60_000,
      `${jobId}-0`,
    );
  } finally {
    await first.shutdown();
    await first.fake?.close();
  }

  const second = await startTestApp({ dataDir });
  try {
    await waitGone(mediaPath);
  } finally {
    await second.dispose();
  }
});
